const crypto = require("crypto");
const http = require("http");
const https = require("https");

function getLicenseKeyMaxAgeMs() {
  const raw = process.env.LICENSE_KEY_MAX_AGE_DAYS;
  const days = raw ? Number(raw) : NaN;
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req?.body && typeof req.body === "object") return resolve(req.body);

    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function extractKey(req) {
  const auth = req?.headers?.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const key = auth.slice("bearer ".length).trim();
    if (key) return key;
  }
  const bodyKey = req?.body?.licenseKey ?? req?.body?.key;
  if (typeof bodyKey === "string" && bodyKey.trim().length > 0) return bodyKey.trim();
  return null;
}

function parseKey(licenseKey) {
  const match = typeof licenseKey === "string" ? licenseKey.match(/^synapse_([a-z0-9]+)_([a-f0-9]{16})$/) : null;
  if (!match) return { valid: false, reason: "Invalid format" };
  const [, timestampBase36, signatureHex] = match;
  const tsSeconds = parseInt(timestampBase36, 36);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return { valid: false, reason: "Invalid timestamp" };
  const maxAgeMs = getLicenseKeyMaxAgeMs();
  if (maxAgeMs > 0) {
    const issuedAtMs = tsSeconds * 1000;
    if (Date.now() - issuedAtMs > maxAgeMs) return { valid: false, reason: "License expired" };
  }
  return { valid: true, timestampBase36, signatureHex };
}

function hmacSignature(timestampBase36, secret) {
  return crypto.createHmac("sha256", secret).update(timestampBase36).digest("hex").slice(0, 16);
}

function safeEqualHex16(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== 16 || b.length !== 16) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function requestJson(method, urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "http:" ? http : https;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (!data) return resolve({ status, json: null });
          try {
            resolve({ status, json: JSON.parse(data) });
          } catch {
            resolve({ status, json: null });
          }
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

async function fetchLicenseFromDb(licenseKey) {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };

  const select = encodeURIComponent("license_key,status,plan,expires_at,last_instance_id");
  const filterKey = encodeURIComponent(licenseKey);
  const url = `${cfg.url}/rest/v1/licenses?license_key=eq.${filterKey}&select=${select}&limit=1`;
  const { status, json } = await requestJson("GET", url, {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
  });

  if (status !== 200) return { ok: false, error: `Supabase request failed (${status})` };
  if (!Array.isArray(json)) return { ok: false, error: "Supabase response invalid" };
  if (json.length === 0) return { ok: true, record: null };
  return { ok: true, record: json[0] };
}

async function touchOrBindLicense(licenseKey, instanceId) {
  const cfg = getSupabaseConfig();
  if (!cfg) return { updated: false };
  const filterKey = encodeURIComponent(licenseKey);
  const id = typeof instanceId === "string" ? instanceId.trim() : "";
  const lastUsedAt = new Date().toISOString();

  if (!id) {
    const url = `${cfg.url}/rest/v1/licenses?license_key=eq.${filterKey}`;
    await requestJson(
      "PATCH",
      url,
      {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        Prefer: "return=minimal",
      },
      { last_used_at: lastUsedAt }
    );
    return { updated: true };
  }

  const safeId = id.length <= 200 ? id : id.slice(0, 200);
  const or = encodeURIComponent(`(last_instance_id.is.null,last_instance_id.eq.${safeId})`);
  const url = `${cfg.url}/rest/v1/licenses?license_key=eq.${filterKey}&or=${or}`;
  const { status, json } = await requestJson(
    "PATCH",
    url,
    {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: "return=representation",
    },
    { last_used_at: lastUsedAt, last_instance_id: safeId }
  );

  if (status < 200 || status >= 300) return { updated: false };
  if (Array.isArray(json)) return { updated: json.length > 0 };
  return { updated: true };
}

async function validateLicense(req, res) {
  const LICENSE_SECRET = process.env.LICENSE_SECRET ?? process.env.LICENSE_SALT;
  if (!LICENSE_SECRET) {
    return res.status(500).json({ valid: false, reason: "Missing LICENSE_SALT or LICENSE_SECRET" });
  }

  req.body = await readJsonBody(req);

  const licenseKey = extractKey(req);
  if (!licenseKey) {
    return res.status(400).json({ valid: false, reason: "Missing license key" });
  }

  const parsed = parseKey(licenseKey);
  if (!parsed.valid) {
    return res.status(200).json({ valid: false, reason: parsed.reason });
  }

  const expected = hmacSignature(parsed.timestampBase36, LICENSE_SECRET);
  const ok = safeEqualHex16(expected, parsed.signatureHex);
  if (!ok) {
    return res.status(200).json({ valid: false, reason: "Invalid signature" });
  }

  const db = await fetchLicenseFromDb(licenseKey);
  if (!db.ok) {
    return res.status(500).json({ valid: false, reason: typeof db.error === "string" ? db.error : "DB error" });
  }

  const record = db.record;
  if (!record) {
    return res.status(200).json({ valid: false, reason: "License not found" });
  }

  if (record.status !== "active") {
    return res.status(200).json({ valid: false, reason: `License is ${record.status}` });
  }

  if (record.expires_at) {
    const exp = new Date(record.expires_at);
    if (Number.isFinite(exp.getTime()) && exp.getTime() <= Date.now()) {
      return res.status(200).json({ valid: false, reason: "License expired" });
    }
  }

  const instanceId = typeof req?.body?.instanceId === "string" ? req.body.instanceId.trim() : "";
  if (!instanceId) {
    return res.status(200).json({ valid: false, reason: "Client update required (missing instance id)" });
  }
  if (record.last_instance_id && record.last_instance_id !== instanceId) {
    return res.status(200).json({ valid: false, reason: "License already activated on another machine" });
  }

  try {
    const { updated } = await touchOrBindLicense(licenseKey, instanceId);
    if (!updated) {
      return res.status(200).json({ valid: false, reason: "License already activated on another machine" });
    }
  } catch {
    return res.status(500).json({ valid: false, reason: "DB update failed" });
  }

  return res.status(200).json({ valid: true, plan: record.plan || "pro", expiresAt: record.expires_at || null });
}

module.exports = validateLicense;


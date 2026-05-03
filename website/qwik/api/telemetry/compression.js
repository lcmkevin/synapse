const crypto = require("crypto");
const http = require("http");
const https = require("https");

function getLicenseKeyMaxAgeMs() {
  const raw = process.env.LICENSE_KEY_MAX_AGE_DAYS;
  const days = raw ? Number(raw) : NaN;
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    if (req?.body && typeof req.body === "object") return resolve(req.body);

    let data = "";
    let total = 0;
    let done = false;

    req.on("data", (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8");
      total += buf.length;
      if (total > maxBytes) {
        done = true;
        try {
          req.destroy();
        } catch {
          void 0;
        }
        return resolve({ __synapseBodyError: "too_large" });
      }
      data += buf.toString("utf8");
    });
    req.on("end", () => {
      if (done) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function parseKey(licenseKey) {
  const key = typeof licenseKey === "string" ? licenseKey.trim() : "";
  if (!key) return { valid: false, reason: "Invalid format" };

  const v2 = key.match(/^synapse2_([a-z0-9]+)_([a-f0-9]{16})_([a-f0-9]{32})$/);
  if (v2) {
    const [, timestampBase36, nonceHex, signatureHex] = v2;
    const tsSeconds = parseInt(timestampBase36, 36);
    if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return { valid: false, reason: "Invalid timestamp" };
    const maxAgeMs = getLicenseKeyMaxAgeMs();
    if (maxAgeMs > 0) {
      const issuedAtMs = tsSeconds * 1000;
      if (Date.now() - issuedAtMs > maxAgeMs) return { valid: false, reason: "License expired" };
    }
    return { valid: true, version: 2, timestampBase36, nonceHex, signatureHex };
  }

  const v1 = key.match(/^synapse_([a-z0-9]+)_([a-f0-9]{16})$/);
  if (!v1) return { valid: false, reason: "Invalid format" };
  const [, timestampBase36, signatureHex] = v1;
  const tsSeconds = parseInt(timestampBase36, 36);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return { valid: false, reason: "Invalid timestamp" };
  const maxAgeMs = getLicenseKeyMaxAgeMs();
  if (maxAgeMs > 0) {
    const issuedAtMs = tsSeconds * 1000;
    if (Date.now() - issuedAtMs > maxAgeMs) return { valid: false, reason: "License expired" };
  }
  return { valid: true, version: 1, timestampBase36, signatureHex };
}

function hmacSignature(timestampBase36, secret) {
  return crypto.createHmac("sha256", secret).update(timestampBase36).digest("hex").slice(0, 16);
}

function hmacSignatureV2(timestampBase36, nonceHex, secret) {
  return crypto.createHmac("sha256", secret).update(`${timestampBase36}.${nonceHex}`).digest("hex").slice(0, 32);
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
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

  const select = encodeURIComponent("license_key,status,expires_at,last_instance_id");
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
  if (!id) return { updated: false };

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

function sanitizeEvent(event) {
  const e = event && typeof event === "object" ? event : {};
  const out = {
    ts: typeof e.ts === "string" ? e.ts : new Date().toISOString(),
    source: e.source === "workspace" || e.source === "selection" ? e.source : "selection",
    beforeTokens: Number.isFinite(Number(e.beforeTokens)) ? Number(e.beforeTokens) : 0,
    afterTokens: Number.isFinite(Number(e.afterTokens)) ? Number(e.afterTokens) : 0,
    savingsPercent: Number.isFinite(Number(e.savingsPercent)) ? Number(e.savingsPercent) : 0,
    fileCount: Number.isFinite(Number(e.fileCount)) ? Number(e.fileCount) : null,
    isPro: !!e.isPro,
    extensionVersion: typeof e.extensionVersion === "string" ? e.extensionVersion : null,
    platform: typeof e.platform === "string" ? e.platform : null,
    hitCounts: null,
  };

  const hits = e.hitCounts && typeof e.hitCounts === "object" ? e.hitCounts : null;
  if (hits) {
    const clean = {};
    for (const k of Object.keys(hits)) {
      const n = Number(hits[k]);
      if (!k || !Number.isFinite(n) || n <= 0) continue;
      if (String(k).length > 200) continue;
      clean[k] = Math.floor(n);
    }
    out.hitCounts = Object.keys(clean).length ? clean : null;
  }
  return out;
}

async function insertTelemetry(licenseKey, instanceId, event) {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };
  const table = (process.env.SYNAPSE_TELEMETRY_TABLE || "synapse_compression_metrics").trim();

  const url = `${cfg.url}/rest/v1/${encodeURIComponent(table)}`;
  const payload = {
    license_key: licenseKey,
    instance_id: instanceId,
    created_at: new Date().toISOString(),
    event,
  };
  const { status } = await requestJson(
    "POST",
    url,
    {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: "return=minimal",
    },
    payload
  );
  if (status < 200 || status >= 300) return { ok: false, error: `Supabase insert failed (${status})` };
  return { ok: true };
}

async function compressionTelemetry(req, res) {
  const LICENSE_SECRET = process.env.LICENSE_SECRET ?? process.env.LICENSE_SALT;
  if (!LICENSE_SECRET) {
    return res.status(500).json({ ok: false, error: "Missing LICENSE_SALT or LICENSE_SECRET" });
  }

  const body = await readJsonBody(req);
  if (body && typeof body === "object" && body.__synapseBodyError === "too_large") {
    return res.status(413).json({ ok: false, error: "Payload too large" });
  }
  req.body = body;

  const licenseKey = typeof body?.licenseKey === "string" ? body.licenseKey.trim() : "";
  const instanceId = typeof body?.instanceId === "string" ? body.instanceId.trim() : "";
  const event = sanitizeEvent(body?.event);
  if (!licenseKey || !instanceId) return res.status(400).json({ ok: false, error: "Missing licenseKey or instanceId" });

  const parsed = parseKey(licenseKey);
  if (!parsed.valid) return res.status(200).json({ ok: false, error: parsed.reason });

  const expected =
    parsed.version === 2 ? hmacSignatureV2(parsed.timestampBase36, parsed.nonceHex, LICENSE_SECRET) : hmacSignature(parsed.timestampBase36, LICENSE_SECRET);
  if (!safeEqualHex(expected, parsed.signatureHex)) return res.status(200).json({ ok: false, error: "Invalid signature" });

  const db = await fetchLicenseFromDb(licenseKey);
  if (!db.ok) return res.status(500).json({ ok: false, error: typeof db.error === "string" ? db.error : "DB error" });
  if (!db.record) return res.status(200).json({ ok: false, error: "License not found" });
  if (db.record.status !== "active") return res.status(200).json({ ok: false, error: `License is ${db.record.status}` });
  if (db.record.expires_at) {
    const exp = new Date(db.record.expires_at);
    if (Number.isFinite(exp.getTime()) && exp.getTime() <= Date.now()) return res.status(200).json({ ok: false, error: "License expired" });
  }
  if (db.record.last_instance_id && db.record.last_instance_id !== instanceId) {
    return res.status(200).json({ ok: false, error: "License already activated on another machine" });
  }
  const { updated } = await touchOrBindLicense(licenseKey, instanceId);
  if (!updated) return res.status(200).json({ ok: false, error: "License already activated on another machine" });

  const inserted = await insertTelemetry(licenseKey, instanceId, event);
  if (!inserted.ok) return res.status(500).json({ ok: false, error: inserted.error || "Insert failed" });
  return res.status(200).json({ ok: true });
}

module.exports = compressionTelemetry;

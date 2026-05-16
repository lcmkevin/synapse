const crypto = require("crypto");
const http = require("http");
const https = require("https");

const FREE_DEFAULT_REPLACEMENTS = [
  { id: "free:001", find: "please ensure that", replace: "ensure" },
  { id: "free:002", find: "please make sure to", replace: "make sure to" },
  { id: "free:003", find: "in order to", replace: "to" },
  { id: "free:004", find: "you should always", replace: "always" },
  { id: "free:005", find: "you are required to", replace: "must" },
  { id: "free:006", find: "kindly provide", replace: "provide" },
  { id: "free:007", find: "based on the information provided", replace: "based on data" },
  { id: "free:008", find: "in the event that", replace: "if" },
  { id: "free:009", find: "for the purpose of", replace: "for" },
  { id: "free:010", find: "with reference to", replace: "about" },
  { id: "free:011", find: "it is important to note that", replace: "note:" },
  { id: "free:012", find: "do not under any circumstances", replace: "never" },
  { id: "free:013", find: "keep in mind that", replace: "remember:" },
  { id: "free:014", find: "it is highly recommended to", replace: "recommend:" },
  { id: "free:015", find: "take into consideration", replace: "consider" },
  { id: "free:016", find: "if and only if", replace: "iff" },
  { id: "free:017", find: "in case of", replace: "if" },
  { id: "free:018", find: "despite the fact that", replace: "although" },
  { id: "free:019", find: "at the end of the day", replace: "finally" },
  { id: "free:020", find: "as soon as possible", replace: "asap" },
  { id: "free:021", find: "due to the fact that", replace: "because" },
  { id: "free:022", find: "by means of", replace: "by" },
  { id: "free:023", find: "at this point in time", replace: "now" },
  { id: "free:024", find: "it goes without saying that", replace: "obviously" },
  { id: "free:025", find: "with the exception of", replace: "except" },
  { id: "free:026", find: "in close proximity to", replace: "near" },
  { id: "free:027", find: "make an effort to", replace: "try to" },
  { id: "free:028", find: "conduct an investigation into", replace: "investigate" },
  { id: "free:029", find: "has the capability to", replace: "can" },
  { id: "free:030", find: "is able to", replace: "can" },
  { id: "free:031", find: "serves to", replace: "does" },
  { id: "free:032", find: "utilized for", replace: "for" },
  { id: "free:033", find: "in the near future", replace: "soon" },
  { id: "free:034", find: "on a regular basis", replace: "regularly" },
  { id: "free:035", find: "in possession of", replace: "has" },
  { id: "free:036", find: "be responsible for", replace: "handle" },
  { id: "free:037", find: "it is clear that", replace: "clearly" },
  { id: "free:038", find: "it appears that", replace: "apparently" },
  { id: "free:039", find: "most of the time", replace: "usually" },
  { id: "free:040", find: "at the same time", replace: "while" },
  { id: "free:041", find: "for example", replace: "e.g." },
  { id: "free:042", find: "that is to say", replace: "i.e." },
  { id: "free:043", find: "with regard to", replace: "about" },
  { id: "free:044", find: "in addition to", replace: "plus" },
  { id: "free:045", find: "as a result", replace: "so" },
  { id: "free:046", find: "in other words", replace: "i.e." },
  { id: "free:047", find: "please note that", replace: "note:" },
  { id: "free:048", find: "please be aware that", replace: "note:" },
  { id: "free:049", find: "with respect to", replace: "about" },
  { id: "free:050", find: "in accordance with", replace: "per" },
  { id: "free:051", find: "as well as", replace: "and" },
  { id: "free:052", find: "a number of", replace: "several" },
  { id: "free:053", find: "in relation to", replace: "about" },
  { id: "free:054", find: "in a timely manner", replace: "promptly" },
];

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

async function fetchDictionaryRows() {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };

  const select = encodeURIComponent("id,category,find_pattern,replace_with,pro_only,created_at");
  const url = `${cfg.url}/rest/v1/synapse_dictionary?select=${select}&category=in.(defluffer,symbolization)&pro_only=eq.true&order=created_at.desc`;
  const { status, json } = await requestJson("GET", url, {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
  });

  if (status !== 200) return { ok: false, error: `Supabase request failed (${status})` };
  if (!Array.isArray(json)) return { ok: false, error: "Supabase response invalid" };
  return { ok: true, rows: json };
}

async function dictionary(req, res) {
  try {
    const url = new URL(req.url || "", "http://localhost");
    const isPublic = url.searchParams.get("public") === "1";
    const tier = (url.searchParams.get("tier") || "").trim().toLowerCase();
    if (req.method === "GET" && isPublic && (tier === "free" || tier === "")) {
      return res.status(200).json({
        ok: true,
        tier: "free",
        updatedAt: "2026-05-16",
        pairs: FREE_DEFAULT_REPLACEMENTS,
      });
    }
  } catch {
    void 0;
  }

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

  const dict = await fetchDictionaryRows();
  if (!dict.ok) return res.status(500).json({ ok: false, error: typeof dict.error === "string" ? dict.error : "DB error" });

  const rows = (dict.rows || [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      id: r.id,
      category: typeof r.category === "string" ? r.category : "",
      find_pattern: typeof r.find_pattern === "string" ? r.find_pattern : "",
      replace_with: typeof r.replace_with === "string" ? r.replace_with : "",
      created_at: typeof r.created_at === "string" ? r.created_at : undefined,
    }))
    .filter((r) => (r.category === "defluffer" || r.category === "symbolization") && r.find_pattern.trim());

  const head = rows[0];
  const dictVersion = `${rows.length}:${head && head.created_at ? head.created_at : "none"}`;
  return res.status(200).json({ ok: true, dictVersion, rows });
}

module.exports = dictionary;

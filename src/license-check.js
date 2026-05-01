const crypto = require("crypto");
const fs = require("fs-extra");
const https = require("https");
const os = require("os");
const path = require("path");
const { DEFAULT_API_BASE_URL, PRO_PRICE_LABEL, PRO_TERMS_LABEL, getProCheckoutUrl } = require("./product.js");

function getApiBaseUrl() {
  const env = process.env.SYNAPSE_LICENSE_API_URL;
  const base = typeof env === "string" && env.trim() ? env.trim() : DEFAULT_API_BASE_URL;
  const trimmed = base.replace(/\/+$/, "");
  if (/^https?:\/\/labs-synapse\.com$/i.test(trimmed)) return trimmed.replace(/\/\/labs-synapse\.com$/i, "//www.labs-synapse.com");
  return trimmed;
}

function getLicenseKeyPath() {
  return path.join(os.homedir(), ".synapse", "license.key");
}

function getInstanceIdPath() {
  return path.join(os.homedir(), ".synapse", "instance_id");
}

async function loadOrCreateInstanceId() {
  const p = getInstanceIdPath();
  try {
    const text = await fs.readFile(p, "utf8");
    const v = String(text || "").trim();
    if (v) return v;
  } catch {
    void 0;
  }

  const v = `cli_${crypto.randomBytes(16).toString("hex")}`;
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, v, "utf8");
  if (process.platform !== "win32") {
    try {
      await fs.chmod(p, 0o600);
    } catch {
      void 0;
    }
  }
  return v;
}

async function loadSavedLicenseKey() {
  const fromEnv = process.env.SYNAPSE_LICENSE_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const p = getLicenseKeyPath();
  try {
    const text = await fs.readFile(p, "utf8");
    const v = String(text || "").trim();
    return v || "";
  } catch {
    return "";
  }
}

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = JSON.stringify(body || {});
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk.toString()));
        res.on("end", () => {
          const status = res.statusCode || 0;
          try {
            const json = data ? JSON.parse(data) : null;
            resolve({ status, json });
          } catch {
            resolve({ status, json: null });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function isProUser() {
  if (process.env.SYNAPSE_DEV === "true") return true;
  if (process.env.SYNAPSE_OFFLINE === "true") return false;

  const licenseKey = await loadSavedLicenseKey();
  if (!licenseKey) return false;

  try {
    const base = getApiBaseUrl();
    const instanceId = await loadOrCreateInstanceId();
    const { status, json } = await postJson(`${base}/api/validate`, { licenseKey, instanceId });
    if (status !== 200) return false;
    return !!json && json.valid === true;
  } catch {
    return false;
  }
}

function showUpgradeMessage() {
  const base = getApiBaseUrl();
  process.stdout.write("\n❌ This action requires a Pro license.\n");
  process.stdout.write(`   Pro: ${PRO_PRICE_LABEL} · ${PRO_TERMS_LABEL}\n`);
  process.stdout.write(`   Upgrade: ${getProCheckoutUrl(base)}\n`);
  process.stdout.write("   Or enter your license key: synapse enter-license\n\n");
}

async function saveLicenseKey(licenseKey) {
  const p = getLicenseKeyPath();
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, String(licenseKey || "").trim(), "utf8");
  if (process.platform !== "win32") {
    try {
      await fs.chmod(p, 0o600);
    } catch {}
  }
  return p;
}

module.exports = { isProUser, showUpgradeMessage, loadSavedLicenseKey, saveLicenseKey, getApiBaseUrl };

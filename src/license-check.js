const fs = require("fs-extra");
const https = require("https");
const os = require("os");
const path = require("path");

function getApiBaseUrl() {
  const env = process.env.SYNAPSE_LICENSE_API_URL;
  const base = typeof env === "string" && env.trim() ? env.trim() : "https://labs-synapse.com";
  return base.replace(/\/+$/, "");
}

function getLicenseKeyPath() {
  return path.join(os.homedir(), ".synapse", "license.key");
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
    const { status, json } = await postJson(`${base}/api/validate`, { licenseKey });
    if (status !== 200) return false;
    return !!json && json.valid === true;
  } catch {
    return false;
  }
}

function showUpgradeMessage() {
  const base = getApiBaseUrl();
  process.stdout.write("\n❌ This action requires a Pro license.\n");
  process.stdout.write(`   Upgrade: ${base}/qwik/pricing.html\n`);
  process.stdout.write("   Or enter your license key: synapse enter-license\n\n");
}

async function saveLicenseKey(licenseKey) {
  const p = getLicenseKeyPath();
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, String(licenseKey || "").trim(), "utf8");
  return p;
}

module.exports = { isProUser, showUpgradeMessage, loadSavedLicenseKey, saveLicenseKey, getApiBaseUrl };


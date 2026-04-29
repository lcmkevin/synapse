const fs = require("fs-extra");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { DEFAULT_API_BASE_URL, PRO_PRICE_LABEL, PRO_TERMS_LABEL, getProCheckoutUrl } = require("./product.js");

function getApiBaseUrl() {
  const env = process.env.SYNAPSE_LICENSE_API_URL;
  const base = typeof env === "string" && env.trim() ? env.trim() : DEFAULT_API_BASE_URL;
  const normalized = base.replace(/\/+$/, "");
  if (normalized === "https://labs-synapse.com") return "https://www.labs-synapse.com";
  if (normalized === "http://labs-synapse.com") return "http://www.labs-synapse.com";
  return normalized;
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
  const payload = JSON.stringify(body || {});
  const maxRedirects = 5;

  const doRequest = (u, redirectsLeft) => {
    return new Promise((resolve, reject) => {
      const url = new URL(u);
      const lib = url.protocol === "http:" ? http : https;
      const req = lib.request(
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
          res.on("end", async () => {
            const status = res.statusCode || 0;
            let json = null;
            try {
              json = data ? JSON.parse(data) : null;
            } catch {
              json = null;
            }

            if ([301, 302, 303, 307, 308].includes(status) && redirectsLeft > 0) {
              const headerLoc = typeof res.headers?.location === "string" ? res.headers.location : "";
              const jsonLoc = typeof json?.redirect === "string" ? String(json.redirect).trim() : "";
              const loc = (headerLoc || jsonLoc || "").trim();
              if (loc) {
                const nextUrl = new URL(loc, url.toString()).toString();
                try {
                  const redirected = await doRequest(nextUrl, redirectsLeft - 1);
                  resolve(redirected);
                  return;
                } catch (e) {
                  reject(e);
                  return;
                }
              }
            }

            resolve({ status, json });
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  };

  return doRequest(urlString, maxRedirects);
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

import crypto from "crypto";
import fs from "fs/promises";
import https from "https";
import os from "os";
import path from "path";

export type LicensePlan = "free" | "pro" | "enterprise";

export type CurrentLicense = {
  valid: boolean;
  plan: LicensePlan;
};

function getApiBaseUrl(): string {
  const env = process.env.SYNAPSE_LICENSE_API_URL;
  const base = typeof env === "string" && env.trim() ? env.trim() : "https://www.labs-synapse.com";
  const trimmed = base.replace(/\/+$/, "");
  if (/^https?:\/\/labs-synapse\.com$/i.test(trimmed)) return trimmed.replace(/\/\/labs-synapse\.com$/i, "//www.labs-synapse.com");
  return trimmed;
}

function getLicenseKeyPath(): string {
  return path.join(os.homedir(), ".synapse", "license.key");
}

function getInstanceIdPath(): string {
  return path.join(os.homedir(), ".synapse", "instance_id");
}

async function loadOrCreateInstanceId(): Promise<string> {
  const p = getInstanceIdPath();
  try {
    const text = await fs.readFile(p, "utf8");
    const v = String(text || "").trim();
    if (v) return v;
  } catch {
    void 0;
  }

  const v = `cli_${crypto.randomBytes(16).toString("hex")}`;
  await fs.mkdir(path.dirname(p), { recursive: true });
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

async function loadSavedLicenseKey(): Promise<string> {
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

function postJson(urlString: string, body: unknown): Promise<{ status: number; json: any }> {
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

export async function getCurrentLicense(): Promise<CurrentLicense> {
  if (process.env.SYNAPSE_DEV === "true") return { valid: true, plan: "pro" };
  if (process.env.SYNAPSE_OFFLINE === "true") return { valid: false, plan: "free" };

  const licenseKey = await loadSavedLicenseKey();
  if (!licenseKey) return { valid: false, plan: "free" };

  try {
    const base = getApiBaseUrl();
    const instanceId = await loadOrCreateInstanceId();
    const { status, json } = await postJson(`${base}/api/validate`, { licenseKey, instanceId });
    if (status !== 200) return { valid: false, plan: "free" };
    const valid = !!json && json.valid === true;
    const plan = valid && json && (json.plan === "pro" || json.plan === "enterprise") ? json.plan : "free";
    return valid ? { valid: true, plan } : { valid: false, plan: "free" };
  } catch {
    return { valid: false, plan: "free" };
  }
}

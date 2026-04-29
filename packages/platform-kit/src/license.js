const crypto = require("crypto");

function getLicenseSecretFromEnv() {
  const secret = process.env.LICENSE_SECRET ?? process.env.LICENSE_SALT;
  return typeof secret === "string" && secret.trim() ? secret.trim() : "";
}

function getLicenseKeyMaxAgeMsFromEnv() {
  const raw = process.env.LICENSE_KEY_MAX_AGE_DAYS;
  const days = raw ? Number(raw) : NaN;
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

function parseLicenseKey(licenseKey, { maxAgeMs = getLicenseKeyMaxAgeMsFromEnv() } = {}) {
  const match = typeof licenseKey === "string" ? licenseKey.match(/^synapse_([a-z0-9]+)_([a-f0-9]{16})$/) : null;
  if (!match) return { valid: false, reason: "Invalid format" };
  const [, timestampBase36, signatureHex] = match;
  const tsSeconds = parseInt(timestampBase36, 36);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return { valid: false, reason: "Invalid timestamp" };
  if (maxAgeMs > 0) {
    const issuedAtMs = tsSeconds * 1000;
    if (Date.now() - issuedAtMs > maxAgeMs) return { valid: false, reason: "License expired" };
  }
  return { valid: true, timestampBase36, signatureHex };
}

function hmacSignatureHex16(timestampBase36, secret) {
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

function generateLicenseKey({ secret = getLicenseSecretFromEnv(), nowMs = Date.now() } = {}) {
  if (!secret) throw new Error("LICENSE_SECRET is required");
  const timestampBase36 = Math.floor(nowMs / 1000).toString(36);
  const signatureHex = hmacSignatureHex16(timestampBase36, secret);
  return `synapse_${timestampBase36}_${signatureHex}`;
}

module.exports = { getLicenseSecretFromEnv, parseLicenseKey, hmacSignatureHex16, safeEqualHex16, generateLicenseKey };

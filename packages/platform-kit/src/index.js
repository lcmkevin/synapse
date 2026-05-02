const { readJsonBody, extractBearerOrBodyKey, requestJson } = require("./http.js");
const { getLicenseSecretFromEnv, generateLicenseKey, parseLicenseKey, safeEqualHex16, safeEqualHex, hmacSignatureHex16, hmacSignatureHex32V2 } = require("./license.js");
const { getSupabaseServiceConfigFromEnv, fetchLicenseRecordByKey, touchLicenseUsage, upsertLicenseRecord } = require("./supabase-licenses.js");
const { verifyStripeSignature, readRawBody } = require("./stripe.js");

module.exports = {
  readJsonBody,
  extractBearerOrBodyKey,
  requestJson,

  getLicenseSecretFromEnv,
  generateLicenseKey,
  parseLicenseKey,
  safeEqualHex16,
  safeEqualHex,
  hmacSignatureHex16,
  hmacSignatureHex32V2,

  getSupabaseServiceConfigFromEnv,
  fetchLicenseRecordByKey,
  touchLicenseUsage,
  upsertLicenseRecord,

  verifyStripeSignature,
  readRawBody,
};

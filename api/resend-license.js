function loadImpl() {
  try {
    return require("../packages/pro/api/resend-license.js");
  } catch {
    try {
      return require("../synapse-pro/api/resend-license.js");
    } catch {
      return null;
    }
  }
}

const impl = loadImpl();

module.exports = async function handler(req, res) {
  if (typeof impl === "function") return impl(req, res);
  if (!impl?.resendLicense) return res.status(404).json({ ok: false, error: "Not available" });
  return impl.resendLicense(req, res);
};

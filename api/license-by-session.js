function loadImpl() {
  try {
    return require("../packages/pro/api/license-by-session.js");
  } catch {
    try {
      return require("../synapse-pro/api/license-by-session.js");
    } catch {
      return null;
    }
  }
}

const impl = loadImpl();

module.exports = async function handler(req, res) {
  if (typeof impl === "function") return impl(req, res);
  if (!impl?.getLicenseBySession) return res.status(404).json({ ok: false, error: "Not available" });
  return impl.getLicenseBySession(req, res);
};

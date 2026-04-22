function loadImpl() {
  try {
    return require("../../../packages/pro/api/validate.js");
  } catch {
    try {
      return require("../../../synapse-pro/api/validate.js");
    } catch {
      return null;
    }
  }
}

const impl = loadImpl();

module.exports = async function handler(req, res) {
  if (!impl?.validateLicense) return res.status(404).json({ valid: false, reason: "Not available" });
  return impl.validateLicense(req, res);
};


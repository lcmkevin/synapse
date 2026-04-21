function loadImpl() {
  try {
    return require("../packages/pro/api/create-checkout.js");
  } catch {
    try {
      return require("../synapse-pro/api/create-checkout.js");
    } catch {
      return null;
    }
  }
}

const impl = loadImpl();

module.exports = async function handler(req, res) {
  if (!impl?.createCheckout) return res.status(404).json({ ok: false, error: "Not available" });
  return impl.createCheckout(req, res);
};


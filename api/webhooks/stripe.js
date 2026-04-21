function loadImpl() {
  try {
    return require("../../packages/pro/api/webhooks/stripe.js");
  } catch {
    try {
      return require("../../synapse-pro/api/webhooks/stripe.js");
    } catch {
      return null;
    }
  }
}

const impl = loadImpl();

module.exports = async function handler(req, res) {
  if (!impl?.handleStripeWebhook) return res.status(404).json({ ok: false, error: "Not available" });
  return impl.handleStripeWebhook(req, res);
};


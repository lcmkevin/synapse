const https = require("https");

function getStripeModeFromKey(apiKey) {
  const k = String(apiKey || "");
  if (k.startsWith("sk_test_")) return "test";
  if (k.startsWith("sk_live_")) return "live";
  return "unknown";
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req?.body && typeof req.body === "object") return resolve(req.body);

    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function encodeForm(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function createCheckout(req, res) {
  try {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    const priceId = process.env.STRIPE_PRICE_ID;
    const successUrl = process.env.STRIPE_SUCCESS_URL;
    const cancelUrl = process.env.STRIPE_CANCEL_URL;
    const mode = getStripeModeFromKey(apiKey);

    if (!apiKey || !priceId || !successUrl || !cancelUrl) {
      return res.status(500).json({
        ok: false,
        error: "Server misconfigured",
        mode,
        hint: "Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL. For Stripe test mode, STRIPE_SECRET_KEY must start with sk_test_ and STRIPE_PRICE_ID must be a test-mode price.",
      });
    }

    const body = await readJsonBody(req);
    const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim() : "";

    const form = encodeForm({
      mode: "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      customer_email: customerEmail || undefined,
      billing_address_collection: "required",
      "tax_id_collection[enabled]": true,
      allow_promotion_codes: true,
    });

    const url = new URL("https://api.stripe.com/v1/checkout/sessions");
    const payload = form;
    const reqStripe = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (stripeRes) => {
        let data = "";
        stripeRes.on("data", (chunk) => (data += chunk.toString()));
        stripeRes.on("end", () => {
          const status = stripeRes.statusCode || 0;
          try {
            const json = JSON.parse(data || "{}");
            if (status >= 200 && status < 300 && json?.url) {
              return res.status(200).json({ ok: true, url: json.url, id: json.id });
            }
            const err = json && typeof json === "object" ? json.error : null;
            const stripeMsg = err && typeof err.message === "string" ? err.message : "";
            const hint =
              mode === "test"
                ? "This server is using Stripe test mode. Ensure STRIPE_PRICE_ID is a test-mode price and your Checkout product/price exists in test mode."
                : mode === "live"
                  ? "This server is using Stripe live mode. Ensure STRIPE_PRICE_ID is a live-mode price and exists in your live account."
                  : "Ensure STRIPE_SECRET_KEY and STRIPE_PRICE_ID are set and match the same Stripe mode (test vs live).";
            return res.status(502).json({
              ok: false,
              error: "Stripe error",
              mode,
              stripeStatus: status,
              stripeMessage: stripeMsg || undefined,
              stripeType: err && typeof err.type === "string" ? err.type : undefined,
              stripeCode: err && typeof err.code === "string" ? err.code : undefined,
              stripeParam: err && typeof err.param === "string" ? err.param : undefined,
              stripeRequestLogUrl: err && typeof err.request_log_url === "string" ? err.request_log_url : undefined,
              hint,
            });
          } catch {
            return res.status(502).json({ ok: false, error: "Stripe error", mode, stripeStatus: status });
          }
        });
      }
    );

    reqStripe.on("error", () => res.status(502).json({ ok: false, error: "Stripe error", mode }));
    reqStripe.write(payload);
    reqStripe.end();
  } catch {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = createCheckout;

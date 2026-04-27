const crypto = require("crypto");
const http = require("http");
const https = require("https");

function generateLicenseKey() {
  const LICENSE_SECRET = process.env.LICENSE_SECRET ?? process.env.LICENSE_SALT;
  if (!LICENSE_SECRET) throw new Error("LICENSE_SECRET is required");
  const timestampBase36 = Math.floor(Date.now() / 1000).toString(36);
  const signatureHex = crypto.createHmac("sha256", LICENSE_SECRET).update(timestampBase36).digest("hex").slice(0, 16);
  return `synapse_${timestampBase36}_${signatureHex}`;
}

function requestJson(method, urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "http:" ? http : https;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (!data) return resolve({ status, json: null });
          try {
            resolve({ status, json: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

function timingSafeEqualHex(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader) return { ok: false, reason: "Missing Stripe-Signature" };
  const parts = String(signatureHeader)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let timestamp = null;
  const signatures = [];
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx);
    const v = p.slice(idx + 1);
    if (k === "t") timestamp = v;
    if (k === "v1") signatures.push(v);
  }

  const ts = timestamp ? parseInt(timestamp, 10) : NaN;
  if (!Number.isFinite(ts)) return { ok: false, reason: "Invalid Stripe-Signature timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return { ok: false, reason: "Stale Stripe-Signature timestamp" };

  const signedPayload = `${ts}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  const match = signatures.some((sig) => typeof sig === "string" && sig.length === expected.length && timingSafeEqualHex(sig, expected));
  return match ? { ok: true } : { ok: false, reason: "Invalid Stripe-Signature" };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === "string") return resolve(Buffer.from(req.body, "utf8"));

    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function upsertLicense(record) {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error("DB not configured");
  const url = `${cfg.url}/rest/v1/licenses?on_conflict=license_key`;
  const { status } = await requestJson(
    "POST",
    url,
    {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    record
  );
  if (status !== 201 && status !== 200 && status !== 204) throw new Error("DB write failed");
}

async function updateLicenseBySubscriptionId(subscriptionId, patch) {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error("DB not configured");
  const sub = encodeURIComponent(subscriptionId);
  const url = `${cfg.url}/rest/v1/licenses?stripe_subscription_id=eq.${sub}`;
  const { status } = await requestJson(
    "PATCH",
    url,
    {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: "return=minimal",
    },
    patch
  );
  if (status !== 204 && status !== 200) throw new Error("DB update failed");
}

function expiresAtOneYearFromNowIso() {
  return null;
}

function normalizePlanCodeFromMetadata(obj) {
  const meta = obj && typeof obj === "object" ? obj.metadata : null;
  const v = meta && typeof meta === "object" ? meta.plan_code : null;
  const planCode = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (planCode === "pro") return "pro_lifetime";
  return planCode || "pro_lifetime";
}

function normalizeLicensePlanFromMetadata(obj, planCode) {
  const meta = obj && typeof obj === "object" ? obj.metadata : null;
  const v = meta && typeof meta === "object" ? meta.license_plan : null;
  const licensePlan = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (licensePlan === "enterprise") return "enterprise";
  if (planCode === "enterprise") return "enterprise";
  return "pro";
}

async function handleStripeWebhook(req, res) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ ok: false, error: "Server misconfigured" });

  const rawBody = await readRawBody(req);
  const sigHeader = req.headers["stripe-signature"];
  const verified = verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!verified.ok) return res.status(400).json({ ok: false, error: verified.reason });

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  const type = event?.type;
  const obj = event?.data?.object;

  try {
    if (type === "checkout.session.completed") {
      const email = obj?.customer_details?.email || obj?.customer_email || null;
      const subscriptionId = obj?.subscription || null;
      const customerId = obj?.customer || null;
      const checkoutSessionId = obj?.id || null;
      const paymentIntentId = obj?.payment_intent || null;
      const planCode = normalizePlanCodeFromMetadata(obj);
      const licensePlan = normalizeLicensePlanFromMetadata(obj, planCode);
      const stripePriceId =
        obj?.metadata && typeof obj.metadata === "object" && typeof obj.metadata.stripe_price_id === "string" && obj.metadata.stripe_price_id.trim()
          ? obj.metadata.stripe_price_id.trim()
          : null;

      const licenseKey = generateLicenseKey();
      await upsertLicense({
        license_key: licenseKey,
        email,
        plan: licensePlan,
        plan_code: planCode,
        status: "active",
        expires_at: expiresAtOneYearFromNowIso(),
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        stripe_checkout_session_id: checkoutSessionId,
        stripe_payment_intent_id: paymentIntentId,
        stripe_price_id: stripePriceId,
      });

      return res.status(200).json({ ok: true });
    }

    if (type === "customer.subscription.deleted") {
      const subscriptionId = obj?.id;
      if (subscriptionId) {
        await updateLicenseBySubscriptionId(subscriptionId, { status: "canceled" });
      }
      return res.status(200).json({ ok: true });
    }

    if (type === "invoice.payment_failed") {
      const subscriptionId = obj?.subscription;
      if (subscriptionId) {
        await updateLicenseBySubscriptionId(subscriptionId, { status: "past_due" });
      }
      return res.status(200).json({ ok: true });
    }

    if (type === "invoice.paid") {
      const subscriptionId = obj?.subscription;
      if (subscriptionId) {
        await updateLicenseBySubscriptionId(subscriptionId, { status: "active" });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: "Webhook processing failed" });
  }
}

module.exports = handleStripeWebhook;

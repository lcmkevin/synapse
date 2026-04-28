const crypto = require("crypto");
const https = require("https");

function getStripeModeFromKey(apiKey) {
  const k = String(apiKey || "");
  if (k.startsWith("sk_test_")) return "test";
  if (k.startsWith("sk_live_")) return "live";
  return "unknown";
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

function makeCheckoutAccessToken() {
  return crypto.randomBytes(16).toString("hex");
}

function buildSuccessUrlWithAccessToken(urlString, accessToken) {
  try {
    const u = new URL(urlString);
    const placeholder = "{CHECKOUT_SESSION_ID}";
    u.searchParams.set("session_id", placeholder);

    const hashParams = new URLSearchParams(u.hash && u.hash.startsWith("#") ? u.hash.slice(1) : "");
    hashParams.delete("session_id");
    hashParams.set("token", accessToken);
    u.hash = hashParams.toString();
    return u.toString();
  } catch {
    return urlString;
  }
}

function supabaseRequestJson({ method, urlString, apiKey, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const reqDb = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          Accept: "application/json",
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (dbRes) => {
        let data = "";
        dbRes.on("data", (chunk) => (data += chunk.toString()));
        dbRes.on("end", () => {
          const status = dbRes.statusCode || 0;
          if (!data) return resolve({ status, json: null });
          try {
            resolve({ status, json: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    reqDb.on("error", reject);
    if (payload) reqDb.write(payload);
    reqDb.end();
  });
}

async function findActiveLicenseByEmail(email) {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;

  const url = new URL(`${cfg.url}/rest/v1/licenses`);
  url.searchParams.set("select", "license_key,email,status,plan_code");
  url.searchParams.set("email", `eq.${e}`);
  url.searchParams.set("status", "eq.active");
  url.searchParams.set("limit", "1");

  try {
    const { status, json } = await supabaseRequestJson({ method: "GET", urlString: url.toString(), apiKey: cfg.key });
    if (status >= 200 && status < 300 && Array.isArray(json) && json[0] && json[0].license_key) return json[0];
  } catch {
    void 0;
  }

  return null;
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

function stripeRequest({ apiKey, method, pathname, query, body }) {
  return new Promise((resolve, reject) => {
    const qs = query && typeof query === "string" && query.trim() ? `?${query}` : "";
    const url = new URL(`https://api.stripe.com${pathname}${qs}`);
    const payload = body ? String(body) : "";
    const reqStripe = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (stripeRes) => {
        let data = "";
        stripeRes.on("data", (chunk) => (data += chunk.toString()));
        stripeRes.on("end", () => {
          const status = stripeRes.statusCode || 0;
          let json = null;
          try {
            json = JSON.parse(data || "{}");
          } catch {
            json = null;
          }
          resolve({ status, json });
        });
      }
    );
    reqStripe.on("error", reject);
    if (payload) reqStripe.write(payload);
    reqStripe.end();
  });
}

const PLAN_REGISTRY = {
  pro_lifetime: {
    license_plan: "pro",
    checkout_mode: "payment",
  },
  enterprise: {
    license_plan: "enterprise",
    checkout_mode: "auto",
  },
};

function normalizePlanCode(plan) {
  const p = String(plan || "").trim().toLowerCase();
  if (p === "pro") return "pro_lifetime";
  if (p === "price_pro_lifetime") return "pro_lifetime";
  if (p === "price_enterprise") return "enterprise";
  return p || "pro_lifetime";
}

function planEnvKeySuffix(planCode) {
  return String(planCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function resolvePriceIdByPlan({ apiKey, planCode }) {
  const suffix = planEnvKeySuffix(planCode);
  const envLookupKey = process.env[`STRIPE_PRICE_LOOKUP_KEY_${suffix}`];
  const envPriceId = process.env[`STRIPE_PRICE_ID_${suffix}`];
  const legacyProLookupKey = planCode === "pro_lifetime" ? process.env.STRIPE_PRICE_LOOKUP_KEY_PRO : "";
  const legacyProPriceId = planCode === "pro_lifetime" ? process.env.STRIPE_PRICE_ID : "";
  const legacyEnterpriseLookupKey = planCode === "enterprise" ? process.env.STRIPE_PRICE_LOOKUP_KEY_ENTERPRISE : "";
  const legacyEnterprisePriceId = planCode === "enterprise" ? process.env.STRIPE_PRICE_ID_ENTERPRISE : "";

  const lookupKey =
    (typeof envLookupKey === "string" && envLookupKey.trim() ? envLookupKey.trim() : "") ||
    (typeof legacyProLookupKey === "string" && legacyProLookupKey.trim() ? legacyProLookupKey.trim() : "") ||
    (typeof legacyEnterpriseLookupKey === "string" && legacyEnterpriseLookupKey.trim() ? legacyEnterpriseLookupKey.trim() : "");

  const fallback =
    (typeof envPriceId === "string" && envPriceId.trim() ? envPriceId.trim() : "") ||
    (typeof legacyProPriceId === "string" && legacyProPriceId.trim() ? legacyProPriceId.trim() : "") ||
    (typeof legacyEnterprisePriceId === "string" && legacyEnterprisePriceId.trim() ? legacyEnterprisePriceId.trim() : "");

  if (!lookupKey) return fallback;

  const query = encodeForm({
    active: "true",
    limit: 1,
    "lookup_keys[0]": lookupKey,
  });

  try {
    const { status, json } = await stripeRequest({ apiKey, method: "GET", pathname: "/v1/prices", query });
    if (status >= 200 && status < 300 && json && Array.isArray(json.data) && json.data[0] && json.data[0].id) {
      return json.data[0].id;
    }
  } catch {
    void 0;
  }

  return fallback;
}

async function fetchPriceInfo({ apiKey, priceId }) {
  const id = typeof priceId === "string" ? priceId.trim() : "";
  if (!id) return null;
  try {
    const { status, json } = await stripeRequest({ apiKey, method: "GET", pathname: `/v1/prices/${encodeURIComponent(id)}` });
    if (status >= 200 && status < 300 && json && typeof json === "object" && json.id) return json;
  } catch {
    void 0;
  }
  return null;
}

async function resolveCheckoutMode({ apiKey, planDef, priceId }) {
  if (!planDef || planDef.checkout_mode !== "auto") return planDef.checkout_mode;
  const price = await fetchPriceInfo({ apiKey, priceId });
  const isRecurring = !!(price && typeof price === "object" && price.recurring);
  return isRecurring ? "subscription" : "payment";
}

async function createCheckout(req, res) {
  try {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    const envSuccessUrl = process.env.STRIPE_SUCCESS_URL;
    const envCancelUrl = process.env.STRIPE_CANCEL_URL;
    const mode = getStripeModeFromKey(apiKey);

    if (!apiKey || !envSuccessUrl || !envCancelUrl) {
      return res.status(500).json({
        ok: false,
        error: "Server misconfigured",
        mode,
        hint:
          "Set STRIPE_SECRET_KEY, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL. Configure per-plan pricing via lookup keys: STRIPE_PRICE_LOOKUP_KEY_PRO_LIFETIME, STRIPE_PRICE_LOOKUP_KEY_ENTERPRISE (preferred), or fallback STRIPE_PRICE_ID_PRO_LIFETIME, STRIPE_PRICE_ID_ENTERPRISE. Legacy vars still supported: STRIPE_PRICE_LOOKUP_KEY_PRO / STRIPE_PRICE_ID and STRIPE_PRICE_LOOKUP_KEY_ENTERPRISE / STRIPE_PRICE_ID_ENTERPRISE.",
      });
    }

    const body = await readJsonBody(req);
    const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim() : "";
    const planCode = normalizePlanCode(body?.plan);
    const legacyPriceAlias = typeof body.price_id === "string" ? body.price_id.trim() : "";
    const normalizedFromAlias = normalizePlanCode(legacyPriceAlias);
    const effectivePlanCode = planCode || normalizedFromAlias;
    const requestedSuccessUrl = typeof body.success_url === "string" ? body.success_url.trim() : "";
    const requestedCancelUrl = typeof body.cancel_url === "string" ? body.cancel_url.trim() : "";

    const planDef = PLAN_REGISTRY[effectivePlanCode];
    if (!planDef) {
      return res.status(400).json({ ok: false, error: "Unknown plan", plan: effectivePlanCode });
    }

    if (customerEmail) {
      const existing = await findActiveLicenseByEmail(customerEmail);
      if (existing?.license_key) {
        return res.status(409).json({
          ok: false,
          error: "License already exists for this email",
          hint: "Use the resend page to retrieve your existing key.",
        });
      }
    }

    const priceId = await resolvePriceIdByPlan({ apiKey, planCode: effectivePlanCode });
    if (!priceId) {
      return res.status(500).json({ ok: false, error: "Server misconfigured", mode, hint: `Missing Stripe price config for plan ${effectivePlanCode}` });
    }

    const checkoutMode = await resolveCheckoutMode({ apiKey, planDef, priceId });

    const successUrl = requestedSuccessUrl || envSuccessUrl;
    const cancelUrl = requestedCancelUrl || envCancelUrl;
    const accessToken = makeCheckoutAccessToken();
    const successUrlWithToken = buildSuccessUrlWithAccessToken(successUrl, accessToken);

    const form = encodeForm({
      mode: checkoutMode,
      success_url: successUrlWithToken,
      cancel_url: cancelUrl,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      customer_email: customerEmail || undefined,
      billing_address_collection: "required",
      "tax_id_collection[enabled]": true,
      allow_promotion_codes: true,
      "metadata[plan_code]": effectivePlanCode,
      "metadata[license_plan]": planDef.license_plan,
      "metadata[stripe_price_id]": priceId,
      "metadata[license_access_token]": accessToken,
    });

    const { status, json } = await stripeRequest({ apiKey, method: "POST", pathname: "/v1/checkout/sessions", body: form });
    if (status >= 200 && status < 300 && json?.url) {
      return res.status(200).json({ ok: true, url: json.url, id: json.id });
    }
    const err = json && typeof json === "object" ? json.error : null;
    const stripeMsg = err && typeof err.message === "string" ? err.message : "";
    const hint =
      mode === "test"
        ? "This server is using Stripe test mode. Ensure your prices exist in test mode (and lookup keys match, if used)."
        : mode === "live"
          ? "This server is using Stripe live mode. Ensure your prices exist in live mode (and lookup keys match, if used)."
          : "Ensure STRIPE_SECRET_KEY and your prices match the same Stripe mode (test vs live).";
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
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = createCheckout;

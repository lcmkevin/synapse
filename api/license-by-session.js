const crypto = require("crypto");
const https = require("https");

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

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

function requestJson({ method, urlString, headers, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = https.request(
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
        res.on("data", (chunk) => (data += chunk.toString()));
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

function stripeRequest({ apiKey, method, pathname }) {
  const url = new URL(`https://api.stripe.com${pathname}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk.toString()));
        res.on("end", () => {
          const status = res.statusCode || 0;
          try {
            resolve({ status, json: data ? JSON.parse(data) : null });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function generateLicenseKey() {
  const LICENSE_SECRET = process.env.LICENSE_SECRET ?? process.env.LICENSE_SALT;
  if (!LICENSE_SECRET) throw new Error("LICENSE_SECRET is required");
  const timestampBase36 = Math.floor(Date.now() / 1000).toString(36);
  const signatureHex = crypto.createHmac("sha256", LICENSE_SECRET).update(timestampBase36).digest("hex").slice(0, 16);
  return `synapse_${timestampBase36}_${signatureHex}`;
}

function getSessionId(req) {
  const fromQuery = typeof req?.query?.session_id === "string" ? req.query.session_id.trim() : "";
  if (fromQuery) return fromQuery;
  const fromUrl =
    typeof req?.url === "string"
      ? (() => {
          try {
            return new URL(req.url, "https://localhost").searchParams.get("session_id") || "";
          } catch {
            return "";
          }
        })()
      : "";
  return fromUrl.trim();
}

function getAccessToken(req) {
  const fromQuery = typeof req?.query?.token === "string" ? req.query.token.trim() : "";
  if (fromQuery) return fromQuery;
  const fromUrl =
    typeof req?.url === "string"
      ? (() => {
          try {
            return new URL(req.url, "https://localhost").searchParams.get("token") || "";
          } catch {
            return "";
          }
        })()
      : "";
  return fromUrl.trim();
}

function normalizeEmail(email) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!e || !e.includes("@")) return "";
  return e;
}

async function findLicenseByCheckoutSessionId(checkoutSessionId) {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;
  const id = typeof checkoutSessionId === "string" ? checkoutSessionId.trim() : "";
  if (!id) return null;

  const url = new URL(`${cfg.url}/rest/v1/licenses`);
  url.searchParams.set("select", "license_key,email,status,plan_code,stripe_checkout_session_id");
  url.searchParams.set("stripe_checkout_session_id", `eq.${id}`);
  url.searchParams.set("limit", "1");

  const { status, json } = await requestJson({
    method: "GET",
    urlString: url.toString(),
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (status >= 200 && status < 300 && Array.isArray(json) && json[0] && json[0].license_key) return json[0];
  return null;
}

function normalizePlanCodeFromMetadata(session) {
  const md = session?.metadata && typeof session.metadata === "object" ? session.metadata : null;
  const raw = md && typeof md.plan_code === "string" ? md.plan_code.trim().toLowerCase() : "";
  return raw || "pro_lifetime";
}

function normalizeLicensePlanFromMetadata(session, planCode) {
  const md = session?.metadata && typeof session.metadata === "object" ? session.metadata : null;
  const raw = md && typeof md.license_plan === "string" ? md.license_plan.trim().toLowerCase() : "";
  if (raw) return raw;
  if (planCode === "enterprise") return "enterprise";
  return "pro";
}

async function upsertLicense(record) {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error("DB not configured");
  const url = `${cfg.url}/rest/v1/licenses?on_conflict=license_key`;
  const { status, json } = await requestJson({
    method: "POST",
    urlString: url,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: record,
  });
  if (!(status === 201 || status === 200 || status === 204)) {
    throw new Error(
      `DB write failed (${status})${json && typeof json === "object" && json.message ? `: ${json.message}` : ""}`
    );
  }
  return { status };
}

function isPaidCheckoutSession(session) {
  if (!session || typeof session !== "object") return false;
  const paymentStatus = typeof session.payment_status === "string" ? session.payment_status : "";
  const status = typeof session.status === "string" ? session.status : "";
  if (paymentStatus === "paid") return true;
  if (status === "complete") return true;
  return false;
}

function isValidCheckoutSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith("cs_") && sessionId.length >= 10;
}

async function handler(req, res) {
  try {
    const cfgAtStart = getSupabaseConfig();
    const requestId = crypto.randomBytes(8).toString("hex");
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "Server misconfigured" });
    if (!cfgAtStart) return res.status(500).json({ ok: false, error: "Server misconfigured" });

    const sessionIdFromQuery = getSessionId(req);
    const tokenFromQuery = getAccessToken(req);
    const body = sessionIdFromQuery ? null : await readJsonBody(req);
    const sessionIdFromBody = body && typeof body.session_id === "string" ? body.session_id.trim() : "";
    const tokenFromBody = body && typeof body.token === "string" ? body.token.trim() : "";
    const emailFromBody = body && typeof body.email === "string" ? body.email : "";
    const emailFromQuery = typeof req?.query?.email === "string" ? req.query.email : "";
    const sessionId = sessionIdFromQuery || sessionIdFromBody;
    if (!sessionId) return res.status(400).json({ ok: false, error: "session_id required" });
    if (!isValidCheckoutSessionId(sessionId) || sessionId.includes("{CHECKOUT_SESSION_ID}")) {
      return res.status(400).json({ ok: false, error: "Invalid session_id" });
    }
    const token = tokenFromQuery || tokenFromBody;
    const requestedEmail = normalizeEmail(emailFromQuery || emailFromBody);
    console.log("[license-by-session] start", {
      requestId,
      vercelEnv: process.env.VERCEL_ENV || null,
      sessionPrefix: sessionId.slice(0, 10),
      hasToken: !!token,
      hasEmail: !!requestedEmail,
      supabaseHost: (() => {
        try {
          return cfgAtStart ? new URL(cfgAtStart.url).host : null;
        } catch {
          return null;
        }
      })(),
    });

    const { status, json } = await stripeRequest({ apiKey, method: "GET", pathname: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}` });
    if (!(status >= 200 && status < 300) || !json || !isPaidCheckoutSession(json)) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    const expectedToken =
      json?.metadata && typeof json.metadata === "object" && typeof json.metadata.license_access_token === "string" ? json.metadata.license_access_token.trim() : "";
    if (expectedToken) {
      if (!token || token !== expectedToken) return res.status(404).json({ ok: false, error: "Not found" });
    } else {
      const sessionEmail = normalizeEmail(json?.customer_details?.email || json?.customer_email || "");
      if (!requestedEmail || !sessionEmail || requestedEmail !== sessionEmail) return res.status(404).json({ ok: false, error: "Not found" });
    }

    const existing = await findLicenseByCheckoutSessionId(sessionId);
    if (existing?.license_key) {
      console.log("[license-by-session] existing", { requestId, sessionPrefix: sessionId.slice(0, 10) });
      return res.status(200).json({
        ok: true,
        licenseKey: existing.license_key,
        plan: existing.plan_code || undefined,
      });
    }

    const email = json?.customer_details?.email || json?.customer_email || null;
    const subscriptionId = json?.subscription || null;
    const customerId = json?.customer || null;
    const paymentIntentId = json?.payment_intent || null;
    const planCode = normalizePlanCodeFromMetadata(json);
    const licensePlan = normalizeLicensePlanFromMetadata(json, planCode);
    const stripePriceId =
      json?.metadata && typeof json.metadata === "object" && typeof json.metadata.stripe_price_id === "string" && json.metadata.stripe_price_id.trim()
        ? json.metadata.stripe_price_id.trim()
        : null;

    const licenseKey = generateLicenseKey();
    try {
      const writeResult = await upsertLicense({
        license_key: licenseKey,
        email,
        plan: licensePlan,
        plan_code: planCode,
        status: "active",
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        stripe_checkout_session_id: sessionId,
        stripe_payment_intent_id: paymentIntentId,
        stripe_price_id: stripePriceId,
      });
      console.log("[license-by-session] wrote", { requestId, sessionPrefix: sessionId.slice(0, 10), status: writeResult.status });
    } catch (e) {
      console.error("[license-by-session] db write failed", {
        hasEmail: !!email,
        planCode,
        hasCustomerId: !!customerId,
        hasPaymentIntentId: !!paymentIntentId,
        hasSubscriptionId: !!subscriptionId,
        message: e && typeof e === "object" ? e.message : undefined,
        supabaseHost: (() => {
          try {
            const cfg = getSupabaseConfig();
            return cfg ? new URL(cfg.url).host : null;
          } catch {
            return null;
          }
        })(),
      });
      throw e;
    }

    const created = await findLicenseByCheckoutSessionId(sessionId);
    if (!created?.license_key) {
      console.error("[license-by-session] db row missing after write", { sessionId });
      return res.status(500).json({ ok: false, error: "Server error" });
    }
    console.log("[license-by-session] created", { requestId, sessionPrefix: sessionId.slice(0, 10) });

    return res.status(200).json({
      ok: true,
      licenseKey: created.license_key,
      plan: created.plan_code || undefined,
    });
  } catch (e) {
    console.error("[license-by-session] failed", { message: e && typeof e === "object" ? e.message : undefined });
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = handler;

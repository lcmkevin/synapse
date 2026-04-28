const https = require("https");

function maskEmail(email) {
  const e = typeof email === "string" ? email.trim() : "";
  if (!e.includes("@")) return "";
  const [local, domain] = e.split("@");
  const safeLocal = local.length <= 2 ? local[0] + "*" : local[0] + "*".repeat(Math.min(6, local.length - 2)) + local[local.length - 1];
  return `${safeLocal}@${domain}`;
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

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

function getEmailConfig() {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM;
  const replyTo = process.env.EMAIL_REPLY_TO;
  const secureRaw = process.env.SMTP_SECURE;

  if (!host || !portRaw || !user || !pass || !from) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) return null;
  const secure = typeof secureRaw === "string" ? secureRaw.trim().toLowerCase() === "true" : port === 465;

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    replyTo: typeof replyTo === "string" && replyTo.trim() ? replyTo.trim() : undefined,
  };
}

function supabaseRequestJson({ method, urlString, apiKey }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
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
    reqDb.end();
  });
}

async function sendLicenseEmail({ to, licenseKey, planCode, reason }) {
  const cfg = getEmailConfig();
  if (!cfg) {
    console.error("[license-email] missing SMTP_* or EMAIL_FROM env vars");
    return { ok: false, skipped: true };
  }
  const email = typeof to === "string" ? to.trim() : "";
  if (!email) {
    console.error("[license-email] missing recipient email");
    return { ok: false, skipped: true };
  }

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    console.error("[license-email] nodemailer not available in runtime");
    return { ok: false, skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const subject = "Your Synapse Pro license key";
  const lines = [];
  lines.push("Here is your Synapse Pro license key:");
  lines.push("");
  lines.push(`Plan: ${planCode || "pro_lifetime"}`);
  lines.push(`License key: ${licenseKey}`);
  lines.push("");
  lines.push("Activate:");
  lines.push("1) synapse enter-license");
  lines.push("2) paste your key");
  if (reason) {
    lines.push("");
    lines.push(`Reason: ${reason}`);
  }

  try {
    await transporter.sendMail({
      from: cfg.from,
      to: email,
      replyTo: cfg.replyTo,
      subject,
      text: lines.join("\n"),
    });
    return { ok: true };
  } catch (err) {
    console.error("[license-email] send failed", {
      to: maskEmail(email),
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      code: err && typeof err === "object" ? err.code : undefined,
      responseCode: err && typeof err === "object" ? err.responseCode : undefined,
      command: err && typeof err === "object" ? err.command : undefined,
    });
    return { ok: false };
  }
}

async function handleResend(req, res) {
  try {
    const cfg = getSupabaseConfig();
    if (!cfg) return res.status(500).json({ ok: false, error: "Server misconfigured" });

    const body = await readJsonBody(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return res.status(400).json({ ok: false, error: "Email required" });

    const url = new URL(`${cfg.url}/rest/v1/licenses`);
    url.searchParams.set("select", "license_key,email,status,plan_code");
    url.searchParams.set("email", `eq.${email}`);
    url.searchParams.set("status", "eq.active");
    url.searchParams.set("limit", "1");

    let license = null;
    try {
      const { status, json } = await supabaseRequestJson({ method: "GET", urlString: url.toString(), apiKey: cfg.key });
      if (status >= 200 && status < 300 && Array.isArray(json) && json[0] && json[0].license_key) license = json[0];
    } catch {
      void 0;
    }

    if (license?.license_key) {
      await sendLicenseEmail({ to: email, licenseKey: license.license_key, planCode: license.plan_code, reason: "resend" });
    }

    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

module.exports = handleResend;

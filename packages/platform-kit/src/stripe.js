const crypto = require("crypto");

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

function readRawBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === "string") return resolve(Buffer.from(req.body, "utf8"));

    const chunks = [];
    let total = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        done = true;
        try {
          req.destroy();
        } catch {
          void 0;
        }
        const err = new Error("Payload too large");
        err.statusCode = 413;
        return reject(err);
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = { verifyStripeSignature, readRawBody };

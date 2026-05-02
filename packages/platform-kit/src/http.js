const http = require("http");
const https = require("https");

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    if (req?.body && typeof req.body === "object") return resolve(req.body);

    let data = "";
    let total = 0;
    let done = false;

    req.on("data", (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8");
      total += buf.length;
      if (total > maxBytes) {
        done = true;
        try {
          req.destroy();
        } catch {
          void 0;
        }
        return resolve({ __synapseBodyError: "too_large" });
      }
      data += buf.toString("utf8");
    });
    req.on("end", () => {
      if (done) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function extractBearerOrBodyKey(req, { bearerPrefix = "bearer ", bodyKeys = ["licenseKey", "key"] } = {}) {
  const auth = req?.headers?.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith(bearerPrefix)) {
    const key = auth.slice(bearerPrefix.length).trim();
    if (key) return key;
  }
  const body = req?.body && typeof req.body === "object" ? req.body : {};
  for (const k of bodyKeys) {
    const v = body?.[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
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
          } catch {
            resolve({ status, json: null });
          }
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { readJsonBody, extractBearerOrBodyKey, requestJson };

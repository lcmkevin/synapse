"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const { URL } = require("url");

const core = require("./core");

const DEFAULT_TEMPLATE_ROOT = path.resolve(__dirname, "..", "Template");
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJson(res, statusCode, obj) {
  send(res, statusCode, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(obj, null, 2));
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function safePathFromPublic(urlPath) {
  const p = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(p);
  const asPosix = decoded.replace(/\\/g, "/");
  const filePath = path.resolve(PUBLIC_DIR, "." + asPosix);
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return filePath;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/info") {
    return sendJson(res, 200, {
      tool: "trae-rule-dashboard",
      templateRoot: DEFAULT_TEMPLATE_ROOT,
      templateSubPath: core.DEFAULT_TEMPLATE_SUBPATH,
      stateFile: core.DEFAULT_STATE_FILE,
    });
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const body = await readBodyJson(req);
  const projectPath = typeof body.projectPath === "string" ? body.projectPath : "";
  const targetRoot = core.normalizeTargetRoot(projectPath || process.cwd());
  const templateRoot = typeof body.templateRoot === "string" && body.templateRoot.trim() ? core.ensureAbsolute(body.templateRoot) : DEFAULT_TEMPLATE_ROOT;

  if (url.pathname === "/api/init") {
    const mode = body.mode === "copy" ? "copy" : "symlink";
    const force = !!body.force;
    const backup = !!body.backup;
    const dryRun = !!body.dryRun;

    const events = [];
    const result = await core.initDeploy({
      toolName: "trae-template",
      version: "0.1.0",
      templateRoot,
      targetRoot,
      mode,
      force,
      backup,
      dryRun,
      onProgress: (e) => events.push(e),
    });
    return sendJson(res, 200, { ok: true, result, events });
  }

  if (url.pathname === "/api/status") {
    const events = [];
    const result = await core.statusCheck({
      templateRoot,
      targetRoot,
      onProgress: (e) => events.push(e),
    });
    return sendJson(res, 200, { ok: true, result, events });
  }

  if (url.pathname === "/api/sync") {
    const force = !!body.force;
    const backup = !!body.backup;
    const dryRun = !!body.dryRun;

    const events = [];
    const result = await core.syncCopy({
      templateRoot,
      targetRoot,
      force,
      backup,
      dryRun,
      onProgress: (e) => events.push(e),
    });
    return sendJson(res, 200, { ok: true, result, events });
  }

  if (url.pathname === "/api/gitignore") {
    const dryRun = !!body.dryRun;
    const result = await core.ensureGitignore({ targetRoot, dryRun });
    return sendJson(res, 200, { ok: true, result });
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (req.method !== "GET") return send(res, 405, { "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed");

    const filePath = safePathFromPublic(url.pathname);
    if (!filePath) return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");
    if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");

    const st = await fsp.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");

    const data = await fsp.readFile(filePath);
    return send(res, 200, { "Content-Type": contentType(filePath) }, data);
  } catch (e) {
    return sendJson(res, 500, { error: e && e.message ? e.message : String(e) });
  }
}

const host = "127.0.0.1";
const portRaw = process.env.PORT || "5177";
const portNum = Number(portRaw);
const port = Number.isFinite(portNum) && portNum >= 0 ? portNum : 5177;

const server = http.createServer((req, res) => void handleRequest(req, res));
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    process.stderr.write(`Port ${port} is already in use. Try: node ./bin/trae-template.js dashboard --port=5178\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const addr = server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : port;
  process.stdout.write(`Dashboard running at http://${host}:${actualPort}/\n`);
});

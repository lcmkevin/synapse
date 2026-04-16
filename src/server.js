"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const { URL } = require("url");
const crypto = require("crypto"); // NEW:
const childProcess = require("child_process");
const os = require("os");

const core = require("./core");

const DEFAULT_TEMPLATE_ROOT = path.resolve(__dirname, "..", "Template");
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const PREVIEW_SESSION_TTL_MS = 15 * 60 * 1000;
const previewSessions = new Map();

// NEW: minimal WebSocket broadcast for sync status (no external deps)
const wsSyncClients = new Set();
let lastSyncStatus = null;

function wsAcceptKey(key) {
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  return crypto.createHash("sha1").update(String(key) + GUID, "binary").digest("base64");
}

function wsSendText(socket, text) {
  const payload = Buffer.from(String(text), "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 255, len & 255]);
  } else {
    const b = Buffer.alloc(10);
    b[0] = 0x81;
    b[1] = 127;
    b.writeBigUInt64BE(BigInt(len), 2);
    header = b;
  }
  socket.write(Buffer.concat([header, payload]));
}

function broadcastSyncStatus(payload) {
  lastSyncStatus = payload;
  const text = JSON.stringify(payload);
  for (const sock of Array.from(wsSyncClients)) {
    try {
      if (!sock || sock.destroyed) {
        wsSyncClients.delete(sock);
        continue;
      }
      wsSendText(sock, text);
    } catch {
      wsSyncClients.delete(sock);
      try {
        sock.destroy();
      } catch {
        void 0;
      }
    }
  }
}

function handleWsUpgrade(req, socket) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws/sync-status") return false;
    const key = req.headers["sec-websocket-key"];
    if (!key) return false;
    const accept = wsAcceptKey(key);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n")
    );
    wsSyncClients.add(socket);
    socket.on("close", () => wsSyncClients.delete(socket));
    socket.on("end", () => wsSyncClients.delete(socket));
    socket.on("error", () => wsSyncClients.delete(socket));
    if (lastSyncStatus) {
      try {
        wsSendText(socket, JSON.stringify(lastSyncStatus));
      } catch {
        void 0;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function prunePreviewSessions() {
  const now = Date.now();
  for (const [id, s] of previewSessions.entries()) {
    if (!s || typeof s.createdAt !== "number" || now - s.createdAt > PREVIEW_SESSION_TTL_MS) {
      previewSessions.delete(id);
      if (s && typeof s.cleanup === "function") {
        void s.cleanup().catch(() => void 0);
      }
    }
  }
}

async function runProcess(cmd, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: typeof code === "number" ? code : 1, stdout, stderr }));
  });
}

async function pickFolderDialogWin32(initialPath, title) {
  if (process.platform !== "win32") {
    throw new Error("Folder picker is only supported on Windows.");
  }

  const desc = typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : "Select Folder";
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.TopMost = $true",
    "$form.StartPosition = 'CenterScreen'",
    "$form.ShowInTaskbar = $false",
    "$form.Opacity = 0",
    "$null = $form.Show()",
    "$null = $form.Activate()",
    "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dlg.Description = '${desc.replace(/'/g, "''")}'`,
    "$dlg.ShowNewFolderButton = $false",
    "$initial = $args[0]",
    "if ($initial -and (Test-Path -LiteralPath $initial)) { $dlg.SelectedPath = $initial }",
    "$null = $dlg.ShowDialog($form)",
    "$form.Close()",
    "if ($dlg.SelectedPath) { Write-Output $dlg.SelectedPath }",
  ].join('; ');

  const init = typeof initialPath === "string" ? initialPath.trim() : "";
  const res = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script, init], // NEW:
    process.cwd()
  );
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || "").trim() || "Folder picker failed.";
    throw new Error(msg);
  }
  return (res.stdout || "").trim();
}

async function gitCloneToTemp(repoUrl, branch) {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-preview-"));
  const repoDir = path.join(parent, "repo");
  const cleanup = async () => {
    await fsp.rm(parent, { recursive: true, force: true });
  };
  const res = await runProcess("git", ["clone", "--depth", "1", "--branch", branch || "main", repoUrl, repoDir], parent);
  if (res.code !== 0) {
    await cleanup();
    const msg = (res.stderr || res.stdout || "").trim() || "git clone failed";
    throw new Error(msg);
  }
  return { repoDir, cleanup };
}

function normalizeRelPosix(p) {
  const s = String(p || "").replace(/\\/g, "/");
  const norm = path.posix.normalize(s).replace(/^(\.\/)+/, "");
  if (!norm || norm === "." || norm.includes("\0")) return null;
  if (path.posix.isAbsolute(norm)) return null;
  if (norm.startsWith("..")) return null;
  if (norm.split("/").some((part) => part === "..")) return null;
  return norm;
}

async function writeUploadedFilesToTemp(files) {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-upload-"));
  const cleanup = async () => {
    await fsp.rm(parent, { recursive: true, force: true });
  };

  if (!Array.isArray(files)) {
    await cleanup();
    throw new Error("files must be an array");
  }

  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const rel = normalizeRelPosix(f.path);
    if (!rel) continue;
    const buf = Buffer.from(String(f.contentBase64 || ""), "base64");
    const abs = path.join(parent, rel.split("/").join(path.sep));
    const dir = path.dirname(abs);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(abs, buf);
  }

  return { upstreamRoot: parent, cleanup };
}

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

  prunePreviewSessions();

  if (url.pathname === "/api/pickFolder") {
    const initialPath = typeof body.initialPath === "string" ? body.initialPath : "";
    const title = typeof body.title === "string" ? body.title : "";
    const pickedPath = await pickFolderDialogWin32(initialPath, title);
    return sendJson(res, 200, { ok: true, result: { path: pickedPath } });
  }

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
    try {
      const result = await core.syncCopy({
        templateRoot,
        targetRoot,
        force,
        backup,
        dryRun,
        onProgress: (e) => events.push(e),
      });
      broadcastSyncStatus({ ok: true, at: Date.now(), kind: "sync", dryRun: !!dryRun, targetRoot, templateRoot }); // NEW:
      return sendJson(res, 200, { ok: true, result, events });
    } catch (e) {
      broadcastSyncStatus({ ok: false, at: Date.now(), kind: "sync", dryRun: !!dryRun, targetRoot, templateRoot, error: e && e.message ? e.message : String(e) }); // NEW:
      throw e;
    }
  }

  if (url.pathname === "/api/gitignore") {
    const dryRun = !!body.dryRun;
    const result = await core.ensureGitignore({ targetRoot, dryRun });
    return sendJson(res, 200, { ok: true, result });
  }

  if (url.pathname === "/api/syncRules") {
    const overwrite = !!body.overwrite;
    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath : "";
    const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : "";
    const branch = typeof body.branch === "string" ? body.branch : "main";

    const events = [];
    let result;
    if (repoUrl && repoUrl.trim()) {
      events.push({ type: "git", repoUrl, branch });
      result = await core.syncTraeFromGit({ repoUrl: repoUrl.trim(), branch, targetRoot, kind: "rules", overwrite });
    } else {
      if (!sourcePath || !sourcePath.trim()) return sendJson(res, 400, { error: "sourcePath or repoUrl required" });
      events.push({ type: "copy", sourcePath: sourcePath.trim() });
      result = await core.syncTraeFolder({ sourceRoot: core.ensureAbsolute(sourcePath.trim()), targetRoot, kind: "rules", overwrite });
    }
    return sendJson(res, 200, { ok: true, result, events });
  }

  if (url.pathname === "/api/syncRulesUpload") {
    const overwrite = !!body.overwrite;
    const files = body.files;
    const { upstreamRoot, cleanup } = await writeUploadedFilesToTemp(files);
    try {
      const result = await core.syncTraeFolder({ sourceRoot: upstreamRoot, targetRoot, kind: "rules", overwrite });
      return sendJson(res, 200, { ok: true, result });
    } finally {
      await cleanup().catch(() => void 0);
    }
  }

  if (url.pathname === "/api/syncSkills") {
    const overwrite = !!body.overwrite;
    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath : "";
    const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : "";
    const branch = typeof body.branch === "string" ? body.branch : "main";

    const events = [];
    let result;
    if (repoUrl && repoUrl.trim()) {
      events.push({ type: "git", repoUrl, branch });
      result = await core.syncTraeFromGit({ repoUrl: repoUrl.trim(), branch, targetRoot, kind: "skills", overwrite });
    } else {
      if (!sourcePath || !sourcePath.trim()) return sendJson(res, 400, { error: "sourcePath or repoUrl required" });
      events.push({ type: "copy", sourcePath: sourcePath.trim() });
      result = await core.syncTraeFolder({ sourceRoot: core.ensureAbsolute(sourcePath.trim()), targetRoot, kind: "skills", overwrite });
    }
    return sendJson(res, 200, { ok: true, result, events });
  }

  if (url.pathname === "/api/syncSkillsUpload") {
    const overwrite = !!body.overwrite;
    const files = body.files;
    const { upstreamRoot, cleanup } = await writeUploadedFilesToTemp(files);
    try {
      const result = await core.syncTraeFolder({ sourceRoot: upstreamRoot, targetRoot, kind: "skills", overwrite });
      return sendJson(res, 200, { ok: true, result });
    } finally {
      await cleanup().catch(() => void 0);
    }
  }

  if (url.pathname === "/api/publish") {
    const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : "";
    const branch = typeof body.branch === "string" ? body.branch : "main";
    const commitMessage = typeof body.commitMessage === "string" ? body.commitMessage : "Publish Trae rules/skills";
    if (!repoUrl || !repoUrl.trim()) return sendJson(res, 400, { error: "repoUrl required" });

    const result = await core.publishTraeToGit({ sourceRoot: targetRoot, repoUrl: repoUrl.trim(), branch, commitMessage });
    return sendJson(res, 200, { ok: true, result });
  }

  if (url.pathname === "/api/merge") {
    const mode = typeof body.mode === "string" ? body.mode : "paths";
    const diff3 = !!body.diff3;
    const apply = !!body.apply;

    if (mode === "git") {
      const repoRoot = targetRoot;
      const filePath = typeof body.filePath === "string" ? body.filePath : "";
      const outPath = typeof body.outPath === "string" ? body.outPath : "";
      if (!filePath || !filePath.trim()) return sendJson(res, 400, { error: "filePath required" });
      const result = await core.mergeGitIndexConflict({
        repoRoot,
        filePath: filePath.trim(),
        outPath: outPath && outPath.trim() ? core.ensureAbsolute(outPath.trim(), repoRoot) : null,
        diff3,
        apply,
      });
      return sendJson(res, 200, { ok: true, result });
    }

    const basePath = typeof body.basePath === "string" ? body.basePath : "";
    const oursPath = typeof body.oursPath === "string" ? body.oursPath : "";
    const theirsPath = typeof body.theirsPath === "string" ? body.theirsPath : "";
    const outPath = typeof body.outPath === "string" ? body.outPath : "";
    if (!basePath || !oursPath || !theirsPath) return sendJson(res, 400, { error: "basePath, oursPath, theirsPath required" });

    const result = await core.mergeThreeWay({
      basePath: basePath.trim(),
      oursPath: oursPath.trim(),
      theirsPath: theirsPath.trim(),
      outPath: outPath && outPath.trim() ? outPath.trim() : null,
      diff3,
      apply,
      allowedRoot: targetRoot,
    });
    return sendJson(res, 200, { ok: true, result });
  }

  if (url.pathname === "/api/previewSync") {
    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath : "";
    const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : "";
    const branch = typeof body.branch === "string" ? body.branch : "main";

    let upstreamRoot = null;
    let sessionId = null;

    if (repoUrl && repoUrl.trim()) {
      const { repoDir, cleanup } = await gitCloneToTemp(repoUrl.trim(), branch);

      upstreamRoot = repoDir;
      sessionId = randomId();
      previewSessions.set(sessionId, { createdAt: Date.now(), upstreamRoot, cleanup, source: { repoUrl: repoUrl.trim(), branch } });
    } else {
      if (!sourcePath || !sourcePath.trim()) return sendJson(res, 400, { error: "sourcePath or repoUrl required" });
      upstreamRoot = core.ensureAbsolute(sourcePath.trim());
      sessionId = randomId();
      previewSessions.set(sessionId, { createdAt: Date.now(), upstreamRoot, cleanup: null, source: { sourcePath: upstreamRoot } });
    }

    const result = await core.previewPresetSync({ targetRoot, upstreamRoot });
    return sendJson(res, 200, { ok: true, sessionId, result });
  }

  if (url.pathname === "/api/previewSyncUpload") {
    const files = body.files;
    const { upstreamRoot, cleanup } = await writeUploadedFilesToTemp(files);
    const sessionId = randomId();
    previewSessions.set(sessionId, { createdAt: Date.now(), upstreamRoot, cleanup, source: { upload: true } });
    const result = await core.previewPresetSync({ targetRoot, upstreamRoot });
    return sendJson(res, 200, { ok: true, sessionId, result });
  }

  if (url.pathname === "/api/previewSyncFile") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const id = typeof body.id === "string" ? body.id : "";
    const diff3 = !!body.diff3;
    if (!sessionId || !previewSessions.has(sessionId)) return sendJson(res, 410, { error: "Preview session expired. Run Preview again." });
    if (!id) return sendJson(res, 400, { error: "id required" });

    const session = previewSessions.get(sessionId);
    const idx = id.indexOf(":");
    if (idx <= 0) return sendJson(res, 400, { error: "invalid id" });
    const kind = id.slice(0, idx);
    const relPosix = id.slice(idx + 1);

    const result = await core.previewPresetFile({ targetRoot, upstreamRoot: session.upstreamRoot, kind, relPosix, diff3 });
    return sendJson(res, 200, { ok: true, result });
  }

  if (url.pathname === "/api/previewSyncApply") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const selections = Array.isArray(body.selections) ? body.selections : [];
    const confirmDelete = !!body.confirmDelete;
    const diff3 = !!body.diff3;
    if (!sessionId || !previewSessions.has(sessionId)) return sendJson(res, 410, { error: "Preview session expired. Run Preview again." });

    const session = previewSessions.get(sessionId);
    const result = await core.applyPresetSync({ targetRoot, upstreamRoot: session.upstreamRoot, selections, diff3, confirmDelete });
    return sendJson(res, 200, { ok: true, result });
  }

  if (url.pathname === "/api/previewSyncClose") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId && previewSessions.has(sessionId)) {
      const s = previewSessions.get(sessionId);
      previewSessions.delete(sessionId);
      if (s && typeof s.cleanup === "function") await s.cleanup().catch(() => void 0);
    }
    return sendJson(res, 200, { ok: true });
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
server.on("upgrade", (req, socket) => { // NEW:
  const ok = handleWsUpgrade(req, socket);
  if (!ok) {
    try {
      socket.destroy();
    } catch {
      void 0;
    }
  }
});
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

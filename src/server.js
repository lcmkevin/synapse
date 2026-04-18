"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const fs = require("fs-extra");
const childProcess = require("child_process");
const os = require("os");

const core = require("./core");

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const DEFAULT_TEMPLATE_ROOT = path.resolve(__dirname, "..", "Template");
const PORT = Number(process.env.SYNAPSE_PORT || 3456);

const app = express();
app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "50mb" }));

const server = http.createServer(app);

const wss = new WebSocket.Server({ noServer: true });
const wsClients = new Set();
let lastSyncPayload = null;

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws/sync-status") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
  if (lastSyncPayload) {
    try {
      ws.send(JSON.stringify(lastSyncPayload));
    } catch {
      void 0;
    }
  }
});

function broadcastSync(ok, details) {
  const payload = {
    kind: "sync",
    ok: !!ok,
    at: Date.now(),
    ...(details || {}),
  };
  lastSyncPayload = payload;
  const text = JSON.stringify(payload);
  for (const ws of Array.from(wsClients)) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    } catch {
      wsClients.delete(ws);
    }
  }
}

function requireString(body, key) {
  const v = body && typeof body[key] === "string" ? body[key].trim() : "";
  return v;
}

function requireBool(body, key) {
  return !!(body && body[key]);
}

function normalizeProjectPath(p) {
  const v = String(p || "").trim();
  if (!v) throw new Error("Project Path is required.");
  return v;
}

function normalizeTemplateRoot(p) {
  const v = String(p || "").trim();
  return v || DEFAULT_TEMPLATE_ROOT;
}

async function pickFolderDialogWin32({ title, initialPath }) {
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
  ].join("; ");

  const init = typeof initialPath === "string" ? initialPath.trim() : "";
  const res = await runProcess("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script, init], process.cwd());
  const picked = (res.stdout || "").trim();
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || "Folder picker failed").trim());
  return { path: picked || null };
}

function isSafeRelPosix(relPosix) {
  if (!relPosix || typeof relPosix !== "string") return false;
  const norm = path.posix.normalize(relPosix).replace(/^(\.\/)+/, "");
  if (!norm || norm === "." || norm.includes("\0")) return false;
  if (path.posix.isAbsolute(norm)) return false;
  if (norm.startsWith("..")) return false;
  const parts = norm.split("/");
  if (parts.some((p) => p === "..")) return false;
  return true;
}

function normalizeUploadedPath(p) {
  const posix = String(p || "").replace(/\\/g, "/");
  if (!posix) return null;
  const idx = posix.indexOf("/.synapse/");
  if (idx >= 0) return posix.slice(idx + 1);
  if (posix.startsWith(".synapse/")) return posix;
  const idxRules = posix.indexOf("/rules/");
  if (idxRules >= 0) return posix.slice(idxRules + 1);
  const idxSkills = posix.indexOf("/skills/");
  if (idxSkills >= 0) return posix.slice(idxSkills + 1);
  if (posix.startsWith("rules/") || posix.startsWith("skills/")) return posix;
  return null;
}

async function materializeUploadedFiles(files) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-upload-"));
  const cleanup = async () => {
    await fs.remove(parent);
  };

  for (const f of Array.isArray(files) ? files : []) {
    const rel = normalizeUploadedPath(f && f.path ? f.path : "");
    if (!rel) continue;
    const relPosix = rel.replace(/\\/g, "/");
    if (!isSafeRelPosix(relPosix)) continue;
    const abs = path.join(parent, relPosix.split("/").join(path.sep));
    await fs.ensureDir(path.dirname(abs));
    const buf = Buffer.from(String(f.contentBase64 || ""), "base64");
    await fs.writeFile(abs, buf);
  }

  return { dir: parent, cleanup };
}

async function gitCloneToTemp({ repoUrl, branch }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-preview-git-"));
  const repoDir = path.join(parent, "repo");
  const cleanup = async () => {
    await fs.remove(parent);
  };

  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const res = await runProcess("git", ["clone", "--depth", "1", "--branch", branch || "main", repoUrl, repoDir], parent, env);
  if (res.code !== 0) {
    await cleanup();
    const msg = (res.stderr || res.stdout || "").trim() || "git clone failed";
    throw new Error(msg);
  }
  return { repoDir, cleanup };
}

function runProcess(cmd, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(cmd, args, { cwd, windowsHide: true, env: env || process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: typeof code === "number" ? code : 1, stdout, stderr }));
  });
}

const PREVIEW_SESSION_TTL_MS = 15 * 60 * 1000;
const previewSessions = new Map();

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function reapSessions() {
  const now = Date.now();
  for (const [id, s] of previewSessions.entries()) {
    if (!s || typeof s.createdAt !== "number") {
      previewSessions.delete(id);
      continue;
    }
    if (now - s.createdAt > PREVIEW_SESSION_TTL_MS) {
      previewSessions.delete(id);
      if (typeof s.cleanup === "function") void s.cleanup().catch(() => void 0);
    }
  }
}

setInterval(reapSessions, 30 * 1000).unref?.();

app.get("/api/info", async (req, res) => {
  void req;
  res.json({
    tool: "synapse-dashboard",
    version: "0.1.0",
    templateRoot: DEFAULT_TEMPLATE_ROOT,
    cwd: process.cwd(),
  });
});

app.post("/api/pickFolder", async (req, res) => {
  const body = req.body || {};
  const title = requireString(body, "title") || "Select Folder";
  const initialPath = requireString(body, "initialPath");

  if (process.platform !== "win32") {
    res.status(501).json({ error: "Folder picker only supported on Windows in this build." });
    return;
  }

  try {
    const result = await pickFolderDialogWin32({ title, initialPath });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/init", async (req, res) => {
  const body = req.body || {};
  try {
    const targetRoot = normalizeProjectPath(requireString(body, "projectPath"));
    const templateRoot = normalizeTemplateRoot(requireString(body, "templateRoot"));
    const mode = requireString(body, "mode") === "copy" ? "copy" : "symlink";
    const force = requireBool(body, "force");
    const backup = requireBool(body, "backup");
    const dryRun = requireBool(body, "dryRun");

    const events = [];
    const result = await core.initDeploy({
      toolName: "synapse",
      version: "0.1.0",
      templateRoot,
      targetRoot,
      mode,
      force,
      backup,
      dryRun,
      onProgress: (e) => events.push(e),
    });
    res.json({ ok: true, result, events });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/status", async (req, res) => {
  const body = req.body || {};
  try {
    const targetRoot = normalizeProjectPath(requireString(body, "projectPath"));
    const templateRoot = normalizeTemplateRoot(requireString(body, "templateRoot"));
    const result = await core.statusCheck({ templateRoot, targetRoot, templateSubPath: ".synapse" });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/sync", async (req, res) => {
  const body = req.body || {};
  try {
    const targetRoot = normalizeProjectPath(requireString(body, "projectPath"));
    const templateRoot = normalizeTemplateRoot(requireString(body, "templateRoot"));
    const force = requireBool(body, "force");
    const backup = requireBool(body, "backup");
    const dryRun = requireBool(body, "dryRun");

    broadcastSync(false, { phase: "syncing" });
    const events = [];
    const result = await core.syncCopy({
      templateRoot,
      targetRoot,
      force,
      backup,
      dryRun,
      onProgress: (e) => events.push(e),
    });
    broadcastSync(true, { phase: "done", dryRun: !!dryRun, targetRoot, templateRoot });
    res.json({ ok: true, result, events });
  } catch (e) {
    broadcastSync(false, { phase: "error", error: e && e.message ? e.message : String(e) });
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/gitignore", async (req, res) => {
  const body = req.body || {};
  try {
    const targetRoot = normalizeProjectPath(requireString(body, "projectPath"));
    const dryRun = requireBool(body, "dryRun");
    const result = await core.ensureGitignore({ targetRoot, dryRun });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/merge", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const mode = requireString(body, "mode") === "git" ? "git" : "paths";
    const apply = requireBool(body, "apply");
    const diff3 = requireBool(body, "diff3");

    if (mode === "git") {
      const filePath = requireString(body, "filePath");
      const outPath = requireString(body, "outPath");
      const result = await core.mergeGitIndexConflict({ repoRoot: projectPath, filePath, outPath, diff3, apply });
      res.json({ ok: true, result });
      return;
    }

    const basePath = requireString(body, "basePath");
    const oursPath = requireString(body, "oursPath");
    const theirsPath = requireString(body, "theirsPath");
    const outPath = requireString(body, "outPath");
    const result = await core.mergeThreeWay({ basePath, oursPath, theirsPath, outPath, diff3, apply, cwd: projectPath });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

async function syncKindFromFolder({ projectPath, sourcePath, kind, overwrite }) {
  return await core.syncSynapseFolder({ sourceRoot: sourcePath, targetRoot: projectPath, kind, overwrite: !!overwrite });
}

async function syncKindFromGit({ projectPath, repoUrl, branch, kind, overwrite }) {
  return await core.syncSynapseFromGit({ repoUrl, branch, targetRoot: projectPath, kind, overwrite: !!overwrite });
}

app.post("/api/syncRules", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const overwrite = requireBool(body, "overwrite");
    const repoUrl = requireString(body, "repoUrl");
    const branch = requireString(body, "branch") || "main";
    const sourcePath = requireString(body, "sourcePath");
    const result = repoUrl ? await syncKindFromGit({ projectPath, repoUrl, branch, kind: "rules", overwrite }) : await syncKindFromFolder({ projectPath, sourcePath, kind: "rules", overwrite });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/syncSkills", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const overwrite = requireBool(body, "overwrite");
    const repoUrl = requireString(body, "repoUrl");
    const branch = requireString(body, "branch") || "main";
    const sourcePath = requireString(body, "sourcePath");
    const result = repoUrl ? await syncKindFromGit({ projectPath, repoUrl, branch, kind: "skills", overwrite }) : await syncKindFromFolder({ projectPath, sourcePath, kind: "skills", overwrite });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/syncRulesUpload", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const overwrite = requireBool(body, "overwrite");
    const { dir, cleanup } = await materializeUploadedFiles(body.files);
    try {
      const result = await syncKindFromFolder({ projectPath, sourcePath: dir, kind: "rules", overwrite });
      res.json({ ok: true, result });
    } finally {
      await cleanup().catch(() => void 0);
    }
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/syncSkillsUpload", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const overwrite = requireBool(body, "overwrite");
    const { dir, cleanup } = await materializeUploadedFiles(body.files);
    try {
      const result = await syncKindFromFolder({ projectPath, sourcePath: dir, kind: "skills", overwrite });
      res.json({ ok: true, result });
    } finally {
      await cleanup().catch(() => void 0);
    }
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/publish", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const repoUrl = requireString(body, "repoUrl");
    const branch = requireString(body, "branch") || "main";
    const commitMessage = requireString(body, "commitMessage") || "Publish Synapse rules/skills";
    const result = await core.publishSynapseToGit({ sourceRoot: projectPath, repoUrl, branch, commitMessage });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/previewSyncUpload", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const { dir, cleanup } = await materializeUploadedFiles(body.files);
    try {
      const result = await core.previewPresetSync({ targetRoot: projectPath, upstreamRoot: dir });
      const sessionId = randomId();
      previewSessions.set(sessionId, { createdAt: Date.now(), upstreamRoot: dir, cleanup });
      res.json({ ok: true, sessionId, result });
    } catch (e) {
      await cleanup().catch(() => void 0);
      throw e;
    }
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/previewSync", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const repoUrl = requireString(body, "repoUrl");
    const branch = requireString(body, "branch") || "main";
    const sourcePath = requireString(body, "sourcePath");

    let upstreamRoot = null;
    let cleanup = null;

    if (repoUrl) {
      const cloned = await gitCloneToTemp({ repoUrl, branch });
      upstreamRoot = cloned.repoDir;
      cleanup = cloned.cleanup;
    } else if (sourcePath) {
      upstreamRoot = sourcePath;
    } else {
      throw new Error("Select a source folder or provide a repo URL.");
    }

    const result = await core.previewPresetSync({ targetRoot: projectPath, upstreamRoot });
    const sessionId = randomId();
    previewSessions.set(sessionId, { createdAt: Date.now(), upstreamRoot, cleanup });
    res.json({ ok: true, sessionId, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/previewSyncFile", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const sessionId = requireString(body, "sessionId");
    const id = requireString(body, "id");
    if (!sessionId || !previewSessions.has(sessionId)) throw new Error("Preview session expired. Run Preview again.");
    if (!id || !id.includes(":")) throw new Error("Invalid item id.");

    const idx = id.indexOf(":");
    const kind = id.slice(0, idx);
    const relPosix = id.slice(idx + 1);
    if (kind !== "rules" && kind !== "skills") throw new Error("Invalid kind.");

    const session = previewSessions.get(sessionId);
    const upstreamRoot = session.upstreamRoot;
    const result = await core.previewPresetFile({ targetRoot: projectPath, upstreamRoot, kind, relPosix, diff3: true });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/previewSyncApply", async (req, res) => {
  const body = req.body || {};
  try {
    const projectPath = normalizeProjectPath(requireString(body, "projectPath"));
    const sessionId = requireString(body, "sessionId");
    const selections = Array.isArray(body.selections) ? body.selections : [];
    const confirmDelete = requireBool(body, "confirmDelete");
    const diff3 = requireBool(body, "diff3");
    if (!sessionId || !previewSessions.has(sessionId)) throw new Error("Preview session expired. Run Preview again.");

    const session = previewSessions.get(sessionId);
    const result = await core.applyPresetSync({ targetRoot: projectPath, upstreamRoot: session.upstreamRoot, selections, diff3, confirmDelete });
    broadcastSync(true, { phase: "preset_applied" });
    res.json({ ok: true, result });
  } catch (e) {
    broadcastSync(false, { phase: "error", error: e && e.message ? e.message : String(e) });
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/previewSyncClose", async (req, res) => {
  const body = req.body || {};
  try {
    const sessionId = requireString(body, "sessionId");
    if (sessionId && previewSessions.has(sessionId)) {
      const s = previewSessions.get(sessionId);
      previewSessions.delete(sessionId);
      if (s && typeof s.cleanup === "function") await s.cleanup().catch(() => void 0);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`🧠 Synapse Dashboard running at http://localhost:${PORT}\n`);
});

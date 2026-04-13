"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const os = require("os");

const DEFAULT_TEMPLATE_SUBPATH = ".trae";
const DEFAULT_STATE_FILE = path.posix.join(".trae", ".deployer.json");
const DEFAULT_GITIGNORE_ENTRY = ".trae/";

function toPosixPath(p) {
  return p.split(path.sep).join(path.posix.sep);
}

function fromPosixPath(p) {
  return p.split(path.posix.sep).join(path.sep);
}

function ensureAbsolute(p, cwd) {
  return path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
}

function normalizeTargetRoot(p, cwd) {
  const abs = ensureAbsolute(p, cwd);
  return abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonIfExists(p) {
  if (!(await exists(p))) return null;
  const raw = await fsp.readFile(p, "utf8");
  return JSON.parse(raw);
}

async function writeJson(p, value) {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function listFilesRecursively(rootDir) {
  const results = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  results.sort();
  return results;
}

async function fileHash(p) {
  const buf = await fsp.readFile(p);
  return sha256Buffer(buf);
}

async function copyFileWithDirs(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
}

function formatBackupSuffix(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

async function backupPathFor(dest) {
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  const stamp = formatBackupSuffix(new Date());
  let candidate = path.join(dir, `${base}.bak.${stamp}`);
  let i = 1;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base}.bak.${stamp}.${i}`);
    i++;
  }
  return candidate;
}

async function backupExisting(dest) {
  const st = await fsp.lstat(dest);
  if (!st.isFile() && !st.isSymbolicLink()) return null;
  const backup = await backupPathFor(dest);
  await ensureDir(path.dirname(backup));
  await fsp.rename(dest, backup);
  return backup;
}

async function trySymlinkFile(src, dest) {
  await ensureDir(path.dirname(dest));
  if (await exists(dest)) {
    await fsp.unlink(dest);
  }
  await fsp.symlink(src, dest, "file");
}

async function safeWriteState(targetRoot, state) {
  const statePath = path.join(targetRoot, fromPosixPath(DEFAULT_STATE_FILE));
  await writeJson(statePath, state);
}

async function loadState(targetRoot) {
  const statePath = path.join(targetRoot, fromPosixPath(DEFAULT_STATE_FILE));
  return await readJsonIfExists(statePath);
}

async function computePlan({ templateRoot, targetRoot, templateSubPath = DEFAULT_TEMPLATE_SUBPATH }) {
  const templateTraeDir = path.join(templateRoot, templateSubPath);
  if (!(await exists(templateTraeDir))) {
    throw new Error(`Template folder not found: ${templateTraeDir}`);
  }

  const srcFiles = await listFilesRecursively(templateTraeDir);
  const plan = [];
  for (const srcFile of srcFiles) {
    const rel = path.relative(templateTraeDir, srcFile);
    const dest = path.join(targetRoot, templateSubPath, rel);
    plan.push({
      src: srcFile,
      dest,
      relPosix: toPosixPath(path.posix.join(templateSubPath, toPosixPath(rel))),
    });
  }
  return { templateTraeDir, plan };
}

async function initDeploy({
  toolName,
  version,
  templateRoot,
  targetRoot,
  mode,
  force,
  backup,
  dryRun,
  templateSubPath = DEFAULT_TEMPLATE_SUBPATH,
  onProgress,
}) {
  if (!(await exists(targetRoot)) && !dryRun) {
    await ensureDir(targetRoot);
  }

  const { plan } = await computePlan({ templateRoot, targetRoot, templateSubPath });

  const applied = [];
  const skipped = [];
  let effectiveMode = mode;

  for (const item of plan) {
    const destExists = await exists(item.dest);
    if (destExists && !force) {
      skipped.push({ ...item, reason: "exists" });
      if (onProgress) onProgress({ type: "skip", relPosix: item.relPosix });
      continue;
    }

    const templateHashAtDeploy = await fileHash(item.src);

    if (dryRun) {
      applied.push({
        ...item,
        action: effectiveMode,
        templateHashAtDeploy,
        targetHashAtDeploy: null,
        linkTarget: null,
        destExists,
        willBackup: !!(destExists && force && backup),
      });
      if (onProgress) onProgress({ type: "dryrun", relPosix: item.relPosix, action: effectiveMode });
      continue;
    }

    if (destExists && force && backup) {
      await backupExisting(item.dest);
    }

    if (effectiveMode === "symlink") {
      try {
        await trySymlinkFile(item.src, item.dest);
        applied.push({
          ...item,
          action: "symlink",
          templateHashAtDeploy,
          targetHashAtDeploy: null,
          linkTarget: item.src,
        });
        if (onProgress) onProgress({ type: "apply", relPosix: item.relPosix, action: "symlink" });
      } catch (e) {
        effectiveMode = "copy";
        await copyFileWithDirs(item.src, item.dest);
        const targetHashAtDeploy = await fileHash(item.dest);
        applied.push({
          ...item,
          action: "copy",
          note: "symlink_failed_fallback_to_copy",
          templateHashAtDeploy,
          targetHashAtDeploy,
          linkTarget: null,
        });
        if (onProgress) onProgress({ type: "apply", relPosix: item.relPosix, action: "copy" });
      }
    } else {
      await copyFileWithDirs(item.src, item.dest);
      const targetHashAtDeploy = await fileHash(item.dest);
      applied.push({
        ...item,
        action: "copy",
        templateHashAtDeploy,
        targetHashAtDeploy,
        linkTarget: null,
      });
      if (onProgress) onProgress({ type: "apply", relPosix: item.relPosix, action: "copy" });
    }
  }

  const state = {
    tool: toolName || "trae-template",
    version: version || "0.1.0",
    templateRoot: templateRoot,
    templateSubPath: templateSubPath,
    deployedAt: new Date().toISOString(),
    requestedMode: mode,
    mode: effectiveMode,
    files: applied.map((a) => ({
      path: a.relPosix,
      action: a.action,
      templateHashAtDeploy: a.templateHashAtDeploy,
      targetHashAtDeploy: a.targetHashAtDeploy,
      linkTarget: a.linkTarget,
      note: a.note || null,
    })),
  };

  if (!dryRun) {
    await safeWriteState(targetRoot, state);
  }

  return {
    targetRoot,
    templateRoot,
    requestedMode: mode,
    effectiveMode,
    applied: applied.map((a) => ({
      path: a.relPosix,
      action: a.action,
      note: a.note || null,
      destExists: typeof a.destExists === "boolean" ? a.destExists : null,
      willBackup: typeof a.willBackup === "boolean" ? a.willBackup : null,
    })),
    skipped: skipped.map((s) => ({ path: s.relPosix, reason: s.reason, destExists: true })),
    stateFile: DEFAULT_STATE_FILE,
    dryRun: !!dryRun,
  };
}

async function statusCheck({ templateRoot, targetRoot, templateSubPath = DEFAULT_TEMPLATE_SUBPATH, onProgress }) {
  const { plan } = await computePlan({ templateRoot, targetRoot, templateSubPath });

  const missing = [];
  const different = [];
  const same = [];

  for (const item of plan) {
    if (!(await exists(item.dest))) {
      missing.push(item.relPosix);
      if (onProgress) onProgress({ type: "missing", relPosix: item.relPosix });
      continue;
    }

    const st = await fsp.lstat(item.dest);
    if (st.isSymbolicLink()) {
      let ok = false;
      try {
        const link = await fsp.readlink(item.dest);
        const resolved = path.resolve(path.dirname(item.dest), link);
        ok = path.resolve(resolved) === path.resolve(item.src);
      } catch {
        ok = false;
      }
      if (ok) same.push(item.relPosix);
      else different.push(item.relPosix);
      if (onProgress) onProgress({ type: "link", relPosix: item.relPosix, ok });
      continue;
    }

    const [srcHash, destHash] = await Promise.all([fileHash(item.src), fileHash(item.dest)]);
    if (srcHash !== destHash) different.push(item.relPosix);
    else same.push(item.relPosix);
    if (onProgress) onProgress({ type: "check", relPosix: item.relPosix, ok: srcHash === destHash });
  }

  return {
    targetRoot,
    templateRoot,
    same,
    different,
    missing,
  };
}

async function syncCopy({ templateRoot, targetRoot, force, backup, dryRun, templateSubPath = DEFAULT_TEMPLATE_SUBPATH, onProgress }) {
  const state = await loadState(targetRoot);
  if (!state) {
    throw new Error(`No state file found at ${DEFAULT_STATE_FILE}. Run "init" first.`);
  }
  if (state.mode !== "copy") {
    return { targetRoot, templateRoot, updated: [], skipped: [], conflicts: [], mode: state.mode, stateFile: DEFAULT_STATE_FILE, dryRun: !!dryRun };
  }

  const { plan } = await computePlan({ templateRoot, targetRoot, templateSubPath });
  const stateByPath = new Map();
  if (Array.isArray(state.files)) {
    for (const f of state.files) {
      if (f && typeof f.path === "string") stateByPath.set(f.path, f);
    }
  }

  const updated = [];
  const skipped = [];
  const conflicts = [];

  for (const item of plan) {
    const destExists = await exists(item.dest);
    const templateHash = await fileHash(item.src);
    const prior = stateByPath.get(item.relPosix);

    if (!destExists) {
      if (!dryRun) {
        await copyFileWithDirs(item.src, item.dest);
      }
      updated.push(item.relPosix);
      if (onProgress) onProgress({ type: "add", relPosix: item.relPosix });
      if (!dryRun) {
        const targetHash = await fileHash(item.dest);
        stateByPath.set(item.relPosix, {
          path: item.relPosix,
          action: "copy",
          templateHashAtDeploy: templateHash,
          targetHashAtDeploy: targetHash,
          linkTarget: null,
          note: prior && prior.note ? prior.note : null,
        });
      }
      continue;
    }

    const st = await fsp.lstat(item.dest);
    if (st.isSymbolicLink()) {
      if (!force) {
        conflicts.push(item.relPosix);
        if (onProgress) onProgress({ type: "conflict", relPosix: item.relPosix, reason: "symlink" });
        continue;
      }
      if (!dryRun) {
        if (backup) {
          await backupExisting(item.dest);
        } else {
          await fsp.unlink(item.dest);
        }
        await copyFileWithDirs(item.src, item.dest);
      }
      updated.push(item.relPosix);
      if (onProgress) onProgress({ type: "replace", relPosix: item.relPosix });
      if (!dryRun) {
        const targetHash = await fileHash(item.dest);
        stateByPath.set(item.relPosix, {
          path: item.relPosix,
          action: "copy",
          templateHashAtDeploy: templateHash,
          targetHashAtDeploy: targetHash,
          linkTarget: null,
          note: "replaced_symlink_with_copy",
        });
      }
      continue;
    }

    const destHash = await fileHash(item.dest);
    if (destHash === templateHash) {
      skipped.push(item.relPosix);
      if (onProgress) onProgress({ type: "skip", relPosix: item.relPosix });
      continue;
    }

    const modifiedByUser = prior && typeof prior.targetHashAtDeploy === "string" && prior.targetHashAtDeploy !== destHash;
    if (modifiedByUser && !force) {
      conflicts.push(item.relPosix);
      if (onProgress) onProgress({ type: "conflict", relPosix: item.relPosix, reason: "modified" });
      continue;
    }

    if (!dryRun) {
      if (backup && destExists) {
        await backupExisting(item.dest);
      }
      await copyFileWithDirs(item.src, item.dest);
    }
    updated.push(item.relPosix);
    if (onProgress) onProgress({ type: "update", relPosix: item.relPosix });
    if (!dryRun) {
      const targetHash = await fileHash(item.dest);
      stateByPath.set(item.relPosix, {
        path: item.relPosix,
        action: "copy",
        templateHashAtDeploy: templateHash,
        targetHashAtDeploy: targetHash,
        linkTarget: null,
        note: null,
      });
    }
  }

  if (!dryRun) {
    state.deployedAt = new Date().toISOString();
    state.templateRoot = templateRoot;
    state.files = Array.from(stateByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
    await safeWriteState(targetRoot, state);
  }

  return {
    targetRoot,
    templateRoot,
    updated,
    skipped,
    conflicts,
    mode: "copy",
    stateFile: DEFAULT_STATE_FILE,
    dryRun: !!dryRun,
  };
}

async function ensureGitignore({ targetRoot, entry = DEFAULT_GITIGNORE_ENTRY, dryRun }) {
  if (!(await exists(targetRoot)) && !dryRun) {
    await ensureDir(targetRoot);
  }

  const gitignorePath = path.join(targetRoot, ".gitignore");
  const current = (await exists(gitignorePath)) ? await fsp.readFile(gitignorePath, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const hasEntry = lines.some((l) => l.trim() === entry);
  if (hasEntry) {
    return { changed: false, gitignorePath, entry };
  }

  const next = (current && !current.endsWith("\n") ? current + "\n" : current) + entry + "\n";
  if (!dryRun) {
    await fsp.writeFile(gitignorePath, next, "utf8");
  }
  return { changed: true, gitignorePath, entry, dryRun: !!dryRun };
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

async function resolveTraeSubdir(sourceRoot, kind) {
  const dotTrae = path.join(sourceRoot, DEFAULT_TEMPLATE_SUBPATH, kind);
  if (await exists(dotTrae)) return dotTrae;

  const direct = path.join(sourceRoot, kind);
  if (await exists(direct)) return direct;

  if (await exists(sourceRoot)) return sourceRoot;
  throw new Error(`Source folder not found: ${sourceRoot}`);
}

async function copyDirTree({ srcDir, destDir, overwrite }) {
  if (!(await exists(srcDir))) throw new Error(`Source directory not found: ${srcDir}`);
  await ensureDir(destDir);

  const files = await listFilesRecursively(srcDir);
  let copied = 0;
  for (const srcFile of files) {
    const rel = path.relative(srcDir, srcFile);
    const destFile = path.join(destDir, rel);
    const destExists = await exists(destFile);
    if (destExists && !overwrite) continue;
    await copyFileWithDirs(srcFile, destFile);
    copied++;
  }
  return { copied, srcDir, destDir };
}

async function syncTraeFolder({ sourceRoot, targetRoot, kind, overwrite }) {
  const srcDir = await resolveTraeSubdir(sourceRoot, kind);
  const destDir = path.join(targetRoot, DEFAULT_TEMPLATE_SUBPATH, kind);
  return await copyDirTree({ srcDir, destDir, overwrite: !!overwrite });
}

async function gitCloneToTemp({ repoUrl, branch }) {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-sync-"));
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

async function syncTraeFromGit({ repoUrl, branch, targetRoot, kind, overwrite }) {
  const { repoDir, cleanup } = await gitCloneToTemp({ repoUrl, branch });
  try {
    return await syncTraeFolder({ sourceRoot: repoDir, targetRoot, kind, overwrite });
  } finally {
    await cleanup();
  }
}

async function publishTraeToGit({ sourceRoot, repoUrl, branch, commitMessage }) {
  const { repoDir, cleanup } = await gitCloneToTemp({ repoUrl, branch });
  try {
    const srcTraeDir = path.join(sourceRoot, DEFAULT_TEMPLATE_SUBPATH);
    const rulesDir = path.join(srcTraeDir, "rules");
    const skillsDir = path.join(srcTraeDir, "skills");
    if (!(await exists(rulesDir)) && !(await exists(skillsDir))) {
      return { changed: false, reason: "no_rules_or_skills" };
    }

    const repoTraeDir = path.join(repoDir, DEFAULT_TEMPLATE_SUBPATH);
    await ensureDir(repoTraeDir);

    if (await exists(rulesDir)) {
      await copyDirTree({ srcDir: rulesDir, destDir: path.join(repoTraeDir, "rules"), overwrite: true });
    }
    if (await exists(skillsDir)) {
      await copyDirTree({ srcDir: skillsDir, destDir: path.join(repoTraeDir, "skills"), overwrite: true });
    }

    const statusRes = await runProcess("git", ["status", "--porcelain"], repoDir);
    if (statusRes.code !== 0) throw new Error((statusRes.stderr || statusRes.stdout || "git status failed").trim());
    if (!statusRes.stdout.trim()) {
      return { changed: false, reason: "no_changes" };
    }

    const addRes = await runProcess("git", ["add", "-A"], repoDir);
    if (addRes.code !== 0) throw new Error((addRes.stderr || addRes.stdout || "git add failed").trim());

    const msg = commitMessage && String(commitMessage).trim() ? String(commitMessage).trim() : "Publish Trae rules/skills";
    const commitRes = await runProcess("git", ["commit", "-m", msg], repoDir);
    if (commitRes.code !== 0) throw new Error((commitRes.stderr || commitRes.stdout || "git commit failed").trim());

    const pushRes = await runProcess("git", ["push", "origin", branch || "main"], repoDir);
    if (pushRes.code !== 0) throw new Error((pushRes.stderr || pushRes.stdout || "git push failed").trim());

    return { changed: true };
  } finally {
    await cleanup();
  }
}

function resolveUnderRoot(root, p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

async function mergeThreeWay({ basePath, oursPath, theirsPath, outPath, diff3, apply, cwd, allowedRoot }) {
  const baseAbs = allowedRoot ? resolveUnderRoot(allowedRoot, basePath) : ensureAbsolute(basePath, cwd);
  const oursAbs = allowedRoot ? resolveUnderRoot(allowedRoot, oursPath) : ensureAbsolute(oursPath, cwd);
  const theirsAbs = allowedRoot ? resolveUnderRoot(allowedRoot, theirsPath) : ensureAbsolute(theirsPath, cwd);
  const outAbs = outPath ? (allowedRoot ? resolveUnderRoot(allowedRoot, outPath) : ensureAbsolute(outPath, cwd)) : null;

  if (!baseAbs || !oursAbs || !theirsAbs || (outPath && !outAbs)) {
    throw new Error("Path is outside the allowed root.");
  }
  if (!(await exists(baseAbs))) throw new Error(`Base file not found: ${baseAbs}`);
  if (!(await exists(oursAbs))) throw new Error(`Ours file not found: ${oursAbs}`);
  if (!(await exists(theirsAbs))) throw new Error(`Theirs file not found: ${theirsAbs}`);

  const args = ["merge-file", "-p"];
  if (diff3) args.push("--diff3");
  args.push(oursAbs, baseAbs, theirsAbs);

  const runCwd = path.dirname(oursAbs);
  const res = await runProcess("git", args, runCwd);
  if (res.code !== 0 && res.code !== 1) {
    const msg = (res.stderr || res.stdout || "").trim() || "git merge-file failed";
    throw new Error(msg);
  }

  const mergedText = res.stdout;
  const hadConflicts = res.code === 1;

  let wrotePath = null;
  const shouldWrite = !!(outAbs && (apply || apply === undefined));
  if (shouldWrite) {
    await ensureDir(path.dirname(outAbs));
    await fsp.writeFile(outAbs, mergedText, "utf8");
    wrotePath = outAbs;
  }

  return { mergedText, hadConflicts, wrotePath };
}

async function mergeGitIndexConflict({ repoRoot, filePath, outPath, diff3, apply }) {
  const repoAbs = ensureAbsolute(repoRoot);
  const rel = toPosixPath(filePath);

  const baseRes = await runProcess("git", ["show", `:1:${rel}`], repoAbs);
  const oursRes = await runProcess("git", ["show", `:2:${rel}`], repoAbs);
  const theirsRes = await runProcess("git", ["show", `:3:${rel}`], repoAbs);

  if (baseRes.code !== 0 || oursRes.code !== 0 || theirsRes.code !== 0) {
    const msg = (baseRes.stderr || oursRes.stderr || theirsRes.stderr || baseRes.stdout || "").trim() || "git show stage failed";
    throw new Error(msg);
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-merge-"));
  const cleanup = async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  };

  try {
    const basePath = path.join(tempDir, "base");
    const oursPath = path.join(tempDir, "ours");
    const theirsPath = path.join(tempDir, "theirs");
    await Promise.all([
      fsp.writeFile(basePath, baseRes.stdout, "utf8"),
      fsp.writeFile(oursPath, oursRes.stdout, "utf8"),
      fsp.writeFile(theirsPath, theirsRes.stdout, "utf8"),
    ]);

    const out = outPath ? ensureAbsolute(outPath, repoAbs) : ensureAbsolute(fromPosixPath(rel), repoAbs);
    const result = await mergeThreeWay({ basePath, oursPath, theirsPath, outPath: out, diff3, apply, cwd: repoAbs });
    return { ...result, outPath: out };
  } finally {
    await cleanup();
  }
}

module.exports = {
  apiVersion: 1,
  DEFAULT_TEMPLATE_SUBPATH,
  DEFAULT_STATE_FILE,
  DEFAULT_GITIGNORE_ENTRY,
  normalizeTargetRoot,
  ensureAbsolute,
  computePlan,
  initDeploy,
  statusCheck,
  syncCopy,
  ensureGitignore,
  deploy: initDeploy,
  status: statusCheck,
  sync: syncCopy,
  gitignore: ensureGitignore,
  syncTraeFolder,
  syncTraeFromGit,
  publishTraeToGit,
  mergeThreeWay,
  mergeGitIndexConflict,
};

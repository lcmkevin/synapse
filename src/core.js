"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

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
  } catch {
    return false;
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

module.exports = {
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
};

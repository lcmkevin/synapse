#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const TOOL_NAME = "trae-template";
const DEFAULT_TEMPLATE_ROOT = path.resolve(__dirname, "..", "Template");
const DEFAULT_TEMPLATE_SUBPATH = ".trae";
const DEFAULT_STATE_FILE = path.posix.join(".trae", ".deployer.json");

function toPosixPath(p) {
  return p.split(path.sep).join(path.posix.sep);
}

function fromPosixPath(p) {
  return p.split(path.posix.sep).join(path.sep);
}

function ensureAbsolute(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function normalizeTargetRoot(p) {
  const abs = ensureAbsolute(p);
  return abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function formatBackupSuffix(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
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

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "help";

  const flags = {};
  const positionals = [];
  for (let i = cmd === "help" ? 0 : 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v === undefined) {
        flags[k] = true;
      } else {
        flags[k] = v;
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd, flags, positionals };
}

function printHelp() {
  const t = TOOL_NAME;
  process.stdout.write(
    [
      `${t} - deploy Trae Template (.trae) into a project`,
      "",
      "Usage:",
      `  ${t} init [projectPath] [--copy|--symlink] [--force] [--backup] [--dry-run] [--template-root=PATH]`,
      `  ${t} status [projectPath] [--template-root=PATH]`,
      `  ${t} sync [projectPath] [--force] [--backup] [--dry-run] [--template-root=PATH]`,
      "",
      "Notes:",
      `  - Default template root: ${DEFAULT_TEMPLATE_ROOT}`,
      `  - Deploys: ${DEFAULT_TEMPLATE_SUBPATH}/**`,
      `  - State file stored at: ${DEFAULT_STATE_FILE} in the target project`,
      "  - If you don't want to disclose your rules, add .trae/ to your project's .gitignore",
      "",
    ].join("\n")
  );
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

function resolveTemplateRoot(flags) {
  if (typeof flags["template-root"] === "string" && flags["template-root"].trim()) {
    return ensureAbsolute(flags["template-root"]);
  }
  return DEFAULT_TEMPLATE_ROOT;
}

function getMode(flags) {
  if (flags.copy && flags.symlink) {
    throw new Error("Choose only one of --copy or --symlink.");
  }
  if (flags.symlink) return "symlink";
  if (flags.copy) return "copy";
  return "symlink";
}

async function computePlan({ templateRoot, targetRoot }) {
  const templateTraeDir = path.join(templateRoot, DEFAULT_TEMPLATE_SUBPATH);
  if (!(await exists(templateTraeDir))) {
    throw new Error(`Template folder not found: ${templateTraeDir}`);
  }

  const srcFiles = await listFilesRecursively(templateTraeDir);
  const plan = [];
  for (const srcFile of srcFiles) {
    const rel = path.relative(templateTraeDir, srcFile);
    const dest = path.join(targetRoot, DEFAULT_TEMPLATE_SUBPATH, rel);
    plan.push({
      src: srcFile,
      dest,
      relPosix: toPosixPath(path.posix.join(DEFAULT_TEMPLATE_SUBPATH, toPosixPath(rel))),
    });
  }
  return { templateTraeDir, plan };
}

async function initCommand({ templateRoot, targetRoot, mode, force, backup, dryRun }) {
  const { plan } = await computePlan({ templateRoot, targetRoot });

  const applied = [];
  const skipped = [];
  let effectiveMode = mode;

  for (const item of plan) {
    const destExists = await exists(item.dest);
    if (destExists && !force) {
      skipped.push({ ...item, reason: "exists" });
      continue;
    }

    const templateHashAtDeploy = await fileHash(item.src);

    if (dryRun) {
      applied.push({ ...item, action: effectiveMode, templateHashAtDeploy, targetHashAtDeploy: null, linkTarget: null });
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
    }
  }

  const state = {
    tool: TOOL_NAME,
    version: "0.1.0",
    templateRoot: templateRoot,
    templateSubPath: DEFAULT_TEMPLATE_SUBPATH,
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

  process.stdout.write(
    [
      `Target: ${targetRoot}`,
      `Template: ${templateRoot}`,
      `Mode: ${mode}${effectiveMode !== mode ? ` (effective: ${effectiveMode})` : ""}`,
      `Applied: ${applied.length}`,
      `Skipped: ${skipped.length}${force ? "" : " (use --force to overwrite)"}`,
      dryRun ? "Dry-run: no files written." : `State: ${DEFAULT_STATE_FILE}`,
      "",
    ].join("\n")
  );
}

async function statusCommand({ templateRoot, targetRoot }) {
  const { plan } = await computePlan({ templateRoot, targetRoot });

  const missing = [];
  const different = [];
  const same = [];

  for (const item of plan) {
    if (!(await exists(item.dest))) {
      missing.push(item.relPosix);
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
      continue;
    }

    const [srcHash, destHash] = await Promise.all([fileHash(item.src), fileHash(item.dest)]);
    if (srcHash !== destHash) different.push(item.relPosix);
    else same.push(item.relPosix);
  }

  process.stdout.write(`Target: ${targetRoot}\nTemplate: ${templateRoot}\n\n`);
  process.stdout.write(`Same: ${same.length}\nDifferent: ${different.length}\nMissing: ${missing.length}\n\n`);
  if (different.length) {
    process.stdout.write("Different:\n");
    for (const p of different) process.stdout.write(`  - ${p}\n`);
    process.stdout.write("\n");
  }
  if (missing.length) {
    process.stdout.write("Missing:\n");
    for (const p of missing) process.stdout.write(`  - ${p}\n`);
    process.stdout.write("\n");
  }

  if (missing.length || different.length) {
    process.exitCode = 2;
  }
}

async function syncCommand({ templateRoot, targetRoot, force, backup, dryRun }) {
  const state = await loadState(targetRoot);
  if (!state) {
    throw new Error(`No state file found at ${DEFAULT_STATE_FILE}. Run "${TOOL_NAME} init" first.`);
  }
  if (state.mode !== "copy") {
    process.stdout.write(`Mode is "${state.mode}". Sync only applies to copy deployments.\n`);
    return;
  }

  const { plan } = await computePlan({ templateRoot, targetRoot });
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
      continue;
    }

    const modifiedByUser = prior && typeof prior.targetHashAtDeploy === "string" && prior.targetHashAtDeploy !== destHash;
    if (modifiedByUser && !force) {
      conflicts.push(item.relPosix);
      continue;
    }

    if (!dryRun) {
      if (backup && destExists) {
        await backupExisting(item.dest);
      }
      await copyFileWithDirs(item.src, item.dest);
    }
    updated.push(item.relPosix);
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

  process.stdout.write(
    [
      `Target: ${targetRoot}`,
      `Template: ${templateRoot}`,
      `Updated: ${updated.length}`,
      `Skipped: ${skipped.length}`,
      `Conflicts: ${conflicts.length}${conflicts.length ? " (use --force to overwrite)" : ""}`,
      dryRun ? "Dry-run: no files written." : `State: ${DEFAULT_STATE_FILE}`,
      "",
    ].join("\n")
  );

  if (conflicts.length) {
    process.stdout.write("Conflicts:\n");
    for (const p of conflicts) process.stdout.write(`  - ${p}\n`);
    process.stdout.write("\n");
    process.exitCode = 2;
  }
}

async function main() {
  const { cmd, flags, positionals } = parseArgs(process.argv);
  if (flags.help || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  const templateRoot = resolveTemplateRoot(flags);
  const targetRoot = normalizeTargetRoot(positionals[0] || process.cwd());

  const force = !!flags.force;
  const backup = !!flags.backup;
  const dryRun = !!flags["dry-run"];

  if (cmd === "init") {
    const mode = getMode(flags);
    await initCommand({ templateRoot, targetRoot, mode, force, backup, dryRun });
    return;
  }
  if (cmd === "status") {
    await statusCommand({ templateRoot, targetRoot });
    return;
  }
  if (cmd === "sync") {
    await syncCommand({ templateRoot, targetRoot, force, backup, dryRun });
    return;
  }

  printHelp();
}

main().catch((err) => {
  process.stderr.write(`${TOOL_NAME}: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

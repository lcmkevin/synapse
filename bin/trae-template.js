#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const childProcess = require("child_process");
const os = require("os");
const core = require("../src/core");

const TOOL_NAME = "trae-template";
const DEFAULT_TEMPLATE_ROOT = path.resolve(__dirname, "..", "Template");
const DEFAULT_TEMPLATE_SUBPATH = ".trae";
const DEFAULT_STATE_FILE = path.posix.join(".trae", ".deployer.json");
const DEFAULT_GITIGNORE_ENTRY = ".trae/";

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

function isTty() {
  return !!process.stdout.isTTY && !!process.stdin.isTTY;
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

function createLogger({ quiet, verbose, logFile }) {
  const level = quiet ? 0 : verbose ? 2 : 1;

  function writeLine(stream, msg) {
    stream.write(String(msg) + "\n");
  }

  async function appendLog(line) {
    if (!logFile) return;
    try {
      await ensureDir(path.dirname(logFile));
      await fsp.appendFile(logFile, line + "\n", "utf8");
    } catch {
      // ignore
    }
  }

  function formatLine(kind, msg) {
    const ts = new Date().toISOString();
    return `[${ts}] ${kind.toUpperCase()}: ${msg}`;
  }

  return {
    info(msg) {
      if (level >= 1) writeLine(process.stdout, msg);
      void appendLog(formatLine("info", msg));
    },
    warn(msg) {
      if (level >= 1) writeLine(process.stderr, msg);
      void appendLog(formatLine("warn", msg));
    },
    error(msg) {
      writeLine(process.stderr, msg);
      void appendLog(formatLine("error", msg));
    },
    debug(msg) {
      if (level >= 2) writeLine(process.stdout, msg);
      void appendLog(formatLine("debug", msg));
    },
    isQuiet: level === 0,
    isVerbose: level >= 2,
  };
}

function createProgress(total, logger) {
  if (!isTty() || logger.isVerbose || logger.isQuiet) {
    return {
      tick() {},
      end() {},
    };
  }

  let current = 0;
  let lastLen = 0;
  function render(msg) {
    const prefix = `[${current}/${total}] `;
    const line = prefix + msg;
    const pad = lastLen > line.length ? " ".repeat(lastLen - line.length) : "";
    process.stdout.write("\r" + line + pad);
    lastLen = line.length;
  }

  return {
    tick(msg) {
      current++;
      render(msg);
    },
    end() {
      if (lastLen) process.stdout.write("\n");
    },
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "help";

  const flags = {};
  const positionals = [];
  for (let i = cmd === "help" ? 0 : 1; i < args.length; i++) {
    const a = args[i];
    if (a === "-h") {
      flags.help = true;
    } else if (a === "-v") {
      flags.verbose = true;
    } else if (a === "-q") {
      flags.quiet = true;
    } else if (a.startsWith("--")) {
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
      `  ${t} init [projectPath] [--copy|--symlink] [--force] [--backup] [--dry-run] [--template-root=PATH] [--interactive]`,
      `  ${t} status [projectPath] [--template-root=PATH]`,
      `  ${t} sync [projectPath] [--force] [--backup] [--dry-run] [--template-root=PATH]`,
      `  ${t} gitignore [projectPath] [--dry-run]`,
      `  ${t} dashboard [--port=5177]`,
      `  ${t} doctor`,
      "",
      "Notes:",
      `  - Default template root: ${DEFAULT_TEMPLATE_ROOT}`,
      `  - Deploys: ${DEFAULT_TEMPLATE_SUBPATH}/**`,
      `  - State file stored at: ${DEFAULT_STATE_FILE} in the target project`,
      "  - If you don't want to disclose your rules, add .trae/ to your project's .gitignore",
      "",
      "Common flags:",
      "  -v, --verbose           Show per-file actions",
      "  -q, --quiet             Only show errors",
      "  --log-file=PATH         Append logs to a file",
      "",
    ].join("\n")
  );
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number(n));
  const pb = String(b).split(".").map((n) => Number(n));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function doctorCommand({ templateRoot, logger }) {
  const issues = [];

  const nodeVer = process.versions.node || "";
  const minNode = "16.17.0";
  if (compareVersions(nodeVer, minNode) < 0) {
    issues.push(`Node.js ${minNode}+ required (current: ${nodeVer})`);
  }

  const templateTrae = path.join(templateRoot, DEFAULT_TEMPLATE_SUBPATH);
  if (!(await exists(templateTrae))) {
    issues.push(`Template folder not found: ${templateTrae}`);
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "trae-rule-"));
  const src = path.join(tempDir, "src.txt");
  const dest = path.join(tempDir, "dest.txt");
  await fsp.writeFile(src, "test", "utf8");
  let symlinkOk = true;
  try {
    await fsp.symlink(src, dest, "file");
  } catch {
    symlinkOk = false;
  }
  await fsp.rm(tempDir, { recursive: true, force: true });

  logger.info(`Node: ${nodeVer}`);
  logger.info(`Template root: ${templateRoot}`);
  logger.info(`Symlink capability: ${symlinkOk ? "OK" : "NOT AVAILABLE"} (copy mode still works)`);
  logger.info("");

  if (issues.length) {
    logger.error("Issues:");
    for (const i of issues) logger.error(`- ${i}`);
    process.exitCode = 2;
  } else {
    logger.info("OK");
  }
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

async function promptLine(question, defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;
  const answer = await new Promise((resolve) => rl.question(q, (val) => resolve(val)));
  rl.close();
  const trimmed = String(answer).trim();
  return trimmed.length ? trimmed : defaultValue;
}

async function promptChoice(question, choices, defaultValue) {
  const choiceText = choices.map((c) => (c === defaultValue ? `${c}*` : c)).join(", ");
  const ans = await promptLine(`${question} [${choiceText}]`, defaultValue);
  if (choices.includes(ans)) return ans;
  return defaultValue;
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

async function initCommand({ templateRoot, targetRoot, mode, force, backup, dryRun, logger }) {
  if (!(await exists(targetRoot))) {
    if (!dryRun) {
      await ensureDir(targetRoot);
    } else {
      logger.warn(`Target folder does not exist (dry-run): ${targetRoot}`);
    }
  }

  const { plan } = await core.computePlan({ templateRoot, targetRoot, templateSubPath: DEFAULT_TEMPLATE_SUBPATH });
  const progress = createProgress(plan.length, logger);

  const result = await core.initDeploy({
    toolName: TOOL_NAME,
    version: "0.1.0",
    templateRoot,
    targetRoot,
    mode,
    force,
    backup,
    dryRun,
    templateSubPath: DEFAULT_TEMPLATE_SUBPATH,
    onProgress: (e) => {
      if (e.type === "skip") progress.tick(`skip ${e.relPosix}`);
      else if (e.type === "dryrun") progress.tick(`${e.action} ${e.relPosix}`);
      else if (e.type === "apply") progress.tick(`${e.action} ${e.relPosix}`);
      else progress.tick(`${e.type} ${e.relPosix}`);
    },
  });
  progress.end();

  logger.info(`Target: ${result.targetRoot}`);
  logger.info(`Template: ${result.templateRoot}`);
  logger.info(`Mode: ${result.requestedMode}${result.effectiveMode !== result.requestedMode ? ` (effective: ${result.effectiveMode})` : ""}`);
  logger.info(`Applied: ${result.applied.length}`);
  logger.info(`Skipped: ${result.skipped.length}${force ? "" : " (use --force to overwrite)"}`);
  logger.info(result.dryRun ? "Dry-run: no files written." : `State: ${result.stateFile}`);
  if (logger.isVerbose) {
    for (const a of result.applied) logger.debug(`APPLY ${a.action.toUpperCase()} ${a.path}${a.note ? ` (${a.note})` : ""}`);
    for (const s of result.skipped) logger.debug(`SKIP ${s.path} (${s.reason})`);
  }
  logger.info("");
}

async function statusCommand({ templateRoot, targetRoot, logger }) {
  const { plan } = await core.computePlan({ templateRoot, targetRoot, templateSubPath: DEFAULT_TEMPLATE_SUBPATH });
  const progress = createProgress(plan.length, logger);

  const result = await core.statusCheck({
    templateRoot,
    targetRoot,
    templateSubPath: DEFAULT_TEMPLATE_SUBPATH,
    onProgress: (e) => {
      if (e.type === "missing") progress.tick(`missing ${e.relPosix}`);
      else if (e.type === "link") progress.tick(`link ${e.relPosix}`);
      else progress.tick(`check ${e.relPosix}`);
    },
  });
  progress.end();

  logger.info(`Target: ${targetRoot}`);
  logger.info(`Template: ${templateRoot}`);
  logger.info("");
  logger.info(`Same: ${result.same.length}`);
  logger.info(`Different: ${result.different.length}`);
  logger.info(`Missing: ${result.missing.length}`);
  logger.info("");
  if (result.different.length) {
    logger.info("Different:");
    for (const p of result.different) logger.info(`  - ${p}`);
    logger.info("");
  }
  if (result.missing.length) {
    logger.info("Missing:");
    for (const p of result.missing) logger.info(`  - ${p}`);
    logger.info("");
  }

  if (result.missing.length || result.different.length) {
    process.exitCode = 2;
  }
}

async function syncCommand({ templateRoot, targetRoot, force, backup, dryRun, logger }) {
  const { plan } = await core.computePlan({ templateRoot, targetRoot, templateSubPath: DEFAULT_TEMPLATE_SUBPATH });
  const progress = createProgress(plan.length, logger);
  const result = await core.syncCopy({
    templateRoot,
    targetRoot,
    force,
    backup,
    dryRun,
    templateSubPath: DEFAULT_TEMPLATE_SUBPATH,
    onProgress: (e) => {
      if (e.type === "conflict") progress.tick(`conflict ${e.relPosix}`);
      else if (e.type === "add") progress.tick(`add ${e.relPosix}`);
      else if (e.type === "replace") progress.tick(`replace ${e.relPosix}`);
      else if (e.type === "update") progress.tick(`update ${e.relPosix}`);
      else progress.tick(`skip ${e.relPosix}`);
    },
  });
  progress.end();

  if (result.mode && result.mode !== "copy") {
    logger.info(`Mode is "${result.mode}". Sync only applies to copy deployments.`);
    return;
  }

  logger.info(`Target: ${targetRoot}`);
  logger.info(`Template: ${templateRoot}`);
  logger.info(`Updated: ${result.updated.length}`);
  logger.info(`Skipped: ${result.skipped.length}`);
  logger.info(`Conflicts: ${result.conflicts.length}${result.conflicts.length ? " (use --force to overwrite)" : ""}`);
  logger.info(result.dryRun ? "Dry-run: no files written." : `State: ${result.stateFile}`);
  logger.info("");

  if (result.conflicts.length) {
    logger.info("Conflicts:");
    for (const p of result.conflicts) logger.info(`  - ${p}`);
    logger.info("");
    process.exitCode = 2;
  }
}

async function gitignoreCommand({ targetRoot, dryRun, logger }) {
  if (!(await exists(targetRoot))) {
    if (!dryRun) {
      await ensureDir(targetRoot);
    } else {
      logger.warn(`Target folder does not exist (dry-run): ${targetRoot}`);
    }
  }

  const result = await core.ensureGitignore({ targetRoot, entry: DEFAULT_GITIGNORE_ENTRY, dryRun });
  if (!result.changed) {
    logger.info(`Already present: ${DEFAULT_GITIGNORE_ENTRY}`);
    return;
  }
  logger.info(dryRun ? `Would add ${DEFAULT_GITIGNORE_ENTRY} to ${result.gitignorePath}` : `Added ${DEFAULT_GITIGNORE_ENTRY} to ${result.gitignorePath}`);
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
  const interactive = !!flags.interactive;
  const quiet = !!flags.quiet;
  const verbose = !!flags.verbose;
  const logFile = typeof flags["log-file"] === "string" && flags["log-file"].trim() ? ensureAbsolute(flags["log-file"]) : null;
  const logger = createLogger({ quiet, verbose, logFile });

  if (cmd === "dashboard") {
    const portRaw = typeof flags.port === "string" ? flags.port : flags.port === true ? "" : "";
    const portNum = portRaw ? Number(portRaw) : 5177;
    const port = Number.isFinite(portNum) && portNum > 0 ? portNum : 5177;
    const serverEntry = path.resolve(__dirname, "..", "src", "server.js");
    logger.info(`Dashboard: http://127.0.0.1:${port}/`);

    const child = childProcess.spawn(process.execPath, [serverEntry], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(port) },
    });

    await new Promise((resolve) => child.on("exit", resolve));
    return;
  }

  if (cmd === "doctor") {
    await doctorCommand({ templateRoot, logger });
    return;
  }

  if (cmd === "init") {
    let resolvedTargetRoot = targetRoot;
    let mode = getMode(flags);

    if (interactive || (!positionals[0] && isTty())) {
      resolvedTargetRoot = normalizeTargetRoot(await promptLine("Project path", process.cwd()));
      mode = await promptChoice("Deploy mode", ["symlink", "copy"], mode);
    }

    await initCommand({ templateRoot, targetRoot: resolvedTargetRoot, mode, force, backup, dryRun, logger });
    return;
  }
  if (cmd === "status") {
    await statusCommand({ templateRoot, targetRoot, logger });
    return;
  }
  if (cmd === "sync") {
    await syncCommand({ templateRoot, targetRoot, force, backup, dryRun, logger });
    return;
  }
  if (cmd === "gitignore") {
    await gitignoreCommand({ targetRoot, dryRun, logger });
    return;
  }

  printHelp();
}

main().catch((err) => {
  process.stderr.write(`${TOOL_NAME}: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

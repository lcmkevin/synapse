#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const childProcess = require("child_process");
const os = require("os");
const core = require("../src/core");

const TOOL_NAME = "trae-template";
const DEFAULT_TEMPLATE_ROOT = path.resolve(__dirname, "..", "Template");
const DEFAULT_TEMPLATE_SUBPATH = ".trae";
const DEFAULT_STATE_FILE = path.posix.join(".trae", ".deployer.json");
const DEFAULT_GITIGNORE_ENTRY = ".trae/";

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
      `  ${t} sync-rules [projectPath] [--from=PATH|--repo=URL] [--branch=main] [--overwrite] [--interactive]`,
      `  ${t} sync-skills [projectPath] [--from=PATH|--repo=URL] [--branch=main] [--overwrite] [--interactive]`,
      `  ${t} publish [projectPath] --repo=URL [--branch=main] [--message=TEXT]`,
      `  ${t} merge --base=PATH --ours=PATH --theirs=PATH [--out=PATH] [--apply] [--diff3]`,
      `  ${t} merge-git <filePath> [--repo=PATH] [--out=PATH] [--apply] [--diff3]`,
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

function resolveTemplateRoot(flags) {
  if (typeof flags["template-root"] === "string" && flags["template-root"].trim()) {
    return core.ensureAbsolute(flags["template-root"]);
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

async function syncTraeKindCommand({ kind, targetRoot, flags, logger }) {
  const overwrite = !!flags.overwrite;
  const interactive = !!flags.interactive;

  const fromFlag = typeof flags.from === "string" && flags.from.trim() ? flags.from.trim() : "";
  const repoFlag = typeof flags.repo === "string" && flags.repo.trim() ? flags.repo.trim() : "";
  const branch = typeof flags.branch === "string" && flags.branch.trim() ? flags.branch.trim() : "main";

  let sourceType = fromFlag ? "from" : repoFlag ? "repo" : "";
  if (!sourceType) {
    if (!interactive && !isTty()) {
      throw new Error(`Missing source. Provide --from=PATH or --repo=URL.`);
    }
    sourceType = await promptChoice("Source type", ["from", "repo"], "from");
  }

  if (sourceType === "repo") {
    const repoUrl = repoFlag || (await promptLine("Repo URL", ""));
    if (!repoUrl) throw new Error("Repo URL is required.");
    const res = await core.syncTraeFromGit({ repoUrl, branch, targetRoot, kind, overwrite });
    logger.info(`Synced ${kind} from repo into ${path.join(targetRoot, ".trae", kind)}`);
    logger.info(`Copied: ${res.copied}`);
    logger.info("");
    return;
  }

  const sourceRoot = fromFlag || (await promptLine("Source folder", process.cwd()));
  const res = await core.syncTraeFolder({ sourceRoot, targetRoot, kind, overwrite });
  logger.info(`Synced ${kind} from folder into ${path.join(targetRoot, ".trae", kind)}`);
  logger.info(`Copied: ${res.copied}`);
  logger.info("");
}

async function publishCommand({ targetRoot, flags, logger }) {
  const repoUrl = typeof flags.repo === "string" && flags.repo.trim() ? flags.repo.trim() : "";
  if (!repoUrl) throw new Error("Missing --repo=URL.");
  const branch = typeof flags.branch === "string" && flags.branch.trim() ? flags.branch.trim() : "main";
  const message = typeof flags.message === "string" && flags.message.trim() ? flags.message.trim() : "Publish Trae rules/skills";

  const res = await core.publishTraeToGit({ sourceRoot: targetRoot, repoUrl, branch, commitMessage: message });
  if (!res.changed) {
    logger.info(`Publish skipped: ${res.reason}`);
    return;
  }
  logger.info("Published rules/skills to team repo.");
}

async function mergeCommand({ flags, logger }) {
  const base = typeof flags.base === "string" && flags.base.trim() ? flags.base.trim() : "";
  const ours = typeof flags.ours === "string" && flags.ours.trim() ? flags.ours.trim() : "";
  const theirs = typeof flags.theirs === "string" && flags.theirs.trim() ? flags.theirs.trim() : "";
  const out = typeof flags.out === "string" && flags.out.trim() ? flags.out.trim() : "";
  const diff3 = !!flags.diff3;
  const apply = !!flags.apply || !!out;

  if (!base || !ours || !theirs) {
    throw new Error("Missing required flags: --base=PATH --ours=PATH --theirs=PATH");
  }

  const res = await core.mergeThreeWay({
    basePath: core.ensureAbsolute(base),
    oursPath: core.ensureAbsolute(ours),
    theirsPath: core.ensureAbsolute(theirs),
    outPath: out ? core.ensureAbsolute(out) : apply ? core.ensureAbsolute(ours) : null,
    diff3,
    apply,
    cwd: process.cwd(),
  });

  if (!apply && !res.wrotePath) {
    process.stdout.write(res.mergedText);
  } else {
    logger.info(`Merged output: ${res.wrotePath || out || ours}`);
  }
  if (res.hadConflicts) process.exitCode = 2;
}

async function mergeGitCommand({ positionals, flags, logger }) {
  const filePath = positionals[0];
  if (!filePath) throw new Error("Missing <filePath>.");
  const repoRoot = typeof flags.repo === "string" && flags.repo.trim() ? flags.repo.trim() : process.cwd();
  const out = typeof flags.out === "string" && flags.out.trim() ? flags.out.trim() : "";
  const diff3 = !!flags.diff3;
  const apply = !!flags.apply || !!out;

  const res = await core.mergeGitIndexConflict({
    repoRoot: core.ensureAbsolute(repoRoot),
    filePath,
    outPath: out ? core.ensureAbsolute(out) : null,
    diff3,
    apply,
  });

  if (!apply) {
    process.stdout.write(res.mergedText);
  } else {
    logger.info(`Merged output: ${res.wrotePath || res.outPath}`);
  }
  if (res.hadConflicts) process.exitCode = 2;
}

async function main() {
  const { cmd, flags, positionals } = parseArgs(process.argv);
  if (flags.help || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  const templateRoot = resolveTemplateRoot(flags);
  const targetRoot = core.normalizeTargetRoot(positionals[0] || process.cwd());

  const force = !!flags.force;
  const backup = !!flags.backup;
  const dryRun = !!flags["dry-run"];
  const interactive = !!flags.interactive;
  const quiet = !!flags.quiet;
  const verbose = !!flags.verbose;
  const logFile = typeof flags["log-file"] === "string" && flags["log-file"].trim() ? core.ensureAbsolute(flags["log-file"]) : null;
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
      resolvedTargetRoot = core.normalizeTargetRoot(await promptLine("Project path", process.cwd()));
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
  if (cmd === "sync-rules") {
    await syncTraeKindCommand({ kind: "rules", targetRoot, flags, logger });
    return;
  }
  if (cmd === "sync-skills") {
    await syncTraeKindCommand({ kind: "skills", targetRoot, flags, logger });
    return;
  }
  if (cmd === "publish") {
    await publishCommand({ targetRoot, flags, logger });
    return;
  }
  if (cmd === "merge") {
    await mergeCommand({ flags, logger });
    return;
  }
  if (cmd === "merge-git") {
    await mergeGitCommand({ positionals, flags, logger });
    return;
  }

  printHelp();
}

main().catch((err) => {
  process.stderr.write(`${TOOL_NAME}: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

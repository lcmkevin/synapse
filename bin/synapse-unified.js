#!/usr/bin/env node

const { Command } = require("commander");
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const { SynapseError, printCliError } = require(path.resolve(__dirname, "..", "src", "error-handler.js"));

const program = new Command();
const isCompiled = typeof process.pkg !== "undefined";
if (isCompiled) {
  process.env.SYNAPSE_BINARY = "true";
}

function cwdPath(...parts) {
  return path.join(process.cwd(), ...parts);
}

function synapseDir() {
  return cwdPath(".synapse");
}

function rulesDir() {
  return cwdPath(".synapse", "rules");
}

function skillsDir() {
  return cwdPath(".synapse", "skills");
}

function configPath() {
  return cwdPath(".synapse", "config.json");
}

async function ensureInitialized() {
  const root = synapseDir();
  if (!(await fs.pathExists(root))) {
    throw new SynapseError({
      code: "E_NOT_INITIALIZED",
      message: "Synapse is not initialized in this folder.",
      suggestion: "Initialize Synapse once, then retry your command.",
      commandHint: "synapse init",
    });
  }
}

function parseRuleFile(content, filePath) {
  const id = path.basename(filePath, path.extname(filePath));
  const nameMatch = content.match(/^# Rule:\s*(.+)$/m);
  const descMatch = content.match(/^# Description:\s*(.+)$/m);
  const name = (nameMatch && nameMatch[1] ? nameMatch[1].trim() : "") || id;
  const description = descMatch && descMatch[1] ? descMatch[1].trim() : undefined;

  const constraints = [];
  const skills = [];
  for (const line of content.split("\n")) {
    if (line.includes("# @constraint")) constraints.push(line.replace("# @constraint", "").trim());
    if (line.includes("# @skill")) skills.push(line.replace("# @skill", "").trim());
  }

  const body = content
    .split("\n")
    .filter((l) => !l.startsWith("# Rule:"))
    .filter((l) => !l.startsWith("# Description:"))
    .filter((l) => !l.startsWith("# Constraints:"))
    .filter((l) => !l.startsWith("# @constraint"))
    .filter((l) => !l.startsWith("# Skills:"))
    .filter((l) => !l.startsWith("# @skill"))
    .join("\n")
    .trim();

  return { id, name, description, content: body, constraints, skills };
}

function compileTrae(rule, { minify } = {}) {
  const lines = [];
  lines.push(`# ${rule.name}`);
  lines.push("");

  if (rule.description) {
    lines.push(rule.description);
    lines.push("");
  }

  lines.push(minify ? String(rule.content || "").trim() : String(rule.content || ""));
  lines.push("");

  if (rule.constraints && rule.constraints.length) {
    lines.push("## Constraints");
    lines.push("");
    for (const c of rule.constraints) lines.push(`- ${String(c).replace("@constraint ", "").trim()}`);
    lines.push("");
  }

  if (rule.skills && rule.skills.length) {
    lines.push("## Skills");
    lines.push("");
    for (const s of rule.skills) lines.push(`- ${String(s).replace("@skill ", "").trim()}`);
  }
  const out = lines.join("\n");
  return minify ? out.replace(/\n{3,}/g, "\n\n") : out;
}

function compileZedRules(rules, { minify } = {}) {
  const lines = [];
  lines.push("# Synapse Rules (.rules)");
  lines.push("");
  lines.push("Generated from .synapse/rules/*.synapse");
  lines.push("");

  for (const rule of rules) {
    lines.push(`## ${rule.name}`);
    lines.push("");
    if (rule.description) {
      lines.push(rule.description);
      lines.push("");
    }
    lines.push(minify ? String(rule.content || "").trim() : String(rule.content || ""));
    lines.push("");
    if (rule.constraints && rule.constraints.length) {
      lines.push("Constraints:");
      for (const c of rule.constraints) lines.push(`- ${String(c).replace("@constraint ", "").trim()}`);
      lines.push("");
    }
    if (rule.skills && rule.skills.length) {
      lines.push("Skills:");
      for (const s of rule.skills) lines.push(`- ${String(s).replace("@skill ", "").trim()}`);
      lines.push("");
    }
  }

  const out = lines.join("\n").trimEnd() + "\n";
  return minify ? out.replace(/\n{3,}/g, "\n\n") : out;
}

function compileCursor(rule, { minify } = {}) {
  const lines = [];
  lines.push("---");
  lines.push(`description: ${rule.description || rule.name}`);
  const globs = rule.constraints && rule.constraints.length ? rule.constraints.join(", ") : "**/*";
  lines.push(`globs: ${globs}`);
  lines.push("---");
  lines.push("");
  lines.push(minify ? String(rule.content || "").trim() : String(rule.content || ""));
  if (rule.skills && rule.skills.length) {
    lines.push("");
    lines.push("## Skills");
    for (const s of rule.skills) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}

function compileWindsurf(rule, { minify } = {}) {
  const payload = {
    name: rule.name,
    description: rule.description || "",
    content: minify ? String(rule.content || "").trim() : String(rule.content || ""),
    constraints: (rule.constraints || []).map((c) => String(c).replace("@constraint ", "").trim()).filter(Boolean),
    skills: (rule.skills || []).map((s) => String(s).replace("@skill ", "").trim()).filter(Boolean),
  };
  return JSON.stringify(payload, null, minify ? 0 : 2);
}

function getTargetPath(target) {
  const map = {
    trae: path.join(".trae", "rules"),
    cursor: path.join(".cursor", "rules"),
    windsurf: ".windsurf",
    cline: ".clinerules",
    zed: "",
  };
  return map[target] || `.${target}`;
}

function getTargetExtension(target) {
  const map = {
    trae: ".md",
    cursor: ".mdc",
    windsurf: ".windsurfrules",
    cline: ".md",
    zed: ".rules",
  };
  return map[target] || ".txt";
}

function makeColorFns(enabled) {
  const reset = "\x1b[0m";
  const codes = {
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    dim: "\x1b[2m",
  };
  const wrap = (code, text) => (enabled ? `${code}${text}${reset}` : text);
  return {
    green: (text) => wrap(codes.green, text),
    yellow: (text) => wrap(codes.yellow, text),
    cyan: (text) => wrap(codes.cyan, text),
    dim: (text) => wrap(codes.dim, text),
  };
}

function normalizeForCompare(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trimEnd();
}

async function promptConflict(question) {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return String(answer || "").trim().toLowerCase();
}

async function compileToTarget({
  rulesPath,
  target,
  workspace,
  minify,
  conflictMode,
  dryRun,
  selectedRuleIds,
  state,
  listChanges,
  colors,
}) {
  const files = await fs.readdir(rulesPath);
  const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));

  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const parsedRules = [];

  for (const file of ruleFiles) {
    const inPath = path.join(rulesPath, file);
    const content = await fs.readFile(inPath, "utf8");
    const rule = parseRuleFile(content, inPath);
    if (Array.isArray(selectedRuleIds) && selectedRuleIds.length > 0 && !selectedRuleIds.includes(rule.id)) continue;
    parsedRules.push(rule);
  }

  if (target === "zed") {
    const outPath = path.join(workspace, ".rules");
    const compiled = compileZedRules(parsedRules, { minify });
    const exists = await fs.pathExists(outPath);
    if (!exists) {
      if (!dryRun) await fs.writeFile(outPath, compiled, "utf8");
      summary.created += 1;
      if (listChanges) process.stdout.write(`${colors.green("[create]")} .rules\n`);
      return summary;
    }

    const existing = await fs.readFile(outPath, "utf8").catch(() => "");
    const same = normalizeForCompare(existing) === normalizeForCompare(compiled);
    if (same) {
      summary.unchanged += 1;
      if (listChanges) process.stdout.write(`${colors.dim("[same]  ")} .rules\n`);
      return summary;
    }

    if (state.skipAll || conflictMode === "skip") {
      summary.skipped += 1;
      if (listChanges) process.stdout.write(`${colors.yellow("[skip]  ")} .rules\n`);
      return summary;
    }

    if (state.overwriteAll || conflictMode === "overwrite") {
      if (!dryRun) await fs.writeFile(outPath, compiled, "utf8");
      summary.updated += 1;
      if (listChanges) process.stdout.write(`${colors.cyan("[update]")} .rules\n`);
      return summary;
    }

    if (conflictMode === "prompt") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Conflict prompt requires a TTY. Use --conflict overwrite|skip.");
      }
      process.stdout.write(`\n⚠️ Conflict: .rules exists and differs.\n`);
      process.stdout.write("Choose: [o]verwrite, [s]kip, overwrite-[a]ll, skip-a[l]l, [c]ancel\n");
      const a = await promptConflict("> ");
      if (!a || a === "c" || a === "cancel") throw new Error("SYNC_CANCELED");
      if (a === "s" || a === "skip") {
        summary.skipped += 1;
        if (listChanges) process.stdout.write(`${colors.yellow("[skip]  ")} .rules\n`);
        return summary;
      }
      if (a === "l" || a === "skip-all") {
        state.skipAll = true;
        summary.skipped += 1;
        if (listChanges) process.stdout.write(`${colors.yellow("[skip]  ")} .rules\n`);
        return summary;
      }
      if (a === "a" || a === "overwrite-all") state.overwriteAll = true;
      if (!dryRun) await fs.writeFile(outPath, compiled, "utf8");
      summary.updated += 1;
      if (listChanges) process.stdout.write(`${colors.cyan("[update]")} .rules\n`);
      return summary;
    }
  }

  const outDir = path.join(workspace, getTargetPath(target));
  await fs.ensureDir(outDir);

  for (const rule of parsedRules) {
    let compiled;
    if (target === "trae") compiled = compileTrae(rule, { minify });
    else if (target === "cursor") compiled = compileCursor(rule, { minify });
    else if (target === "windsurf") compiled = compileWindsurf(rule, { minify });
    else if (target === "cline") compiled = compileTrae(rule, { minify });
    else compiled = rule.content;
    const outPath = path.join(outDir, `${rule.id}${getTargetExtension(target)}`);

    const exists = await fs.pathExists(outPath);
    if (!exists) {
      if (!dryRun) await fs.writeFile(outPath, compiled, "utf8");
      summary.created += 1;
      if (listChanges) {
        const rel = path.relative(workspace, outPath);
        process.stdout.write(`${colors.green("[create]")} ${rel}\n`);
      }
      continue;
    }

    const existing = await fs.readFile(outPath, "utf8").catch(() => "");
    const same = normalizeForCompare(existing) === normalizeForCompare(compiled);
    if (same) {
      summary.unchanged += 1;
      if (listChanges) {
        const rel = path.relative(workspace, outPath);
        process.stdout.write(`${colors.dim("[same]  ")} ${rel}\n`);
      }
      continue;
    }

    if (state.skipAll || conflictMode === "skip") {
      summary.skipped += 1;
      if (listChanges) {
        const rel = path.relative(workspace, outPath);
        process.stdout.write(`${colors.yellow("[skip]  ")} ${rel}\n`);
      }
      continue;
    }

    if (state.overwriteAll || conflictMode === "overwrite") {
      if (!dryRun) await fs.writeFile(outPath, compiled, "utf8");
      summary.updated += 1;
      if (listChanges) {
        const rel = path.relative(workspace, outPath);
        process.stdout.write(`${colors.cyan("[update]")} ${rel}\n`);
      }
      continue;
    }

    if (conflictMode === "prompt") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Conflict prompt requires a TTY. Use --conflict overwrite|skip.");
      }

      process.stdout.write(`\n⚠️ Conflict: ${path.relative(workspace, outPath)} exists and differs.\n`);
      process.stdout.write("Choose: [o]verwrite, [s]kip, overwrite-[a]ll, skip-a[l]l, [c]ancel\n");
      const a = await promptConflict("> ");
      if (!a || a === "c" || a === "cancel") throw new Error("SYNC_CANCELED");
      if (a === "s" || a === "skip") {
        summary.skipped += 1;
        if (listChanges) {
          const rel = path.relative(workspace, outPath);
          process.stdout.write(`${colors.yellow("[skip]  ")} ${rel}\n`);
        }
        continue;
      }
      if (a === "l" || a === "skip-all") {
        state.skipAll = true;
        summary.skipped += 1;
        if (listChanges) {
          const rel = path.relative(workspace, outPath);
          process.stdout.write(`${colors.yellow("[skip]  ")} ${rel}\n`);
        }
        continue;
      }
      if (a === "a" || a === "overwrite-all") state.overwriteAll = true;

      if (!dryRun) await fs.writeFile(outPath, compiled, "utf8");
      summary.updated += 1;
      if (listChanges) {
        const rel = path.relative(workspace, outPath);
        process.stdout.write(`${colors.cyan("[update]")} ${rel}\n`);
      }
      continue;
    }
  }

  return summary;
}

async function startNodeProcess(label, args, env) {
  if (isCompiled) {
    process.stdout.write(
      `⚠️ ${label} is not available in the standalone binary yet. Use the npm install (Node.js) version for server features.\n`
    );
    return null;
  }
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...(env || {}) } });
  child.on("error", (err) => {
    process.stderr.write(`${label} error: ${String(err && err.message ? err.message : err)}\n`);
  });
  return child;
}

program
  .name("synapse")
  .description("Universal rule orchestration: portable rules across IDEs with safe sync, rollback, cost analysis, and zero lock-in")
  .version(require(path.resolve(__dirname, "..", "package.json")).version);

program
  .command("init")
  .description("Initialize Synapse in current directory")
  .action(async () => {
    const root = synapseDir();
    if (await fs.pathExists(root)) {
      process.stdout.write("❌ Synapse already initialized\n");
      return;
    }

    await fs.ensureDir(rulesDir());
    await fs.ensureDir(skillsDir());

    const config = {
      version: "1.0",
      masterPath: ".synapse/",
      targets: {
        trae: { enabled: true, path: ".trae/rules/" },
        cursor: { enabled: true, path: ".cursor/rules/" },
        windsurf: { enabled: false, path: ".windsurf/" },
        cline: { enabled: false, path: ".clinerules/" },
      },
    };
    await fs.writeJson(configPath(), config, { spaces: 2 });

    const exampleRule = `# Rule: Welcome to Synapse
# Description: Your first Synapse rule

Always write clean, documented code

# Constraints:
# @constraint **/*.ts

# Skills:
# @skill code-review
`;
    await fs.writeFile(path.join(rulesDir(), "welcome.synapse"), exampleRule, "utf8");

    process.stdout.write("✅ Synapse initialized!\n");
    process.stdout.write("📁 Created .synapse/ folder\n\n");
    process.stdout.write("Next steps:\n");
    process.stdout.write("  synapse sync --all     # Compile rules for all IDEs\n");
    process.stdout.write("  synapse watch          # Auto-sync on changes\n");
    process.stdout.write("  synapse serve          # Start WebSocket/MCP servers\n");
  });

program
  .command("sync")
  .description("Sync rules to IDEs (optional backup for rollback)")
  .option("-t, --target <ide>", "Target IDE (trae, cursor, windsurf, cline, zed)")
  .option("-a, --all", "Sync to all enabled IDEs")
  .option("--rules <ids>", "Comma-separated rule ids (.synapse basenames) to sync")
  .option("--minify", "Remove leading/trailing whitespace from output")
  .option("--conflict <mode>", "Conflict handling: overwrite, skip, prompt")
  .option("--backup", "Create a local backup before writing outputs (for rollback)")
  .option("--dry-run", "Print what would change without writing files")
  .option("--list-changes", "Print per-file changes (with color in TTYs)")
  .option("-w, --watch", "Watch mode (auto-sync on changes)")
  .addHelpText(
    "after",
    `
Examples:
  $ synapse sync --all --conflict prompt
  $ synapse sync --target cursor
  $ synapse sync --all --backup

Rollback:
  $ synapse backup list
  $ synapse rollback --backup <name>
  $ synapse backup restore --backup <name>
`
  )
  .action(async (options) => {
    await ensureInitialized();

    const rp = rulesDir();
    const files = await fs.readdir(rp).catch(() => []);
    const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));
    if (ruleFiles.length === 0) {
      process.stdout.write("⚠️ No .synapse files found\n");
      return;
    }

    let cfg = {};
    try {
      cfg = await fs.readJson(configPath());
    } catch {
      cfg = {};
    }

    const enabledTargets =
      cfg && cfg.targets
        ? Object.entries(cfg.targets)
            .filter(([, v]) => v && v.enabled)
            .map(([k]) => k)
        : [];

    const targets = options.all
      ? ["trae", "cursor", "windsurf", "cline"]
      : options.target
        ? [String(options.target)]
        : enabledTargets.length
          ? enabledTargets
          : ["trae", "cursor"];
    process.stdout.write(`🔄 Syncing ${ruleFiles.length} rule(s) to: ${targets.join(", ")}\n`);

    const postSyncLines = [];
    let syncFinished = false;
    const emitPostSync = (line) => {
      const s = String(line || "");
      if (!s) return;
      if (syncFinished) process.stdout.write(s);
      else postSyncLines.push(s);
    };

    const supportedAdapterTargets = new Set(["cursor", "trae", "windsurf", "cline", "zed"]);
    const adapterTargets = targets.map((t) => String(t || "").trim()).filter((t) => supportedAdapterTargets.has(t));
    const adapterUpdateBg = (async () => {
      if (adapterTargets.length === 0) return [];
      const { updateAdapterIfNeeded, checkAdapterTipIfNeeded } = require(path.resolve(__dirname, "..", "src", "commands", "adapters-update.js"));

      const results = [];
      for (const ideId of adapterTargets) {
        const res = await updateAdapterIfNeeded({ ideId, quiet: true });
        if (res && typeof res.status === "string") results.push(res);
        else {
          const tip = await checkAdapterTipIfNeeded({ ideId, quiet: true });
          if (tip && typeof tip.status === "string") results.push(tip);
        }
      }
      return results;
    })();

    adapterUpdateBg
      .then((results) => {
        if (!Array.isArray(results) || results.length === 0) return;
        for (const r of results) {
          if (!r || typeof r.ideId !== "string") continue;
          if (r.status === "updated") {
            emitPostSync(`✅ Auto-updated ${r.ideId} adapter (v${r.fromVersion} → v${r.toVersion})\n`);
          } else if (r.status === "manual_available") {
            emitPostSync(`Tip: New ${r.ideId} adapter available. Run: synapse adapters update ${r.ideId}\n`);
          }
        }
      })
      .catch(() => void 0);

    const selectedRuleIds = String(options.rules || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.toLowerCase().endsWith(".synapse") ? s.slice(0, -".synapse".length) : s));

    const defaultConflict = process.stdin.isTTY && process.stdout.isTTY ? "prompt" : "overwrite";
    const conflictModeRaw = typeof options.conflict === "string" && options.conflict.trim() ? options.conflict.trim() : defaultConflict;
    const conflictMode = ["overwrite", "skip", "prompt"].includes(conflictModeRaw) ? conflictModeRaw : defaultConflict;
    const dryRun = !!options.dryRun;
    const listChanges = !!options.listChanges;
    const colors = makeColorFns(process.stdout.isTTY);

    if (!!options.backup && !dryRun) {
      const { BackupManager } = require(path.resolve(__dirname, "..", "src", "backup.js"));
      const backupManager = new BackupManager();
      const backupPath = await backupManager.createBackup(process.cwd());
      process.stdout.write(`📦 Backup saved to: ${backupPath}\n\n`);
    }

    const state = { overwriteAll: false, skipAll: false };
    const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (const t of targets) {
      const s = await compileToTarget({
        rulesPath: rp,
        target: t,
        workspace: process.cwd(),
        minify: !!options.minify,
        conflictMode,
        dryRun,
        selectedRuleIds,
        state,
        listChanges,
        colors,
      });
      totals.created += s.created;
      totals.updated += s.updated;
      totals.unchanged += s.unchanged;
      totals.skipped += s.skipped;
    }

    if (dryRun) {
      process.stdout.write(
        `✅ Dry run complete (create: ${totals.created}, update: ${totals.updated}, unchanged: ${totals.unchanged}, skipped: ${totals.skipped})\n`
      );
    } else {
      process.stdout.write(
        `✅ Sync complete (created: ${totals.created}, updated: ${totals.updated}, unchanged: ${totals.unchanged}, skipped: ${totals.skipped})\n`
      );
    }

    syncFinished = true;
    for (const line of postSyncLines) process.stdout.write(line);

    if (options.watch) {
      if (dryRun) {
        process.stdout.write("⚠️ --dry-run is not supported in --watch mode\n");
        return;
      }
      const chokidar = require("chokidar");
      process.stdout.write("👀 Watch mode enabled. Waiting for changes...\n");
      const watcher = chokidar.watch(rp, { persistent: true, ignoreInitial: true });
      watcher.on("change", async (file) => {
        process.stdout.write(`📝 Changed: ${path.basename(file)}\n`);
        const state = { overwriteAll: false, skipAll: false };
        for (const t of targets) {
          await compileToTarget({
            rulesPath: rp,
            target: t,
            workspace: process.cwd(),
            minify: !!options.minify,
            conflictMode,
            dryRun: false,
            selectedRuleIds,
            state,
          });
        }
        process.stdout.write("✅ Synced\n");
      });
    }
  });

program
  .command("analyze")
  .description("Analyze token costs and get optimization suggestions (local-only)")
  .option("--top <n>", "Show top N largest rules", "10")
  .option("--threshold <tokens>", "Flag rules above this estimated token count", "2000")
  .option(
    "--usd-per-1m <usd>",
    "Cost estimate per 1,000,000 tokens (USD). Set SYNAPSE_USD_PER_1M_TOKENS to change default.",
    process.env.SYNAPSE_USD_PER_1M_TOKENS || "10"
  )
  .addHelpText(
    "after",
    `
Example output:
  Total tokens: 15,234 | Estimated cost: $0.152/session
  💡 Recommendation: Convert a large always-on rule to a skill (reduce token spend)

Pro users:
  $ synapse optimize --apply --backup
`
  )
  .action(async (options) => {
    await ensureInitialized();

    const rp = rulesDir();
    const files = await fs.readdir(rp).catch(() => []);
    const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));
    if (ruleFiles.length === 0) {
      process.stdout.write("⚠️ No .synapse files found\n");
      return;
    }

    const { LocalOptimizer } = require(path.resolve(__dirname, "..", "src", "optimizer.js"));
    const optimizer = new LocalOptimizer();
    const rows = [];
    let totalTokens = 0;
    for (const file of ruleFiles) {
      const p = path.join(rp, file);
      const content = await fs.readFile(p, "utf8");
      const chars = content.length;
      const estTokens = optimizer.countTokens(content);
      totalTokens += estTokens;
      rows.push({
        id: path.basename(file, ".synapse"),
        file,
        estTokens,
        chars,
      });
    }

    rows.sort((a, b) => b.estTokens - a.estTokens);
    const topN = Math.max(1, parseInt(String(options.top || "10"), 10) || 10);
    const threshold = Math.max(1, parseInt(String(options.threshold || "2000"), 10) || 2000);
    const flagged = rows.filter((r) => r.estTokens >= threshold);
    const usdPer1M = Math.max(0, Number.parseFloat(String(options.usdPer1m || "10")) || 0);
    const estCost = usdPer1M > 0 ? (totalTokens / 1_000_000) * usdPer1M : 0;

    process.stdout.write(`🧮 Rules analyzed: ${rows.length}\n`);
    process.stdout.write(`🧠 Total tokens (est): ${totalTokens.toLocaleString()}\n`);
    if (usdPer1M > 0) process.stdout.write(`💵 Estimated cost: $${estCost.toFixed(3)}/session (USD per 1M: $${usdPer1M})\n`);
    process.stdout.write(`🚩 Flagged (>= ${threshold} est tokens): ${flagged.length}\n\n`);

    const out = rows.slice(0, topN).map((r) => ({
      id: r.id,
      estTokens: r.estTokens,
      chars: r.chars,
      file: r.file,
    }));
    console.table(out);

    if (flagged.length > 0) {
      process.stdout.write("\nTips:\n");
      process.stdout.write("  - Keep always-on rules short; move long examples into skills.\n");
      process.stdout.write("  - Run: synapse optimize (detect conflicts + get suggestions).\n");
      process.stdout.write("  - Use: synapse sync --minify to reduce whitespace in generated outputs.\n");
    }
  });

program
  .command("mcp")
  .description("Start MCP server (stdio) for AI agents (Cursor/Windsurf/etc.)")
  .action(async () => {
    await ensureInitialized();
    const standaloneRoot = path.resolve(__dirname, "..", "standalone");
    const mcpPath = path.join(standaloneRoot, "dist", "mcp-server.js");
    process.stdout.write("🚀 Starting MCP server...\n");
    if (!(await fs.pathExists(mcpPath))) {
      process.stdout.write("⚠️ MCP server not built. Run: (cd standalone && npm run build)\n");
      process.exitCode = 1;
      return;
    }
    await startNodeProcess("mcp", [mcpPath]);
  });

program
  .command("importFromIDE")
  .alias("import-from-ide")
  .description("Import existing IDE rules into .synapse/rules (zero lock-in)")
  .option("--dry-run", "Show what would be imported without writing files")
  .option("--conflict <mode>", "Conflict handling for existing .synapse files: overwrite, skip, prompt", "prompt")
  .action(async (options) => {
    await ensureInitialized();

    const dryRun = !!options.dryRun;
    const conflictModeRaw = typeof options.conflict === "string" ? options.conflict.trim() : "prompt";
    const conflictMode = ["overwrite", "skip", "prompt"].includes(conflictModeRaw) ? conflictModeRaw : "prompt";

    const root = process.cwd();
    const outDir = rulesDir();
    await fs.ensureDir(outDir);

    const readIfExists = async (p) => {
      try {
        if (!(await fs.pathExists(p))) return null;
        return await fs.readFile(p, "utf8");
      } catch {
        return null;
      }
    };

    const suggestName = (base) => {
      const safe = String(base || "")
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^\.+/, "")
        .replace(/\.+$/, "")
        .toLowerCase();
      return `${safe || "imported"}.synapse`;
    };

    const parseMdRule = (content, filePath) => {
      const lines = String(content || "").split(/\r?\n/);
      const base = path.basename(filePath, path.extname(filePath));
      let name = base;
      const nameMatch = String(content || "").match(/^#\s+(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();

      let description = "";
      let mainContent = "";
      const constraints = [];
      const skills = [];

      let inConstraints = false;
      let inSkills = false;
      let inDescription = true;
      const descriptionLines = [];
      const bodyLines = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === 0 && line.startsWith("# ")) continue;

        if (line.trim() === "## Constraints") {
          inConstraints = true;
          inSkills = false;
          inDescription = false;
          continue;
        }
        if (line.trim() === "## Skills") {
          inConstraints = false;
          inSkills = true;
          inDescription = false;
          continue;
        }

        if (inConstraints) {
          if (line.trim().startsWith("-")) {
            const c = line.trim().slice(1).trim();
            if (c) constraints.push(c);
            continue;
          }
          if (line.trim() !== "") inConstraints = false;
          if (inConstraints) continue;
        }

        if (inSkills) {
          if (line.trim().startsWith("-")) {
            const s = line.trim().slice(1).trim();
            if (s) skills.push(s);
            continue;
          }
          if (line.trim() !== "") inSkills = false;
          if (inSkills) continue;
        }

        if (inDescription) {
          if (line.trim() === "") {
            if (descriptionLines.length > 0) inDescription = false;
            else continue;
          } else {
            descriptionLines.push(line);
            continue;
          }
        }

        bodyLines.push(line);
      }

      description = descriptionLines.join("\n").trim();
      mainContent = bodyLines.join("\n").trim();

      return { name, description: description || undefined, content: mainContent || "", constraints, skills };
    };

    const parseCursorMdc = (content, filePath) => {
      const base = path.basename(filePath, path.extname(filePath));
      const fm = String(content || "").match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = {};
      if (fm) {
        for (const line of fm[1].split("\n")) {
          const [key, ...value] = line.split(":");
          if (key && value.length) frontmatter[key.trim()] = value.join(":").trim();
        }
      }
      const cleanContent = String(content || "").replace(/^---\n[\s\S]*?\n---/, "").trim();
      const name = typeof frontmatter.description === "string" && frontmatter.description.trim() ? frontmatter.description.trim() : base;
      const globsRaw = typeof frontmatter.globs === "string" ? frontmatter.globs : "";
      const constraints = globsRaw
        ? globsRaw
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean)
        : [];
      return { name, description: typeof frontmatter.description === "string" ? frontmatter.description : undefined, content: cleanContent, constraints, skills: [] };
    };

    const parseWindsurf = (content, filePath) => {
      const base = path.basename(filePath, path.extname(filePath));
      try {
        const json = JSON.parse(String(content || ""));
        const name = typeof json.name === "string" && json.name.trim() ? json.name.trim() : base;
        const description = typeof json.description === "string" ? json.description : undefined;
        const body = typeof json.content === "string" ? json.content : "";
        const constraints = Array.isArray(json.constraints) ? json.constraints.map((c) => String(c)).filter(Boolean) : [];
        const skills = Array.isArray(json.skills) ? json.skills.map((s) => String(s)).filter(Boolean) : [];
        return { name, description, content: body, constraints, skills };
      } catch {
        return { name: base, description: "Imported from Windsurf", content: String(content || ""), constraints: [], skills: [] };
      }
    };

    const formatSynapse = ({ name, description, content, constraints, skills }) => {
      const lines = [];
      lines.push(`# Rule: ${String(name || "Imported Rule").trim()}`);
      if (description) lines.push(`# Description: ${String(description).trim()}`);
      lines.push("");
      lines.push(String(content || "").trimEnd());
      lines.push("");
      if (constraints && constraints.length) {
        lines.push("# Constraints:");
        for (const c of constraints) lines.push(`# @constraint ${String(c).trim()}`);
        lines.push("");
      }
      if (skills && skills.length) {
        lines.push("# Skills:");
        for (const s of skills) lines.push(`# @skill ${String(s).trim()}`);
        lines.push("");
      }
      return lines.join("\n").trimEnd() + "\n";
    };

    const detected = [];

    const scanDir = async (dir, exts) => {
      if (!(await fs.pathExists(dir))) return;
      const entries = await fs.readdir(dir).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        const ext = path.extname(e).toLowerCase();
        if (!exts.includes(ext)) continue;
        detected.push(full);
      }
    };

    await scanDir(path.join(root, ".trae", "rules"), [".md"]);
    await scanDir(path.join(root, ".cursor", "rules"), [".mdc"]);
    await scanDir(path.join(root, ".windsurf"), [".windsurfrules"]);
    await scanDir(path.join(root, ".clinerules"), [".md"]);

    if (detected.length === 0) {
      process.stdout.write("📥 No IDE rule files found to import in this workspace\n");
      return;
    }

    let created = 0;
    let skipped = 0;
    let overwritten = 0;

    process.stdout.write(`📥 Found ${detected.length} rule file(s). Importing to .synapse/rules/\n\n`);

    for (const filePath of detected) {
      const content = await readIfExists(filePath);
      if (content === null) continue;
      const ext = path.extname(filePath).toLowerCase();
      const base = path.basename(filePath, ext);
      const ide =
        filePath.includes(`${path.sep}.cursor${path.sep}`) ? "cursor" : filePath.includes(`${path.sep}.windsurf${path.sep}`) ? "windsurf" : filePath.includes(`${path.sep}.clinerules${path.sep}`) ? "cline" : "trae";

      let parsed;
      if (ide === "cursor") parsed = parseCursorMdc(content, filePath);
      else if (ide === "windsurf") parsed = parseWindsurf(content, filePath);
      else parsed = parseMdRule(content, filePath);

      if (!parsed.description) parsed.description = `Imported from ${ide}`;

      const outName = suggestName(parsed.name || base);
      const outPath = path.join(outDir, outName);
      const exists = await fs.pathExists(outPath);

      if (exists) {
        if (conflictMode === "skip") {
          skipped++;
          process.stdout.write(`↩️ Skipped (exists): ${outName}\n`);
          continue;
        }
        if (conflictMode === "prompt") {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            skipped++;
            process.stdout.write(`↩️ Skipped (no TTY to prompt): ${outName}\n`);
            continue;
          }
          const ans = await promptConflict(`Overwrite existing ${outName}? (y/N) `);
          if (!["y", "yes"].includes(ans)) {
            skipped++;
            process.stdout.write(`↩️ Skipped: ${outName}\n`);
            continue;
          }
        }
      }

      const next = formatSynapse(parsed);
      if (!dryRun) await fs.writeFile(outPath, next, "utf8");

      if (exists) overwritten++;
      else created++;
      process.stdout.write(`${dryRun ? "🧪 Would import" : "✅ Imported"}: ${outName}\n`);
    }

    process.stdout.write(`\n✅ Import complete (created: ${created}, overwritten: ${overwritten}, skipped: ${skipped})\n`);
    process.stdout.write("Next: synapse sync --all --conflict prompt\n");
  });

function isProEnabledForCli() {
  if (process.env.SYNAPSE_DEV === "true") return true;
  const v = process.env.SYNAPSE_PRO;
  return typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

program
  .command("optimize")
  .description("Optimize local rules/skills (local-only). Free: analyze. Pro: apply fixes.")
  .option("--apply", "Apply auto-fixes (Pro)")
  .option("--backup", "Create a local backup before running")
  .option("--dry-run", "Show what would change without writing files (Pro for apply)")
  .action(async (options) => {
    await ensureInitialized();

    const { LocalOptimizer } = require(path.resolve(__dirname, "..", "src", "optimizer.js"));
    const { BackupManager } = require(path.resolve(__dirname, "..", "src", "backup.js"));
    const { isProUser, showUpgradeMessage } = require(path.resolve(__dirname, "..", "src", "license-check.js"));

    const rp = rulesDir();
    const shouldBackup = !!options.backup || !!options.apply;
    if (shouldBackup) {
      const backupManager = new BackupManager();
      const backupPath = await backupManager.createBackup(process.cwd());
      process.stdout.write(`📦 Backup saved to: ${backupPath}\n\n`);
    }

    const optimizer = new LocalOptimizer();
    let result;
    try {
      result = await optimizer.analyzeAllRules(rp);
    } finally {
      optimizer.dispose();
    }

    const issues = Array.isArray(result.issues) ? result.issues : [];
    const bySeverity = { info: 0, warning: 0, error: 0 };
    for (const i of issues) {
      if (i && typeof i.severity === "string" && Object.prototype.hasOwnProperty.call(bySeverity, i.severity)) bySeverity[i.severity] += 1;
    }

    process.stdout.write(`🧠 Total tokens (est): ${Number(result.totalTokens || 0).toLocaleString()}\n`);
    process.stdout.write(`💡 Potential savings (est): ${Number(result.potentialSavings || 0).toLocaleString()}\n`);
    process.stdout.write(
      `🧾 Issues: ${issues.length} (info: ${bySeverity.info}, warning: ${bySeverity.warning}, error: ${bySeverity.error})\n`
    );
    process.stdout.write(`🛠️ Auto-fixable: ${Number(result.fixableCount || 0)}\n\n`);

    const topIssues = issues.slice(0, 25).map((i) => ({
      rule: i.ruleName,
      severity: i.severity,
      type: i.type,
      savings: i.estimatedSavings || 0,
      message: i.message,
    }));
    if (topIssues.length) console.table(topIssues);

    if (!options.apply) {
      if (Number(result.fixableCount || 0) > 0) {
        process.stdout.write("\nTo apply auto-fixes (Pro): synapse optimize --apply\n");
      }
      return;
    }

    const proOk = isProEnabledForCli() ? true : await isProUser();
    if (!proOk) {
      showUpgradeMessage();
      process.exitCode = 1;
      return;
    }

    const files = await fs.readdir(rp).catch(() => []);
    const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));
    if (ruleFiles.length === 0) {
      process.stdout.write("⚠️ No .synapse files found\n");
      return;
    }

    const optimizer2 = new LocalOptimizer();
    const changed = [];
    try {
      for (const file of ruleFiles) {
        const p = path.join(rp, file);
        const content = await fs.readFile(p, "utf8");
        const perIssues = await optimizer2.analyzeRule(content, file);
        const fixable = perIssues.filter((i) => i && i.autoFixable);
        if (!fixable.length) continue;
        const next = await optimizer2.applyAutoFix(content, fixable);
        if (next !== content) {
          if (!options.dryRun) {
            await fs.writeFile(p, next, "utf8");
          }
          changed.push(file);
        }
      }
    } finally {
      optimizer2.dispose();
    }

    if (options.dryRun) {
      process.stdout.write(`\n✅ Dry run complete. ${changed.length} file(s) would change\n`);
      for (const f of changed.slice(0, 50)) process.stdout.write(`  - ${f}\n`);
      return;
    }

    process.stdout.write(`\n✅ Applied fixes to ${changed.length} file(s)\n`);
    process.stdout.write("Run: synapse sync --all --conflict prompt\n");
  });

program
  .command("backup")
  .description("Manage local backups")
  .argument("<action>", "list, restore")
  .option("--backup <name>", "Backup folder name for restore (e.g., backup_2026-04-22T...)")
  .action(async (action, options) => {
    const { BackupManager } = require(path.resolve(__dirname, "..", "src", "backup.js"));
    const mgr = new BackupManager();
    const a = String(action || "").trim().toLowerCase();
    if (a === "list") {
      const backups = await mgr.listBackups();
      if (backups.length === 0) {
        process.stdout.write("📦 No backups found\n");
        return;
      }
      process.stdout.write("📦 Available backups:\n");
      for (const b of backups) process.stdout.write(`  - ${b}\n`);
      return;
    }
    if (a === "restore") {
      const name = typeof options.backup === "string" ? options.backup.trim() : "";
      if (!name) {
        process.stdout.write("❌ Specify backup name: --backup <name>\n");
        process.stdout.write("Run: synapse backup list\n");
        process.exitCode = 1;
        return;
      }
      const backupPath = path.join(require("os").homedir(), ".synapse", "backups", name);
      await mgr.restore(backupPath, process.cwd());
      process.stdout.write("✅ Restore complete. Run: synapse sync --all\n");
      return;
    }
    process.stdout.write("❌ Unknown action. Use: list, restore\n");
    process.exitCode = 1;
  });

const adaptersCmd = program.command("adapters").description("Manage IDE adapters");

adaptersCmd
  .command("list")
  .description("List adapters with update status")
  .action(async () => {
    const { runAdaptersList } = require(path.resolve(__dirname, "..", "src", "commands", "adapters-list.js"));
    await runAdaptersList();
  });

adaptersCmd
  .command("update")
  .description("Update adapters (Pro: auto-update; Free: manual instructions)")
  .argument("[ide]", "IDE id (cursor, trae, windsurf, cline, zed)")
  .option("--all", "Update all supported IDE adapters")
  .action(async (ide, options) => {
    const { runAdaptersUpdate } = require(path.resolve(__dirname, "..", "src", "commands", "adapters-update.js"));
    await runAdaptersUpdate({ ideId: typeof ide === "string" ? ide.trim() : "", all: !!options.all });
  });

adaptersCmd
  .command("versions")
  .description("List available adapter versions (Pro only)")
  .argument("<ide>", "IDE id (cursor, trae, windsurf, cline, zed)")
  .action(async (ide) => {
    const { runAdaptersVersions } = require(path.resolve(__dirname, "..", "src", "commands", "adapters-versions.js"));
    await runAdaptersVersions({ ideId: typeof ide === "string" ? ide.trim() : "" });
  });

adaptersCmd
  .command("rollback")
  .description("Rollback adapter to a specific version (Pro only)")
  .argument("<ide>", "IDE id (cursor, trae, windsurf, cline, zed)")
  .argument("<version>", "Version (example: 1.1.0)")
  .action(async (ide, version) => {
    const { runAdaptersRollback } = require(path.resolve(__dirname, "..", "src", "commands", "adapters-rollback.js"));
    await runAdaptersRollback({ ideId: typeof ide === "string" ? ide.trim() : "", version: typeof version === "string" ? version.trim() : "" });
  });

function backupRootDir() {
  return path.join(require("os").homedir(), ".synapse", "backups");
}

function firstDiffLine(aText, bText) {
  const a = String(aText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const b = String(bText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = typeof a[i] === "string" ? a[i] : "";
    const bv = typeof b[i] === "string" ? b[i] : "";
    if (av !== bv) return { line: i + 1, a: av, b: bv };
  }
  return null;
}

function clipLine(line, max = 160) {
  const s = String(line || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

program
  .command("diff")
  .description("Compare current rules with a backup snapshot")
  .option("--backup <name>", "Backup folder name (default: latest)")
  .option("--max <n>", "Max files to list per section", "50")
  .action(async (options) => {
    await ensureInitialized();

    const { BackupManager } = require(path.resolve(__dirname, "..", "src", "backup.js"));
    const mgr = new BackupManager();
    const backups = await mgr.listBackups();
    if (backups.length === 0) {
      process.stdout.write("📦 No backups found\n");
      process.stdout.write("Tip: synapse optimize --backup OR synapse backup list\n");
      process.exitCode = 1;
      return;
    }

    const max = Math.max(1, parseInt(String(options.max || "50"), 10) || 50);
    const nameRaw = typeof options.backup === "string" ? options.backup.trim() : "";
    const name = nameRaw || backups[0];
    const backupPath = path.join(backupRootDir(), name);
    const backupRulesPath = path.join(backupPath, "rules");
    const currentRulesPath = rulesDir();

    if (!(await fs.pathExists(backupRulesPath))) {
      process.stdout.write(`❌ Backup not found or missing rules/: ${name}\n`);
      process.stdout.write("Run: synapse backup list\n");
      process.exitCode = 1;
      return;
    }

    const currentFiles = (await fs.readdir(currentRulesPath).catch(() => [])).filter((f) => String(f).toLowerCase().endsWith(".synapse"));
    const backupFiles = (await fs.readdir(backupRulesPath).catch(() => [])).filter((f) => String(f).toLowerCase().endsWith(".synapse"));

    const currentSet = new Set(currentFiles);
    const backupSet = new Set(backupFiles);

    const added = currentFiles.filter((f) => !backupSet.has(f)).sort();
    const removed = backupFiles.filter((f) => !currentSet.has(f)).sort();

    const changed = [];
    for (const f of currentFiles) {
      if (!backupSet.has(f)) continue;
      const cur = await fs.readFile(path.join(currentRulesPath, f), "utf8").catch(() => "");
      const old = await fs.readFile(path.join(backupRulesPath, f), "utf8").catch(() => "");
      if (normalizeForCompare(cur) !== normalizeForCompare(old)) {
        changed.push({ file: f, cur, old });
      }
    }
    changed.sort((a, b) => a.file.localeCompare(b.file));

    process.stdout.write(`🔎 Diff vs backup: ${name}\n\n`);

    const total = added.length + removed.length + changed.length;
    if (total === 0) {
      process.stdout.write("✅ No changes detected\n");
      return;
    }

    if (added.length) {
      process.stdout.write(`➕ Added (${added.length}):\n`);
      for (const f of added.slice(0, max)) process.stdout.write(`  - ${f}\n`);
      if (added.length > max) process.stdout.write(`  … +${added.length - max} more\n`);
      process.stdout.write("\n");
    }

    if (removed.length) {
      process.stdout.write(`➖ Removed (${removed.length}):\n`);
      for (const f of removed.slice(0, max)) process.stdout.write(`  - ${f}\n`);
      if (removed.length > max) process.stdout.write(`  … +${removed.length - max} more\n`);
      process.stdout.write("\n");
    }

    if (changed.length) {
      process.stdout.write(`✏️ Changed (${changed.length}):\n`);
      for (const item of changed.slice(0, max)) {
        const diff = firstDiffLine(item.old, item.cur);
        if (!diff) {
          process.stdout.write(`  - ${item.file}\n`);
          continue;
        }
        process.stdout.write(`  - ${item.file} (line ${diff.line})\n`);
        process.stdout.write(`      - ${clipLine(diff.a)}\n`);
        process.stdout.write(`      + ${clipLine(diff.b)}\n`);
      }
      if (changed.length > max) process.stdout.write(`  … +${changed.length - max} more\n`);
    }
  });

program
  .command("rollback")
  .description("Restore rules from a backup (rules only). Run sync after.")
  .option("--backup <name>", "Backup folder name (default: latest)")
  .option("--yes", "Skip confirmation prompt")
  .action(async (options) => {
    await ensureInitialized();

    const { BackupManager } = require(path.resolve(__dirname, "..", "src", "backup.js"));
    const mgr = new BackupManager();
    const backups = await mgr.listBackups();
    if (backups.length === 0) {
      process.stdout.write("📦 No backups found\n");
      process.exitCode = 1;
      return;
    }

    const nameRaw = typeof options.backup === "string" ? options.backup.trim() : "";
    const name = nameRaw || backups[0];
    const backupPath = path.join(backupRootDir(), name);
    const backupRulesPath = path.join(backupPath, "rules");
    if (!(await fs.pathExists(backupRulesPath))) {
      process.stdout.write(`❌ Backup not found or missing rules/: ${name}\n`);
      process.stdout.write("Run: synapse backup list\n");
      process.exitCode = 1;
      return;
    }

    if (!options.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write("❌ Rollback requires a TTY unless you pass --yes\n");
        process.exitCode = 1;
        return;
      }
      const ans = await promptConflict(`Restore .synapse/rules/ from "${name}"? This overwrites current rules. (y/N) `);
      if (!["y", "yes"].includes(ans)) {
        process.stdout.write("↩️ Cancelled\n");
        return;
      }
    }

    const created = await mgr.createBackup(process.cwd());
    process.stdout.write(`📦 Backup saved to: ${created}\n`);

    const currentRulesPath = rulesDir();
    await fs.remove(currentRulesPath);
    await fs.ensureDir(currentRulesPath);
    await fs.copy(backupRulesPath, currentRulesPath, { overwrite: true, errorOnExist: false });

    process.stdout.write(`✅ Rolled back rules to: ${name}\n`);
    process.stdout.write("Next: synapse sync --all --conflict prompt\n");
  });

program
  .command("clean")
  .description("Remove Synapse-generated files")
  .option("-a, --all", "Remove ALL Synapse files (config, cache, backups)")
  .option("--cache", "Remove only cache files")
  .option("--backups", "Remove only backup files")
  .option("--config", "Remove only configuration files")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (options) => {
    const { cleanCommand } = require(path.resolve(__dirname, "..", "src", "commands", "clean.js"));
    await cleanCommand(options);
  });

program
  .command("enter-license")
  .description("Save your Synapse Pro license key for CLI features")
  .argument("[key]", "Your license key (if omitted, will prompt)")
  .action(async (key) => {
    const readline = require("readline");
    const { getApiBaseUrl, saveLicenseKey } = require(path.resolve(__dirname, "..", "src", "license-check.js"));

    const promptKey = async () =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.stdoutMuted = true;
        rl._writeToOutput = function _writeToOutput(stringToWrite) {
          if (rl.stdoutMuted) return;
          rl.output.write(stringToWrite);
        };
        rl.question("Enter your license key: ", (answer) => {
          rl.close();
          process.stdout.write("\n");
          resolve(answer);
        });
      });

    const licenseKey = (typeof key === "string" && key.trim()) ? key.trim() : String(await promptKey()).trim();
    if (!licenseKey) {
      process.stdout.write("❌ No license key provided\n");
      process.exitCode = 1;
      return;
    }

    if (process.env.SYNAPSE_OFFLINE === "true") {
      process.stdout.write("❌ Cannot validate license while SYNAPSE_OFFLINE=true\n");
      process.exitCode = 1;
      return;
    }

    let ok = false;
    try {
      const { isProUser } = require(path.resolve(__dirname, "..", "src", "license-check.js"));
      await saveLicenseKey(licenseKey);
      ok = await isProUser();
      if (!ok) {
        process.stdout.write("❌ Invalid or inactive license key\n");
        process.exitCode = 1;
        return;
      }
    } catch {
      process.stdout.write("❌ License validation failed\n");
      process.stdout.write(`Check: ${getApiBaseUrl()}/api/validate\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write("✅ License activated for CLI\n");
  });

program
  .command("resend-license")
  .description("Resend your Synapse Pro license email (always returns ok)")
  .argument("[email]", "Your checkout email (if omitted, will prompt)")
  .action(async (emailArg) => {
    const readline = require("readline");
    const https = require("https");
    const { getApiBaseUrl } = require(path.resolve(__dirname, "..", "src", "license-check.js"));

    const promptEmail = async () =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.question("Email used at checkout: ", (answer) => {
          rl.close();
          resolve(answer);
        });
      });

    const email = (typeof emailArg === "string" && emailArg.trim()) ? emailArg.trim().toLowerCase() : String(await promptEmail()).trim().toLowerCase();
    if (!email) {
      process.stdout.write("❌ Email is required\n");
      process.exitCode = 1;
      return;
    }
    if (process.env.SYNAPSE_OFFLINE === "true") {
      process.stdout.write("❌ Cannot resend while SYNAPSE_OFFLINE=true\n");
      process.exitCode = 1;
      return;
    }

    const base = getApiBaseUrl();
    const url = new URL(`${base}/api/resend-license`);
    const payload = JSON.stringify({ email });

    try {
      const { status } = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            res.on("data", () => void 0);
            res.on("end", () => resolve({ status: res.statusCode || 0 }));
          }
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });

      if (status >= 200 && status < 300) {
        process.stdout.write("✅ If a license exists for that email, it has been resent.\n");
        return;
      }

      process.stdout.write(`❌ Resend failed (${status}). Check: ${base}/api/resend-license\n`);
      process.exitCode = 1;
    } catch {
      process.stdout.write("❌ Resend failed (network error)\n");
      process.stdout.write(`Check: ${base}/api/resend-license\n`);
      process.exitCode = 1;
    }
  });

program
  .command("watch")
  .description("Watch .synapse/ and auto-sync on changes")
  .option("-t, --targets <ides>", "Comma-separated IDEs to sync to", "trae,cursor")
  .option("--minify", "Remove leading/trailing whitespace from output")
  .option("--rules <ids>", "Comma-separated rule ids (.synapse basenames) to sync")
  .option("--conflict <mode>", "Conflict handling: overwrite, skip, prompt")
  .action(async (options) => {
    await ensureInitialized();
    const targets = String(options.targets || "trae,cursor")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const rp = rulesDir();
    const chokidar = require("chokidar");

    process.stdout.write("👀 Watching .synapse/rules/ for changes...\n");
    process.stdout.write(`📤 Will sync to: ${targets.join(", ")}\n`);
    process.stdout.write("Press Ctrl+C to stop\n\n");

    const selectedRuleIds = String(options.rules || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.toLowerCase().endsWith(".synapse") ? s.slice(0, -".synapse".length) : s));

    const defaultConflict = process.stdin.isTTY && process.stdout.isTTY ? "prompt" : "overwrite";
    const conflictModeRaw = typeof options.conflict === "string" && options.conflict.trim() ? options.conflict.trim() : defaultConflict;
    const conflictMode = ["overwrite", "skip", "prompt"].includes(conflictModeRaw) ? conflictModeRaw : defaultConflict;
    const state = { overwriteAll: false, skipAll: false };
    const colors = makeColorFns(process.stdout.isTTY);

    const watcher = chokidar.watch(rp, { ignored: /(^|[\/\\])\../, persistent: true, ignoreInitial: true });
    const doAll = async () => {
      for (const t of targets) {
        await compileToTarget({
          rulesPath: rp,
          target: t,
          workspace: process.cwd(),
          minify: !!options.minify,
          conflictMode,
          dryRun: false,
          selectedRuleIds,
          state,
          listChanges: false,
          colors,
        });
      }
    };

    watcher.on("change", async (file) => {
      process.stdout.write(`📝 ${path.basename(file)} changed\n`);
      await doAll();
      process.stdout.write(`✅ Synced at ${new Date().toLocaleTimeString()}\n\n`);
    });
    watcher.on("add", (file) => process.stdout.write(`➕ New rule: ${path.basename(file)}\n`));
    watcher.on("unlink", (file) => process.stdout.write(`➖ Deleted rule: ${path.basename(file)}\n`));
  });

program
  .command("serve")
  .description("Start Synapse servers (WebSocket + MCP)")
  .option("--ws-port <port>", "WebSocket server port", "3457")
  .option("--mcp-only", "Start only MCP server")
  .option("--ws-only", "Start only WebSocket server")
  .action(async (options) => {
    const wsPort = String(options.wsPort || "3457");
    const standaloneRoot = path.resolve(__dirname, "..", "standalone");
    const mcpPath = path.join(standaloneRoot, "dist", "mcp-server.js");
    const wsPath = path.join(standaloneRoot, "dist", "websocket-server.js");

    process.stdout.write("🧠 Starting Synapse servers...\n\n");

    const startMcp = async () => {
      if (!(await fs.pathExists(mcpPath))) {
        process.stdout.write("⚠️ MCP server not built. Run: (cd standalone && npm run build)\n");
        return null;
      }
      process.stdout.write("🚀 Starting MCP server...\n");
      return await startNodeProcess("mcp", [mcpPath]);
    };

    const startWs = async () => {
      if (!(await fs.pathExists(wsPath))) {
        process.stdout.write("⚠️ WebSocket server not built. Run: (cd standalone && npm run build)\n");
        return null;
      }
      process.stdout.write(`🚀 Starting WebSocket server on port ${wsPort}...\n`);
      return await startNodeProcess("ws", [wsPath], { WS_PORT: wsPort });
    };

    if (options.mcpOnly) {
      await startMcp();
      return;
    }
    if (options.wsOnly) {
      await startWs();
      return;
    }

    await startWs();
    await startMcp();
  });

program
  .command("dashboard")
  .description("Start the Synapse dashboard backend (http://localhost:3456/ by default)")
  .option("--port <port>", "Dashboard port (SYNAPSE_PORT)", "3456")
  .action(async (options) => {
    const p = String(options.port || "3456");
    const serverPath = path.resolve(__dirname, "..", "src", "server.js");
    if (!(await fs.pathExists(serverPath))) {
      throw new SynapseError({
        code: "E_DASHBOARD_MISSING",
        message: "Dashboard server is missing from this install.",
        suggestion: "Reinstall Synapse from npm, or use the full Node.js install (not the standalone binary).",
        details: { serverPath },
      });
    }
    process.stdout.write(`🚀 Starting dashboard on port ${p}...\n`);
    await startNodeProcess("dashboard", [serverPath], { SYNAPSE_PORT: p });
  });

program
  .command("status")
  .description("Show Synapse status and configuration")
  .action(async () => {
    const root = synapseDir();
    if (!(await fs.pathExists(root))) {
      process.stdout.write("❌ Synapse not initialized in this directory\n");
      return;
    }

    let cfg = {};
    try {
      cfg = await fs.readJson(configPath());
    } catch {
      cfg = {};
    }

    const files = await fs.readdir(rulesDir()).catch(() => []);
    const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));
    const targets = cfg && cfg.targets ? Object.keys(cfg.targets) : [];

    process.stdout.write("\n");
    process.stdout.write("╔══════════════════════════════════════════════════════════════╗\n");
    process.stdout.write("║                    🧠 SYNAPSE STATUS                         ║\n");
    process.stdout.write("╠══════════════════════════════════════════════════════════════╣\n");
    process.stdout.write(`║  Version:     ${(cfg && cfg.version) || "unknown"}\n`);
    process.stdout.write(`║  Rules:       ${ruleFiles.length} rule(s)\n`);
    process.stdout.write(`║  Targets:     ${targets.length ? targets.join(", ") : "none"}\n`);
    process.stdout.write(`║  Workspace:   ${process.cwd()}\n`);
    process.stdout.write("╚══════════════════════════════════════════════════════════════╝\n");
    process.stdout.write("\n");

    if (ruleFiles.length) {
      process.stdout.write("📄 Rules:\n");
      for (const f of ruleFiles) process.stdout.write(`  - ${f}\n`);
    }
  });

program
  .command("target")
  .description("Manage IDE targets")
  .argument("<action>", "add, remove, list")
  .argument("[ide]", "IDE name (trae, cursor, windsurf, cline)")
  .action(async (action, ide) => {
    await ensureInitialized();

    const cp = configPath();
    const cfg = (await fs.readJson(cp).catch(() => ({}))) || {};
    cfg.targets = cfg.targets || {};

    if (action === "list") {
      process.stdout.write("🎯 Enabled targets:\n");
      for (const [name, t] of Object.entries(cfg.targets)) {
        process.stdout.write(`  - ${name}: ${t && t.enabled ? "enabled" : "disabled"}\n`);
      }
      return;
    }

    if (!ide) {
      process.stdout.write('❌ Specify IDE: synapse target add <ide> | synapse target remove <ide>\n');
      return;
    }

    if (action === "add") {
      cfg.targets[ide] = { enabled: true, path: `${getTargetPath(ide)}/` };
      await fs.writeJson(cp, cfg, { spaces: 2 });
      process.stdout.write(`✅ Added ${ide} target\n`);
      return;
    }

    if (action === "remove") {
      delete cfg.targets[ide];
      await fs.writeJson(cp, cfg, { spaces: 2 });
      process.stdout.write(`✅ Removed ${ide} target\n`);
      return;
    }

    process.stdout.write("❌ Unknown action. Use: add, remove, list\n");
  });

program.parseAsync(process.argv).catch((err) => {
  printCliError(err);
});


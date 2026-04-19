#!/usr/bin/env node

const { Command } = require("commander");
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

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
    throw new Error('Run "synapse init" first');
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
  };
  return map[target] || `.${target}`;
}

function getTargetExtension(target) {
  const map = {
    trae: ".md",
    cursor: ".mdc",
    windsurf: ".windsurfrules",
    cline: ".md",
  };
  return map[target] || ".txt";
}

async function compileToTarget({ rulesPath, target, workspace, minify }) {
  const outDir = path.join(workspace, getTargetPath(target));
  await fs.ensureDir(outDir);

  const files = await fs.readdir(rulesPath);
  const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));

  for (const file of ruleFiles) {
    const inPath = path.join(rulesPath, file);
    const content = await fs.readFile(inPath, "utf8");
    const rule = parseRuleFile(content, inPath);
    let compiled;
    if (target === "trae") compiled = compileTrae(rule, { minify });
    else if (target === "cursor") compiled = compileCursor(rule, { minify });
    else if (target === "windsurf") compiled = compileWindsurf(rule, { minify });
    else if (target === "cline") compiled = compileTrae(rule, { minify });
    else compiled = rule.content;
    const outPath = path.join(outDir, `${rule.id}${getTargetExtension(target)}`);
    await fs.writeFile(outPath, compiled, "utf8");
  }
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

program.name("synapse").description("Synapse - Universal rule orchestration for all IDEs").version("0.1.0");

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
  .description("Compile rules to target IDEs")
  .option("-t, --target <ide>", "Target IDE (trae, cursor, windsurf, cline)")
  .option("-a, --all", "Sync to all enabled IDEs")
  .option("--minify", "Remove leading/trailing whitespace from output")
  .option("-w, --watch", "Watch mode (auto-sync on changes)")
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

    for (const t of targets) {
      await compileToTarget({ rulesPath: rp, target: t, workspace: process.cwd(), minify: !!options.minify });
    }

    process.stdout.write("✅ Sync complete\n");

    if (options.watch) {
      const chokidar = require("chokidar");
      process.stdout.write("👀 Watch mode enabled. Waiting for changes...\n");
      const watcher = chokidar.watch(rp, { persistent: true, ignoreInitial: true });
      watcher.on("change", async (file) => {
        process.stdout.write(`📝 Changed: ${path.basename(file)}\n`);
        for (const t of targets) await compileToTarget({ rulesPath: rp, target: t, workspace: process.cwd(), minify: !!options.minify });
        process.stdout.write("✅ Synced\n");
      });
    }
  });

program
  .command("watch")
  .description("Watch .synapse/ and auto-sync on changes")
  .option("-t, --targets <ides>", "Comma-separated IDEs to sync to", "trae,cursor")
  .option("--minify", "Remove leading/trailing whitespace from output")
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

    const watcher = chokidar.watch(rp, { ignored: /(^|[\/\\])\../, persistent: true, ignoreInitial: true });
    const doAll = async () => {
      for (const t of targets) await compileToTarget({ rulesPath: rp, target: t, workspace: process.cwd(), minify: !!options.minify });
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
      throw new Error(`Dashboard server not found: ${serverPath}`);
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
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exitCode = 1;
});


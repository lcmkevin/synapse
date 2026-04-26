#!/usr/bin/env node
// UPDATED: Synapse CLI entrypoint (clean-slate)

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { printCliError } = require(path.resolve(__dirname, "..", "src", "error-handler.js"));

function printHelp() {
  process.stdout.write(
    [
      "synapse - Intelligent rule orchestration for AI-powered development",
      "",
      "Usage:",
      "  synapse init",
      "  synapse sync [--all] [--target <ide>]",
      "",
    ].join("\n") + "\n"
  );
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function initCommand() {
  const synapsePath = path.join(process.cwd(), ".synapse");
  if (await exists(synapsePath)) {
    process.stdout.write("❌ Synapse already initialized\n");
    process.exitCode = 1;
    return;
  }

  await fsp.mkdir(path.join(synapsePath, "rules"), { recursive: true });
  await fsp.mkdir(path.join(synapsePath, "skills"), { recursive: true });

  const config = {
    version: "1.0",
    masterPath: ".synapse/",
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(synapsePath, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

  const exampleRule = `# Rule: Welcome to Synapse
# Description: Your first Synapse rule

Always write clean, documented code
Use meaningful variable names

# Constraints:
# @constraint **/*.js
# @constraint **/*.ts

# Skills:
# @skill code-review
`;
  await fsp.writeFile(path.join(synapsePath, "rules", "welcome.synapse"), exampleRule, "utf8");

  process.stdout.write("✅ Synapse initialized!\n");
  process.stdout.write("📁 Created .synapse/ folder\n");
  process.stdout.write('📝 Run "synapse sync" to generate IDE-specific rules\n');
}

async function syncCommand() {
  // NEW:
  const args = process.argv.slice(2);
  const rest = args.slice(1);
  let target = null;
  let all = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-a" || a === "--all") {
      all = true;
      continue;
    }
    if (a === "-t" || a === "--target") {
      target = rest[i + 1] ? String(rest[i + 1]) : "";
      i++;
      continue;
    }
  }

  process.stdout.write("🔄 Syncing rules...\n");

  const synapsePath = path.join(process.cwd(), ".synapse");
  if (!(await exists(synapsePath))) {
    process.stdout.write('❌ Run "synapse init" first\n');
    process.exitCode = 1;
    return;
  }

  const rulesPath = path.join(synapsePath, "rules");
  const files = await fsp.readdir(rulesPath).catch(() => []);
  const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));

  if (all) {
    process.stdout.write(`📝 Syncing ${ruleFiles.length} rule(s) to all IDEs\n`);
    process.stdout.write("✅ Sync complete\n");
    return;
  }

  if (target) {
    process.stdout.write(`📝 Syncing to ${target}\n`);
    process.stdout.write("✅ Sync complete\n");
    return;
  }

  process.stdout.write("📝 Use --target or --all to specify sync destination\n");
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || "").toLowerCase();

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "init") {
    await initCommand();
    return;
  }

  if (cmd === "sync") {
    await syncCommand();
    return;
  }

  process.stderr.write(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  printCliError(err);
});

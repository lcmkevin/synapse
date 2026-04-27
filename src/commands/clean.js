const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function homedirPath(...parts) {
  return path.join(os.homedir(), ...parts);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function confirmPrompt(question) {
  const readline = require("readline");
  return await new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve(false);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      const v = String(answer || "").trim().toLowerCase();
      resolve(v === "y" || v === "yes");
    });
  });
}

async function cleanCommand(options = {}) {
  const opts = options && typeof options === "object" ? options : {};

  const synapseDir = homedirPath(".synapse");
  const cacheDir = homedirPath(".synapse", "cache");
  const backupsDir = homedirPath(".synapse", "backups");
  const localSynapseDir = path.join(process.cwd(), ".synapse");

  const wantAll = !!opts.all;
  const wantCache = !!opts.cache;
  const wantBackups = !!opts.backups;
  const wantConfig = !!opts.config;

  const toDelete = [];

  if (wantAll || wantConfig) {
    if (await pathExists(synapseDir)) toDelete.push({ p: synapseDir, label: "Global configuration (~/.synapse/)" });
    if (await pathExists(localSynapseDir)) toDelete.push({ p: localSynapseDir, label: "Local configuration (./.synapse/)" });
  } else {
    if (wantCache && (await pathExists(cacheDir))) toDelete.push({ p: cacheDir, label: "Cache files (~/.synapse/cache/)" });
    if (wantBackups && (await pathExists(backupsDir))) toDelete.push({ p: backupsDir, label: "Backup files (~/.synapse/backups/)" });
  }

  if (toDelete.length === 0) {
    process.stdout.write("No Synapse files found to clean.\n");
    return;
  }

  process.stdout.write("\n🧹 The following will be deleted:\n\n");
  for (const item of toDelete) process.stdout.write(`  • ${item.label}: ${item.p}\n`);

  if (!opts.force) {
    const confirmed = await confirmPrompt("\nDelete these files? (y/N) ");
    if (!confirmed) {
      process.stdout.write("Clean cancelled.\n");
      return;
    }
  }

  for (const item of toDelete) {
    try {
      await fs.rm(item.p, { recursive: true, force: true });
      process.stdout.write(`✅ Deleted: ${item.label}\n`);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : "Unknown error";
      process.stdout.write(`❌ Failed to delete ${item.label}: ${msg}\n`);
      process.exitCode = 1;
    }
  }

  process.stdout.write("\n✨ Synapse files cleaned successfully\n");
}

module.exports = { cleanCommand };

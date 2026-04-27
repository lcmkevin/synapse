import fs from "fs/promises";
import os from "os";
import path from "path";

type CleanOptions = {
  all?: boolean;
  cache?: boolean;
  backups?: boolean;
  config?: boolean;
  force?: boolean;
};

function homedirPath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function confirmPrompt(question: string): Promise<boolean> {
  const readline = require("readline") as typeof import("readline");
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

export async function cleanCommand(options: CleanOptions = {}): Promise<void> {
  const synapseDir = homedirPath(".synapse");
  const cacheDir = homedirPath(".synapse", "cache");
  const backupsDir = homedirPath(".synapse", "backups");
  const localSynapseDir = path.join(process.cwd(), ".synapse");

  const wantAll = !!options.all;
  const wantCache = !!options.cache;
  const wantBackups = !!options.backups;
  const wantConfig = !!options.config;

  const toDelete: Array<{ p: string; label: string }> = [];

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

  if (!options.force) {
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
    } catch (err: any) {
      const msg = err && err.message ? String(err.message) : "Unknown error";
      process.stdout.write(`❌ Failed to delete ${item.label}: ${msg}\n`);
      process.exitCode = 1;
    }
  }

  process.stdout.write("\n✨ Synapse files cleaned successfully\n");
}


#!/usr/bin/env node
const path = require("path");
const { spawn } = require("child_process");
const { printCliError } = require(path.resolve(__dirname, "..", "src", "error-handler.js"));

async function main() {
  if (!process.env.SYNAPSE_SUPPRESS_LEGACY_CLI_WARNING) {
    process.stderr.write(
      "⚠️ Deprecated entrypoint. Use the unified CLI entrypoint: synapse\n" +
        "Tip: Synapse supports safe sync/rollback, local cost analysis, conflict detection, and zero lock-in imports.\n\n"
    );
  }

  const unifiedPath = path.resolve(__dirname, "synapse-unified.js");
  const child = spawn(process.execPath, [unifiedPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      process.exitCode = typeof code === "number" ? code : 1;
      resolve();
    });
  });
}

main().catch((err) => {
  printCliError(err);
});

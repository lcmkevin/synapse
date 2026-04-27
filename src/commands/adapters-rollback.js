const path = require("path");
const { getCurrentLicense } = require(path.resolve(__dirname, "..", "license", "checker.js"));
const { showUpgradeMessage } = require(path.resolve(__dirname, "..", "license-check.js"));

function loadProModule() {
  try {
    return require(path.resolve(__dirname, "..", "..", "packages", "pro", "cli", "commands", "adapters-rollback.js"));
  } catch {
    return null;
  }
}

async function runAdaptersRollback({ ideId, version }) {
  const license = await getCurrentLicense().catch(() => ({ valid: false, plan: "free" }));
  if (!license || license.valid !== true) {
    process.stdout.write("🔒 Pro required: adapters rollback\n");
    showUpgradeMessage();
    process.exitCode = 1;
    return;
  }

  const mod = loadProModule();
  if (!mod || typeof mod.runAdaptersRollback !== "function") {
    process.stdout.write("❌ Pro module not available for adapters rollback\n");
    showUpgradeMessage();
    process.exitCode = 1;
    return;
  }

  await mod.runAdaptersRollback({ ideId, version });
}

module.exports = { runAdaptersRollback };

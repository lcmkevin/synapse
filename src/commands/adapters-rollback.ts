import path from "path";
import { getCurrentLicense } from "../license/checker";

function loadProModule(): any | null {
  try {
    return require("../../packages/pro/cli/commands/adapters-rollback.js");
  } catch {
    return null;
  }
}

export async function runAdaptersRollback(ideId: string, version: string): Promise<void> {
  const license = await getCurrentLicense().catch(() => ({ valid: false, plan: "free" as const }));
  if (!license || license.valid !== true) {
    process.stdout.write("🔒 Pro required: adapters rollback\n");
    try {
      const mod = require("../license-check.js") as any;
      if (mod && typeof mod.showUpgradeMessage === "function") mod.showUpgradeMessage();
    } catch {}
    process.exitCode = 1;
    return;
  }

  const mod = loadProModule();
  if (!mod || typeof mod.runAdaptersRollback !== "function") {
    process.stdout.write("❌ Pro module not available for adapters rollback\n");
    process.exitCode = 1;
    return;
  }

  await mod.runAdaptersRollback({ ideId: typeof ideId === "string" ? ideId.trim() : "", version: typeof version === "string" ? version.trim() : "" });
}

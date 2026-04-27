import { getCurrentLicense } from "../license/checker";

export const SUPPORTED_IDES = ["cursor", "trae", "windsurf", "cline", "zed"] as const;

export async function runAdaptersList(): Promise<void> {
  const license = await getCurrentLicense().catch(() => ({ valid: false, plan: "free" as const }));
  const isPro = !!license && license.valid === true && (license.plan === "pro" || license.plan === "enterprise");

  if (isPro) {
    try {
      const mod = require("../../packages/pro/cli/commands/adapters-list.js") as any;
      if (mod && typeof mod.runAdaptersList === "function") {
        await mod.runAdaptersList({ plan: license.plan });
        return;
      }
    } catch {}
  }

  process.stdout.write("🔒 Pro required: adapters list\n");
  try {
    const { showUpgradeMessage } = require("../license-check") as any;
    if (typeof showUpgradeMessage === "function") showUpgradeMessage();
  } catch {}
}

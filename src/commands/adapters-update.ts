import { getCurrentLicense } from "../license/checker";

function loadProModule(): any | null {
  try {
    return require("../../packages/pro/cli/commands/adapters-update.js");
  } catch {
    return null;
  }
}

function printManualInstructions(ideId: string): void {
  let base = "https://labs-synapse.com";
  try {
    const mod = require("../license-check.js") as any;
    if (mod && typeof mod.getApiBaseUrl === "function") base = String(mod.getApiBaseUrl());
  } catch {}

  process.stdout.write(`\n⚠️ Manual update required for ${ideId}\n\n`);
  process.stdout.write(`Download: ${base}/downloads/adapters/${ideId}.json\n`);
  process.stdout.write(`Save to: ~/.synapse/adapters/${ideId}.json\n\n`);
  process.stdout.write("Upgrade to Pro for one-command updates: synapse enter-license\n\n");
}

export async function runAdaptersUpdate(args: { ideId?: string; all?: boolean }): Promise<void> {
  const supported = ["cursor", "trae", "windsurf", "cline", "zed"];
  const license = await getCurrentLicense().catch(() => ({ valid: false, plan: "free" as const }));
  const isPro = !!license && license.valid === true && (license.plan === "pro" || license.plan === "enterprise");

  const targets = args.all ? supported : [args.ideId].filter(Boolean) as string[];
  if (targets.length === 0) {
    process.stdout.write("❌ Specify an IDE or use --all\n");
    process.exitCode = 1;
    return;
  }

  if (isPro) {
    const mod = loadProModule();
    if (mod && typeof mod.runAdaptersUpdate === "function") {
      await mod.runAdaptersUpdate({ ideId: typeof args.ideId === "string" ? args.ideId.trim() : "", all: !!args.all, plan: license.plan });
      return;
    }
  }

  for (const id of targets) {
    if (!supported.includes(id)) {
      process.stdout.write(`❌ Unknown IDE: ${id}. Supported: ${supported.join(", ")}\n`);
      process.exitCode = 1;
      continue;
    }
    printManualInstructions(id);
  }

  try {
    const mod = require("../license-check.js") as any;
    if (mod && typeof mod.showUpgradeMessage === "function") mod.showUpgradeMessage();
  } catch {}
}

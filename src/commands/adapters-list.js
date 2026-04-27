const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { getCurrentLicense } = require(path.resolve(__dirname, "..", "license", "checker.js"));
const { showUpgradeMessage } = require(path.resolve(__dirname, "..", "license-check.js"));

const SUPPORTED_IDES = ["cursor", "trae", "windsurf", "cline", "zed"];

function homedirPath(...parts) {
  return path.join(os.homedir(), ...parts);
}

async function readInstalledVersion(ideId) {
  const p = homedirPath(".synapse", "adapters", `${ideId}.json`);
  try {
    const text = await fs.readFile(p, "utf8");
    const json = JSON.parse(text);
    const v = typeof json?.version === "string" ? json.version.trim() : "";
    return v || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function pad(s, w) {
  return String(s).padEnd(w, " ");
}

function loadProModule() {
  try {
    return require(path.resolve(__dirname, "..", "..", "packages", "pro", "cli", "commands", "adapters-list.js"));
  } catch {
    return null;
  }
}

async function runAdaptersList() {
  const license = await getCurrentLicense().catch(() => ({ valid: false, plan: "free" }));
  const isPro = !!license && license.valid === true && (license.plan === "pro" || license.plan === "enterprise");

  if (isPro) {
    const mod = loadProModule();
    if (mod && typeof mod.runAdaptersList === "function") {
      await mod.runAdaptersList({ plan: license.plan });
      return;
    }
  }

  const rows = [];
  for (const ideId of SUPPORTED_IDES) {
    const current = await readInstalledVersion(ideId);
    rows.push({ ide: ideId, current: `v${current}`, status: "🔒 Pro required", latest: "-" });
  }

  const ideW = Math.max("IDE".length, ...rows.map((r) => r.ide.length));
  const curW = Math.max("Current".length, ...rows.map((r) => r.current.length));
  const statusW = Math.max("Status".length, ...rows.map((r) => r.status.length));
  const latestW = Math.max("Latest".length, ...rows.map((r) => r.latest.length));

  process.stdout.write(`${pad("IDE", ideW)}  ${pad("Current", curW)}  ${pad("Status", statusW)}  ${pad("Latest", latestW)}\n`);
  process.stdout.write(`${"-".repeat(ideW)}  ${"-".repeat(curW)}  ${"-".repeat(statusW)}  ${"-".repeat(latestW)}\n`);
  for (const r of rows) {
    process.stdout.write(`${pad(r.ide, ideW)}  ${pad(r.current, curW)}  ${pad(r.status, statusW)}  ${pad(r.latest, latestW)}\n`);
  }

  showUpgradeMessage();
}

module.exports = { runAdaptersList, SUPPORTED_IDES };

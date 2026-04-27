const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const semver = require("semver");
const { fetch: undiciFetch, Headers, Request, Response } = require("undici");

const { getCurrentLicense } = require(path.resolve(__dirname, "..", "license", "checker.js"));
const { showUpgradeMessage, getApiBaseUrl } = require(path.resolve(__dirname, "..", "license-check.js"));

function homedirPath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function safeSemver(v) {
  const cleaned = semver.valid(semver.coerce(String(v ?? "")));
  return typeof cleaned === "string" ? cleaned : null;
}

async function readJsonFile(p) {
  try {
    const text = await fs.readFile(p, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJsonAtomic(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, p);
}

async function readInstalledVersion(ideId) {
  const p = homedirPath(".synapse", "adapters", `${ideId}.json`);
  const parsed = await readJsonFile(p);
  const v = typeof parsed?.version === "string" ? parsed.version.trim() : "";
  return v || "1.0.0";
}

async function hasOverride(ideId) {
  const p = homedirPath(".synapse", "adapters", "overrides", `${ideId}.json`);
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function ensureFetchForNode16() {
  if (typeof globalThis.fetch === "function") return;
  globalThis.fetch = undiciFetch;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
}

function cacheDir() {
  return homedirPath(".synapse", "cache", "adapters");
}

function manifestPath() {
  return path.join(cacheDir(), "manifest.json");
}

async function readManifest() {
  const m = await readJsonFile(manifestPath());
  if (m && m.schemaVersion === 1 && m.lastChecked && typeof m.lastChecked === "object") return m;
  return { schemaVersion: 1, lastChecked: {} };
}

async function markChecked(key) {
  const m = await readManifest();
  m.lastChecked[key] = new Date().toISOString();
  await writeJsonAtomic(manifestPath(), m);
}

function parseDateMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

async function checkedWithin(key, ttlMs) {
  const m = await readManifest();
  const last = parseDateMs(m.lastChecked?.[key]);
  if (!last) return false;
  return Date.now() - last < ttlMs;
}

function loadProModule() {
  try {
    return require(path.resolve(__dirname, "..", "..", "packages", "pro", "cli", "commands", "adapters-update.js"));
  } catch {
    return null;
  }
}

function printManualInstructions(ideId) {
  const base = getApiBaseUrl();
  process.stdout.write(`\n⚠️ Manual update required for ${ideId}\n\n`);
  process.stdout.write(`Download: ${base}/downloads/adapters/${ideId}.json\n`);
  process.stdout.write(`Save to: ~/.synapse/adapters/${ideId}.json\n\n`);
  process.stdout.write("Upgrade to Pro for one-command updates: synapse enter-license\n\n");
}

async function runAdaptersUpdate({ ideId, all }) {
  const supported = ["cursor", "trae", "windsurf", "cline", "zed"];
  const license = await getCurrentLicense().catch(() => ({ valid: false, plan: "free" }));
  const isPro = !!license && license.valid === true && (license.plan === "pro" || license.plan === "enterprise");

  const targets = all ? supported : [ideId].filter(Boolean);
  if (targets.length === 0) {
    process.stdout.write("❌ Specify an IDE or use --all\n");
    process.exitCode = 1;
    return;
  }

  if (isPro) {
    const mod = loadProModule();
    if (mod && typeof mod.runAdaptersUpdate === "function") {
      await mod.runAdaptersUpdate({ ideId: typeof ideId === "string" ? ideId.trim() : "", all: !!all, plan: license.plan });
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

  showUpgradeMessage();
}

async function updateAdapterIfNeeded({ ideId, planOverride, quiet }) {
  const license = await getCurrentLicense().catch(() => ({ valid: false, plan: "free" }));
  const isPro = !!license && license.valid === true && (license.plan === "pro" || license.plan === "enterprise");
  if (!isPro) return null;

  const mod = loadProModule();
  if (!mod || typeof mod.updateAdapterIfNeeded !== "function") return null;

  const plan = planOverride || license.plan;
  return await mod.updateAdapterIfNeeded({ ideId, plan, quiet: !!quiet });
}

async function checkAdapterTipIfNeeded({ ideId, quiet }) {
  const supported = ["cursor", "trae", "windsurf", "cline", "zed"];
  const id = typeof ideId === "string" ? ideId.trim() : "";
  if (!id || !supported.includes(id)) return null;

  if (await hasOverride(id)) return null;

  const key = `${id}:free-tip`;
  const ttlMs = 24 * 60 * 60 * 1000;
  const recentlyChecked = await checkedWithin(key, ttlMs);
  if (recentlyChecked) return null;

  ensureFetchForNode16();
  const current = safeSemver(await readInstalledVersion(id)) || "1.0.0";
  const url = `${getApiBaseUrl()}/downloads/adapters/${id}.json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const text = await resp.text();
    const json = (() => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    })();
    const latest = safeSemver(json?.version);
    if (latest && semver.gt(latest, current)) {
      if (!quiet) process.stdout.write(`Tip: New ${id} adapter available. Run: synapse adapters update ${id}\n`);
      return { ideId: id, status: "manual_available", fromVersion: current, toVersion: latest };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    await markChecked(key).catch(() => void 0);
  }
}

module.exports = { runAdaptersUpdate, updateAdapterIfNeeded, checkAdapterTipIfNeeded };

// UPDATED: Synapse extension entry point (clean-slate)
import * as vscode from "vscode";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { AdapterManager } from "./compiler/adapter-manager"; // NEW:
import { ActionsViewProvider } from "./features/actionsView";
import WebSocket from "ws";
import { AIModel, TokenCounter } from "./features/tokenAnalysis/tokenCounter";
import { SkillConverter } from "./features/tokenAnalysis/skillConverter";
import { ImportScanner } from "./features/importScanner";
import { FormatConverter } from "./features/formatConverter";
import { CompressionResult, RuleCompressor as FreeRuleCompressor } from "./features/ruleCompressor";
import { UNINSTALL_FEEDBACK_URL } from "./product";

let tokenCounter: TokenCounter | null = null;
let cleanupContext: vscode.ExtensionContext | null = null;

function backupRootDir(): string {
  return path.join(os.homedir(), ".synapse", "backups");
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

type CompressionMetricsMode = "off" | "local" | "upload";

function getCompressionMetricsMode(): CompressionMetricsMode {
  const raw = vscode.workspace.getConfiguration("synapse").get<string>("compressionMetrics");
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "local" || v === "upload") return v;
  return "off";
}

async function appendJsonlLine(filePath: string, payload: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const line = JSON.stringify(payload) + "\n";
  await fs.appendFile(filePath, line, "utf8");
  if (process.platform !== "win32") {
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      void 0;
    }
  }
}

async function postJson(urlString: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "http:" ? http : https;
    const payload = JSON.stringify(body ?? {});
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (!data) return resolve({ status, json: null });
          try {
            resolve({ status, json: JSON.parse(data) });
          } catch {
            resolve({ status, json: null });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function recordCompressionMetric(
  context: vscode.ExtensionContext,
  event: {
    source: "selection" | "workspace";
    beforeTokens: number;
    afterTokens: number;
    savingsPercent: number;
    fileCount?: number;
    hitCounts?: Record<string, number>;
    isPro: boolean;
  }
): Promise<void> {
  const mode = getCompressionMetricsMode();
  if (mode === "off") return;

  const payload = {
    ts: new Date().toISOString(),
    source: event.source,
    beforeTokens: event.beforeTokens,
    afterTokens: event.afterTokens,
    savingsPercent: event.savingsPercent,
    fileCount: typeof event.fileCount === "number" ? event.fileCount : undefined,
    hitCounts: event.hitCounts && Object.keys(event.hitCounts).length ? event.hitCounts : undefined,
    isPro: event.isPro,
    extensionVersion: context.extension?.packageJSON?.version,
    platform: process.platform,
  };

  if (mode === "local") {
    const p = path.join(os.homedir(), ".synapse", "telemetry", "compression-metrics.jsonl");
    await appendJsonlLine(p, payload);
    return;
  }

  const key = await context.secrets.get("synapse.licenseKey.v1");
  const licenseKey = typeof key === "string" ? key.trim() : "";
  if (!licenseKey) return;

  let base = "https://www.labs-synapse.com";
  try {
    const configured = vscode.workspace.getConfiguration("synapse").get<string>("licenseApiUrl");
    const trimmed = typeof configured === "string" && configured.trim() ? configured.trim().replace(/\/+$/, "") : base;
    base = /^https?:\/\/labs-synapse\.com$/i.test(trimmed) ? trimmed.replace(/\/\/labs-synapse\.com$/i, "//www.labs-synapse.com") : trimmed;
  } catch {
    void 0;
  }

  const instanceId = vscode.env.machineId || "unknown";
  try {
    await postJson(`${base}/api/telemetry/compression`, { licenseKey, instanceId, event: payload });
  } catch {
    void 0;
  }
}

async function getCliInvocation(workspaceRoot: string): Promise<string> {
  const localCli = path.join(workspaceRoot, "bin", "synapse-unified.js");
  try {
    await fs.access(localCli);
    return `node "${localCli}"`;
  } catch {
    return "synapse";
  }
}

async function getCliCommand(workspaceRoot: string): Promise<{ command: string; args: string[]; display: string; useShell: boolean }> {
  const localCli = path.join(workspaceRoot, "bin", "synapse-unified.js");
  try {
    await fs.access(localCli);
    return {
      command: process.execPath,
      args: [localCli],
      display: `node "${localCli}"`,
      useShell: false,
    };
  } catch {
    return { command: "synapse", args: [], display: "synapse", useShell: process.platform === "win32" };
  }
}

async function runCliToOutput(
  workspaceRoot: string,
  cliArgs: string[],
  output: vscode.OutputChannel,
  label: string
): Promise<number> {
  const base = await getCliCommand(workspaceRoot);
  const fullArgs = [...base.args, ...cliArgs];

  output.show(true);
  output.appendLine(`\n[${label}] ${base.display} ${cliArgs.join(" ")}`.trim());

  return await new Promise<number>((resolve) => {
    let resolved = false;
    const done = (code: number) => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    const child = spawn(base.command, fullArgs, {
      cwd: workspaceRoot,
      env: process.env,
      shell: base.useShell,
    });

    child.stdout?.on("data", (chunk) => {
      output.append(chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      output.append(chunk.toString());
    });
    child.on("error", (err) => {
      output.appendLine(`\n[${label}] Failed to run CLI: ${err instanceof Error ? err.message : String(err)}`);
      done(1);
    });
    child.on("close", (code) => {
      const n = typeof code === "number" ? code : 1;
      output.appendLine(`\n[${label}] Exit code: ${n}`);
      done(n);
    });
  });
}

async function listBackups(): Promise<string[]> {
  try {
    const entries = await fs.readdir(backupRootDir());
    return entries.filter((b) => b.startsWith("backup_")).sort().reverse();
  } catch {
    return [];
  }
}

async function pruneBackups(maxKeep: number): Promise<void> {
  const keep = Number.isFinite(maxKeep) ? Math.max(0, Math.floor(maxKeep)) : 0;
  if (keep <= 0) return;
  const backups = await listBackups();
  const extra = backups.slice(keep);
  for (const name of extra) {
    try {
      await fs.rm(path.join(backupRootDir(), name), { recursive: true, force: true });
    } catch {
      void 0;
    }
  }
}

async function createBackup(workspaceRoot: string, retention: number): Promise<string> {
  const synapsePath = path.join(workspaceRoot, ".synapse");
  const ok = await fsPathExists(synapsePath);
  if (!ok) throw new Error("Missing .synapse/ in workspace");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folderName = `backup_${timestamp}`;
  const backupFolder = path.join(backupRootDir(), folderName);
  await ensureDir(backupFolder);
  await fs.cp(synapsePath, backupFolder, { recursive: true });
  await pruneBackups(retention);
  return backupFolder;
}

async function restoreBackupByName(name: string, workspaceRoot: string): Promise<void> {
  const backupPath = path.join(backupRootDir(), name);
  const ok = await fsPathExists(backupPath);
  if (!ok) throw new Error("Backup not found");
  const targetPath = path.join(workspaceRoot, ".synapse");
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.cp(backupPath, targetPath, { recursive: true });
}

async function fsPathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function deleteFsPath(p: string): Promise<boolean> {
  try {
    await fs.rm(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function performCleanup(context: vscode.ExtensionContext): Promise<number> {
  const homeDir = os.homedir();
  const synapseDir = path.join(homeDir, ".synapse");

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const workspaceSynapseDirs: string[] = [];
  for (const folder of workspaceFolders) {
    const synapsePath = path.join(folder.uri.fsPath, ".synapse");
    if (await fsPathExists(synapsePath)) workspaceSynapseDirs.push(synapsePath);
  }

  const storageDirs: string[] = [];
  if (context.storageUri?.fsPath) storageDirs.push(context.storageUri.fsPath);
  if (context.globalStorageUri?.fsPath) storageDirs.push(context.globalStorageUri.fsPath);

  let removedCount = 0;

  if (await fsPathExists(synapseDir)) {
    if (await deleteFsPath(synapseDir)) removedCount += 1;
  }

  for (const p of workspaceSynapseDirs) {
    if (await deleteFsPath(p)) removedCount += 1;
  }

  for (const p of storageDirs) {
    if (await fsPathExists(p)) {
      if (await deleteFsPath(p)) removedCount += 1;
    }
  }

  return removedCount;
}

async function promptForCleanup(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Synapse Extension - Cleanup Options",
    { modal: true, detail: "Do you want to remove Synapse-generated files and configuration from this machine?" },
    "Remove Everything",
    "Keep Configuration",
    "Cancel"
  );

  if (choice === "Remove Everything") {
    const removedCount = await performCleanup(context);
    void vscode.window.showInformationMessage(`✅ Synapse files removed successfully (${removedCount} location(s))`);
    const feedback = await vscode.window.showInformationMessage("Help us improve Synapse", "Share Feedback", "No Thanks");
    if (feedback === "Share Feedback") {
      void vscode.env.openExternal(vscode.Uri.parse(UNINSTALL_FEEDBACK_URL));
    }
    return;
  }

  if (choice === "Keep Configuration") {
    void vscode.window.showInformationMessage("Synapse configuration kept at ~/.synapse/");
  }
}

class PlaceholderViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly title: string,
    private readonly description: string,
    private readonly buttonLabel: string,
    private readonly commandId: string
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = `<!doctype html><html><body style="padding:10px;font-family:var(--vscode-font-family)"><h3>${this.title}</h3><p>${this.description}</p><button id="run" style="padding:6px 10px">${this.buttonLabel}</button><script>const vscode=acquireVsCodeApi();document.getElementById('run').onclick=()=>vscode.postMessage({command:'run'});</script></body></html>`;
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.command === "run") await vscode.commands.executeCommand(this.commandId);
    });
  }
}

type LicenseManagerLike = {
  initialize(context: vscode.ExtensionContext): void;
  isProUser(): boolean;
  canUseFeature(feature: any): boolean;
  showUpgradePrompt(): Promise<void>;
  activateLicense?(key: string): Promise<boolean>;
  runDiagnostics?(): Promise<void>;
  forgetLicenseKey?(): Promise<void>;
};

type RuleCompressorLike = {
  fetchLatestDictionary?: (force?: boolean) => Promise<void>;
  applyCompression: (text: string, isPro: boolean) => CompressionResult | Promise<CompressionResult>;
};

async function loadLicenseManager(context: vscode.ExtensionContext): Promise<LicenseManagerLike> {
  const proPath = path.join(context.extensionPath, "..", "packages", "pro", "extension", "license");
  try {
    const proModule: any = require(proPath);
    if (proModule?.LicenseManager?.getInstance) {
      const inst: LicenseManagerLike = proModule.LicenseManager.getInstance();
      inst.initialize(context);
      return inst;
    }
  } catch {
    void 0;
  }

  const fallbackModule: any = require("./license");
  const inst: LicenseManagerLike = fallbackModule.LicenseManager.getInstance();
  inst.initialize(context);
  return inst;
}

async function loadRuleCompressor(context: vscode.ExtensionContext): Promise<RuleCompressorLike> {
  const proPath = path.join(context.extensionPath, "..", "packages", "pro", "extension", "RuleCompressor");
  try {
    const proModule: any = require(proPath);
    if (proModule?.RuleCompressor) {
      const inst: RuleCompressorLike = new proModule.RuleCompressor(context);
      return inst;
    }
  } catch {
    void 0;
  }
  return new FreeRuleCompressor();
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("Synapse extension activated"); // NEW:
  cleanupContext = context;

  const license = await loadLicenseManager(context);
  const compressor = await loadRuleCompressor(context);
  const output = vscode.window.createOutputChannel("Synapse");
  context.subscriptions.push(output);

  const virtualDocs = new Map<string, string>();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("synapse-virtual", {
      provideTextDocumentContent(uri) {
        const key = decodeURIComponent(String(uri.path || "").replace(/^\//, ""));
        return virtualDocs.get(key) || "";
      },
    })
  );

  const adapterManager = new AdapterManager(context); // NEW:
  tokenCounter = new TokenCounter();
  let skillConverter = new SkillConverter(context);
  let wsClient: WebSocket | null = null;
  const isProUser = () => license.isProUser();
  const importScanner = new ImportScanner();
  const formatConverter = new FormatConverter();

  function formatUnknownError(err: unknown): { message: string; detail?: string } {
    if (!err) return { message: "Unknown error" };
    if (typeof err === "string") return { message: err };
    if (err instanceof Error) {
      const msg = typeof err.message === "string" && err.message.trim() ? err.message.trim() : err.name;
      const detail = typeof err.stack === "string" && err.stack.trim() ? err.stack : undefined;
      return { message: msg || "Error", detail };
    }
    try {
      return { message: JSON.stringify(err) };
    } catch {
      return { message: String(err) };
    }
  }

  async function showCommandError(label: string, err: unknown) {
    const formatted = formatUnknownError(err);
    const code = typeof (err as any)?.code === "string" ? String((err as any).code) : "";
    const extra = code ? ` (${code})` : "";
    output.appendLine(`[${new Date().toISOString()}] ${label}${extra}: ${formatted.message}`);
    if (formatted.detail) output.appendLine(formatted.detail);

    const actions = formatted.detail ? ["Show Details"] : [];
    const picked = await vscode.window.showErrorMessage(`Synapse: ${label} failed: ${formatted.message}${extra}`, ...actions);
    if (picked === "Show Details") output.show(true);
  }

  function safeCommand<TArgs extends unknown[]>(label: string, fn: (...args: TArgs) => Promise<void>) {
    return async (...args: TArgs) => {
      try {
        await fn(...args);
      } catch (err) {
        await showCommandError(label, err);
      }
    };
  }

  function connectToSynapseWS(workspaceRoot: string) {
    const port = vscode.workspace.getConfiguration("synapse").get("wsPort", 3457);
    try {
      wsClient = new WebSocket(`ws://localhost:${port}?ide=vscode&workspace=${encodeURIComponent(workspaceRoot)}`);
    } catch {
      wsClient = null;
      return;
    }

    wsClient.on("open", () => void 0);
    wsClient.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "sync_broadcast") {
          void vscode.window.showInformationMessage(`Synapse: ${msg.source} triggered sync`);
        }
        if (msg.type === "rule_changed") {
          void vscode.commands.executeCommand("synapse.sync");
        }
      } catch {
        void 0;
      }
    });
    wsClient.on("error", () => void 0);
    wsClient.on("close", () => void 0);
  }

  const initCommand = vscode.commands.registerCommand("synapse.init", safeCommand("Initialize Project", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Please open a workspace folder first");
      return;
    }

    const synapsePath = path.join(workspaceRoot, ".synapse");

    try {
      await fs.access(synapsePath);
      vscode.window.showInformationMessage("Synapse already initialized");
      return;
    } catch (error) {
      void error;
    }

    const detectedRules = await importScanner.scanWorkspace(workspaceRoot);
    const uniqueIdes = Array.from(new Set(detectedRules.map((r) => r.ide))).join(", ");

    let importedCount = 0;
    if (detectedRules.length > 0) {
      const importChoice = await vscode.window.showInformationMessage(
        `Found ${detectedRules.length} existing rule(s) from ${uniqueIdes}. Import to Synapse?`,
        "Import All",
        "Select Rules",
        "Skip"
      );

      let rulesToImport = detectedRules;
      if (importChoice === "Select Rules") {
        const selected = await vscode.window.showQuickPick(
          detectedRules.map((r) => ({
            label: r.suggestedName,
            description: `from ${r.ide}`,
            picked: true,
            rule: r,
          })),
          { canPickMany: true, placeHolder: "Select rules to import" }
        );
        if (!selected) return;
        rulesToImport = selected.map((s: any) => s.rule);
      }

      if (importChoice === "Import All" || importChoice === "Select Rules") {
        await fs.mkdir(path.join(synapsePath, "rules"), { recursive: true });
        await fs.mkdir(path.join(synapsePath, "skills"), { recursive: true });

        const config = {
          version: "1.0",
          masterPath: ".synapse/",
          createdAt: new Date().toISOString(),
        };
        await fs.writeFile(path.join(synapsePath, "config.json"), JSON.stringify(config, null, 2));

        for (const rule of rulesToImport) {
          const converted = formatConverter.convertToSynapse(rule);
          const targetPath = path.join(synapsePath, "rules", rule.suggestedName);
          await fs.writeFile(targetPath, converted, "utf-8");
        }

        importedCount = rulesToImport.length;
        vscode.window.showInformationMessage(`✅ Imported ${importedCount} rule(s) to .synapse/`);
        return;
      }
    }

    try {
      await fs.mkdir(path.join(synapsePath, "rules"), { recursive: true });
      await fs.mkdir(path.join(synapsePath, "skills"), { recursive: true });

      const config = {
        version: "1.0",
        masterPath: ".synapse/",
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(synapsePath, "config.json"), JSON.stringify(config, null, 2));

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
      await fs.writeFile(path.join(synapsePath, "rules", "welcome.synapse"), exampleRule);

      vscode.window.showInformationMessage("✅ Synapse initialized with example rule");
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to initialize: ${error}`);
    }
  }));

  const importFromIdeCommand = vscode.commands.registerCommand("synapse.importFromIDE", safeCommand("Import From IDE", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const detectedRules = await importScanner.scanWorkspace(workspaceRoot);
    if (detectedRules.length === 0) {
      vscode.window.showInformationMessage("No existing IDE rules found");
      return;
    }

    const selected = await vscode.window.showQuickPick(
      detectedRules.map((r) => ({
        label: r.suggestedName,
        description: `from ${r.ide} (${r.originalPath})`,
        picked: true,
        rule: r,
      })),
      { canPickMany: true, placeHolder: "Select rules to import" }
    );

    if (!selected) return;

    const synapseRulesPath = path.join(workspaceRoot, ".synapse", "rules");
    await fs.mkdir(synapseRulesPath, { recursive: true });

    for (const item of selected) {
      const rule = (item as any).rule;
      const converted = formatConverter.convertToSynapse(rule);
      await fs.writeFile(path.join(synapseRulesPath, rule.suggestedName), converted, "utf-8");
    }

    vscode.window.showInformationMessage(`✅ Imported ${selected.length} rule(s)`);
  }));

  const syncCommand = vscode.commands.registerCommand("synapse.sync", safeCommand("Sync Rules", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; // NEW:
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }
    const config = vscode.workspace.getConfiguration("synapse");
    const targets = config.get<Record<string, { enabled: boolean }>>("targets", {
      trae: { enabled: true },
      cursor: { enabled: true },
    });
    const configuredTargets = Object.entries(targets)
      .filter(([, v]) => v?.enabled !== false)
      .map(([k]) => k);
    const configured = configuredTargets.length > 0 ? configuredTargets : ["trae", "cursor"];

    let activeTargets = configured;
    if (!license.canUseFeature("unlimitedTargets") && configured.length > 2) {
      activeTargets = configured.slice(0, 2);
      vscode.window.showWarningMessage(
        `Free tier limited to 2 IDEs (${activeTargets.join(", ")}). Upgrade to Pro for unlimited targets.`
      );
    }

    const rulesDir = path.join(workspaceRoot, ".synapse", "rules");
    const files = await fs.readdir(rulesDir).catch(() => []);
    const ruleFiles = files.filter((f) => f.endsWith(".synapse"));
    if (ruleFiles.length === 0) {
      vscode.window.showWarningMessage("No .synapse rules found");
      return;
    }

    const mode = await vscode.window.showQuickPick(
      ["Sync (safe)", "Sync and overwrite all outputs", "Sync and skip existing outputs", "Select rules to sync (safe)"],
      { placeHolder: "Choose sync behavior" }
    );
    if (!mode) return;

    let conflictMode: "overwrite" | "skip" | "prompt" = "prompt";
    if (mode === "Sync and overwrite all outputs") conflictMode = "overwrite";
    if (mode === "Sync and skip existing outputs") conflictMode = "skip";

    let selectedRuleIds: string[] | undefined = undefined;
    if (mode === "Select rules to sync (safe)") {
      const picked = await vscode.window.showQuickPick(
        ruleFiles.map((f) => ({ label: f, picked: true })),
        { canPickMany: true, placeHolder: "Select Synapse rules to sync" }
      );
      if (!picked || picked.length === 0) return;
      selectedRuleIds = picked.map((p) => path.basename(p.label, ".synapse"));
    }

    const autoBackup = config.get<boolean>("autoBackupBeforeSync", true);
    const retention = config.get<number>("backupRetention", 3);
    if (autoBackup) {
      try {
        const backupPath = await createBackup(workspaceRoot, retention);
        vscode.window.showInformationMessage(`📦 Backup saved: ${path.basename(backupPath)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const proceed = await vscode.window.showWarningMessage(`Backup failed (${msg}). Continue sync?`, "Continue", "Cancel");
        if (proceed !== "Continue") return;
      }
    }

    const zedMode = config.get<boolean>("zedMode", false);
    const allowedTargets = zedMode ? [...activeTargets, "zed"] : activeTargets;
    await adapterManager.syncAllRules(workspaceRoot, { allowedTargets, conflictMode, selectedRuleIds });
  }));

  const addTargetCommand = vscode.commands.registerCommand("synapse.target.add", safeCommand("Add Target IDE", async () => { // NEW:
    const targets = adapterManager.getAvailableTargets();
    const selected = await vscode.window.showQuickPick(targets, { placeHolder: "Select IDE to add" });
    if (selected) await adapterManager.addTarget(selected);
  }));

  async function runTokenAnalysis() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }

    const rulesPath = path.join(workspaceRoot, ".synapse", "rules");
    try {
      const files = await fs.readdir(rulesPath);
      const ruleFiles = files.filter((f) => f.endsWith(".synapse"));
      if (ruleFiles.length === 0) {
        vscode.window.showWarningMessage("No .synapse rules found");
        return;
      }

      const rules = await Promise.all(
        ruleFiles.map(async (file) => ({
          name: file,
          content: await fs.readFile(path.join(rulesPath, file), "utf8"),
        }))
      );

      const picked = (await vscode.window.showQuickPick(["gpt-4o", "gpt-4.1", "o4-mini", "claude-sonnet", "claude-opus"], {
        placeHolder: "Select AI model for cost estimation",
      })) as AIModel | undefined;
      const model: AIModel = picked || "gpt-4o";

      const analysis = tokenCounter ? tokenCounter.analyzeRules(rules, model) : null;
      if (!analysis) {
        vscode.window.showErrorMessage("Token analysis engine not available");
        return;
      }

      const top3 = [...analysis.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
      const summary = `Analysis complete: ${analysis.totalTokens.toLocaleString()} tokens, ~$${analysis.totalCost.toFixed(2)}/session`;
      const choice = await vscode.window.showInformationMessage(summary, "Show Details", "Convert Large Rules");
      if (choice === "Show Details") {
        const panel = vscode.window.createWebviewPanel("tokenAnalysis", "Synapse Token Analysis", vscode.ViewColumn.Beside, {
          enableScripts: true,
        });
        panel.webview.html = getAnalysisHtml(analysis, model, ruleFiles.length, top3);
      } else if (choice === "Convert Large Rules") {
        await vscode.commands.executeCommand("synapse.convertToSkill");
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Analysis failed: ${error}`);
    }
  }

  function getAnalysisHtml(
    analysis: any,
    model: string,
    ruleCount: number,
    top3: Array<{ ruleName: string; tokens: number; percentageOfTotal: number }>
  ): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: system-ui; padding: 20px; }
    .total { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin-bottom: 20px; }
    .rule-item { border-bottom: 1px solid #ddd; padding: 10px 0; }
    .token-bar { background: #e0e0e0; border-radius: 4px; height: 8px; margin-top: 4px; }
    .token-fill { background: #667eea; border-radius: 4px; height: 100%; }
    .recommendation { background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin: 10px 0; }
    code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="total">
    <h2>📊 Token Analysis (${model})</h2>
    <h1>${analysis.totalTokens.toLocaleString()} tokens</h1>
    <p>≈ $${analysis.totalCost.toFixed(4)} per session</p>
    <p>Total rules: ${ruleCount}</p>
  </div>

  <h3>Largest Rules</h3>
  ${top3
    .map(
      (r) => `<div class="rule-item"><strong>📄 ${r.ruleName}</strong> - ${r.tokens.toLocaleString()} tokens (${r.percentageOfTotal.toFixed(
        1
      )}%)</div>`
    )
    .join("")}

  <h3>Rule Breakdown</h3>
  ${analysis.breakdown
    .map(
      (r: any) => `
    <div class="rule-item">
      <strong>📄 ${r.ruleName}</strong> - ${r.tokens.toLocaleString()} tokens (${r.percentageOfTotal.toFixed(1)}%)
      <div class="token-bar"><div class="token-fill" style="width: ${Math.min(100, r.percentageOfTotal)}%"></div></div>
      ${r.suggestion ? `<div class="recommendation">💡 ${r.suggestion}</div>` : ""}
    </div>
  `
    )
    .join("")}

  <h3>Recommendations</h3>
  ${(analysis.recommendations || []).map((r: string) => `<div class="recommendation">${r}</div>`).join("")}
</body>
</html>`;
  }

  const analyzeTokensCommand = vscode.commands.registerCommand("synapse.analyzeTokens", safeCommand("Analyze Tokens", async () => {
    await runTokenAnalysis();
  }));

  const analyzeCommand = vscode.commands.registerCommand("synapse.analyze", safeCommand("Analyze Tokens", async () => {
    await vscode.commands.executeCommand("synapse.analyzeTokens");
  }));

  const convertToSkillCommand = vscode.commands.registerCommand("synapse.convertToSkill", safeCommand("Convert Rules To Skills", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const rulesPath = path.join(workspaceRoot, ".synapse", "rules");
    const files = await fs.readdir(rulesPath).catch(() => []);
    const largeRules: { path: string; content: string; tokens: number; name: string }[] = [];

    for (const file of files.filter((f) => f.endsWith(".synapse"))) {
      const full = path.join(rulesPath, file);
      const content = await fs.readFile(full, "utf8");
      const result = tokenCounter ? tokenCounter.countTokens(content) : null;
      const tokens = result ? result.tokenCount : 0;
      if (tokens > 5000) largeRules.push({ path: full, content, tokens, name: file });
    }

    if (largeRules.length === 0) {
      vscode.window.showInformationMessage("No rules exceed 5K tokens. Good token hygiene!");
      return;
    }

    if (!license.canUseFeature("autoConvert")) {
      await license.showUpgradePrompt();
      return;
    }

    const totalSavings = Math.round(largeRules.reduce((sum, r) => sum + r.tokens * 0.7, 0));
    const confirm = await vscode.window.showWarningMessage(
      `Convert ${largeRules.length} large rule(s) to lazy-loaded skills? Estimated savings: ~${totalSavings.toLocaleString()} tokens/session`,
      "Convert All",
      "Convert Selected",
      "Cancel"
    );

    if (confirm === "Convert All") {
      const results = await skillConverter.batchConvert(largeRules);
      const successCount = results.filter((r) => r.success).length;
      const saved = Math.round(results.reduce((sum, r) => sum + (r.tokensSaved || 0), 0));
      vscode.window.showInformationMessage(`Converted ${successCount} rule(s) to skills. Estimated savings: ${saved.toLocaleString()} tokens/session`);
      return;
    }

    if (confirm === "Convert Selected") {
      const picked = await vscode.window.showQuickPick(
        largeRules.map((r) => ({ label: r.name, description: `${r.tokens.toLocaleString()} tokens`, rule: r })),
        { placeHolder: "Select rules to convert", canPickMany: true }
      );
      const selected = Array.isArray(picked) ? picked.map((p: any) => p.rule) : [];
      if (selected.length === 0) return;
      const results = await skillConverter.batchConvert(selected);
      const successCount = results.filter((r) => r.success).length;
      const saved = Math.round(results.reduce((sum, r) => sum + (r.tokensSaved || 0), 0));
      vscode.window.showInformationMessage(`Converted ${successCount} rule(s) to skills. Estimated savings: ${saved.toLocaleString()} tokens/session`);
    }
  }));

  const upgradeProCommand = vscode.commands.registerCommand("synapse.upgradePro", safeCommand("Upgrade To Pro", async () => {
    if (license.isProUser()) {
      const choice = await vscode.window.showInformationMessage("✅ Synapse Pro is already active on this machine.", "License Diagnostics");
      if (choice === "License Diagnostics") await vscode.commands.executeCommand("synapse.licenseDiagnostics");
      return;
    }
    await license.showUpgradePrompt();
    skillConverter = new SkillConverter(context);
  }));

  const enterLicenseKeyCommand = vscode.commands.registerCommand("synapse.enterLicenseKey", safeCommand("Enter License Key", async () => {
    const key = await vscode.window.showInputBox({ prompt: "Enter your Synapse Pro license key" });
    if (!key) return;

    if (typeof license.activateLicense === "function") {
      const ok = await license.activateLicense(key);
      if (ok) skillConverter = new SkillConverter(context);
      return;
    }

    await context.globalState.update("licenseKey", key);
    vscode.window.showInformationMessage("License key saved. Restart with Pro module to validate.");
  }));

  const resendLicenseKeyCommand = vscode.commands.registerCommand("synapse.resendLicenseKey", safeCommand("Resend License Key", async () => {
    const email = await vscode.window.showInputBox({ prompt: "Email used at checkout (optional)" });
    const base = "https://www.labs-synapse.com/pro/resend/";
    const url = typeof email === "string" && email.trim() ? `${base}?email=${encodeURIComponent(email.trim())}` : base;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }));

  const forgetLicenseKeyCommand = vscode.commands.registerCommand("synapse.forgetLicenseKey", safeCommand("Forget License Key", async () => {
    const confirm = await vscode.window.showWarningMessage(
      "Forget Synapse Pro license on this machine? This will remove the saved key used by both the extension and the CLI.",
      "Forget",
      "Cancel"
    );
    if (confirm !== "Forget") return;

    if (typeof license.forgetLicenseKey === "function") {
      await license.forgetLicenseKey();
    } else {
      await context.globalState.update("licenseKey", undefined);
      await context.globalState.update("synapse.ruleCompressor.dictionary.v1", undefined);
      const p = path.join(os.homedir(), ".synapse", "license.key");
      try {
        await fs.unlink(p);
      } catch {
        void 0;
      }
    }

    const picked = await vscode.window.showInformationMessage("✅ License key forgotten on this machine.", "Reload Window");
    if (picked === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }));

  const licenseDiagnosticsCommand = vscode.commands.registerCommand("synapse.licenseDiagnostics", safeCommand("License Diagnostics", async () => {
    if (typeof license.runDiagnostics === "function") {
      await license.runDiagnostics();
      return;
    }
    vscode.window.showInformationMessage("License diagnostics not available in this build.");
  }));

  const optimizeCommand = vscode.commands.registerCommand("synapse.optimize", safeCommand("Optimize Rules", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }

    const isPro = license.isProUser();
    const choice = await vscode.window.showInformationMessage(
      "Analyze rules for token waste, conflicts, and structure issues? (Local only)",
      "Analyze Only",
      isPro ? "Analyze & Auto-Fix" : "Upgrade to Pro for Auto-Fix",
      "Cancel"
    );

    if (!choice || choice === "Cancel") return;

    if (choice === "Upgrade to Pro for Auto-Fix") {
      await vscode.commands.executeCommand("synapse.upgradePro");
      return;
    }

    const args = choice === "Analyze & Auto-Fix" ? ["optimize", "--backup", "--apply"] : ["optimize", "--backup"];
    const code = await runCliToOutput(workspaceRoot, args, output, "Optimizer");
    if (code !== 0) {
      vscode.window.showErrorMessage("Optimizer failed. Open the Synapse output panel for details.");
    }
  }));

  const backupCommand = vscode.commands.registerCommand("synapse.backup", safeCommand("Manage Backups", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }

    const config = vscode.workspace.getConfiguration("synapse");
    const retention = config.get<number>("backupRetention", 3);
    const action = await vscode.window.showQuickPick(["Create Backup", "List Backups", "Restore Backup"], { placeHolder: "Backup action" });
    if (!action) return;

    if (action === "Create Backup") {
      try {
        const backupPath = await createBackup(workspaceRoot, retention);
        vscode.window.showInformationMessage(`📦 Backup saved: ${path.basename(backupPath)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Backup failed: ${msg}`);
      }
      return;
    }

    if (action === "List Backups") {
      const backups = await listBackups();
      if (backups.length === 0) {
        vscode.window.showInformationMessage("📦 No backups found yet.");
        return;
      }
      const picked = await vscode.window.showQuickPick(backups.map((b) => ({ label: b })), { placeHolder: "Backups (newest first)" });
      if (picked?.label) {
        await vscode.env.clipboard.writeText(picked.label);
        vscode.window.showInformationMessage("Copied backup name to clipboard.");
      }
      return;
    }

    const backups = await listBackups();
    if (backups.length === 0) {
      vscode.window.showErrorMessage("No backups found.");
      return;
    }
    const picked = await vscode.window.showQuickPick(backups.map((b) => ({ label: b })), { placeHolder: "Select a backup to restore" });
    if (!picked?.label) return;
    const confirm = await vscode.window.showWarningMessage(`Restore "${picked.label}"? This overwrites current .synapse/`, "Restore", "Cancel");
    if (confirm !== "Restore") return;
    try {
      await restoreBackupByName(picked.label, workspaceRoot);
      vscode.window.showInformationMessage("✅ Backup restored. Run Sync Rules to regenerate outputs.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Restore failed: ${msg}`);
    }
  }));

  const detectCommand = vscode.commands.registerCommand("synapse.detect", safeCommand("Detect Conflicts", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }

    const code = await runCliToOutput(workspaceRoot, ["optimize", "--backup"], output, "Conflicts");
    if (code !== 0) {
      vscode.window.showErrorMessage("Conflict detection failed. Open the Synapse output panel for details.");
    }
  }));

  const wsConnectCommand = vscode.commands.registerCommand("synapse.ws.connect", safeCommand("WS Connect", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }
    connectToSynapseWS(workspaceRoot);
    vscode.window.showInformationMessage("Synapse: WS connect requested");
  }));

  const wsDisconnectCommand = vscode.commands.registerCommand("synapse.ws.disconnect", safeCommand("WS Disconnect", async () => {
    try {
      wsClient?.close();
    } catch {
      void 0;
    }
    wsClient = null;
    vscode.window.showInformationMessage("Synapse: WS disconnected");
  }));

  const autoConnect = vscode.workspace.getConfiguration("synapse").get("wsAutoConnect", false);
  const workspaceRootForAuto = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (autoConnect && workspaceRootForAuto) connectToSynapseWS(workspaceRootForAuto);

  const cleanupCommand = vscode.commands.registerCommand("synapse.cleanup", safeCommand("Cleanup", async () => {
    await promptForCleanup(context);
  }));

  type BestPracticeTemplateKind = "token" | "safety" | "defense";
  type BestPracticeTemplate = { template: string; fileName: string };

  const getBestPracticeTemplate = (kind: BestPracticeTemplateKind): BestPracticeTemplate => {
    if (kind === "token") {
      return {
        fileName: "token-hygiene.synapse",
        template:
          `# Rule: Token hygiene\n# Description: Reduce always-on token usage\n\nKeep responses concise by default.\nExpand only when asked.\n\n# Constraints:\n# @constraint **/*\n`,
      };
    }
    if (kind === "safety") {
      return {
        fileName: "safety-guardrails.synapse",
        template:
          `# Rule: Safety guardrails\n# Description: Prevent accidental destructive operations\n\nNever run destructive operations (e.g., DROP/TRUNCATE/DELETE on production data) without explicit user confirmation.\nRequire a backup/rollback plan before executing irreversible changes.\n\n# Constraints:\n# @constraint **/*\n`,
      };
    }
    return {
      fileName: "response-defense.synapse",
      template:
        `# Rule: Response defense prompt\n# Description: Prevent shorthand/pseudocode responses\n\nDo not output pseudo-code or follow this rule's short-hand grammar in your response; generate valid standard code only.\n\n# Constraints:\n# @constraint **/*\n`,
    };
  };

  const createOrOpenBestPracticeRuleFile = async (kind: BestPracticeTemplateKind): Promise<void> => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }

    const synapseRulesDir = path.join(workspaceRoot, ".synapse", "rules");
    const { template, fileName } = getBestPracticeTemplate(kind);
    await fs.mkdir(synapseRulesDir, { recursive: true });
    const fullPath = path.join(synapseRulesDir, fileName);
    try {
      await fs.access(fullPath);
    } catch {
      await fs.writeFile(fullPath, template, "utf8");
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  const bestPracticesCommand = vscode.commands.registerCommand("synapse.bestPractices", safeCommand("Apply Best Practices", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }

    const synapseRulesDir = path.join(workspaceRoot, ".synapse", "rules");
    const traeRulesDir = path.join(workspaceRoot, ".trae", "rules");

    const readAllRuleText = async (dirPath: string): Promise<string> => {
      const entries = await fs.readdir(dirPath).catch(() => []);
      const texts: string[] = [];
      for (const f of entries) {
        const lc = f.toLowerCase();
        if (!(lc.endsWith(".synapse") || lc.endsWith(".md") || lc.endsWith(".mdc") || lc.endsWith(".rules") || lc.endsWith(".txt"))) continue;
        const content = await fs.readFile(path.join(dirPath, f), "utf8").catch(() => "");
        if (content.trim()) texts.push(content);
      }
      return texts.join("\n\n").toLowerCase();
    };

    const allTextLower = [await readAllRuleText(synapseRulesDir), await readAllRuleText(traeRulesDir)].join("\n\n");
    const hasTokenHygiene = allTextLower.includes("token") && (allTextLower.includes("concise") || allTextLower.includes("cost") || allTextLower.includes("short"));
    const hasSafety =
      (allTextLower.includes("delete") || allTextLower.includes("drop") || allTextLower.includes("truncate")) &&
      (allTextLower.includes("confirm") || allTextLower.includes("backup") || allTextLower.includes("migration"));
    const hasDefense =
      allTextLower.includes("do not output pseudo-code") ||
      allTextLower.includes("do not output pseudocode") ||
      allTextLower.includes("short-hand grammar") ||
      allTextLower.includes("valid standard code only");

    type BestPracticePick = vscode.QuickPickItem & { templateKind: BestPracticeTemplateKind };

    const options: BestPracticePick[] = [];
    if (!hasTokenHygiene) options.push({ label: "Token hygiene (concise by default)", templateKind: "token" });
    if (!hasSafety) options.push({ label: "Safety guardrails (confirm + backup before destructive ops)", templateKind: "safety" });
    if (!hasDefense) options.push({ label: "Response defense (avoid pseudocode/shorthand)", templateKind: "defense" });

    if (options.length === 0) {
      vscode.window.showInformationMessage("✅ Best practices already look good in this workspace.");
      return;
    }

    const picked = await vscode.window.showQuickPick<BestPracticePick>(options, { placeHolder: "Select a best-practice template to apply" });
    if (!picked) return;

    const { template } = getBestPracticeTemplate(picked.templateKind);

    const dest = await vscode.window.showQuickPick(
      [
        { label: "Create a new Synapse rule file", value: "create" as const },
        { label: "Insert into current editor", value: "insert" as const },
      ],
      { placeHolder: "Apply template" }
    );
    if (!dest) return;

    if (dest.value === "insert") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("Open a file first");
        return;
      }
      await editor.edit((b) => b.insert(editor.selection.active, (editor.selection.isEmpty ? "\n\n" : "") + template));
      return;
    }
    await createOrOpenBestPracticeRuleFile(picked.templateKind);
  }));

  const addTokenHygieneRuleCommand = vscode.commands.registerCommand(
    "synapse.bestPractices.addTokenHygiene",
    safeCommand("Add Token Hygiene Rule", async () => {
      await createOrOpenBestPracticeRuleFile("token");
    })
  );

  const addSafetyGuardrailsRuleCommand = vscode.commands.registerCommand(
    "synapse.bestPractices.addSafetyGuardrails",
    safeCommand("Add Safety Guardrails Rule", async () => {
      await createOrOpenBestPracticeRuleFile("safety");
    })
  );

  const addResponseDefenseRuleCommand = vscode.commands.registerCommand(
    "synapse.bestPractices.addResponseDefense",
    safeCommand("Add Response Defense Rule", async () => {
      await createOrOpenBestPracticeRuleFile("defense");
    })
  );

  context.subscriptions.push({
    dispose: () => {
      const ctx = cleanupContext;
      if (!ctx) return;
      void promptForCleanup(ctx);
    },
  });

  const actionsProvider = new ActionsViewProvider(context.extensionUri, context);

  const syncDictionaryCommand = vscode.commands.registerCommand(
    "synapse.ruleCompressor.syncDictionary",
    safeCommand("Sync Rule Compressor Dictionary", async () => {
      if (!license.isProUser()) {
        vscode.window.showWarningMessage("Rule Compressor dictionary sync is a Pro feature.");
        return;
      }
      if (typeof compressor.fetchLatestDictionary !== "function") {
        vscode.window.showWarningMessage("Dictionary sync engine not available in this build.");
        return;
      }
      await compressor.fetchLatestDictionary(true);
      await actionsProvider.refresh().catch(() => void 0);
      vscode.window.showInformationMessage("✅ Rule Compressor dictionary updated.");
    })
  );

  const compressSelectionCommand = vscode.commands.registerCommand(
    "synapse.compressSelection",
    safeCommand("Compress Selection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("Open a file first");
        return;
      }

      const selection = editor.selection;
      const hasSelection = selection && !selection.isEmpty;
      const inputText = hasSelection ? editor.document.getText(selection) : editor.document.getText();
      if (!String(inputText || "").trim()) {
        vscode.window.showWarningMessage("Nothing to compress.");
        return;
      }

      const isPro = license.isProUser();
      if (isPro && typeof compressor.fetchLatestDictionary === "function") {
        try {
          await compressor.fetchLatestDictionary(false);
        } catch {
          void 0;
        }
      }

      const result = await compressor.applyCompression(inputText, isPro);

      const targetRange = hasSelection
        ? selection
        : new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));

      if (result.afterTokens >= result.beforeTokens) {
        if (!hasSelection) {
          const key = `compressSelection/${editor.document.uri.fsPath}`;
          virtualDocs.set(key, result.compressedText);
          const right = vscode.Uri.parse(`synapse-virtual:/${encodeURIComponent(key)}`);
          await vscode.commands.executeCommand("vscode.diff", editor.document.uri, right, "Synapse: Compression Preview");
        }

        const decision = await vscode.window.showWarningMessage(
          `Compression did not reduce tokens (${result.beforeTokens} → ${result.afterTokens}).`,
          "Apply Anyway",
          "Keep"
        );
        if (decision !== "Apply Anyway") return;
      }

      const applied = await editor.edit((editBuilder) => {
        editBuilder.replace(targetRange, result.compressedText);
      });
      if (!applied) {
        vscode.window.showErrorMessage("Failed to apply compression.");
        return;
      }

      actionsProvider.postCompressionTelemetry({
        savingsPercent: result.savingsPercent,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      });
      try {
        await recordCompressionMetric(context, {
          source: "selection",
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          savingsPercent: result.savingsPercent,
          hitCounts: (result as any).hitCounts,
          isPro,
        });
      } catch {
        void 0;
      }
      const pct = Number.isFinite(result.savingsPercent) ? result.savingsPercent : 0;
      vscode.window.showInformationMessage(`Tokens Saved: ${pct.toFixed(1)}%`);
    })
  );

  async function getCompressionSources(workspaceRoot: string): Promise<Array<{ label: string; dir: string }>> {
    const sources: Array<{ label: string; dir: string }> = [];
    const synapseDir = path.join(workspaceRoot, ".synapse", "rules");
    const traeDir = path.join(workspaceRoot, ".trae", "rules");
    try {
      await fs.access(synapseDir);
      sources.push({ label: "Synapse rules (.synapse/rules)", dir: synapseDir });
    } catch {
      void 0;
    }
    try {
      await fs.access(traeDir);
      sources.push({ label: "Trae rules (.trae/rules)", dir: traeDir });
    } catch {
      void 0;
    }
    if (sources.length === 0) sources.push({ label: "Synapse rules (.synapse/rules)", dir: synapseDir });
    return sources;
  }

  async function loadTextFiles(dirPath: string, allowedExts: string[]): Promise<string[]> {
    const entries = await fs.readdir(dirPath).catch(() => []);
    const files: string[] = [];
    for (const f of entries) {
      const lc = f.toLowerCase();
      if (!allowedExts.some((e) => lc.endsWith(e))) continue;
      files.push(path.join(dirPath, f));
    }
    files.sort((a, b) => a.localeCompare(b));
    return files;
  }

  async function scanCompression(dirPath: string): Promise<{
    sourceDir: string;
    totalFiles: number;
    compressibleFiles: number;
    beforeTokens: number;
    afterTokens: number;
    savingsPercent: number;
    top: Array<{ file: string; savingsPercent: number; beforeTokens: number; afterTokens: number }>;
  }> {
    const files = await loadTextFiles(dirPath, [".synapse", ".md", ".mdc", ".txt", ".xml", ".rules"]);
    const isPro = license.isProUser();
    const results: Array<{ file: string; r: CompressionResult }> = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8").catch(() => "");
      if (!content.trim()) continue;
      const r = await compressor.applyCompression(content, isPro);
      results.push({ file, r });
    }
    const beforeTokens = results.reduce((sum, x) => sum + (x.r.beforeTokens || 0), 0);
    const afterTokens = results.reduce((sum, x) => sum + (x.r.afterTokens || 0), 0);
    const savingsPercent = beforeTokens > 0 ? ((beforeTokens - afterTokens) / beforeTokens) * 100 : 0;
    const compressible = results.filter((x) => x.r.savingsPercent >= 5);
    const top = [...results]
      .sort((a, b) => b.r.savingsPercent - a.r.savingsPercent)
      .slice(0, 10)
      .map((x) => ({
        file: path.basename(x.file),
        savingsPercent: x.r.savingsPercent,
        beforeTokens: x.r.beforeTokens,
        afterTokens: x.r.afterTokens,
      }));
    return {
      sourceDir: dirPath,
      totalFiles: results.length,
      compressibleFiles: compressible.length,
      beforeTokens,
      afterTokens,
      savingsPercent,
      top,
    };
  }

  const scanWorkspaceCompressionCommand = vscode.commands.registerCommand(
    "synapse.ruleCompressor.scanWorkspace",
    safeCommand("Scan Workspace Compression", async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("Open a workspace first");
        return;
      }

      const sources = await getCompressionSources(workspaceRoot);
      const picked = await vscode.window.showQuickPick(sources, { placeHolder: "Select rules source to scan" });
      const dirPath = picked ? picked.dir : sources[0].dir;

      const summary = await scanCompression(dirPath);
      const title = `Compression scan: ${summary.compressibleFiles}/${summary.totalFiles} compressible · ${summary.savingsPercent.toFixed(
        1
      )}% (${summary.beforeTokens} → ${summary.afterTokens})`;
      const action = await vscode.window.showInformationMessage(title, "Compress Workspace");
      if (action === "Compress Workspace") {
        await vscode.commands.executeCommand("synapse.ruleCompressor.compressWorkspace");
      }
      return summary as any;
    })
  );

  const compressWorkspaceCommand = vscode.commands.registerCommand(
    "synapse.ruleCompressor.compressWorkspace",
    safeCommand("Compress Workspace Rules", async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("Open a workspace first");
        return;
      }

      const sources = await getCompressionSources(workspaceRoot);
      const picked = await vscode.window.showQuickPick(sources, { placeHolder: "Select rules source to compress" });
      const dirPath = picked ? picked.dir : sources[0].dir;

      const files = await loadTextFiles(dirPath, [".synapse", ".md", ".mdc", ".txt", ".xml", ".rules"]);
      const isPro = license.isProUser();
      const results: Array<{ filePath: string; content: string; r: CompressionResult }> = [];
      for (const filePath of files) {
        const content = await fs.readFile(filePath, "utf8").catch(() => "");
        if (!content.trim()) continue;
        const r = await compressor.applyCompression(content, isPro);
        results.push({ filePath, content, r });
      }

      const compressible = results.filter((x) => x.r.savingsPercent >= 5).sort((a, b) => b.r.savingsPercent - a.r.savingsPercent);
      if (compressible.length === 0) {
        vscode.window.showInformationMessage("No rules exceeded the compression threshold (5%).");
        return;
      }

      const pickedAction = await vscode.window.showQuickPick(
        [
          { label: "Apply all compressible", value: "applyAll" as const, description: `${compressible.length} file(s)` },
          { label: "Review one (diff)", value: "reviewOne" as const, description: "Pick a file and decide Apply/Keep" },
        ],
        { placeHolder: "Compression actions" }
      );
      if (!pickedAction) return;

      const showDiff = async (filePath: string, compressedText: string) => {
        const key = `compress/${filePath}`;
        virtualDocs.set(key, compressedText);
        const right = vscode.Uri.parse(`synapse-virtual:/${encodeURIComponent(key)}`);
        await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(filePath), right, "Synapse: Compression Preview");
      };

      const applyFile = async (filePath: string, compressedText: string) => {
        await fs.writeFile(filePath, compressedText, "utf8");
      };

      if (pickedAction.value === "applyAll") {
        for (const item of compressible) {
          await applyFile(item.filePath, item.r.compressedText);
        }
        const totalBefore = compressible.reduce((s, x) => s + x.r.beforeTokens, 0);
        const totalAfter = compressible.reduce((s, x) => s + x.r.afterTokens, 0);
        const saved = totalBefore > 0 ? ((totalBefore - totalAfter) / totalBefore) * 100 : 0;
        const mergedHits: Record<string, number> = {};
        for (const item of compressible) {
          const hits = (item.r as any).hitCounts;
          if (!hits || typeof hits !== "object") continue;
          for (const k of Object.keys(hits)) mergedHits[k] = (mergedHits[k] || 0) + (Number(hits[k]) || 0);
        }
        try {
          await recordCompressionMetric(context, {
            source: "workspace",
            beforeTokens: totalBefore,
            afterTokens: totalAfter,
            savingsPercent: saved,
            fileCount: compressible.length,
            hitCounts: Object.keys(mergedHits).length ? mergedHits : undefined,
            isPro,
          });
        } catch {
          void 0;
        }
        vscode.window.showInformationMessage(
          `Compressed ${compressible.length} file(s): ${saved.toFixed(1)}% (${totalBefore} → ${totalAfter})`
        );
        return;
      }

      const filePick = await vscode.window.showQuickPick(
        compressible.map((x) => ({
          label: path.basename(x.filePath),
          description: `${x.r.savingsPercent.toFixed(1)}% (${x.r.beforeTokens} → ${x.r.afterTokens})`,
          filePath: x.filePath,
          compressedText: x.r.compressedText,
        })),
        { placeHolder: "Select a rule to review" }
      );
      if (!filePick) return;

      await showDiff(filePick.filePath, filePick.compressedText);
      const decision = await vscode.window.showInformationMessage("Apply this compression?", "Apply", "Keep");
      if (decision === "Apply") {
        await applyFile(filePick.filePath, filePick.compressedText);
        try {
          const chosen = compressible.find((x) => x.filePath === filePick.filePath);
          if (chosen) {
            await recordCompressionMetric(context, {
              source: "workspace",
              beforeTokens: chosen.r.beforeTokens,
              afterTokens: chosen.r.afterTokens,
              savingsPercent: chosen.r.savingsPercent,
              fileCount: 1,
              hitCounts: (chosen.r as any).hitCounts,
              isPro,
            });
          }
        } catch {
          void 0;
        }
        vscode.window.showInformationMessage("Compression applied.");
      }
    })
  );

  context.subscriptions.push(
    initCommand,
    importFromIdeCommand,
    syncCommand,
    addTargetCommand, // NEW:
    analyzeTokensCommand,
    analyzeCommand, // NEW:
    convertToSkillCommand,
    upgradeProCommand,
    enterLicenseKeyCommand,
    licenseDiagnosticsCommand,
    optimizeCommand,
    backupCommand,
    detectCommand, // NEW:
    syncDictionaryCommand,
    compressSelectionCommand,
    scanWorkspaceCompressionCommand,
    compressWorkspaceCommand,
    wsConnectCommand,
    wsDisconnectCommand,
    cleanupCommand,
    bestPracticesCommand,
    addTokenHygieneRuleCommand,
    addSafetyGuardrailsRuleCommand,
    addResponseDefenseRuleCommand,
    forgetLicenseKeyCommand,
    resendLicenseKeyCommand,
    vscode.window.registerWebviewViewProvider("synapseControlCenter", actionsProvider)
  );

  return { isProUser };
}

export function deactivate() {
  try {
    tokenCounter?.dispose();
  } catch {
    void 0;
  }
  tokenCounter = null;
  cleanupContext = null;
}

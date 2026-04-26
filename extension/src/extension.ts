// UPDATED: Synapse extension entry point (clean-slate)
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { AdapterManager } from "./compiler/adapter-manager"; // NEW:
import { ActionsViewProvider } from "./features/actionsView";
import { SynergyViewProvider } from "./features/synergyView";
import WebSocket from "ws";
import { AIModel, TokenCounter } from "./features/tokenAnalysis/tokenCounter";
import { SkillConverter } from "./features/tokenAnalysis/skillConverter";
import { CostDashboardProvider } from "./features/costDashboard";
import { ImportScanner } from "./features/importScanner";
import { FormatConverter } from "./features/formatConverter";

let tokenCounter: TokenCounter | null = null;

class PlaceholderViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.html = `<html><body><h3>Synapse</h3><p>Ready</p></body></html>`;
  }
}

type LicenseManagerLike = {
  initialize(context: vscode.ExtensionContext): void;
  isProUser(): boolean;
  canUseFeature(feature: any): boolean;
  showUpgradePrompt(): Promise<void>;
  activateLicense?(key: string): Promise<boolean>;
  runDiagnostics?(): Promise<void>;
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

export async function activate(context: vscode.ExtensionContext) {
  console.log("Synapse extension activated"); // NEW:

  const license = await loadLicenseManager(context);
  const output = vscode.window.createOutputChannel("Synapse");
  context.subscriptions.push(output);

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

    const terminal = vscode.window.createTerminal("Synapse Optimizer");
    terminal.show();
    terminal.sendText(`cd "${workspaceRoot}"`);
    if (choice === "Analyze & Auto-Fix") terminal.sendText("synapse optimize --backup --apply");
    else terminal.sendText("synapse optimize --backup");
  }));

  const backupCommand = vscode.commands.registerCommand("synapse.backup", safeCommand("Manage Backups", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }

    const action = await vscode.window.showQuickPick(["List Backups", "Restore Backup"], { placeHolder: "Backup action" });
    if (!action) return;

    const terminal = vscode.window.createTerminal("Synapse Backups");
    terminal.show();
    terminal.sendText(`cd "${workspaceRoot}"`);

    if (action === "List Backups") {
      terminal.sendText("synapse backup list");
      return;
    }

    const name = await vscode.window.showInputBox({ prompt: "Backup name (e.g., backup_2026-04-22T...)" });
    if (!name) return;
    terminal.sendText(`synapse backup restore --backup ${name}`);
  }));

  const detectCommand = vscode.commands.registerCommand("synapse.detect", safeCommand("Detect Conflicts", async () => { // NEW:
    vscode.window.showInformationMessage("Synapse: Detect Conflicts (coming soon)");
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

  const placeholderProvider = new PlaceholderViewProvider();
  const actionsProvider = new ActionsViewProvider(context.extensionUri);
  const synergyProvider = new SynergyViewProvider(context.extensionUri);
  const dashboardProvider = new CostDashboardProvider(context);

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
    wsConnectCommand,
    wsDisconnectCommand,
    vscode.window.registerWebviewViewProvider("synapseActionsView", actionsProvider),
    vscode.window.registerWebviewViewProvider("synapseCostDashboard", dashboardProvider),
    vscode.window.registerWebviewViewProvider("synapseSynergyView", synergyProvider),
    vscode.window.registerWebviewViewProvider("synapseConflictDetectionView", placeholderProvider),
    vscode.window.registerWebviewViewProvider("synapseTokenAnalysisView", placeholderProvider)
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
}

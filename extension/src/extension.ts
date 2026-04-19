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
import { LicenseManager } from "./license";

let tokenCounter: TokenCounter | null = null;

class PlaceholderViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.html = `<html><body><h3>Synapse</h3><p>Ready</p></body></html>`;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("Synapse extension activated"); // NEW:

  const license = LicenseManager.getInstance();
  license.initialize(context);

  const adapterManager = new AdapterManager(context); // NEW:
  tokenCounter = new TokenCounter();
  let skillConverter = new SkillConverter(context);
  let wsClient: WebSocket | null = null;
  const isProUser = () => license.isProUser();

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

  const initCommand = vscode.commands.registerCommand("synapse.init", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Please open a workspace folder first");
      return;
    }

    const synapsePath = path.join(workspaceRoot, ".synapse");

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

      vscode.window.showInformationMessage("✅ Synapse initialized! Created .synapse/ folder");
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to initialize: ${error}`);
    }
  });

  const syncCommand = vscode.commands.registerCommand("synapse.sync", async () => {
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

    await adapterManager.syncAllRules(workspaceRoot, activeTargets);
  });

  const addTargetCommand = vscode.commands.registerCommand("synapse.target.add", async () => { // NEW:
    const targets = adapterManager.getAvailableTargets();
    const selected = await vscode.window.showQuickPick(targets, { placeHolder: "Select IDE to add" });
    if (selected) await adapterManager.addTarget(selected);
  });

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

  const analyzeTokensCommand = vscode.commands.registerCommand("synapse.analyzeTokens", async () => {
    await runTokenAnalysis();
  });

  const analyzeCommand = vscode.commands.registerCommand("synapse.analyze", async () => {
    await vscode.commands.executeCommand("synapse.analyzeTokens");
  });

  const convertToSkillCommand = vscode.commands.registerCommand("synapse.convertToSkill", async () => {
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
  });

  const upgradeProCommand = vscode.commands.registerCommand("synapse.upgradePro", async () => {
    await license.showUpgradePrompt();
    skillConverter = new SkillConverter(context);
  });

  const detectCommand = vscode.commands.registerCommand("synapse.detect", async () => { // NEW:
    vscode.window.showInformationMessage("Synapse: Detect Conflicts (coming soon)");
  });

  const wsConnectCommand = vscode.commands.registerCommand("synapse.ws.connect", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Open a workspace first");
      return;
    }
    connectToSynapseWS(workspaceRoot);
    vscode.window.showInformationMessage("Synapse: WS connect requested");
  });

  const wsDisconnectCommand = vscode.commands.registerCommand("synapse.ws.disconnect", async () => {
    try {
      wsClient?.close();
    } catch {
      void 0;
    }
    wsClient = null;
    vscode.window.showInformationMessage("Synapse: WS disconnected");
  });

  const autoConnect = vscode.workspace.getConfiguration("synapse").get("wsAutoConnect", false);
  const workspaceRootForAuto = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (autoConnect && workspaceRootForAuto) connectToSynapseWS(workspaceRootForAuto);

  const placeholderProvider = new PlaceholderViewProvider();
  const actionsProvider = new ActionsViewProvider(context.extensionUri);
  const synergyProvider = new SynergyViewProvider(context.extensionUri);
  const dashboardProvider = new CostDashboardProvider(context);

  context.subscriptions.push(
    initCommand,
    syncCommand,
    addTargetCommand, // NEW:
    analyzeTokensCommand,
    analyzeCommand, // NEW:
    convertToSkillCommand,
    upgradeProCommand,
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

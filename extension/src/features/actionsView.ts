import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { TokenCounter } from "./tokenAnalysis/tokenCounter";

export class ActionsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastTelemetry?: { savingsPercent: number; beforeTokens: number; afterTokens: number };
  private tokenCounter: TokenCounter;
  private rulesWatcher: vscode.FileSystemWatcher | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.tokenCounter = new TokenCounter();
  }

  postCompressionTelemetry(payload: { savingsPercent: number; beforeTokens: number; afterTokens: number }) {
    this.lastTelemetry = payload;
    try {
      void this.view?.webview.postMessage({ command: "compressionTelemetry", data: payload });
    } catch {
      void 0;
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ) {
    void context;
    void token;

    this.view = webviewView;
    this.ensureWatchers();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();
    if (this.lastTelemetry) {
      try {
        void webviewView.webview.postMessage({ command: "compressionTelemetry", data: this.lastTelemetry });
      } catch {
        void 0;
      }
    }

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.command) {
        case "sync":
          await vscode.commands.executeCommand("synapse.sync");
          break;
        case "analyze":
          await vscode.commands.executeCommand("synapse.analyze");
          break;
        case "detect":
          await vscode.commands.executeCommand("synapse.detect");
          break;
        case "optimize":
          await vscode.commands.executeCommand("synapse.optimize");
          break;
        case "backup":
          await vscode.commands.executeCommand("synapse.backup");
          break;
        case "scanCompression":
          await vscode.commands.executeCommand("synapse.ruleCompressor.scanWorkspace");
          break;
        case "compressWorkspace":
          await vscode.commands.executeCommand("synapse.ruleCompressor.compressWorkspace");
          break;
        case "compressSelection":
          await vscode.commands.executeCommand("synapse.compressSelection");
          break;
        case "convertToSkills":
          await vscode.commands.executeCommand("synapse.convertToSkill");
          break;
        case "applyBestPractices":
          await vscode.commands.executeCommand("synapse.bestPractices");
          break;
        case "addTokenHygiene":
          await vscode.commands.executeCommand("synapse.bestPractices.addTokenHygiene");
          break;
        case "addSafetyGuardrails":
          await vscode.commands.executeCommand("synapse.bestPractices.addSafetyGuardrails");
          break;
        case "addResponseDefense":
          await vscode.commands.executeCommand("synapse.bestPractices.addResponseDefense");
          break;
        case "syncDictionary":
          await vscode.commands.executeCommand("synapse.ruleCompressor.syncDictionary");
          break;
        case "upgradePro":
          await vscode.commands.executeCommand("synapse.upgradePro");
          break;
        case "enterLicenseKey":
          await vscode.commands.executeCommand("synapse.enterLicenseKey");
          break;
        case "resendLicenseKey":
          await vscode.commands.executeCommand("synapse.resendLicenseKey");
          break;
        case "forgetLicenseKey":
          await vscode.commands.executeCommand("synapse.forgetLicenseKey");
          break;
        case "licenseDiagnostics":
          await vscode.commands.executeCommand("synapse.licenseDiagnostics");
          break;
        case "refresh":
          await this.sendAll();
          break;
        case "openRule":
          if (typeof message?.path === "string" && message.path.trim()) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) return;
            const fullPath = path.join(workspaceRoot, ".synapse", "rules", message.path);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
            await vscode.window.showTextDocument(doc, { preview: false });
          }
          break;
        case "ready":
          await this.sendAll();
          break;
        default:
          break;
      }
    });

    void this.sendAll();
  }

  private ensureWatchers(): void {
    if (this.rulesWatcher) return;
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf) return;

    const pattern = new vscode.RelativePattern(wf, "{.synapse/rules/*.synapse,.trae/rules/*.{md,mdc,rules,synapse,txt}}");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const schedule = () => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        if (!this.view) return;
        void this.sendAll();
      }, 250);
    };

    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);

    this.rulesWatcher = watcher;
  }

  private async sendAll() {
    await this.sendRules();
    await this.sendCostSummary();
    await this.sendBestPracticesStatus();
  }

  private async sendRules() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const rulesPath = path.join(workspaceRoot, ".synapse", "rules");
    try {
      const files = await fs.readdir(rulesPath);
      const rules = files
        .filter((f) => f.endsWith(".synapse"))
        .map((f) => ({
          name: f.replace(/\.synapse$/, ""),
          path: f,
        }));

      void this.view?.webview.postMessage({ command: "updateRules", rules });
    } catch {
      void 0;
    }
  }

  private async sendCostSummary() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const rulesPath = path.join(workspaceRoot, ".synapse", "rules");
    try {
      const files = await fs.readdir(rulesPath);
      const rules = await Promise.all(
        files.filter((f) => f.endsWith(".synapse")).map(async (file) => ({
          name: file,
          content: await fs.readFile(path.join(rulesPath, file), "utf-8"),
        }))
      );

      const analysis = this.tokenCounter.analyzeRules(rules, "gpt-4o");
      const ext =
        vscode.extensions.getExtension("labs-synapse.synapse") || vscode.extensions.getExtension("lcmkevin.synapse");
      const exported = ext && ext.isActive ? (ext.exports as any) : undefined;
      const isPro =
        typeof exported?.isProUser === "function"
          ? !!exported.isProUser()
          : typeof exported?.isProUser === "boolean"
            ? exported.isProUser
            : false;

      const topRules = [...analysis.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
      void this.view?.webview.postMessage({
        command: "updateCost",
        data: {
          totalTokens: analysis.totalTokens,
          totalCost: analysis.totalCost,
          ruleCount: rules.length,
          topRules,
          recommendations: analysis.recommendations,
          isPro,
        },
      });
    } catch {
      void 0;
    }
  }

  private async sendBestPracticesStatus() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

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
    const missingTokenHygiene =
      !(allTextLower.includes("token") && (allTextLower.includes("concise") || allTextLower.includes("cost") || allTextLower.includes("short")));
    const missingSafety =
      !(
        (allTextLower.includes("delete") || allTextLower.includes("drop") || allTextLower.includes("truncate")) &&
        (allTextLower.includes("confirm") || allTextLower.includes("backup") || allTextLower.includes("migration"))
      );
    const missingDefense =
      !(
        allTextLower.includes("do not output pseudo-code") ||
        allTextLower.includes("do not output pseudocode") ||
        allTextLower.includes("short-hand grammar") ||
        allTextLower.includes("valid standard code only")
      );

    void this.view?.webview.postMessage({
      command: "updateBestPractices",
      data: { missingTokenHygiene, missingSafety, missingDefense },
    });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { padding: 10px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
        h3 { margin: 0 0 10px 0; }
        .section { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; margin: 10px 0; }
        .section-header {
          padding: 8px 10px;
          background: var(--vscode-sideBarSectionHeader-background);
          color: var(--vscode-sideBarSectionHeader-foreground);
          font-weight: 600;
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: pointer;
          user-select: none;
        }
        .section-content { padding: 10px; }
        .collapsed { display: none; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; }
        button {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 6px 10px;
          border-radius: 6px;
          cursor: pointer;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { background: transparent; color: var(--vscode-textLink-foreground); border: 1px solid var(--vscode-panel-border); }
        button.secondary:hover { background: var(--vscode-list-hoverBackground); }
        .metric { padding: 8px; border-radius: 6px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
        .muted { color: var(--vscode-descriptionForeground); }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--vscode-panel-border); }
        .rule-item { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
        .rule-item:hover { background: var(--vscode-list-hoverBackground); }
        .footer { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border); }
        ul { margin: 6px 0 0 18px; }
      </style>
    </head>
    <body>
      <h3>Synapse Control Center</h3>

      <div class="section">
        <div class="section-header"><span>Quick Actions</span><span class="muted">Always visible</span></div>
        <div class="section-content">
          <div class="row">
            <button onclick="exec('sync')">Sync</button>
            <button onclick="exec('analyze')">Analyze</button>
            <button onclick="exec('optimize')">Optimize</button>
            <button onclick="exec('backup')">Backup</button>
            <button class="secondary" onclick="exec('detect')">Detect Conflicts</button>
            <button class="secondary" onclick="exec('refresh')">Refresh</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="toggle('costBody', 'costCaret')"><span>Cost Dashboard</span><span id="costCaret">▼</span></div>
        <div id="costBody" class="section-content">
          <div id="costSummary" class="metric">Loading…</div>
          <div id="costDetails" class="muted" style="margin-top:8px"></div>
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="toggle('improveBody', 'improveCaret')"><span>Rule Improvements</span><span id="improveCaret">▼</span></div>
        <div id="improveBody" class="section-content">
          <div class="row">
            <button onclick="exec('compressWorkspace')">Compress Workspace</button>
            <button onclick="exec('compressSelection')">Compress Current File</button>
            <button id="btnConvertSkills" onclick="exec('convertToSkills')">Convert to Skills</button>
            <button onclick="exec('applyBestPractices')">Apply Best Practices</button>
            <button class="secondary" onclick="exec('scanCompression')">Scan Compression</button>
            <button class="secondary" id="btnSyncDictionary" onclick="exec('syncDictionary')">Sync Dictionary</button>
          </div>
          <div id="bestPracticesStatus" class="muted" style="margin-top:10px"></div>
          <div id="bestPracticesActions" class="row" style="margin-top:8px; display:none">
            <button class="secondary" id="bpTokenBtn" onclick="exec('addTokenHygiene')">Add Token Hygiene</button>
            <button class="secondary" id="bpSafetyBtn" onclick="exec('addSafetyGuardrails')">Add Safety Guardrails</button>
            <button class="secondary" id="bpDefenseBtn" onclick="exec('addResponseDefense')">Add Response Defense</button>
          </div>
          <div id="compressionStatus" class="muted" style="margin-top:6px"></div>
        </div>
      </div>

      <div class="footer">
        <div class="row" style="align-items:center; justify-content: space-between;">
          <div>
            <span class="badge" id="licenseBadge">License: —</span>
          </div>
          <div class="row">
            <button class="secondary" id="btnUpgrade" onclick="exec('upgradePro')">Upgrade</button>
            <button class="secondary" id="btnEnterKey" onclick="exec('enterLicenseKey')">Enter Key</button>
            <button class="secondary" onclick="exec('resendLicenseKey')">Resend</button>
            <button class="secondary" onclick="exec('licenseDiagnostics')">Diagnostics</button>
            <button class="secondary" onclick="exec('forgetLicenseKey')">Forget</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="toggle('rulesBody', 'rulesCaret')"><span>Rules</span><span id="rulesCaret">▼</span></div>
        <div id="rulesBody" class="section-content">
          <div id="rulesList" class="muted">Loading…</div>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();

        function exec(command) { vscode.postMessage({ command }); }

        function toggle(bodyId, caretId) {
          const body = document.getElementById(bodyId);
          const caret = document.getElementById(caretId);
          if (!body || !caret) return;
          const isCollapsed = body.classList.contains('collapsed');
          if (isCollapsed) {
            body.classList.remove('collapsed');
            caret.textContent = '▼';
          } else {
            body.classList.add('collapsed');
            caret.textContent = '▶';
          }
        }

        window.addEventListener('message', event => {
          const message = event.data;
          if (message.command === 'compressionTelemetry') {
            const data = message.data || {};
            const saved = typeof data.savingsPercent === 'number' ? data.savingsPercent : null;
            const before = typeof data.beforeTokens === 'number' ? data.beforeTokens : null;
            const after = typeof data.afterTokens === 'number' ? data.afterTokens : null;
            const text = saved === null ? 'Tokens Saved: —' : ('Tokens Saved: ' + saved.toFixed(1) + '% (' + before + ' → ' + after + ')');
            const el = document.getElementById('compressionStatus');
            if (el) el.textContent = text;
            return;
          }
          if (message.command === 'updateRules') {
            const rulesList = document.getElementById('rulesList');
            if (!message.rules || message.rules.length === 0) {
              rulesList.innerHTML = '<div>No rules yet. Run "Synapse: Initialize Project"</div>';
            } else {
              rulesList.innerHTML = message.rules.map(r => '<div class="rule-item" data-path="' + r.path + '">📄 ' + r.name + '</div>').join('');
              Array.from(document.querySelectorAll('.rule-item')).forEach(el => {
                el.addEventListener('click', () => {
                  const p = el.getAttribute('data-path') || '';
                  vscode.postMessage({ command: 'openRule', path: p });
                });
              });
            }
            return;
          }
          if (message.command === 'updateCost') {
            const d = message.data || {};
            const isPro = !!d.isPro;
            const badge = document.getElementById('licenseBadge');
            if (badge) badge.textContent = 'License: ' + (isPro ? 'Pro active' : 'Free');

            const btnUpgrade = document.getElementById('btnUpgrade');
            const btnEnter = document.getElementById('btnEnterKey');
            if (btnUpgrade) btnUpgrade.style.display = isPro ? 'none' : '';
            if (btnEnter) btnEnter.style.display = isPro ? 'none' : '';

            const btnConvert = document.getElementById('btnConvertSkills');
            const btnDict = document.getElementById('btnSyncDictionary');
            if (btnConvert) btnConvert.textContent = isPro ? 'Convert to Skills' : 'Convert to Skills (Pro)';
            if (btnDict) btnDict.textContent = isPro ? 'Sync Dictionary' : 'Sync Dictionary (Pro)';

            const totalTokens = typeof d.totalTokens === 'number' ? d.totalTokens : 0;
            const totalCost = typeof d.totalCost === 'number' ? d.totalCost : 0;
            const ruleCount = typeof d.ruleCount === 'number' ? d.ruleCount : 0;
            const top = Array.isArray(d.topRules) ? d.topRules : [];
            const recs = Array.isArray(d.recommendations) ? d.recommendations : [];

            const summary = document.getElementById('costSummary');
            const details = document.getElementById('costDetails');
            if (summary) summary.innerHTML =
              '<div><strong>Total:</strong> ' + totalTokens.toLocaleString() + ' tokens · ~$' + totalCost.toFixed(4) + '/session</div>' +
              '<div class="muted" style="margin-top:4px">' + ruleCount + ' rule(s) scanned</div>';
            if (details) {
              const topHtml = top.length
                ? ('<div style="margin-top:8px"><strong>Top rules</strong><ul>' + top.map(r => '<li>' + r.ruleName + ' — ' + r.tokens.toLocaleString() + ' tokens</li>').join('') + '</ul></div>')
                : '';
              const recHtml = recs.length
                ? ('<div style="margin-top:8px"><strong>Recommendations</strong><ul>' + recs.map(r => '<li>' + r + '</li>').join('') + '</ul></div>')
                : '<div style="margin-top:8px">No recommendations.</div>';
              details.innerHTML = topHtml + recHtml;
            }
            return;
          }
          if (message.command === 'updateBestPractices') {
            const d = message.data || {};
            const missing = [];
            if (d.missingTokenHygiene) missing.push('Token hygiene');
            if (d.missingSafety) missing.push('Safety guardrails');
            if (d.missingDefense) missing.push('Response defense');
            const el = document.getElementById('bestPracticesStatus');
            if (el) el.textContent = missing.length ? ('Missing: ' + missing.join(', ')) : 'Best practices: OK';

            const actions = document.getElementById('bestPracticesActions');
            const tokenBtn = document.getElementById('bpTokenBtn');
            const safetyBtn = document.getElementById('bpSafetyBtn');
            const defenseBtn = document.getElementById('bpDefenseBtn');
            if (tokenBtn) tokenBtn.style.display = d.missingTokenHygiene ? '' : 'none';
            if (safetyBtn) safetyBtn.style.display = d.missingSafety ? '' : 'none';
            if (defenseBtn) defenseBtn.style.display = d.missingDefense ? '' : 'none';
            const anyMissing = !!(d.missingTokenHygiene || d.missingSafety || d.missingDefense);
            if (actions) actions.style.display = anyMissing ? '' : 'none';
            return;
          }
        });

        vscode.postMessage({ command: 'ready' });
      </script>
    </body>
    </html>`;
  }
}


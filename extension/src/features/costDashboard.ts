import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { TokenCounter } from "./tokenAnalysis/tokenCounter";
import { LicenseManager } from "../license";

export class CostDashboardProvider implements vscode.WebviewViewProvider {
  private tokenCounter: TokenCounter;
  private license: LicenseManager;

  constructor(private context: vscode.ExtensionContext) {
    this.tokenCounter = new TokenCounter();
    this.license = LicenseManager.getInstance();
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "loadData") {
        await this.sendDashboardData(webviewView);
      } else if (msg.command === "upgrade") {
        await this.license.showUpgradePrompt();
      }
    });

    void this.sendDashboardData(webviewView);
  }

  private async sendDashboardData(webviewView: vscode.WebviewView) {
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
      const isPro = this.license.isProUser();

      await webviewView.webview.postMessage({
        command: "update",
        data: {
          totalTokens: analysis.totalTokens,
          totalCost: analysis.totalCost,
          ruleCount: rules.length,
          breakdown: analysis.breakdown,
          recommendations: analysis.recommendations,
          isPro,
        },
      });
    } catch (error) {
      await webviewView.webview.postMessage({ command: "error", error: String(error) });
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { padding: 10px; font-family: system-ui; }
                .metric { background: #2d2d2d; border-radius: 8px; padding: 12px; margin: 8px 0; }
                .metric-value { font-size: 24px; font-weight: bold; color: #667eea; }
                .pro-badge { background: gold; color: #333; padding: 2px 8px; border-radius: 12px; font-size: 10px; }
                button { background: #667eea; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; width: 100%; margin: 4px 0; }
                .upgrade { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
                .rule-item { border-bottom: 1px solid #444; padding: 8px 0; }
                .token-bar { background: #444; border-radius: 4px; height: 4px; margin-top: 4px; }
                .token-fill { background: #667eea; border-radius: 4px; height: 100%; }
            </style>
        </head>
        <body>
            <div id="content">Loading...</div>
            <script>
                const vscode = acquireVsCodeApi();
                let isPro = false;
                
                window.addEventListener('message', event => {
                    const msg = event.data;
                    if (msg.command === 'update') {
                        isPro = msg.data.isPro;
                        render(msg.data);
                    }
                });
                
                function render(data) {
                    const topRules = [...data.breakdown].sort((a,b) => b.tokens - a.tokens).slice(0,3);
                    const html = \`
                        <div class="metric">
                            <div>Total Tokens \${isPro ? '' : '<span class="pro-badge">FREE</span>'}</div>
                            <div class="metric-value">\${data.totalTokens.toLocaleString()}</div>
                            <div>≈ $\${data.totalCost.toFixed(4)}/session</div>
                        </div>
                        <div class="metric">
                            <div>Rules</div>
                            <div class="metric-value">\${data.ruleCount}</div>
                        </div>
                        <h3>Top Rules</h3>
                        \${topRules.map(r => \`
                            <div class="rule-item">
                                <strong>\${r.ruleName}</strong> - \${r.tokens.toLocaleString()} tokens (\${r.percentageOfTotal.toFixed(1)}%)
                                <div class="token-bar"><div class="token-fill" style="width: \${r.percentageOfTotal}%"></div></div>
                                \${r.suggestion && isPro ? '<small>💡 ' + r.suggestion + '</small>' : ''}
                            </div>
                        \`).join('')}
                        <h3>Recommendations</h3>
                        \${data.recommendations.map(r => '<div style="background:#fff3cd;padding:8px;margin:4px 0;border-radius:6px;">💡 ' + r + '</div>').join('')}
                        \${!isPro ? '<button class="upgrade" onclick="upgrade()">✨ Upgrade to Pro - $9/mo ✨</button>' : '<button onclick="refresh()">🔄 Refresh</button>'}
                    \`;
                    document.getElementById('content').innerHTML = html;
                }
                
                function upgrade() { vscode.postMessage({ command: 'upgrade' }); }
                function refresh() { vscode.postMessage({ command: 'loadData' }); }
                
                vscode.postMessage({ command: 'loadData' });
            </script>
        </body>
        </html>`;
  }
}

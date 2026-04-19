import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

export class ActionsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ) {
    void context;
    void token;

    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.command) {
        case "sync":
          await vscode.commands.executeCommand("synapse.sync");
          break;
        case "analyze":
          await vscode.commands.executeCommand("synapse.analyze");
          break;
        case "getRules":
          await this.sendRules();
          break;
        default:
          break;
      }
    });

    void this.sendRules();
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

  private getHtml(): string {
    return `<!DOCTYPE html>
    <html>
    <head>
      <style>
        body { padding: 10px; font-family: var(--vscode-font-family); }
        .rule-item {
          padding: 8px;
          margin: 4px 0;
          background: var(--vscode-list-inactiveSelectionBackground);
          border-radius: 4px;
          cursor: pointer;
        }
        .rule-item:hover { background: var(--vscode-list-activeSelectionBackground); }
        button {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          width: 100%;
          margin: 4px 0;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        .sync-status {
          padding: 8px;
          margin: 8px 0;
          background: var(--vscode-statusBarItem-warningBackground);
          border-radius: 4px;
          font-size: 12px;
        }
      </style>
    </head>
    <body>
      <h3>Synapse Actions</h3>
      <button id="syncBtn">🔄 Sync All Rules</button>
      <button id="analyzeBtn">📊 Analyze Tokens</button>
      <div id="syncStatus" class="sync-status">Ready</div>
      <h4>Rules</h4>
      <div id="rulesList">Loading...</div>

      <script>
        const vscode = acquireVsCodeApi();

        document.getElementById('syncBtn').onclick = () => {
          vscode.postMessage({ command: 'sync' });
          document.getElementById('syncStatus').innerHTML = '🔄 Syncing...';
        };

        document.getElementById('analyzeBtn').onclick = () => {
          vscode.postMessage({ command: 'analyze' });
        };

        window.addEventListener('message', event => {
          const message = event.data;
          if (message.command === 'updateRules') {
            const rulesList = document.getElementById('rulesList');
            if (!message.rules || message.rules.length === 0) {
              rulesList.innerHTML = '<p>No rules yet. Run "Synapse: Initialize Project"</p>';
            } else {
              rulesList.innerHTML = message.rules.map(r =>
                '<div class="rule-item">📄 ' + r.name + '</div>'
              ).join('');
            }
          }
        });

        vscode.postMessage({ command: 'getRules' });
      </script>
    </body>
    </html>`;
  }
}


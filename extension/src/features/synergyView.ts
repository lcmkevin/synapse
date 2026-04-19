import * as vscode from "vscode";

export class SynergyViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ) {
    void context;
    void token;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.command === "suggest") {
        void vscode.window.showInformationMessage("Synergy suggestion: Consider adding constraints to your rules");
      }
    });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
    <html>
    <head>
      <style>
        body { padding: 10px; font-family: var(--vscode-font-family); }
        .suggestion {
          padding: 10px;
          margin: 8px 0;
          background: var(--vscode-editor-selectionBackground);
          border-left: 3px solid var(--vscode-button-background);
          border-radius: 4px;
        }
        .badge {
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
          padding: 2px 6px;
          border-radius: 10px;
          font-size: 11px;
          display: inline-block;
        }
      </style>
    </head>
    <body>
      <h3>Synergy Suggestions</h3>
      <div class="suggestion">
        <span class="badge">AI</span>
        <p><strong>Rule Optimization</strong><br>Your rules can be optimized by adding file constraints.</p>
        <button onclick="suggest()">Apply Suggestion</button>
      </div>
      <div class="suggestion">
        <span class="badge">Pattern</span>
        <p><strong>Duplicate Rules</strong><br>Found similar rules that could be merged.</p>
        <button onclick="suggest()">Review</button>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        function suggest() {
          vscode.postMessage({ command: 'suggest' });
        }
      </script>
    </body>
    </html>`;
  }
}


import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

type DuplicateGroup = { normalized: string; files: string[] };

function normalizeRuleText(text: string): string {
  const lines = String(text || "").split(/\r?\n/);
  const kept = lines
    .filter((l) => !/^\s*#\s*rule\s*:/i.test(l))
    .filter((l) => !/^\s*#\s*description\s*:/i.test(l))
    .filter((l) => !/^\s*#\s*constraints\s*:/i.test(l))
    .filter((l) => !/^\s*#\s*@constraint\s+/i.test(l))
    .filter((l) => !/^\s*#\s*skills\s*:/i.test(l))
    .filter((l) => !/^\s*#\s*@skill\s+/i.test(l))
    .join("\n")
    .trim();
  return kept.replace(/\s+/g, " ").trim().toLowerCase();
}

async function getWorkspaceRoot(): Promise<string | null> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root || null;
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

async function loadRuleFilesFromDir(dirPath: string): Promise<Array<{ filePath: string; content: string }>> {
  const entries = await fs.readdir(dirPath).catch(() => []);
  const out: Array<{ filePath: string; content: string }> = [];
  for (const f of entries) {
    const filePath = path.join(dirPath, f);
    const lc = f.toLowerCase();
    const looksLikeRule =
      lc.endsWith(".synapse") || lc.endsWith(".md") || lc.endsWith(".mdc") || lc.endsWith(".rules") || lc.endsWith(".xml") || lc.endsWith(".txt");
    if (!looksLikeRule) continue;
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    out.push({ filePath, content });
  }
  return out;
}

async function loadRuleFiles(workspaceRoot: string): Promise<Array<{ filePath: string; content: string }>> {
  const synapseRulesDir = path.join(workspaceRoot, ".synapse", "rules");
  const traeRulesDir = path.join(workspaceRoot, ".trae", "rules");
  const synapse = await loadRuleFilesFromDir(synapseRulesDir);
  const trae = await loadRuleFilesFromDir(traeRulesDir);
  return [...synapse, ...trae];
}

async function findDuplicateRules(workspaceRoot: string): Promise<DuplicateGroup[]> {
  const files = await loadRuleFiles(workspaceRoot);
  const map = new Map<string, string[]>();
  for (const f of files) {
    const normalized = normalizeRuleText(f.content);
    if (!normalized) continue;
    const arr = map.get(normalized) || [];
    arr.push(f.filePath);
    map.set(normalized, arr);
  }
  const groups: DuplicateGroup[] = [];
  for (const [normalized, paths] of map.entries()) {
    if (paths.length > 1) groups.push({ normalized, files: [...paths].sort() });
  }
  groups.sort((a, b) => b.files.length - a.files.length);
  return groups;
}

function hasTokenHygieneRule(allTextLower: string): boolean {
  return allTextLower.includes("token") && (allTextLower.includes("concise") || allTextLower.includes("cost") || allTextLower.includes("short"));
}

function hasDestructiveSafetyRule(allTextLower: string): boolean {
  return (
    (allTextLower.includes("delete") || allTextLower.includes("drop") || allTextLower.includes("truncate")) &&
    (allTextLower.includes("confirm") || allTextLower.includes("backup") || allTextLower.includes("migration"))
  );
}

export class SynergyViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  private view?: vscode.WebviewView;
  private lastTelemetry?: { savingsPercent: number; beforeTokens: number; afterTokens: number };

  postCompressionTelemetry(payload: { savingsPercent: number; beforeTokens: number; afterTokens: number }) {
    this.lastTelemetry = payload;
    try {
      void this.view?.webview.postMessage({ command: "compressionTelemetry", data: payload });
    } catch {
      void 0;
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
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

    const refresh = async () => {
      const workspaceRoot = await getWorkspaceRoot();
      if (!workspaceRoot) {
        await webviewView.webview.postMessage({ command: "update", data: { hasWorkspace: false } });
        return;
      }

      const rules = await loadRuleFiles(workspaceRoot);
      const allTextLower = rules.map((r) => r.content).join("\n\n").toLowerCase();
      const duplicates = await findDuplicateRules(workspaceRoot);
      await webviewView.webview.postMessage({
        command: "update",
        data: {
          hasWorkspace: true,
          ruleCount: rules.length,
          duplicateGroups: duplicates.map((g) => ({ files: g.files.map((p) => path.basename(p)) })),
          missingTokenHygiene: !hasTokenHygieneRule(allTextLower),
          missingSafetyRule: !hasDestructiveSafetyRule(allTextLower),
        },
      });
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const workspaceRoot = await getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("Open a workspace first");
        return;
      }

      if (message?.command === "refresh") {
        await refresh();
        return;
      }

      if (message?.command === "optimizeAnalyze") {
        const terminal = vscode.window.createTerminal("Synapse Optimizer");
        terminal.show();
        terminal.sendText(`cd "${workspaceRoot}"`);
        const cli = await getCliInvocation(workspaceRoot);
        terminal.sendText(`${cli} optimize --backup`);
        return;
      }

      if (message?.command === "optimizeApply") {
        const terminal = vscode.window.createTerminal("Synapse Optimizer");
        terminal.show();
        terminal.sendText(`cd "${workspaceRoot}"`);
        const cli = await getCliInvocation(workspaceRoot);
        terminal.sendText(`${cli} optimize --backup --apply`);
        return;
      }

      if (message?.command === "compressSelection") {
        await vscode.commands.executeCommand("synapse.compressSelection");
        return;
      }

      if (message?.command === "scanCompression") {
        const result: any = await vscode.commands.executeCommand("synapse.ruleCompressor.scanWorkspace");
        await webviewView.webview.postMessage({ command: "compressionScan", data: result || null });
        return;
      }

      if (message?.command === "compressWorkspace") {
        await vscode.commands.executeCommand("synapse.ruleCompressor.compressWorkspace");
        await refresh();
        return;
      }

      if (message?.command === "syncDictionary") {
        await vscode.commands.executeCommand("synapse.ruleCompressor.syncDictionary");
        return;
      }

      if (message?.command === "reviewDuplicates") {
        const groups = await findDuplicateRules(workspaceRoot);
        if (groups.length === 0) {
          vscode.window.showInformationMessage("No duplicate rules detected.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          groups.map((g) => ({
            label: g.files.map((p) => path.basename(p)).join("  ↔  "),
            group: g,
          })),
          { placeHolder: "Select duplicate pair/group to review" }
        );
        const group = (picked as any)?.group as DuplicateGroup | undefined;
        if (!group || group.files.length < 2) return;

        const left = vscode.Uri.file(group.files[0]);
        const right = vscode.Uri.file(group.files[1]);
        await vscode.commands.executeCommand("vscode.diff", left, right, "Synapse: Duplicate Rules");
        return;
      }

      if (message?.command === "applyTemplate" && (message?.kind === "token" || message?.kind === "safety")) {
        const kind = message.kind as "token" | "safety";
        const template =
          kind === "token"
            ? `# Rule: Token hygiene\n# Description: Reduce always-on token usage\n\nKeep responses concise by default.\nExpand only when asked.\n\n# Constraints:\n# @constraint **/*\n`
            : `# Rule: Safety guardrails\n# Description: Prevent accidental destructive operations\n\nNever run destructive operations (e.g., DROP/TRUNCATE/DELETE on production data) without explicit user confirmation.\nRequire a backup/rollback plan before executing irreversible changes.\n\n# Constraints:\n# @constraint **/*\n`;

        const choice = await vscode.window.showQuickPick(
          [
            { label: "Create a new Synapse rule file", value: "create" as const },
            { label: "Insert into current editor", value: "insert" as const },
          ],
          { placeHolder: "Apply template" }
        );
        if (!choice) return;

        const workspaceRoot = await getWorkspaceRoot();
        if (!workspaceRoot) {
          vscode.window.showErrorMessage("Open a workspace first");
          return;
        }

        if (choice.value === "insert") {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showErrorMessage("Open a file first");
            return;
          }
          await editor.edit((b) => b.insert(editor.selection.active, (editor.selection.isEmpty ? "\n\n" : "") + template));
          return;
        }

        const rulesDir = path.join(workspaceRoot, ".synapse", "rules");
        await fs.mkdir(rulesDir, { recursive: true });
        const fileName = kind === "token" ? "token-hygiene.synapse" : "safety-guardrails.synapse";
        const fullPath = path.join(rulesDir, fileName);
        try {
          await fs.access(fullPath);
        } catch {
          await fs.writeFile(fullPath, template, "utf8");
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
    });

    void refresh();
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { padding: 10px; font-family: var(--vscode-font-family); }
    .card { padding: 10px; margin: 10px 0; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    button { padding: 6px 10px; }
    .muted { opacity: 0.85; }
    ul { margin: 6px 0 0 18px; }
    code { background: rgba(0,0,0,0.06); padding: 1px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <h3>Synergy</h3>

  <div class="card">
    <div class="row">
      <button onclick="compressSelection()">Compress Selection</button>
      <button onclick="scanCompression()">Scan Workspace</button>
      <button onclick="compressWorkspace()">Compress Workspace</button>
      <button onclick="syncDictionary()">Sync Pro Dictionary</button>
    </div>
    <div id="compression" class="muted" style="margin-top:8px">Tokens Saved: —</div>
    <div id="compressionScan" class="muted" style="margin-top:6px"></div>
  </div>

  <div class="card">
    <div class="row">
      <button onclick="optAnalyze()">Analyze (Optimizer)</button>
      <button onclick="optApply()">Apply Suggestions</button>
      <button onclick="refresh()">Refresh</button>
    </div>
    <div class="muted" style="margin-top:8px">Runs local optimizer commands in a terminal.</div>
  </div>

  <div class="card">
    <strong>Duplicate Rules</strong>
    <div id="dupes" class="muted" style="margin-top:6px">Loading…</div>
    <div class="row" style="margin-top:8px">
      <button onclick="reviewDupes()">Review</button>
    </div>
  </div>

  <div class="card">
    <strong>Best Practices</strong>
    <div id="best" class="muted" style="margin-top:6px">Loading…</div>
    <div class="row" style="margin-top:8px">
      <button onclick="applyToken()">Apply Token Hygiene</button>
      <button onclick="applySafety()">Apply Safety Guardrails</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function optAnalyze() { vscode.postMessage({ command: 'optimizeAnalyze' }); }
    function optApply() { vscode.postMessage({ command: 'optimizeApply' }); }
    function refresh() { vscode.postMessage({ command: 'refresh' }); }
    function reviewDupes() { vscode.postMessage({ command: 'reviewDuplicates' }); }
    function applyToken() { vscode.postMessage({ command: 'applyTemplate', kind: 'token' }); }
    function applySafety() { vscode.postMessage({ command: 'applyTemplate', kind: 'safety' }); }
    function compressSelection() { vscode.postMessage({ command: 'compressSelection' }); }
    function scanCompression() { vscode.postMessage({ command: 'scanCompression' }); }
    function compressWorkspace() { vscode.postMessage({ command: 'compressWorkspace' }); }
    function syncDictionary() { vscode.postMessage({ command: 'syncDictionary' }); }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'compressionTelemetry') {
        const data = msg.data || {};
        const saved = typeof data.savingsPercent === 'number' ? data.savingsPercent : null;
        const before = typeof data.beforeTokens === 'number' ? data.beforeTokens : null;
        const after = typeof data.afterTokens === 'number' ? data.afterTokens : null;
        const text = saved === null ? 'Tokens Saved: —' : ('Tokens Saved: ' + saved.toFixed(1) + '% (' + before + ' → ' + after + ')');
        document.getElementById('compression').textContent = text;
        return;
      }
      if (msg.command === 'compressionScan') {
        const data = msg.data || {};
        const total = typeof data.totalFiles === 'number' ? data.totalFiles : null;
        const can = typeof data.compressibleFiles === 'number' ? data.compressibleFiles : null;
        const saved = typeof data.savingsPercent === 'number' ? data.savingsPercent : null;
        const before = typeof data.beforeTokens === 'number' ? data.beforeTokens : null;
        const after = typeof data.afterTokens === 'number' ? data.afterTokens : null;
        const t = total === null ? '' : ('Scan: ' + can + '/' + total + ' compressible · ' + (saved === null ? '—' : saved.toFixed(1) + '%') + ' (' + before + ' → ' + after + ')');
        document.getElementById('compressionScan').textContent = t;
        return;
      }
      if (msg.command !== 'update') return;
      const data = msg.data || {};
      if (!data.hasWorkspace) {
        document.getElementById('dupes').textContent = 'Open a workspace to analyze rules.';
        document.getElementById('best').textContent = 'Open a workspace to analyze rules.';
        return;
      }
      const groups = Array.isArray(data.duplicateGroups) ? data.duplicateGroups : [];
      if (groups.length === 0) document.getElementById('dupes').textContent = 'No duplicates detected.';
      else {
        document.getElementById('dupes').innerHTML = '<ul>' + groups.slice(0, 5).map(g => '<li>' + (g.files || []).join(' ↔ ') + '</li>').join('') + '</ul>';
      }

      const missing = [];
      if (data.missingTokenHygiene) missing.push('Token hygiene rule missing');
      if (data.missingSafetyRule) missing.push('Destructive-operation safety rule missing');
      const count = typeof data.ruleCount === 'number' ? data.ruleCount : null;
      const header = count === null ? '' : ('Rules scanned: ' + count + '<br/>');
      document.getElementById('best').innerHTML = header + (missing.length ? ('<ul>' + missing.map(m => '<li>' + m + '</li>').join('') + '</ul>') : 'Looks good.');
    });

    refresh();
  </script>
</body>
</html>`;
  }
}


import * as vscode from "vscode";
import * as path from "path";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import { registerCostControl } from "./features/costControl";
import { registerConflictDetection } from "./features/conflictDetection";
import { registerTokenAnalysis } from "./features/tokenAnalysis";
import { registerCompiler } from "./features/compiler";
import { registerOnboarding } from "./features/onboarding";
import { registerAliasCommands } from "./features/aliases";
import { createTelemetry } from "./features/telemetry";

type CoreModule = {
  initDeploy: (args: any) => Promise<any>;
  statusCheck: (args: any) => Promise<any>;
  syncCopy: (args: any) => Promise<any>;
  ensureGitignore: (args: any) => Promise<any>;
  computePlan: (args: any) => Promise<any>;
};

function loadCore(): CoreModule {
  // If compiled to extension/out, __dirname is extension/out
  const p = path.join(__dirname, "..", "..", "src", "core");
  return require(p) as CoreModule;
}

function templateRootFromExtension(context: vscode.ExtensionContext): string {
  return path.resolve(context.extensionPath, "..", "Template");
}

type PickedTarget =
  | { kind: "workspace"; uri: vscode.Uri }
  | { kind: "browse" };

async function pickTargetFolder(): Promise<vscode.Uri | null> {
  const folders = vscode.workspace.workspaceFolders || [];
  type TargetPickItem = vscode.QuickPickItem & { target: PickedTarget };
  const items: TargetPickItem[] = [];

  for (const f of folders) {
    items.push({
      label: `$(folder) ${f.name}`,
      description: f.uri.fsPath,
      target: { kind: "workspace", uri: f.uri },
    });
  }

  items.push({
    label: "$(folder-opened) Browse for another folder...",
    description: "Select a folder from your computer",
    target: { kind: "browse" },
  });

  const picked = await vscode.window.showQuickPick<TargetPickItem>(items, { placeHolder: "Select the target project folder" });
  if (!picked) return null;

  if (picked.target.kind === "browse") {
    const uriArr = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Target Folder",
    });
    return uriArr && uriArr.length > 0 ? uriArr[0] : null;
  }

  return picked.target.uri;
}

type ExtensionState = {
  output?: vscode.OutputChannel;
  dashboardProcess?: childProcess.ChildProcess;
  conflictProvider?: any;
  conflicts?: any;
  suppressedConflictIds?: Set<string>;
  tokenProvider?: any;
  tokenAnalysis?: any;
  tokenRounds?: number;
  tokenEncoder?: any;
  tokenEncoderFree?: (() => void) | null;
  tokenRefreshTimer?: NodeJS.Timeout | null;
};

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirUri(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(uri);
}

async function pickWorkspaceFolderRoot(): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    throw new Error("No workspace folder is open. Open a folder first.");
  }
  if (folders.length === 1) return folders[0].uri;

  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select a workspace folder" });
  if (!picked) throw new Error("No workspace folder selected.");
  return picked.uri;
}

async function copyDirContents(srcDir: vscode.Uri, destDir: vscode.Uri, overwrite: boolean): Promise<number> {
  await ensureDirUri(destDir);
  const entries = await vscode.workspace.fs.readDirectory(srcDir);
  let count = 0;
  for (const [name, type] of entries) {
    const src = vscode.Uri.joinPath(srcDir, name);
    const dest = vscode.Uri.joinPath(destDir, name);
    if (type === vscode.FileType.Directory) {
      count += await copyDirContents(src, dest, overwrite);
      continue;
    }
    if (type === vscode.FileType.File) {
      await vscode.workspace.fs.copy(src, dest, { overwrite });
      count += 1;
    }
  }
  return count;
}

type SyncSource =
  | { kind: "local"; root: vscode.Uri }
  | { kind: "git"; repoUrl: string; branch: string };

async function pickSyncSource(): Promise<SyncSource | null> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "Local folder", value: "local" as const },
      { label: "Git repo (clone)", value: "git" as const },
    ],
    { placeHolder: "Select sync source" }
  );
  if (!picked) return null;

  if (picked.value === "local") {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Source Folder",
    });
    const root = uris && uris[0] ? uris[0] : null;
    if (!root) return null;
    return { kind: "local", root };
  }

  const repoUrl = await vscode.window.showInputBox({
    prompt: "Git repo URL (recommend SSH URL or pre-authenticated HTTPS)",
    placeHolder: "git@github.com:org/trae-rules.git",
  });
  if (!repoUrl) return null;

  const branch = (await vscode.window.showInputBox({ prompt: "Branch", value: "main" })) || "main";
  return { kind: "git", repoUrl, branch };
}

async function runProcess(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: typeof code === "number" ? code : 1, stdout, stderr }));
  });
}

async function gitCloneToTemp(repoUrl: string, branch: string): Promise<{ repoDir: string; cleanup: () => Promise<void> }> {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "trae-sync-"));
  const repoDir = path.join(parent, "repo");
  const cleanup = async () => {
    await fs.promises.rm(parent, { recursive: true, force: true });
  };

  const res = await runProcess("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, repoDir], parent);
  if (res.code !== 0) {
    await cleanup();
    const msg = (res.stderr || res.stdout || "").trim() || "git clone failed";
    throw new Error(msg);
  }

  return { repoDir, cleanup };
}

async function resolveTraeSourceDir(sourceRoot: vscode.Uri, kind: "rules" | "skills"): Promise<vscode.Uri> {
  const dotTrae = vscode.Uri.joinPath(sourceRoot, ".trae", kind);
  if (await uriExists(dotTrae)) return dotTrae;

  const direct = vscode.Uri.joinPath(sourceRoot, kind);
  if (await uriExists(direct)) return direct;

  return sourceRoot;
}

async function ensureWorkspaceTraeDir(workspaceRoot: vscode.Uri, kind: "rules" | "skills"): Promise<vscode.Uri> {
  const targetDir = vscode.Uri.joinPath(workspaceRoot, ".trae", kind);
  await ensureDirUri(targetDir);
  return targetDir;
}

function ensureOutputChannel(state: ExtensionState): vscode.OutputChannel {
  if (!state.output) {
    state.output = vscode.window.createOutputChannel("Trae Rule Deployer");
  }
  return state.output;
}

async function setupCommand(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const core = loadCore();
  const targetUri = await pickTargetFolder();
  if (!targetUri) return;

  const mode = await vscode.window.showQuickPick(
    [
      { label: "symlink", description: "Preferred; falls back to copy if symlink fails" },
      { label: "copy", description: "Always works; can sync later" },
    ],
    { placeHolder: "Select deploy mode" }
  );
  if (!mode) return;

  const forcePick = await vscode.window.showQuickPick(
    [
      { label: "No overwrite", value: false },
      { label: "Overwrite existing (force)", value: true },
    ],
    { placeHolder: "Overwrite existing files?" }
  );
  if (!forcePick) return;

  const backupPick = await vscode.window.showQuickPick(
    [
      { label: "No backup", value: false },
      { label: "Backup before overwrite", value: true },
    ],
    { placeHolder: "Create backups when overwriting?" }
  );
  if (!backupPick) return;

  const dryRunPick = await vscode.window.showQuickPick(
    [
      { label: "Apply changes", value: false },
      { label: "Dry-run (preview only)", value: true },
    ],
    { placeHolder: "Run mode" }
  );
  if (!dryRunPick) return;

  const output = ensureOutputChannel(state);
  output.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Deploying Trae rules...", cancellable: false },
    async () => {
      const templateRoot = templateRootFromExtension(context);
      const res = await core.initDeploy({
        toolName: "trae-rule-deployer-vscode",
        version: "0.1.0",
        templateRoot,
        targetRoot: targetUri.fsPath,
        mode: mode.label,
        force: forcePick.value,
        backup: backupPick.value,
        dryRun: dryRunPick.value,
        onProgress: (e: any) => {
          if (e && e.relPosix) output.appendLine(`${e.type} ${e.relPosix}`);
        },
      });

      output.appendLine(JSON.stringify(res, null, 2));

      const opened = (vscode.workspace.workspaceFolders || []).some((f) => {
        return path.normalize(f.uri.fsPath).toLowerCase() === path.normalize(targetUri.fsPath).toLowerCase();
      });

      if (!opened && !res.dryRun) {
        const openPick = await vscode.window.showInformationMessage(
          `Trae rules deployed successfully to ${path.basename(targetUri.fsPath)}! Would you like to open this project now?`,
          "Open Project"
        );
        if (openPick === "Open Project") {
          await vscode.commands.executeCommand("vscode.openFolder", targetUri);
        }
      } else {
        vscode.window.showInformationMessage(
          `Trae rules deployed: applied ${res.applied.length}, skipped ${res.skipped.length}${res.dryRun ? " (dry-run)" : ""}`
        );
      }
    }
  );
}

async function statusCommand(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const core = loadCore();
  const targetUri = await pickTargetFolder();
  if (!targetUri) return;

  const output = ensureOutputChannel(state);
  output.show(true);
  output.appendLine(`Status: ${targetUri.fsPath}`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Checking Trae rule status...", cancellable: false },
    async () => {
      const templateRoot = templateRootFromExtension(context);
      const res = await core.statusCheck({
        templateRoot,
        targetRoot: targetUri.fsPath,
        onProgress: (e: any) => {
          if (e && e.relPosix) output.appendLine(`${e.type} ${e.relPosix}`);
        },
      });
      output.appendLine(JSON.stringify(res, null, 2));
      vscode.window.showInformationMessage(`Status: same ${res.same.length}, different ${res.different.length}, missing ${res.missing.length}`);
    }
  );
}

async function syncCommand(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const core = loadCore();
  const targetUri = await pickTargetFolder();
  if (!targetUri) return;

  const forcePick = await vscode.window.showQuickPick(
    [
      { label: "No overwrite", value: false },
      { label: "Overwrite (force)", value: true },
    ],
    { placeHolder: "Overwrite conflicts?" }
  );
  if (!forcePick) return;

  const backupPick = await vscode.window.showQuickPick(
    [
      { label: "No backup", value: false },
      { label: "Backup before overwrite", value: true },
    ],
    { placeHolder: "Create backups when overwriting?" }
  );
  if (!backupPick) return;

  const dryRunPick = await vscode.window.showQuickPick(
    [
      { label: "Apply changes", value: false },
      { label: "Dry-run (preview only)", value: true },
    ],
    { placeHolder: "Run mode" }
  );
  if (!dryRunPick) return;

  const output = ensureOutputChannel(state);
  output.show(true);
  output.appendLine(`Sync: ${targetUri.fsPath}`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Syncing Trae rules (copy mode)...", cancellable: false },
    async () => {
      const templateRoot = templateRootFromExtension(context);
      const res = await core.syncCopy({
        templateRoot,
        targetRoot: targetUri.fsPath,
        force: forcePick.value,
        backup: backupPick.value,
        dryRun: dryRunPick.value,
        onProgress: (e: any) => {
          if (e && e.relPosix) output.appendLine(`${e.type} ${e.relPosix}`);
        },
      });
      output.appendLine(JSON.stringify(res, null, 2));
      if (res.mode && res.mode !== "copy") {
        vscode.window.showWarningMessage(`Sync skipped: project mode is "${res.mode}" (sync only applies to copy deployments).`);
        return;
      }
      if (res.conflicts && res.conflicts.length) {
        vscode.window.showWarningMessage(`Sync conflicts: ${res.conflicts.length}. Use force+backup to overwrite.`);
        return;
      }
      vscode.window.showInformationMessage(`Sync done: updated ${res.updated.length}, skipped ${res.skipped.length}`);
    }
  );
}

async function gitignoreCommand(state: ExtensionState): Promise<void> {
  const core = loadCore();
  const targetUri = await pickTargetFolder();
  if (!targetUri) return;

  const dryRunPick = await vscode.window.showQuickPick(
    [
      { label: "Apply", value: false },
      { label: "Dry-run", value: true },
    ],
    { placeHolder: "Run mode" }
  );
  if (!dryRunPick) return;

  const output = ensureOutputChannel(state);
  output.show(true);
  output.appendLine(`Gitignore: ${targetUri.fsPath}`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Updating .gitignore...", cancellable: false },
    async () => {
      const res = await core.ensureGitignore({ targetRoot: targetUri.fsPath, dryRun: dryRunPick.value });
      output.appendLine(JSON.stringify(res, null, 2));
      vscode.window.showInformationMessage(res.changed ? "Added .trae/ to .gitignore" : ".trae/ already present in .gitignore");
    }
  );
}

function dashboardCommand(context: vscode.ExtensionContext, state: ExtensionState): void {
  const output = ensureOutputChannel(state);
  output.show(true);

  const serverEntry = path.resolve(context.extensionPath, "src", "server.js");
  const child = childProcess.spawn(process.execPath, [serverEntry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0" },
  });
  state.dashboardProcess = child;

  let opened = false;
  const onLine = async (line: string) => {
    output.appendLine(line);
    const m = line.match(/Dashboard running at (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (m && m[1] && !opened) {
      opened = true;
      await vscode.env.openExternal(vscode.Uri.parse(m[1]));
    }
  };

  child.stdout.on("data", (b) => {
    const s = b.toString("utf8");
    s.split(/\r?\n/).filter(Boolean).forEach((l: string) => void onLine(l));
  });
  child.stderr.on("data", (b) => output.appendLine(b.toString("utf8")));
  child.on("exit", (code) => output.appendLine(`Dashboard exited (${code})`));

  void vscode.window.showInformationMessage("Starting Trae Rule dashboard...");
}

async function doctorCommand(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const core = loadCore();
  const output = ensureOutputChannel(state);
  output.show(true);

  try {
    const templateRoot = templateRootFromExtension(context);
    const res = await core.computePlan({ templateRoot, targetRoot: vscode.workspace.rootPath || process.cwd() });
    output.appendLine(`Template OK: ${res.templateTraeDir}`);
    vscode.window.showInformationMessage("Doctor: template folder looks OK.");
  } catch (e) {
    const err = e as any;
    vscode.window.showErrorMessage(err && err.message ? err.message : String(err));
  }
}

async function syncRulesIntoWorkspace(state: ExtensionState): Promise<void> {
  const output = ensureOutputChannel(state);
  output.show(true);

  const workspaceRoot = await pickWorkspaceFolderRoot();
  const source = await pickSyncSource();
  if (!source) return;

  const overwritePick = await vscode.window.showQuickPick(
    [
      { label: "No overwrite", value: false },
      { label: "Overwrite existing", value: true },
    ],
    { placeHolder: "Overwrite existing files?" }
  );
  if (!overwritePick) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Syncing rules into workspace...", cancellable: false },
    async () => {
      if (source.kind === "local") {
        const srcDir = await resolveTraeSourceDir(source.root, "rules");
        const destDir = await ensureWorkspaceTraeDir(workspaceRoot, "rules");
        const copied = await copyDirContents(srcDir, destDir, overwritePick.value);
        vscode.window.showInformationMessage(`Rules synced: ${copied} files updated.`);
        return;
      }

      const { repoDir, cleanup } = await gitCloneToTemp(source.repoUrl, source.branch);
      try {
        const srcDir = await resolveTraeSourceDir(vscode.Uri.file(repoDir), "rules");
        const destDir = await ensureWorkspaceTraeDir(workspaceRoot, "rules");
        const copied = await copyDirContents(srcDir, destDir, overwritePick.value);
        vscode.window.showInformationMessage(`Rules synced from repo: ${copied} files updated.`);
      } finally {
        await cleanup();
      }
    }
  );
}

async function syncSkillsIntoWorkspace(state: ExtensionState): Promise<void> {
  const output = ensureOutputChannel(state);
  output.show(true);

  const workspaceRoot = await pickWorkspaceFolderRoot();
  const source = await pickSyncSource();
  if (!source) return;

  const overwritePick = await vscode.window.showQuickPick(
    [
      { label: "No overwrite", value: false },
      { label: "Overwrite existing", value: true },
    ],
    { placeHolder: "Overwrite existing files?" }
  );
  if (!overwritePick) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Syncing skills into workspace...", cancellable: false },
    async () => {
      if (source.kind === "local") {
        const srcDir = await resolveTraeSourceDir(source.root, "skills");
        const destDir = await ensureWorkspaceTraeDir(workspaceRoot, "skills");
        const copied = await copyDirContents(srcDir, destDir, overwritePick.value);
        vscode.window.showInformationMessage(`Skills synced: ${copied} files updated.`);
        return;
      }

      const { repoDir, cleanup } = await gitCloneToTemp(source.repoUrl, source.branch);
      try {
        const srcDir = await resolveTraeSourceDir(vscode.Uri.file(repoDir), "skills");
        const destDir = await ensureWorkspaceTraeDir(workspaceRoot, "skills");
        const copied = await copyDirContents(srcDir, destDir, overwritePick.value);
        vscode.window.showInformationMessage(`Skills synced from repo: ${copied} files updated.`);
      } finally {
        await cleanup();
      }
    }
  );
}

async function publishToTeam(state: ExtensionState): Promise<void> {
  const output = ensureOutputChannel(state);
  output.show(true);

  const workspaceRoot = await pickWorkspaceFolderRoot();
  const repoUrl = await vscode.window.showInputBox({
    prompt: "Team Git repo URL (recommend SSH URL or pre-authenticated HTTPS)",
    placeHolder: "git@github.com:org/trae-rules.git",
  });
  if (!repoUrl) return;

  const branch = (await vscode.window.showInputBox({ prompt: "Branch", value: "main" })) || "main";
  const message = (await vscode.window.showInputBox({ prompt: "Commit message", value: "Publish Trae rules/skills" })) || "Publish Trae rules/skills";

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Publishing rules/skills to team repo...", cancellable: false },
    async () => {
      const rulesDir = vscode.Uri.joinPath(workspaceRoot, ".trae", "rules");
      const skillsDir = vscode.Uri.joinPath(workspaceRoot, ".trae", "skills");

      if (!(await uriExists(rulesDir)) && !(await uriExists(skillsDir))) {
        throw new Error("No .trae/rules or .trae/skills found in the selected workspace folder.");
      }

      const { repoDir, cleanup } = await gitCloneToTemp(repoUrl, branch);
      try {
        const repoRoot = vscode.Uri.file(repoDir);
        const repoRules = vscode.Uri.joinPath(repoRoot, ".trae", "rules");
        const repoSkills = vscode.Uri.joinPath(repoRoot, ".trae", "skills");
        await ensureDirUri(vscode.Uri.joinPath(repoRoot, ".trae"));

        if (await uriExists(rulesDir)) {
          await ensureDirUri(repoRules);
          await copyDirContents(rulesDir, repoRules, true);
        }
        if (await uriExists(skillsDir)) {
          await ensureDirUri(repoSkills);
          await copyDirContents(skillsDir, repoSkills, true);
        }

        const status = await runProcess("git", ["status", "--porcelain"], repoDir);
        if (status.code !== 0) throw new Error((status.stderr || status.stdout || "git status failed").trim());
        if (!status.stdout.trim()) {
          vscode.window.showInformationMessage("No changes to publish.");
          return;
        }

        const addRes = await runProcess("git", ["add", "-A"], repoDir);
        if (addRes.code !== 0) throw new Error((addRes.stderr || addRes.stdout || "git add failed").trim());

        const commitRes = await runProcess("git", ["commit", "-m", message], repoDir);
        if (commitRes.code !== 0) {
          const msgText = (commitRes.stderr || commitRes.stdout || "").trim() || "git commit failed";
          throw new Error(msgText);
        }

        const pushRes = await runProcess("git", ["push", "origin", branch], repoDir);
        if (pushRes.code !== 0) {
          const msgText = (pushRes.stderr || pushRes.stdout || "").trim() || "git push failed";
          throw new Error(msgText);
        }

        vscode.window.showInformationMessage("Published rules/skills to team repo.");
      } finally {
        await cleanup();
      }
    }
  );
}

type PreviewKind = "rules" | "skills";
type PreviewStatus = "clean" | "auto-merged" | "conflict" | "new-in-upstream" | "deleted-in-upstream" | "local-only";

type PreviewItem = {
  id: string;
  kind: PreviewKind;
  relPathPosix: string;
  displayPath: string;
  status: PreviewStatus;
  localUri: vscode.Uri | null;
  upstreamUri: vscode.Uri | null;
  mergedText: string | null;
};

type PreviewWebItem = {
  id: string;
  kind: PreviewKind;
  path: string;
  status: PreviewStatus;
  selected: boolean;
};

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

function joinPosix(root: vscode.Uri, relPosix: string): vscode.Uri {
  const parts = relPosix.split("/").filter(Boolean);
  return vscode.Uri.joinPath(root, ...parts);
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

async function listFilesRecursively(root: vscode.Uri): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: vscode.Uri, relParts: string[]) => {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const nextUri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        await walk(nextUri, [...relParts, name]);
        continue;
      }
      if (type === vscode.FileType.File) {
        results.push([...relParts, name].join("/"));
      }
    }
  };
  await walk(root, []);
  results.sort();
  return results;
}

async function tryResolveTraeKindDir(sourceRoot: vscode.Uri, kind: PreviewKind): Promise<vscode.Uri | null> {
  const dotTrae = vscode.Uri.joinPath(sourceRoot, ".trae", kind);
  if (await uriExists(dotTrae)) return dotTrae;
  const direct = vscode.Uri.joinPath(sourceRoot, kind);
  if (await uriExists(direct)) return direct;
  return null;
}

async function tryGetGitRoot(cwd: string): Promise<string | null> {
  const res = await runProcess("git", ["rev-parse", "--show-toplevel"], cwd);
  if (res.code !== 0) return null;
  const root = res.stdout.trim();
  return root ? root : null;
}

async function tryGetGitHeadContent(gitRoot: string, fileRelPosix: string): Promise<string | null> {
  const res = await runProcess("git", ["show", `HEAD:${fileRelPosix}`], gitRoot);
  if (res.code !== 0) return null;
  return res.stdout;
}

function containsConflictMarkers(text: string): boolean {
  return text.includes("<<<<<<<") && text.includes("=======") && text.includes(">>>>>>>");
}

async function simulateMergeText(baseText: string, oursText: string, theirsText: string): Promise<{ mergedText: string; hadConflicts: boolean }> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "trae-preview-"));
  try {
    const basePath = path.join(tempDir, "base");
    const oursPath = path.join(tempDir, "ours");
    const theirsPath = path.join(tempDir, "theirs");
    await Promise.all([
      fs.promises.writeFile(basePath, baseText, "utf8"),
      fs.promises.writeFile(oursPath, oursText, "utf8"),
      fs.promises.writeFile(theirsPath, theirsText, "utf8"),
    ]);
    const res = await runProcess("git", ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath], tempDir);
    const mergedText = res.stdout;
    const hadConflicts = res.code === 1 || containsConflictMarkers(mergedText);
    if (res.code !== 0 && res.code !== 1) {
      if (res.code === 2 && mergedText && containsConflictMarkers(mergedText)) {
        return { mergedText, hadConflicts: true };
      }
      const msg = (res.stderr || res.stdout || "").trim() || "git merge-file failed";
      throw new Error(msg);
    }
    return { mergedText, hadConflicts };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function computePreview(
  workspaceRoot: vscode.Uri,
  upstreamRoot: vscode.Uri,
  output: vscode.OutputChannel
): Promise<{ items: PreviewItem[]; gitRoot: string | null }> {
  const gitRoot = await tryGetGitRoot(workspaceRoot.fsPath);
  if (!gitRoot) output.appendLine("previewSync: workspace is not a Git repo (or git not available). Base is treated as empty for 3-way simulation.");

  const kinds: PreviewKind[] = ["rules", "skills"];
  const items: PreviewItem[] = [];

  for (const kind of kinds) {
    const upstreamDir = await tryResolveTraeKindDir(upstreamRoot, kind);
    const localDir = vscode.Uri.joinPath(workspaceRoot, ".trae", kind);
    const hasLocalDir = await uriExists(localDir);

    const upstreamFiles = upstreamDir ? await listFilesRecursively(upstreamDir) : [];
    const localFiles = hasLocalDir ? await listFilesRecursively(localDir) : [];

    const upstreamSet = new Set(upstreamFiles);
    const localSet = new Set(localFiles);
    const all = Array.from(new Set([...upstreamFiles, ...localFiles])).sort();

    for (const relPosix of all) {
      const localUri = hasLocalDir && localSet.has(relPosix) ? joinPosix(localDir, relPosix) : null;
      const upstreamUri = upstreamDir && upstreamSet.has(relPosix) ? joinPosix(upstreamDir, relPosix) : null;
      const displayPath = `.trae/${kind}/${relPosix}`;
      const id = `${kind}:${relPosix}`;

      if (!localUri && upstreamUri) {
        items.push({ id, kind, relPathPosix: relPosix, displayPath, status: "new-in-upstream", localUri: null, upstreamUri, mergedText: null });
        continue;
      }

      if (localUri && !upstreamUri) {
        if (gitRoot) {
          const relFromGit = toPosixPath(path.relative(gitRoot, localUri.fsPath));
          const headText = relFromGit.startsWith("..") ? null : await tryGetGitHeadContent(gitRoot, relFromGit);
          const status: PreviewStatus = headText !== null ? "deleted-in-upstream" : "local-only";
          items.push({ id, kind, relPathPosix: relPosix, displayPath, status, localUri, upstreamUri: null, mergedText: null });
          continue;
        }
        items.push({ id, kind, relPathPosix: relPosix, displayPath, status: "local-only", localUri, upstreamUri: null, mergedText: null });
        continue;
      }

      if (!localUri || !upstreamUri) {
        continue;
      }

      const [oursText, theirsText] = await Promise.all([readTextFile(localUri), readTextFile(upstreamUri)]);
      if (oursText === theirsText) {
        items.push({ id, kind, relPathPosix: relPosix, displayPath, status: "clean", localUri, upstreamUri, mergedText: null });
        continue;
      }

      let baseText = "";
      if (gitRoot) {
        const relFromGit = toPosixPath(path.relative(gitRoot, localUri.fsPath));
        if (!relFromGit.startsWith("..")) {
          const headText = await tryGetGitHeadContent(gitRoot, relFromGit);
          baseText = headText === null ? "" : headText;
        }
      }

      const sim = await simulateMergeText(baseText, oursText, theirsText);
      const status: PreviewStatus = sim.hadConflicts || containsConflictMarkers(sim.mergedText) ? "conflict" : "auto-merged";
      items.push({ id, kind, relPathPosix: relPosix, displayPath, status, localUri, upstreamUri, mergedText: sim.mergedText });
    }
  }

  return { items, gitRoot };
}

function getPreviewWebItems(items: PreviewItem[]): PreviewWebItem[] {
  return items.map((i) => ({
    id: i.id,
    kind: i.kind,
    path: i.displayPath,
    status: i.status,
    selected: false,
  }));
}

function previewWebviewHtml(webview: vscode.Webview, data: { items: PreviewWebItem[] }): string {
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const initialJson = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preset Sync Preview</title>
    <style>
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
      header, footer { padding: 12px 16px; display: flex; gap: 10px; align-items: center; border-bottom: 1px solid var(--vscode-editorWidget-border); }
      footer { border-top: 1px solid var(--vscode-editorWidget-border); border-bottom: none; justify-content: flex-end; }
      h1 { font-size: 14px; margin: 0; flex: 1; }
      .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
      .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
      .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
      .btn:disabled { opacity: 0.5; cursor: default; }
      table { width: 100%; border-collapse: collapse; }
      th, td { font-size: 12px; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
      tr:hover { background: var(--vscode-list-hoverBackground); }
      .cell-status { width: 56px; }
      .cell-check { width: 34px; }
      .cell-action { width: 140px; }
      code { font-family: var(--vscode-editor-font-family); }
      .rowbtn { background: transparent; border: 1px solid var(--vscode-editorWidget-border); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; }
    </style>
  </head>
  <body>
    <header>
      <h1>Preset Sync Preview</h1>
      <span id="summary" class="muted"></span>
      <button id="selectConflicts" class="btn secondary">Select All Conflicts</button>
      <button id="selectCleanAuto" class="btn secondary">Auto-Resolve Clean/Auto</button>
      <button id="refresh" class="btn secondary">Refresh</button>
    </header>
    <main>
      <table>
        <thead>
          <tr>
            <th class="cell-check"></th>
            <th class="cell-status">Status</th>
            <th>File Path</th>
            <th class="cell-action">Current Action</th>
            <th class="cell-action">Open</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </main>
    <footer>
      <button id="apply" class="btn">Apply Selected</button>
      <button id="cancel" class="btn secondary">Cancel</button>
    </footer>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const initial = ${initialJson};
      let items = initial.items || [];

      function iconForStatus(s) {
        if (s === 'clean') return '✅';
        if (s === 'auto-merged') return '⚠️';
        if (s === 'conflict') return '🔴';
        if (s === 'new-in-upstream') return '➕';
        if (s === 'deleted-in-upstream') return '🗑️';
        return '📄';
      }

      function actionFor(item) {
        if (item.status === 'clean') return item.selected ? 'Apply (no-op)' : 'Skip';
        if (item.status === 'auto-merged') return item.selected ? 'Merge' : 'Skip';
        if (item.status === 'conflict') return item.selected ? 'Merge (conflict)' : 'Skip';
        if (item.status === 'new-in-upstream') return item.selected ? 'Add' : 'Skip';
        if (item.status === 'deleted-in-upstream') return item.selected ? 'Delete' : 'Keep';
        return 'Preserve';
      }

      function canSelect(item) {
        return item.status !== 'local-only';
      }

      function render() {
        const tbody = document.getElementById('tbody');
        tbody.textContent = '';

        const counts = {};
        for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;

        const parts = Object.keys(counts).sort().map(k => k + ': ' + counts[k]);
        document.getElementById('summary').textContent = items.length + ' files' + (parts.length ? ' • ' + parts.join(' • ') : '');

        for (const item of items) {
          const tr = document.createElement('tr');
          tr.addEventListener('click', () => vscode.postMessage({ type: 'open', id: item.id }));

          const tdCheck = document.createElement('td');
          tdCheck.className = 'cell-check';
          if (canSelect(item)) {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!item.selected;
            cb.addEventListener('click', (e) => {
              e.stopPropagation();
              item.selected = cb.checked;
              render();
            });
            tdCheck.appendChild(cb);
          }
          tr.appendChild(tdCheck);

          const tdStatus = document.createElement('td');
          tdStatus.className = 'cell-status';
          tdStatus.textContent = iconForStatus(item.status);
          tr.appendChild(tdStatus);

          const tdPath = document.createElement('td');
          const code = document.createElement('code');
          code.textContent = item.path;
          tdPath.appendChild(code);
          tr.appendChild(tdPath);

          const tdAction = document.createElement('td');
          tdAction.className = 'cell-action';
          tdAction.textContent = actionFor(item);
          tr.appendChild(tdAction);

          const tdOpen = document.createElement('td');
          tdOpen.className = 'cell-action';
          const btn = document.createElement('button');
          btn.className = 'rowbtn';
          btn.textContent = 'Open';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'open', id: item.id });
          });
          tdOpen.appendChild(btn);
          tr.appendChild(tdOpen);

          tbody.appendChild(tr);
        }
      }

      document.getElementById('selectConflicts').addEventListener('click', () => {
        for (const it of items) it.selected = it.status === 'conflict';
        render();
      });

      document.getElementById('selectCleanAuto').addEventListener('click', () => {
        for (const it of items) it.selected = it.status === 'clean' || it.status === 'auto-merged';
        render();
      });

      document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

      document.getElementById('apply').addEventListener('click', () => {
        const selections = items.filter(i => i.selected && canSelect(i)).map(i => i.id);
        vscode.postMessage({ type: 'apply', selections });
      });

      document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

      window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'setData' && msg.data && Array.isArray(msg.data.items)) {
          items = msg.data.items;
          render();
        }
      });

      render();
    </script>
  </body>
</html>`;
}

async function openPreviewItem(item: PreviewItem, output: vscode.OutputChannel): Promise<void> {
  if (item.status === "new-in-upstream" && item.upstreamUri) {
    const doc = await vscode.workspace.openTextDocument(item.upstreamUri);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  if ((item.status === "deleted-in-upstream" || item.status === "local-only") && item.localUri) {
    const doc = await vscode.workspace.openTextDocument(item.localUri);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  if ((item.status === "clean" || item.status === "auto-merged") && item.localUri && item.upstreamUri) {
    await vscode.commands.executeCommand("vscode.diff", item.localUri, item.upstreamUri, `Upstream diff: ${item.displayPath}`);
    return;
  }
  if (item.status === "conflict") {
    if (item.localUri) {
      try {
        await vscode.commands.executeCommand("vscode.openWith", item.localUri, "vscode.mergeEditor");
        return;
      } catch (e) {
        const err = e as any;
        output.appendLine(err && err.message ? err.message : String(err));
      }
    }
    if (item.mergedText) {
      const doc = await vscode.workspace.openTextDocument({ content: item.mergedText, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    if (item.localUri && item.upstreamUri) {
      await vscode.commands.executeCommand("vscode.diff", item.localUri, item.upstreamUri, `Upstream diff: ${item.displayPath}`);
    }
    return;
  }
}

async function applyPreviewSelections(
  selections: string[],
  itemsById: Map<string, PreviewItem>,
  workspaceRoot: vscode.Uri,
  upstreamRoot: vscode.Uri,
  output: vscode.OutputChannel
): Promise<void> {
  const selectedItems = selections.map((id) => itemsById.get(id)).filter((v): v is PreviewItem => !!v);
  const toDelete = selectedItems.filter((i) => i.status === "deleted-in-upstream" && i.localUri).map((i) => i.localUri as vscode.Uri);
  if (toDelete.length > 0) {
    const pick = await vscode.window.showWarningMessage(
      `Delete ${toDelete.length} file(s) that are missing in upstream preset?`,
      { modal: true },
      "Delete",
      "Cancel"
    );
    if (pick !== "Delete") {
      return;
    }
  }

  const gitRoot = await tryGetGitRoot(workspaceRoot.fsPath);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Applying preset sync changes...", cancellable: false },
    async (progress) => {
      const inc = 100 / Math.max(1, selectedItems.length);
      for (const item of selectedItems) {
        progress.report({ message: item.displayPath, increment: inc });

        if (item.status === "clean") {
          continue;
        }

        if (item.status === "new-in-upstream") {
          if (!item.upstreamUri) continue;
          const destDir = vscode.Uri.joinPath(workspaceRoot, ".trae", item.kind);
          const destUri = joinPosix(destDir, item.relPathPosix);
          await ensureDirUri(vscode.Uri.file(path.dirname(destUri.fsPath)));
          await vscode.workspace.fs.copy(item.upstreamUri, destUri, { overwrite: true });
          continue;
        }

        if (item.status === "deleted-in-upstream") {
          if (!item.localUri) continue;
          await vscode.workspace.fs.delete(item.localUri, { useTrash: true });
          continue;
        }

        if (item.status === "auto-merged" || item.status === "conflict") {
          if (!item.localUri || !item.upstreamUri) continue;
          const [oursText, theirsText] = await Promise.all([readTextFile(item.localUri), readTextFile(item.upstreamUri)]);
          let baseText = "";
          if (gitRoot) {
            const relFromGit = toPosixPath(path.relative(gitRoot, item.localUri.fsPath));
            if (!relFromGit.startsWith("..")) {
              const headText = await tryGetGitHeadContent(gitRoot, relFromGit);
              baseText = headText === null ? "" : headText;
            }
          }
          const sim = await simulateMergeText(baseText, oursText, theirsText);
          const destDir = vscode.Uri.joinPath(workspaceRoot, ".trae", item.kind);
          const destUri = joinPosix(destDir, item.relPathPosix);
          await ensureDirUri(vscode.Uri.file(path.dirname(destUri.fsPath)));
          await vscode.workspace.fs.writeFile(destUri, Buffer.from(sim.mergedText, "utf8"));
          if (sim.hadConflicts || containsConflictMarkers(sim.mergedText)) {
            output.appendLine(`Applied with conflicts: ${item.displayPath}`);
          }
          continue;
        }
      }
    }
  );
}

async function previewSyncCommand(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const output = ensureOutputChannel(state);
  output.show(true);

  const workspaceRoot = await pickWorkspaceFolderRoot();
  const source = await pickSyncSource();
  if (!source) return;

  let upstreamRoot = source.kind === "local" ? source.root : null;
  let cleanup: (() => Promise<void>) | null = null;

  if (source.kind === "git") {
    const cloned = await gitCloneToTemp(source.repoUrl, source.branch);
    upstreamRoot = vscode.Uri.file(cloned.repoDir);
    cleanup = cloned.cleanup;
  }

  if (!upstreamRoot) return;

  const panel = vscode.window.createWebviewPanel(
    "presetSyncPreview",
    "Preset Sync Preview",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  let itemsById = new Map<string, PreviewItem>();

  const refresh = async () => {
    const preview = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Building preset sync preview...", cancellable: false },
      async () => {
        return await computePreview(workspaceRoot, upstreamRoot as vscode.Uri, output);
      }
    );
    itemsById = new Map(preview.items.map((i) => [i.id, i]));
    panel.webview.postMessage({ type: "setData", data: { items: getPreviewWebItems(preview.items) } });
  };

  panel.webview.html = previewWebviewHtml(panel.webview, { items: [] });

  panel.onDidDispose(async () => {
    if (cleanup) await cleanup();
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "open" && typeof msg.id === "string") {
        const item = itemsById.get(msg.id);
        if (!item) return;
        await openPreviewItem(item, output);
        return;
      }
      if (msg.type === "apply" && Array.isArray(msg.selections)) {
        const selections = msg.selections.filter((s: unknown): s is string => typeof s === "string");
        await applyPreviewSelections(selections, itemsById, workspaceRoot, upstreamRoot as vscode.Uri, output);
        await refresh();
        vscode.window.showInformationMessage("Preset sync apply finished.");
        return;
      }
      if (msg.type === "refresh") {
        await refresh();
        return;
      }
      if (msg.type === "cancel") {
        panel.dispose();
      }
    } catch (e) {
      const err = e as any;
      const text = err && err.message ? err.message : String(err);
      output.appendLine(text);
      vscode.window.showErrorMessage(text);
    }
  });

  await refresh();
}

async function mergeConflict(state: ExtensionState): Promise<void> {
  const output = ensureOutputChannel(state);
  output.show(true);

  const workspaceRoot = await pickWorkspaceFolderRoot();
  const rootPick = await vscode.window.showQuickPick(
    [
      { label: "Pick a file under .trae/", value: "trae" as const },
      { label: "Pick any file", value: "any" as const },
    ],
    { placeHolder: "Select file scope" }
  );
  if (!rootPick) return;

  const defaultUri = rootPick.value === "trae" ? vscode.Uri.joinPath(workspaceRoot, ".trae") : workspaceRoot;
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri,
    openLabel: "Select file",
  });
  const fileUri = uris && uris[0] ? uris[0] : null;
  if (!fileUri) return;

  const modePick = await vscode.window.showQuickPick(
    [
      { label: "Open Merge Editor (Git)", value: "mergeEditor" as const },
      { label: "Diff with another file", value: "diff" as const },
    ],
    { placeHolder: "How to resolve?" }
  );
  if (!modePick) return;

  if (modePick.value === "mergeEditor") {
    try {
      await vscode.commands.executeCommand("vscode.openWith", fileUri, "vscode.mergeEditor");
      return;
    } catch (e) {
      const err = e as any;
      output.appendLine(err && err.message ? err.message : String(err));
    }
  }

  const otherUris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Select file to diff against",
  });
  const otherUri = otherUris && otherUris[0] ? otherUris[0] : null;
  if (!otherUri) return;

  await vscode.commands.executeCommand("vscode.diff", otherUri, fileUri, `Diff: ${path.basename(otherUri.fsPath)} ↔ ${path.basename(fileUri.fsPath)}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const state: ExtensionState = {};
  const telemetry = createTelemetry(context);

  context.subscriptions.push(vscode.commands.registerCommand("traeRule.setup", () => setupCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.status", () => statusCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.sync", () => syncCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.gitignore", () => gitignoreCommand(state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.dashboard", () => dashboardCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.doctor", () => doctorCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("trae.syncRules", () => syncRulesIntoWorkspace(state)));
  context.subscriptions.push(vscode.commands.registerCommand("trae.syncSkills", () => syncSkillsIntoWorkspace(state)));
  context.subscriptions.push(vscode.commands.registerCommand("trae.publishToTeam", () => publishToTeam(state)));
  context.subscriptions.push(vscode.commands.registerCommand("trae.mergeConflict", () => mergeConflict(state)));
  context.subscriptions.push(vscode.commands.registerCommand("trae.previewSync", () => previewSyncCommand(context, state)));

  registerConflictDetection(context, state, { pickWorkspaceFolderRoot, readTextFile, ensureOutputChannel });
  registerTokenAnalysis(context, state, { pickWorkspaceFolderRoot, readTextFile, uriExists, ensureDirUri, ensureOutputChannel });
  registerCostControl(context);
  registerCompiler(context, state, { pickWorkspaceFolderRoot, readTextFile, uriExists, ensureDirUri, ensureOutputChannel });
  registerAliasCommands(context);
  registerOnboarding(context);
  void telemetry.event("activate");

  context.subscriptions.push({
    dispose() {
      try {
        if (state.dashboardProcess && !state.dashboardProcess.killed) {
          state.dashboardProcess.kill();
        }
      } catch {
        void 0;
      }
      try {
        if (state.tokenRefreshTimer) clearTimeout(state.tokenRefreshTimer);
      } catch {
        void 0;
      }
      try {
        if (state.tokenEncoderFree) state.tokenEncoderFree();
      } catch {
        void 0;
      } finally {
        state.tokenEncoderFree = null;
        state.tokenEncoder = null;
      }
    },
  });
}

export function deactivate(): void {
  return;
}

import * as vscode from "vscode";
import * as path from "path";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";

type CoreModule = {
  initDeploy: (args: any) => Promise<any>;
  statusCheck: (args: any) => Promise<any>;
  syncCopy: (args: any) => Promise<any>;
  ensureGitignore: (args: any) => Promise<any>;
  computePlan: (args: any) => Promise<any>;
};

function loadCore(): CoreModule {
  const p = path.join(__dirname, "..", "src", "core");
  return require(p) as CoreModule;
}

function templateRootFromExtension(context: vscode.ExtensionContext): string {
  return path.resolve(context.extensionPath, "Template");
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

  context.subscriptions.push({
    dispose() {
      try {
        if (state.dashboardProcess && !state.dashboardProcess.killed) {
          state.dashboardProcess.kill();
        }
      } catch {
        void 0;
      }
    },
  });
}

export function deactivate(): void {
  return;
}

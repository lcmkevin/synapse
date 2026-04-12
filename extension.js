/* eslint-disable no-console */
"use strict";

const vscode = require("vscode");
const path = require("path");
const childProcess = require("child_process");

const core = require("./src/core");

function templateRootFromExtension(context) {
  return path.resolve(context.extensionPath, "Template");
}

async function pickWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder is open. Open a folder first.");
    return null;
  }
  if (folders.length === 1) return folders[0];

  const items = folders.map((f) => ({
    label: f.name,
    description: f.uri.fsPath,
    folder: f,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a workspace folder" });
  return picked ? picked.folder : null;
}

function ensureOutputChannel(state) {
  if (!state.output) {
    state.output = vscode.window.createOutputChannel("Trae Rule Deployer");
  }
  return state.output;
}

async function setupCommand(context, state) {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;

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

  try {
    const templateRoot = templateRootFromExtension(context);
    const res = await core.initDeploy({
      toolName: "trae-rule-deployer-vscode",
      version: "0.1.0",
      templateRoot,
      targetRoot: folder.uri.fsPath,
      mode: mode.label,
      force: forcePick.value,
      backup: backupPick.value,
      dryRun: dryRunPick.value,
      onProgress: (e) => {
        if (e && e.relPosix) output.appendLine(`${e.type} ${e.relPosix}`);
      },
    });
    output.appendLine(JSON.stringify(res, null, 2));
    vscode.window.showInformationMessage(`Trae rules deployed: applied ${res.applied.length}, skipped ${res.skipped.length}${res.dryRun ? " (dry-run)" : ""}`);
  } catch (e) {
    vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
  }
}

async function statusCommand(context, state) {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;

  const output = ensureOutputChannel(state);
  output.show(true);
  output.appendLine(`Status: ${folder.uri.fsPath}`);

  try {
    const templateRoot = templateRootFromExtension(context);
    const res = await core.statusCheck({
      templateRoot,
      targetRoot: folder.uri.fsPath,
      onProgress: (e) => {
        if (e && e.relPosix) output.appendLine(`${e.type} ${e.relPosix}`);
      },
    });
    output.appendLine(JSON.stringify(res, null, 2));
    vscode.window.showInformationMessage(`Status: same ${res.same.length}, different ${res.different.length}, missing ${res.missing.length}`);
  } catch (e) {
    vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
  }
}

async function syncCommand(context, state) {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;

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
  output.appendLine(`Sync: ${folder.uri.fsPath}`);

  try {
    const templateRoot = templateRootFromExtension(context);
    const res = await core.syncCopy({
      templateRoot,
      targetRoot: folder.uri.fsPath,
      force: forcePick.value,
      backup: backupPick.value,
      dryRun: dryRunPick.value,
      onProgress: (e) => {
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
  } catch (e) {
    vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
  }
}

async function gitignoreCommand(state) {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;

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
  output.appendLine(`Gitignore: ${folder.uri.fsPath}`);

  try {
    const res = await core.ensureGitignore({ targetRoot: folder.uri.fsPath, dryRun: dryRunPick.value });
    output.appendLine(JSON.stringify(res, null, 2));
    vscode.window.showInformationMessage(res.changed ? "Added .trae/ to .gitignore" : ".trae/ already present in .gitignore");
  } catch (e) {
    vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
  }
}

function dashboardCommand(context, state) {
  const output = ensureOutputChannel(state);
  output.show(true);

  const serverEntry = path.resolve(context.extensionPath, "src", "server.js");
  const child = childProcess.spawn(process.execPath, [serverEntry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0" },
  });
  state.dashboardProcess = child;

  let opened = false;
  const onLine = async (line) => {
    output.appendLine(line);
    const m = line.match(/Dashboard running at (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (m && m[1] && !opened) {
      opened = true;
      await vscode.env.openExternal(vscode.Uri.parse(m[1]));
    }
  };

  child.stdout.on("data", (b) => {
    const s = b.toString("utf8");
    s.split(/\r?\n/).filter(Boolean).forEach((l) => void onLine(l));
  });
  child.stderr.on("data", (b) => output.appendLine(b.toString("utf8")));
  child.on("exit", (code) => output.appendLine(`Dashboard exited (${code})`));

  vscode.window.showInformationMessage("Starting Trae Rule dashboard...");
}

async function doctorCommand(context, state) {
  const output = ensureOutputChannel(state);
  output.show(true);

  try {
    const templateRoot = templateRootFromExtension(context);
    const res = await core.computePlan({ templateRoot, targetRoot: vscode.workspace.rootPath || process.cwd() });
    output.appendLine(`Template OK: ${res.templateTraeDir}`);
    vscode.window.showInformationMessage("Doctor: template folder looks OK.");
  } catch (e) {
    vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
  }
}

function activate(context) {
  const state = {};

  context.subscriptions.push(vscode.commands.registerCommand("traeRule.setup", () => setupCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.status", () => statusCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.sync", () => syncCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.gitignore", () => gitignoreCommand(state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.dashboard", () => dashboardCommand(context, state)));
  context.subscriptions.push(vscode.commands.registerCommand("traeRule.doctor", () => doctorCommand(context, state)));

  context.subscriptions.push({
    dispose() {
      try {
        if (state.dashboardProcess && !state.dashboardProcess.killed) {
          state.dashboardProcess.kill();
        }
      } catch {
        // ignore
      }
    },
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};


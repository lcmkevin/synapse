import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('trae.syncRules', syncRules),
    vscode.commands.registerCommand('trae.syncSkills', syncSkills),
    vscode.commands.registerCommand('trae.publishToTeam', publishToTeam),
    vscode.commands.registerCommand('trae.mergeConflict', mergeConflict)
  );
}

async function pickSourceFolder(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select source folder'
  });
  return uris?.[0]?.fsPath;
}

async function getWorkspaceRoot(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder open');
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Pick workspace folder' });
  if (!picked) throw new Error('No folder selected');
  return picked.uri.fsPath;
}

async function copyDir(src: string, dest: string) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.promises.copyFile(s, d);
  }
}

async function syncRules() {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Syncing Trae rules...',
    cancellable: false
  }, async () => {
    try {
      const src = await pickSourceFolder();
      if (!src) return;
      const root = await getWorkspaceRoot();
      const dest = path.join(root, '.trae', 'rules');
      await copyDir(path.join(src, '.trae', 'rules'), dest);
      vscode.window.showInformationMessage('Rules synced into workspace .trae/rules');
    } catch (e: any) {
      vscode.window.showErrorMessage('Sync rules failed: ' + e.message);
    }
  });
}

async function syncSkills() {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Syncing Trae skills...',
    cancellable: false
  }, async () => {
    try {
      const src = await pickSourceFolder();
      if (!src) return;
      const root = await getWorkspaceRoot();
      const dest = path.join(root, '.trae', 'skills');
      await copyDir(path.join(src, '.trae', 'skills'), dest);
      vscode.window.showInformationMessage('Skills synced into workspace .trae/skills');
    } catch (e: any) {
      vscode.window.showErrorMessage('Sync skills failed: ' + e.message);
    }
  });
}

async function publishToTeam() {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Publishing rules/skills to team repo...',
    cancellable: false
  }, async () => {
    try {
      const root = await getWorkspaceRoot();
      const repo = await vscode.window.showInputBox({ prompt: 'Team Git repo HTTPS URL', placeHolder: 'https://github.com/org/shared-rules.git' });
      if (!repo) return;
      const branch = await vscode.window.showInputBox({ prompt: 'Branch (default main)', value: 'main' }) || 'main';
      const token = await vscode.window.showInputBox({ prompt: 'GitHub PAT (optional)', password: true });
      const remoteName = 'trae-team';
      const tmp = path.join(root, '.trae-team-tmp');
      await fs.promises.mkdir(tmp, { recursive: true });
      await execAsync(`git clone --depth 1 --branch ${branch} ${repo} .`, { cwd: tmp });
      await copyDir(path.join(root, '.trae', 'rules'), path.join(tmp, '.trae', 'rules'));
      await copyDir(path.join(root, '.trae', 'skills'), path.join(tmp, '.trae', 'skills'));
      await execAsync('git add .', { cwd: tmp });
      await execAsync('git commit -m "Publish rules/skills from Trae extension"', { cwd: tmp });
      const pushUrl = token ? repo.replace('https://', `https://${token}@`) : repo;
      await execAsync(`git push ${pushUrl} ${branch}`, { cwd: tmp });
      await fs.promises.rm(tmp, { recursive: true, force: true });
      vscode.window.showInformationMessage('Rules & skills published to team repo');
    } catch (e: any) {
      vscode.window.showErrorMessage('Publish failed: ' + e.message);
    }
  });
}

async function mergeConflict() {
  try {
    const root = await getWorkspaceRoot();
    const conflicted = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select conflicted file'
    });
    if (!conflicted) return;
    await vscode.commands.executeCommand('vscode.diff', 
      vscode.Uri.file(conflicted[0].fsPath + '.base'),
      vscode.Uri.file(conflicted[0].fsPath),
      'Merge conflict');
  } catch (e: any) {
    vscode.window.showErrorMessage('Merge conflict open failed: ' + e.message);
  }
}

export function deactivate() {}
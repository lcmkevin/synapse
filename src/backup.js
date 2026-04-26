const fs = require("fs-extra");
const path = require("path");
const os = require("os");

class BackupManager {
  constructor(options) {
    const root = options && typeof options.backupDir === "string" && options.backupDir.trim() ? options.backupDir.trim() : null;
    this.backupDir = root || path.join(os.homedir(), ".synapse", "backups");
  }

  async createBackup(workspaceRoot) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFolder = path.join(this.backupDir, `backup_${timestamp}`);
    await fs.ensureDir(backupFolder);

    const synapsePath = path.join(workspaceRoot, ".synapse");
    await fs.copy(synapsePath, backupFolder, { overwrite: true, errorOnExist: false });
    return backupFolder;
  }

  async restore(backupPath, workspaceRoot) {
    const targetPath = path.join(workspaceRoot, ".synapse");
    await fs.remove(targetPath);
    await fs.copy(backupPath, targetPath, { overwrite: true, errorOnExist: false });
  }

  async listBackups() {
    try {
      const entries = await fs.readdir(this.backupDir);
      return entries.filter((b) => b.startsWith("backup_")).sort().reverse();
    } catch {
      return [];
    }
  }
}

module.exports = { BackupManager };


const fs = require("fs-extra");
const path = require("path");
const os = require("os");

class BackupManager {
  constructor(options) {
    const root = options && typeof options.backupDir === "string" && options.backupDir.trim() ? options.backupDir.trim() : null;
    this.backupDir = root || path.join(os.homedir(), ".synapse", "backups");
  }

  getMaxKeep() {
    const raw = process.env.SYNAPSE_BACKUP_KEEP ?? process.env.SYNAPSE_BACKUP_RETENTION;
    if (raw === undefined) return 3;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return 3;
    return Math.max(0, n);
  }

  async pruneBackups(maxKeep) {
    const keep = Number.isFinite(maxKeep) ? Math.max(0, Math.floor(maxKeep)) : 0;
    if (keep <= 0) return;
    const backups = await this.listBackups();
    const extra = backups.slice(keep);
    for (const name of extra) {
      try {
        await fs.remove(path.join(this.backupDir, name));
      } catch {
        void 0;
      }
    }
  }

  async createBackup(workspaceRoot) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFolder = path.join(this.backupDir, `backup_${timestamp}`);
    await fs.ensureDir(backupFolder);

    const synapsePath = path.join(workspaceRoot, ".synapse");
    await fs.copy(synapsePath, backupFolder, { overwrite: true, errorOnExist: false });
    await this.pruneBackups(this.getMaxKeep());
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

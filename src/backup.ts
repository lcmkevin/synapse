import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

export type BackupManagerOptions = {
  backupDir?: string;
};

export class BackupManager {
  private backupDir: string;

  constructor(options?: BackupManagerOptions) {
    const dir = typeof options?.backupDir === "string" && options.backupDir.trim() ? options.backupDir.trim() : "";
    this.backupDir = dir || path.join(os.homedir(), ".synapse", "backups");
  }

  private getMaxKeep(): number {
    const raw = process.env.SYNAPSE_BACKUP_KEEP ?? process.env.SYNAPSE_BACKUP_RETENTION;
    if (raw === undefined) return 3;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return 3;
    return Math.max(0, n);
  }

  private async pruneBackups(maxKeep: number): Promise<void> {
    const keep = Number.isFinite(maxKeep) ? Math.max(0, Math.floor(maxKeep)) : 0;
    if (keep <= 0) return;
    const backups = await this.listBackups();
    const extra = backups.slice(keep);
    for (const name of extra) {
      try {
        await fs.rm(path.join(this.backupDir, name), { recursive: true, force: true });
      } catch {
        void 0;
      }
    }
  }

  async createBackup(workspaceRoot: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFolder = path.join(this.backupDir, `backup_${timestamp}`);
    await fs.mkdir(backupFolder, { recursive: true });

    const synapsePath = path.join(workspaceRoot, ".synapse");
    await fs.cp(synapsePath, backupFolder, { recursive: true });
    await this.pruneBackups(this.getMaxKeep());
    return backupFolder;
  }

  async restore(backupPath: string, workspaceRoot: string): Promise<void> {
    const targetPath = path.join(workspaceRoot, ".synapse");
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(backupPath, targetPath, { recursive: true });
  }

  async listBackups(): Promise<string[]> {
    try {
      const backups = await fs.readdir(this.backupDir);
      return backups.filter((b) => b.startsWith("backup_")).sort().reverse();
    } catch {
      return [];
    }
  }
}

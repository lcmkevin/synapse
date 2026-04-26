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

  async createBackup(workspaceRoot: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFolder = path.join(this.backupDir, `backup_${timestamp}`);
    await fs.mkdir(backupFolder, { recursive: true });

    const synapsePath = path.join(workspaceRoot, ".synapse");
    await fs.cp(synapsePath, backupFolder, { recursive: true });
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

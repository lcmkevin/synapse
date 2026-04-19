import * as fs from "fs/promises";
import * as path from "path";

export interface DetectedRule {
  ide: "trae" | "cursor" | "windsurf" | "cline";
  originalPath: string;
  originalFormat: string;
  content: string;
  suggestedName: string;
}

export class ImportScanner {
  async scanWorkspace(workspaceRoot: string): Promise<DetectedRule[]> {
    const detected: DetectedRule[] = [];

    const traePath = path.join(workspaceRoot, ".trae", "rules");
    detected.push(...(await this.scanTrae(traePath)));

    const cursorPath = path.join(workspaceRoot, ".cursor", "rules");
    detected.push(...(await this.scanCursor(cursorPath)));

    const windsurfPath = path.join(workspaceRoot, ".windsurf");
    detected.push(...(await this.scanWindsurf(windsurfPath)));

    const clinePath = path.join(workspaceRoot, ".clinerules");
    detected.push(...(await this.scanCline(clinePath)));

    return detected;
  }

  private async scanTrae(folderPath: string): Promise<DetectedRule[]> {
    const rules: DetectedRule[] = [];
    try {
      const files = await fs.readdir(folderPath);
      const traeFiles = files.filter((f) => f.toLowerCase().endsWith(".md"));

      for (const file of traeFiles) {
        const fullPath = path.join(folderPath, file);
        const content = await fs.readFile(fullPath, "utf-8");
        rules.push({
          ide: "trae",
          originalPath: fullPath,
          originalFormat: "markdown",
          content,
          suggestedName: this.suggestName(file.replace(/\.md$/i, "")),
        });
      }
    } catch {
      return rules;
    }
    return rules;
  }

  private async scanCursor(folderPath: string): Promise<DetectedRule[]> {
    const rules: DetectedRule[] = [];
    try {
      const files = await fs.readdir(folderPath);
      const cursorFiles = files.filter((f) => f.toLowerCase().endsWith(".mdc"));

      for (const file of cursorFiles) {
        const fullPath = path.join(folderPath, file);
        const content = await fs.readFile(fullPath, "utf-8");
        rules.push({
          ide: "cursor",
          originalPath: fullPath,
          originalFormat: "cursor",
          content,
          suggestedName: this.suggestName(file.replace(/\.mdc$/i, "")),
        });
      }
    } catch {
      return rules;
    }
    return rules;
  }

  private async scanWindsurf(folderPath: string): Promise<DetectedRule[]> {
    const rules: DetectedRule[] = [];
    try {
      const files = await fs.readdir(folderPath);
      const windsurfFiles = files.filter((f) => f.toLowerCase().endsWith(".windsurfrules"));

      for (const file of windsurfFiles) {
        const fullPath = path.join(folderPath, file);
        const content = await fs.readFile(fullPath, "utf-8");
        rules.push({
          ide: "windsurf",
          originalPath: fullPath,
          originalFormat: "windsurf",
          content,
          suggestedName: this.suggestName(file.replace(/\.windsurfrules$/i, "")),
        });
      }
    } catch {
      return rules;
    }
    return rules;
  }

  private async scanCline(folderPath: string): Promise<DetectedRule[]> {
    const rules: DetectedRule[] = [];
    try {
      const files = await fs.readdir(folderPath);
      const clineFiles = files.filter((f) => f.toLowerCase().endsWith(".md"));

      for (const file of clineFiles) {
        const fullPath = path.join(folderPath, file);
        const content = await fs.readFile(fullPath, "utf-8");
        rules.push({
          ide: "cline",
          originalPath: fullPath,
          originalFormat: "markdown",
          content,
          suggestedName: this.suggestName(file.replace(/\.md$/i, "")),
        });
      }
    } catch {
      return rules;
    }
    return rules;
  }

  private suggestName(base: string): string {
    const safe = base
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "")
      .toLowerCase();
    return `${safe || "imported"}.synapse`;
  }
}

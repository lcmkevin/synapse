// NEW: AdapterManager compiles .synapse master rules to IDE-specific formats

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { IDEAdapter, SynapseRule, CompilationResult } from "./adapters/adapter.interface";
import { TraeAdapter } from "./adapters/trae.adapter";
import { CursorAdapter } from "./adapters/cursor.adapter";
import { WindsurfAdapter } from "./adapters/windsurf.adapter";
import { ClineAdapter } from "./adapters/cline.adapter";

export class AdapterManager {
  private adapters: Map<string, IDEAdapter> = new Map();
  private enabledTargets: Map<string, boolean> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    this.registerAdapters();
    void this.loadEnabledTargets();
  }

  private registerAdapters(): void {
    const trae = new TraeAdapter();
    const cursor = new CursorAdapter();
    const windsurf = new WindsurfAdapter();
    const cline = new ClineAdapter();
    this.adapters.set(trae.id, trae);
    this.adapters.set(cursor.id, cursor);
    this.adapters.set(windsurf.id, windsurf);
    this.adapters.set(cline.id, cline);
  }

  private async loadEnabledTargets(): Promise<void> {
    const config = vscode.workspace.getConfiguration("synapse");
    const targets = config.get<Record<string, { enabled: boolean }>>("targets", {});

    for (const [id, adapter] of this.adapters) {
      const key = adapter.name.toLowerCase();
      const targetConfig = targets[key];
      this.enabledTargets.set(id, targetConfig?.enabled ?? true);
    }
  }

  async compileToTarget(rule: SynapseRule, targetName: string, workspaceRoot: string): Promise<CompilationResult> {
    const adapter = Array.from(this.adapters.values()).find((a) => a.name.toLowerCase() === targetName.toLowerCase());
    if (!adapter) return { success: false, errors: [`No adapter for: ${targetName}`], targetIDE: targetName };

    try {
      const compiled = await adapter.compile(rule);
      const validation = await adapter.validate(compiled);
      if (!validation.valid) return { success: false, errors: validation.errors, targetIDE: adapter.name };

      const targetPath = path.join(workspaceRoot, adapter.targetFolder);
      await fs.mkdir(targetPath, { recursive: true });

      const outputFile = path.join(targetPath, `${rule.id}${adapter.targetExtension}`);
      await fs.writeFile(outputFile, compiled, "utf8");

      return { success: true, outputPath: outputFile, targetIDE: adapter.name };
    } catch (error) {
      return { success: false, errors: [error instanceof Error ? error.message : String(error)], targetIDE: adapter.name };
    }
  }

  async syncAllRules(workspaceRoot: string, allowedTargets?: string[]): Promise<CompilationResult[]> {
    await this.loadEnabledTargets();
    const masterPath = path.join(workspaceRoot, ".synapse", "rules");
    const results: CompilationResult[] = [];

    try {
      const files = await fs.readdir(masterPath);
      const ruleFiles = files.filter((f) => f.endsWith(".synapse"));

      for (const file of ruleFiles) {
        const fullPath = path.join(masterPath, file);
        const content = await fs.readFile(fullPath, "utf8");
        const rule = await this.parseRule(content, fullPath);

        for (const [adapterId, enabled] of this.enabledTargets) {
          if (!enabled) continue;
          const adapter = this.adapters.get(adapterId);
          if (!adapter) continue;
          if (allowedTargets && allowedTargets.length > 0) {
            const name = adapter.name.toLowerCase();
            if (!allowedTargets.map((t) => t.toLowerCase()).includes(name)) continue;
          }
          const result = await this.compileToTarget(rule, adapter.name, workspaceRoot);
          results.push(result);
        }
      }

      const successCount = results.filter((r) => r.success).length;
      vscode.window.showInformationMessage(`Synapse: Synced ${ruleFiles.length} rule(s) to ${successCount} output(s)`);
    } catch (error) {
      vscode.window.showErrorMessage(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return results;
  }

  private async parseRule(content: string, filePath: string): Promise<SynapseRule> {
    return this.parseSynapseRule(content, filePath);
  }

  private parseSynapseRule(content: string, filePath: string): SynapseRule {
    const nameMatch = content.match(/^\s*#\s*Rule:\s*(.+)\s*$/im);
    const descMatch = content.match(/^\s*#\s*Description:\s*(.+)\s*$/im);

    const constraints: string[] = [];
    const skills: string[] = [];

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const constraintMatch = line.match(/^\s*#\s*@constraint\s+(.+)\s*$/i);
      if (constraintMatch) constraints.push(`@constraint ${constraintMatch[1].trim()}`);

      const skillMatch = line.match(/^\s*#\s*@skill\s+(.+)\s*$/i);
      if (skillMatch) skills.push(`@skill ${skillMatch[1].trim()}`);
    }

    const cleaned = lines
      .filter((l) => !/^\s*#\s*Rule:\s*/i.test(l))
      .filter((l) => !/^\s*#\s*Description:\s*/i.test(l))
      .filter((l) => !/^\s*#\s*Constraints:\s*$/i.test(l))
      .filter((l) => !/^\s*#\s*@constraint\s+/i.test(l))
      .filter((l) => !/^\s*#\s*Skills:\s*$/i.test(l))
      .filter((l) => !/^\s*#\s*@skill\s+/i.test(l))
      .join("\n")
      .trim();

    const now = new Date();
    return {
      id: path.basename(filePath, path.extname(filePath)),
      name: (nameMatch?.[1] || path.basename(filePath, path.extname(filePath))).trim(),
      description: descMatch?.[1]?.trim(),
      content: cleaned,
      constraints,
      skills,
      metadata: {
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
    };
  }

  getAvailableTargets(): string[] {
    return Array.from(this.adapters.values()).map((a) => a.name);
  }

  async addTarget(targetName: string): Promise<void> {
    const adapter = Array.from(this.adapters.values()).find((a) => a.name.toLowerCase() === targetName.toLowerCase());
    if (!adapter) throw new Error(`Unknown IDE: ${targetName}`);

    const config = vscode.workspace.getConfiguration("synapse");
    const targets = config.get<Record<string, { enabled: boolean; path: string }>>("targets", {});

    targets[targetName.toLowerCase()] = { enabled: true, path: adapter.targetFolder };
    await config.update("targets", targets, vscode.ConfigurationTarget.Workspace);
    await this.loadEnabledTargets();

    vscode.window.showInformationMessage(`Added ${adapter.name} target. ${adapter.getInstallInstructions()}`);
  }
}

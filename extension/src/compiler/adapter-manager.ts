// NEW: AdapterManager compiles .synapse master rules to IDE-specific formats

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { IDEAdapter, SynapseRule, CompilationResult, AdapterOutput } from "./adapters/adapter.interface";
import { TraeAdapter } from "./adapters/trae.adapter";
import { CursorAdapter } from "./adapters/cursor.adapter";
import { WindsurfAdapter } from "./adapters/windsurf.adapter";
import { ClineAdapter } from "./adapters/cline.adapter";
import { ZedAdapter } from "./adapters/zed.adapter";

type ConflictMode = "overwrite" | "skip" | "prompt";

type SyncOptions = {
  allowedTargets?: string[];
  conflictMode?: ConflictMode;
  selectedRuleIds?: string[];
};

type ConflictState = {
  overwriteAll: boolean;
  skipAll: boolean;
};

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
    const zed = new ZedAdapter();
    this.adapters.set(trae.id, trae);
    this.adapters.set(cursor.id, cursor);
    this.adapters.set(windsurf.id, windsurf);
    this.adapters.set(cline.id, cline);
    this.adapters.set(zed.id, zed);
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

  private normalizeForCompare(text: string): string {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trimEnd();
  }

  private async writeOutputFile(
    outputFile: string,
    compiled: string,
    targetName: string,
    conflictMode: ConflictMode,
    state: ConflictState
  ): Promise<CompilationResult> {
    let existing: string | null = null;
    try {
      existing = await fs.readFile(outputFile, "utf8");
    } catch {
      existing = null;
    }

    if (existing !== null) {
      const same = this.normalizeForCompare(existing) === this.normalizeForCompare(compiled);
      if (same) return { success: true, outputPath: outputFile, targetIDE: targetName, warnings: ["Unchanged"] };

      if (state.skipAll) {
        return { success: true, outputPath: outputFile, targetIDE: targetName, warnings: ["Skipped existing file"] };
      }
      if (state.overwriteAll) {
        await fs.writeFile(outputFile, compiled, "utf8");
        return { success: true, outputPath: outputFile, targetIDE: targetName };
      }

      if (conflictMode === "skip") {
        return { success: true, outputPath: outputFile, targetIDE: targetName, warnings: ["Skipped existing file"] };
      }

      if (conflictMode === "prompt") {
        const choice = await vscode.window.showQuickPick(["Overwrite", "Skip", "Overwrite All", "Skip All", "Cancel Sync"], {
          placeHolder: `${targetName}: ${path.basename(outputFile)} exists. Overwrite?`,
        });
        if (!choice || choice === "Cancel Sync") throw new Error("SYNC_CANCELED");
        if (choice === "Skip") {
          return { success: true, outputPath: outputFile, targetIDE: targetName, warnings: ["Skipped existing file"] };
        }
        if (choice === "Skip All") {
          state.skipAll = true;
          return { success: true, outputPath: outputFile, targetIDE: targetName, warnings: ["Skipped existing file"] };
        }
        if (choice === "Overwrite All") state.overwriteAll = true;
        await fs.writeFile(outputFile, compiled, "utf8");
        return { success: true, outputPath: outputFile, targetIDE: targetName };
      }
    }

    await fs.writeFile(outputFile, compiled, "utf8");
    return { success: true, outputPath: outputFile, targetIDE: targetName };
  }

  async compileToTarget(
    rule: SynapseRule,
    targetName: string,
    workspaceRoot: string,
    conflictMode: ConflictMode,
    state: ConflictState
  ): Promise<CompilationResult> {
    const adapter = Array.from(this.adapters.values()).find((a) => a.name.toLowerCase() === targetName.toLowerCase());
    if (!adapter) return { success: false, errors: [`No adapter for: ${targetName}`], targetIDE: targetName };

    try {
      const compiled = await adapter.compile(rule);
      const validation = await adapter.validate(compiled);
      if (!validation.valid) return { success: false, errors: validation.errors, targetIDE: adapter.name };

      const targetPath = path.join(workspaceRoot, adapter.targetFolder);
      await fs.mkdir(targetPath, { recursive: true });

      const outputFile = path.join(targetPath, `${rule.id}${adapter.targetExtension}`);
      return await this.writeOutputFile(outputFile, compiled, adapter.name, conflictMode, state);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "SYNC_CANCELED") throw error;
      return { success: false, errors: [error instanceof Error ? error.message : String(error)], targetIDE: adapter.name };
    }
  }

  private async compileAllForAdapter(
    adapter: IDEAdapter,
    rules: SynapseRule[],
    workspaceRoot: string,
    conflictMode: ConflictMode,
    state: ConflictState
  ): Promise<CompilationResult[]> {
    if (!adapter.compileAll) return [];
    const outputs: AdapterOutput[] = await adapter.compileAll(rules);
    const results: CompilationResult[] = [];
    for (const out of outputs) {
      const outputFile = path.join(workspaceRoot, out.relativePath);
      await fs.mkdir(path.dirname(outputFile), { recursive: true });
      const validation = await adapter.validate(out.content);
      if (!validation.valid) {
        results.push({ success: false, errors: validation.errors, targetIDE: adapter.name, outputPath: outputFile });
        continue;
      }
      const r = await this.writeOutputFile(outputFile, out.content, adapter.name, conflictMode, state);
      results.push(r);
    }
    return results;
  }

  async syncAllRules(workspaceRoot: string, options: SyncOptions = {}): Promise<CompilationResult[]> {
    await this.loadEnabledTargets();
    const masterPath = path.join(workspaceRoot, ".synapse", "rules");
    const results: CompilationResult[] = [];
    const conflictMode: ConflictMode = options.conflictMode || "prompt";
    const state: ConflictState = { overwriteAll: false, skipAll: false };
    let processedRules = 0;

    try {
      const files = await fs.readdir(masterPath);
      const ruleFiles = files.filter((f) => f.endsWith(".synapse"));
      const rules: SynapseRule[] = [];

      for (const file of ruleFiles) {
        const fullPath = path.join(masterPath, file);
        const content = await fs.readFile(fullPath, "utf8");
        const rule = await this.parseRule(content, fullPath);
        if (options.selectedRuleIds && options.selectedRuleIds.length > 0 && !options.selectedRuleIds.includes(rule.id)) continue;
        rules.push(rule);
      }

      processedRules = rules.length;

      for (const [adapterId, enabled] of this.enabledTargets) {
        if (!enabled) continue;
        const adapter = this.adapters.get(adapterId);
        if (!adapter) continue;
        if (options.allowedTargets && options.allowedTargets.length > 0) {
          const name = adapter.name.toLowerCase();
          if (!options.allowedTargets.map((t) => t.toLowerCase()).includes(name)) continue;
        }

        if (adapter.compileAll) {
          results.push(...(await this.compileAllForAdapter(adapter, rules, workspaceRoot, conflictMode, state)));
          continue;
        }

        for (const rule of rules) {
          results.push(await this.compileToTarget(rule, adapter.name, workspaceRoot, conflictMode, state));
        }
      }

      const successCount = results.filter((r) => r.success).length;
      vscode.window.showInformationMessage(`Synapse: Synced ${processedRules} rule(s) to ${successCount} output(s)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "SYNC_CANCELED") {
        vscode.window.showInformationMessage("Sync canceled.");
        return results;
      }
      vscode.window.showErrorMessage(`Sync failed: ${msg}`);
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

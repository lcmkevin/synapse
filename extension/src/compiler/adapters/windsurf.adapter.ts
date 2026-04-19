import * as path from "path";
import { IDEAdapter, SynapseRule } from "./adapter.interface";

export class WindsurfAdapter implements IDEAdapter {
  id = "windsurf-v1";
  name = "Windsurf";
  version = "1.0.0";
  sourceExtension = ".synapse";
  targetExtension = ".windsurfrules";
  targetFolder = ".windsurf/";

  async compile(rule: SynapseRule, options: { minify?: boolean } = {}): Promise<string> {
    const payload = {
      name: rule.name,
      description: rule.description || "",
      content: options.minify ? rule.content.trim() : rule.content,
      constraints: (rule.constraints || []).map((c) => c.replace(/^@constraint\s+/i, "").trim()).filter(Boolean),
      skills: (rule.skills || []).map((s) => s.replace(/^@skill\s+/i, "").trim()).filter(Boolean),
    };
    return JSON.stringify(payload, null, options.minify ? 0 : 2);
  }

  async parse(content: string, filePath: string): Promise<SynapseRule> {
    let json: any = null;
    try {
      json = JSON.parse(content);
    } catch {
      json = null;
    }

    const now = new Date();
    const id = path.basename(filePath, path.extname(filePath));
    const name = (json?.name || id).toString();
    const description = json?.description ? String(json.description) : undefined;
    const ruleContent = json?.content ? String(json.content) : content;
    const constraints = Array.isArray(json?.constraints) ? json.constraints.map((c: any) => `@constraint ${String(c)}`) : [];
    const skills = Array.isArray(json?.skills) ? json.skills.map((s: any) => `@skill ${String(s)}`) : [];

    return {
      id,
      name,
      description,
      content: ruleContent.trim(),
      constraints,
      skills,
      metadata: {
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
    };
  }

  async validate(compiled: string): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    try {
      JSON.parse(compiled);
    } catch {
      errors.push("Invalid JSON format");
    }
    return { valid: errors.length === 0, errors };
  }

  getInstallInstructions(): string {
    return "Windsurf reads .windsurfrules JSON files from the .windsurf/ folder.";
  }
}


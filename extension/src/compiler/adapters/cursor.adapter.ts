// NEW: Cursor adapter (v2)

import * as path from "path";
import { IDEAdapter, SynapseRule } from "./adapter.interface";

export class CursorAdapter implements IDEAdapter {
  id = "cursor-v2";
  name = "Cursor";
  version = "2.0.0";
  targetExtension = ".mdc";
  targetFolder = ".cursor/rules/";

  async compile(rule: SynapseRule, options: { minify?: boolean } = {}): Promise<string> {
    const parts: string[] = [];

    parts.push("---");
    parts.push(`description: ${rule.description || rule.name}`);
    const globs = rule.constraints?.length ? rule.constraints.map((c) => c.replace(/^@constraint\s+/, "").trim()).join(", ") : "**/*";
    parts.push(`globs: ${globs}`);
    parts.push("---");
    parts.push("");
    parts.push(options.minify ? rule.content.trim() : rule.content);

    if (rule.skills?.length) {
      parts.push("");
      parts.push("## Skills");
      for (const s of rule.skills) parts.push(`- ${s}`);
    }

    return parts.join("\n");
  }

  async parse(content: string, filePath: string): Promise<SynapseRule> {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter: Record<string, string> = {};

    if (frontmatterMatch) {
      for (const line of frontmatterMatch[1].split("\n")) {
        const [key, ...value] = line.split(":");
        if (key && value.length) frontmatter[key.trim()] = value.join(":").trim();
      }
    }

    const cleanContent = content.replace(/^---\n[\s\S]*?\n---/, "").trim();
    const now = new Date();

    return {
      id: path.basename(filePath, path.extname(filePath)),
      name: frontmatter.description || path.basename(filePath, path.extname(filePath)),
      description: frontmatter.description,
      content: cleanContent,
      constraints: frontmatter.globs ? frontmatter.globs.split(",").map((g) => `@constraint ${g.trim()}`) : [],
      skills: [],
      metadata: {
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
    };
  }

  async validate(compiled: string): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (!compiled.includes("---")) errors.push("Missing YAML frontmatter");
    return { valid: errors.length === 0, errors };
  }

  getInstallInstructions(): string {
    return "Create .cursor/rules/ folder. Cursor loads .mdc files automatically.";
  }
}


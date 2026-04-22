import { IDEAdapter, SynapseRule, AdapterOutput } from "./adapter.interface";

export class ZedAdapter implements IDEAdapter {
  id = "zed-v1";
  name = "Zed";
  version = "1.0.0";
  targetExtension = ".rules";
  targetFolder = "";

  async compile(rule: SynapseRule, options: { minify?: boolean } = {}): Promise<string> {
    const parts: string[] = [];
    parts.push(`## ${rule.name}`);
    parts.push("");
    if (rule.description) {
      parts.push(rule.description);
      parts.push("");
    }
    parts.push(options.minify ? rule.content.trim() : rule.content);
    parts.push("");
    if (rule.constraints?.length) {
      parts.push("Constraints:");
      for (const c of rule.constraints) parts.push(`- ${c.replace(/^@constraint\\s+/i, "").trim()}`);
      parts.push("");
    }
    if (rule.skills?.length) {
      parts.push("Skills:");
      for (const s of rule.skills) parts.push(`- ${s.replace(/^@skill\\s+/i, "").trim()}`);
      parts.push("");
    }
    return parts.join("\n").trimEnd();
  }

  async compileAll(rules: SynapseRule[], options: { minify?: boolean } = {}): Promise<AdapterOutput[]> {
    const blocks: string[] = [];
    blocks.push("# Synapse Rules (.rules)");
    blocks.push("");
    blocks.push("Generated from .synapse/rules/*.synapse");
    blocks.push("");

    for (const rule of rules) {
      const block = await this.compile(rule, options);
      blocks.push(block);
      blocks.push("");
    }

    return [{ relativePath: ".rules", content: blocks.join("\n").trimEnd() + "\n" }];
  }

  async parse(_content: string, filePath: string): Promise<SynapseRule> {
    const now = new Date();
    return {
      id: filePath,
      name: filePath,
      content: "",
      constraints: [],
      skills: [],
      metadata: { createdAt: now, updatedAt: now, version: 1 },
    };
  }

  async validate(compiled: string): Promise<{ valid: boolean; errors?: string[] }> {
    const ok = typeof compiled === "string" && compiled.trim().length > 0;
    return ok ? { valid: true } : { valid: false, errors: ["Empty output"] };
  }

  getInstallInstructions(): string {
    return "Zed reads .rules at the project root and auto-includes it in Agent context.";
  }
}


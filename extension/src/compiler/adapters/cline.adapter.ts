import * as path from "path";
import { IDEAdapter, SynapseRule } from "./adapter.interface";

export class ClineAdapter implements IDEAdapter {
  id = "cline-v1";
  name = "Cline";
  version = "1.0.0";
  sourceExtension = ".synapse";
  targetExtension = ".md";
  targetFolder = ".clinerules/";

  async compile(rule: SynapseRule, options: { minify?: boolean } = {}): Promise<string> {
    const lines: string[] = [];

    lines.push(`# ${rule.name}`);
    lines.push("");

    if (rule.description) {
      lines.push(rule.description);
      lines.push("");
    }

    lines.push(options.minify ? rule.content.trim() : rule.content);
    lines.push("");

    if (rule.constraints && rule.constraints.length > 0) {
      lines.push("## Constraints");
      lines.push("");
      for (const constraint of rule.constraints) {
        const cleanConstraint = constraint.replace("@constraint ", "").trim();
        lines.push(`- ${cleanConstraint}`);
      }
      lines.push("");
    }

    if (rule.skills && rule.skills.length > 0) {
      lines.push("## Skills");
      lines.push("");
      for (const skill of rule.skills) {
        const cleanSkill = skill.replace("@skill ", "").trim();
        lines.push(`- ${cleanSkill}`);
      }
    }

    let output = lines.join("\n");
    if (options.minify) output = output.replace(/\n{3,}/g, "\n\n");
    return output;
  }

  async parse(content: string, filePath: string): Promise<SynapseRule> {
    const lines = content.split("\n");

    let name = path.basename(filePath, ".md");
    const nameMatch = content.match(/^#\s+(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim();

    let description = "";
    let mainContent = "";
    const constraints: string[] = [];
    const skills: string[] = [];

    let inConstraints = false;
    let inSkills = false;
    let inDescription = true;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (i === 0 && line.startsWith("# ")) continue;

      if (line.trim() === "## Constraints") {
        inConstraints = true;
        inSkills = false;
        inDescription = false;
        continue;
      }

      if (line.trim() === "## Skills") {
        inConstraints = false;
        inSkills = true;
        inDescription = false;
        continue;
      }

      if (inConstraints && line.trim().startsWith("-")) {
        const constraint = line.trim().substring(1).trim();
        if (constraint) constraints.push(`@constraint ${constraint}`);
        continue;
      }

      if (inSkills && line.trim().startsWith("-")) {
        const skill = line.trim().substring(1).trim();
        if (skill) skills.push(`@skill ${skill}`);
        continue;
      }

      if (inConstraints && line.trim() !== "" && !line.trim().startsWith("-")) inConstraints = false;
      if (inSkills && line.trim() !== "" && !line.trim().startsWith("-")) inSkills = false;

      if (inDescription && line.trim() && !line.startsWith("#")) {
        description = line.trim();
        inDescription = false;
        continue;
      }

      if (!inConstraints && !inSkills && !line.startsWith("##")) {
        if (line.trim() || mainContent) mainContent += `${line}\n`;
      }
    }

    const now = new Date();
    return {
      id: path.basename(filePath, ".md"),
      name,
      description: description || undefined,
      content: mainContent.trim(),
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
    if (!compiled.trim()) errors.push("Empty rule content");
    if (!/^#\s+/m.test(compiled)) errors.push("Missing rule title (H1 heading)");
    return { valid: errors.length === 0, errors };
  }

  getInstallInstructions(): string {
    return "Cline reads .md files from .clinerules/ folder.";
  }
}


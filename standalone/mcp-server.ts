#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

type SynapseRule = {
  id: string;
  name: string;
  description?: string;
  content: string;
  constraints?: string[];
  skills?: string[];
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    version: number;
  };
};

const SyncTargetSchema = z.enum(["trae", "cursor", "windsurf", "cline", "all"]);
const SyncOptionsSchema = z.object({
  target: SyncTargetSchema,
  workspace: z.string().optional(),
  minify: z.boolean().optional(),
});

const AnalyzeSchema = z.object({
  workspace: z.string().optional(),
});

const InitSchema = z.object({
  workspace: z.string().optional(),
});

const ListRulesSchema = z.object({
  workspace: z.string().optional(),
});

const CreateRuleSchema = z.object({
  name: z.string(),
  content: z.string().optional(),
  workspace: z.string().optional(),
});

const server = new Server(
  { name: "synapse-mcp", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

const TOOL_DEFS = [
  {
    name: "synapse_init",
    description: "Initialize Synapse in a workspace. Creates .synapse/ folder with example rules.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Path to workspace (defaults to current directory)" },
      },
    },
  },
  {
    name: "synapse_sync",
    description: "Compile Synapse rules to target IDE format (Trae, Cursor, Windsurf, Cline, or all)",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["trae", "cursor", "windsurf", "cline", "all"], description: "Target IDE to sync rules to" },
        workspace: { type: "string", description: "Path to workspace (defaults to current directory)" },
        minify: { type: "boolean", description: "Remove leading/trailing whitespace from output" },
      },
      required: ["target"],
    },
  },
  {
    name: "synapse_analyze",
    description: "Analyze token usage across all Synapse rules (rough estimate).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Path to workspace" },
      },
    },
  },
  {
    name: "synapse_list_rules",
    description: "List all Synapse rules in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Path to workspace" },
      },
    },
  },
  {
    name: "synapse_create_rule",
    description: "Create a new Synapse rule file.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Rule name (without extension)" },
        content: { type: "string", description: "Rule content" },
        workspace: { type: "string", description: "Path to workspace" },
      },
      required: ["name"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "synapse_init":
        return await handleInit(args);
      case "synapse_sync":
        return await handleSync(args);
      case "synapse_analyze":
        return await handleAnalyze(args);
      case "synapse_list_rules":
        return await handleListRules(args);
      case "synapse_create_rule":
        return await handleCreateRule(args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }], isError: true };
  }
});

function workspaceDir(raw?: string): string {
  const w = typeof raw === "string" && raw.trim() ? raw.trim() : process.cwd();
  return path.isAbsolute(w) ? w : path.resolve(process.cwd(), w);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function extractRuleName(content: string, fallback: string): string {
  const nameMatch = content.match(/^# Rule:\s*(.+)$/m);
  const name = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "";
  return name || fallback;
}

function extractDescription(content: string): string | undefined {
  const m = content.match(/^# Description:\s*(.+)$/m);
  const v = m && m[1] ? m[1].trim() : "";
  return v || undefined;
}

function extractList(content: string, token: "# @constraint" | "# @skill"): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const idx = line.indexOf(token);
    if (idx >= 0) out.push(line.slice(idx + token.length).trim());
  }
  return out;
}

function cleanRuleBody(content: string): string {
  return content
    .split("\n")
    .filter((l) => !l.startsWith("# Rule:"))
    .filter((l) => !l.startsWith("# Description:"))
    .filter((l) => !l.startsWith("# Constraints:"))
    .filter((l) => !l.startsWith("# @constraint"))
    .filter((l) => !l.startsWith("# Skills:"))
    .filter((l) => !l.startsWith("# @skill"))
    .join("\n")
    .trim();
}

function parseSynapseRule(content: string, filePath: string): SynapseRule {
  const id = path.basename(filePath, path.extname(filePath));
  const name = extractRuleName(content, id);
  const description = extractDescription(content);
  const constraints = extractList(content, "# @constraint");
  const skills = extractList(content, "# @skill");
  const body = cleanRuleBody(content);
  const now = new Date();
  return {
    id,
    name,
    description,
    content: body,
    constraints,
    skills,
    metadata: { createdAt: now, updatedAt: now, version: 1 },
  };
}

function compileTrae(rule: SynapseRule, minify?: boolean): string {
  const lines: string[] = [];
  lines.push(`# Generated by Synapse from ${rule.name}`);
  lines.push(`# Rule: ${rule.name}`);
  if (rule.description) lines.push(`# Description: ${rule.description}`);
  lines.push("");
  if (rule.constraints && rule.constraints.length) {
    lines.push("# Constraints:");
    for (const c of rule.constraints) lines.push(`# @constraint ${c}`);
    lines.push("");
  }
  lines.push(minify ? rule.content.trim() : rule.content);
  lines.push("");
  if (rule.skills && rule.skills.length) {
    lines.push("# Skills:");
    for (const s of rule.skills) lines.push(`# @skill ${s}`);
  }
  return lines.join("\n");
}

function compileCursor(rule: SynapseRule, minify?: boolean): string {
  const parts: string[] = [];
  parts.push("---");
  parts.push(`description: ${rule.description || rule.name}`);
  const globs = rule.constraints && rule.constraints.length ? rule.constraints.join(", ") : "**/*";
  parts.push(`globs: ${globs}`);
  parts.push("---");
  parts.push("");
  parts.push(minify ? rule.content.trim() : rule.content);
  if (rule.skills && rule.skills.length) {
    parts.push("");
    parts.push("## Skills");
    for (const s of rule.skills) parts.push(`- ${s}`);
  }
  return parts.join("\n");
}

function getTargetFolder(target: string): string {
  const folders: Record<string, string> = {
    trae: ".trae",
    cursor: path.join(".cursor", "rules"),
    windsurf: ".windsurf",
    cline: ".cline",
  };
  return folders[target] || path.join(".synapse", "output");
}

function getTargetExtension(target: string): string {
  const extensions: Record<string, string> = {
    trae: ".trae",
    cursor: ".mdc",
    windsurf: ".windsurfrules",
    cline: ".xml",
  };
  return extensions[target] || ".txt";
}

async function handleInit(args: unknown) {
  const parsed = InitSchema.safeParse(args);
  const workDir = workspaceDir(parsed.success ? parsed.data.workspace : undefined);
  const synapsePath = path.join(workDir, ".synapse");

  if (await pathExists(synapsePath)) {
    return { content: [{ type: "text", text: `Synapse already initialized at ${synapsePath}` }] };
  }

  await fs.mkdir(path.join(synapsePath, "rules"), { recursive: true });
  await fs.mkdir(path.join(synapsePath, "skills"), { recursive: true });

  const config = { version: "1.0", masterPath: ".synapse/", createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(synapsePath, "config.json"), JSON.stringify(config, null, 2), "utf8");

  const exampleRule = `# Rule: Example Rule
# Description: This is an example Synapse rule

Always write clean, documented code
Use meaningful variable names
Follow project coding standards

# Constraints:
# @constraint **/*.ts
# @constraint **/*.tsx
# @constraint !**/*.test.ts

# Skills:
# @skill code-review
# @skill refactor
`;
  await fs.writeFile(path.join(synapsePath, "rules", "example.synapse"), exampleRule, "utf8");

  return {
    content: [
      { type: "text", text: `✅ Synapse initialized at ${synapsePath}\nCreated: .synapse/rules/example.synapse` },
    ],
  };
}

async function handleSync(args: unknown) {
  const parsed = SyncOptionsSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
  }

  const { target, workspace, minify } = parsed.data;
  const workDir = workspaceDir(workspace);
  const synapsePath = path.join(workDir, ".synapse");
  if (!(await pathExists(synapsePath))) {
    return { content: [{ type: "text", text: "Synapse not initialized. Run synapse_init first." }], isError: true };
  }

  const rulesPath = path.join(synapsePath, "rules");
  if (!(await pathExists(rulesPath))) {
    return { content: [{ type: "text", text: `No rules folder found: ${rulesPath}` }], isError: true };
  }

  const allFiles = await fs.readdir(rulesPath).catch(() => []);
  const ruleFiles = allFiles.filter((f) => String(f).toLowerCase().endsWith(".synapse"));
  if (ruleFiles.length === 0) {
    return { content: [{ type: "text", text: `No .synapse files found in ${rulesPath}` }] };
  }

  const targets = target === "all" ? ["trae", "cursor"] : [target];
  const results: string[] = [];

  for (const t of targets) {
    if (t !== "trae" && t !== "cursor") {
      results.push(`⚠️ ${t}: not implemented (skipped)`);
      continue;
    }

    const targetPath = path.join(workDir, getTargetFolder(t));
    await fs.mkdir(targetPath, { recursive: true });

    for (const file of ruleFiles) {
      const inPath = path.join(rulesPath, file);
      const content = await fs.readFile(inPath, "utf8");
      const rule = parseSynapseRule(content, inPath);
      const compiled = t === "trae" ? compileTrae(rule, minify) : compileCursor(rule, minify);
      const outFile = path.join(targetPath, `${rule.id}${getTargetExtension(t)}`);
      await fs.writeFile(outFile, compiled, "utf8");
      results.push(`✅ ${t}: ${outFile}`);
    }
  }

  return {
    content: [
      {
        type: "text",
        text: `Synced ${ruleFiles.length} rule(s) to ${target === "all" ? "all IDEs" : target}:\n${results.join("\n")}`,
      },
    ],
  };
}

async function handleAnalyze(args: unknown) {
  const parsed = AnalyzeSchema.safeParse(args);
  const workDir = workspaceDir(parsed.success ? parsed.data.workspace : undefined);
  const rulesPath = path.join(workDir, ".synapse", "rules");

  if (!(await pathExists(rulesPath))) {
    return { content: [{ type: "text", text: "No rules found. Run synapse_init first." }] };
  }

  const files = await fs.readdir(rulesPath).catch(() => []);
  const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));
  if (ruleFiles.length === 0) {
    return { content: [{ type: "text", text: "No rules found. Run synapse_init to create an example." }] };
  }

  let totalTokens = 0;
  const ruleTokens: { name: string; tokens: number; lines: number }[] = [];

  for (const file of ruleFiles) {
    const content = await fs.readFile(path.join(rulesPath, file), "utf8");
    const tokens = Math.ceil(content.length / 4);
    const lines = content.split("\n").length;
    totalTokens += tokens;
    ruleTokens.push({ name: file, tokens, lines });
  }

  const avg = Math.round(totalTokens / Math.max(1, ruleFiles.length));
  const breakdown = ruleTokens.map((r) => `  - ${r.name}: ~${r.tokens.toLocaleString()} tokens (${r.lines} lines)`).join("\n");
  const suggestion = totalTokens > 10000 ? "Consider splitting large rules or using lazy-loaded skills." : "Token usage looks reasonable.";

  const out = [
    "📊 Synapse Token Analysis",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `Total rules: ${ruleFiles.length}`,
    `Total tokens: ~${totalTokens.toLocaleString()}`,
    `Average per rule: ~${avg.toLocaleString()}`,
    "",
    "📄 Rule breakdown:",
    breakdown,
    "",
    `💡 Suggestion: ${suggestion}`,
  ].join("\n");

  return { content: [{ type: "text", text: out }] };
}

async function handleListRules(args: unknown) {
  const parsed = ListRulesSchema.safeParse(args);
  const workDir = workspaceDir(parsed.success ? parsed.data.workspace : undefined);
  const rulesPath = path.join(workDir, ".synapse", "rules");

  if (!(await pathExists(rulesPath))) {
    return { content: [{ type: "text", text: "No .synapse folder found. Run synapse_init first." }] };
  }

  const files = await fs.readdir(rulesPath).catch(() => []);
  const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));
  if (ruleFiles.length === 0) {
    return { content: [{ type: "text", text: 'No rules found. Run synapse_init to create an example.' }] };
  }

  return {
    content: [{ type: "text", text: `📁 Rules in ${rulesPath}:\n${ruleFiles.map((f) => `  - ${f}`).join("\n")}` }],
  };
}

async function handleCreateRule(args: unknown) {
  const parsed = CreateRuleSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
  }

  const workDir = workspaceDir(parsed.data.workspace);
  const rulesPath = path.join(workDir, ".synapse", "rules");
  if (!(await pathExists(rulesPath))) {
    return { content: [{ type: "text", text: "Synapse not initialized. Run synapse_init first." }], isError: true };
  }

  const nameRaw = parsed.data.name.trim();
  const fileName = nameRaw.toLowerCase().endsWith(".synapse") ? nameRaw : `${nameRaw}.synapse`;
  const filePath = path.join(rulesPath, fileName);

  const defaultContent =
    parsed.data.content ||
    `# Rule: ${nameRaw}\n# Description: Add description here\n\n# Your rule content here\n\n# Constraints:\n# @constraint **/*\n\n# Skills:\n`;

  await fs.writeFile(filePath, defaultContent, "utf8");
  return { content: [{ type: "text", text: `✅ Created rule: ${filePath}` }] };
}

async function main() {
  const firstChunk = await new Promise<Buffer>((resolve) => {
    process.stdin.once("data", (b) => resolve(Buffer.isBuffer(b) ? b : Buffer.from(String(b))));
  });

  const firstText = firstChunk.toString("utf8");
  if (!firstText.includes("Content-Length:") && firstText.trim().startsWith("{")) {
    const req = JSON.parse(firstText.trim());
    const id = req && typeof req.id !== "undefined" ? req.id : null;
    if (req && req.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported method" } }) + "\n");
    return;
  }

  process.stdin.unshift(firstChunk);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Synapse MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

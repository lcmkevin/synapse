const fs = require("fs-extra");
const path = require("path");

function approximateTokenCount(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return 0;
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x7f) asciiCount++;
    else nonAsciiCount++;
  }
  const approx = asciiCount / 4 + nonAsciiCount;
  const rounded = Math.ceil(approx);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
}

function safeSplitLines(content) {
  return String(content || "").split(/\r?\n/);
}

class LocalOptimizer {
  constructor(options) {
    this.options = options || {};
    this.maxRecommendedTokens = Number.isFinite(this.options.maxRecommendedTokens) ? this.options.maxRecommendedTokens : 2000;
    this.tokenWasteThreshold = Number.isFinite(this.options.tokenWasteThreshold) ? this.options.tokenWasteThreshold : 5000;
    this.encoder = null;
  }

  countTokens(content) {
    const text = typeof content === "string" ? content : "";
    const encoder = this.getEncoder();
    if (!encoder) return approximateTokenCount(text);
    try {
      const tokens = encoder.encode(text);
      const tokenCount =
        tokens && typeof tokens.length === "number" ? tokens.length : Array.isArray(tokens) ? tokens.length : approximateTokenCount(text);
      return Number.isFinite(tokenCount) ? tokenCount : approximateTokenCount(text);
    } catch {
      return approximateTokenCount(text);
    }
  }

  getEncoder() {
    if (this.encoder) return this.encoder;
    try {
      const { encoding_for_model, get_encoding } = require("tiktoken");
      try {
        this.encoder = encoding_for_model("gpt-4o");
        return this.encoder;
      } catch {
        try {
          this.encoder = get_encoding("o200k_base");
          return this.encoder;
        } catch {
          this.encoder = get_encoding("cl100k_base");
          return this.encoder;
        }
      }
    } catch {
      return null;
    }
  }

  async analyzeRule(content, ruleName) {
    const issues = [];
    const lines = safeSplitLines(content);
    const tokenCount = this.countTokens(content);

    if (tokenCount > this.tokenWasteThreshold) {
      issues.push({
        ruleName,
        severity: "warning",
        type: "token_waste",
        message: `Rule has ${tokenCount.toLocaleString()} tokens (recommended <${this.maxRecommendedTokens})`,
        suggestion: "Split into smaller rules or convert to lazy-loaded skill",
        estimatedSavings: Math.max(0, tokenCount - this.maxRecommendedTokens),
        autoFixable: true,
      });
    }

    const commentLines = lines.filter((l) => l.trim().startsWith("#")).length;
    const contentLines = lines.filter((l) => !l.trim().startsWith("#") && l.trim().length > 0).length;
    if (contentLines > 0 && commentLines > contentLines * 2) {
      issues.push({
        ruleName,
        severity: "info",
        type: "structure",
        message: `High comment-to-content ratio (${commentLines} comments, ${contentLines} content lines)`,
        suggestion: "Move verbose documentation to a separate doc or skill description",
        estimatedSavings: Math.floor(tokenCount * 0.2),
        autoFixable: false,
      });
    }

    const constraints = String(content || "").match(/#\s*@constraint\s+(.+)/g) || [];
    const uniqueConstraints = new Set(constraints.map((c) => c.trim()));
    if (constraints.length > uniqueConstraints.size) {
      issues.push({
        ruleName,
        severity: "warning",
        type: "redundancy",
        message: `Duplicate constraints found (${constraints.length - uniqueConstraints.size} duplicates)`,
        suggestion: "Remove duplicate constraint lines",
        estimatedSavings: 0,
        autoFixable: true,
      });
    }

    if (constraints.length === 0 && contentLines > 5) {
      issues.push({
        ruleName,
        severity: "info",
        type: "missing_constraint",
        message: "Rule has no constraints (applies to ALL files)",
        suggestion: "Add file constraints (e.g., # @constraint **/*.ts) to limit token usage",
        estimatedSavings: 0,
        autoFixable: false,
      });
    }

    return issues;
  }

  async findConflicts(allRules) {
    const conflicts = [];
    const contradictions = [
      { a: "never use", b: "always use" },
      { a: "avoid", b: "use" },
      { a: "do not", b: "must" },
      { a: "forbidden", b: "required" },
      { a: "don't", b: "always" },
    ];

    for (let i = 0; i < allRules.length; i++) {
      const aText = String(allRules[i]?.content || "").toLowerCase();
      for (let j = i + 1; j < allRules.length; j++) {
        const bText = String(allRules[j]?.content || "").toLowerCase();
        for (const contra of contradictions) {
          const hasA = aText.includes(contra.a) && bText.includes(contra.b);
          const hasB = aText.includes(contra.b) && bText.includes(contra.a);
          if (!hasA && !hasB) continue;
          conflicts.push({
            ruleName: `${allRules[i].name} ↔ ${allRules[j].name}`,
            severity: "warning",
            type: "conflict",
            message: `Potential conflict: "${contra.a}" vs "${contra.b}"`,
            suggestion: "Review and merge or resolve contradiction",
            estimatedSavings: 0,
            autoFixable: false,
          });
        }
      }
    }

    return conflicts;
  }

  async analyzeAllRules(rulesPath) {
    const files = await fs.readdir(rulesPath).catch(() => []);
    const ruleFiles = files.filter((f) => String(f).toLowerCase().endsWith(".synapse"));

    const allIssues = [];
    let totalTokens = 0;
    const ruleContents = [];

    for (const file of ruleFiles) {
      const content = await fs.readFile(path.join(rulesPath, file), "utf8");
      const tokenCount = this.countTokens(content);
      totalTokens += tokenCount;
      ruleContents.push({ name: file, content });
      const issues = await this.analyzeRule(content, file);
      allIssues.push(...issues);
    }

    const conflicts = await this.findConflicts(ruleContents);
    allIssues.push(...conflicts);

    const potentialSavings = allIssues.reduce((sum, i) => sum + (i.estimatedSavings || 0), 0);
    const fixableCount = allIssues.filter((i) => i.autoFixable).length;

    return {
      issues: allIssues,
      totalTokens,
      potentialSavings,
      fixableCount,
    };
  }

  async applyAutoFix(content, issues) {
    let optimized = String(content || "");

    for (const issue of issues) {
      if (!issue || !issue.autoFixable) continue;

      if (issue.type === "redundancy") {
        const lines = safeSplitLines(optimized);
        const seen = new Set();
        const deduped = lines.filter((line) => {
          const t = line.trim();
          if (!t.match(/^#\s*@constraint\s+/)) return true;
          if (seen.has(t)) return false;
          seen.add(t);
          return true;
        });
        optimized = deduped.join("\n");
      }
    }

    return optimized;
  }

  dispose() {
    const enc = this.encoder;
    this.encoder = null;
    try {
      if (enc && typeof enc.free === "function") enc.free();
    } catch {
      void 0;
    }
  }
}

module.exports = { LocalOptimizer };


import { encoding_for_model, get_encoding, TiktokenModel } from "tiktoken";
import * as vscode from "vscode";

export type AIModel = "gpt-4o" | "gpt-4.1" | "o4-mini" | "claude-sonnet" | "claude-opus";

export interface TokenCountResult {
  model: AIModel;
  tokenCount: number;
  estimatedCostUSD: number;
  characterCount: number;
  lineCount: number;
}

export interface RuleTokenBreakdown {
  ruleName: string;
  tokens: number;
  costUSD: number;
  percentageOfTotal: number;
  suggestion?: string;
}

const MODEL_RATES: Record<AIModel, number> = {
  "gpt-4o": 2.5,
  "gpt-4.1": 2.0,
  "o4-mini": 0.6,
  "claude-sonnet": 3.0,
  "claude-opus": 15.0,
};

function toTiktokenModel(model: AIModel): TiktokenModel {
  if (model === "claude-sonnet" || model === "claude-opus") return "gpt-4";
  if (model === "gpt-4.1") return "gpt-4";
  if (model === "o4-mini") return "gpt-4o";
  return model as unknown as TiktokenModel;
}

export class TokenCounter {
  private encoderCache: Map<AIModel, any> = new Map();

  private getEncoder(model: AIModel) {
    const cached = this.encoderCache.get(model);
    if (cached) return cached;

    const mapped = toTiktokenModel(model);
    let enc: any;
    try {
      enc = encoding_for_model(mapped);
    } catch {
      try {
        enc = get_encoding("o200k_base");
      } catch {
        enc = get_encoding("cl100k_base");
      }
    }

    this.encoderCache.set(model, enc);
    return enc;
  }

  countTokens(text: string, model: AIModel = "gpt-4o"): TokenCountResult {
    const characterCount = text.length;
    const lineCount = text.split("\n").length;
    try {
      const encoder = this.getEncoder(model);
      const tokens = encoder.encode(text);
      const tokenCount = Array.isArray(tokens) ? tokens.length : 0;
      const estimatedCostUSD = (tokenCount / 1_000_000) * MODEL_RATES[model];

      return { model, tokenCount, estimatedCostUSD, characterCount, lineCount };
    } catch {
      const tokenCount = this.approximateTokenCount(text);
      const estimatedCostUSD = (tokenCount / 1_000_000) * MODEL_RATES[model];
      return { model, tokenCount, estimatedCostUSD, characterCount, lineCount };
    }
  }

  private approximateTokenCount(text: string): number {
    if (!text) return 0;

    let asciiCount = 0;
    let nonAsciiCount = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code <= 0x7f) asciiCount++;
      else nonAsciiCount++;
    }

    const approx = asciiCount / 4 + nonAsciiCount;
    const rounded = Math.ceil(approx);
    return Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
  }

  analyzeRules(
    rules: { name: string; content: string }[],
    model: AIModel = "gpt-4o"
  ): { totalTokens: number; totalCost: number; breakdown: RuleTokenBreakdown[]; recommendations: string[] } {
    const breakdown: RuleTokenBreakdown[] = [];
    let totalTokens = 0;

    for (const rule of rules) {
      const result = this.countTokens(rule.content, model);
      totalTokens += result.tokenCount;
      breakdown.push({
        ruleName: rule.name,
        tokens: result.tokenCount,
        costUSD: result.estimatedCostUSD,
        percentageOfTotal: 0,
        suggestion: this.getSuggestion(rule.name, result.tokenCount),
      });
    }

    for (const item of breakdown) {
      item.percentageOfTotal = totalTokens > 0 ? (item.tokens / totalTokens) * 100 : 0;
    }

    const recommendations = this.generateRecommendations(breakdown, totalTokens);
    const totalCost = (totalTokens / 1_000_000) * MODEL_RATES[model];

    return { totalTokens, totalCost, breakdown, recommendations };
  }

  private getSuggestion(ruleName: string, tokenCount: number): string | undefined {
    if (tokenCount > 5000) return `Consider splitting ${ruleName} into multiple smaller rules or converting to lazy-loaded skill`;
    if (tokenCount > 2000) return `Consider reviewing ${ruleName} for unnecessary content`;
    return undefined;
  }

  private generateRecommendations(breakdown: RuleTokenBreakdown[], totalTokens: number): string[] {
    const recommendations: string[] = [];
    const largeRules = breakdown.filter((r) => r.tokens > 5000);

    if (largeRules.length > 0) {
      recommendations.push(
        `📊 Token Optimization: ${largeRules.length} rule(s) exceed 5K tokens. Converting to lazy-loaded skills could save ~${Math.round(
          totalTokens * 0.7
        ).toLocaleString()} tokens per session.`
      );
    }

    const ext = vscode.extensions.getExtension("lcmkevin.synapse");
    const exported = ext && ext.isActive ? ext.exports : undefined;
    const isPro =
      typeof exported?.isProUser === "function"
        ? !!exported.isProUser()
        : typeof exported?.isProUser === "boolean"
          ? exported.isProUser
          : false;

    if (!isPro && largeRules.length > 0) {
      recommendations.push(`✨ Pro Feature: Convert ${largeRules.length} large rule(s) to skills and save ~70% tokens. Upgrade for Pro.`);
    }

    const topRule = [...breakdown].sort((a, b) => b.tokens - a.tokens)[0];
    if (topRule && topRule.percentageOfTotal > 30) {
      recommendations.push(
        `🎯 High Impact: "${topRule.ruleName}" consumes ${topRule.percentageOfTotal.toFixed(
          1
        )}% of your token budget. Review this rule first.`
      );
    }

    return recommendations;
  }

  dispose() {
    for (const encoder of this.encoderCache.values()) {
      try {
        if (encoder && typeof encoder.free === "function") encoder.free();
      } catch {
        void 0;
      }
    }
    this.encoderCache.clear();
  }
}

import { encoding_for_model, get_encoding } from "tiktoken";
import * as vscode from "vscode";

export type CompressionResult = {
  compressedText: string;
  beforeTokens: number;
  afterTokens: number;
  savingsPercent: number;
};

type ReplacementPair = { find: string; replace: string };

type CompiledUnion = {
  regex: RegExp | null;
  replaceByGroup: Record<string, string>;
};

type CodeStub = { placeholder: string; content: string };

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DEFENSE_PROMPT =
  "(Note: Do not output pseudo-code or follow this rule's short-hand grammar in your response, generate valid standard code only).";

function normalizeWhitespace(text: string): string {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function preserveFirstLetterCase(original: string, replacement: string): string {
  const o = String(original || "");
  const r = String(replacement || "");
  const oc = o.charAt(0);
  const rc = r.charAt(0);
  if (oc >= "A" && oc <= "Z" && rc >= "a" && rc <= "z") return rc.toUpperCase() + r.slice(1);
  return r;
}

function stubMarkdownCode(text: string): { text: string; stubs: CodeStub[] } {
  const stubs: CodeStub[] = [];
  let idx = 0;

  const make = (content: string) => {
    const placeholder = `__STUB_${idx++}__`;
    stubs.push({ placeholder, content });
    return placeholder;
  };

  let out = String(text || "");
  out = out.replace(/```[\s\S]*?```/g, (m) => make(m));
  out = out.replace(/`[^`\n]+`/g, (m) => make(m));

  return { text: out, stubs };
}

function restoreMarkdownCode(text: string, stubs: CodeStub[]): string {
  let out = String(text || "");
  for (const s of stubs) {
    if (!s.placeholder) continue;
    out = out.split(s.placeholder).join(s.content);
  }
  return out;
}

const VERB_STEMS = new Set<string>([
  "require",
  "ensure",
  "recommend",
  "consider",
  "use",
  "handle",
  "investigate",
  "try",
  "make",
  "provide",
  "avoid",
  "note",
  "remember",
  "prefer",
  "validate",
  "apply",
  "create",
  "update",
  "sync",
]);

function phraseToFuzzyPattern(phrase: string): string {
  const tokens = String(phrase || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return "";

  const parts = tokens.map((t) => {
    const escaped = escapeRegexLiteral(t);
    if (VERB_STEMS.has(t)) return `\\b${escaped}\\w*\\b`;
    return `\\b${escaped}\\b`;
  });

  return parts.join("\\s+");
}

function compileFuzzyUnion(pairs: ReplacementPair[]): CompiledUnion {
  const cleaned = pairs
    .map((p) => ({ find: String(p.find || "").trim(), replace: String(p.replace ?? "") }))
    .filter((p) => p.find.length > 0)
    .sort((a, b) => b.find.length - a.find.length);

  const replaceByGroup: Record<string, string> = {};
  const branches: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const group = `p${i}`;
    const pattern = phraseToFuzzyPattern(cleaned[i].find);
    if (!pattern) continue;
    replaceByGroup[group] = cleaned[i].replace;
    branches.push(`(?<${group}>${pattern})`);
  }

  if (branches.length === 0) return { regex: null, replaceByGroup };
  return { regex: new RegExp(branches.join("|"), "gi"), replaceByGroup };
}

function applyUnion(text: string, dict: CompiledUnion): string {
  if (!dict.regex) return text;
  return text.replace(dict.regex, (...args: any[]) => {
    const groups = args && args.length > 0 ? args[args.length - 1] : null;
    if (groups && typeof groups === "object") {
      for (const k of Object.keys(groups)) {
        if (groups[k] !== undefined) {
          const repl = dict.replaceByGroup[k];
          return repl !== undefined ? preserveFirstLetterCase(String(args[0] || ""), repl) : args[0];
        }
      }
    }
    return args[0];
  });
}

function approximateTokenCount(text: string): number {
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

const FILLER_OPENINGS: string[] = [
  "i would like to ask you to",
  "i would like to ask",
  "i would like to",
  "i want to ask you to",
  "i want to ask",
  "i want you to",
  "i'd like to",
  "could you please",
  "can you please",
  "would you please",
  "please",
];

const FILLER_OPENING_REGEXES: RegExp[] = FILLER_OPENINGS.map((p) => {
  const pattern = phraseToFuzzyPattern(p);
  return pattern ? new RegExp(`^\\s*(?:${pattern})\\s+`, "i") : /^$/i;
});

function stripFillerOpenings(text: string): string {
  const lines = String(text || "").split(/\r?\n/);
  const outLines: string[] = [];

  for (const line of lines) {
    const segments = String(line || "").match(/[^.!?]+[.!?]?/g) || [line];
    const rebuilt: string[] = [];

    for (let seg of segments) {
      const trimmed = seg.trimStart();
      const openerIndex = FILLER_OPENING_REGEXES.findIndex((re) => re.test(trimmed));
      if (openerIndex >= 0) {
        seg = trimmed.replace(FILLER_OPENING_REGEXES[openerIndex], "");
        seg = seg.replace(/^\s*[,;:\-–—]+\s*/, "");
        seg = seg.trimStart();
      }
      rebuilt.push(seg);
    }

    outLines.push(rebuilt.join("").trimEnd());
  }

  return outLines.join("\n");
}

export class RuleCompressor {
  /**
   * Free-tier dictionary (40+ pairs). This always applies, even for Pro users.
   * Keep this list stable and conservative to avoid semantic changes.
   */
  static readonly FREE_DEFAULT_REPLACEMENTS: ReplacementPair[] = [
    { find: "please ensure that", replace: "ensure" },
    { find: "please make sure to", replace: "make sure to" },
    { find: "in order to", replace: "to" },
    { find: "you should always", replace: "always" },
    { find: "you are required to", replace: "must" },
    { find: "kindly provide", replace: "provide" },
    { find: "based on the information provided", replace: "based on data" },
    { find: "in the event that", replace: "if" },
    { find: "for the purpose of", replace: "for" },
    { find: "with reference to", replace: "about" },
    { find: "it is important to note that", replace: "note:" },
    { find: "do not under any circumstances", replace: "never" },
    { find: "keep in mind that", replace: "remember:" },
    { find: "it is highly recommended to", replace: "recommend:" },
    { find: "take into consideration", replace: "consider" },
    { find: "if and only if", replace: "iff" },
    { find: "in case of", replace: "if" },
    { find: "despite the fact that", replace: "although" },
    { find: "at the end of the day", replace: "finally" },
    { find: "as soon as possible", replace: "asap" },
    { find: "due to the fact that", replace: "because" },
    { find: "by means of", replace: "by" },
    { find: "at this point in time", replace: "now" },
    { find: "it goes without saying that", replace: "obviously" },
    { find: "with the exception of", replace: "except" },
    { find: "in close proximity to", replace: "near" },
    { find: "make an effort to", replace: "try to" },
    { find: "conduct an investigation into", replace: "investigate" },
    { find: "has the capability to", replace: "can" },
    { find: "is able to", replace: "can" },
    { find: "serves to", replace: "does" },
    { find: "utilized for", replace: "for" },
    { find: "in the near future", replace: "soon" },
    { find: "on a regular basis", replace: "regularly" },
    { find: "in possession of", replace: "has" },
    { find: "be responsible for", replace: "handle" },
    { find: "it is clear that", replace: "clearly" },
    { find: "it appears that", replace: "apparently" },
    { find: "most of the time", replace: "usually" },
    { find: "at the same time", replace: "while" },
    { find: "for example", replace: "e.g." },
    { find: "that is to say", replace: "i.e." },
    { find: "with regard to", replace: "about" },
    { find: "in addition to", replace: "plus" },
    { find: "as a result", replace: "so" },
    { find: "in other words", replace: "i.e." },
  ];

  private static encoder: any | null = null;
  private static compiledFree: CompiledUnion | null = null;

  async fetchLatestDictionary(): Promise<void> {
    return;
  }

  async applyCompression(text: string, _isPro: boolean): Promise<CompressionResult> {
    const raw = String(text || "");
    const beforeTokens = this.countTokens(raw);

    const stubbed = stubMarkdownCode(raw);
    let out = normalizeWhitespace(stripFillerOpenings(stubbed.text));
    out = this.applyFree(out);
    out = normalizeWhitespace(out);

    let afterTokens = this.countTokens(out);
    let savingsPercent = beforeTokens > 0 ? ((beforeTokens - afterTokens) / beforeTokens) * 100 : 0;

    if (savingsPercent < 5) {
      const lm = await this.compressWithNativeLM(stubbed.text);
      if (lm) {
        const lmText = normalizeWhitespace(stripFillerOpenings(lm));
        const lmAfter = this.countTokens(lmText);
        const lmSavings = beforeTokens > 0 ? ((beforeTokens - lmAfter) / beforeTokens) * 100 : 0;
        if (Number.isFinite(lmSavings) && lmSavings > savingsPercent) {
          out = lmText;
          afterTokens = lmAfter;
          savingsPercent = lmSavings;
        }
      }
    }

    out = restoreMarkdownCode(out, stubbed.stubs);
    if (!out.endsWith(DEFENSE_PROMPT)) {
      out = (out ? out.replace(/\s+$/, "") + "\n" : "") + DEFENSE_PROMPT;
    }
    out = normalizeWhitespace(out);

    afterTokens = this.countTokens(out);
    savingsPercent = beforeTokens > 0 ? ((beforeTokens - afterTokens) / beforeTokens) * 100 : 0;

    return {
      compressedText: out,
      beforeTokens,
      afterTokens,
      savingsPercent: Number.isFinite(savingsPercent) ? Math.max(0, savingsPercent) : 0,
    };
  }

  private applyFree(text: string): string {
    if (!RuleCompressor.compiledFree) {
      RuleCompressor.compiledFree = compileFuzzyUnion(RuleCompressor.FREE_DEFAULT_REPLACEMENTS);
    }
    return applyUnion(text, RuleCompressor.compiledFree);
  }

  private async compressWithNativeLM(text: string): Promise<string | null> {
    const lmApi: any = (vscode as any).lm;
    const msgApi: any = (vscode as any).LanguageModelChatMessage;
    if (!lmApi || typeof lmApi.selectChatModels !== "function" || !msgApi || typeof msgApi.User !== "function") return null;

    let model: any = null;
    try {
      const models = await lmApi.selectChatModels({ vendor: "copilot", family: "gpt-4o" });
      model = Array.isArray(models) ? models[0] : null;
    } catch {
      model = null;
    }
    if (!model || typeof model.sendRequest !== "function") return null;

    const systemPrompt = "Act as a prompt compressor. Remove fluff, greetings, and filler words from the following rule. Keep it strictly imperative.";
    const messages = [msgApi.User(systemPrompt), msgApi.User(String(text || ""))];

    const cts = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => {
      try {
        cts.cancel();
      } catch {
        void 0;
      }
    }, 4000);

    try {
      const resp = await model.sendRequest(messages, {}, cts.token);
      let out = "";
      if (resp && resp.text && Symbol.asyncIterator in resp.text) {
        for await (const fragment of resp.text) out += fragment;
      } else if (typeof resp?.text === "string") {
        out = resp.text;
      }
      return out && typeof out === "string" ? out : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      try {
        cts.dispose();
      } catch {
        void 0;
      }
    }
  }

  private countTokens(text: string): number {
    try {
      if (!RuleCompressor.encoder) {
        try {
          RuleCompressor.encoder = encoding_for_model("gpt-4o" as any);
        } catch {
          try {
            RuleCompressor.encoder = get_encoding("o200k_base");
          } catch {
            RuleCompressor.encoder = get_encoding("cl100k_base");
          }
        }
      }
      const tokens = RuleCompressor.encoder.encode(text);
      const n = tokens && typeof tokens.length === "number" ? tokens.length : Array.isArray(tokens) ? tokens.length : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return approximateTokenCount(text);
    }
  }
}

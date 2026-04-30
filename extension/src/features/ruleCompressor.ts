import { encoding_for_model, get_encoding } from "tiktoken";

export type CompressionResult = {
  compressedText: string;
  beforeTokens: number;
  afterTokens: number;
  savingsPercent: number;
};

type ReplacementPair = { find: string; replace: string };

type CompiledDictionary = {
  regex: RegExp | null;
  lookup: Map<string, string>;
};

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWhitespace(text: string): string {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function compileUnionDictionary(pairs: ReplacementPair[]): CompiledDictionary {
  const lookup = new Map<string, string>();
  const escaped = pairs
    .map((p) => ({ find: String(p.find || "").trim().toLowerCase(), replace: String(p.replace ?? "") }))
    .filter((p) => p.find.length > 0)
    .sort((a, b) => b.find.length - a.find.length)
    .map((p) => {
      lookup.set(p.find, p.replace);
      return escapeRegexLiteral(p.find);
    });

  if (escaped.length === 0) return { regex: null, lookup };
  const union = `\\b(${escaped.join("|")})\\b`;
  return { regex: new RegExp(union, "gi"), lookup };
}

function applyUnion(text: string, dict: CompiledDictionary): string {
  if (!dict.regex) return text;
  return text.replace(dict.regex, (matched) => {
    const key = matched.toLowerCase();
    const replacement = dict.lookup.get(key);
    return replacement !== undefined ? replacement : matched;
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
  private static compiledFree: CompiledDictionary | null = null;

  async fetchLatestDictionary(): Promise<void> {
    return;
  }

  applyCompression(text: string, _isPro: boolean): CompressionResult {
    const raw = String(text || "");
    const beforeTokens = this.countTokens(raw);

    let out = normalizeWhitespace(raw);
    out = this.applyFree(out);
    out = normalizeWhitespace(out);

    const afterTokens = this.countTokens(out);
    const savingsPercent = beforeTokens > 0 ? ((beforeTokens - afterTokens) / beforeTokens) * 100 : 0;

    return {
      compressedText: out,
      beforeTokens,
      afterTokens,
      savingsPercent: Number.isFinite(savingsPercent) ? Math.max(0, savingsPercent) : 0,
    };
  }

  private applyFree(text: string): string {
    if (!RuleCompressor.compiledFree) {
      RuleCompressor.compiledFree = compileUnionDictionary(RuleCompressor.FREE_DEFAULT_REPLACEMENTS);
    }
    return applyUnion(text, RuleCompressor.compiledFree);
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


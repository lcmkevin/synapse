const fs = require("fs");
const os = require("os");
const path = require("path");

function parseArgs(argv) {
  const out = { file: "", top: 30, dict: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" && argv[i + 1]) out.file = String(argv[++i]);
    else if (a === "--top" && argv[i + 1]) out.top = Number(argv[++i]);
    else if (a === "--dict" && argv[i + 1]) out.dict = String(argv[++i]);
  }
  if (!out.file) out.file = path.join(os.homedir(), ".synapse", "telemetry", "compression-metrics.jsonl");
  if (!Number.isFinite(out.top) || out.top <= 0) out.top = 30;
  return out;
}

function safeReadJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadDictMap(dictPath) {
  if (!dictPath) return null;
  const json = safeReadJson(dictPath);
  if (!json) return null;
  const rows = Array.isArray(json?.rows) ? json.rows : Array.isArray(json) ? json : [];
  const map = new Map();
  for (const r of rows) {
    const id = typeof r?.id === "string" ? r.id : "";
    const find = typeof r?.find_pattern === "string" ? r.find_pattern : "";
    const replace = typeof r?.replace_with === "string" ? r.replace_with : "";
    if (!id) continue;
    map.set(id, { find_pattern: find, replace_with: replace });
  }
  return map;
}

function summarize(filePath, topN, dictMap) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, error: `Cannot read: ${filePath}` };
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  const agg = {
    events: 0,
    selectionEvents: 0,
    workspaceEvents: 0,
    beforeTokens: 0,
    afterTokens: 0,
    savingsPercentSum: 0,
    proEvents: 0,
    hitCounts: {},
  };

  for (const line of lines) {
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    agg.events++;
    if (obj.source === "workspace") agg.workspaceEvents++;
    else agg.selectionEvents++;
    if (obj.isPro) agg.proEvents++;

    const bt = Number(obj.beforeTokens);
    const at = Number(obj.afterTokens);
    const sp = Number(obj.savingsPercent);
    if (Number.isFinite(bt) && bt > 0) agg.beforeTokens += bt;
    if (Number.isFinite(at) && at >= 0) agg.afterTokens += at;
    if (Number.isFinite(sp)) agg.savingsPercentSum += sp;

    const hits = obj.hitCounts && typeof obj.hitCounts === "object" ? obj.hitCounts : null;
    if (hits) {
      for (const k of Object.keys(hits)) {
        const n = Number(hits[k]);
        if (!k || !Number.isFinite(n) || n <= 0) continue;
        agg.hitCounts[k] = (agg.hitCounts[k] || 0) + Math.floor(n);
      }
    }
  }

  const avgSavings = agg.events ? agg.savingsPercentSum / agg.events : 0;
  const topHits = Object.entries(agg.hitCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, count]) => {
      const dict = dictMap?.get?.(id);
      return dict ? { id, count, find_pattern: dict.find_pattern, replace_with: dict.replace_with } : { id, count };
    });

  return {
    ok: true,
    file: filePath,
    events: agg.events,
    selectionEvents: agg.selectionEvents,
    workspaceEvents: agg.workspaceEvents,
    proEvents: agg.proEvents,
    beforeTokens: agg.beforeTokens,
    afterTokens: agg.afterTokens,
    totalSavedTokens: agg.beforeTokens - agg.afterTokens,
    avgSavingsPercent: avgSavings,
    topHits,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dictMap = loadDictMap(args.dict);
  const out = summarize(args.file, args.top, dictMap);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (!out.ok) process.exitCode = 1;
}

main();

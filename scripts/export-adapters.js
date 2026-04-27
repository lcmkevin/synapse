const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

function requiredEnv(name) {
  const v = process.env[name];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function toAdapterPayload(row) {
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  const version = typeof row?.version === "string" ? row.version.trim() : "";
  if (!id || !version) return null;

  return {
    id,
    version,
    minCliVersion: typeof row?.min_cli_version === "string" ? row.min_cli_version : null,
    requiresPro: row?.requires_pro === true,
    releaseNotes: typeof row?.release_notes === "string" ? row.release_notes : null,
    downloadUrl: `https://labs-synapse.com/downloads/adapters/${id}.json`,
    isActive: row?.is_active !== false,
    updatedAt: new Date().toISOString(),
    config: row?.config ?? {},
  };
}

async function exportAdapters() {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const supabaseAnonKey = requiredEnv("SUPABASE_ANON_KEY");

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  process.stdout.write("📦 Exporting adapters from Supabase...\n");

  const { data, error } = await supabase
    .from("latest_adapters")
    .select("id, version, min_cli_version, requires_pro, config, release_notes, is_active")
    .order("id");

  if (error) {
    process.stderr.write(`❌ Error fetching adapters: ${error.message || String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const rows = Array.isArray(data) ? data : [];
  const adapters = rows.map(toAdapterPayload).filter(Boolean);

  const outputDir = path.join(__dirname, "..", "website", "qwik", "downloads", "adapters");
  fs.mkdirSync(outputDir, { recursive: true });

  for (const adapter of adapters) {
    const filePath = path.join(outputDir, `${adapter.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(adapter, null, 2), "utf8");
    process.stdout.write(`✅ Exported ${adapter.id} v${adapter.version}\n`);
  }

  const index = adapters.map((a) => ({
    id: a.id,
    version: a.version,
    releaseNotes: a.releaseNotes,
    downloadUrl: a.downloadUrl,
  }));

  fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify(index, null, 2), "utf8");

  process.stdout.write(`✅ Exported ${adapters.length} adapters\n`);
}

exportAdapters().catch((err) => {
  process.stderr.write(`❌ Export failed: ${err?.message || String(err)}\n`);
  process.exitCode = 1;
});

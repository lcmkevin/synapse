const { requestJson } = require("./http.js");

function getSupabaseServiceConfigFromEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

async function fetchLicenseRecordByKey(licenseKey, { select = "license_key,status,plan,expires_at" } = {}) {
  const cfg = getSupabaseServiceConfigFromEnv();
  if (!cfg) return { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };

  const encodedSelect = encodeURIComponent(select);
  const filterKey = encodeURIComponent(licenseKey);
  const url = `${cfg.url}/rest/v1/licenses?license_key=eq.${filterKey}&select=${encodedSelect}&limit=1`;
  const { status, json } = await requestJson("GET", url, { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` });

  if (status !== 200) return { ok: false, error: `Supabase request failed (${status})` };
  if (!Array.isArray(json)) return { ok: false, error: "Supabase response invalid" };
  if (json.length === 0) return { ok: true, record: null };
  return { ok: true, record: json[0] };
}

async function touchLicenseUsage(licenseKey, instanceId) {
  const cfg = getSupabaseServiceConfigFromEnv();
  if (!cfg) return;
  const filterKey = encodeURIComponent(licenseKey);
  const url = `${cfg.url}/rest/v1/licenses?license_key=eq.${filterKey}`;
  const update = {
    last_used_at: new Date().toISOString(),
    last_instance_id: typeof instanceId === "string" && instanceId.length <= 200 ? instanceId : null,
  };
  await requestJson(
    "PATCH",
    url,
    { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: "return=minimal" },
    update
  );
}

async function upsertLicenseRecord(record, { onConflict = "license_key" } = {}) {
  const cfg = getSupabaseServiceConfigFromEnv();
  if (!cfg) throw new Error("DB not configured");
  const url = `${cfg.url}/rest/v1/licenses?on_conflict=${encodeURIComponent(onConflict)}`;
  const { status } = await requestJson(
    "POST",
    url,
    {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    record
  );
  if (status !== 201 && status !== 200 && status !== 204) throw new Error("DB write failed");
}

module.exports = { getSupabaseServiceConfigFromEnv, fetchLicenseRecordByKey, touchLicenseUsage, upsertLicenseRecord };

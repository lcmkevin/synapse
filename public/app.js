async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json && json.error ? json.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function $(id) {
  return document.getElementById(id);
}

function getMode() {
  const el = document.querySelector('input[name="mode"]:checked');
  return el ? el.value : "symlink";
}

function setMode(mode) {
  const value = mode === "copy" ? "copy" : "symlink";
  const el = document.querySelector(`input[name="mode"][value="${value}"]`);
  if (el) el.checked = true;
}

function payload() {
  return {
    projectPath: $("projectPath").value.trim(),
    templateRoot: $("templateRoot").value.trim(),
    mode: getMode(),
    force: $("force").checked,
    backup: $("backup").checked,
    dryRun: $("dryRun").checked,
  };
}

const STORAGE_KEY = "trae_rule_dashboard_v1";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState() {
  const state = {
    projectPath: $("projectPath").value,
    templateRoot: $("templateRoot").value,
    mode: getMode(),
    force: $("force").checked,
    backup: $("backup").checked,
    dryRun: $("dryRun").checked,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function writeOutput(title, obj) {
  const out = $("output");
  const ts = new Date().toISOString();
  const block = `[${ts}] ${title}\n${JSON.stringify(obj, null, 2)}\n\n`;
  out.textContent = block + out.textContent;
}

function setPreviewVisible(visible) {
  $("previewPanel").hidden = !visible;
}

function pill(text, kind) {
  const span = document.createElement("span");
  span.className = kind ? `pill ${kind}` : "pill";
  span.textContent = text;
  return span;
}

function renderDryRunPreview(initResponse) {
  const result = initResponse && initResponse.result ? initResponse.result : null;
  if (!result || !result.dryRun) {
    setPreviewVisible(false);
    return;
  }

  const applied = Array.isArray(result.applied) ? result.applied : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];

  const overwrites = applied.filter((a) => a && a.destExists === true).length;
  const backups = applied.filter((a) => a && a.willBackup === true).length;

  $("previewSummary").textContent = `Applied: ${applied.length} | Skipped: ${skipped.length} | Overwrite: ${overwrites} | Backup: ${backups}`;

  const body = $("previewBody");
  body.textContent = "";

  for (const a of applied) {
    const tr = document.createElement("tr");

    const tdAction = document.createElement("td");
    tdAction.appendChild(pill(String(a.action || "").toUpperCase(), a.action === "copy" ? "ok" : ""));

    const tdPath = document.createElement("td");
    tdPath.textContent = a.path || "";

    const tdOverwrite = document.createElement("td");
    tdOverwrite.appendChild(pill(a.destExists ? "YES" : "NO", a.destExists ? "warn" : "ok"));

    const tdBackup = document.createElement("td");
    tdBackup.appendChild(pill(a.willBackup ? "YES" : "NO", a.willBackup ? "warn" : "ok"));

    tr.appendChild(tdAction);
    tr.appendChild(tdPath);
    tr.appendChild(tdOverwrite);
    tr.appendChild(tdBackup);
    body.appendChild(tr);
  }

  for (const s of skipped) {
    const tr = document.createElement("tr");

    const tdAction = document.createElement("td");
    tdAction.appendChild(pill("SKIP", "warn"));

    const tdPath = document.createElement("td");
    tdPath.textContent = s.path || "";

    const tdOverwrite = document.createElement("td");
    tdOverwrite.appendChild(pill("NO", "ok"));

    const tdBackup = document.createElement("td");
    tdBackup.appendChild(pill("NO", "ok"));

    tr.appendChild(tdAction);
    tr.appendChild(tdPath);
    tr.appendChild(tdOverwrite);
    tr.appendChild(tdBackup);
    body.appendChild(tr);
  }

  setPreviewVisible(true);
}

async function run(title, fn) {
  try {
    $("btnInit").disabled = true;
    $("btnStatus").disabled = true;
    $("btnSync").disabled = true;
    $("btnGitignore").disabled = true;
    const result = await fn();
    if (title === "init") {
      renderDryRunPreview(result);
    }
    writeOutput(title, result);
  } catch (e) {
    writeOutput(`${title} (error)`, { error: e && e.message ? e.message : String(e) });
  } finally {
    $("btnInit").disabled = false;
    $("btnStatus").disabled = false;
    $("btnSync").disabled = false;
    $("btnGitignore").disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const persisted = loadState();
  if (persisted) {
    if (typeof persisted.projectPath === "string") $("projectPath").value = persisted.projectPath;
    if (typeof persisted.templateRoot === "string") $("templateRoot").value = persisted.templateRoot;
    setMode(persisted.mode);
    $("force").checked = !!persisted.force;
    $("backup").checked = !!persisted.backup;
    $("dryRun").checked = !!persisted.dryRun;
  }

  $("projectPath").addEventListener("input", saveState);
  $("templateRoot").addEventListener("input", saveState);
  document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", saveState));
  $("force").addEventListener("change", saveState);
  $("backup").addEventListener("change", saveState);
  $("dryRun").addEventListener("change", saveState);

  $("btnInit").addEventListener("click", () => run("init", () => postJson("/api/init", payload())));
  $("btnStatus").addEventListener("click", () => run("status", () => postJson("/api/status", payload())));
  $("btnSync").addEventListener("click", () => run("sync", () => postJson("/api/sync", payload())));
  $("btnGitignore").addEventListener("click", () => run("gitignore", () => postJson("/api/gitignore", payload())));
  $("btnClear").addEventListener("click", () => {
    $("output").textContent = "";
  });
  $("btnHidePreview").addEventListener("click", () => setPreviewVisible(false));
  setPreviewVisible(false);

  try {
    const res = await fetch("/api/info");
    const info = await res.json();
    writeOutput("info", info);
    if (!$("templateRoot").value && info && typeof info.templateRoot === "string") {
      $("templateRoot").value = info.templateRoot;
      saveState();
    }
  } catch {
    // ignore
  }
});

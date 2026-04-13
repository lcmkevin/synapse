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

function getMergeMode() {
  const el = document.querySelector('input[name="mergeMode"]:checked');
  return el ? el.value : "git";
}

function setMergeMode(mode) {
  const value = mode === "paths" ? "paths" : "git";
  const el = document.querySelector(`input[name="mergeMode"][value="${value}"]`);
  if (el) el.checked = true;
  $("mergeGitFields").hidden = value !== "git";
  $("mergePathsFields").hidden = value !== "paths";
}

function getSyncSourceMode() {
  const el = document.querySelector('input[name="syncSourceMode"]:checked');
  return el ? el.value : "local";
}

function setSyncSourceMode(mode) {
  const value = mode === "git" ? "git" : "local";
  const el = document.querySelector(`input[name="syncSourceMode"][value="${value}"]`);
  if (el) el.checked = true;
  $("syncLocalFields").hidden = value !== "local";
  $("syncGitFields").hidden = value !== "git";
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

function mergePayload() {
  const projectPath = $("projectPath").value.trim();
  const mode = getMergeMode();
  if (mode === "git") {
    return {
      projectPath,
      mode: "git",
      filePath: $("mergeGitFilePath").value.trim(),
      outPath: $("mergeGitOutPath").value.trim(),
      apply: $("mergeApply").checked,
      diff3: $("mergeDiff3").checked,
    };
  }
  return {
    projectPath,
    mode: "paths",
    basePath: $("mergeBasePath").value.trim(),
    oursPath: $("mergeOursPath").value.trim(),
    theirsPath: $("mergeTheirsPath").value.trim(),
    outPath: $("mergeOutPath").value.trim(),
    apply: $("mergeApply").checked,
    diff3: $("mergeDiff3").checked,
  };
}

function syncPayloadBase() {
  const projectPath = $("projectPath").value.trim();
  const mode = getSyncSourceMode();
  const overwrite = $("syncOverwrite").checked;
  if (mode === "git") {
    return {
      projectPath,
      overwrite,
      repoUrl: $("syncRepoUrl").value.trim(),
      branch: $("syncBranch").value.trim() || "main",
    };
  }
  return {
    projectPath,
    overwrite,
    sourcePath: $("syncSourcePath").value.trim(),
  };
}

function publishPayload() {
  return {
    projectPath: $("projectPath").value.trim(),
    repoUrl: $("publishRepoUrl").value.trim(),
    branch: $("publishBranch").value.trim() || "main",
    commitMessage: $("publishMessage").value.trim() || "Publish Trae rules/skills",
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
    mergeMode: getMergeMode(),
    mergeGitFilePath: $("mergeGitFilePath").value,
    mergeGitOutPath: $("mergeGitOutPath").value,
    mergeBasePath: $("mergeBasePath").value,
    mergeOursPath: $("mergeOursPath").value,
    mergeTheirsPath: $("mergeTheirsPath").value,
    mergeOutPath: $("mergeOutPath").value,
    mergeApply: $("mergeApply").checked,
    mergeDiff3: $("mergeDiff3").checked,
    syncSourceMode: getSyncSourceMode(),
    syncSourcePath: $("syncSourcePath").value,
    syncRepoUrl: $("syncRepoUrl").value,
    syncBranch: $("syncBranch").value,
    syncOverwrite: $("syncOverwrite").checked,
    publishRepoUrl: $("publishRepoUrl").value,
    publishBranch: $("publishBranch").value,
    publishMessage: $("publishMessage").value,
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
    ["btnInit", "btnStatus", "btnSync", "btnGitignore", "btnMerge", "btnSyncRules", "btnSyncSkills", "btnPublish"].forEach((id) => ($(id).disabled = true));
    const result = await fn();
    if (title === "init") {
      renderDryRunPreview(result);
    }
    writeOutput(title, result);
  } catch (e) {
    writeOutput(`${title} (error)`, { error: e && e.message ? e.message : String(e) });
  } finally {
    ["btnInit", "btnStatus", "btnSync", "btnGitignore", "btnMerge", "btnSyncRules", "btnSyncSkills", "btnPublish"].forEach((id) => ($(id).disabled = false));
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

    setMergeMode(persisted.mergeMode);
    if (typeof persisted.mergeGitFilePath === "string") $("mergeGitFilePath").value = persisted.mergeGitFilePath;
    if (typeof persisted.mergeGitOutPath === "string") $("mergeGitOutPath").value = persisted.mergeGitOutPath;
    if (typeof persisted.mergeBasePath === "string") $("mergeBasePath").value = persisted.mergeBasePath;
    if (typeof persisted.mergeOursPath === "string") $("mergeOursPath").value = persisted.mergeOursPath;
    if (typeof persisted.mergeTheirsPath === "string") $("mergeTheirsPath").value = persisted.mergeTheirsPath;
    if (typeof persisted.mergeOutPath === "string") $("mergeOutPath").value = persisted.mergeOutPath;
    $("mergeApply").checked = persisted.mergeApply !== undefined ? !!persisted.mergeApply : true;
    $("mergeDiff3").checked = !!persisted.mergeDiff3;

    setSyncSourceMode(persisted.syncSourceMode);
    if (typeof persisted.syncSourcePath === "string") $("syncSourcePath").value = persisted.syncSourcePath;
    if (typeof persisted.syncRepoUrl === "string") $("syncRepoUrl").value = persisted.syncRepoUrl;
    if (typeof persisted.syncBranch === "string") $("syncBranch").value = persisted.syncBranch;
    $("syncOverwrite").checked = !!persisted.syncOverwrite;
    if (typeof persisted.publishRepoUrl === "string") $("publishRepoUrl").value = persisted.publishRepoUrl;
    if (typeof persisted.publishBranch === "string") $("publishBranch").value = persisted.publishBranch;
    if (typeof persisted.publishMessage === "string") $("publishMessage").value = persisted.publishMessage;
  }

  $("projectPath").addEventListener("input", saveState);
  $("templateRoot").addEventListener("input", saveState);
  document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", saveState));
  $("force").addEventListener("change", saveState);
  $("backup").addEventListener("change", saveState);
  $("dryRun").addEventListener("change", saveState);

  document.querySelectorAll('input[name="mergeMode"]').forEach((el) =>
    el.addEventListener("change", () => {
      setMergeMode(getMergeMode());
      saveState();
    })
  );
  ["mergeGitFilePath", "mergeGitOutPath", "mergeBasePath", "mergeOursPath", "mergeTheirsPath", "mergeOutPath"].forEach((id) =>
    $(id).addEventListener("input", saveState)
  );
  $("mergeApply").addEventListener("change", saveState);
  $("mergeDiff3").addEventListener("change", saveState);

  document.querySelectorAll('input[name="syncSourceMode"]').forEach((el) =>
    el.addEventListener("change", () => {
      setSyncSourceMode(getSyncSourceMode());
      saveState();
    })
  );
  ["syncSourcePath", "syncRepoUrl", "syncBranch", "publishRepoUrl", "publishBranch", "publishMessage"].forEach((id) =>
    $(id).addEventListener("input", saveState)
  );
  $("syncOverwrite").addEventListener("change", saveState);

  $("btnInit").addEventListener("click", () => run("init", () => postJson("/api/init", payload())));
  $("btnStatus").addEventListener("click", () => run("status", () => postJson("/api/status", payload())));
  $("btnSync").addEventListener("click", () => run("sync", () => postJson("/api/sync", payload())));
  $("btnGitignore").addEventListener("click", () => run("gitignore", () => postJson("/api/gitignore", payload())));
  $("btnMerge").addEventListener("click", () => run("merge", () => postJson("/api/merge", mergePayload())));
  $("btnSyncRules").addEventListener("click", () => run("syncRules", () => postJson("/api/syncRules", syncPayloadBase())));
  $("btnSyncSkills").addEventListener("click", () => run("syncSkills", () => postJson("/api/syncSkills", syncPayloadBase())));
  $("btnPublish").addEventListener("click", () => run("publish", () => postJson("/api/publish", publishPayload())));
  $("btnClear").addEventListener("click", () => {
    $("output").textContent = "";
  });
  $("btnHidePreview").addEventListener("click", () => setPreviewVisible(false));
  setPreviewVisible(false);
  setMergeMode(getMergeMode());
  setSyncSourceMode(getSyncSourceMode());

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

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

function presetPreviewPayload() {
  return syncPayloadBase();
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

let presetSessionId = null;
let presetItems = [];
let uploadedLocalFolder = null;

async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function pickLocalFolderFiles(fileList) {
  const files = Array.from(fileList || []);
  const kept = [];
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    const posix = rel.replace(/\\/g, "/");
    const isTrae = posix.includes("/.trae/rules/") || posix.includes("/.trae/skills/") || posix.startsWith(".trae/rules/") || posix.startsWith(".trae/skills/");
    const isDirect = posix.includes("/rules/") || posix.includes("/skills/") || posix.startsWith("rules/") || posix.startsWith("skills/");
    if (!isTrae && !isDirect) continue;
    kept.push({ file: f, relPosix: posix });
  }
  const encoded = [];
  for (const it of kept) {
    const contentBase64 = await fileToBase64(it.file);
    encoded.push({ path: it.relPosix, contentBase64 });
  }
  const name = kept.length > 0 ? kept[0].relPosix.split("/")[0] : "folder";
  return { name, files: encoded };
}

async function pickLocalFolderFromDirectoryHandle(dirHandle) {
  const folderName = dirHandle && dirHandle.name ? String(dirHandle.name) : "folder";
  const kept = [];

  const walk = async (handle, relParts) => {
    for await (const entry of handle.values()) {
      if (entry.kind === "directory") {
        await walk(entry, [...relParts, entry.name]);
        continue;
      }
      if (entry.kind !== "file") continue;
      const relPosix = [...relParts, entry.name].join("/").replace(/\\/g, "/");
      const posix = `${folderName}/${relPosix}`;
      const isTrae =
        posix.includes("/.trae/rules/") ||
        posix.includes("/.trae/skills/") ||
        posix.startsWith(".trae/rules/") ||
        posix.startsWith(".trae/skills/");
      const isDirect = posix.includes("/rules/") || posix.includes("/skills/") || posix.startsWith("rules/") || posix.startsWith("skills/");
      if (!isTrae && !isDirect) continue;
      const file = await entry.getFile();
      kept.push({ file, relPosix: posix });
    }
  };

  await walk(dirHandle, []);

  const encoded = [];
  for (const it of kept) {
    const contentBase64 = await fileToBase64(it.file);
    encoded.push({ path: it.relPosix, contentBase64 });
  }
  return { name: folderName, files: encoded };
}

function statusIcon(status) {
  if (status === "clean") return "✅";
  if (status === "auto-merged") return "⚠️";
  if (status === "conflict") return "🔴";
  if (status === "new-in-upstream") return "➕";
  if (status === "deleted-in-upstream") return "🗑️";
  return "📄";
}

function defaultRowAction(item) {
  if (!item || !item.status) return "";
  if (item.status === "clean") return "skip";
  if (item.status === "auto-merged") return item.selected ? "merge" : "skip";
  if (item.status === "conflict") return item.selected ? "merge (conflict)" : "skip";
  if (item.status === "new-in-upstream") return item.selected ? "add" : "skip";
  if (item.status === "deleted-in-upstream") return item.selected ? "delete" : "keep";
  return "preserve";
}

function canSelectPreset(item) {
  return item && item.status !== "local-only";
}

function renderPresetPreview() {
  const body = $("presetBody");
  body.textContent = "";

  const counts = {};
  for (const it of presetItems) counts[it.status] = (counts[it.status] || 0) + 1;
  const parts = Object.keys(counts)
    .sort()
    .map((k) => `${k}: ${counts[k]}`);
  $("presetSummary").textContent = `${presetItems.length} files${parts.length ? " | " + parts.join(" | ") : ""}`;

  for (const item of presetItems) {
    const tr = document.createElement("tr");

    const tdCheck = document.createElement("td");
    if (canSelectPreset(item)) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!item.selected;
      cb.addEventListener("change", () => {
        item.selected = cb.checked;
        renderPresetPreview();
      });
      tdCheck.appendChild(cb);
    }

    const tdStatus = document.createElement("td");
    tdStatus.textContent = statusIcon(item.status);

    const tdPath = document.createElement("td");
    tdPath.textContent = item.path || "";

    const tdAction = document.createElement("td");
    tdAction.textContent = defaultRowAction(item);

    const tdOpen = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = "View";
    btn.addEventListener("click", async () => {
      await run("previewFile", async () => {
        const res = await postJson("/api/previewSyncFile", { projectPath: $("projectPath").value.trim(), sessionId: presetSessionId, id: item.id });
        const r = res && res.result ? res.result : null;
        const out = $("presetFilePreview");
        const parts = [];
        $("presetFileTitle").textContent = item.path || "File Preview";
        if (r && r.oursText !== null) parts.push(`--- ours ---\n${r.oursText}`);
        if (r && r.theirsText !== null) parts.push(`--- theirs ---\n${r.theirsText}`);
        if (r && r.mergedText !== null) parts.push(`--- merged (preview) ---\n${r.mergedText}`);
        out.textContent = parts.join("\n\n");
        return res;
      });
    });
    tdOpen.appendChild(btn);

    tr.appendChild(tdCheck);
    tr.appendChild(tdStatus);
    tr.appendChild(tdPath);
    tr.appendChild(tdAction);
    tr.appendChild(tdOpen);

    body.appendChild(tr);
  }
}

async function closePresetSession() {
  if (!presetSessionId) return;
  try {
    await postJson("/api/previewSyncClose", { projectPath: $("projectPath").value.trim(), sessionId: presetSessionId });
  } catch {
    // ignore
  } finally {
    presetSessionId = null;
  }
}

async function run(title, fn) {
  const ids = [
    "btnInit",
    "btnStatus",
    "btnSync",
    "btnGitignore",
    "btnMerge",
    "btnSyncRules",
    "btnSyncSkills",
    "btnPublish",
    "btnPresetPreview",
    "btnPresetSelectConflicts",
    "btnPresetSelectCleanAuto",
    "btnPresetApplySelected",
    "btnSyncBrowse",
  ];
  const setDisabled = (disabled) => {
    for (const id of ids) {
      const el = $(id);
      if (el) el.disabled = disabled;
    }
  };
  try {
    setDisabled(true);
    const result = await fn();
    if (title === "init") {
      renderDryRunPreview(result);
    }
    if (title === "previewSync") {
      const r = result && result.result ? result.result : null;
      presetSessionId = result && result.sessionId ? result.sessionId : null;
      presetItems = r && Array.isArray(r.items) ? r.items.map((x) => ({ ...x, selected: false })) : [];
      $("presetFileTitle").textContent = "File Preview";
      $("presetFilePreview").textContent = "";
      renderPresetPreview();
    }
    writeOutput(title, result);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    writeOutput(`${title} (error)`, { error: msg });
    if (title === "previewSync") {
      const el = $("presetSummary");
      if (el) el.textContent = `Preview error: ${msg}`;
    }
  } finally {
    setDisabled(false);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const sourcePathEl = $("syncSourcePath");
  const defaultSourcePlaceholder = sourcePathEl ? sourcePathEl.getAttribute("placeholder") || "" : "";

  // NEW: real-time sync status indicator via WebSocket
  const syncDot = $("syncDot");
  const syncLabel = $("syncLabel");
  const syncWrap = document.querySelector(".syncStatus");
  function setSyncUi(kind, at, errText) {
    if (!syncDot || !syncLabel) return;
    syncDot.classList.remove("syncDot--ok", "syncDot--fail", "syncDot--warn", "syncDot--unknown");
    const when = typeof at === "number" ? new Date(at).toLocaleString() : "unknown";
    if (kind === "ok") {
      syncDot.classList.add("syncDot--ok");
      syncLabel.textContent = "Sync: ok";
      if (syncWrap) syncWrap.title = `Last sync: ok • ${when}`;
      return;
    }
    if (kind === "fail") {
      syncDot.classList.add("syncDot--fail");
      syncLabel.textContent = "Sync: fail";
      const extra = errText ? ` • ${String(errText).slice(0, 120)}` : "";
      if (syncWrap) syncWrap.title = `Last sync: fail • ${when}${extra}`;
      return;
    }
    if (kind === "warn") {
      syncDot.classList.add("syncDot--warn");
      syncLabel.textContent = "Sync: disconnected";
      if (syncWrap) syncWrap.title = "Sync status: disconnected";
      return;
    }
    syncDot.classList.add("syncDot--unknown");
    syncLabel.textContent = "Sync: unknown";
    if (syncWrap) syncWrap.title = "Sync status: unknown";
  }

  function connectSyncWs() {
    try {
      const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/sync-status`;
      const ws = new WebSocket(wsUrl);
      setSyncUi("warn");
      ws.addEventListener("open", () => setSyncUi("warn"));
      ws.addEventListener("close", () => setSyncUi("warn"));
      ws.addEventListener("error", () => setSyncUi("warn"));
      ws.addEventListener("message", (ev) => {
        try {
          const data = JSON.parse(String(ev.data || ""));
          if (data && data.kind === "sync") {
            setSyncUi(data.ok ? "ok" : "fail", data.at, data.error || "");
          }
        } catch {
          void 0;
        }
      });
    } catch {
      setSyncUi("warn");
    }
  }

  connectSyncWs();

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
    if (typeof persisted.syncSourcePath === "string") {
      const v = persisted.syncSourcePath;
      $("syncSourcePath").value = typeof v === "string" && v.trim().startsWith("(picked ") ? "" : v;
    }
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

  $("syncSourcePath").addEventListener("input", () => {
    uploadedLocalFolder = null;
    $("syncSourcePickedInfo").textContent = "";
    if (defaultSourcePlaceholder) $("syncSourcePath").placeholder = defaultSourcePlaceholder;
  });

  $("btnInit").addEventListener("click", () => run("init", () => postJson("/api/init", payload())));
  $("btnStatus").addEventListener("click", () => run("status", () => postJson("/api/status", payload())));
  $("btnSync").addEventListener("click", () => run("sync", () => postJson("/api/sync", payload())));
  $("btnGitignore").addEventListener("click", () => run("gitignore", () => postJson("/api/gitignore", payload())));
  $("btnMerge").addEventListener("click", () => run("merge", () => postJson("/api/merge", mergePayload())));

  $("btnSyncRules").addEventListener("click", () =>
    run("syncRules", () => {
      const base = syncPayloadBase();
      if (getSyncSourceMode() === "local" && uploadedLocalFolder && Array.isArray(uploadedLocalFolder.files) && uploadedLocalFolder.files.length > 0) {
        return postJson("/api/syncRulesUpload", { projectPath: base.projectPath, overwrite: base.overwrite, files: uploadedLocalFolder.files });
      }
      if (getSyncSourceMode() === "local" && !base.sourcePath) {
        throw new Error("Select a source folder: click Select (recommended) or type a folder path.");
      }
      return postJson("/api/syncRules", base);
    })
  );
  $("btnSyncSkills").addEventListener("click", () =>
    run("syncSkills", () => {
      const base = syncPayloadBase();
      if (getSyncSourceMode() === "local" && uploadedLocalFolder && Array.isArray(uploadedLocalFolder.files) && uploadedLocalFolder.files.length > 0) {
        return postJson("/api/syncSkillsUpload", { projectPath: base.projectPath, overwrite: base.overwrite, files: uploadedLocalFolder.files });
      }
      if (getSyncSourceMode() === "local" && !base.sourcePath) {
        throw new Error("Select a source folder: click Select (recommended) or type a folder path.");
      }
      return postJson("/api/syncSkills", base);
    })
  );
  $("btnPublish").addEventListener("click", () => run("publish", () => postJson("/api/publish", publishPayload())));

  $("btnSyncBrowse").addEventListener("click", () => {
    try {
      const picker = $("syncSourcePicker");
      if (picker) picker.value = "";
    } catch {
      void 0;
    }
    void run("pickLocalPresetFolder", async () => {
      const initialPath = $("syncSourcePath").value.trim();
      const res = await postJson("/api/pickFolder", { projectPath: $("projectPath").value.trim(), initialPath, title: "Select Source Folder" });
      const picked = res && res.result && typeof res.result.path === "string" ? res.result.path.trim() : "";
      if (!picked) return { ok: true, picked: false };
      uploadedLocalFolder = null;
      $("syncSourcePickedInfo").textContent = `Selected: ${picked}`;
      $("syncSourcePickedInfo").title = picked;
      $("syncSourcePath").value = picked;
      if (defaultSourcePlaceholder) $("syncSourcePath").placeholder = defaultSourcePlaceholder;
      saveState();
      return { ok: true, picked: true };
    });
  });
  $("syncSourcePicker").addEventListener("change", async (e) => {
    const input = e.target;
    const list = input && input.files ? input.files : null;
    if (!list || list.length === 0) return;
    await run("pickLocalPresetFolder", async () => {
      uploadedLocalFolder = await pickLocalFolderFiles(list);
      const folderName = uploadedLocalFolder && uploadedLocalFolder.files && uploadedLocalFolder.files[0] && uploadedLocalFolder.files[0].path ? String(uploadedLocalFolder.files[0].path).split("/")[0] : "folder";
      $("syncSourcePickedInfo").textContent = `Selected: ${folderName} (${uploadedLocalFolder.files.length} files)`;
      $("syncSourcePath").value = folderName;
      if (defaultSourcePlaceholder) $("syncSourcePath").placeholder = defaultSourcePlaceholder;
      saveState();
      return { ok: true, files: uploadedLocalFolder.files.length };
    });
    try {
      input.value = "";
    } catch {
      void 0;
    }
  });
  $("btnPresetPreview").addEventListener("click", async () => {
    await closePresetSession();
    await run("previewSync", () => {
      const base = presetPreviewPayload();
      if (getSyncSourceMode() === "local" && uploadedLocalFolder && Array.isArray(uploadedLocalFolder.files) && uploadedLocalFolder.files.length > 0) {
        return postJson("/api/previewSyncUpload", { projectPath: base.projectPath, files: uploadedLocalFolder.files });
      }
      if (getSyncSourceMode() === "local" && !base.sourcePath) {
        throw new Error("Select a source folder: click Select (recommended) or type a folder path.");
      }
      return postJson("/api/previewSync", base);
    });
  });
  $("btnPresetSelectConflicts").addEventListener("click", () => {
    for (const it of presetItems) it.selected = it.status === "conflict";
    renderPresetPreview();
  });
  $("btnPresetSelectCleanAuto").addEventListener("click", () => {
    for (const it of presetItems) it.selected = it.status === "clean" || it.status === "auto-merged";
    renderPresetPreview();
  });
  $("btnPresetApplySelected").addEventListener("click", async () => {
    if (!presetSessionId) {
      writeOutput("previewApply (error)", { error: "Run Preview first." });
      return;
    }
    const selected = presetItems.filter((i) => i.selected && canSelectPreset(i)).map((i) => i.id);
    const willDelete = presetItems.some((i) => i.selected && i.status === "deleted-in-upstream");
    const confirmDelete = willDelete ? window.confirm("Delete files that are missing in upstream preset?") : false;
    await run("previewApply", () =>
      postJson("/api/previewSyncApply", { projectPath: $("projectPath").value.trim(), sessionId: presetSessionId, selections: selected, confirmDelete })
    );
    await run("previewSync", () => postJson("/api/previewSync", presetPreviewPayload()));
  });
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

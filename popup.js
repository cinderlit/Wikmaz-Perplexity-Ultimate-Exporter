const exportCurrentBtn = document.getElementById("exportCurrentBtn");
const startBtn = document.getElementById("startBtn");
const incrementalBtn = document.getElementById("incrementalBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const advancedToggle = document.getElementById("advancedToggle");
const advancedPanel = document.getElementById("advancedPanel");
const selectedIdsEl = document.getElementById("selectedIds");
const exportSelectedBtn = document.getElementById("exportSelectedBtn");
const sinceDateEl = document.getElementById("sinceDate");
const incrementalFromDateBtn = document.getElementById("incrementalFromDateBtn");
const seedCheckpointBtn = document.getElementById("seedCheckpointBtn");
const seedFromDiskBtn = document.getElementById("seedFromDiskBtn");
const checkpointImportFile = document.getElementById("checkpointImportFile");
const checkpointImportText = document.getElementById("checkpointImportText");
const importCheckpointBtn = document.getElementById("importCheckpointBtn");
const overwriteOnExportEl = document.getElementById("overwriteOnExport");
const deepScanIncrementalEl = document.getElementById("deepScanIncremental");
const resetCheckpointBtn = document.getElementById("resetCheckpointBtn");
const checkpointInfoEl = document.getElementById("checkpointInfo");
const archiveInfoEl = document.getElementById("archiveInfo");
const exportRootEl = document.getElementById("exportRoot");

const actionButtons = [
  exportCurrentBtn,
  startBtn,
  incrementalBtn,
  exportSelectedBtn,
  incrementalFromDateBtn,
  seedCheckpointBtn,
  seedFromDiskBtn,
  importCheckpointBtn
];

function sendAction(message, onDone) {
  chrome.runtime.sendMessage(message, (response) => {
    const err = chrome.runtime.lastError;
    if (err) {
      statusEl.innerText = "Error: " + err.message;
      setRunningUI(false);
      if (onDone) onDone(err);
      return;
    }
    if (response && response.error) {
      statusEl.innerText = "Error: " + response.error;
      setRunningUI(false);
      if (onDone) onDone(new Error(response.error));
      return;
    }
    if (onDone) onDone(null, response);
  });
}

function setRunningUI(running) {
  actionButtons.forEach((btn) => {
    btn.style.display = running ? "none" : "block";
  });
  advancedToggle.style.display = running ? "none" : "block";
  if (!running) advancedPanel.classList.remove("open");
  stopBtn.style.display = running ? "block" : "none";
  progressBar.style.display = running ? "block" : "none";
}

function loadCheckpointInfo() {
  chrome.runtime.sendMessage({ action: "get_checkpoint_info" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      checkpointInfoEl.innerText = "Checkpoint: not initialized";
      return;
    }
    if (response.lastSuccessfulExportAt) {
      const when = new Date(response.lastSuccessfulExportAt).toLocaleString();
      const seeded = response.seededFromArchive ? " · seeded" : "";
      checkpointInfoEl.innerText =
        "Last sync: " +
        when +
        " (" +
        response.count +
        " threads, mode: " +
        (response.lastExportMode || "?") +
        ")" +
        seeded;
    } else {
      checkpointInfoEl.innerText = "Checkpoint: not initialized";
    }
  });
}

function loadArchiveInfo() {
  chrome.runtime.sendMessage({ action: "get_archive_info" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      archiveInfoEl.innerText = "Archive: unknown";
      return;
    }
    const scanned = response.lastScannedAt
      ? " · synced " + new Date(response.lastScannedAt).toLocaleString()
      : " · not synced yet";
    if (!response.synced) {
      archiveInfoEl.innerText = "Archive path: " + response.exportRoot + scanned;
      return;
    }
    if (response.fileCount === 0 && response.downloadRecordsQueried != null) {
      archiveInfoEl.innerText =
        "Archive: " +
        response.exportRoot +
        " (0 indexed from " +
        response.downloadRecordsQueried +
        " download records" +
        (response.searchCounts && response.searchCounts.allDownloads
          ? "; allDownloads=" + response.searchCounts.allDownloads
          : "") +
        ")" +
        scanned;
      return;
    }
    archiveInfoEl.innerText =
      "Archive: " +
      response.exportRoot +
      " (" +
      response.fileCount +
      " files" +
      (response.indexedFromDeleted ? ", " + response.indexedFromDeleted + " deleted entries" : "") +
      (response.indexedFromBasename ? ", " + response.indexedFromBasename + " by filename" : "") +
      ")" +
      scanned;
  });
}

function loadExportSettings() {
  chrome.runtime.sendMessage({ action: "get_export_settings" }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    if (response.exportRoot) exportRootEl.value = response.exportRoot;
    if (overwriteOnExportEl) overwriteOnExportEl.checked = Boolean(response.overwriteOnExport);
    if (deepScanIncrementalEl) deepScanIncrementalEl.checked = Boolean(response.deepScanIncremental);
  });
}

function saveExportRoot() {
  chrome.runtime.sendMessage({ action: "set_export_root", exportRoot: exportRootEl.value }, (response) => {
    if (response && response.exportRoot) {
      exportRootEl.value = response.exportRoot;
    }
  });
}

async function requirePerplexityTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("perplexity.ai")) {
    statusEl.innerText = "Error: Please open Perplexity first!";
    return null;
  }
  return tab;
}

function beginRun(statusText) {
  setRunningUI(true);
  statusEl.innerText = statusText;
}

advancedToggle.addEventListener("click", () => {
  advancedPanel.classList.toggle("open");
  if (advancedPanel.classList.contains("open")) {
    loadCheckpointInfo();
    loadArchiveInfo();
    loadExportSettings();
  }
});

exportRootEl.addEventListener("change", saveExportRoot);
exportRootEl.addEventListener("blur", saveExportRoot);

exportCurrentBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;

  const conversationIdMatch = tab.url.match(/\/search\/([^/?#]+)/);
  if (!conversationIdMatch) {
    statusEl.innerText = "Error: Not on a conversation page (/search/...).";
    return;
  }

  beginRun("Exporting current conversation...");
  sendAction({
    action: "export_current",
    tabId: tab.id,
    tabUrl: tab.url
  });
});

startBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  beginRun("Initializing full export...");
  sendAction({ action: "start_batch", tabId: tab.id });
});

incrementalBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  beginRun("Checking recent threads for changes...");
  sendAction({ action: "export_incremental", tabId: tab.id });
});

exportSelectedBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  const ids = selectedIdsEl.value
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    statusEl.innerText = "Error: Enter at least one conversation ID.";
    return;
  }
  beginRun("Exporting " + ids.length + " selected conversation(s)...");
  sendAction({ action: "export_selected", tabId: tab.id, ids });
});

incrementalFromDateBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  if (!sinceDateEl.value) {
    statusEl.innerText = "Error: Pick a date first.";
    return;
  }
  const sinceDate = sinceDateEl.value;
  const parts = sinceDate.split("-").map(Number);
  const sinceIso = new Date(parts[0], parts[1] - 1, parts[2]).toISOString();
  beginRun("Exporting threads since " + sinceDate + "...");
  sendAction({ action: "export_incremental", tabId: tab.id, sinceDate: sinceIso });
});

seedCheckpointBtn.addEventListener("click", () => {
  beginRun("Scanning Downloads export folder...");
  sendAction({ action: "seed_from_archive" }, (err) => {
    if (!err) {
      loadCheckpointInfo();
      loadArchiveInfo();
    }
  });
});

seedFromDiskBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("seed-from-disk.html") });
});

function readCheckpointImportPayload() {
  const text = (checkpointImportText && checkpointImportText.value.trim()) || "";
  if (text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Invalid JSON in textarea");
    }
  }
  return null;
}

importCheckpointBtn.addEventListener("click", () => {
  const runImport = (checkpoint) => {
    beginRun("Merging imported checkpoint...");
    sendAction({ action: "import_checkpoint", checkpoint }, (err, response) => {
      if (err) return;
      const msg =
        "Imported: " +
        (response.newCount || "?") +
        " threads" +
        (response.stats && response.stats.added ? " · added " + response.stats.added : "") +
        (response.stats && response.stats.updated ? " · updated " + response.stats.updated : "");
      statusEl.innerText = msg;
      setRunningUI(false);
      loadCheckpointInfo();
    });
  };

  try {
    const fromText = readCheckpointImportPayload();
    if (fromText) {
      runImport(fromText);
      return;
    }
    const file = checkpointImportFile && checkpointImportFile.files && checkpointImportFile.files[0];
    if (!file) {
      statusEl.innerText = "Error: Choose a JSON file or paste checkpoint JSON.";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        runImport(JSON.parse(String(reader.result || "")));
      } catch (e) {
        statusEl.innerText = "Error: Invalid checkpoint JSON file.";
      }
    };
    reader.readAsText(file);
  } catch (e) {
    statusEl.innerText = "Error: " + e.message;
  }
});

if (overwriteOnExportEl) {
  overwriteOnExportEl.addEventListener("change", () => {
    chrome.runtime.sendMessage({
      action: "set_overwrite_on_export",
      enabled: overwriteOnExportEl.checked
    });
  });
}

if (deepScanIncrementalEl) {
  deepScanIncrementalEl.addEventListener("change", () => {
    chrome.runtime.sendMessage({
      action: "set_deep_scan_incremental",
      enabled: deepScanIncrementalEl.checked
    });
  });
}

resetCheckpointBtn.addEventListener("click", () => {
  if (!confirm("Reset export checkpoint? Next incremental will treat all threads as new.")) return;
  sendAction({ action: "reset_checkpoint" }, (err) => {
    if (!err) {
      statusEl.innerText = "Checkpoint reset.";
      loadCheckpointInfo();
    }
  });
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stop_batch" });
  statusEl.innerText = "Stopped by user.";
  setRunningUI(false);
});

chrome.runtime.sendMessage({ action: "get_status" }, (response) => {
  if (response && response.isRunning) {
    setRunningUI(true);
    statusEl.innerText = response.text || "Resuming...";
    if (response.total) {
      progressBar.max = response.total;
      progressBar.value = response.progress;
    }
  }
});

loadCheckpointInfo();
loadArchiveInfo();
loadExportSettings();

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "update_status") {
    statusEl.innerText = message.text;
    if (message.progress !== undefined && message.total !== undefined) {
      progressBar.max = message.total;
      progressBar.value = message.progress;
    }
  } else if (message.action === "finished") {
    setRunningUI(false);
    if (message.summary && message.summary.text) {
      statusEl.innerText = message.summary.text;
    }
    loadCheckpointInfo();
    loadArchiveInfo();
  }
});

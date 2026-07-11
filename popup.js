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
const resetCheckpointBtn = document.getElementById("resetCheckpointBtn");
const checkpointInfoEl = document.getElementById("checkpointInfo");
const exportRootEl = document.getElementById("exportRoot");

const actionButtons = [
  exportCurrentBtn,
  startBtn,
  incrementalBtn,
  exportSelectedBtn,
  incrementalFromDateBtn,
  seedCheckpointBtn
];

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
    if (!response) {
      checkpointInfoEl.innerText = "Checkpoint: not initialized";
      return;
    }
    if (response.lastSuccessfulExportAt) {
      const when = new Date(response.lastSuccessfulExportAt).toLocaleString();
      checkpointInfoEl.innerText =
        "Last sync: " + when + " (" + response.count + " threads, mode: " + (response.lastExportMode || "?") + ")";
    } else {
      checkpointInfoEl.innerText = "Checkpoint: not initialized";
    }
  });
}

function loadExportRoot() {
  chrome.runtime.sendMessage({ action: "get_export_root" }, (response) => {
    if (response && response.exportRoot) {
      exportRootEl.value = response.exportRoot;
    }
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
    loadExportRoot();
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
  chrome.runtime.sendMessage({
    action: "export_current",
    tabId: tab.id,
    tabUrl: tab.url
  });
});

startBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  beginRun("Initializing full export...");
  chrome.runtime.sendMessage({ action: "start_batch", tabId: tab.id });
});

incrementalBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  beginRun("Scanning for changes since last export...");
  chrome.runtime.sendMessage({ action: "export_incremental", tabId: tab.id });
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
  chrome.runtime.sendMessage({ action: "export_selected", tabId: tab.id, ids });
});

incrementalFromDateBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  if (!sinceDateEl.value) {
    statusEl.innerText = "Error: Pick a date first.";
    return;
  }
  const sinceDate = new Date(sinceDateEl.value).toISOString();
  beginRun("Incremental export from " + sinceDateEl.value + "...");
  chrome.runtime.sendMessage({ action: "export_incremental", tabId: tab.id, sinceDate });
});

seedCheckpointBtn.addEventListener("click", async () => {
  const tab = await requirePerplexityTab();
  if (!tab) return;
  beginRun("Syncing checkpoint with current archive...");
  chrome.runtime.sendMessage({ action: "seed_checkpoint", tabId: tab.id });
});

resetCheckpointBtn.addEventListener("click", () => {
  if (!confirm("Reset export checkpoint? Next incremental will treat all threads as new.")) return;
  chrome.runtime.sendMessage({ action: "reset_checkpoint" }, () => {
    statusEl.innerText = "Checkpoint reset.";
    loadCheckpointInfo();
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
loadExportRoot();

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
  }
});

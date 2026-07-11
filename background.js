importScripts("lib/settings.js", "lib/export-utils.js", "lib/checkpoint.js", "lib/archive-index.js");

let isRunning = false;
let linksQueue = [];
let currentIndex = 0;
let mainTabId = null;
let currentStatusText = "Ready to work";
let runContext = null;
let exportedForCheckpoint = [];
let cachedExportRoot = ExportSettings.DEFAULT_EXPORT_ROOT;
let cachedOverwriteOnExport = false;

function newRunContext(mode, filters) {
  return {
    mode,
    runTimestamp: new Date().toISOString(),
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    exportedIds: [],
    filters: filters || {},
    stoppedByUser: false
  };
}

function updateStatus(text, progress, total) {
  currentStatusText = text;
  try {
    chrome.runtime.sendMessage({
      action: "update_status",
      text,
      progress,
      total
    }).catch(() => {});
  } catch (e) {}
}

function downloadBlobContent(filename, content, mimeType) {
  return new Promise((resolve) => {
    const url = ExportUtils.contentToDataUrl(content, mimeType);
    const options = { url, filename, saveAs: false };
    if (cachedOverwriteOnExport) {
      options.conflictAction = "overwrite";
    }
    chrome.downloads.download(options, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function downloadTextFile(filename, content, mimeType) {
  return downloadBlobContent(filename, content, mimeType || "text/plain;charset=utf-8");
}

function fetchAllThreadsInTab(tabId, fetchOptions) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: fetchThreadsViaAPI,
    args: [fetchOptions || {}]
  }).then((results) => {
    if (results && results[0] && results[0].result) return results[0].result;
    return { chats: [], threadsChecked: 0, pagesScanned: 0 };
  });
}

async function buildFetchOptions(mode, options) {
  const sinceDate = options && options.sinceDate ? options.sinceDate : null;
  const deepScan = await ExportSettings.loadDeepScanIncremental();
  let fetchMode = "full";

  if (mode === "incremental") {
    fetchMode = sinceDate ? "sinceDate" : "incremental";
  }

  const fetchOptions = {
    mode: fetchMode,
    sinceDate,
    deepScan: Boolean(deepScan || (options && options.deepScan))
  };

  if (fetchMode === "incremental") {
    const checkpoint = await Checkpoint.loadCheckpoint();
    if (Checkpoint.isCheckpointSeeded(checkpoint)) {
      fetchOptions.checkpoint = Checkpoint.slimCheckpointForFetch(checkpoint);
    }
  }

  return fetchOptions;
}

function assertPerplexityTab(tabId) {
  return chrome.tabs.get(tabId).then((tab) => {
    if (!tab || !tab.url || !tab.url.includes("perplexity.ai")) {
      throw new Error("Tab is not a Perplexity page");
    }
    return tab;
  });
}

function startExportFromTab(tabId, mode, options) {
  return assertPerplexityTab(tabId)
    .then(() => beginExportRun(tabId, mode, options))
    .then((allChats) => resolveQueueFromList(allChats, mode, options))
    .then(() => startRunAfterQueueReady(mode))
    .catch(handleRunError);
}

function beginExportRun(tabId, mode, options) {
  if (isRunning) return Promise.reject(new Error("Export already running"));
  isRunning = true;
  mainTabId = tabId;
  runContext = newRunContext(mode, options && options.filters ? options.filters : {});
  exportedForCheckpoint = [];
  linksQueue = [];
  currentIndex = 0;
  updateStatus("Connecting to Perplexity API...", 0, 0);
  return Promise.all([ExportSettings.loadExportRoot(), ExportSettings.loadOverwriteOnExport()])
    .then(([root, overwrite]) => {
      cachedExportRoot = root;
      cachedOverwriteOnExport = overwrite;
      return buildFetchOptions(mode, options);
    })
    .then((fetchOptions) => fetchAllThreadsInTab(tabId, fetchOptions))
    .then((fetchResult) => {
      const allChats = fetchResult.chats || [];
      if (!allChats || allChats.length === 0) {
        throw new Error("Could not load thread list from Perplexity. Check login and try again.");
      }
      runContext.apiThreadCount = allChats.length;
      runContext.threadsChecked = fetchResult.threadsChecked || allChats.length;
      runContext.pagesScanned = fetchResult.pagesScanned || 0;
      runContext.earlyStopped = Boolean(fetchResult.earlyStopped);
      return allChats;
    });
}

function resolveQueueFromList(allChats, mode, options) {
  if (mode === "incremental") {
    const sinceDate = options && options.sinceDate ? options.sinceDate : null;

    if (sinceDate) {
      const filtered = ExportUtils.filterBySinceDate(allChats, sinceDate);
      linksQueue = filtered.toExport;
      runContext.skipped = filtered.skipped;
      runContext.apiThreadCount = filtered.apiTotal;
      runContext.dateOnlyExport = true;
      if (linksQueue.length > 0) {
        updateStatus(
          "Exporting " + linksQueue.length + " thread(s) since " + sinceDate.slice(0, 10) + "...",
          0,
          linksQueue.length
        );
      }
      return Promise.resolve();
    }

    return Checkpoint.loadCheckpoint().then((checkpoint) => {
      if (checkpoint.lastExportMode === "seed") {
        return Promise.reject(
          new Error(
            "Checkpoint was seeded from API (not your archive). Reset checkpoint, then sync from Downloads."
          )
        );
      }
      if (!checkpoint.lastSuccessfulExportAt || Object.keys(checkpoint.conversationIndex || {}).length === 0) {
        return Promise.reject(
          new Error(
            "Checkpoint not initialized. Import checkpoint JSON, seed from disk, or sync from Downloads first."
          )
        );
      }
      runContext.checkpoint = checkpoint;
      runContext.archiveFileCount =
        checkpoint.archiveMeta && checkpoint.archiveMeta.fileCount != null
          ? checkpoint.archiveMeta.fileCount
          : Object.keys(checkpoint.conversationIndex || {}).length;
      const filtered = ExportUtils.filterIncrementalCandidates(allChats, checkpoint, sinceDate);
      linksQueue = filtered.toExport;
      runContext.skipped = filtered.skipped;
      runContext.apiThreadCount = filtered.apiTotal;
      if (runContext.skipped > 0) {
        updateStatus(
          "Skipped " + runContext.skipped + " unchanged. Exporting " + linksQueue.length + "...",
          0,
          linksQueue.length
        );
      }
    });
  } else if (mode === "selected") {
    const ids = ExportUtils.dedupeIds((options && options.ids) || []);
    const { resolved, missing, invalid } = ExportUtils.findChatsByIds(allChats, ids);
    if (invalid.length > 0) {
      runContext.failures.push({
        uuid: invalid.join(", "),
        title: "Invalid ID",
        error: "Invalid conversation ID format"
      });
      runContext.failed += invalid.length;
    }
    if (missing.length > 0) {
      runContext.failures.push({ uuid: missing.join(", "), title: "Not found", error: "ID not in thread list" });
      runContext.failed += missing.length;
    }
    linksQueue = resolved;
    return Promise.resolve();
  }

  if (mode === "single") {
    const conversationId = options && options.conversationId;
    if (!conversationId) {
      return Promise.reject(new Error("No conversation ID"));
    }
    if (!ExportUtils.isValidConversationId(conversationId)) {
      return Promise.reject(new Error("Invalid conversation ID"));
    }
    return resolveSingleConversation(allChats, conversationId);
  }

  linksQueue = allChats;
  return Promise.resolve();
}

function resolveSingleConversation(allChats, conversationId) {
  const { resolved } = ExportUtils.findChatsByIds(allChats, [conversationId]);
  if (resolved.length > 0) {
    linksQueue = resolved;
    return Promise.resolve();
  }
  return chrome.scripting.executeScript({
    target: { tabId: mainTabId },
    func: resolveConversationFromApi,
    args: [conversationId]
  }).then((results) => {
    if (results && results[0] && results[0].result) {
      linksQueue = [results[0].result];
      return;
    }
    return Promise.reject(new Error("Could not resolve conversation metadata"));
  });
}

function startRunAfterQueueReady(mode) {
  if (linksQueue.length === 0) {
    if (runContext.failed > 0) {
      return finishRun();
    }
    isRunning = false;
    const emptyMsg = ExportUtils.buildEmptyQueueMessage(runContext);
    updateStatus(emptyMsg, 0, 0);
    runContext.emptyQueueMessage = emptyMsg;
    return finishRun();
  }
  currentIndex = 0;
  updateStatus("Starting download of " + linksQueue.length + " chat(s)...", 0, linksQueue.length);
  processNextAPI();
}

function handleRunError(err) {
  if (runContext) {
    runContext.failures.push({ uuid: "", title: "", error: err.message });
    runContext.failed++;
    finishRun();
    return;
  }
  isRunning = false;
  linksQueue = [];
  updateStatus("Error: " + err.message, 0, 0);
  chrome.runtime.sendMessage({
    action: "finished",
    summary: { attempted: 0, succeeded: 0, failed: 1, skipped: 0, text: "Error: " + err.message }
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "export-current-conversation",
      title: "Export this conversation",
      contexts: ["page"],
      documentUrlPatterns: ["*://*.perplexity.ai/search/*"]
    });
  });
});

async function runArchiveSeed() {
  if (isRunning) return Promise.reject(new Error("Export already running"));
  isRunning = true;
  runContext = newRunContext("archive-seed", {});
  exportedForCheckpoint = [];
  linksQueue = [];
  currentIndex = 0;
  updateStatus("Querying Chrome download history...", 0, 0);

  try {
    cachedExportRoot = await ExportSettings.loadExportRoot();
    const scanResult = await ArchiveIndex.scanDownloadsArchive(cachedExportRoot);
    const incoming = Checkpoint.buildCheckpointFromArchive(scanResult.entries, {
      exportRoot: cachedExportRoot,
      fileCount: scanResult.entries.length,
      skippedNoUuid: scanResult.skippedNoUuid.length,
      indexedFromDeleted: scanResult.indexedFromDeleted,
      lastScannedAt: scanResult.meta.lastScannedAt
    });
    const existing = await Checkpoint.loadCheckpoint();
    const priorCount = Checkpoint.countIndex(existing);
    const { checkpoint, stats } = Checkpoint.mergeCheckpoint(existing, incoming, { mode: "merge" });
    await Checkpoint.saveCheckpoint(checkpoint);
    const newCount = Checkpoint.countIndex(checkpoint);
    runContext.archiveFileCount = scanResult.entries.length;
    runContext.skipped = scanResult.entries.length;
    runContext.checkpoint = checkpoint;
    let summary =
      "Archive synced (merge): " +
      scanResult.entries.length +
      " files indexed from " +
      scanResult.downloadRecordsQueried +
      " download record(s)";
    summary += " · checkpoint " + priorCount + " → " + newCount + " threads";
    if (newCount < priorCount) {
      summary += " (warning: count decreased)";
    }
    if (stats.added > 0) summary += " · added " + stats.added;
    if (stats.updated > 0) summary += " · updated " + stats.updated;
    if (scanResult.indexedFromBasename > 0) {
      summary += " (" + scanResult.indexedFromBasename + " matched by filename only)";
    }
    if (scanResult.indexedFromDeleted > 0) {
      summary += " (" + scanResult.indexedFromDeleted + " from deleted download entries)";
    }
    if (scanResult.skippedNoUuid.length) {
      summary += " (" + scanResult.skippedNoUuid.length + " without UUID skipped)";
    }
    if (scanResult.entries.length === 0) {
      const counts = scanResult.meta.searchCounts || {};
      summary +=
        ". Diagnostics: merged=" +
        (scanResult.downloadRecordsQueried || 0) +
        ", allDownloads=" +
        (counts.allDownloads || 0) +
        ", uuidRegex=" +
        (counts.uuidRegex || 0) +
        ", mdQuery=" +
        (counts.mdQuery || 0) +
        ", noFilename=" +
        (scanResult.skippedNoFilename || 0) +
        ", rejectedPath=" +
        (scanResult.skippedWrongPath || 0);
      if (scanResult.meta.sampleUuidRegexFilenames && scanResult.meta.sampleUuidRegexFilenames.length) {
        summary += ", sample=" + scanResult.meta.sampleUuidRegexFilenames[0].slice(0, 80);
      }
    }
    runContext.emptyQueueMessage = summary;
    runContext.scanDiagnostics = scanResult.meta;
    await finishRun();
  } catch (err) {
    handleRunError(err);
    throw err;
  }
}

async function runDiskCheckpointMerge(entries, meta) {
  if (isRunning) return Promise.reject(new Error("Export already running"));
  isRunning = true;
  runContext = newRunContext("disk-seed", {});
  exportedForCheckpoint = [];
  linksQueue = [];
  currentIndex = 0;

  try {
    const incoming = Checkpoint.buildCheckpointFromDiskEntries(entries, meta);
    const existing = await Checkpoint.loadCheckpoint();
    const priorCount = Checkpoint.countIndex(existing);
    const { checkpoint, stats } = Checkpoint.mergeCheckpoint(existing, incoming, { mode: "merge" });
    await Checkpoint.saveCheckpoint(checkpoint);
    const newCount = Checkpoint.countIndex(checkpoint);
    runContext.archiveFileCount = entries.length;
    runContext.checkpoint = checkpoint;
    runContext.emptyQueueMessage =
      "Disk checkpoint merged: " +
      entries.length +
      " files indexed · checkpoint " +
      priorCount +
      " → " +
      newCount +
      " threads" +
      (stats.added ? " · added " + stats.added : "") +
      (stats.updated ? " · updated " + stats.updated : "") +
      (meta && meta.skippedNoUuid ? " · " + meta.skippedNoUuid + " without UUID skipped" : "");
    await finishRun();
    return { priorCount, newCount, stats };
  } catch (err) {
    handleRunError(err);
    throw err;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "export-current-conversation" || !tab || !tab.id || isRunning) return;
  if (!tab.url || !tab.url.includes("perplexity.ai")) return;
  const conversationId = ExportUtils.extractConversationIdFromUrl(tab.url);
  if (!conversationId) return;
  startExportFromTab(tab.id, "single", { conversationId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message.action === "get_status") {
    sendResponse({
      isRunning,
      text: currentStatusText,
      progress: currentIndex,
      total: linksQueue.length
    });
    return true;
  }

  if (message.action === "get_checkpoint_info") {
    Checkpoint.loadCheckpoint().then((cp) => {
      sendResponse(Checkpoint.getCheckpointInfo(cp));
    });
    return true;
  }

  if (message.action === "get_export_root") {
    ExportSettings.loadExportRoot().then((root) => {
      sendResponse({ exportRoot: root });
    });
    return true;
  }

  if (message.action === "get_archive_info") {
    ArchiveIndex.getArchiveInfo().then((info) => {
      sendResponse(info);
    });
    return true;
  }

  if (message.action === "set_export_root") {
    ExportSettings.saveExportRoot(message.exportRoot).then((sanitized) => {
      cachedExportRoot = sanitized;
      sendResponse({ exportRoot: sanitized });
    });
    return true;
  }

  if (message.action === "get_export_settings") {
    Promise.all([
      ExportSettings.loadExportRoot(),
      ExportSettings.loadOverwriteOnExport(),
      ExportSettings.loadDeepScanIncremental()
    ]).then(([exportRoot, overwriteOnExport, deepScanIncremental]) => {
      sendResponse({ exportRoot, overwriteOnExport, deepScanIncremental });
    });
    return true;
  }

  if (message.action === "set_overwrite_on_export") {
    ExportSettings.saveOverwriteOnExport(message.enabled).then((enabled) => {
      cachedOverwriteOnExport = enabled;
      sendResponse({ overwriteOnExport: enabled });
    });
    return true;
  }

  if (message.action === "set_deep_scan_incremental") {
    ExportSettings.saveDeepScanIncremental(message.enabled).then((enabled) => {
      sendResponse({ deepScanIncremental: enabled });
    });
    return true;
  }

  if (message.action === "import_checkpoint") {
    Checkpoint.importCheckpoint(message.checkpoint, { mode: message.replace ? "replace" : "merge" })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "merge_checkpoint_from_disk") {
    runDiskCheckpointMerge(message.entries || [], message.meta || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "reset_checkpoint") {
    Checkpoint.resetCheckpoint().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === "stop_batch") {
    if (runContext) runContext.stoppedByUser = true;
    isRunning = false;
    linksQueue = [];
    updateStatus("Stopped by user. Memory cleared.", currentIndex, 0);
    return;
  }

  if (isRunning) {
    if (
      message.action !== "get_status" &&
      message.action !== "get_checkpoint_info" &&
      message.action !== "get_export_root" &&
      message.action !== "get_archive_info" &&
      message.action !== "get_export_settings"
    ) {
      sendResponse && sendResponse({ error: "Export already running" });
    }
    return;
  }

  if (message.action === "seed_from_archive") {
    runArchiveSeed()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "start_batch") {
    startExportFromTab(message.tabId, "full", {});
    return;
  }

  if (message.action === "export_incremental") {
    const filters = {};
    if (message.sinceDate) filters.sinceDate = message.sinceDate;
    startExportFromTab(message.tabId, "incremental", { filters, sinceDate: message.sinceDate });
    return;
  }

  if (message.action === "export_selected") {
    const filters = { selectedIds: ExportUtils.dedupeIds(message.ids || []) };
    startExportFromTab(message.tabId, "selected", { filters, ids: message.ids });
    return;
  }

  if (message.action === "export_current") {
    const conversationId = ExportUtils.extractConversationIdFromUrl(message.tabUrl);
    if (!conversationId) {
      sendResponse({ error: "Not on a conversation page. Open a /search/... thread first." });
      return true;
    }
    startExportFromTab(message.tabId, "single", { conversationId });
    return true;
  }
});

async function finishRun() {
  const manifest = ExportUtils.buildRunManifest({
    runTimestamp: runContext.runTimestamp,
    runType: runContext.mode,
    mode: runContext.mode,
    filters: runContext.filters,
    exportRoot: cachedExportRoot,
    attempted: runContext.attempted,
    succeeded: runContext.succeeded,
    failed: runContext.failed,
    skipped: runContext.skipped,
    exportedIds: runContext.exportedIds,
    failures: runContext.failures,
    archiveFileCount: runContext.archiveFileCount ?? null,
    apiThreadCount: runContext.apiThreadCount ?? null,
    scanDiagnostics: runContext.scanDiagnostics || null
  });

  if (runContext.mode !== "archive-seed" && runContext.mode !== "disk-seed") {
    const manifestFilename = ExportUtils.buildManifestFilename(runContext.runTimestamp, cachedExportRoot);
    await downloadTextFile(manifestFilename, JSON.stringify(manifest, null, 2), "application/json");
  }

  if (runContext.mode !== "archive-seed" && runContext.mode !== "disk-seed" && ExportUtils.shouldUpdateCheckpoint(runContext)) {
    if (exportedForCheckpoint.length > 0) {
      const checkpoint = await Checkpoint.loadCheckpoint();
      const updated = Checkpoint.updateCheckpointAfterSuccess(checkpoint, exportedForCheckpoint, runContext);
      await Checkpoint.saveCheckpoint(updated);
    }
  }

  let summaryText = runContext.emptyQueueMessage || ExportUtils.buildSummaryText(runContext);
  isRunning = false;
  linksQueue = [];
  updateStatus(summaryText, runContext.succeeded, 0);

  chrome.runtime.sendMessage({
    action: "finished",
    summary: {
      attempted: runContext.attempted,
      succeeded: runContext.succeeded,
      failed: runContext.failed,
      skipped: runContext.skipped,
      text: summaryText
    }
  }).catch(() => {});
}

function processNextAPI() {
  if (!isRunning) return;

  if (currentIndex >= linksQueue.length) {
    finishRun();
    return;
  }

  const chatData = linksQueue[currentIndex];
  runContext.attempted++;
  updateStatus(
    "Exporting [" + chatData.space + "]: " + (currentIndex + 1) + " of " + linksQueue.length,
    currentIndex,
    linksQueue.length
  );

  const threadUrl =
    "https://www.perplexity.ai/rest/thread/" +
    chatData.uuid +
    "?with_schematized_response=true&version=2.18&source=default";

  chrome.scripting
    .executeScript({
      target: { tabId: mainTabId },
      func: fetchSingleChatContent,
      args: [chatData, threadUrl]
    })
    .then((results) => {
      if (!isRunning) return;

      if (results && results[0] && results[0].result && results[0].result.content) {
        const data = results[0].result;
        const finalFilename = ExportUtils.buildFilename(chatData, cachedExportRoot);

        downloadBlobContent(finalFilename, data.content, "text/markdown;charset=utf-8").then((ok) => {
          if (!isRunning) return;
          if (ok) {
            runContext.succeeded++;
            runContext.exportedIds.push(chatData.uuid);
            exportedForCheckpoint.push({
              uuid: chatData.uuid,
              title: chatData.title,
              date: chatData.date,
              updatedAt: data.updatedAt || chatData.updatedAt || chatData.date
            });
          } else {
            runContext.failed++;
            runContext.failures.push({
              uuid: chatData.uuid,
              title: chatData.title,
              error: "Download failed"
            });
          }
          currentIndex++;
          setTimeout(processNextAPI, 1000);
        });
      } else {
        runContext.failed++;
        runContext.failures.push({
          uuid: chatData.uuid,
          title: chatData.title,
          error: "Failed to fetch or parse conversation"
        });
        currentIndex++;
        setTimeout(processNextAPI, 1000);
      }
    })
    .catch((err) => {
      runContext.failed++;
      runContext.failures.push({
        uuid: chatData.uuid,
        title: chatData.title,
        error: err && err.message ? err.message : "Script injection failed"
      });
      currentIndex++;
      setTimeout(processNextAPI, 1000);
    });
}

async function fetchThreadsViaAPI(options) {
  options = options || {};
  const mode = options.mode || "full";
  const sinceDate = options.sinceDate || null;
  const checkpoint = options.checkpoint || null;
  const deepScan = Boolean(options.deepScan);

  function parseTimestamp(ts) {
    if (!ts) return 0;
    const n = Date.parse(ts);
    return Number.isNaN(n) ? 0 : n;
  }

  function getChatUpdatedAt(chat) {
    return (
      chat.updatedAt ||
      chat.last_query_datetime ||
      chat.updated_at ||
      chat.date ||
      chat.inserted_at ||
      chat.created_at ||
      null
    );
  }

  function shouldExportOnPage(chat) {
    if (!checkpoint || !checkpoint.conversationIndex) return true;
    const prev = checkpoint.conversationIndex[chat.uuid];
    if (!prev) return true;
    const updatedMs = parseTimestamp(getChatUpdatedAt(chat));
    const prevMs = parseTimestamp(prev.updatedAt);
    if (!updatedMs || !prevMs) return true;
    return updatedMs > prevMs;
  }

  function isPageFullySynced(page) {
    if (!page || page.length === 0) return false;
    for (const chat of page) {
      if (shouldExportOnPage(chat)) return false;
    }
    return true;
  }

  function isPageOlderThanSince(page) {
    if (!page || page.length === 0) return true;
    const sinceMs = parseTimestamp(sinceDate);
    if (!sinceMs) return false;
    for (const chat of page) {
      if (parseTimestamp(getChatUpdatedAt(chat)) >= sinceMs) return false;
    }
    return true;
  }

  let allChats = [];
  let offset = 0;
  let pagesScanned = 0;
  let earlyStopped = false;
  const limit = 50;
  const url = "https://www.perplexity.ai/rest/thread/list_ask_threads?version=2.18&source=default";
  const canEarlyStop =
    !deepScan &&
    (mode === "sinceDate" || (mode === "incremental" && checkpoint && checkpoint.seededFromArchive));

  while (true) {
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "x-perplexity-request-endpoint": url,
          "x-perplexity-request-try-number": "1"
        },
        body: JSON.stringify({ limit, ascending: false, offset, search_term: "" })
      });

      if (!response.ok) break;
      const data = await response.json();
      let list = [];

      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.list)) list = data.list;
      else if (data && Array.isArray(data.threads)) list = data.threads;

      if (list.length === 0) break;

      const pageChats = [];
      list.forEach((item) => {
        if (item.uuid) {
          let spaceName = "General";
          if (item.collection && item.collection.title) {
            spaceName = item.collection.title;
          } else if (item.collection_info && item.collection_info.title) {
            spaceName = item.collection_info.title;
          } else if (item.space_info && item.space_info.name) {
            spaceName = item.space_info.name;
          }

          pageChats.push({
            uuid: item.uuid,
            title: item.title || "Untitled",
            date: item.inserted_at || item.created_at || new Date().toISOString(),
            updatedAt:
              item.last_query_datetime ||
              item.updated_at ||
              item.inserted_at ||
              item.created_at ||
              new Date().toISOString(),
            slug: item.slug || null,
            space: spaceName
          });
        }
      });

      allChats = allChats.concat(pageChats);
      pagesScanned += 1;

      const statusText =
        canEarlyStop || mode !== "full"
          ? "Checked " + allChats.length + " recent thread(s)..."
          : "Scanning database... Found: " + allChats.length;
      chrome.runtime.sendMessage({ action: "update_status", text: statusText }).catch(() => {});

      if (canEarlyStop) {
        if (mode === "incremental" && isPageFullySynced(pageChats)) {
          earlyStopped = true;
          break;
        }
        if (mode === "sinceDate" && isPageOlderThanSince(pageChats)) {
          earlyStopped = true;
          break;
        }
      }

      if (list.length < limit) break;
      offset += limit;
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      break;
    }
  }

  return {
    chats: allChats,
    threadsChecked: allChats.length,
    pagesScanned,
    earlyStopped
  };
}

async function resolveConversationFromApi(conversationId) {
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function maxEntryUpdatedAt(entries) {
    if (!entries || !Array.isArray(entries)) return null;
    let max = null;
    for (const entry of entries) {
      const ts = entry.entry_updated_datetime || entry.updated_at;
      if (ts && (!max || ts > max)) max = ts;
    }
    return max;
  }

  const threadUrl =
    "https://www.perplexity.ai/rest/thread/" +
    conversationId +
    "?with_schematized_response=true&version=2.18&source=default";

  try {
    const response = await fetch(threadUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "*/*",
        "x-perplexity-request-endpoint": threadUrl,
        "x-perplexity-request-reason": "search-components"
      }
    });

    if (!response.ok) return null;
    const data = await response.json();

    let title = "Untitled";
    if (data.thread_metadata && data.thread_metadata.title) {
      title = data.thread_metadata.title;
    } else if (data.entries && data.entries[0] && data.entries[0].thread_title) {
      title = data.entries[0].thread_title;
    }

    let uuid = conversationId;
    const uuidMatch = conversationId.match(UUID_RE);
    if (uuidMatch) {
      uuid = uuidMatch[0];
    } else if (data.entries && data.entries[0] && data.entries[0].context_uuid) {
      uuid = data.entries[0].context_uuid;
    }

    const updatedAt =
      (data.thread_metadata && data.thread_metadata.updated_at) ||
      maxEntryUpdatedAt(data.entries) ||
      new Date().toISOString();

    return {
      uuid,
      title,
      date: (data.thread_metadata && data.thread_metadata.created_at) || updatedAt,
      updatedAt,
      slug: conversationId,
      space: "General"
    };
  } catch (e) {
    return null;
  }
}

async function fetchSingleChatContent(metadata, apiUrl) {
  function maxEntryUpdatedAt(entries) {
    if (!entries || !Array.isArray(entries)) return null;
    let max = null;
    for (const entry of entries) {
      const ts = entry.entry_updated_datetime || entry.updated_at;
      if (ts && (!max || ts > max)) max = ts;
    }
    return max;
  }

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "*/*",
        "x-perplexity-request-endpoint": apiUrl,
        "x-perplexity-request-reason": "search-components"
      }
    });

    if (!response.ok) return null;
    const data = await response.json();

    let updatedAt =
      (data.thread_metadata && data.thread_metadata.updated_at) ||
      maxEntryUpdatedAt(data.entries) ||
      metadata.updatedAt ||
      metadata.date;

    let markdown = "# " + metadata.title + "\n\n";
    markdown += "**Space:** " + metadata.space + "\n";
    markdown += "**ID:** " + metadata.uuid + "\n";
    markdown += "**Date:** " + metadata.date + "\n\n---\n\n";

    if (data && data.entries && Array.isArray(data.entries)) {
      data.entries.forEach((entry) => {
        if (entry.query_str) {
          markdown += "## 👤 User:\n" + entry.query_str + "\n\n";
          markdown += "## 🤖 Perplexity:\n";

          let entryTexts = new Set();
          let filesFound = [];
          let stepsFound = [];

          const extractAggressive = (obj, depth = 0) => {
            if (depth > 20 || typeof obj !== "object" || obj === null) return;

            if (obj.filename || obj.name || (obj.code && obj.language)) {
              let fname = obj.filename || obj.name || "Generated_File";
              let fcontent = obj.code || obj.content || obj.text || obj.value;
              let flang = obj.language || "text";

              if (fcontent && typeof fcontent === "string" && fcontent.length > 5) {
                let fileBlock =
                  "> 📦 **Generated File/Artifact:** `" +
                  fname +
                  "`\n\n```" +
                  flang +
                  "\n" +
                  fcontent +
                  "\n```\n";
                if (!filesFound.includes(fileBlock)) filesFound.push(fileBlock);
                obj.code = "";
                obj.content = "";
                obj.text = "";
                obj.value = "";
              }
            }

            if (obj.action || obj.step_type || obj.tool_name || obj.query) {
              let stepTitle =
                obj.action || obj.step_type || obj.tool_name || obj.title || "Background Operation";
              let stepDetail = obj.query || obj.text || obj.summary || "";

              if (stepDetail && typeof stepDetail === "string" && stepDetail.length > 2) {
                let stepStr =
                  "> 👣 **Step:** `" +
                  stepTitle +
                  "`\n> *Details:* " +
                  stepDetail.replace(/\n/g, " ") +
                  "\n";
                if (!stepsFound.includes(stepStr)) stepsFound.push(stepStr);
              }
            }

            Object.keys(obj).forEach((key) => {
              let val = obj[key];
              if (typeof val === "string" && val.length > 50) {
                let k = key.toLowerCase();
                if (
                  !k.includes("id") &&
                  !k.includes("url") &&
                  !k.includes("date") &&
                  !k.includes("time") &&
                  !k.includes("query")
                ) {
                  entryTexts.add(val);
                }
              } else if (typeof val === "object") {
                extractAggressive(val, depth + 1);
              }
            });
          };

          extractAggressive(entry);

          if (stepsFound.length > 0) {
            markdown += "### 👣 AI Step Log:\n";
            stepsFound.forEach((s) => {
              markdown += s + "\n";
            });
            markdown += "\n";
          }

          let answer = "";
          if (entry.blocks && Array.isArray(entry.blocks)) {
            const textBlock = entry.blocks.find(
              (b) =>
                b.intended_usage === "ask_text" ||
                b.intended_usage === "answer" ||
                b.markdown_block
            );
            if (textBlock && textBlock.markdown_block && textBlock.markdown_block.answer) {
              answer = textBlock.markdown_block.answer;
            }
          }
          if (answer) markdown += "### 📝 Main Answer:\n" + answer + "\n\n";

          if (filesFound.length > 0) {
            markdown += "### 📦 Generated Files & Artifacts:\n";
            filesFound.forEach((f) => {
              markdown += f + "\n\n";
            });
          }

          let uniqueTexts = Array.from(entryTexts).sort((a, b) => b.length - a.length);
          let finalEntryMarkdown = "";

          uniqueTexts.forEach((t) => {
            let checkStr = t.trim().substring(0, 100);
            if (
              checkStr.length > 10 &&
              !finalEntryMarkdown.includes(checkStr) &&
              !markdown.includes(checkStr)
            ) {
              finalEntryMarkdown += t + "\n\n";
            }
          });

          if (finalEntryMarkdown.trim().length > 0) {
            markdown += "### 🗃️ Cache Dump (Additional Data):\n" + finalEntryMarkdown;
          }

          markdown += "---\n\n";
        }
      });
    }
    return { content: markdown, updatedAt };
  } catch (e) {
    return null;
  }
}

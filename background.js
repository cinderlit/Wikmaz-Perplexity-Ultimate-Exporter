importScripts("lib/export-utils.js", "lib/checkpoint.js");

let isRunning = false;
let linksQueue = [];
let currentIndex = 0;
let mainTabId = null;
let currentStatusText = "Ready to work";
let runContext = null;
let exportedForCheckpoint = [];
let seedChatList = null;

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

function downloadTextFile(filename, content, mimeType) {
  const blobUrl = "data:" + mimeType + ";charset=utf-8," + encodeURIComponent(content);
  return new Promise((resolve) => {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, () => resolve());
  });
}

function fetchAllThreadsInTab(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: fetchAllThreadsViaAPI
  }).then((results) => {
    if (results && results[0] && results[0].result) return results[0].result;
    return [];
  });
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
  seedChatList = null;
  linksQueue = [];
  currentIndex = 0;
  updateStatus("Connecting to Perplexity API...", 0, 0);
  return fetchAllThreadsInTab(tabId);
}

function resolveQueueFromList(allChats, mode, options) {
  if (mode === "seed") {
    seedChatList = allChats;
    linksQueue = [];
    runContext.skipped = allChats.length;
    return Promise.resolve();
  }

  if (mode === "incremental") {
    const sinceDate = options && options.sinceDate ? options.sinceDate : null;
    return Checkpoint.loadCheckpoint().then((checkpoint) => {
      const filtered = ExportUtils.filterIncrementalCandidates(allChats, checkpoint, sinceDate);
      linksQueue = filtered.toExport;
      runContext.skipped = filtered.skipped;
      if (runContext.skipped > 0) {
        updateStatus("Skipped " + runContext.skipped + " unchanged. Exporting " + linksQueue.length + "...", 0, linksQueue.length);
      }
    });
  }

  if (mode === "selected") {
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
  if (mode === "seed") {
    return finishRun();
  }
  if (linksQueue.length === 0) {
    if (runContext.failed > 0) {
      return finishRun();
    }
    isRunning = false;
    updateStatus("No chats to export.", 0, 0);
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
  chrome.contextMenus.create({
    id: "export-current-conversation",
    title: "Export this conversation",
    contexts: ["page"],
    documentUrlPatterns: ["*://*.perplexity.ai/search/*"]
  });
});

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
    if (message.action !== "get_status" && message.action !== "get_checkpoint_info") {
      sendResponse && sendResponse({ error: "Export already running" });
    }
    return;
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

  if (message.action === "seed_checkpoint") {
    startExportFromTab(message.tabId, "seed", {});
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
    attempted: runContext.attempted,
    succeeded: runContext.succeeded,
    failed: runContext.failed,
    skipped: runContext.skipped,
    exportedIds: runContext.exportedIds,
    failures: runContext.failures
  });

  const manifestFilename = ExportUtils.buildManifestFilename(runContext.runTimestamp);
  await downloadTextFile(manifestFilename, JSON.stringify(manifest, null, 2), "application/json");

  if (ExportUtils.shouldUpdateCheckpoint(runContext)) {
    if (runContext.mode === "seed" && seedChatList) {
      const seeded = Checkpoint.seedCheckpointFromList(seedChatList);
      await Checkpoint.saveCheckpoint(seeded);
    } else if (exportedForCheckpoint.length > 0) {
      const checkpoint = await Checkpoint.loadCheckpoint();
      const updated = Checkpoint.updateCheckpointAfterSuccess(checkpoint, exportedForCheckpoint, runContext);
      await Checkpoint.saveCheckpoint(updated);
    }
  }

  const summaryText = ExportUtils.buildSummaryText(runContext);
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
        const blobUrl = "data:text/markdown;charset=utf-8," + encodeURIComponent(data.content);
        const finalFilename = ExportUtils.buildFilename(chatData);

        chrome.downloads.download({ url: blobUrl, filename: finalFilename, saveAs: false }, () => {
          runContext.succeeded++;
          runContext.exportedIds.push(chatData.uuid);
          exportedForCheckpoint.push({
            uuid: chatData.uuid,
            title: chatData.title,
            date: chatData.date,
            updatedAt: data.updatedAt || chatData.updatedAt || chatData.date
          });
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

async function fetchAllThreadsViaAPI() {
  let allChats = [];
  let offset = 0;
  const limit = 50;
  const url = "https://www.perplexity.ai/rest/thread/list_ask_threads?version=2.18&source=default";

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

          allChats.push({
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

      chrome.runtime
        .sendMessage({ action: "update_status", text: "Scanning database... Found: " + allChats.length })
        .catch(() => {});
      offset += limit;
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      break;
    }
  }
  return allChats;
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

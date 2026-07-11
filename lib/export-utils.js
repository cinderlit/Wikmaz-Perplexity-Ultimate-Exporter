(function (root) {
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const SLUG_RE = /^[a-zA-Z0-9_-]{1,200}$/;

  function isValidConversationId(id) {
    if (!id || typeof id !== "string") return false;
    const trimmed = id.trim();
    if (UUID_RE.test(trimmed)) return true;
    return SLUG_RE.test(trimmed);
  }

  function sanitizeUuid(uuid) {
    const match = String(uuid || "").match(UUID_RE);
    return match ? match[0] : "unknown";
  }

  function extractConversationIdFromUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes("perplexity.ai")) return null;
      const match = parsed.pathname.match(/\/search\/([^/?#]+)/);
      if (!match) return null;
      const segment = decodeURIComponent(match[1]);
      const uuidMatch = segment.match(UUID_RE);
      const candidate = uuidMatch ? uuidMatch[0] : segment;
      return isValidConversationId(candidate) ? candidate : null;
    } catch (e) {
      return null;
    }
  }

  function dedupeIds(ids) {
    const seen = new Set();
    const result = [];
    for (const raw of ids || []) {
      const id = String(raw || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function normalizeExportRoot(exportRoot) {
    if (typeof ExportSettings !== "undefined" && ExportSettings.sanitizeExportRoot) {
      return ExportSettings.sanitizeExportRoot(exportRoot);
    }
    const root = String(exportRoot || "Perplexity_Export").trim().replace(/\\/g, "/");
    const segments = root
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter((s) => s && s !== "." && s !== "..");
    return segments.length > 0 ? segments.join("/") : "Perplexity_Export";
  }

  function buildFilename(chatData, exportRoot) {
    let safeTitle = (chatData.title || "Untitled")
      .replace(/[^a-z0-9A-Z_ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, "_")
      .substring(0, 80)
      .trim();
    let safeSpace = (chatData.space || "General")
      .replace(/[^a-z0-9A-Z_ąćęłńóśźżĄĆĘŁŃÓŚŹŻ \-]/g, "_")
      .trim();
    if (!safeSpace) safeSpace = "General";
    const safeUuid = sanitizeUuid(chatData.uuid);
    const root = normalizeExportRoot(exportRoot);
    return root + "/" + safeSpace + "/" + safeTitle + " (" + safeUuid + ").md";
  }

  function buildManifestFilename(runTimestamp, exportRoot) {
    const safeTs = (runTimestamp || new Date().toISOString()).replace(/[:.]/g, "-");
    const root = normalizeExportRoot(exportRoot);
    return root + "/manifest-" + safeTs + ".json";
  }

  function buildRunManifest(runMeta) {
    return {
      runTimestamp: runMeta.runTimestamp || new Date().toISOString(),
      runType: runMeta.runType || runMeta.mode || "full",
      filters: runMeta.filters || {},
      exportRoot: runMeta.exportRoot || null,
      attempted: runMeta.attempted || 0,
      succeeded: runMeta.succeeded || 0,
      failed: runMeta.failed || 0,
      skipped: runMeta.skipped || 0,
      exportedIds: runMeta.exportedIds || [],
      failures: runMeta.failures || [],
      archiveFileCount: runMeta.archiveFileCount ?? null,
      apiThreadCount: runMeta.apiThreadCount ?? null,
      scanDiagnostics: runMeta.scanDiagnostics || null,
      outputFormat: "markdown"
    };
  }

  function maxEntryUpdatedAt(entries) {
    if (!entries || !Array.isArray(entries)) return null;
    let max = null;
    for (const entry of entries) {
      const ts = entry.entry_updated_datetime || entry.updated_at;
      if (ts && (!max || ts > max)) max = ts;
    }
    return max;
  }

  function getConversationTimestamp(listItem, threadDetail) {
    if (threadDetail) {
      if (threadDetail.thread_metadata && threadDetail.thread_metadata.updated_at) {
        return threadDetail.thread_metadata.updated_at;
      }
      const entryMax = maxEntryUpdatedAt(threadDetail.entries);
      if (entryMax) return entryMax;
    }
    if (listItem) {
      return (
        listItem.updatedAt ||
        listItem.last_query_datetime ||
        listItem.updated_at ||
        listItem.date ||
        listItem.inserted_at ||
        listItem.created_at ||
        null
      );
    }
    return null;
  }

  function parseTimestamp(ts) {
    if (!ts) return 0;
    const n = Date.parse(ts);
    return Number.isNaN(n) ? 0 : n;
  }

  function shouldExportConversation(chat, checkpoint, sinceDate) {
    const updatedAt = getConversationTimestamp(chat);
    const updatedMs = parseTimestamp(updatedAt);
    if (sinceDate) {
      const sinceMs = parseTimestamp(sinceDate);
      if (sinceMs && updatedMs < sinceMs) return false;
    }
    if (!checkpoint || !checkpoint.conversationIndex) return true;
    const prev = checkpoint.conversationIndex[chat.uuid];
    if (!prev) return true;
    const prevMs = parseTimestamp(prev.updatedAt);
    if (!updatedMs) return true;
    if (!prevMs) return true;
    return updatedMs > prevMs;
  }

  function shouldExportBySinceDate(chat, sinceDate) {
    if (!sinceDate) return true;
    const sinceMs = parseTimestamp(sinceDate);
    if (!sinceMs) return true;
    const updatedMs = parseTimestamp(getConversationTimestamp(chat));
    if (!updatedMs) return true;
    return updatedMs >= sinceMs;
  }

  function filterBySinceDate(chats, sinceDate) {
    const toExport = [];
    let skipped = 0;
    for (const chat of chats || []) {
      if (shouldExportBySinceDate(chat, sinceDate)) {
        toExport.push(chat);
      } else {
        skipped++;
      }
    }
    return { toExport, skipped, apiTotal: (chats || []).length };
  }

  function isPageFullySynced(page, checkpoint) {
    if (!page || page.length === 0) return false;
    if (!checkpoint || !checkpoint.conversationIndex) return false;
    for (const chat of page) {
      if (shouldExportConversation(chat, checkpoint, null)) return false;
    }
    return true;
  }

  function isPageOlderThanSince(page, sinceDate) {
    if (!page || page.length === 0) return true;
    if (!sinceDate) return false;
    const sinceMs = parseTimestamp(sinceDate);
    if (!sinceMs) return false;
    for (const chat of page) {
      const updatedMs = parseTimestamp(getConversationTimestamp(chat));
      if (updatedMs >= sinceMs) return false;
    }
    return true;
  }

  function filterIncrementalCandidates(chats, checkpoint, sinceDate) {
    const toExport = [];
    let skipped = 0;
    for (const chat of chats || []) {
      if (shouldExportConversation(chat, checkpoint, sinceDate)) {
        toExport.push(chat);
      } else {
        skipped++;
      }
    }
    return { toExport, skipped, apiTotal: (chats || []).length };
  }

  function buildEmptyQueueMessage(runContext) {
    const archiveCount =
      runContext.archiveFileCount ??
      (runContext.checkpoint && runContext.checkpoint.archiveMeta
        ? runContext.checkpoint.archiveMeta.fileCount
        : null);
    const apiTotal = runContext.apiThreadCount ?? null;
    const skipped = runContext.skipped ?? 0;
    const details = [];
    if (runContext.filters && runContext.filters.sinceDate) {
      details.push("since: " + runContext.filters.sinceDate);
    }
    if (archiveCount != null) details.push("archive: " + archiveCount + " files");
    if (apiTotal != null) details.push("API: " + apiTotal + " threads");
    if (skipped > 0) details.push("skipped: " + skipped);
    if (details.length === 0) return "No new or changed conversations.";
    return "No new or changed conversations (" + details.join(", ") + ")";
  }

  function shouldUpdateCheckpoint(runContext) {
    if (!runContext) return false;
    if (runContext.failed > 0) return false;
    if (runContext.stoppedByUser) return false;
    return true;
  }

  function findChatsByIds(allChats, ids) {
    const wanted = dedupeIds(ids);
    const byUuid = new Map();
    const bySlug = new Map();
    for (const chat of allChats || []) {
      byUuid.set(chat.uuid, chat);
      if (chat.slug) bySlug.set(chat.slug, chat);
    }
    const resolved = [];
    const missing = [];
    const invalid = [];
    for (const id of wanted) {
      if (!isValidConversationId(id)) {
        invalid.push(id);
        continue;
      }
      const chat = byUuid.get(id) || bySlug.get(id);
      if (chat) resolved.push(chat);
      else missing.push(id);
    }
    return { resolved, missing, invalid };
  }

  function buildSummaryText(runContext) {
    const parts = [];
    parts.push("Done: " + runContext.succeeded + " exported");
    if (runContext.failed > 0) parts.push(runContext.failed + " failed");
    if (runContext.skipped > 0) parts.push(runContext.skipped + " skipped");
    if (runContext.failed > 0) parts.push("(checkpoint not updated)");
    return parts.join(", ");
  }

  function contentToDataUrl(content, mimeType) {
    const type = mimeType || "text/plain;charset=utf-8";
    const base64 = btoa(unescape(encodeURIComponent(String(content))));
    return "data:" + type + ";base64," + base64;
  }

  const api = {
    UUID_RE,
    SLUG_RE,
    isValidConversationId,
    sanitizeUuid,
    extractConversationIdFromUrl,
    dedupeIds,
    normalizeExportRoot,
    buildFilename,
    buildManifestFilename,
    buildRunManifest,
    maxEntryUpdatedAt,
    getConversationTimestamp,
    parseTimestamp,
    shouldExportConversation,
    shouldExportBySinceDate,
    isPageFullySynced,
    isPageOlderThanSince,
    filterBySinceDate,
    filterIncrementalCandidates,
    shouldUpdateCheckpoint,
    findChatsByIds,
    buildSummaryText,
    buildEmptyQueueMessage,
    contentToDataUrl
  };

  root.ExportUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : global);

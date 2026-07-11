(function (root) {
  const STORAGE_KEY = "exportCheckpoint";
  const UUID_STRICT_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SEEDED_THRESHOLD = 500;

  const SOURCE_PRIORITY = {
    export: 3,
    archive: 2,
    disk: 1,
    "disk-seed": 1,
    "disk-import": 1
  };

  function emptyCheckpoint() {
    return {
      version: 1,
      lastSuccessfulExportAt: null,
      lastExportMode: null,
      lastSince: null,
      seededFromArchive: false,
      conversationIndex: {}
    };
  }

  function parseTimestamp(ts) {
    if (!ts) return 0;
    const n = Date.parse(ts);
    return Number.isNaN(n) ? 0 : n;
  }

  function isValidUuid(uuid) {
    return Boolean(uuid && UUID_STRICT_RE.test(uuid));
  }

  function countIndex(checkpoint) {
    return Object.keys((checkpoint && checkpoint.conversationIndex) || {}).length;
  }

  function isCheckpointSeeded(checkpoint) {
    if (!checkpoint) return false;
    if (checkpoint.seededFromArchive) return true;
    const fileCount = checkpoint.archiveMeta && checkpoint.archiveMeta.fileCount;
    if (fileCount != null && fileCount >= SEEDED_THRESHOLD) return true;
    return countIndex(checkpoint) >= SEEDED_THRESHOLD;
  }

  function applySeededFromArchiveFlag(checkpoint) {
    if (!checkpoint) return checkpoint;
    if (isCheckpointSeeded(checkpoint)) {
      checkpoint.seededFromArchive = true;
    }
    return checkpoint;
  }

  function slimCheckpointForFetch(checkpoint) {
    if (!checkpoint || !checkpoint.conversationIndex) {
      return { seededFromArchive: false, conversationIndex: {} };
    }
    const slimIndex = {};
    for (const [uuid, entry] of Object.entries(checkpoint.conversationIndex)) {
      slimIndex[uuid] = { updatedAt: entry.updatedAt || null };
    }
    return {
      seededFromArchive: isCheckpointSeeded(checkpoint),
      conversationIndex: slimIndex
    };
  }

  function loadCheckpoint() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        const cp = data[STORAGE_KEY];
        if (cp && cp.version === 1 && cp.conversationIndex) {
          resolve(cp);
        } else {
          resolve(emptyCheckpoint());
        }
      });
    });
  }

  function saveCheckpoint(checkpoint) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: checkpoint }, resolve);
    });
  }

  function resetCheckpoint() {
    return saveCheckpoint(emptyCheckpoint());
  }

  function getCheckpointInfo(checkpoint) {
    const index = checkpoint && checkpoint.conversationIndex ? checkpoint.conversationIndex : {};
    return {
      lastSuccessfulExportAt: checkpoint ? checkpoint.lastSuccessfulExportAt : null,
      lastExportMode: checkpoint ? checkpoint.lastExportMode : null,
      seededFromArchive: checkpoint ? Boolean(checkpoint.seededFromArchive) : false,
      count: Object.keys(index).length
    };
  }

  function updateCheckpointAfterSuccess(checkpoint, exportedConversations, runMeta) {
    const now = new Date().toISOString();
    const next = checkpoint ? { ...checkpoint, conversationIndex: { ...checkpoint.conversationIndex } } : emptyCheckpoint();
    next.version = 1;
    next.lastSuccessfulExportAt = now;
    next.lastExportMode = runMeta.mode || runMeta.runType || "full";
    next.lastSince = runMeta.filters && runMeta.filters.sinceDate ? runMeta.filters.sinceDate : null;
    if (!next.conversationIndex) next.conversationIndex = {};

    for (const conv of exportedConversations || []) {
      if (!conv.uuid) continue;
      next.conversationIndex[conv.uuid] = {
        updatedAt: conv.updatedAt || conv.date || now,
        exportedAt: now,
        source: "export",
        title: conv.title || undefined
      };
      if (conv.hash) next.conversationIndex[conv.uuid].hash = conv.hash;
    }

    return applySeededFromArchiveFlag(next);
  }

  function shouldKeepExistingEntry(existing, incoming) {
    if (!existing) return false;
    if (!incoming) return true;
    const existingMs = parseTimestamp(existing.updatedAt);
    const incomingMs = parseTimestamp(incoming.updatedAt);
    if (incomingMs > existingMs) return false;
    if (incomingMs < existingMs) return true;
    const existingPriority = SOURCE_PRIORITY[existing.source] || 0;
    const incomingPriority = SOURCE_PRIORITY[incoming.source] || 0;
    return existingPriority >= incomingPriority;
  }

  function validateCheckpointImport(data) {
    if (!data || typeof data !== "object") {
      return { valid: false, error: "Checkpoint must be a JSON object" };
    }
    if (data.version !== 1) {
      return { valid: false, error: "Unsupported checkpoint version (expected 1)" };
    }
    if (!data.conversationIndex || typeof data.conversationIndex !== "object") {
      return { valid: false, error: "Missing conversationIndex object" };
    }
    let invalidKeys = 0;
    for (const uuid of Object.keys(data.conversationIndex)) {
      if (!isValidUuid(uuid)) invalidKeys += 1;
    }
    if (invalidKeys > 0 && Object.keys(data.conversationIndex).length === invalidKeys) {
      return { valid: false, error: "No valid UUID keys in conversationIndex" };
    }
    return { valid: true, invalidKeys };
  }

  function normalizeIncomingCheckpoint(incoming) {
    const base = emptyCheckpoint();
    const next = {
      ...base,
      ...incoming,
      conversationIndex: { ...(incoming.conversationIndex || {}) }
    };
    if (incoming.archiveMeta) {
      next.archiveMeta = { ...incoming.archiveMeta };
    }
    return applySeededFromArchiveFlag(next);
  }

  function mergeCheckpoint(existing, incoming, options) {
    const mode = (options && options.mode) || "merge";
    const stats = { added: 0, updated: 0, kept: 0 };

    if (!incoming) {
      return { checkpoint: existing || emptyCheckpoint(), stats };
    }

    if (mode === "replace" || !existing || !existing.conversationIndex) {
      const replaced = normalizeIncomingCheckpoint(incoming);
      stats.added = countIndex(replaced);
      return { checkpoint: replaced, stats };
    }

    const next = {
      ...existing,
      conversationIndex: { ...existing.conversationIndex },
      archiveMeta: incoming.archiveMeta
        ? { ...(existing.archiveMeta || {}), ...incoming.archiveMeta }
        : existing.archiveMeta
    };

    for (const [uuid, entry] of Object.entries(incoming.conversationIndex || {})) {
      if (!isValidUuid(uuid) || !entry) continue;
      const prev = next.conversationIndex[uuid];
      if (!prev) {
        next.conversationIndex[uuid] = { ...entry };
        stats.added += 1;
      } else if (!shouldKeepExistingEntry(prev, entry)) {
        next.conversationIndex[uuid] = { ...entry };
        stats.updated += 1;
      } else {
        stats.kept += 1;
      }
    }

    if (incoming.lastSuccessfulExportAt) {
      next.lastSuccessfulExportAt = incoming.lastSuccessfulExportAt;
    }
    if (incoming.lastExportMode) {
      next.lastExportMode = incoming.lastExportMode;
    }
    if (incoming.lastSince != null) {
      next.lastSince = incoming.lastSince;
    }

    return { checkpoint: applySeededFromArchiveFlag(next), stats };
  }

  function buildCheckpointFromArchive(archiveEntries, scanMeta) {
    const now = new Date().toISOString();
    const checkpoint = emptyCheckpoint();
    checkpoint.lastSuccessfulExportAt = now;
    checkpoint.lastExportMode = "archive-seed";
    checkpoint.archiveMeta = {
      exportRoot: (scanMeta && scanMeta.exportRoot) || null,
      fileCount: (archiveEntries || []).length,
      skippedNoUuid: (scanMeta && scanMeta.skippedNoUuid) || 0,
      lastScannedAt: (scanMeta && scanMeta.lastScannedAt) || now,
      source: "downloads"
    };

    for (const entry of archiveEntries || []) {
      if (!entry.uuid) continue;
      checkpoint.conversationIndex[entry.uuid] = {
        updatedAt: entry.updatedAt || new Date(entry.lastModified || Date.now()).toISOString(),
        exportedAt: now,
        source: "archive",
        title: entry.filename || undefined
      };
    }

    return applySeededFromArchiveFlag(checkpoint);
  }

  function buildCheckpointFromDiskEntries(diskEntries, meta) {
    const now = new Date().toISOString();
    const checkpoint = emptyCheckpoint();
    checkpoint.lastSuccessfulExportAt = now;
    checkpoint.lastExportMode = (meta && meta.mode) || "disk-seed";
    checkpoint.archiveMeta = {
      fileCount: (diskEntries || []).length,
      skippedNoUuid: (meta && meta.skippedNoUuid) || 0,
      lastScannedAt: (meta && meta.lastScannedAt) || now,
      source: (meta && meta.source) || "disk"
    };

    for (const entry of diskEntries || []) {
      if (!entry.uuid) continue;
      checkpoint.conversationIndex[entry.uuid] = {
        updatedAt: entry.updatedAt || now,
        exportedAt: now,
        source: (meta && meta.entrySource) || "disk",
        title: entry.filename || undefined
      };
    }

    return applySeededFromArchiveFlag(checkpoint);
  }

  async function importCheckpoint(data, options) {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    const validation = validateCheckpointImport(parsed);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    const existing = await loadCheckpoint();
    const priorCount = countIndex(existing);
    const { checkpoint, stats } = mergeCheckpoint(existing, parsed, options || { mode: "merge" });
    await saveCheckpoint(checkpoint);
    return {
      checkpoint,
      stats,
      priorCount,
      newCount: countIndex(checkpoint),
      invalidKeys: validation.invalidKeys || 0
    };
  }

  const api = {
    STORAGE_KEY,
    SEEDED_THRESHOLD,
    emptyCheckpoint,
    parseTimestamp,
    isValidUuid,
    countIndex,
    isCheckpointSeeded,
    applySeededFromArchiveFlag,
    slimCheckpointForFetch,
    loadCheckpoint,
    saveCheckpoint,
    resetCheckpoint,
    getCheckpointInfo,
    updateCheckpointAfterSuccess,
    shouldKeepExistingEntry,
    validateCheckpointImport,
    mergeCheckpoint,
    buildCheckpointFromArchive,
    buildCheckpointFromDiskEntries,
    importCheckpoint
  };

  root.Checkpoint = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : global);

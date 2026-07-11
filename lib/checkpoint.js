(function (root) {
  const STORAGE_KEY = "exportCheckpoint";

  function emptyCheckpoint() {
    return {
      version: 1,
      lastSuccessfulExportAt: null,
      lastExportMode: null,
      lastSince: null,
      conversationIndex: {}
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
      count: Object.keys(index).length
    };
  }

  function updateCheckpointAfterSuccess(checkpoint, exportedConversations, runMeta) {
    const now = new Date().toISOString();
    const next = checkpoint ? { ...checkpoint } : emptyCheckpoint();
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

    return next;
  }

  function buildCheckpointFromArchive(archiveEntries, scanMeta) {
    const now = new Date().toISOString();
    const checkpoint = emptyCheckpoint();
    checkpoint.lastSuccessfulExportAt = now;
    checkpoint.lastExportMode = "archive-seed";
    checkpoint.archiveMeta = {
      folderName: (scanMeta && scanMeta.name) || null,
      fileCount: (archiveEntries || []).length,
      skippedNoUuid: (scanMeta && scanMeta.skippedNoUuid) || 0,
      lastScannedAt: (scanMeta && scanMeta.lastScannedAt) || now
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

    return checkpoint;
  }

  const api = {
    STORAGE_KEY,
    emptyCheckpoint,
    loadCheckpoint,
    saveCheckpoint,
    resetCheckpoint,
    getCheckpointInfo,
    updateCheckpointAfterSuccess,
    buildCheckpointFromArchive
  };

  root.Checkpoint = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : global);

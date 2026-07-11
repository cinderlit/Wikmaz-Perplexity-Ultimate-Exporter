(function (root) {
  const META_STORAGE_KEY = "archiveScanMeta";

  const UUID_IN_FILENAME_RE =
    /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\.md$/i;

  const UUID_STRICT_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function sanitizeExportRoot(exportRoot) {
    if (typeof ExportSettings !== "undefined" && ExportSettings.sanitizeExportRoot) {
      return ExportSettings.sanitizeExportRoot(exportRoot);
    }
    if (!exportRoot || typeof exportRoot !== "string") return "perplexity-mining/Perplexity_Export";
    return exportRoot.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "perplexity-mining/Perplexity_Export";
  }

  function escapeRegexLiteral(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractUuidFromFilename(filename) {
    if (!filename || typeof filename !== "string") return null;
    const match = filename.match(UUID_IN_FILENAME_RE);
    return match ? match[1].toLowerCase() : null;
  }

  function isValidUuid(uuid) {
    return Boolean(uuid && UUID_STRICT_RE.test(uuid));
  }

  function normalizePath(filename) {
    return String(filename || "").replace(/\\/g, "/");
  }

  function basenameFromPath(filename) {
    const normalized = normalizePath(filename);
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function isFilenameUnderExportRoot(filename, exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const normalized = normalizePath(filename);
    const marker = "/" + safeRoot + "/";
    const idx = normalized.indexOf(marker);
    if (idx === -1) return false;

    const suffix = normalized.slice(idx + marker.length);
    if (!suffix || suffix.includes("..")) return false;

    const segments = suffix.split("/").filter(Boolean);
    for (const seg of segments) {
      if (seg === "." || seg === "..") return false;
    }
    return suffix.endsWith(".md");
  }

  function buildDownloadsFilenameRegex(exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const escaped = escapeRegexLiteral(safeRoot);
    return ".*" + escaped + "/.*\\.md$";
  }

  function indexDownloadItems(items, exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const entriesByUuid = new Map();
    const skippedNoUuid = [];
    let skippedWrongPath = 0;
    let skippedMissing = 0;

    for (const item of items || []) {
      if (!item || typeof item.filename !== "string") continue;
      if (item.exists === false) {
        skippedMissing += 1;
        continue;
      }
      if (!isFilenameUnderExportRoot(item.filename, safeRoot)) {
        skippedWrongPath += 1;
        continue;
      }

      const base = basenameFromPath(item.filename);
      if (!base.endsWith(".md")) continue;

      const uuid = extractUuidFromFilename(base);
      if (!isValidUuid(uuid)) {
        skippedNoUuid.push({ basename: base });
        continue;
      }

      const endTime = Number(item.endTime || item.startTime || 0);
      const existing = entriesByUuid.get(uuid);
      if (!existing || endTime >= existing.endTime) {
        entriesByUuid.set(uuid, {
          uuid,
          filename: base,
          endTime,
          updatedAt: new Date(endTime || Date.now()).toISOString()
        });
      }
    }

    return {
      entries: Array.from(entriesByUuid.values()),
      skippedNoUuid,
      skippedWrongPath,
      skippedMissing
    };
  }

  function loadArchiveMeta() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get(META_STORAGE_KEY, (data) => {
        resolve(data[META_STORAGE_KEY] || null);
      });
    });
  }

  function saveArchiveMeta(meta) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        resolve(meta);
        return;
      }
      chrome.storage.local.set({ [META_STORAGE_KEY]: meta }, () => resolve(meta));
    });
  }

  function searchDownloads(filenameRegex) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.downloads || !chrome.downloads.search) {
        reject(new Error("Downloads API is not available"));
        return;
      }
      chrome.downloads.search(
        {
          filenameRegex,
          orderBy: ["-endTime"],
          limit: 0
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(results || []);
        }
      );
    });
  }

  async function scanDownloadsArchive(exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const filenameRegex = buildDownloadsFilenameRegex(safeRoot);
    const items = await searchDownloads(filenameRegex);
    const indexed = indexDownloadItems(items, safeRoot);
    const meta = {
      exportRoot: safeRoot,
      fileCount: indexed.entries.length,
      skippedNoUuid: indexed.skippedNoUuid.length,
      skippedWrongPath: indexed.skippedWrongPath,
      skippedMissing: indexed.skippedMissing,
      lastScannedAt: new Date().toISOString()
    };
    await saveArchiveMeta(meta);
    return { ...indexed, meta };
  }

  async function getArchiveInfo() {
    const exportRoot =
      typeof ExportSettings !== "undefined" && ExportSettings.loadExportRoot
        ? await ExportSettings.loadExportRoot()
        : sanitizeExportRoot(null);
    const meta = await loadArchiveMeta();
    return {
      exportRoot,
      fileCount: meta ? meta.fileCount || 0 : 0,
      skippedNoUuid: meta ? meta.skippedNoUuid || 0 : 0,
      lastScannedAt: meta ? meta.lastScannedAt || null : null,
      synced: Boolean(meta && meta.lastScannedAt)
    };
  }

  const api = {
    META_STORAGE_KEY,
    UUID_IN_FILENAME_RE,
    sanitizeExportRoot,
    escapeRegexLiteral,
    extractUuidFromFilename,
    isValidUuid,
    isFilenameUnderExportRoot,
    buildDownloadsFilenameRegex,
    indexDownloadItems,
    scanDownloadsArchive,
    getArchiveInfo,
    loadArchiveMeta,
    saveArchiveMeta
  };

  root.ArchiveIndex = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : global);

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
    return String(filename || "").replace(/\\/g, "/").trim();
  }

  function normalizeDownloadRecordFilename(filename) {
    let normalized = normalizePath(filename);
    if (!normalized) return "";

    if (normalized.startsWith("file://")) {
      try {
        normalized = decodeURIComponent(new URL(normalized).pathname);
      } catch (e) {
        normalized = normalized.replace(/^file:\/+/, "/");
      }
    }

    if (/%[0-9A-Fa-f]{2}/.test(normalized)) {
      try {
        normalized = decodeURIComponent(normalized);
      } catch (e) {}
    }

    return normalized;
  }

  function isAbsoluteFilesystemPath(path) {
    return /^\/Users\//i.test(path) || /^\/home\//i.test(path) || /^\/var\//i.test(path);
  }

  function basenameFromPath(filename) {
    const normalized = normalizeDownloadRecordFilename(filename);
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : normalized;
  }

  function exportRootTail(exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const parts = safeRoot.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : safeRoot;
  }

  function toRelativeClassificationPath(filename, exportRoot) {
    const normalized = normalizeDownloadRecordFilename(filename);
    if (!normalized) return "";
    if (isFilenameUnderExportRoot(normalized, exportRoot)) return normalized;
    if (isAbsoluteFilesystemPath(normalized)) return normalized;
    return normalized.replace(/^\/+/, "");
  }

  function isFilenameUnderExportRoot(filename, exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const normalized = normalizeDownloadRecordFilename(filename).toLowerCase();
    const marker = "/" + safeRoot.toLowerCase() + "/";
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

  function isRelativeUnderExportFolder(filename, exportRoot) {
    const normalized = toRelativeClassificationPath(filename, exportRoot).toLowerCase();
    const safeRoot = sanitizeExportRoot(exportRoot).toLowerCase();
    if (normalized.includes("..")) return false;
    if (!normalized.endsWith(".md")) return false;

    if (normalized.startsWith(safeRoot + "/")) return true;

    const tail = exportRootTail(exportRoot).toLowerCase();
    if (tail && normalized.startsWith(tail + "/")) return true;

    return false;
  }

  function isWikmazUuidMarkdownBasename(base) {
    if (!base || typeof base !== "string" || !base.endsWith(".md")) return false;
    if (base.includes("..") || base.includes("/")) return false;
    return isValidUuid(extractUuidFromFilename(base));
  }

  function isNestedSpaceUuidMarkdownPath(filename, exportRoot) {
    const normalized = normalizeDownloadRecordFilename(filename);
    if (isAbsoluteFilesystemPath(normalized)) return false;

    const relative = normalized.replace(/^\/+/, "");
    if (!relative.includes("/")) return false;
    if (relative.includes("..")) return false;
    if (!relative.endsWith(".md")) return false;

    const base = basenameFromPath(relative);
    if (!isWikmazUuidMarkdownBasename(base)) return false;

    const segments = relative.split("/").filter(Boolean);
    return segments.length >= 2;
  }

  function isAbsolutePathOutsideExport(filename, exportRoot) {
    const normalized = normalizeDownloadRecordFilename(filename);
    if (!isAbsoluteFilesystemPath(normalized)) return false;
    return !isFilenameUnderExportRoot(normalized, exportRoot) && !isRelativeUnderExportFolder(normalized, exportRoot);
  }

  function classifyArchiveDownloadFilename(filename, exportRoot) {
    const normalized = normalizeDownloadRecordFilename(filename);
    const relative = toRelativeClassificationPath(filename, exportRoot);
    const base = basenameFromPath(relative || normalized);

    if (isFilenameUnderExportRoot(normalized, exportRoot)) {
      return { accepted: true, pathMatched: true };
    }

    if (isRelativeUnderExportFolder(relative || normalized, exportRoot) && isWikmazUuidMarkdownBasename(base)) {
      return { accepted: true, pathMatched: true };
    }

    if (isNestedSpaceUuidMarkdownPath(filename, exportRoot)) {
      return { accepted: true, pathMatched: false };
    }

    if (!relative.includes("/") && isWikmazUuidMarkdownBasename(relative || normalized)) {
      return { accepted: true, pathMatched: false };
    }

    return { accepted: false, pathMatched: false };
  }

  function resolveDownloadFilename(item) {
    if (!item) return "";

    const candidates = [item.filename, item.localFilename];
    for (const raw of candidates) {
      if (typeof raw === "string" && raw.trim()) {
        return normalizeDownloadRecordFilename(raw);
      }
    }

    const urlCandidates = [item.finalUrl, item.url];
    for (const rawUrl of urlCandidates) {
      if (typeof rawUrl !== "string" || !rawUrl.startsWith("file://")) continue;
      try {
        const path = decodeURIComponent(new URL(rawUrl).pathname);
        if (path) return normalizeDownloadRecordFilename(path);
      } catch (e) {}
    }

    return "";
  }

  function buildDownloadsFilenameRegex(exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const escaped = escapeRegexLiteral(safeRoot);
    return ".*" + escaped + "/.*\\.md$";
  }

  function buildUuidMarkdownRegex() {
    return (
      ".*\\(" +
      "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" +
      "\\)\\.md$"
    );
  }

  function dedupeDownloadItems(items) {
    const byKey = new Map();
    for (const item of items || []) {
      if (!item) continue;
      const key =
        item.id != null ? "id:" + item.id : String(item.filename || "") + "|" + String(item.endTime || "");
      byKey.set(key, item);
    }
    return Array.from(byKey.values());
  }

  function buildUuidRegexIdSet(items) {
    const ids = new Set();
    for (const item of items || []) {
      if (item && item.id != null) ids.add(item.id);
    }
    return ids;
  }

  function isBetterDownloadEntry(candidate, existing) {
    if (!existing) return true;
    if (candidate.pathMatched && !existing.pathMatched) return true;
    if (!candidate.pathMatched && existing.pathMatched) return false;
    if (candidate.fileExists && !existing.fileExists) return true;
    if (!candidate.fileExists && existing.fileExists) return false;
    return candidate.endTime >= existing.endTime;
  }

  function classifyDownloadItem(item, exportRoot, uuidRegexIds) {
    const filename = resolveDownloadFilename(item);
    if (!filename) {
      return { accepted: false, pathMatched: false, filename: "", reason: "no_filename" };
    }

    const classification = classifyArchiveDownloadFilename(filename, exportRoot);
    if (classification.accepted) {
      return { ...classification, filename, reason: null };
    }

    const base = basenameFromPath(filename);
    const fromUuidSearch = uuidRegexIds && item.id != null && uuidRegexIds.has(item.id);
    if (
      fromUuidSearch &&
      isWikmazUuidMarkdownBasename(base) &&
      !filename.includes("..") &&
      !isAbsolutePathOutsideExport(filename, exportRoot)
    ) {
      return { accepted: true, pathMatched: false, filename, reason: "uuid_regex_match" };
    }

    return { ...classification, filename, reason: "rejected_path" };
  }

  function indexDownloadItems(items, exportRoot, uuidRegexIds) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const entriesByUuid = new Map();
    const skippedNoUuid = [];
    let skippedWrongPath = 0;
    let skippedNoFilename = 0;
    let rawMatches = 0;
    const sampleRejected = [];

    for (const item of items || []) {
      const result = classifyDownloadItem(item, safeRoot, uuidRegexIds);
      if (!result.accepted) {
        if (result.reason === "no_filename") {
          skippedNoFilename += 1;
        } else {
          skippedWrongPath += 1;
          if (sampleRejected.length < 3 && result.filename) {
            sampleRejected.push(result.filename.slice(0, 160));
          }
        }
        continue;
      }

      rawMatches += 1;
      const base = basenameFromPath(result.filename);
      if (!base.endsWith(".md")) continue;

      const uuid = extractUuidFromFilename(base);
      if (!isValidUuid(uuid)) {
        skippedNoUuid.push({ basename: base });
        continue;
      }

      const endTime = Number(item.endTime || item.startTime || 0);
      const fileExists = item.exists !== false;
      const candidate = {
        uuid,
        filename: base,
        endTime,
        fileExists,
        pathMatched: result.pathMatched,
        updatedAt: new Date(endTime || Date.now()).toISOString()
      };
      const existing = entriesByUuid.get(uuid);
      if (isBetterDownloadEntry(candidate, existing)) {
        entriesByUuid.set(uuid, candidate);
      }
    }

    const entries = Array.from(entriesByUuid.values());
    const indexedFromDeleted = entries.filter((entry) => !entry.fileExists).length;
    const indexedFromBasename = entries.filter((entry) => !entry.pathMatched).length;

    return {
      entries,
      skippedNoUuid,
      skippedWrongPath,
      skippedNoFilename,
      rawMatches,
      indexedFromDeleted,
      indexedFromBasename,
      sampleRejected
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

  function searchDownloads(options) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.downloads || !chrome.downloads.search) {
        reject(new Error("Downloads API is not available"));
        return;
      }
      const query = {
        orderBy: ["-endTime"],
        limit: 0,
        ...(options || {})
      };
      chrome.downloads.search(query, (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(results || []);
        }
      });
    });
  }

  async function safeSearch(options) {
    try {
      return await searchDownloads(options);
    } catch (e) {
      return [];
    }
  }

  async function collectDownloadCandidates(exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const tail = exportRootTail(safeRoot);
    const [
      pathRegexItems,
      uuidRegexItems,
      rootTailItems,
      extensionItems,
      mdQueryItems,
      allItems
    ] = await Promise.all([
      safeSearch({ filenameRegex: buildDownloadsFilenameRegex(safeRoot) }),
      safeSearch({ filenameRegex: buildUuidMarkdownRegex() }),
      safeSearch({ query: [tail] }),
      safeSearch({ query: ["Perplexity Ultimate Export"] }),
      safeSearch({ query: [".md"] }),
      safeSearch({})
    ]);

    const merged = dedupeDownloadItems([
      ...pathRegexItems,
      ...uuidRegexItems,
      ...rootTailItems,
      ...extensionItems,
      ...mdQueryItems,
      ...allItems
    ]);

    return {
      items: merged,
      uuidRegexIds: buildUuidRegexIdSet(uuidRegexItems),
      sampleUuidRegexFilenames: uuidRegexItems
        .slice(0, 3)
        .map((item) => resolveDownloadFilename(item) || String(item.filename || "")),
      searchCounts: {
        pathRegex: pathRegexItems.length,
        uuidRegex: uuidRegexItems.length,
        rootTailQuery: rootTailItems.length,
        extensionQuery: extensionItems.length,
        mdQuery: mdQueryItems.length,
        allDownloads: allItems.length,
        merged: merged.length
      }
    };
  }

  async function scanDownloadsArchive(exportRoot) {
    const safeRoot = sanitizeExportRoot(exportRoot);
    const collected = await collectDownloadCandidates(safeRoot);
    const indexed = indexDownloadItems(collected.items, safeRoot, collected.uuidRegexIds);
    const meta = {
      exportRoot: safeRoot,
      fileCount: indexed.entries.length,
      skippedNoUuid: indexed.skippedNoUuid.length,
      skippedWrongPath: indexed.skippedWrongPath,
      skippedNoFilename: indexed.skippedNoFilename,
      downloadRecordsQueried: collected.items.length,
      rawMatches: indexed.rawMatches,
      indexedFromDeleted: indexed.indexedFromDeleted,
      indexedFromBasename: indexed.indexedFromBasename,
      searchCounts: collected.searchCounts,
      sampleUuidRegexFilenames: collected.sampleUuidRegexFilenames,
      sampleRejected: indexed.sampleRejected,
      lastScannedAt: new Date().toISOString()
    };
    await saveArchiveMeta(meta);
    return { ...indexed, downloadRecordsQueried: collected.items.length, meta };
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
      indexedFromDeleted: meta ? meta.indexedFromDeleted || 0 : 0,
      indexedFromBasename: meta ? meta.indexedFromBasename || 0 : 0,
      downloadRecordsQueried: meta ? meta.downloadRecordsQueried || 0 : 0,
      searchCounts: meta ? meta.searchCounts || null : null,
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
    normalizeDownloadRecordFilename,
    resolveDownloadFilename,
    isFilenameUnderExportRoot,
    isRelativeUnderExportFolder,
    isNestedSpaceUuidMarkdownPath,
    isWikmazUuidMarkdownBasename,
    classifyArchiveDownloadFilename,
    classifyDownloadItem,
    isBetterDownloadEntry,
    buildDownloadsFilenameRegex,
    buildUuidMarkdownRegex,
    dedupeDownloadItems,
    indexDownloadItems,
    collectDownloadCandidates,
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

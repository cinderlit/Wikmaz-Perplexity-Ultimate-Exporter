(function (root) {
  const STORAGE_KEY = "exportRoot";
  const OVERWRITE_KEY = "overwriteOnExport";
  const DEEP_SCAN_KEY = "deepScanIncremental";
  const DEFAULT_EXPORT_ROOT = "perplexity-mining/Perplexity_Export";

  function sanitizeExportRoot(input) {
    if (!input || typeof input !== "string") return DEFAULT_EXPORT_ROOT;
    let path = input.trim().replace(/\\/g, "/");
    path = path.replace(/^\/+/, "").replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);
    const safe = [];
    for (const seg of segments) {
      if (seg === "." || seg === "..") continue;
      const clean = seg.replace(/[^a-zA-Z0-9_ąćęłńóśźżĄĆĘŁŃÓŚŹŻ \-\.]/g, "_");
      if (clean) safe.push(clean);
    }
    return safe.length > 0 ? safe.join("/") : DEFAULT_EXPORT_ROOT;
  }

  function loadExportRoot() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        const stored = data[STORAGE_KEY];
        resolve(sanitizeExportRoot(stored || DEFAULT_EXPORT_ROOT));
      });
    });
  }

  function saveExportRoot(exportRoot) {
    const sanitized = sanitizeExportRoot(exportRoot);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: sanitized }, () => resolve(sanitized));
    });
  }

  function loadOverwriteOnExport() {
    return new Promise((resolve) => {
      chrome.storage.local.get(OVERWRITE_KEY, (data) => {
        resolve(Boolean(data[OVERWRITE_KEY]));
      });
    });
  }

  function saveOverwriteOnExport(enabled) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [OVERWRITE_KEY]: Boolean(enabled) }, () => resolve(Boolean(enabled)));
    });
  }

  function loadDeepScanIncremental() {
    return new Promise((resolve) => {
      chrome.storage.local.get(DEEP_SCAN_KEY, (data) => {
        resolve(Boolean(data[DEEP_SCAN_KEY]));
      });
    });
  }

  function saveDeepScanIncremental(enabled) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [DEEP_SCAN_KEY]: Boolean(enabled) }, () => resolve(Boolean(enabled)));
    });
  }

  const api = {
    STORAGE_KEY,
    OVERWRITE_KEY,
    DEEP_SCAN_KEY,
    DEFAULT_EXPORT_ROOT,
    sanitizeExportRoot,
    loadExportRoot,
    saveExportRoot,
    loadOverwriteOnExport,
    saveOverwriteOnExport,
    loadDeepScanIncremental,
    saveDeepScanIncremental
  };

  root.ExportSettings = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : global);

(function (root) {
  const STORAGE_KEY = "exportRoot";
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

  const api = {
    STORAGE_KEY,
    DEFAULT_EXPORT_ROOT,
    sanitizeExportRoot,
    loadExportRoot,
    saveExportRoot
  };

  root.ExportSettings = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : global);

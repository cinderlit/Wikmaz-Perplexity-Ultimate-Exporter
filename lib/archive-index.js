(function (root) {
  const DB_NAME = "wikmazArchiveDb";
  const DB_VERSION = 1;
  const HANDLE_STORE = "directoryHandle";
  const META_STORE = "archiveMeta";
  const HANDLE_KEY = "linked";

  const UUID_IN_FILENAME_RE =
    /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\.md$/i;

  function extractUuidFromFilename(filename) {
    if (!filename || typeof filename !== "string") return null;
    const match = filename.match(UUID_IN_FILENAME_RE);
    return match ? match[1].toLowerCase() : null;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
      };
    });
  }

  function idbGet(storeName, key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          const request = store.get(key);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        })
    );
  }

  function idbPut(storeName, key, value) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          const request = store.put(value, key);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve();
        })
    );
  }

  function idbDelete(storeName, key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          const request = store.delete(key);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve();
        })
    );
  }

  async function ensureDirectoryPermission(dirHandle, mode) {
    if (!dirHandle || typeof dirHandle.queryPermission !== "function") {
      throw new Error("Invalid directory handle");
    }
    const opts = { mode: mode || "read" };
    const current = await dirHandle.queryPermission(opts);
    if (current === "granted") return dirHandle;
    const requested = await dirHandle.requestPermission(opts);
    if (requested !== "granted") {
      throw new Error("Archive folder permission denied. Re-link the folder.");
    }
    return dirHandle;
  }

  async function scanDirectoryHandle(dirHandle, relativePath) {
    const entries = [];
    const skippedNoUuid = [];
    const basePath = relativePath || "";

    for await (const [name, handle] of dirHandle.entries()) {
      const path = basePath ? basePath + "/" + name : name;
      if (handle.kind === "directory") {
        const nested = await scanDirectoryHandle(handle, path);
        entries.push(...nested.entries);
        skippedNoUuid.push(...nested.skippedNoUuid);
        continue;
      }
      if (handle.kind !== "file" || !name.endsWith(".md")) continue;

      const uuid = extractUuidFromFilename(name);
      if (!uuid) {
        skippedNoUuid.push({ filename: name, path });
        continue;
      }

      const file = await handle.getFile();
      entries.push({
        uuid,
        filename: name,
        path,
        lastModified: file.lastModified,
        updatedAt: new Date(file.lastModified).toISOString()
      });
    }

    return { entries, skippedNoUuid };
  }

  async function saveDirectoryHandle(dirHandle, meta) {
    await idbPut(HANDLE_STORE, HANDLE_KEY, dirHandle);
    const archiveMeta = {
      name: dirHandle.name,
      linkedAt: new Date().toISOString(),
      ...(meta || {})
    };
    await idbPut(META_STORE, HANDLE_KEY, archiveMeta);
    return archiveMeta;
  }

  async function loadDirectoryHandle() {
    return idbGet(HANDLE_STORE, HANDLE_KEY);
  }

  async function loadArchiveMeta() {
    const meta = await idbGet(META_STORE, HANDLE_KEY);
    return meta || null;
  }

  async function getArchiveInfo() {
    const meta = await loadArchiveMeta();
    if (!meta) {
      return { linked: false, name: null, fileCount: 0, skippedNoUuid: 0, lastScannedAt: null };
    }
    return {
      linked: true,
      name: meta.name,
      fileCount: meta.fileCount || 0,
      skippedNoUuid: meta.skippedNoUuid || 0,
      lastScannedAt: meta.lastScannedAt || meta.linkedAt || null
    };
  }

  async function clearArchiveLink() {
    await idbDelete(HANDLE_STORE, HANDLE_KEY);
    await idbDelete(META_STORE, HANDLE_KEY);
  }

  async function scanLinkedArchive() {
    const dirHandle = await loadDirectoryHandle();
    if (!dirHandle) {
      throw new Error("No archive folder linked. Use Link archive folder first.");
    }
    await ensureDirectoryPermission(dirHandle, "read");
    const result = await scanDirectoryHandle(dirHandle);
    const meta = await loadArchiveMeta();
    const updatedMeta = {
      ...(meta || { name: dirHandle.name, linkedAt: new Date().toISOString() }),
      name: dirHandle.name,
      fileCount: result.entries.length,
      skippedNoUuid: result.skippedNoUuid.length,
      lastScannedAt: new Date().toISOString()
    };
    await idbPut(META_STORE, HANDLE_KEY, updatedMeta);
    return { ...result, meta: updatedMeta };
  }

  const api = {
    UUID_IN_FILENAME_RE,
    extractUuidFromFilename,
    scanDirectoryHandle,
    ensureDirectoryPermission,
    saveDirectoryHandle,
    loadDirectoryHandle,
    loadArchiveMeta,
    getArchiveInfo,
    clearArchiveLink,
    scanLinkedArchive
  };

  root.ArchiveIndex = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : global);

const pickBtn = document.getElementById("pickBtn");
const folderInput = document.getElementById("folderInput");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

function basename(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || "");
}

function indexFilesFromList(fileList) {
  const byUuid = new Map();
  let skippedNoUuid = 0;
  let scanned = 0;

  for (const file of fileList || []) {
    if (!file || !file.name) continue;
    const name = basename(file.name);
    if (!name.endsWith(".md")) continue;
    scanned += 1;
    const uuid = ArchiveIndex.extractUuidFromFilename(name);
    if (!ArchiveIndex.isValidUuid(uuid)) {
      skippedNoUuid += 1;
      continue;
    }
    const updatedAt = new Date(file.lastModified || Date.now()).toISOString();
    const existing = byUuid.get(uuid);
    if (!existing || Date.parse(updatedAt) > Date.parse(existing.updatedAt)) {
      byUuid.set(uuid, { uuid, filename: name, updatedAt });
    }
  }

  return {
    entries: Array.from(byUuid.values()),
    skippedNoUuid,
    scanned
  };
}

async function pickWithDirectoryPicker() {
  if (typeof window.showDirectoryPicker !== "function") {
    return null;
  }
  const dir = await window.showDirectoryPicker();
  const files = [];
  async function walk(handle, prefix) {
    for await (const [name, child] of handle.entries()) {
      const path = prefix ? prefix + "/" + name : name;
      if (child.kind === "directory") {
        await walk(child, path);
      } else if (child.kind === "file" && name.endsWith(".md")) {
        const file = await child.getFile();
        Object.defineProperty(file, "name", { value: path, configurable: true });
        files.push(file);
      }
    }
  }
  await walk(dir, "");
  return files;
}

async function mergeEntries(result) {
  setStatus(
    "Indexed " +
      result.entries.length +
      " UUID(s) from " +
      result.scanned +
      " .md file(s)" +
      (result.skippedNoUuid ? " · " + result.skippedNoUuid + " without UUID skipped" : "") +
      "\nMerging into checkpoint..."
  );

  const response = await chrome.runtime.sendMessage({
    action: "merge_checkpoint_from_disk",
    entries: result.entries,
    meta: {
      mode: "disk-seed",
      source: "disk-tab",
      skippedNoUuid: result.skippedNoUuid,
      lastScannedAt: new Date().toISOString(),
      entrySource: "disk"
    }
  });

  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  if (response && response.error) {
    throw new Error(response.error);
  }

  setStatus(
    "Done. Checkpoint " +
      (response.priorCount != null ? response.priorCount + " → " : "") +
      (response.newCount != null ? response.newCount : "?") +
      " threads."
  );
}

async function handleFileList(fileList) {
  pickBtn.disabled = true;
  try {
    setStatus("Scanning " + fileList.length + " file(s)...");
    const result = indexFilesFromList(fileList);
    if (result.entries.length === 0) {
      setStatus("No Wikmaz (uuid).md files found in the selected folder.");
      return;
    }
    await mergeEntries(result);
  } catch (err) {
    setStatus("Error: " + (err && err.message ? err.message : String(err)));
  } finally {
    pickBtn.disabled = false;
  }
}

pickBtn.addEventListener("click", async () => {
  try {
    const pickerFiles = await pickWithDirectoryPicker();
    if (pickerFiles) {
      await handleFileList(pickerFiles);
      return;
    }
    folderInput.value = "";
    folderInput.click();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    setStatus("Picker failed: " + (err.message || err) + "\nTrying folder input fallback...");
    folderInput.value = "";
    folderInput.click();
  }
});

folderInput.addEventListener("change", () => {
  if (!folderInput.files || folderInput.files.length === 0) return;
  handleFileList(folderInput.files);
});

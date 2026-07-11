const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  buildCheckpointFromDisk,
  extractUuidFromFilename
} = require("../scripts/build-checkpoint-from-disk.js");

describe("build-checkpoint-from-disk script", () => {
  it("extracts UUID from Wikmaz filename", () => {
    assert.equal(
      extractUuidFromFilename("thread_title (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).md"),
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
  });

  it("indexes md files in a temp folder", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wikmaz-cp-"));
    const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const file = path.join(tmp, "General", "thread (" + uuid + ").md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# test\n");
    const cp = buildCheckpointFromDisk(tmp);
    assert.equal(cp.conversationIndex[uuid].source, "disk");
    assert.equal(cp.archiveMeta.fileCount, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

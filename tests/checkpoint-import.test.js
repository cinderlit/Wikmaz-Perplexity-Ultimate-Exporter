const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Checkpoint = require("../lib/checkpoint.js");

describe("validateCheckpointImport", () => {
  it("accepts valid checkpoint JSON", () => {
    const result = Checkpoint.validateCheckpointImport({
      version: 1,
      conversationIndex: {
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": { updatedAt: "2026-01-01T00:00:00.000Z" }
      }
    });
    assert.equal(result.valid, true);
  });

  it("rejects missing conversationIndex", () => {
    const result = Checkpoint.validateCheckpointImport({ version: 1 });
    assert.equal(result.valid, false);
  });
});

describe("mergeCheckpoint", () => {
  it("adds missing UUIDs from incoming", () => {
    const existing = Checkpoint.emptyCheckpoint();
    existing.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "export"
    };
    const incoming = {
      version: 1,
      conversationIndex: {
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": {
          updatedAt: "2026-02-01T00:00:00.000Z",
          source: "disk"
        }
      }
    };
    const { checkpoint, stats } = Checkpoint.mergeCheckpoint(existing, incoming);
    assert.equal(stats.added, 1);
    assert.equal(Object.keys(checkpoint.conversationIndex).length, 2);
  });

  it("prefers export source on timestamp tie", () => {
    const existing = Checkpoint.emptyCheckpoint();
    existing.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "export",
      title: "from-export"
    };
    const incoming = {
      version: 1,
      conversationIndex: {
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": {
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "disk",
          title: "from-disk"
        }
      }
    };
    const { checkpoint, stats } = Checkpoint.mergeCheckpoint(existing, incoming);
    assert.equal(stats.kept, 1);
    assert.equal(checkpoint.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].title, "from-export");
  });

  it("updates when incoming has newer updatedAt", () => {
    const existing = Checkpoint.emptyCheckpoint();
    existing.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "export"
    };
    const incoming = {
      version: 1,
      conversationIndex: {
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": {
          updatedAt: "2026-06-01T00:00:00.000Z",
          source: "disk"
        }
      }
    };
    const { checkpoint, stats } = Checkpoint.mergeCheckpoint(existing, incoming);
    assert.equal(stats.updated, 1);
    assert.equal(checkpoint.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].source, "disk");
  });
});

describe("isCheckpointSeeded", () => {
  it("marks seeded when count crosses threshold", () => {
    const cp = Checkpoint.emptyCheckpoint();
    assert.equal(Checkpoint.isCheckpointSeeded(cp), false);
    cp.seededFromArchive = true;
    assert.equal(Checkpoint.isCheckpointSeeded(cp), true);
  });

  it("applySeededFromArchiveFlag sets flag for large index", () => {
    const cp = Checkpoint.emptyCheckpoint();
    for (let i = 0; i < Checkpoint.SEEDED_THRESHOLD; i += 1) {
      const hex = i.toString(16).padStart(12, "0");
      cp.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-" + hex] = {
        updatedAt: "2026-01-01T00:00:00.000Z",
        source: "disk"
      };
    }
    Checkpoint.applySeededFromArchiveFlag(cp);
    assert.equal(cp.seededFromArchive, true);
  });
});

describe("buildCheckpointFromDiskEntries", () => {
  it("builds index from disk entries", () => {
    const cp = Checkpoint.buildCheckpointFromDiskEntries(
      [{ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", filename: "t (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).md", updatedAt: "2026-03-01T00:00:00.000Z" }],
      { source: "disk-script" }
    );
    assert.equal(cp.lastExportMode, "disk-seed");
    assert.equal(cp.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].source, "disk");
  });
});

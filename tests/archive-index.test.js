const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ArchiveIndex = require("../lib/archive-index.js");
const Checkpoint = require("../lib/checkpoint.js");
const ExportUtils = require("../lib/export-utils.js");

describe("extractUuidFromFilename", () => {
  it("extracts UUID from Wikmaz filename", () => {
    const name =
      "How_large_of_a_solar_panel (df2fd3f7-70e8-4602-b054-58ea53077048).md";
    assert.equal(
      ArchiveIndex.extractUuidFromFilename(name),
      "df2fd3f7-70e8-4602-b054-58ea53077048"
    );
  });

  it("returns null when filename has no UUID", () => {
    assert.equal(
      ArchiveIndex.extractUuidFromFilename("I will not apologize for the cardinal sin of _chec.md"),
      null
    );
  });
});

describe("buildCheckpointFromArchive", () => {
  it("indexes only archive entries with source archive", () => {
    const entries = [
      {
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        filename: "one.md",
        updatedAt: "2026-07-01T10:00:00.000Z"
      },
      {
        uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        filename: "two.md",
        updatedAt: "2026-07-03T10:00:00.000Z"
      }
    ];
    const cp = Checkpoint.buildCheckpointFromArchive(entries, {
      name: "Perplexity_Export",
      fileCount: 2,
      skippedNoUuid: 1
    });
    assert.equal(cp.lastExportMode, "archive-seed");
    assert.equal(Object.keys(cp.conversationIndex).length, 2);
    assert.equal(cp.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].source, "archive");
    assert.equal(cp.archiveMeta.fileCount, 2);
    assert.equal(cp.archiveMeta.skippedNoUuid, 1);
  });
});

describe("incremental with archive checkpoint", () => {
  const archiveEntries = [
    { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", updatedAt: "2026-07-01T10:00:00.000Z" }
  ];
  const checkpoint = Checkpoint.buildCheckpointFromArchive(archiveEntries, { fileCount: 1 });

  const apiChats = [
    { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", updatedAt: "2026-07-01T10:00:00.000Z", title: "A" },
    { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", updatedAt: "2026-07-10T10:00:00.000Z", title: "B" }
  ];

  it("exports only threads missing from archive or changed", () => {
    const { toExport, skipped } = ExportUtils.filterIncrementalCandidates(apiChats, checkpoint);
    assert.deepEqual(toExport.map((c) => c.uuid), ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]);
    assert.equal(skipped, 1);
  });

  it("exports changed thread when updatedAt is newer", () => {
    const changedApi = [
      { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", updatedAt: "2026-07-10T12:00:00.000Z", title: "A" }
    ];
    const { toExport } = ExportUtils.filterIncrementalCandidates(changedApi, checkpoint);
    assert.deepEqual(toExport.map((c) => c.uuid), ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]);
  });
});

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
require("../lib/settings.js");
const ArchiveIndex = require("../lib/archive-index.js");
const Checkpoint = require("../lib/checkpoint.js");
const ExportUtils = require("../lib/export-utils.js");

const EXPORT_ROOT = "perplexity-mining/Perplexity_Export";

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

describe("buildDownloadsFilenameRegex", () => {
  it("escapes regex metacharacters in export root", () => {
    const regex = ArchiveIndex.buildDownloadsFilenameRegex("foo.bar/test");
    assert.equal(regex, ".*foo\\.bar/test/.*\\.md$");
  });
});

describe("isFilenameUnderExportRoot", () => {
  it("accepts files under the configured export root", () => {
    const path =
      "/Users/me/Downloads/perplexity-mining/Perplexity_Export/space/thread (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).md";
    assert.equal(ArchiveIndex.isFilenameUnderExportRoot(path, EXPORT_ROOT), true);
  });

  it("rejects path traversal and lookalike prefixes", () => {
    const traversal =
      "/Users/me/Downloads/perplexity-mining/Perplexity_Export/../secret (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).md";
    const lookalike =
      "/Users/me/Downloads/evil-perplexity-mining/Perplexity_Export/thread (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).md";
    assert.equal(ArchiveIndex.isFilenameUnderExportRoot(traversal, EXPORT_ROOT), false);
    assert.equal(ArchiveIndex.isFilenameUnderExportRoot(lookalike, EXPORT_ROOT), false);
  });
});

describe("indexDownloadItems", () => {
  it("indexes latest download per UUID and skips missing files", () => {
    const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const base = "/Users/me/Downloads/" + EXPORT_ROOT + "/space/thread (" + uuid + ").md";
    const items = [
      { filename: base, exists: true, endTime: 1000 },
      { filename: base, exists: true, endTime: 2000 },
      { filename: base, exists: false, endTime: 3000 }
    ];
    const result = ArchiveIndex.indexDownloadItems(items, EXPORT_ROOT);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].uuid, uuid);
    assert.equal(result.entries[0].endTime, 2000);
    assert.equal(result.skippedMissing, 1);
  });

  it("rejects invalid UUIDs and files outside export root", () => {
    const badUuid =
      "/Users/me/Downloads/" + EXPORT_ROOT + "/space/thread (not-a-uuid).md";
    const outside = "/Users/me/Downloads/other/thread (bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb).md";
    const result = ArchiveIndex.indexDownloadItems(
      [
        { filename: badUuid, exists: true, endTime: 1000 },
        { filename: outside, exists: true, endTime: 1000 }
      ],
      EXPORT_ROOT
    );
    assert.equal(result.entries.length, 0);
    assert.equal(result.skippedNoUuid.length, 1);
    assert.equal(result.skippedWrongPath, 1);
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
      exportRoot: EXPORT_ROOT,
      fileCount: 2,
      skippedNoUuid: 1
    });
    assert.equal(cp.lastExportMode, "archive-seed");
    assert.equal(Object.keys(cp.conversationIndex).length, 2);
    assert.equal(cp.conversationIndex["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].source, "archive");
    assert.equal(cp.archiveMeta.fileCount, 2);
    assert.equal(cp.archiveMeta.exportRoot, EXPORT_ROOT);
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

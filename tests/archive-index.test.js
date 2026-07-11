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

describe("buildUuidMarkdownRegex", () => {
  it("matches Wikmaz uuid markdown filenames", () => {
    const regex = new RegExp(ArchiveIndex.buildUuidMarkdownRegex(), "i");
    assert.match(
      "unpacking_vs_a_little_to_the_left_reddit (a1f1cbad-fd2b-4cef-9ed9-07e9007f9d64).md",
      regex
    );
    assert.match(
      "thread (AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA).md",
      regex
    );
  });
});

describe("classifyArchiveDownloadFilename", () => {
  it("accepts full paths under export root", () => {
    const path =
      "/Users/me/Downloads/perplexity-mining/Perplexity_Export/space/thread (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(path, EXPORT_ROOT), {
      accepted: true,
      pathMatched: true
    });
  });

  it("accepts relative Perplexity_Export paths", () => {
    const relative =
      "Perplexity_Export/General/thread (bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb).md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(relative, EXPORT_ROOT), {
      accepted: true,
      pathMatched: true
    });
  });

  it("accepts basename-only deleted download records", () => {
    const base =
      "unpacking_vs_a_little_to_the_left_reddit (a1f1cbad-fd2b-4cef-9ed9-07e9007f9d64).md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(base, EXPORT_ROOT), {
      accepted: true,
      pathMatched: false
    });
  });

  it("rejects basename-only files without uuid", () => {
    assert.deepEqual(
      ArchiveIndex.classifyArchiveDownloadFilename("What would my memoirs be called.md", EXPORT_ROOT),
      { accepted: false, pathMatched: false }
    );
  });

  it("accepts space-relative paths from Brave deleted download records", () => {
    const spaceRelative =
      "General/unpacking_vs_a_little_to_the_left_reddit (a1f1cbad-fd2b-4cef-9ed9-07e9007f9d64).md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(spaceRelative, EXPORT_ROOT), {
      accepted: true,
      pathMatched: false
    });
    const leadingSlash =
      "/General/thread (cccccccc-cccc-cccc-cccc-cccccccccccc).md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(leadingSlash, EXPORT_ROOT), {
      accepted: true,
      pathMatched: false
    });
    const nestedSpace =
      "AI Tools/thread (cccccccc-cccc-cccc-cccc-cccccccccccc).md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(nestedSpace, EXPORT_ROOT), {
      accepted: true,
      pathMatched: false
    });
  });

  it("rejects absolute paths outside export root", () => {
    const outside =
      "/Users/me/Downloads/other/General/thread (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(outside, EXPORT_ROOT), {
      accepted: false,
      pathMatched: false
    });
  });

  it("rejects nested paths without uuid", () => {
    const partial = "General/What would my memoirs be called.md";
    assert.deepEqual(ArchiveIndex.classifyArchiveDownloadFilename(partial, EXPORT_ROOT), {
      accepted: false,
      pathMatched: false
    });
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
  it("indexes deleted download entries and prefers existing files when deduping", () => {
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
    assert.equal(result.entries[0].fileExists, true);
    assert.equal(result.entries[0].pathMatched, true);
    assert.equal(result.indexedFromDeleted, 0);
  });

  it("indexes basename-only deleted download history for checkpoint seeding", () => {
    const uuid = "a1f1cbad-fd2b-4cef-9ed9-07e9007f9d64";
    const base = "unpacking_vs_a_little_to_the_left_reddit (" + uuid + ").md";
    const result = ArchiveIndex.indexDownloadItems(
      [{ filename: base, exists: false, endTime: 4000 }],
      EXPORT_ROOT
    );
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].uuid, uuid);
    assert.equal(result.entries[0].fileExists, false);
    assert.equal(result.entries[0].pathMatched, false);
    assert.equal(result.indexedFromBasename, 1);
    assert.equal(result.indexedFromDeleted, 1);
  });

  it("prefers path-matched records over basename-only for the same uuid", () => {
    const uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const full =
      "/Users/me/Downloads/" + EXPORT_ROOT + "/General/thread (" + uuid + ").md";
    const base = "thread (" + uuid + ").md";
    const result = ArchiveIndex.indexDownloadItems(
      [
        { filename: base, exists: false, endTime: 5000 },
        { filename: full, exists: false, endTime: 1000 }
      ],
      EXPORT_ROOT
    );
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].pathMatched, true);
    assert.equal(result.entries[0].endTime, 1000);
  });

  it("indexes space-relative download history paths", () => {
    const uuid = "a1f1cbad-fd2b-4cef-9ed9-07e9007f9d64";
    const path = "General/unpacking_vs_a_little_to_the_left_reddit (" + uuid + ").md";
    const result = ArchiveIndex.indexDownloadItems(
      [{ id: 1, filename: path, exists: false, endTime: 4000 }],
      EXPORT_ROOT,
      new Set()
    );
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].uuid, uuid);
    assert.equal(result.indexedFromBasename, 1);
  });

  it("accepts uuid-regex matches even when path classification fails", () => {
    const uuid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const weird = "/General/thread (" + uuid + ").md";
    const result = ArchiveIndex.indexDownloadItems(
      [{ id: 99, filename: weird, exists: false, endTime: 1000 }],
      EXPORT_ROOT,
      new Set([99])
    );
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].uuid, uuid);
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
      EXPORT_ROOT,
      new Set()
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

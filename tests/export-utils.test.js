const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ExportUtils = require("../lib/export-utils.js");
const Checkpoint = require("../lib/checkpoint.js");

describe("extractConversationIdFromUrl", () => {
  it("extracts UUID from slug URL", () => {
    const url = "https://www.perplexity.ai/search/my-query-e9d4579c-e60c-4b59-9c58-50b1dc7ef4fd";
    assert.equal(
      ExportUtils.extractConversationIdFromUrl(url),
      "e9d4579c-e60c-4b59-9c58-50b1dc7ef4fd"
    );
  });

  it("returns full slug when no UUID present", () => {
    const url = "https://www.perplexity.ai/search/some-short-slug-id";
    assert.equal(ExportUtils.extractConversationIdFromUrl(url), "some-short-slug-id");
  });

  it("returns null for non-conversation URLs", () => {
    assert.equal(ExportUtils.extractConversationIdFromUrl("https://www.perplexity.ai/"), null);
    assert.equal(ExportUtils.extractConversationIdFromUrl("https://google.com/search/foo"), null);
  });

  it("returns null for invalid slug segments", () => {
    const url = "https://www.perplexity.ai/search/../../etc/passwd";
    assert.equal(ExportUtils.extractConversationIdFromUrl(url), null);
  });
});

describe("isValidConversationId", () => {
  it("accepts UUIDs and safe slugs", () => {
    assert.equal(
      ExportUtils.isValidConversationId("e9d4579c-e60c-4b59-9c58-50b1dc7ef4fd"),
      true
    );
    assert.equal(ExportUtils.isValidConversationId("some-short-slug-id"), true);
  });

  it("rejects path traversal and unsafe characters", () => {
    assert.equal(ExportUtils.isValidConversationId("../../etc/passwd"), false);
    assert.equal(ExportUtils.isValidConversationId("foo/bar"), false);
    assert.equal(ExportUtils.isValidConversationId("id?query=1"), false);
  });
});

describe("buildFilename", () => {
  it("sanitizes malicious uuid in filename", () => {
    const filename = ExportUtils.buildFilename({
      title: "Test",
      space: "General",
      uuid: "../../../etc/passwd"
    });
    assert.match(filename, / \(unknown\)\.md$/);
    assert.doesNotMatch(filename, /\.\./);
  });

  it("uses custom export root prefix", () => {
    const filename = ExportUtils.buildFilename(
      { title: "Test", space: "Org-estra", uuid: "e9d4579c-e60c-4b59-9c58-50b1dc7ef4fd" },
      "perplexity-mining/Perplexity_Export"
    );
    assert.match(filename, /^perplexity-mining\/Perplexity_Export\/Org-estra\//);
  });
});

describe("buildManifestFilename", () => {
  it("uses custom export root prefix", () => {
    const filename = ExportUtils.buildManifestFilename(
      "2026-07-10T12:00:00.000Z",
      "perplexity-mining/Perplexity_Export"
    );
    assert.equal(
      filename,
      "perplexity-mining/Perplexity_Export/manifest-2026-07-10T12-00-00-000Z.json"
    );
  });
});

describe("dedupeIds", () => {
  it("preserves order and removes duplicates", () => {
    assert.deepEqual(
      ExportUtils.dedupeIds(["a", "b", "a", "c", "b", ""]),
      ["a", "b", "c"]
    );
  });
});

describe("filterIncrementalCandidates", () => {
  const chats = [
    { uuid: "aaa", title: "A", updatedAt: "2026-07-01T10:00:00.000Z" },
    { uuid: "bbb", title: "B", updatedAt: "2026-07-03T10:00:00.000Z" },
    { uuid: "ccc", title: "C", updatedAt: "2026-06-01T10:00:00.000Z" }
  ];

  const checkpoint = {
    version: 1,
    conversationIndex: {
      aaa: { updatedAt: "2026-07-01T10:00:00.000Z" },
      bbb: { updatedAt: "2026-07-02T10:00:00.000Z" },
      ccc: { updatedAt: "2026-06-01T10:00:00.000Z" }
    }
  };

  it("exports new and changed conversations only", () => {
    const { toExport, skipped } = ExportUtils.filterIncrementalCandidates(chats, checkpoint);
    assert.deepEqual(toExport.map((c) => c.uuid), ["bbb"]);
    assert.equal(skipped, 2);
  });

  it("exports all when checkpoint empty", () => {
    const { toExport, skipped } = ExportUtils.filterIncrementalCandidates(chats, null);
    assert.equal(toExport.length, 3);
    assert.equal(skipped, 0);
  });

  it("respects sinceDate filter", () => {
    const { toExport, skipped } = ExportUtils.filterIncrementalCandidates(
      chats,
      null,
      "2026-07-02T00:00:00.000Z"
    );
    assert.deepEqual(toExport.map((c) => c.uuid), ["bbb"]);
    assert.equal(skipped, 2);
  });

  it("skips all unchanged on second incremental pass", () => {
    const freshCheckpoint = Checkpoint.seedCheckpointFromList(chats);
    const { toExport, skipped } = ExportUtils.filterIncrementalCandidates(chats, freshCheckpoint);
    assert.equal(toExport.length, 0);
    assert.equal(skipped, 3);
  });
});

describe("shouldUpdateCheckpoint", () => {
  it("returns false when failures present", () => {
    assert.equal(
      ExportUtils.shouldUpdateCheckpoint({ failed: 1, stoppedByUser: false }),
      false
    );
  });

  it("returns false when stopped by user", () => {
    assert.equal(
      ExportUtils.shouldUpdateCheckpoint({ failed: 0, stoppedByUser: true }),
      false
    );
  });

  it("returns true on clean successful run", () => {
    assert.equal(
      ExportUtils.shouldUpdateCheckpoint({ failed: 0, stoppedByUser: false }),
      true
    );
  });
});

describe("findChatsByIds", () => {
  const allChats = [
    { uuid: "uuid-1", slug: "slug-one", title: "One" },
    { uuid: "uuid-2", slug: "slug-two", title: "Two" }
  ];

  it("resolves by uuid and slug with dedupe", () => {
    const { resolved, missing, invalid } = ExportUtils.findChatsByIds(allChats, [
      "uuid-1",
      "slug-two",
      "uuid-1",
      "missing"
    ]);
    assert.equal(resolved.length, 2);
    assert.deepEqual(missing, ["missing"]);
    assert.deepEqual(invalid, []);
  });

  it("rejects invalid IDs", () => {
    const { resolved, missing, invalid } = ExportUtils.findChatsByIds(allChats, [
      "uuid-1",
      "../../etc/passwd"
    ]);
    assert.equal(resolved.length, 1);
    assert.deepEqual(missing, []);
    assert.deepEqual(invalid, ["../../etc/passwd"]);
  });
});

describe("buildRunManifest", () => {
  it("includes required fields", () => {
    const manifest = ExportUtils.buildRunManifest({
      runType: "incremental",
      attempted: 5,
      succeeded: 5,
      failed: 0,
      skipped: 100,
      exportedIds: ["a"],
      filters: { sinceDate: null }
    });
    assert.equal(manifest.runType, "incremental");
    assert.equal(manifest.skipped, 100);
    assert.equal(manifest.outputFormat, "markdown");
  });
});

describe("checkpoint updateAfterSuccess", () => {
  it("merges exported conversations into index", () => {
    const cp = Checkpoint.emptyCheckpoint();
    const updated = Checkpoint.updateCheckpointAfterSuccess(
      cp,
      [{ uuid: "x", title: "T", updatedAt: "2026-07-03T12:00:00.000Z" }],
      { mode: "single" }
    );
    assert.ok(updated.lastSuccessfulExportAt);
    assert.equal(updated.conversationIndex.x.updatedAt, "2026-07-03T12:00:00.000Z");
    assert.equal(updated.lastExportMode, "single");
  });
});

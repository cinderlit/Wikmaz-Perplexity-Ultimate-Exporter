const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ExportUtils = require("../lib/export-utils.js");

const checkpoint = {
  conversationIndex: {
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": { updatedAt: "2026-06-01T00:00:00.000Z" }
  }
};

describe("isPageFullySynced", () => {
  it("returns false when a thread needs export", () => {
    const page = [
      {
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ];
    assert.equal(ExportUtils.isPageFullySynced(page, checkpoint), false);
  });

  it("returns true when all threads are synced", () => {
    const page = [
      {
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        updatedAt: "2026-05-01T00:00:00.000Z"
      },
      {
        uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        updatedAt: "2026-04-01T00:00:00.000Z"
      }
    ];
    const fullCheckpoint = {
      conversationIndex: {
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": { updatedAt: "2026-06-01T00:00:00.000Z" },
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": { updatedAt: "2026-06-01T00:00:00.000Z" }
      }
    };
    assert.equal(ExportUtils.isPageFullySynced(page, fullCheckpoint), true);
  });
});

describe("isPageOlderThanSince", () => {
  it("returns true when every thread is before since date", () => {
    const page = [
      { uuid: "a", updatedAt: "2026-06-01T00:00:00.000Z" },
      { uuid: "b", updatedAt: "2026-06-02T00:00:00.000Z" }
    ];
    assert.equal(ExportUtils.isPageOlderThanSince(page, "2026-07-01T00:00:00.000Z"), true);
  });

  it("returns false when any thread is on or after since date", () => {
    const page = [
      { uuid: "a", updatedAt: "2026-06-01T00:00:00.000Z" },
      { uuid: "b", updatedAt: "2026-07-02T00:00:00.000Z" }
    ];
    assert.equal(ExportUtils.isPageOlderThanSince(page, "2026-07-01T00:00:00.000Z"), false);
  });
});

describe("incremental pagination simulation", () => {
  function simulateEarlyStop(pages, checkpoint, sinceDate) {
    const allChats = [];
    let earlyStopped = false;
    for (const page of pages) {
      allChats.push(...page);
      if (sinceDate) {
        if (ExportUtils.isPageOlderThanSince(page, sinceDate)) {
          earlyStopped = true;
          break;
        }
      } else if (checkpoint && ExportUtils.isPageFullySynced(page, checkpoint)) {
        earlyStopped = true;
        break;
      }
    }
    return { allChats, earlyStopped };
  }

  it("stops after first synced page for incremental", () => {
    const pages = [
      [
        { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", updatedAt: "2026-05-01T00:00:00.000Z" }
      ],
      [
        { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", updatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    ];
    const fullCheckpoint = {
      conversationIndex: {
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": { updatedAt: "2026-06-01T00:00:00.000Z" },
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": { updatedAt: "2026-06-01T00:00:00.000Z" }
      }
    };
    const result = simulateEarlyStop(pages, fullCheckpoint, null);
    assert.equal(result.earlyStopped, true);
    assert.equal(result.allChats.length, 1);
  });

  it("stops when page is older than since date", () => {
    const pages = [
      [{ uuid: "a", updatedAt: "2026-07-05T00:00:00.000Z" }],
      [{ uuid: "b", updatedAt: "2026-06-01T00:00:00.000Z" }]
    ];
    const result = simulateEarlyStop(pages, null, "2026-07-01T00:00:00.000Z");
    assert.equal(result.earlyStopped, true);
    assert.equal(result.allChats.length, 2);
  });
});

# Dev Build — Manual Test Guide

Load unpacked from this folder: `extension-dev/`

Chrome: `chrome://extensions` → Developer mode → Load unpacked → select this directory.

## Prerequisites

- Logged into Perplexity in the browser
- An active Perplexity tab open when starting export (not required for archive link/sync)
- Export path in Advanced options set to your archive (default: `perplexity-mining/Perplexity_Export`)

---

## A. Export current conversation

1. Open a Perplexity thread (`https://www.perplexity.ai/search/...`).
2. Click the extension icon → **Export current conversation**.
3. Verify one `.md` file appears under your configured export folder `{space}/`.
4. Open Perplexity home (not a thread) → click **Export current conversation**.
5. Verify error: *"Not on a conversation page (/search/...)."*

**Context menu (optional):** Right-click on a thread page → **Export this conversation**.

---

## B. Export selected conversations

1. Open **Advanced options**.
2. Paste 2–3 conversation UUIDs (one duplicated) into the textarea.
3. Click **Export selected**.
4. Verify only deduped files download.
5. Open export folder `manifest-*.json` → confirm `runType: "selected"` and correct `exportedIds`.

---

## C. Recovery from bad API seed (if you used the old build)

1. Advanced → **Reset checkpoint**
2. Continue with section G

---

## D. Modify a conversation

1. Open an existing thread on Perplexity.
2. Send a follow-up message and wait for the response.

---

## E. Second incremental

1. Click **Incremental export** (Perplexity tab open).
2. Verify only new/changed threads export (not the full archive).
3. Manifest shows large `skipped` count and small `exportedIds` list.
4. If any export failed, checkpoint should **not** advance (status mentions *checkpoint not updated*).

---

## F. Regression — full export

1. Click **Start Export (full)**.
2. Verify all threads export as before (same Markdown format and filename pattern).
3. Click **Stop Process** mid-run → verify stop works and checkpoint is not corrupted.

---

## G. Archive link + sync + incremental (primary workflow)

1. Advanced → **Link archive folder…** → select `Perplexity_Export` (your on-disk archive).
2. Verify status: `Archive: Perplexity_Export (N files)`.
3. Click **Sync checkpoint from archive** (no Perplexity tab required).
4. Verify manifest `runType: "archive-seed"` and checkpoint count ≈ on-disk `.md` count (not API thread count).
5. Open Perplexity → **Incremental export**.
6. Verify exports = API threads missing from archive + any threads updated since archive baseline.

---

## Run unit tests

```bash
cd ~/Downloads/perplexity-mining
node --test extension-dev/tests/*.test.js
```

---

## Timestamp assumptions

| Priority | Field | Source |
|----------|-------|--------|
| 1 | `thread_metadata.updated_at` | Thread detail GET |
| 2 | Max `entry_updated_datetime` | Thread detail entries |
| 3 | `last_query_datetime` | Thread list API |
| 4 | File `lastModified` | Archive scan (checkpoint seed) |
| 5 | `inserted_at` / `created_at` | Thread list API |

---

## Follow-ups (not implemented)

- ZIP bundling for incremental runs
- Resume interrupted batch from checkpoint

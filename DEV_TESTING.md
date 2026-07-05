# Dev Build — Manual Test Guide

Load unpacked from this folder: `extension-dev/`

Chrome: `chrome://extensions` → Developer mode → Load unpacked → select this directory.

## Prerequisites

- Logged into Perplexity in the browser
- An active Perplexity tab open when starting any export

---

## A. Export current conversation

1. Open a Perplexity thread (`https://www.perplexity.ai/search/...`).
2. Click the extension icon → **Export current conversation**.
3. Verify one `.md` file appears under `Downloads/Perplexity_Export/{space}/`.
4. Open Perplexity home (not a thread) → click **Export current conversation**.
5. Verify error: *"Not on a conversation page (/search/...)."*

**Context menu (optional):** Right-click on a thread page → **Export this conversation**.

---

## B. Export selected conversations

1. Open **Advanced options**.
2. Paste 2–3 conversation UUIDs (one duplicated) into the textarea.
3. Click **Export selected**.
4. Verify only deduped files download.
5. Open `Downloads/Perplexity_Export/manifest-*.json` → confirm `runType: "selected"` and correct `exportedIds`.

---

## C. First incremental (with seeding)

1. Click **Mark current archive as synced** (requires Perplexity tab).
2. Wait for completion — should download a manifest with `runType: "seed"`.
3. Verify **no bulk `.md` re-download** occurred.
4. Popup Advanced section shows last sync time and thread count.

---

## D. Modify a conversation

1. Open an existing thread on Perplexity.
2. Send a follow-up message and wait for the response.

---

## E. Second incremental

1. Click **Incremental export**.
2. Verify only the modified thread (and any brand-new threads) export.
3. Manifest shows large `skipped` count and small `exportedIds` list.
4. If any export failed, checkpoint should **not** advance (status mentions *checkpoint not updated*).

---

## F. Regression — full export

1. Click **Start Export (full)**.
2. Verify all threads export as before (same Markdown format and filename pattern).
3. Click **Stop Process** mid-run → verify stop works and checkpoint is not corrupted.

---

## Run unit tests

```bash
node --test extension-dev/tests/export-utils.test.js
```

---

## Timestamp assumptions

| Priority | Field | Source |
|----------|-------|--------|
| 1 | `thread_metadata.updated_at` | Thread detail GET |
| 2 | Max `entry_updated_datetime` | Thread detail entries |
| 3 | `last_query_datetime` | Thread list API |
| 4 | `inserted_at` / `created_at` | Thread list API (Markdown header `Date:` unchanged) |

---

## Follow-ups (not implemented)

- Bootstrap checkpoint from local `Perplexity_Export/` filenames (offline)
- ZIP bundling for incremental runs
- Resume interrupted batch from checkpoint

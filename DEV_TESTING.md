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

## G. Downloads sync + incremental (supplemental)

1. Advanced → confirm export path is `perplexity-mining/Perplexity_Export` (or your archive path under Downloads).
2. Click **Sync checkpoint from Downloads (merge)** (no Perplexity tab required).
3. Verify status shows merge summary (`checkpoint N → M threads`). Downloads sync may index far fewer files than your on-disk archive in Brave.
4. Open Perplexity → **Incremental export**.
5. Verify exports = API threads missing from checkpoint + any threads updated since checkpoint baseline.

**Note:** Prefer section H for a full archive seed. Downloads sync merges in what it can find from browser history.

---

## H. Disk checkpoint seed + JSON import (primary seed workflow)

### H1. Offline script (privacy-first)

```bash
cd ~/Downloads/perplexity-mining
node scripts/build-checkpoint-from-disk.js \
  --root ~/Downloads/perplexity-mining/Perplexity_Export \
  --out ~/Downloads/perplexity-checkpoint.json
```

1. Advanced → **Import checkpoint JSON** → choose the generated file (or paste JSON).
2. Click **Merge imported checkpoint**.
3. Verify checkpoint count ≈ your on-disk UUID file count (~2,257).
4. Checkpoint line should show `seeded`.

### H2. In-browser disk folder pick

1. Advanced → **Seed checkpoint from disk folder…**
2. In the tab, click **Choose archive folder…** and select `Perplexity_Export`.
3. Verify success message with merged thread count.
4. Close tab → popup checkpoint count updated.

---

## I. Fast incremental (early-stop pagination)

1. After a complete checkpoint seed (section H), open Perplexity.
2. Click **Incremental export**.
3. Status should show `Checked N recent thread(s)...` with N ≈ 50–150 (not 2,258).
4. Only new/changed threads export.
5. Enable **Deep scan** in Advanced to force full API pagination (use after incomplete seed).
6. **Export since date** also stops early once a page is entirely before the cutoff date.

**Caveat:** List API timestamps can be stale. Use **Export since date** or **Deep scan** if an old edited thread is missed.

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
| 4 | Download `endTime` / file `mtime` | Downloads archive scan or disk seed |
| 5 | `inserted_at` / `created_at` | Thread list API |

---

## Follow-ups (not implemented)

- ZIP bundling for incremental runs
- Resume interrupted batch from checkpoint

## Overwrite on re-export

1. Advanced → enable **Overwrite existing files on export**.
2. **Start Export (full)** replaces same-path `.md` files instead of creating `(1)` duplicates.
3. Use only for emergency checkpoint rebuild when disk seed is unavailable.

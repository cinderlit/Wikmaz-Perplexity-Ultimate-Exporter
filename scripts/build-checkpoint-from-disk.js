#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const UUID_IN_FILENAME_RE =
  /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\.md$/i;
const UUID_STRICT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEEDED_THRESHOLD = 500;

function extractUuidFromFilename(filename) {
  if (!filename || typeof filename !== "string") return null;
  const match = filename.match(UUID_IN_FILENAME_RE);
  return match ? match[1].toLowerCase() : null;
}

function isValidUuid(uuid) {
  return Boolean(uuid && UUID_STRICT_RE.test(uuid));
}

function parseArgs(argv) {
  const options = {
    root: path.join(process.env.HOME || "", "Downloads/perplexity-mining/Perplexity_Export"),
    out: null
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      options.root = path.resolve(argv[++i]);
    } else if (arg === "--out" && argv[i + 1]) {
      options.out = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

function walkMdFiles(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error("Cannot read directory: " + dir + " (" + e.message + ")");
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMdFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function buildCheckpointFromDisk(rootDir) {
  const now = new Date().toISOString();
  const files = walkMdFiles(rootDir);
  const byUuid = new Map();
  let skippedNoUuid = 0;

  for (const filePath of files) {
    const base = path.basename(filePath);
    const uuid = extractUuidFromFilename(base);
    if (!isValidUuid(uuid)) {
      skippedNoUuid += 1;
      continue;
    }
    const stat = fs.statSync(filePath);
    const updatedAt = new Date(stat.mtimeMs || Date.now()).toISOString();
    const existing = byUuid.get(uuid);
    if (!existing || Date.parse(updatedAt) > Date.parse(existing.updatedAt)) {
      byUuid.set(uuid, {
        updatedAt,
        exportedAt: now,
        source: "disk",
        title: base
      });
    }
  }

  const conversationIndex = Object.fromEntries(byUuid.entries());
  const fileCount = Object.keys(conversationIndex).length;

  return {
    version: 1,
    lastSuccessfulExportAt: now,
    lastExportMode: "disk-import",
    lastSince: null,
    seededFromArchive: fileCount >= SEEDED_THRESHOLD,
    conversationIndex,
    archiveMeta: {
      fileCount,
      skippedNoUuid,
      source: "disk-script",
      lastScannedAt: now,
      root: rootDir
    }
  };
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(`Usage: node scripts/build-checkpoint-from-disk.js [--root PATH] [--out FILE]

  --root  Archive folder to scan (default: ~/Downloads/perplexity-mining/Perplexity_Export)
  --out   Write JSON to file instead of stdout
`);
    process.exit(0);
  }

  const checkpoint = buildCheckpointFromDisk(options.root);
  const json = JSON.stringify(checkpoint, null, 2);

  if (options.out) {
    fs.writeFileSync(options.out, json, "utf8");
    console.error(
      "Wrote checkpoint with " +
        checkpoint.archiveMeta.fileCount +
        " threads to " +
        options.out +
        (checkpoint.archiveMeta.skippedNoUuid
          ? " (" + checkpoint.archiveMeta.skippedNoUuid + " without UUID skipped)"
          : "")
    );
  } else {
    process.stdout.write(json);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractUuidFromFilename,
  isValidUuid,
  buildCheckpointFromDisk,
  walkMdFiles
};

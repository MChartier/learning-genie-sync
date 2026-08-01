import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.mjs";

export const LEDGER_FILENAME = ".learning-genie-ledger.json";
export const LEDGER_VERSION = 2;
export const TERMINAL_MEDIA_STATUSES = new Set(["uploaded", "unavailable"]);

export function isTerminalMediaStatus(status) {
  return TERMINAL_MEDIA_STATUSES.has(status);
}

export function loadMediaLedger(ledgerPath) {
  const fallback = { version: LEDGER_VERSION, media: {} };
  const ledger = readJsonFile(ledgerPath, fallback);
  if (!ledger || typeof ledger !== "object") return fallback;
  ledger.version = LEDGER_VERSION;
  ledger.media ||= {};
  return ledger;
}

export function saveMediaLedger(ledgerPath, ledger) {
  writeJsonAtomic(ledgerPath, {
    version: LEDGER_VERSION,
    media: ledger.media || {},
    updatedAt: new Date().toISOString()
  });
}

export function extractMediaDescriptors(payload) {
  const descriptors = [];
  const visited = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }

    if (Array.isArray(value.media)) {
      for (const media of value.media) {
        if (!media?.public_url) continue;
        descriptors.push(createDescriptor(media, value));
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "media") continue;
      visit(child);
    }
  }

  visit(payload);
  const unique = new Map();
  for (const descriptor of descriptors) unique.set(descriptor.key, descriptor);
  return [...unique.values()];
}

export function mergeDescriptorsIntoLedger(ledger, descriptors) {
  const usedPaths = new Map();
  for (const [key, entry] of Object.entries(ledger.media || {})) {
    if (entry.relativePath) usedPaths.set(normalizeRelativePath(entry.relativePath), key);
  }

  for (const descriptor of descriptors) {
    const previous = ledger.media[descriptor.key];
    // Signed/public URLs may refresh query tokens without representing new
    // media. Reset a durable status only when the canonical asset path changes.
    const sourceChanged = previous
      && canonicalSource(previous.url) !== canonicalSource(descriptor.url);
    const relativePath = previous?.relativePath
      || chooseRelativePath(descriptor.suggestedFilename, descriptor.key, usedPaths);
    usedPaths.set(normalizeRelativePath(relativePath), descriptor.key);
    ledger.media[descriptor.key] = {
      ...previous,
      ...descriptor,
      relativePath,
      status: sourceChanged ? "pending" : (previous?.status || "pending"),
      attempts: sourceChanged ? 0 : Number(previous?.attempts || 0),
      firstSeenAt: previous?.firstSeenAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
  }
  return ledger;
}

export function markLedgerPathsUploaded(mediaRoot, uploadedPaths) {
  const normalizedPaths = new Set([...uploadedPaths].map(file => path.resolve(file)));
  let changedEntries = 0;
  for (const ledgerPath of findLedgerFiles(mediaRoot)) {
    const ledger = loadMediaLedger(ledgerPath);
    const ledgerDirectory = path.dirname(ledgerPath);
    let changed = false;
    for (const entry of Object.values(ledger.media)) {
      if (!entry.relativePath) continue;
      const absolutePath = path.resolve(ledgerDirectory, entry.relativePath);
      if (!normalizedPaths.has(absolutePath)) continue;
      entry.status = "uploaded";
      entry.uploadedAt = new Date().toISOString();
      entry.lastError = null;
      changed = true;
      changedEntries += 1;
    }
    if (changed) saveMediaLedger(ledgerPath, ledger);
  }
  return changedEntries;
}

export function findLedgerFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".lg-sync-tmp") stack.push(fullPath);
      } else if (entry.isFile() && entry.name === LEDGER_FILENAME) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export function stableMediaKey(media) {
  const direct = media?.id ?? media?.mediaId ?? media?.media_id ?? media?.uid ?? media?.guid;
  if (direct) return `id:${direct}`;
  return `url:${sha256(normalizeUrl(media?.public_url || ""))}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function createDescriptor(media, parent) {
  const url = String(media.public_url);
  const timestamp = firstPresent(
    media.createAtUtc, media.createdAtUtc, media.create_at_utc, media.created_at_utc,
    media.createAtUTC, media.createdAtUTC,
    parent.createAtUtc, parent.createdAtUtc, parent.create_at_utc, parent.created_at_utc,
    parent.createAtUTC, parent.createdAtUTC,
    media.createAt, media.createdAt, media.create_at, media.created_at,
    parent.createAt, parent.createdAt, parent.create_at, parent.created_at
  );
  const utcTimestamp = firstPresent(
    media.createAtUtc, media.createdAtUtc, media.create_at_utc, media.created_at_utc,
    media.createAtUTC, media.createdAtUTC,
    parent.createAtUtc, parent.createdAtUtc, parent.create_at_utc, parent.created_at_utc,
    parent.createAtUTC, parent.createdAtUTC
  );
  const caption = (parent.type || "") === "Activity"
    ? sanitizeCaption(parent.payload)
    : "";

  return {
    key: stableMediaKey(media),
    mediaId: media.id ?? media.mediaId ?? media.media_id ?? null,
    url,
    timestamp: timestamp == null ? null : String(timestamp),
    timestampKind: utcTimestamp != null ? "utc" : "local",
    caption,
    suggestedFilename: filenameFromUrl(url)
  };
}

function firstPresent(...values) {
  return values.find(value => value !== null && value !== undefined && value !== "");
}

function sanitizeCaption(value) {
  if (value == null) return "";
  return String(value).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function filenameFromUrl(value) {
  let filename = "";
  try {
    filename = decodeURIComponent(path.posix.basename(new URL(value).pathname));
  } catch {
    filename = path.posix.basename(String(value).split("?")[0]);
  }
  filename = filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "");
  return filename || `media-${sha256(value).slice(0, 12)}`;
}

function chooseRelativePath(suggestedFilename, key, usedPaths) {
  const normalized = normalizeRelativePath(suggestedFilename);
  if (!usedPaths.has(normalized) || usedPaths.get(normalized) === key) return suggestedFilename;
  const extension = path.extname(suggestedFilename);
  const stem = path.basename(suggestedFilename, extension);
  return `${stem}-${sha256(key).slice(0, 10)}${extension}`;
}

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(value);
  }
}

function canonicalSource(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value).split("?")[0];
  }
}

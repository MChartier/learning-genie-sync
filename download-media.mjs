#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { fsyncDirectory, fsyncFile, writeJsonAtomic } from "./lib/atomic-json.mjs";
import {
  LEDGER_FILENAME,
  extractMediaDescriptors,
  loadMediaLedger,
  mergeDescriptorsIntoLedger,
  saveMediaLedger,
  sha256
} from "./lib/media-ledger.mjs";

const execFile = promisify(execFileCallback);
const GIB = 1024 ** 3;
const MEDIA_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".heic", ".png", ".webp", ".gif",
  ".mp4", ".mov", ".m4v", ".avi", ".mkv"
]);

export async function runDownloadBatch({
  inputPath,
  outdir,
  ledgerPath = path.join(outdir, LEDGER_FILENAME),
  reportPath = process.env.DOWNLOAD_REPORT_PATH,
  timezone = process.env.LOCAL_TZ || "America/Los_Angeles",
  commandRunner = defaultCommandRunner,
  contentLengthResolver = resolveContentLength,
  sleep = delay,
  logger = console,
  now = () => new Date(),
  maxAttempts = numberSetting("MAX_MEDIA_ATTEMPTS", 10),
  retriesPerRun = numberSetting("DOWNLOAD_MAX_RETRIES", 3),
  ledgerFlushEvery = numberSetting("LEDGER_FLUSH_EVERY", 100),
  retryBaseMs = numberSetting("RETRY_BASE_MS", 2000),
  retryMaxMs = numberSetting("RETRY_MAX_MS", 30000),
  maxStagingBytes = byteSetting("MAX_STAGING_BYTES", 20 * GIB),
  minFreeBytes = byteSetting("MIN_FREE_BYTES", 5 * GIB),
  unknownDownloadReserveBytes = byteSetting("UNKNOWN_DOWNLOAD_RESERVE_BYTES", 512 * 1024 ** 2)
}) {
  const startedAt = now().toISOString();
  fs.mkdirSync(outdir, { recursive: true });
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const descriptors = extractMediaDescriptors(payload);
  const ledger = loadMediaLedger(ledgerPath);
  mergeDescriptorsIntoLedger(ledger, descriptors);

  // Persist every descriptor before attempting network or metadata work. This
  // durable queue is what lets the fetch cursor move without losing one failed
  // media item or replaying months of already-complete downloads.
  saveMediaLedger(ledgerPath, ledger);
  let pendingLedgerUpdates = 0;
  const persistLedger = ({ force = false } = {}) => {
    pendingLedgerUpdates += 1;
    if (force || pendingLedgerUpdates >= Math.max(1, ledgerFlushEvery)) {
      saveMediaLedger(ledgerPath, ledger);
      pendingLedgerUpdates = 0;
    }
  };

  const report = {
    startedAt,
    finishedAt: null,
    ledgerPath,
    ledgerDurable: true,
    discovered: descriptors.length,
    downloaded: 0,
    downloadedBytes: 0,
    skipped: 0,
    skippedBytes: 0,
    warnings: 0,
    failed: 0,
    blocked: 0,
    exhausted: 0,
    failures: []
  };

  const entries = Object.values(ledger.media)
    .filter(entry => entry.status !== "uploaded")
    .sort((left, right) => String(left.firstSeenAt).localeCompare(String(right.firstSeenAt)));
  let currentStagingBytes = directorySize(outdir);

  logger.log(`[download] queued=${entries.length} newly_discovered=${descriptors.length}`);
  for (const entry of entries) {
    const destination = path.join(outdir, entry.relativePath);
    if (isCompleteDestination(destination)) {
      const bytes = fs.statSync(destination).size;
      entry.status = "complete";
      entry.bytes = bytes;
      entry.completedAt ||= now().toISOString();
      entry.lastError = null;
      persistLedger();
      report.skipped += 1;
      report.skippedBytes += bytes;
      continue;
    }

    if (Number(entry.attempts || 0) >= maxAttempts) {
      report.failed += 1;
      report.exhausted += 1;
      report.failures.push({ key: entry.key, path: entry.relativePath, error: "maximum attempts exhausted" });
      continue;
    }

    const expectedBytes = await contentLengthResolver(entry.url).catch(() => null);
    const reservation = positiveInteger(expectedBytes) || unknownDownloadReserveBytes;
    const capacity = inspectStorageCapacity(outdir, reservation, {
      maxStagingBytes,
      minFreeBytes,
      stagingBytes: currentStagingBytes
    });
    if (!capacity.allowed) {
      entry.status = "pending";
      entry.lastError = capacity.reason;
      entry.lastFailureAt = now().toISOString();
      persistLedger({ force: true });
      report.blocked += 1;
      report.failed += 1;
      report.failures.push({ key: entry.key, path: entry.relativePath, error: capacity.reason });
      logger.error(`[download] storage ceiling reached: ${capacity.reason}`);
      break;
    }

    let completed = false;
    let lastError;
    const attemptsRemaining = Math.max(0, maxAttempts - Number(entry.attempts || 0));
    const runAttempts = Math.min(retriesPerRun, attemptsRemaining);
    for (let runAttempt = 1; runAttempt <= runAttempts; runAttempt += 1) {
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.status = "downloading";
      entry.lastAttemptAt = now().toISOString();
      entry.lastError = null;

      try {
        const result = await downloadAndCommitEntry({
          entry,
          outdir,
          destination,
          timezone,
          commandRunner,
          logger
        });
        entry.status = "complete";
        entry.bytes = result.bytes;
        entry.completedAt = now().toISOString();
        entry.lastError = null;
        entry.metadataWarnings = result.warnings;
        persistLedger();
        report.downloaded += 1;
        report.downloadedBytes += result.bytes;
        report.warnings += result.warnings.length;
        currentStagingBytes += result.stagingDeltaBytes;
        completed = true;
        break;
      } catch (error) {
        lastError = error;
        entry.status = "failed";
        entry.lastError = error?.message || String(error);
        entry.lastFailureAt = now().toISOString();
        persistLedger({ force: true });
        currentStagingBytes = directorySize(outdir);
        if (isMissingToolError(error)) throw error;
        if (runAttempt < runAttempts) {
          const waitMs = Math.min(retryBaseMs * 2 ** (runAttempt - 1), retryMaxMs);
          logger.warn(`[download] ${entry.relativePath} failed; retrying in ${waitMs}ms: ${entry.lastError}`);
          await sleep(waitMs);
        }
      }
    }

    if (!completed) {
      report.failed += 1;
      report.failures.push({
        key: entry.key,
        path: entry.relativePath,
        error: lastError?.message || entry.lastError || "download failed"
      });
    }
  }

  if (pendingLedgerUpdates > 0) persistLedger({ force: true });
  report.finishedAt = now().toISOString();
  if (reportPath) writeJsonAtomic(reportPath, report);
  logger.log(
    `[download] downloaded=${report.downloaded} bytes=${report.downloadedBytes} `
    + `skipped=${report.skipped} skipped_bytes=${report.skippedBytes} `
    + `failed=${report.failed} warnings=${report.warnings} blocked=${report.blocked}`
  );
  return report;
}

export async function downloadAndCommitEntry({
  entry,
  outdir,
  destination,
  timezone,
  commandRunner = defaultCommandRunner,
  logger = console
}) {
  const tempDirectory = path.join(outdir, ".lg-sync-tmp");
  fs.mkdirSync(tempDirectory, { recursive: true });
  const extension = path.extname(entry.relativePath);
  const tempName = `${sha256(entry.key).slice(0, 24)}.part${extension}`;
  const temporaryPath = path.join(tempDirectory, tempName);
  const sidecar = sidecarPathFor(temporaryPath, extension);
  const destinationSidecar = sidecarPathFor(destination, extension);
  const affectedPaths = [
    temporaryPath,
    `${temporaryPath}.aria2`,
    sidecar,
    destination,
    `${destination}.aria2`,
    destinationSidecar
  ].filter(Boolean);
  const affectedBytesBefore = sumExistingFileSizes(affectedPaths);

  await commandRunner("aria2c", [
    "--auto-file-renaming=false",
    "--allow-overwrite=true",
    "--continue=true",
    "--max-tries=1",
    "--retry-wait=0",
    `--max-connection-per-server=${numberSetting("ARIA_CONN", 16)}`,
    `--split=${numberSetting("ARIA_SPLIT", 16)}`,
    `--dir=${tempDirectory}`,
    `--out=${tempName}`,
    entry.url
  ]);

  if (!fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size <= 0) {
    throw new Error(`aria2 did not produce a complete non-empty file for ${entry.relativePath}`);
  }
  if (fs.existsSync(`${temporaryPath}.aria2`)) {
    throw new Error(`aria2 control file remains for ${entry.relativePath}`);
  }

  const warnings = await stampMetadata({
    filePath: temporaryPath,
    finalExtension: extension,
    timestamp: entry.timestamp,
    timestampKind: entry.timestampKind,
    caption: entry.caption,
    timezone,
    commandRunner,
    logger
  });

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fsyncFile(temporaryPath);
  if (sidecar && fs.existsSync(sidecar)) {
    fsyncFile(sidecar);
    fs.renameSync(sidecar, destinationSidecar);
  }

  // rename(2) replaces any legacy aria2 partial on Linux and is atomic because
  // the temporary directory lives on the same filesystem as the destination.
  fs.renameSync(temporaryPath, destination);
  try { fs.unlinkSync(`${destination}.aria2`); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  fsyncDirectory(path.dirname(destination));
  const bytes = fs.statSync(destination).size;
  const sidecarBytes = destinationSidecar && fs.existsSync(destinationSidecar)
    ? fs.statSync(destinationSidecar).size
    : 0;
  const affectedBytesAfter = sumExistingFileSizes(affectedPaths);
  return {
    bytes,
    committedBytes: bytes + sidecarBytes,
    stagingDeltaBytes: affectedBytesAfter - affectedBytesBefore,
    warnings
  };
}

export async function stampMetadata({
  filePath,
  finalExtension,
  timestamp,
  timestampKind,
  caption,
  timezone,
  commandRunner = defaultCommandRunner,
  logger = console
}) {
  if (!timestamp) {
    logger.warn(`[metadata] no capture timestamp for ${path.basename(filePath)}; leaving metadata unchanged`);
    return ["missing capture timestamp"];
  }
  const fields = prepareTimestamp(timestamp, timestampKind, timezone);
  if (!fields) throw new Error(`Unable to parse capture timestamp '${timestamp}'`);

  const extension = finalExtension.toLowerCase();
  const warnings = [];
  const captionArgs = caption ? [`-XMP-dc:Description=${caption}`] : [];
  const commonXmp = [
    `-XMP:xmp:CreateDate=${fields.xmp}`,
    `-XMP:xmp:ModifyDate=${fields.xmp}`,
    `-XMP:xmp:MetadataDate=${fields.xmp}`,
    `-XMP-photoshop:DateCreated=${fields.xmp}`
  ];

  if ([".jpg", ".jpeg", ".heic"].includes(extension)) {
    const stillCaption = caption
      ? [`-EXIF:ImageDescription=${caption}`, `-IPTC:Caption-Abstract=${caption}`]
      : [];
    warnings.push(...await runExiftool([
      "-m", "-P", "-overwrite_original",
      `-EXIF:DateTimeOriginal=${fields.exif}`,
      `-EXIF:CreateDate=${fields.exif}`,
      `-EXIF:ModifyDate=${fields.exif}`,
      `-IPTC:DateCreated=${fields.iptcDate}`,
      `-IPTC:TimeCreated=${fields.iptcTime}`,
      ...commonXmp,
      `-FileModifyDate=${fields.xmp}`,
      ...stillCaption,
      ...captionArgs,
      filePath
    ], commandRunner));
  } else if ([".mp4", ".mov", ".m4v"].includes(extension)) {
    const videoCaption = caption
      ? [`-QuickTime:Comment=${caption}`, `-XMP-dc:Description=${caption}`]
      : [];
    warnings.push(...await runExiftool([
      "-m", "-P", "-overwrite_original",
      `-QuickTime:CreateDate=${fields.exif}`,
      `-QuickTime:ModifyDate=${fields.exif}`,
      `-QuickTime:TrackCreateDate=${fields.exif}`,
      `-QuickTime:TrackModifyDate=${fields.exif}`,
      `-QuickTime:MediaCreateDate=${fields.exif}`,
      `-QuickTime:MediaModifyDate=${fields.exif}`,
      ...commonXmp,
      `-FileModifyDate=${fields.xmp}`,
      ...videoCaption,
      filePath
    ], commandRunner));
  } else {
    warnings.push(...await runExiftool([
      "-m", "-P", "-overwrite_original",
      ...commonXmp,
      `-FileModifyDate=${fields.xmp}`,
      ...captionArgs,
      filePath
    ], commandRunner));

    if ([".png", ".webp"].includes(extension)) {
      warnings.push(...await runExiftool([
        "-m", "-P", "-overwrite_original", "-o", "%d%f.xmp",
        ...commonXmp,
        ...captionArgs,
        filePath
      ], commandRunner));
    }
  }

  for (const warning of warnings) logger.warn(`[metadata] ${warning}`);
  return warnings;
}

export async function runExiftool(args, commandRunner = defaultCommandRunner) {
  try {
    const result = await commandRunner("exiftool", args);
    return benignExifWarnings(result?.stderr);
  } catch (error) {
    const warnings = benignExifWarnings(error?.stderr);
    const stderrLines = nonemptyLines(error?.stderr);
    if (stderrLines.length > 0 && warnings.length === stderrLines.length) return warnings;
    throw new Error(`ExifTool failed: ${String(error?.stderr || error?.message || error).trim()}`, { cause: error });
  }
}

export function benignExifWarnings(stderr) {
  return nonemptyLines(stderr).filter(line => {
    if (!/^warning:/i.test(line)) return false;
    return /(?:invalid|malformed|bad|unsupported|converted|ignored).*(?:utf-?8|unicode|character|encoding)|(?:utf-?8|unicode|character|encoding).*(?:invalid|malformed|bad|unsupported|converted|ignored)|encoded text|text encoding/i.test(line);
  });
}

export function inspectStorageCapacity(
  root,
  reservationBytes,
  { maxStagingBytes, minFreeBytes, stagingBytes = directorySize(root) }
) {
  if (maxStagingBytes > 0 && stagingBytes + reservationBytes > maxStagingBytes) {
    return {
      allowed: false,
      stagingBytes,
      reason: `staging=${stagingBytes}B reservation=${reservationBytes}B ceiling=${maxStagingBytes}B`
    };
  }

  if (minFreeBytes > 0 && typeof fs.statfsSync === "function") {
    const stats = fs.statfsSync(root);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (freeBytes - reservationBytes < minFreeBytes) {
      return {
        allowed: false,
        stagingBytes,
        freeBytes,
        reason: `free=${freeBytes}B reservation=${reservationBytes}B minimum_free=${minFreeBytes}B`
      };
    }
  }
  return { allowed: true, stagingBytes };
}

export function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

export function prepareTimestamp(raw, kind = "utc", timezone = "UTC") {
  const normalized = String(raw).trim().replace(" ", "T");
  let instant;
  if (kind === "utc") {
    instant = new Date(/[zZ]|[+-]\d{2}(?::?\d{2})?$/.test(normalized) ? normalized : `${normalized}Z`);
  } else {
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    instant = zonedComponentsToDate({
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
      hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] || 0)
    }, timezone);
  }
  if (!instant || Number.isNaN(instant.getTime())) return null;

  const parts = datePartsInZone(instant, timezone);
  const offset = timezoneOffset(instant, timezone);
  const date = `${parts.year}:${parts.month}:${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  return {
    exif: `${date} ${time}`,
    xmp: `${parts.year}-${parts.month}-${parts.day}T${time}${offset}`,
    iptcDate: date,
    iptcTime: `${time}${offset}`
  };
}

async function defaultCommandRunner(command, args, options = {}) {
  return execFile(command, args, { maxBuffer: 10 * 1024 * 1024, ...options });
}

async function resolveContentLength(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (!response.ok) return null;
    return positiveInteger(response.headers.get("content-length"));
  } finally {
    clearTimeout(timeout);
  }
}

function isCompleteDestination(filePath) {
  try {
    return fs.statSync(filePath).isFile()
      && fs.statSync(filePath).size > 0
      && !fs.existsSync(`${filePath}.aria2`);
  } catch {
    return false;
  }
}

function sidecarPathFor(filePath, extension) {
  if (![".png", ".webp"].includes(extension.toLowerCase())) return null;
  return filePath.slice(0, -extension.length) + ".xmp";
}

function sumExistingFileSizes(paths) {
  let bytes = 0;
  for (const filePath of paths) {
    try { bytes += fs.statSync(filePath).size; } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

function nonemptyLines(value) {
  return String(value || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function isMissingToolError(error) {
  return error?.code === "ENOENT" || error?.cause?.code === "ENOENT";
}

function datePartsInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}

function timezoneOffset(date, timezone) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset"
  }).formatToParts(date).find(part => part.type === "timeZoneName")?.value || "GMT+00:00";
  const match = value.match(/GMT([+-]\d{2}):?(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "+00:00";
}

function zonedComponentsToDate(components, timezone) {
  const desired = Date.UTC(
    components.year, components.month - 1, components.day,
    components.hour, components.minute, components.second
  );
  let guess = new Date(desired);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = datePartsInZone(guess, timezone);
    const actualAsUtc = Date.UTC(
      Number(actual.year), Number(actual.month) - 1, Number(actual.day),
      Number(actual.hour), Number(actual.minute), Number(actual.second)
    );
    guess = new Date(guess.getTime() + desired - actualAsUtc);
  }
  return guess;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function numberSetting(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function byteSetting(name, fallback) {
  return numberSetting(name, fallback);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const [inputPath = "input.json", outdir = "downloads"] = process.argv.slice(2);
  if (!inputPath || !outdir) {
    console.error("Usage: download-media.mjs <input.json> <output-directory>");
    process.exitCode = 2;
    return;
  }
  try {
    await runDownloadBatch({ inputPath, outdir });
  } catch (error) {
    console.error(`[download] fatal: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

export { MEDIA_EXTENSIONS };

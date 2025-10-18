import { Command } from "commander";
import { chromium, request as pwRequest, type APIRequestContext, type Request } from "playwright";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDays,
  addMilliseconds,
  format,
  isAfter,
  isBefore,
  parseISO,
  subMilliseconds
} from "date-fns";
import { DateTime } from "luxon";
import pLimit from "p-limit";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { exiftool } from "exiftool-vendored";

type MaybeStorageState = Parameters<typeof pwRequest.newContext>[0]["storageState"];
type StorageState = Exclude<MaybeStorageState, string | undefined>;

const { mkdir, writeFile, rename } = fsPromises;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const DEFAULT_AUTH = path.join(PROJECT_ROOT, "auth.storage.json");
const DEFAULT_OUT = path.join(process.cwd(), "input.json");
const DEFAULT_OUTDIR = process.env.OUTDIR ?? path.join(process.cwd(), "downloads");
const DEFAULT_STATE = process.env.STATE_PATH ?? path.join(process.cwd(), "sync-state.json");

const LOGIN_URL = "https://web.learning-genie.com/#/login";
const PARENT_URL = "https://web.learning-genie.com/v2/#/parent";
const NOTES_BASE = "https://api2.learning-genie.com/api/v1/Notes";
const ENROLLMENTS_URL = "https://api2.learning-genie.com/api/v1/Enrollments";

const DEFAULT_COUNT = 50;
const DEFAULT_DELAY_MS = 350;
const MAX_SYNC_PAGES = 200;
const MAX_RETRIES = 4;
const DEFAULT_NOTE_CATEGORY = "report";
const INCLUDE_VIDEO_BOOK = true;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0";
const DEFAULT_LOCAL_TZ = "America/Los_Angeles";
let lastTimezoneOffsetHours: number | null = null;

interface MediaDownloadDescriptor {
  url: string;
  rawTimestamp: string;
  hint: "utc" | "local";
  caption?: string;
  mediaType: "video" | "image" | "unknown";
}

interface SoftAssetLimitResult {
  filteredItems: any[];
  totalAssets: number;
  selectedAssets: number;
  limited: boolean;
  latestTimestamp: Date | null;
  cutoffTimestamp: Date | null;
}

const program = new Command();
program.name("lg").description("Learning Genie Sync CLI").version("0.3.0");

program
  .command("sync")
  .description("Login if needed → fetch new Notes → download media with metadata")
  .option("--auth <file>", "storageState JSON path", DEFAULT_AUTH)
  .option("--outfile <file>", "intermediate JSON for the downloader", DEFAULT_OUT)
  .option("--outdir <dir>", "final download directory", DEFAULT_OUTDIR)
  .option("--max-assets <count>", "soft limit on number of assets to sync")
  .action(async (opts) => {
    const authPath = (opts.auth as string) ?? DEFAULT_AUTH;
    const outfileBase = (opts.outfile as string) ?? DEFAULT_OUT;
    const outdirRoot = (opts.outdir as string) ?? DEFAULT_OUTDIR;
    const maxAssets = parseMaxAssetsOption((opts as Record<string, unknown>).maxAssets);

    const username = process.env.LG_USER;
    const password = process.env.LG_PASS;
    if (!fs.existsSync(authPath) && (!username || !password)) {
      console.error("First run needs LG_USER and LG_PASS so the sync can log in automatically.");
      process.exit(2);
    }

    await ensureAuthValid({ authPath, username, password });

    const statePath = DEFAULT_STATE;
    const syncState = loadSyncState(statePath);

    const { storageState, savedHeaders } = loadAuthStateFile(authPath);
    let request: APIRequestContext;
    let headers: Record<string, string>;
    try {
      ({ request, extraHTTPHeaders: headers } = await createApiRequestContext({ storageState, savedHeaders }));
    } catch (err) {
      console.error((err as Error)?.message ?? err);
      process.exit(4);
    }

    try {
      let enrollments;
      try {
        enrollments = await fetchParentEnrollments({ request, headers });
      } catch (err) {
        console.error("Failed to load enrollments:", (err as Error)?.message ?? err);
        process.exit(6);
      }

      if (!Array.isArray(enrollments) || enrollments.length === 0) {
        console.error("No enrollments found for this account.");
        process.exit(7);
      }

      const usedFolderNames = new Map<string, number>();
      const multi = enrollments.length > 1;
      let stateUpdated = false;

      for (const enrollment of enrollments) {
        const enrollmentId = extractEnrollmentId(enrollment);
        if (!enrollmentId) {
          console.warn("Skipping enrollment with missing id:", JSON.stringify(enrollment));
          continue;
        }

        const displayName = resolveEnrollmentDisplayName(enrollment, enrollmentId);
        const folderBase = uniqueSlug(displayName, usedFolderNames);
        const childOutdir = path.join(outdirRoot, folderBase);

        const timezone = resolveEnrollmentTimezone({ enrollment, headers });
        if (timezone) {
          console.log(`🌐 [${displayName}] Using timezone ${timezone} for metadata`);
        }

        const storedISO = syncState[enrollmentId];
        let storedDate: Date | null = null;
        if (storedISO) {
          try {
            const parsed = parseISO(storedISO);
            if (!Number.isNaN(parsed?.getTime?.())) storedDate = parsed;
          } catch {
            storedDate = null;
          }
        }
        const derivedStart = storedDate ? addMilliseconds(storedDate, 1) : undefined;
        const effectiveStart = selectEffectiveStartDate(undefined, derivedStart);

        if (storedDate) {
          console.log(`🕒 [${displayName}] Last synced at ${storedDate.toISOString()} (state file)`);
        }
        if (effectiveStart) {
          const usingDerived = derivedStart && effectiveStart.getTime() === derivedStart.getTime();
          const sourceLabel = usingDerived ? "derived" : "default";
          console.log(`📆 [${displayName}] Using start time ${effectiveStart.toISOString()} (${sourceLabel})`);
        }

        console.log(`📚 Fetching notes for enrollment ${enrollmentId} …`);
        const items = await fetchNotesRange({
          request,
          enrollmentId,
          startDate: effectiveStart,
          endDate: undefined,
          pageSize: DEFAULT_COUNT,
          maxPages: MAX_SYNC_PAGES,
          delayMs: DEFAULT_DELAY_MS,
          assetLimit: typeof maxAssets === "number" ? maxAssets : undefined
        });

        let processedItems = items;
        let latestTimestampForState: Date | null = null;

        if (typeof maxAssets === "number") {
          const limitResult = applySoftAssetLimit(items, maxAssets);
          processedItems = limitResult.filteredItems;
          latestTimestampForState = limitResult.latestTimestamp;
          if (limitResult.totalAssets === 0) {
            console.log(`🎯 [${displayName}] No downloadable assets detected.`);
          } else if (limitResult.limited) {
            const cutoffDetail =
              limitResult.cutoffTimestamp != null ? ` (cutoff ${limitResult.cutoffTimestamp.toISOString()})` : "";
            console.log(
              `🎯 [${displayName}] Soft limit applied: selected ${limitResult.selectedAssets} of ${limitResult.totalAssets} assets${cutoffDetail}.`
            );
          } else {
            console.log(
              `🎯 [${displayName}] Soft limit of ${maxAssets} not reached; ${limitResult.totalAssets} assets available.`
            );
          }
        } else {
          latestTimestampForState = findLatestTimestamp(items);
        }

        if (!latestTimestampForState) {
          latestTimestampForState = findLatestTimestamp(processedItems);
        }

        const outfile = multi ? appendFileSuffix(outfileBase, `-${folderBase}`) : outfileBase;
        await writeFile(outfile, JSON.stringify({ items: processedItems }, null, 2));
        console.log(`📄 [${displayName}] Wrote ${processedItems.length} items → ${outfile}`);

        if (processedItems.length === 0) {
          console.log(`ℹ️  [${displayName}] No media in range; skipping downloader.`);
          continue;
        }

        await runDownloader({
          items: processedItems,
          outdir: childOutdir,
          timezone,
          label: displayName
        });

        const latest = latestTimestampForState ?? findLatestTimestamp(processedItems);
        if (latest) {
          syncState[enrollmentId] = latest.toISOString();
          stateUpdated = true;
        }
      }

      if (stateUpdated) {
        saveSyncState(statePath, syncState);
      }
    } finally {
      await request.dispose();
    }
  });

await program.parseAsync(process.argv);

process.on("exit", () => {
  void exiftool.end();
});

process.on("SIGINT", () => {
  void exiftool.end().finally(() => process.exit(1));
});

// ---------------------------------------------------------------------------
// Downloader implementation
// ---------------------------------------------------------------------------

async function runDownloader({
  items,
  outdir,
  timezone,
  label
}: {
  items: unknown[];
  outdir: string;
  timezone?: string | null;
  label: string;
}) {
  const resolvedTimezone = sanitizeTimezone(timezone) ?? sanitizeTimezone(process.env.LOCAL_TZ) ?? DEFAULT_LOCAL_TZ;
  await mkdir(outdir, { recursive: true });

  const mediaItems = collectMediaEntries(items);
  if (mediaItems.length === 0) {
    console.log(`ℹ️  [${label}] No downloadable media items detected.`);
    return;
  }

  const concurrency =
    Number.parseInt(process.env.LG_DOWNLOAD_CONCURRENCY ?? "", 10) > 0
      ? Number.parseInt(process.env.LG_DOWNLOAD_CONCURRENCY!, 10)
      : 6;
  const limit = pLimit(concurrency);

  console.log(`⬇️  [${label}] Downloading ${mediaItems.length} media files → ${outdir}`);

  const results = await Promise.all(
    mediaItems.map((entry, index) =>
      limit(async () => {
        const filename = await resolveDestinationFilename(outdir, entry.url, index);
        const filePath = path.join(outdir, filename);
        await downloadToFile(entry.url, filePath);
        await applyMetadata(filePath, entry, resolvedTimezone);
        console.log(`✅  ${path.basename(filePath)} ← ${entry.rawTimestamp}`);
      }).catch((err) => {
        console.error(`   ⚠ Failed to handle ${entry.url}: ${(err as Error)?.message ?? err}`);
      })
    )
  );

  void results;
}

function applySoftAssetLimit(items: any[], maxAssets: number): SoftAssetLimitResult {
  if (!Array.isArray(items) || items.length === 0) {
    const safeItems = Array.isArray(items) ? items : [];
    return {
      filteredItems: safeItems,
      totalAssets: 0,
      selectedAssets: 0,
      limited: false,
      latestTimestamp: findLatestTimestamp(safeItems),
      cutoffTimestamp: null
    };
  }

  type AssetRecord = {
    itemIndex: number;
    mediaIndex: number;
    timestamp: Date | null;
  };

  const records: AssetRecord[] = [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (!item || typeof item !== "object") continue;
    const anyItem = item as Record<string, unknown>;
    const mediaArray = Array.isArray(anyItem.media) ? (anyItem.media as unknown[]) : null;
    if (!mediaArray || mediaArray.length === 0) continue;

    const parentTimestamp = extractTimestamp(anyItem)?.date ?? null;

    for (let mediaIndex = 0; mediaIndex < mediaArray.length; mediaIndex++) {
      const mediaEntry = mediaArray[mediaIndex];
      if (!mediaEntry || typeof mediaEntry !== "object") continue;

      const timestamp = resolveAssetTimestamp(
        mediaEntry as Record<string, unknown>,
        anyItem,
        parentTimestamp
      );

      records.push({
        itemIndex,
        mediaIndex,
        timestamp
      });
    }
  }

  const totalAssets = records.length;
  if (totalAssets === 0) {
    return {
      filteredItems: items,
      totalAssets: 0,
      selectedAssets: 0,
      limited: false,
      latestTimestamp: findLatestTimestamp(items),
      cutoffTimestamp: null
    };
  }

  if (totalAssets <= maxAssets) {
    return {
      filteredItems: items,
      totalAssets,
      selectedAssets: totalAssets,
      limited: false,
      latestTimestamp: findLatestTimestamp(items),
      cutoffTimestamp: null
    };
  }

  records.sort((a, b) => {
    const aTime = a.timestamp ? a.timestamp.getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.timestamp ? b.timestamp.getTime() : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
    return a.mediaIndex - b.mediaIndex;
  });

  const selectedRecords: AssetRecord[] = [];
  let boundaryTime: number | null = null;

  for (const record of records) {
    if (selectedRecords.length < maxAssets) {
      selectedRecords.push(record);
      if (record.timestamp) {
        boundaryTime = record.timestamp.getTime();
      }
      continue;
    }

    if (
      boundaryTime != null &&
      record.timestamp &&
      record.timestamp.getTime() === boundaryTime
    ) {
      selectedRecords.push(record);
      continue;
    }

    break;
  }

  const selectedByItem = new Map<number, Set<number>>();
  for (const record of selectedRecords) {
    let set = selectedByItem.get(record.itemIndex);
    if (!set) {
      set = new Set<number>();
      selectedByItem.set(record.itemIndex, set);
    }
    set.add(record.mediaIndex);
  }

  const filteredItems: any[] = [];
  let latestItemTimestampFallback: Date | null = null;

  const pushAndTrack = (entry: any) => {
    filteredItems.push(entry);
    const ts = extractTimestamp(entry);
    if (ts && (!latestItemTimestampFallback || isAfter(ts.date, latestItemTimestampFallback))) {
      latestItemTimestampFallback = ts.date;
    }
  };

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const originalItem = items[itemIndex];
    if (!originalItem || typeof originalItem !== "object") {
      pushAndTrack(originalItem);
      continue;
    }

    const anyItem = originalItem as Record<string, unknown>;
    const mediaArray = Array.isArray(anyItem.media) ? (anyItem.media as unknown[]) : null;
    if (!mediaArray) {
      pushAndTrack(originalItem);
      continue;
    }
    if (mediaArray.length === 0) {
      pushAndTrack(originalItem);
      continue;
    }

    const selectedSet = selectedByItem.get(itemIndex);
    if (!selectedSet || selectedSet.size === 0) {
      continue;
    }

    const filteredMedia = mediaArray.filter((_, idx) => selectedSet.has(idx));
    const clonedItem = { ...anyItem, media: filteredMedia };
    pushAndTrack(clonedItem);
  }

  let latestAssetTimestamp: Date | null = null;
  let cutoffTimestamp: Date | null = null;
  for (let idx = selectedRecords.length - 1; idx >= 0; idx--) {
    const ts = selectedRecords[idx]?.timestamp ?? null;
    if (ts && (!cutoffTimestamp || ts.getTime() > cutoffTimestamp.getTime())) {
      cutoffTimestamp = ts;
    }
    if (ts && (!latestAssetTimestamp || isAfter(ts, latestAssetTimestamp))) {
      latestAssetTimestamp = ts;
    }
  }

  let latestTimestamp = latestAssetTimestamp ?? null;
  if (!latestTimestamp && latestItemTimestampFallback) {
    latestTimestamp = latestItemTimestampFallback;
  }
  if (!latestTimestamp) {
    latestTimestamp = findLatestTimestamp(filteredItems);
  }

  return {
    filteredItems,
    totalAssets,
    selectedAssets: selectedRecords.length,
    limited: selectedRecords.length < totalAssets,
    latestTimestamp: latestTimestamp ?? null,
    cutoffTimestamp
  };

  function resolveAssetTimestamp(
    media: Record<string, unknown>,
    parent: Record<string, unknown>,
    fallback: Date | null
  ): Date | null {
    const resolved = resolveMediaTimestamp(media, parent);
    if (resolved) {
      const parsed = parseTimestamp(resolved.value, { treatAsUTC: resolved.hint === "utc" });
      if (parsed) {
        return parsed.date;
      }
    }

    const mediaTimestamp = extractTimestamp(media);
    if (mediaTimestamp) {
      return mediaTimestamp.date;
    }

    return fallback;
  }
}

function collectMediaEntries(items: unknown[]): MediaDownloadDescriptor[] {
  if (!Array.isArray(items)) return [];
  const results: MediaDownloadDescriptor[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const anyItem = item as Record<string, unknown>;
    if (!Array.isArray(anyItem.media)) continue;

    for (const media of anyItem.media as Record<string, unknown>[]) {
      if (!media || typeof media !== "object") continue;
      const url = normalizeUrl((media as Record<string, unknown>).public_url ?? media.publicUrl);
      if (!url) continue;

      const timestampInfo = resolveMediaTimestamp(media, anyItem);
      if (!timestampInfo) continue;

      const caption = deriveCaption(anyItem);
      const mediaType = classifyMediaType(media);

      results.push({
        url,
        rawTimestamp: timestampInfo.value,
        hint: timestampInfo.hint,
        caption,
        mediaType
      });
    }
  }

  return results;
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function resolveMediaTimestamp(
  media: Record<string, unknown>,
  parent: Record<string, unknown>
): { value: string; hint: "utc" | "local" } | null {
  const utcKeys = [
    "createAtUtc",
    "createdAtUtc",
    "create_at_utc",
    "created_at_utc",
    "createAtUTC",
    "createdAtUTC"
  ];
  const localKeys = ["createAt", "createdAt", "create_at", "created_at"];

  for (const key of utcKeys) {
    const val = pickFirstDefined([media[key], parent[key]]);
    if (typeof val === "string" && val.trim()) {
      return { value: val.trim(), hint: "utc" };
    }
  }

  for (const key of localKeys) {
    const val = pickFirstDefined([media[key], parent[key]]);
    if (typeof val === "string" && val.trim()) {
      return { value: val.trim(), hint: "local" };
    }
  }

  return null;
}

function pickFirstDefined(values: unknown[]): unknown {
  for (const val of values) {
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return null;
}

function deriveCaption(parent: Record<string, unknown>): string | undefined {
  const type = typeof parent.type === "string" ? parent.type : undefined;
  if (type !== "Activity") return undefined;

  const raw = parent.payload ?? parent.caption ?? parent.description;
  if (raw == null) return undefined;

  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  }

  return text.replace(/\r|\n/g, " ").replace(/\t/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

function classifyMediaType(media: Record<string, unknown>): "video" | "image" | "unknown" {
  const mime = typeof media.mimeType === "string" ? media.mimeType : typeof media.type === "string" ? media.type : "";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";

  const url = normalizeUrl((media.public_url ?? media.publicUrl) as string | undefined);
  if (url) {
    const lower = url.toLowerCase();
    if (/\.(mp4|mov|m4v)(\?|$)/.test(lower)) return "video";
    if (/\.(jpe?g|heic|png|webp)(\?|$)/.test(lower)) return "image";
  }

  return "unknown";
}

async function resolveDestinationFilename(outdir: string, url: string, index: number): Promise<string> {
  const parsed = safeUrlParse(url);
  const base = path.basename(parsed?.pathname ?? "");
  const ext = path.extname(base);
  const stem = base ? path.basename(base, ext) : `media-${index}`;
  const safeStem = stem || `media-${index}`;
  const safeExt = ext || guessExtensionFromUrl(url);

  let candidate = `${safeStem}${safeExt}`;
  let attempt = 1;
  while (fs.existsSync(path.join(outdir, candidate))) {
    candidate = `${safeStem}-${attempt}${safeExt}`;
    attempt += 1;
  }
  return candidate;
}

function guessExtensionFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return ".jpg";
  if (lower.includes(".png")) return ".png";
  if (lower.includes(".webp")) return ".webp";
  if (lower.includes(".heic")) return ".heic";
  if (lower.includes(".mp4")) return ".mp4";
  if (lower.includes(".mov")) return ".mov";
  if (lower.includes(".m4v")) return ".m4v";
  return ".bin";
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const tempPath = `${destination}.partial`;
  try {
    const nodeStream = Readable.fromWeb(response.body as ReadableStream<any>);
    await pipeline(nodeStream, fs.createWriteStream(tempPath));
    await rename(tempPath, destination);
  } catch (err) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function applyMetadata(
  filePath: string,
  entry: MediaDownloadDescriptor,
  timezone: string
): Promise<void> {
  const timestamp = prepareTimestamp(entry.rawTimestamp, entry.hint, timezone);
  if (!timestamp) {
    console.warn(`   ⚠ Failed to parse timestamp '${entry.rawTimestamp}' (hint=${entry.hint})`);
    return;
  }

  const extension = path.extname(filePath).toLowerCase().replace(/^\./, "");
  const caption = entry.caption;

  if (["mp4", "mov", "m4v"].includes(extension) || entry.mediaType === "video") {
    await stampVideo(filePath, timestamp, caption);
  } else if (["png", "webp"].includes(extension)) {
    await stampPngOrWebp(filePath, timestamp, caption);
  } else if (["jpg", "jpeg", "heic"].includes(extension) || entry.mediaType === "image") {
    await stampStillImage(filePath, timestamp, caption);
  } else {
    await stampGeneric(filePath, timestamp, caption);
  }
}

interface PreparedTimestamp {
  exif: string;
  xmp: string;
  iptcDate: string;
  iptcTime: string;
  file: string;
  log: string;
}

function prepareTimestamp(raw: string, hint: "utc" | "local", timezone: string): PreparedTimestamp | null {
  const normalized = raw.replace(" ", "T");

  let dt =
    hint === "utc"
      ? DateTime.fromISO(normalized, { zone: "utc" })
      : DateTime.fromISO(normalized, { zone: timezone });

  if (!dt.isValid) {
    dt =
      hint === "utc"
        ? DateTime.fromRFC2822(raw, { zone: "utc" })
        : DateTime.fromRFC2822(raw, { zone: timezone });
  }

  if (!dt.isValid) {
    return null;
  }

  const localized = dt.setZone(timezone, { keepLocalTime: hint === "local" });
  if (!localized.isValid) {
    return null;
  }

  return {
    exif: localized.toFormat("yyyy:MM:dd HH:mm:ss"),
    xmp: localized.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ"),
    iptcDate: localized.toFormat("yyyy:MM:dd"),
    iptcTime: localized.toFormat("HH:mm:ssZZ"),
    file: localized.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ"),
    log: localized.toISO() ?? localized.toString()
  };
}

async function stampStillImage(filePath: string, ts: PreparedTimestamp, caption?: string) {
  const tags: Record<string, string> = {
    AllDates: ts.exif,
    "IPTC:DateCreated": ts.iptcDate,
    "IPTC:TimeCreated": ts.iptcTime,
    "XMP:CreateDate": ts.xmp,
    "XMP:ModifyDate": ts.xmp,
    "XMP:MetadataDate": ts.xmp,
    "XMP-photoshop:DateCreated": ts.xmp,
    FileModifyDate: ts.file
  };
  if (caption) {
    tags["EXIF:ImageDescription"] = caption;
    tags["IPTC:Caption-Abstract"] = caption;
    tags["XMP-dc:Description"] = caption;
  }
  await exiftool.write(filePath, tags as any, ["-overwrite_original", "-P", "-m"]);
  console.log(`   🖼  EXIF/XMP/IPTC set (LOCAL) → ${path.basename(filePath)} ← ${ts.log}`);
}

async function stampPngOrWebp(filePath: string, ts: PreparedTimestamp, caption?: string) {
  const baseTags: Record<string, string> = {
    "XMP:CreateDate": ts.xmp,
    "XMP:ModifyDate": ts.xmp,
    "XMP:MetadataDate": ts.xmp,
    "XMP-photoshop:DateCreated": ts.xmp,
    FileModifyDate: ts.file
  };
  if (caption) {
    baseTags["XMP-dc:Description"] = caption;
  }
  await exiftool.write(filePath, baseTags as any, ["-overwrite_original", "-P", "-m"]);

  const sidecarTags: Record<string, string> = {
    "XMP:CreateDate": ts.xmp,
    "XMP:ModifyDate": ts.xmp,
    "XMP:MetadataDate": ts.xmp,
    "XMP-photoshop:DateCreated": ts.xmp
  };
  if (caption) {
    sidecarTags["XMP-dc:Description"] = caption;
  }
  await exiftool.write(filePath, sidecarTags as any, ["-overwrite_original", "-P", "-m", "-o", "%d%f.xmp"]);
  console.log(`   🧩 PNG/WEBP XMP+sidecar (LOCAL) → ${path.basename(filePath)} ← ${ts.log}`);
}

async function stampGeneric(filePath: string, ts: PreparedTimestamp, caption?: string) {
  const sidecarTags: Record<string, string> = {
    "XMP:CreateDate": ts.xmp,
    "XMP:ModifyDate": ts.xmp,
    "XMP:MetadataDate": ts.xmp,
    "XMP-photoshop:DateCreated": ts.xmp
  };
  if (caption) {
    sidecarTags["XMP-dc:Description"] = caption;
  }
  await exiftool.write(filePath, sidecarTags as any, ["-overwrite_original", "-P", "-m", "-o", "%d%f.xmp"]);
  await exiftool.write(
    filePath,
    { FileModifyDate: ts.file } as any,
    ["-overwrite_original", "-P", "-m"]
  );
  console.log(`   ℹ  Sidecar+mtime (LOCAL) → ${path.basename(filePath)} ← ${ts.log}`);
}

async function stampVideo(filePath: string, ts: PreparedTimestamp, caption?: string) {
  const tags: Record<string, string> = {
    "QuickTime:CreateDate": ts.exif,
    "QuickTime:ModifyDate": ts.exif,
    "QuickTime:TrackCreateDate": ts.exif,
    "QuickTime:TrackModifyDate": ts.exif,
    "QuickTime:MediaCreateDate": ts.exif,
    "QuickTime:MediaModifyDate": ts.exif,
    "XMP:CreateDate": ts.xmp,
    "XMP:ModifyDate": ts.xmp,
    "XMP:MetadataDate": ts.xmp,
    "XMP-photoshop:DateCreated": ts.xmp,
    FileModifyDate: ts.file
  };
  if (caption) {
    tags["QuickTime:Comment"] = caption;
    tags["XMP-dc:Description"] = caption;
  }
  await exiftool.write(filePath, tags as any, ["-overwrite_original", "-P", "-m"]);
  console.log(`   🎬 QuickTime/XMP set (LOCAL) → ${path.basename(filePath)} ← ${ts.log}`);
}

function sanitizeTimezone(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function safeUrlParse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Existing helper logic (adapted from lg.mjs)
// ---------------------------------------------------------------------------

async function loginAndSaveState({
  username,
  password,
  authPath,
  headless = true
}: {
  username: string;
  password: string;
  authPath: string;
  headless?: boolean;
}) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  let capturedApiHeaders: Record<string, string> | null = null;
  page.on("request", (req: Request) => {
    if (!req.url().startsWith("https://api2.learning-genie.com/")) return;
    const picked = pickRelevantApiHeaders(req.headers());
    if (!picked) return;
    const prefer = /\/api\/v1\/Notes/i.test(req.url());
    if (!capturedApiHeaders || prefer) {
      capturedApiHeaders = picked;
    }
  });

  console.log(`🔐 Navigating to login page …`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  console.log(`✏️ Filling login form and submitting …`);
  const emailField = page.locator('input[id="userEmail"]');
  const passwordField = page.locator('input[id="userPassword"]');
  await emailField.waitFor({ state: "visible", timeout: 15000 });
  await emailField.fill(username);
  await passwordField.waitFor({ state: "visible", timeout: 15000 });
  await passwordField.fill(password);
  await Promise.all([
    page.click('button[id="btnLogin"], button:has-text("Sign In")'),
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {})
  ]);

  console.log(`👶 Waiting for parent portal to load …`);
  await page.goto(PARENT_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log(`🔑 Saving auth state …`);
  const storage = await ctx.storageState();
  const extraHeaders = buildApiHeaders(
    {
      storageState: storage,
      savedHeaders: capturedApiHeaders ?? undefined
    },
    { allowMissingUid: true }
  );
  if (extraHeaders && !extraHeaders["x-uid"]) {
    console.warn("⚠️  Could not auto-detect X-UID. Set LG_UID env before fetch/sync commands if API calls fail.");
  }
  const payload = extraHeaders ? { ...storage, __extraHTTPHeaders: extraHeaders } : storage;
  await writeFile(authPath, JSON.stringify(payload, null, 2), "utf8");

  console.log("💯 Login complete.");
  await browser.close();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatForApi(date: Date, { treatAsUTC = false }: { treatAsUTC?: boolean } = {}) {
  if (treatAsUTC) {
    if (typeof lastTimezoneOffsetHours === "number" && Number.isFinite(lastTimezoneOffsetHours)) {
      const localDate = new Date(date.getTime() + lastTimezoneOffsetHours * 60 * 60 * 1000);
      return format(localDate, "yyyy-MM-dd HH:mm:ss.SSS");
    }
    const iso = date.toISOString();
    return iso.slice(0, -1).replace("T", " ");
  }
  return format(date, "yyyy-MM-dd HH:mm:ss.SSS");
}

function extractTimestamp(item: any): { date: Date; raw: string; treatAsUTC: boolean } | null {
  if (!item || typeof item !== "object") return null;

  const directCandidates: Array<[string, boolean]> = [
    ["create_at", false],
    ["createAt", false],
    ["createdAt", false],
    ["from_date", false],
    ["timestamp", false],
    ["to_date", false],
    ["update_at", false],
    ["updatedAt", false],
    ["create_at_utc", true],
    ["update_at_utc", true],
    ["createAtUtc", true],
    ["createdAtUtc", true],
    ["updatedAtUtc", true],
    ["updateAtUtc", true]
  ];

  for (const [key, treatAsUTC] of directCandidates) {
    if (item[key] == null) continue;
    const parsed = parseTimestamp(item[key], { treatAsUTC });
    if (parsed) return parsed;
  }

  if (Array.isArray(item.media)) {
    for (const media of item.media) {
      const parsed = extractTimestamp(media);
      if (parsed) return parsed;
    }
  }

  return null;
}

function parseTimestamp(
  raw: unknown,
  { treatAsUTC = false }: { treatAsUTC?: boolean } = {}
): { date: Date; raw: string; treatAsUTC: boolean } | null {
  const str = String(raw ?? "").trim();
  if (!str) return null;

  const normalized = str.replace(" ", "T");
  const attempts = new Set<string>();

  if (treatAsUTC) {
    if (/[zZ]|[+-]\d{2}/.test(normalized)) {
      attempts.add(normalized);
    } else {
      attempts.add(`${normalized}Z`);
    }
  } else {
    attempts.add(str);
    attempts.add(normalized);
  }

  for (const cand of attempts) {
    const d = new Date(cand);
    if (!Number.isNaN(d.getTime())) {
      return { date: d, raw: str, treatAsUTC };
    }
  }

  try {
    const d = parseISO(normalized);
    if (!Number.isNaN(d.getTime())) {
      return { date: d, raw: str, treatAsUTC };
    }
  } catch {
    // ignore parse errors
  }

  return null;
}

function pickRelevantApiHeaders(headers: Record<string, string> = {}) {
  const interesting = [
    "accept",
    "accept-language",
    "origin",
    "referer",
    "user-agent",
    "x-center-id",
    "x-lg-language",
    "x-lg-platform",
    "x-lg-timezoneoffset",
    "x-uid",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site"
  ];
  const picked: Record<string, string> = {};
  for (const key of interesting) {
    if (headers[key]) picked[key] = headers[key];
  }
  return Object.keys(picked).length ? picked : null;
}

function buildApiHeaders(
  { storageState, savedHeaders }: { storageState: StorageState; savedHeaders?: Record<string, string> | null },
  { allowMissingUid = false }: { allowMissingUid?: boolean } = {}
) {
  const base: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    origin: "https://web.learning-genie.com",
    referer: "https://web.learning-genie.com/",
    "user-agent": DEFAULT_USER_AGENT,
    "x-lg-platform": "web"
  };

  if (savedHeaders) {
    for (const [key, value] of Object.entries(savedHeaders)) {
      if (value) base[key] = value;
    }
  }

  if (!base["accept-language"]) {
    const lang = inferLanguage(storageState);
    if (lang) base["accept-language"] = lang;
  }
  if (!base["x-lg-language"] && base["accept-language"]) {
    base["x-lg-language"] = base["accept-language"].split(",")[0] || "en-US";
  }

  if (!base["x-center-id"]) {
    const centerId = inferGroupField(storageState, "center_id");
    base["x-center-id"] = centerId ?? "null";
  }

  if (!base["x-lg-timezoneoffset"]) {
    const tz = inferGroupField(storageState, "timezone");
    const offset = computeTimezoneOffsetHours(tz);
    base["x-lg-timezoneoffset"] =
      offset != null ? String(offset) : String(-new Date().getTimezoneOffset() / 60);
  }

  if (base["x-lg-timezoneoffset"] != null) {
    const num = Number(base["x-lg-timezoneoffset"]);
    if (!Number.isNaN(num)) {
      lastTimezoneOffsetHours = num;
    }
  }

  if (!base["x-uid"]) {
    const envUid = process.env.LG_UID?.trim();
    if (envUid) base["x-uid"] = envUid;
  }

  if (!base["accept-language"]) {
    base["accept-language"] = "en-US,en;q=0.9";
  }

  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || value === null || value === "") continue;
    cleaned[key] = String(value);
  }

  if (!cleaned["x-uid"] && !allowMissingUid) {
    throw new Error("Missing X-UID header. Re-run the sync with LG_USER/LG_PASS set or provide LG_UID env.");
  }

  return cleaned;
}

function inferLanguage(storageState: StorageState) {
  const raw = extractLocalStorageValue(storageState, "NG_TRANSLATE_LANG_KEY");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // ignore
  }
  if (typeof raw === "string") return raw;
  return null;
}

function inferGroupField(storageState: StorageState, key: string) {
  const raw = extractLocalStorageValue(storageState, "group");
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && key in obj) {
      return (obj as Record<string, unknown>)[key] as string | null;
    }
  } catch {
    // ignore
  }
  return null;
}

function computeTimezoneOffsetHours(tzValue: unknown) {
  if (typeof tzValue === "number") return tzValue;
  if (typeof tzValue === "string") {
    const trimmed = tzValue.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function extractLocalStorageValue(storageState: StorageState, key: string) {
  if (!storageState || typeof storageState === "string") return null;
  if (!storageState.origins) return null;
  for (const origin of storageState.origins) {
    if (!origin?.localStorage) continue;
    for (const entry of origin.localStorage) {
      if (entry?.name === key) {
        return entry.value ?? null;
      }
    }
  }
  return null;
}

function extractEnrollmentId(enrollment: any) {
  return (
    enrollment?.enrollment_id ??
    enrollment?.enrollmentId ??
    enrollment?.enrollmentID ??
    enrollment?.id ??
    enrollment?.childEnrollmentId ??
    null
  );
}

function resolveEnrollmentDisplayName(enrollment: any, fallback: string) {
  const candidates = [
    enrollment?.display_name,
    enrollment?.displayName,
    enrollment?.name,
    enrollment?.child?.name,
    enrollment?.child?.fullName,
    enrollment?.child?.firstName && enrollment?.child?.lastName
      ? `${enrollment.child.firstName} ${enrollment.child.lastName}`
      : null,
    enrollment?.child?.nickname
  ];

  for (const cand of candidates) {
    if (typeof cand === "string" && cand.trim()) {
      return cand.trim();
    }
  }

  return fallback;
}

function uniqueSlug(value: string, map: Map<string, number>) {
  let slug = slugifyName(value) || "child";
  let attempt = map.get(slug) ?? 0;
  if (attempt > 0) {
    slug = `${slug}-${attempt}`;
  }
  map.set(slugifyName(value) || "child", attempt + 1);
  return slug;
}

function slugifyName(value: string) {
  if (!value) return "";
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  return ascii
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function appendFileSuffix(filePath: string, suffix: string) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  return path.join(dir, `${base}${suffix}${ext}`);
}

function resolveEnrollmentTimezone({
  enrollment,
  headers
}: {
  enrollment: any;
  headers: Record<string, string>;
}): string | null {
  const candidates = [
    enrollment?.center?.timezone,
    enrollment?.group?.timezone,
    enrollment?.timezone,
    enrollment?.timeZone,
    enrollment?.child?.timezone,
    enrollment?.child?.timeZone
  ];
  for (const tz of candidates) {
    if (typeof tz === "string" && tz.trim()) return tz.trim();
  }

  const offsetHeader = getHeaderValue(headers, "x-lg-timezoneoffset");
  if (offsetHeader && offsetHeader !== "null") {
    const num = Number(offsetHeader);
    if (!Number.isNaN(num)) {
      const tz = offsetHoursToTimezone(num);
      if (tz) return tz;
    }
  }

  if (process.env.LOCAL_TZ && process.env.LOCAL_TZ.trim()) {
    return process.env.LOCAL_TZ.trim();
  }

  return null;
}

function getHeaderValue(headers: Record<string, string>, name: string) {
  if (!headers) return undefined;
  if (headers[name] != null) return headers[name];
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function offsetHoursToTimezone(offsetHours: number) {
  if (!Number.isFinite(offsetHours)) return null;
  const inverted = -offsetHours;
  const suffix = inverted >= 0 ? `+${inverted}` : `${inverted}`;
  return `Etc/GMT${suffix}`;
}

function parseMaxAssetsOption(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const str = String(raw).trim();
  if (!str) return undefined;
  const value = Number.parseInt(str, 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.error("--max-assets must be a positive integer.");
    process.exit(8);
  }
  return value;
}

function selectEffectiveStartDate(userStart?: Date, derivedStart?: Date) {
  if (!userStart) return derivedStart ?? undefined;
  if (!derivedStart) return userStart;
  return isAfter(userStart, derivedStart) ? userStart : derivedStart;
}

function findLatestTimestamp(items: any[]) {
  if (!Array.isArray(items)) return null;
  let latest: Date | null = null;
  for (const it of items) {
    const ts = extractTimestamp(it);
    if (ts && (!latest || isAfter(ts.date, latest))) {
      latest = ts.date;
    }
  }
  return latest;
}

function loadSyncState(statePath: string) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      return data as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return {} as Record<string, string>;
}

function saveSyncState(statePath: string, state: Record<string, string>) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {
    // ignore
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadAuthStateFile(authPath: string): {
  storageState: StorageState;
  savedHeaders?: Record<string, string>;
} {
  const raw = fs.readFileSync(authPath, "utf8");
  const parsed = JSON.parse(raw);
  const { __extraHTTPHeaders, ...rest } = parsed;
  return { storageState: rest, savedHeaders: __extraHTTPHeaders };
}

async function createApiRequestContext({
  storageState,
  savedHeaders
}: {
  storageState: StorageState;
  savedHeaders?: Record<string, string>;
}) {
  const extraHTTPHeaders = buildApiHeaders({ storageState, savedHeaders });
  const request = await pwRequest.newContext({
    storageState,
    extraHTTPHeaders,
    baseURL: "https://api2.learning-genie.com"
  });
  return { request, extraHTTPHeaders };
}

async function fetchParentEnrollments({
  request,
  headers
}: {
  request: APIRequestContext;
  headers: Record<string, string>;
}) {
  const headerUid = getHeaderValue(headers, "x-uid");
  const trimmedHeaderUid = typeof headerUid === "string" ? headerUid.trim() : undefined;
  const envUid = process.env.LG_UID?.trim();
  const parentId = trimmedHeaderUid || envUid;
  if (!parentId) {
    throw new Error("Missing X-UID for enrollment lookup. Rerun the sync with LG_USER/LG_PASS or set LG_UID env.");
  }

  const url = new URL(ENROLLMENTS_URL);
  url.searchParams.set("parent_id", parentId);
  const json = await robustGetJSON(request, url.toString());

  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  throw new Error("Unexpected enrollments response shape.");
}

function loadSyncStateDate(state: Record<string, string>, enrollmentId: string) {
  const raw = state[enrollmentId];
  if (!raw) return null;
  try {
    const parsed = parseISO(raw);
    if (!Number.isNaN(parsed?.getTime?.())) return parsed;
  } catch {
    // ignore
  }
  return null;
}

function deriveStableId(item: any) {
  const candidates = [
    item?.id,
    item?.note_id,
    item?.noteId,
    item?.child_media_id,
    item?.childMediaId,
    item?.create_at,
    item?.createAt,
    item?.createdAt,
    item?.timestamp
  ];
  for (const cand of candidates) {
    if (cand != null) return String(cand);
  }
  return JSON.stringify(item);
}

function buildNotesUrl({
  enrollmentId,
  beforeTime,
  pageSize
}: {
  enrollmentId: string;
  beforeTime: string;
  pageSize: number;
}) {
  const url = new URL(NOTES_BASE);
  if (beforeTime) {
    url.searchParams.set("before_time", beforeTime);
  }
  if (pageSize) {
    url.searchParams.set("count", String(pageSize));
  }
  url.searchParams.set("enrollment_id", String(enrollmentId));
  if (DEFAULT_NOTE_CATEGORY) {
    url.searchParams.set("note_category", DEFAULT_NOTE_CATEGORY);
  }
  url.searchParams.set("video_book", INCLUDE_VIDEO_BOOK ? "true" : "false");
  return url.toString();
}

function filterByRangeAndFindNext(items: any[], startDate?: Date, endDate?: Date) {
  if (!items?.length) return { kept: [], nextCursor: null as null | { date: Date; treatAsUTC: boolean } };

  const exclusiveEnd = endDate ? addDays(endDate, 1) : null;
  const kept: any[] = [];
  let oldest: { date: Date; treatAsUTC: boolean } | null = null;

  for (const it of items) {
    const ts = extractTimestamp(it);
    if (ts && (!oldest || isBefore(ts.date, oldest.date))) {
      oldest = { date: ts.date, treatAsUTC: ts.treatAsUTC };
    }

    if (!ts) {
      kept.push(it);
      continue;
    }

    const { date } = ts;
    if (startDate && isBefore(date, startDate)) continue;
    if (exclusiveEnd && !isBefore(date, exclusiveEnd)) continue;
    kept.push(it);
  }

  if (!oldest) return { kept, nextCursor: null };

  const nextCursorMinus = subMilliseconds(oldest.date, 1);
  if (startDate && !isAfter(nextCursorMinus, startDate)) {
    return { kept, nextCursor: null };
  }

  return { kept, nextCursor: oldest };
}

async function robustGetJSON(request: APIRequestContext, url: string, tryNum = 0): Promise<any> {
  const resp = await request.get(url);
  if (resp.status() >= 500 || resp.status() === 429) {
    if (tryNum < MAX_RETRIES) {
      const backoff = Math.min(2000 * (tryNum + 1), 8000);
      await sleep(backoff);
      return robustGetJSON(request, url, tryNum + 1);
    }
  }
  if (!resp.ok()) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${resp.status()} ${resp.statusText()} ${text?.slice(0, 200)}`);
  }
  return resp.json();
}

async function fetchNotesRange({
  request,
  enrollmentId,
  startDate,
  endDate,
  pageSize,
  maxPages,
  delayMs,
  assetLimit
}: {
  request: APIRequestContext;
  enrollmentId: string;
  startDate?: Date;
  endDate?: Date;
  pageSize: number;
  maxPages: number;
  delayMs: number;
  assetLimit?: number;
}) {
  const deduped: any[] = [];
  const seen = new Set<string>();

  const base = endDate ? new Date(endDate.getTime()) : new Date();
  const initialUpper = addDays(base, 1);
  initialUpper.setHours(0, 0, 0, 0);
  let beforeCursor = formatForApi(initialUpper);
  let pages = 0;
  let assetLimitInfo: SoftAssetLimitResult | null = null;

  while (pages < maxPages) {
    const url = buildNotesUrl({ enrollmentId, beforeTime: beforeCursor, pageSize });
    console.log(`Fetching page ${pages + 1} …`);
    console.log(`  → ${url}`);
    const json = await robustGetJSON(request, url);
    let items = json?.items ?? json?.data ?? json ?? [];
    if (!Array.isArray(items)) {
      if (items && typeof items === "object") {
        items = Object.values(items);
      }
    }
    if (!Array.isArray(items) || items.length === 0) break;

    const { kept, nextCursor } = filterByRangeAndFindNext(items, startDate, endDate);
    const pageOldestTimestamp = nextCursor?.date ?? null;

    for (const it of kept) {
      const id = deriveStableId(it);
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(it);
      }
    }

    if (typeof assetLimit === "number" && Number.isFinite(assetLimit) && assetLimit > 0) {
      assetLimitInfo = applySoftAssetLimit(deduped, assetLimit);
      if (
        assetLimitInfo.limited &&
        assetLimitInfo.cutoffTimestamp &&
        pageOldestTimestamp &&
        isBefore(pageOldestTimestamp, assetLimitInfo.cutoffTimestamp)
      ) {
        break;
      }
    }

    pages += 1;
    if (!nextCursor) break;

    let nextBefore = formatForApi(nextCursor.date, { treatAsUTC: nextCursor.treatAsUTC });
    if (nextBefore === beforeCursor) {
      const fallback = formatForApi(subMilliseconds(nextCursor.date, 1), { treatAsUTC: nextCursor.treatAsUTC });
      if (fallback === beforeCursor) break;
      nextBefore = fallback;
    }

    beforeCursor = nextBefore;

    await sleep(delayMs);
  }

  return deduped;
}

async function ensureAuthValid({
  authPath,
  username,
  password
}: {
  authPath: string;
  username?: string;
  password?: string;
}) {
  let needLogin = !fs.existsSync(authPath);
  if (!needLogin) {
    try {
      const { storageState, savedHeaders } = loadAuthStateFile(authPath);
      const { request } = await createApiRequestContext({ storageState, savedHeaders });
      try {
        const headers = buildApiHeaders({ storageState, savedHeaders }, { allowMissingUid: true });
        const enrollments = await fetchParentEnrollments({ request, headers });
        if (!Array.isArray(enrollments) || enrollments.length === 0) {
          throw new Error("No enrollments returned when validating auth.");
        }
      } finally {
        await request.dispose();
      }
    } catch (err) {
      console.warn("Auth validation failed:", (err as Error)?.message ?? err);
      needLogin = true;
    }
  }

  if (!needLogin) return;
  if (!username || !password) {
    throw new Error("LG_USER and LG_PASS must be set to create auth storage state.");
  }

  await loginAndSaveState({ username, password, authPath });
}

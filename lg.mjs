#!/usr/bin/env node
/**
 * Learning Genie Sync CLI (Playwright)
 * - sync: ensure auth → fetch new Notes → run the downloader per child
 *
 * Typical usage:
 *   LG_USER="you@example.com" LG_PASS="secret" \
 *   node ./lg.mjs sync --auth /data/auth.storage.json \
 *                      --outfile /tmp/input.json \
 *                      --outdir /data
 */

import { Command } from "commander";
import { chromium, request as pwRequest } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { addDays, addMilliseconds, isAfter, isBefore, parseISO, subMilliseconds, format } from "date-fns";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

// -------------------- constants & setup --------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_AUTH = path.join(__dirname, "auth.storage.json");
const DEFAULT_OUT  = path.join(process.cwd(), "input.json");
const DEFAULT_OUTDIR = process.env.OUTDIR ?? path.join(process.cwd(), "downloads");
const DEFAULT_STATE = process.env.STATE_PATH ?? path.join(process.cwd(), "sync-state.json");
const DOWNLOADER_SCRIPT = path.join(__dirname, "learning-genie-download.sh");

const LOGIN_URL  = "https://web.learning-genie.com/#/login";
const PARENT_URL = "https://web.learning-genie.com/v2/#/parent";
const NOTES_BASE = "https://api2.learning-genie.com/api/v1/Notes";
const ENROLLMENTS_URL = "https://api2.learning-genie.com/api/v1/Enrollments";

// polite defaults
const DEFAULT_COUNT = 50;
const DEFAULT_DELAY_MS = 350; // between API calls
const DEFAULT_NOTE_CATEGORY = "report";
const INCLUDE_VIDEO_BOOK = true;
const MAX_SYNC_PAGES = 200;
const MAX_RETRIES = 4;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0";

let lastTimezoneOffsetHours = null;

// -------------------- CLI definition --------------------

const program = new Command();
program
  .name("lg")
  .description("Learning Genie Sync CLI")
  .version("0.2.0");

// ----- sync (primary workflow) -----
program.command("sync")
  .description("Login if needed → fetch new Notes → run the downloader per child")
  .option("--auth <file>", "storageState JSON path", DEFAULT_AUTH)
  .option("--outfile <file>", "intermediate JSON for the downloader", DEFAULT_OUT)
  .option("--outdir <dir>", "final download directory", DEFAULT_OUTDIR)
  .action(async (opts) => {
    const authPath = opts.auth ?? DEFAULT_AUTH;
    const outfileBase = opts.outfile ?? DEFAULT_OUT;
    const outdirRoot = opts.outdir ?? DEFAULT_OUTDIR;

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
    let request;
    let headers;
    try {
      ({ request, extraHTTPHeaders: headers } = await createApiRequestContext({ storageState, savedHeaders }));
    } catch (err) {
      console.error(err?.message || err);
      process.exit(4);
    }

    try {
      let enrollments;
      try {
        enrollments = await fetchParentEnrollments({ request, headers });
      } catch (err) {
        console.error("Failed to load enrollments:", err?.message || err);
        process.exit(6);
      }

      if (!Array.isArray(enrollments) || enrollments.length === 0) {
        console.error("No enrollments found for this account.");
        process.exit(7);
      }

      const usedFolderNames = new Map();
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
          console.log(`🌐 [${displayName}] Using timezone ${timezone} for EXIF metadata`);
        }

        const storedISO = syncState[enrollmentId];
        let storedDate = null;
        if (storedISO) {
          try {
            const parsed = parseISO(storedISO);
            if (!Number.isNaN(parsed?.getTime?.())) storedDate = parsed;
          } catch {}
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
          delayMs: DEFAULT_DELAY_MS
        });

        const outfile = multi ? appendFileSuffix(outfileBase, `-${folderBase}`) : outfileBase;

        fs.writeFileSync(outfile, JSON.stringify({ items }, null, 2));
        console.log(`📄 [${displayName}] Wrote ${items.length} items → ${outfile}`);

        if (items.length === 0) {
          console.log(`ℹ️  [${displayName}] No media in range; skipping downloader.`);
          continue;
        }

        await fs.promises.mkdir(childOutdir, { recursive: true }).catch(() => {});
        console.log(`⬇️  [${displayName}] Running: ${DOWNLOADER_SCRIPT} "${outfile}" "${childOutdir}"`);
        try {
          const env = { ...process.env };
          if (timezone) env.LOCAL_TZ = timezone;
          const { stdout, stderr } = await execFile(DOWNLOADER_SCRIPT, [outfile, childOutdir], {
            env
          });
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          console.log(`✅ [${displayName}] Sync complete.`);

          const latest = findLatestTimestamp(items);
          if (latest) {
            syncState[enrollmentId] = latest.toISOString();
            stateUpdated = true;
          }
        } catch (err) {
          console.error(`Downloader script failed for ${displayName}:`, err?.stderr || err?.message || err);
          process.exit(5);
        }
      }

      if (stateUpdated) {
        saveSyncState(statePath, syncState);
      }
    } finally {
      await request.dispose();
    }
  });

program.parseAsync(process.argv);

// -------------------- helpers --------------------

async function loginAndSaveState({ username, password, authPath, headless = true }) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  let capturedApiHeaders = null;
  page.on("request", (req) => {
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
  const extraHeaders = buildApiHeaders({
    storageState: storage,
    savedHeaders: capturedApiHeaders
  }, { allowMissingUid: true });
  if (extraHeaders && !extraHeaders["x-uid"]) {
    console.warn("⚠️  Could not auto-detect X-UID. Set LG_UID env before fetch/sync commands if API calls fail.");
  }
  const payload = extraHeaders
    ? { ...storage, __extraHTTPHeaders: extraHeaders }
    : storage;
  fs.writeFileSync(authPath, JSON.stringify(payload, null, 2));

  console.log("💯 Login complete.");
  await browser.close();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatForApi(date, { treatAsUTC = false } = {}) {
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

function extractTimestamp(item) {
  if (!item || typeof item !== "object") return null;

  const directCandidates = [
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

function parseTimestamp(raw, { treatAsUTC = false } = {}) {
  const str = String(raw).trim();
  if (!str) return null;

  const normalized = str.replace(" ", "T");
  const attempts = new Set();

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
  } catch {}

  return null;
}

function pickRelevantApiHeaders(headers = {}) {
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
  const picked = {};
  for (const key of interesting) {
    if (headers[key]) picked[key] = headers[key];
  }
  return Object.keys(picked).length ? picked : null;
}

function buildApiHeaders({ storageState, savedHeaders }, { allowMissingUid = false } = {}) {
  const base = {
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
    base["x-lg-timezoneoffset"] = offset ?? String(-new Date().getTimezoneOffset() / 60);
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

  const cleaned = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || value === null || value === "") continue;
    cleaned[key] = String(value);
  }

  if (!cleaned["x-uid"] && !allowMissingUid) {
    throw new Error("Missing X-UID header. Re-run the sync with LG_USER/LG_PASS set or provide LG_UID env.");
  }

  return cleaned;
}

function inferLanguage(storageState) {
  const raw = extractLocalStorageValue(storageState, "NG_TRANSLATE_LANG_KEY");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {}
  if (typeof raw === "string") return raw;
  return null;
}

function inferGroupField(storageState, key) {
  const raw = extractLocalStorageValue(storageState, "group");
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && key in obj) {
      return obj[key];
    }
  } catch {}
  return null;
}

function computeTimezoneOffsetHours(timezone) {
  if (!timezone || typeof timezone !== "string") return null;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset"
    });
    const parts = dtf.formatToParts(new Date());
    const tzName = parts.find(p => p.type === "timeZoneName")?.value;
    if (!tzName) return null;
    const match = tzName.match(/GMT([+-]?\d{1,2})(?::(\d{2}))?/i);
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = match[2] ? Number(match[2]) : 0;
    const sign = Math.sign(hours || (match[1]?.startsWith("-") ? -1 : 1));
    const total = hours + sign * (minutes / 60);
    return String(total);
  } catch {
    return null;
  }
}

function extractLocalStorageValue(storageState, key) {
  if (!storageState?.origins) return null;
  for (const origin of storageState.origins) {
    if (origin.origin !== "https://web.learning-genie.com") continue;
    const entry = (origin.localStorage || []).find(item => item.name === key);
    if (entry) return entry.value;
  }
  return null;
}

function loadAuthStateFile(authPath) {
  const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const { __extraHTTPHeaders, ...storageState } = raw;
  return {
    storageState,
    savedHeaders: __extraHTTPHeaders ?? null
  };
}

async function createApiRequestContext({ storageState, savedHeaders }) {
  const extraHTTPHeaders = buildApiHeaders({ storageState, savedHeaders });
  const request = await pwRequest.newContext({ storageState, extraHTTPHeaders });
  return { request, extraHTTPHeaders };
}

function buildNotesUrl({ enrollmentId, beforeTime, pageSize }) {
  const u = new URL(NOTES_BASE);
  // Matches the example: before_time=YYYY-MM-DD HH:MM:SS.mmm, count, enrollment_id, note_category, video_book
  if (beforeTime) u.searchParams.set("before_time", beforeTime);
  if (pageSize)  u.searchParams.set("count", String(pageSize));
  u.searchParams.set("enrollment_id", enrollmentId);
  u.searchParams.set("note_category", DEFAULT_NOTE_CATEGORY);
  if (INCLUDE_VIDEO_BOOK) {
    u.searchParams.set("video_book", "true");
  }
  return u.toString();
}

function filterByRangeAndFindNext(items, startDate, endDate) {
  if (!items?.length) return { kept: [], nextCursor: null };

  const exclusiveEnd = endDate ? addDays(endDate, 1) : null;
  const kept = [];
  let oldest = null;

  for (const it of items) {
    const ts = extractTimestamp(it);
    if (ts && (!oldest || isBefore(ts.date, oldest.date))) {
      oldest = ts;
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

async function robustGetJSON(request, url, tryNum = 0) {
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
    throw new Error(`GET ${url} failed: ${resp.status()} ${resp.statusText()} ${text?.slice(0,200)}`);
  }
  return resp.json();
}

async function fetchNotesRange({
  request,
  enrollmentId,
  startDate,   // Date | undefined
  endDate,     // Date | undefined
  pageSize,
  maxPages,
  delayMs
}) {
  const all = [];

  // Start pagination from endDate+1 (or tomorrow) at 00:00 so the end day is fully included.
  const base = endDate ? new Date(endDate.getTime()) : new Date();
  const initialUpper = addDays(base, 1);
  initialUpper.setHours(0, 0, 0, 0);
  let beforeCursor = formatForApi(initialUpper);
  let pages = 0;

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
    all.push(...kept);

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

  // De-dup (APIs may overlap edges)
  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    const id = deriveStableId(it);
    if (!seen.has(id)) { seen.add(id); deduped.push(it); }
  }
  return deduped;
}

async function ensureAuthValid({ authPath, username, password }) {
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
      console.warn("Auth validation failed:", err?.message || err);
      needLogin = true;
    }
  }
  if (needLogin) {
    if (!username || !password) {
      throw new Error("Missing LG_USER/LG_PASS for auto-login.");
    }
    console.log("🔐 Logging in to refresh auth …");
    await loginAndSaveState({ username, password, authPath });
  }
}

function deriveStableId(item) {
  if (!item || typeof item !== "object") return JSON.stringify(item);

  const direct = item.id
    ?? item.id_str
    ?? item.idStr
    ?? item.noteId
    ?? item.note_id
    ?? item.local_id
    ?? item.localId
    ?? item.uid
    ?? item.guid;
  if (direct) return String(direct);

  if (Array.isArray(item.media)) {
    for (const media of item.media) {
      if (media?.id) return String(media.id);
      if (media?.mediaId) return String(media.mediaId);
      if (media?.public_url) return `media:${media.public_url}`;
    }
  }

  const ts = extractTimestamp(item)?.raw ?? "";
  const payload = item.payload ?? item.originalPayload ?? item.description ?? "";
  const mediaKey = Array.isArray(item.media)
    ? item.media.map(m => m?.public_url ?? m?.id ?? "").join("|")
    : "";
  return `${ts}::${payload}::${mediaKey}`;
}

async function fetchParentEnrollments({ request, headers }) {
  const parentId = getHeaderValue(headers, "x-uid") ?? process.env.LG_UID?.trim();
  if (!parentId) {
    throw new Error("Missing X-UID for enrollment lookup. Set LG_UID env or rerun the sync with credentials.");
  }
  const url = new URL(ENROLLMENTS_URL);
  url.searchParams.set("parent_id", parentId);
  const json = await robustGetJSON(request, url.toString());
  if (!Array.isArray(json)) {
    throw new Error("Unexpected enrollments response shape.");
  }
  return json;
}

function extractEnrollmentId(enrollment) {
  return enrollment?.id ?? enrollment?.enrollment_id ?? enrollment?.enrollmentId ?? null;
}

function resolveEnrollmentDisplayName(enrollment, fallbackId) {
  const candidates = [
    enrollment?.first_name,
    enrollment?.firstName,
    enrollment?.display_name,
    enrollment?.displayName,
    enrollment?.child?.first_name,
    enrollment?.child?.display_name
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallbackId || "child";
}

function uniqueSlug(name, used) {
  const base = slugifyName(name) || "child";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  if (count === 0) return base;
  return `${base}-${count + 1}`;
}

function slugifyName(value) {
  if (!value) return "";
  const ascii = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7F]/g, "");
  return ascii
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function appendFileSuffix(filePath, suffix) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  return path.join(dir, `${base}${suffix}${ext}`);
}

function getHeaderValue(headers, name) {
  if (!headers) return undefined;
  if (headers[name] != null) return headers[name];
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function resolveEnrollmentTimezone({ enrollment, headers }) {
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

function offsetHoursToTimezone(offsetHours) {
  if (!Number.isFinite(offsetHours)) return null;
  const inverted = -offsetHours;
  const suffix = inverted >= 0 ? `+${inverted}` : `${inverted}`;
  return `Etc/GMT${suffix}`;
}

function selectEffectiveStartDate(userStart, derivedStart) {
  if (!userStart) return derivedStart ?? undefined;
  if (!derivedStart) return userStart;
  return isAfter(userStart, derivedStart) ? userStart : derivedStart;
}

function findLatestTimestamp(items) {
  if (!Array.isArray(items)) return null;
  let latest = null;
  for (const it of items) {
    const ts = extractTimestamp(it);
    if (ts && (!latest || isAfter(ts.date, latest))) {
      latest = ts.date;
    }
  }
  return latest;
}

function loadSyncState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      return data;
    }
  } catch {}
  return {};
}

function saveSyncState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {}
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

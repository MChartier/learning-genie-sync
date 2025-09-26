#!/usr/bin/env node
/**
 * Learning Genie CLI (Playwright)
 * - login: interactive login; saves auth state (cookies/storage)
 * - fetch: fetch Notes JSON for a date range
 * - sync:  ensure auth → fetch JSON → run your bash downloader (one command)
 *
 * Typical usage:
 *   # First run (one-liner):
 *   LG_USER="you@example.com" LG_PASS="secret" \
 *   node ./lg.mjs sync --enrollment D1435731-662B-42A2-97C6-5D039BB087BC \
 *                      --start 2025-09-01 --end 2025-09-27 \
 *                      --outdir downloads \
 *                      --script ./learning-genie-download.sh
 *
 *   # Or split:
 *   LG_USER=... LG_PASS=... node ./lg.mjs login --headful
 *   node ./lg.mjs fetch --enrollment ... --start ... --end ... --out response.json
 *   ./learning-genie-download.sh response.json downloads
 */

import { Command } from "commander";
import { chromium, request as pwRequest } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { addDays, isAfter, isBefore, parseISO } from "date-fns";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

// -------------------- constants & setup --------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_AUTH = path.join(__dirname, "auth.storage.json");
const DEFAULT_OUT  = path.join(process.cwd(), "response.json");

const LOGIN_URL  = "https://web.learning-genie.com/#/login";
const PARENT_URL = "https://web.learning-genie.com/v2/#/parent";
const NOTES_BASE = "https://api2.learning-genie.com/api/v1/Notes";

// polite defaults
const DEFAULT_COUNT = 50;
const DEFAULT_DELAY_MS = 350; // between API calls
const MAX_RETRIES = 4;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0";

// -------------------- CLI definition --------------------

const program = new Command();
program
  .name("lg")
  .description("Learning Genie CLI: login + fetch Notes (and optional one-shot sync)")
  .version("0.1.1");

// ----- login -----
program.command("login")
  .description("Interactive login and save storage state")
  .option("--auth <file>", "storageState JSON path", DEFAULT_AUTH)
  .option("--headful", "show the browser window", false)
  .option("--username <email>", "username; defaults LG_USER env")
  .option("--password <pass>", "password; defaults LG_PASS env")
  .action(async (opts) => {
    const username = opts.username ?? process.env.LG_USER;
    const password = opts.password ?? process.env.LG_PASS;
    if (!username || !password) {
      console.error("LG_USER and LG_PASS env (or --username/--password) required.");
      console.error("Got: username=", username, " password=", password);
      process.exit(2);
    }
    await loginAndSaveState({ username, password, authPath: opts.auth, headless: !opts.headful });
    console.log(`Saved auth → ${opts.auth}`);
  });

// ----- fetch -----
program.command("fetch")
  .description("Fetch Notes JSON for a date range")
  .requiredOption("--enrollment <id>", "enrollment_id (GUID)")
  .option("--start <YYYY-MM-DD>", "start date (inclusive)")
  .option("--end <YYYY-MM-DD>", "end date (inclusive)")
  .option("--count <n>", "page size for Notes?count=", `${DEFAULT_COUNT}`)
  .option("--note-category <name>", "note_category filter", "report")
  .option("--video-book", "include video_book=true", true)
  .option("--auth <file>", "storageState JSON path", DEFAULT_AUTH)
  .option("--out <file>", "output JSON file", DEFAULT_OUT)
  .option("--raw-params <queryString>", "append raw query params, e.g. 'foo=bar&baz=1'")
  .option("--max-pages <n>", "safety cap on pages", "200")
  .option("--delay <ms>", "delay between page requests", `${DEFAULT_DELAY_MS}`)
  .action(async (opts) => {
    const { enrollment, start, end, count, noteCategory, videoBook, auth, out, rawParams } = normalizeFetchOptions(opts);

    if (!fs.existsSync(auth)) {
      console.error(`Auth state not found at ${auth}. Run: lg login`);
      process.exit(3);
    }
    const { storageState, savedHeaders } = loadAuthStateFile(auth);
    let request;
    try {
      request = await createApiRequestContext({ storageState, savedHeaders });
    } catch (err) {
      console.error(err?.message || err);
      process.exit(4);
    }

    try {
      const all = await fetchNotesRange({
        request,
        enrollmentId: enrollment,
        startDate: start,
        endDate: end,
        pageSize: count,
        noteCategory,
        videoBook,
        rawParams,
        maxPages: Number(opts.maxPages),
        delayMs: Number(opts.delay)
      });

      // Write a shape your jq already handles (root has "items")
      const payload = { items: all };
      fs.writeFileSync(out, JSON.stringify(payload, null, 2));
      console.log(`Wrote ${all.length} items → ${out}`);
    } finally {
      await request.dispose();
    }
  });

// ----- sync (one-shot) -----
program.command("sync")
  .description("Login if needed → fetch Notes → run your bash downloader in one go")
  .requiredOption("--enrollment <id>", "enrollment_id (GUID)")
  .option("--start <YYYY-MM-DD>", "start date (inclusive)")
  .option("--end <YYYY-MM-DD>", "end date (inclusive)")
  .option("--count <n>", "page size", `${DEFAULT_COUNT}`)
  .option("--note-category <name>", "note_category filter", "report")
  .option("--video-book", "include video_book=true", true)
  .option("--auth <file>", "storageState JSON path", DEFAULT_AUTH)
  .option("--outfile <file>", "intermediate JSON for your script", path.join(process.cwd(), "response.json"))
  .option("--outdir <dir>", "final download directory", path.join(process.cwd(), "downloads"))
  .option("--script <path>", "path to your bash script", "./learning-genie-download.sh")
  .option("--raw-params <queryString>", "extra query params")
  .option("--headful", "show browser UI for login/captcha", false)
  .action(async (opts) => {
    const username = process.env.LG_USER;
    const password = process.env.LG_PASS;
    if (!fs.existsSync(opts.auth) && (!username || !password)) {
      console.error("First run needs creds: set LG_USER and LG_PASS env (or run `lg login`).");
      process.exit(2);
    }

    // 1) Ensure we have valid auth (try a small API call; if 401 → login)
    await ensureAuthValid({
      authPath: opts.auth,
      headless: !opts.headful,
      username,
      password,
      enrollmentId: opts.enrollment
    });

    // 2) Fetch date-range JSON
    const { storageState, savedHeaders } = loadAuthStateFile(opts.auth);
    let request;
    try {
      request = await createApiRequestContext({ storageState, savedHeaders });
    } catch (err) {
      console.error(err?.message || err);
      process.exit(4);
    }
    try {
      const all = await fetchNotesRange({
        request,
        enrollmentId: opts.enrollment,
        startDate: opts.start ? parseISO(opts.start) : undefined,
        endDate:   opts.end   ? parseISO(opts.end)   : undefined,
        pageSize: Number(opts.count ?? DEFAULT_COUNT),
        noteCategory: opts.noteCategory ?? "report",
        videoBook: opts.videoBook !== false,
        rawParams: opts.rawParams ?? "",
        maxPages: 200,
        delayMs: DEFAULT_DELAY_MS
      });
      fs.writeFileSync(opts.outfile, JSON.stringify({ items: all }, null, 2));
      console.log(`📄 Wrote ${all.length} items → ${opts.outfile}`);
    } finally {
      await request.dispose();
    }

    // 3) Run your bash pipeline
    await fs.promises.mkdir(opts.outdir, { recursive: true }).catch(() => {});
    console.log(`⬇️  Running: ${opts.script} "${opts.outfile}" "${opts.outdir}"`);
    try {
      const { stdout, stderr } = await execFile(opts.script, [opts.outfile, opts.outdir], {
        env: process.env
      });
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      console.log("✅ Sync complete.");
    } catch (err) {
      console.error("Downloader script failed:", err?.stderr || err?.message || err);
      process.exit(5);
    }
  });

program.parseAsync(process.argv);

// -------------------- helpers --------------------

function normalizeFetchOptions(opts) {
  const start = opts.start ? parseISO(opts.start) : undefined;
  const end   = opts.end   ? parseISO(opts.end)   : undefined;
  if (start && end && isAfter(start, addDays(end, 1))) {
    console.error("Invalid range: start must be <= end");
    process.exit(4);
  }
  return {
    enrollment: opts.enrollment,
    start,
    end,
    count: Number(opts.count ?? DEFAULT_COUNT),
    noteCategory: opts.noteCategory ?? "report",
    videoBook: opts.videoBook !== false, // default true
    auth: opts.auth ?? DEFAULT_AUTH,
    out: opts.out ?? DEFAULT_OUT,
    rawParams: opts.rawParams ?? ""
  };
}

async function loginAndSaveState({ username, password, authPath, headless }) {
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

  console.log(`🔐 Filling login form and submitting …`);
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

  console.log(`🔐 Waiting for parent portal to load …`);
  await page.goto(PARENT_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log(`🔐 Saving auth state …`);
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

  console.log("🔐 Login complete.");
  await browser.close();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    throw new Error("Missing X-UID header. Rerun `lg login --headful` and ensure the portal loads (or set LG_UID env).");
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
  return pwRequest.newContext({ storageState, extraHTTPHeaders });
}

function buildNotesUrl({ enrollmentId, beforeISO, pageSize, noteCategory, videoBook, rawParams }) {
  const u = new URL(NOTES_BASE);
  // Matches the example: before_time=YYYY-MM-DD, count, enrollment_id, note_category, video_book
  if (beforeISO) u.searchParams.set("before_time", beforeISO);
  if (pageSize)  u.searchParams.set("count", String(pageSize));
  u.searchParams.set("enrollment_id", enrollmentId);
  if (noteCategory) u.searchParams.set("note_category", noteCategory);
  if (videoBook) u.searchParams.set("video_book", "true");

  if (rawParams) {
    const p = new URLSearchParams(rawParams);
    for (const [k, v] of p.entries()) u.searchParams.set(k, v);
  }
  return u.toString();
}

function getOldestTimestampISO(items) {
  // Find oldest timestamp in a page; tolerate multiple field names.
  const dates = [];
  for (const it of items) {
    const t = it.createAtUtc || it.createdAtUtc || it.createdAt || it.createAt || it.timestamp || it.updatedAtUtc;
    if (!t) continue;
    try {
      const d = parseISO(String(t).replace(' ', 'T'));
      if (!isNaN(d)) dates.push(d);
    } catch {}
  }
  if (!dates.length) return null;
  const oldest = dates.reduce((a, b) => (isBefore(a, b) ? a : b));
  return oldest.toISOString().slice(0, 10); // YYYY-MM-DD
}

function filterByRangeAndFindNext(items, startDate, endDate) {
  if (!items?.length) return { kept: [], nextBefore: null };

  // Keep only items within [startDate, endDate] if provided
  const kept = items.filter(it => {
    const raw = it.createAtUtc || it.createdAtUtc || it.createdAt || it.createAt || it.timestamp;
    if (!raw) return true; // keep unknowns; your jq will skip if no timestamp
    let d;
    try { d = parseISO(String(raw).replace(' ', 'T')); } catch { return false; }
    if (startDate && isBefore(d, startDate)) return false;
    if (endDate && isAfter(d, addDays(endDate, 1))) return false;
    return true;
  });

  // For next page, we want `before_time = min(oldest_in_page, endDate+1)`
  const pageOldestISO = getOldestTimestampISO(items);
  if (!pageOldestISO) return { kept, nextBefore: null };

  let nextBefore = pageOldestISO; // YYYY-MM-DD
  if (startDate) {
    const oldestDate = parseISO(pageOldestISO);
    if (isBefore(oldestDate, startDate)) {
      nextBefore = null; // we've gone past the start; stop
    }
  }
  return { kept, nextBefore };
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
  noteCategory,
  videoBook,
  rawParams,
  maxPages,
  delayMs
}) {
  const all = [];

  // Start pagination from endDate+1 (or today+1) so the end day is fully included.
  const today = new Date();
  const initialUpper = addDays(endDate ?? today, 1);
  let beforeISO = initialUpper.toISOString().slice(0, 10);
  let pages = 0;

  while (pages < maxPages) {
    const url = buildNotesUrl({ enrollmentId, beforeISO, pageSize, noteCategory, videoBook, rawParams });
    console.log(`Fetching page ${pages + 1} …`);
    console.log(`  → ${url}`);
    const json = await robustGetJSON(request, url);
    const items = json?.items ?? json?.data ?? json ?? [];
    if (!Array.isArray(items) || items.length === 0) break;

    const { kept, nextBefore } = filterByRangeAndFindNext(items, startDate, endDate);
    all.push(...kept);

    pages += 1;
    if (!nextBefore) break;
    beforeISO = nextBefore;

    await sleep(delayMs);
  }

  // De-dup (APIs may overlap edges)
  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    const id = it.id || it.noteId || JSON.stringify([it.createAtUtc, it.public_url, it.payload]);
    if (!seen.has(id)) { seen.add(id); deduped.push(it); }
  }
  return deduped;
}

async function ensureAuthValid({ authPath, headless, username, password, enrollmentId }) {
  let needLogin = !fs.existsSync(authPath);
  if (!needLogin) {
    try {
      const { storageState, savedHeaders } = loadAuthStateFile(authPath);
      const request = await createApiRequestContext({ storageState, savedHeaders });
      const testUrl = buildNotesUrl({
        enrollmentId,
        beforeISO: addDays(new Date(), 1).toISOString().slice(0,10),
        pageSize: 1,
        noteCategory: "report",
        videoBook: true,
        rawParams: ""
      });
      const r = await request.get(testUrl);
      await request.dispose();
      if (r.status() === 401 || r.status() === 403) needLogin = true;
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
    await loginAndSaveState({ username, password, authPath, headless });
  }
}

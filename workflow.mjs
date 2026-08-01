#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { readJsonFile, writeJsonAtomic } from "./lib/atomic-json.mjs";
import { markLedgerPathsUploaded } from "./lib/media-ledger.mjs";
import { MEDIA_EXTENSIONS, directorySize } from "./download-media.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GIB = 1024 ** 3;

export async function runWorkflowAttempt({
  mediaRoot = process.env.OUTDIR || "/data/staging",
  authPath = process.env.AUTH_PATH || "/data/auth.storage.json",
  statePath = process.env.STATE_PATH || "/data/sync-state.json",
  outfile = process.env.OUTFILE || "/tmp/input.json",
  syncReportPath = process.env.SYNC_REPORT_PATH || "/data/last-sync-report.json",
  commandRunner = defaultCommandRunner,
  logger = console,
  immichUrl = process.env.IMMICH_INSTANCE_URL,
  immichApiKey = process.env.IMMICH_API_KEY,
  immichCli = process.env.IMMICH_CLI_PATH || path.join(__dirname, "node_modules", ".bin", "immich"),
  syncArgs = splitShellWords(process.env.SYNC_ARGS || ""),
  deleteAfterUpload = booleanSetting("DELETE_AFTER_UPLOAD", true),
  autoCreateAlbum = booleanSetting("IMMICH_AUTO_CREATE_ALBUM", false)
} = {}) {
  fs.mkdirSync(mediaRoot, { recursive: true });
  const beforeSync = summarizeMedia(mediaRoot);
  logger.log(`[workflow] stage=download existing=${beforeSync.count} existing_bytes=${beforeSync.bytes}`);
  try { fs.unlinkSync(syncReportPath); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await commandRunner(process.execPath, [
    path.join(__dirname, "lg.mjs"), "sync",
    "--auth", authPath,
    "--state", statePath,
    "--outfile", outfile,
    "--outdir", mediaRoot,
    "--report", syncReportPath,
    ...syncArgs
  ], { env: process.env, logger });

  const syncReport = readJsonFile(syncReportPath, emptySyncReport());
  const staged = summarizeMedia(mediaRoot);
  verifyStaging(staged);
  logger.log(
    `[workflow] stage=verify files=${staged.count} bytes=${staged.bytes} `
    + `downloaded=${syncReport.downloaded || 0} downloaded_bytes=${syncReport.downloadedBytes || 0} `
    + `download_failures=${syncReport.failed || 0}`
  );

  if (!immichUrl && !immichApiKey) {
    logger.log("[workflow] Immich is not configured; leaving verified media in staging");
    return workflowResult({ syncReport, staged, uploaded: 0, uploadedBytes: 0, deleted: 0, deletedBytes: 0 });
  }
  if (!immichUrl || !immichApiKey) {
    throw new Error("IMMICH_INSTANCE_URL and IMMICH_API_KEY must both be set");
  }
  if (staged.count === 0) {
    logger.log("[workflow] stage=upload no staged media");
    return workflowResult({ syncReport, staged, uploaded: 0, uploadedBytes: 0, deleted: 0, deletedBytes: 0 });
  }

  logger.log(`[workflow] stage=upload files=${staged.count} bytes=${staged.bytes}`);
  const uploadArguments = ["upload", "--recursive", "--no-progress"];
  if (autoCreateAlbum) uploadArguments.push("--album");
  if (deleteAfterUpload) uploadArguments.push("--delete", "--delete-duplicates");
  uploadArguments.push(mediaRoot);

  await commandRunner(immichCli, uploadArguments, {
    env: { ...process.env, IMMICH_INSTANCE_URL: immichUrl, IMMICH_API_KEY: immichApiKey },
    logger
  });

  const deletedPaths = new Set(staged.files.filter(file => !fs.existsSync(file.path)).map(file => file.path));
  let deletedBytes = staged.files
    .filter(file => deletedPaths.has(file.path))
    .reduce((sum, file) => sum + file.bytes, 0);

  if (deleteAfterUpload) {
    const remaining = staged.files.filter(file => fs.existsSync(file.path));
    if (remaining.length > 0) {
      throw new Error(`Immich returned success but ${remaining.length} staged media file(s) were not deleted`);
    }
    for (const file of staged.files) {
      const sidecar = file.path.slice(0, -path.extname(file.path).length) + ".xmp";
      try {
        const bytes = fs.statSync(sidecar).size;
        fs.unlinkSync(sidecar);
        deletedBytes += bytes;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    markLedgerPathsUploaded(mediaRoot, deletedPaths);
  }

  const afterUpload = summarizeMedia(mediaRoot);
  logger.log(
    `[workflow] stage=complete uploaded=${staged.count} uploaded_bytes=${staged.bytes} `
    + `deleted=${deletedPaths.size} deleted_bytes=${deletedBytes} remaining=${afterUpload.count}`
  );
  return workflowResult({
    syncReport,
    staged: afterUpload,
    uploaded: staged.count,
    uploadedBytes: staged.bytes,
    deleted: deletedPaths.size,
    deletedBytes
  });
}

export async function runWorkflowWithRetries({
  attempt = runWorkflowAttempt,
  maxRetries = numberSetting("WORKFLOW_MAX_RETRIES", 3),
  retryBaseMs = numberSetting("WORKFLOW_RETRY_BASE_MS", 5000),
  retryMaxMs = numberSetting("WORKFLOW_RETRY_MAX_MS", 60000),
  sleep = delay,
  logger = console,
  statePath = process.env.WORKFLOW_STATE_PATH || "/data/workflow-state.json",
  mediaRoot = process.env.OUTDIR || "/data/staging",
  alert = sendAlert,
  now = () => new Date()
} = {}) {
  const state = loadWorkflowState(statePath);
  await runPreflightAlerts({ state, mediaRoot, alert, now, logger });

  let lastError;
  for (let index = 0; index < maxRetries; index += 1) {
    try {
      const result = await attempt();
      const degraded = Number(result.download?.failed || 0) > 0;
      const timestamp = now().toISOString();
      state.lastRunAt = timestamp;
      state.lastStatus = degraded ? "degraded" : "success";
      state.lastSummary = result;
      state.lastError = null;
      if (degraded) {
        state.consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
        const repeated = state.consecutiveFailures >= numberSetting("ALERT_FAILURE_THRESHOLD", 3);
        await alert(
          repeated
            ? "Learning Genie sync repeatedly has media failures"
            : "Learning Genie sync completed with media failures",
          `${result.download.failed} media item(s) remain queued for retry; `
            + `consecutive degraded/failed runs: ${state.consecutiveFailures}.`,
          { priority: repeated ? "urgent" : "high" }
        );
      } else {
        state.consecutiveFailures = 0;
        state.lastSuccessfulRunAt = timestamp;
      }
      writeJsonAtomic(statePath, state);
      return result;
    } catch (error) {
      lastError = error;
      if (index + 1 < maxRetries) {
        const waitMs = Math.min(retryBaseMs * 2 ** index, retryMaxMs);
        logger.error(`[workflow] attempt=${index + 1}/${maxRetries} failed; retrying in ${waitMs}ms: ${error?.message || error}`);
        await sleep(waitMs);
      }
    }
  }

  const timestamp = now().toISOString();
  state.lastRunAt = timestamp;
  state.lastStatus = "failed";
  state.lastError = lastError?.message || String(lastError);
  state.consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
  writeJsonAtomic(statePath, state);
  if (state.consecutiveFailures >= numberSetting("ALERT_FAILURE_THRESHOLD", 3)) {
    await alert(
      "Learning Genie sync repeatedly failing",
      `${state.consecutiveFailures} consecutive runs failed. Latest error: ${state.lastError}`,
      { priority: "urgent" }
    );
  }
  throw lastError;
}

export function summarizeMedia(root) {
  const files = [];
  if (!fs.existsSync(root)) return { count: 0, bytes: 0, zeroByte: [], incomplete: [], files };
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".lg-sync-tmp") stack.push(fullPath);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !MEDIA_EXTENSIONS.has(extension)) continue;
      const bytes = fs.statSync(fullPath).size;
      files.push({ path: fullPath, bytes });
    }
  }
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    zeroByte: files.filter(file => file.bytes === 0).map(file => file.path),
    incomplete: files.filter(file => fs.existsSync(`${file.path}.aria2`)).map(file => file.path),
    files
  };
}

export function verifyStaging(summary) {
  if (summary.zeroByte.length > 0) {
    throw new Error(`Staging verification found ${summary.zeroByte.length} zero-byte media file(s)`);
  }
  if (summary.incomplete.length > 0) {
    throw new Error(`Staging verification found ${summary.incomplete.length} media file(s) with aria2 control files`);
  }
}

export function loadWorkflowState(statePath) {
  const state = readJsonFile(statePath, { version: 1, consecutiveFailures: 0 });
  state.version = 1;
  state.consecutiveFailures ||= 0;
  return state;
}

export async function sendAlert(title, body, { priority = "default" } = {}) {
  const directUrl = process.env.ALERT_WEBHOOK_URL;
  const ntfyBase = process.env.NTFY_URL;
  const ntfyTopic = process.env.NTFY_TOPIC;
  const target = directUrl || (ntfyBase && ntfyTopic
    ? `${ntfyBase.replace(/\/$/, "")}/${encodeURIComponent(ntfyTopic)}`
    : null);
  if (!target) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { Title: title, Priority: priority },
      body,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    console.error(`[alert] failed to send notification: ${error?.message || error}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function runPreflightAlerts({ state, mediaRoot, alert, now, logger }) {
  const staleAfterHours = numberSetting("STALE_AFTER_HOURS", 48);
  if (state.lastSuccessfulRunAt && staleAfterHours > 0) {
    const ageMs = now().getTime() - Date.parse(state.lastSuccessfulRunAt);
    if (ageMs > staleAfterHours * 60 * 60 * 1000) {
      logger.warn(`[workflow] last successful run is ${Math.floor(ageMs / 3_600_000)} hours old`);
      await alert(
        "Learning Genie sync is stale",
        `Last fully successful run: ${state.lastSuccessfulRunAt}`,
        { priority: "high" }
      );
    }
  }

  const stagingBytes = directorySize(mediaRoot);
  const alertBytes = numberSetting("STAGING_ALERT_BYTES", 10 * GIB);
  if (alertBytes > 0 && stagingBytes >= alertBytes) {
    logger.warn(`[workflow] staging directory is unexpectedly large: ${stagingBytes} bytes`);
    await alert(
      "Learning Genie staging directory is large",
      `Staging contains ${stagingBytes} bytes; configured alert threshold is ${alertBytes} bytes.`,
      { priority: "high" }
    );
  }
}

function workflowResult({ syncReport, staged, uploaded, uploadedBytes, deleted, deletedBytes }) {
  return {
    download: syncReport,
    uploaded,
    uploadedBytes,
    deleted,
    deletedBytes,
    remaining: staged.count,
    remainingBytes: staged.bytes
  };
}

function emptySyncReport() {
  return { downloaded: 0, downloadedBytes: 0, skipped: 0, skippedBytes: 0, failed: 0, warnings: 0 };
}

function splitShellWords(value) {
  if (!value.trim()) return [];
  const words = [];
  let current = "";
  let quote = null;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) { words.push(current); current = ""; }
    } else current += character;
  }
  if (quote) throw new Error("Unterminated quote in SYNC_ARGS");
  if (current) words.push(current);
  return words;
}

function booleanSetting(name, fallback) {
  if (process.env[name] == null) return fallback;
  return !["0", "false", "no", "off"].includes(process.env[name].toLowerCase());
}

function numberSetting(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultCommandRunner(command, args, { env = process.env, logger = console } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    child.stdout.on("data", chunk => {
      process.stdout.write(chunk);
    });
    child.stderr.on("data", chunk => {
      process.stderr.write(chunk);
      stderrTail = `${stderrTail}${chunk}`.slice(-32_768);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ code });
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderrTail.trim()}`));
    });
    logger.log(`[workflow] exec=${path.basename(command)} args=${args.slice(0, -1).join(" ")}`);
  });
}

async function main() {
  try {
    await runWorkflowWithRetries();
  } catch (error) {
    console.error(`[workflow] failed after bounded retries: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

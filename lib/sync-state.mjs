import { readJsonFile, writeJsonAtomic } from "./atomic-json.mjs";

export const SYNC_STATE_VERSION = 2;

export function loadSyncStateFile(statePath) {
  const raw = readJsonFile(statePath, {});
  if (raw?.version === SYNC_STATE_VERSION && raw.enrollments) return raw;

  const enrollments = {};
  for (const [enrollmentId, value] of Object.entries(raw || {})) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) continue;
    enrollments[enrollmentId] = {
      fetchedThrough: value,
      completedThrough: value,
      migratedAt: new Date().toISOString()
    };
  }
  return { version: SYNC_STATE_VERSION, enrollments };
}

export function saveSyncStateFile(statePath, state) {
  writeJsonAtomic(statePath, {
    version: SYNC_STATE_VERSION,
    enrollments: state.enrollments || {},
    updatedAt: new Date().toISOString()
  });
}

export function getEnrollmentFetchWatermark(state, enrollmentId) {
  const entry = state?.enrollments?.[enrollmentId];
  return entry?.fetchedThrough ?? entry?.completedThrough ?? null;
}

export function recordEnrollmentResult(
  state,
  enrollmentId,
  { latestTimestamp, ledgerDurable, failedCount = 0, attemptedAt = new Date().toISOString() }
) {
  state.version = SYNC_STATE_VERSION;
  state.enrollments ||= {};
  const previous = state.enrollments[enrollmentId] || {};
  const next = { ...previous, lastAttemptAt: attemptedAt };

  if (!ledgerDurable || !latestTimestamp) {
    next.lastAttemptStatus = "failed";
    state.enrollments[enrollmentId] = next;
    return false;
  }

  const latestISO = latestTimestamp instanceof Date
    ? latestTimestamp.toISOString()
    : new Date(latestTimestamp).toISOString();
  next.fetchedThrough = laterTimestamp(previous.fetchedThrough, latestISO);
  next.lastAttemptStatus = failedCount > 0 ? "partial" : "complete";
  next.pendingFailures = failedCount;

  // This success watermark is deliberately stricter than the fetch cursor. The
  // fetch cursor may move once every media descriptor is durably in the ledger;
  // completion only moves when every file in the batch is durable.
  if (failedCount === 0) {
    next.completedThrough = laterTimestamp(previous.completedThrough, latestISO);
    next.lastSuccessfulAt = attemptedAt;
  }

  state.enrollments[enrollmentId] = next;
  return true;
}

function laterTimestamp(current, candidate) {
  if (!current || Number.isNaN(Date.parse(current))) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

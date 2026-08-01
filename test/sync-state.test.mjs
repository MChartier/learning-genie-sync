import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadSyncStateFile,
  recordEnrollmentResult,
  saveSyncStateFile
} from "../lib/sync-state.mjs";

test("completion state advances only after durable per-media success", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-state-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "sync-state.json");
  const state = { version: 2, enrollments: {} };
  const timestamp = new Date("2026-07-20T18:30:00.000Z");

  recordEnrollmentResult(state, "child", {
    latestTimestamp: timestamp,
    ledgerDurable: false,
    failedCount: 1
  });
  assert.equal(state.enrollments.child.fetchedThrough, undefined);
  assert.equal(state.enrollments.child.completedThrough, undefined);

  recordEnrollmentResult(state, "child", {
    latestTimestamp: timestamp,
    ledgerDurable: true,
    failedCount: 1
  });
  assert.equal(state.enrollments.child.fetchedThrough, timestamp.toISOString());
  assert.equal(state.enrollments.child.completedThrough, undefined);

  recordEnrollmentResult(state, "child", {
    latestTimestamp: timestamp,
    ledgerDurable: true,
    failedCount: 0
  });
  assert.equal(state.enrollments.child.completedThrough, timestamp.toISOString());

  saveSyncStateFile(statePath, state);
  assert.equal(loadSyncStateFile(statePath).enrollments.child.completedThrough, timestamp.toISOString());
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith(".tmp")), []);
});

test("legacy timestamp-only state migrates without replaying history", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-state-migration-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "sync-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ child: "2026-06-16T00:00:00.000Z" }));

  const state = loadSyncStateFile(statePath);
  assert.equal(state.enrollments.child.fetchedThrough, "2026-06-16T00:00:00.000Z");
  assert.equal(state.enrollments.child.completedThrough, "2026-06-16T00:00:00.000Z");
});

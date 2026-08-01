import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWorkflowAttempt, runWorkflowWithRetries } from "../workflow.mjs";
import { loadMediaLedger, saveMediaLedger } from "../lib/media-ledger.mjs";

test("a failed Immich upload leaves all staged files in place", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-workflow-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, "staging");
  const mediaPath = path.join(mediaRoot, "child", "photo.jpg");
  const syncReportPath = path.join(root, "sync-report.json");
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, "media");

  await assert.rejects(() => runWorkflowAttempt({
    mediaRoot,
    authPath: path.join(root, "auth.json"),
    statePath: path.join(root, "state.json"),
    outfile: path.join(root, "input.json"),
    syncReportPath,
    immichUrl: "https://immich.example/api",
    immichApiKey: "test-key",
    immichCli: "immich-test",
    commandRunner: async command => {
      if (command === process.execPath) {
        fs.writeFileSync(syncReportPath, JSON.stringify({ failed: 0, downloaded: 0, downloadedBytes: 0 }));
        return { code: 0 };
      }
      throw new Error("Immich DNS failure");
    }
  }), /Immich DNS failure/);

  assert.equal(fs.readFileSync(mediaPath, "utf8"), "media");
});

test("a successful Immich upload deletes the staged file and durably marks its ledger entry", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-workflow-success-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, "staging");
  const childRoot = path.join(mediaRoot, "child");
  const mediaPath = path.join(childRoot, "photo.jpg");
  const ledgerPath = path.join(childRoot, ".learning-genie-ledger.json");
  const syncReportPath = path.join(root, "sync-report.json");
  fs.mkdirSync(childRoot, { recursive: true });
  fs.writeFileSync(mediaPath, "media");
  saveMediaLedger(ledgerPath, {
    version: 1,
    media: {
      "id:media-1": { key: "id:media-1", relativePath: "photo.jpg", status: "complete" }
    }
  });

  const result = await runWorkflowAttempt({
    mediaRoot,
    authPath: path.join(root, "auth.json"),
    statePath: path.join(root, "state.json"),
    outfile: path.join(root, "input.json"),
    syncReportPath,
    immichUrl: "https://immich.example/api",
    immichApiKey: "test-key",
    immichCli: "immich-test",
    commandRunner: async (command, args) => {
      if (command === process.execPath) {
        fs.writeFileSync(syncReportPath, JSON.stringify({ failed: 0, downloaded: 0, downloadedBytes: 0 }));
        return { code: 0 };
      }
      assert.ok(args.includes("--delete"));
      assert.ok(args.includes("--delete-duplicates"));
      fs.unlinkSync(mediaPath);
      return { code: 0 };
    }
  });

  assert.equal(result.uploaded, 1);
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(mediaPath), false);
  assert.equal(loadMediaLedger(ledgerPath).media["id:media-1"].status, "uploaded");
});

test("a newly unavailable empty item alerts once without blocking valid staged media", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-workflow-unavailable-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, "staging");
  const mediaPath = path.join(mediaRoot, "child", "valid.jpg");
  const zeroPath = path.join(mediaRoot, "child", "empty.mp4");
  const syncReportPath = path.join(root, "sync-report.json");
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, "valid media");
  fs.writeFileSync(zeroPath, "");
  const alerts = [];
  let immichInvocations = 0;

  const result = await runWorkflowAttempt({
    mediaRoot,
    authPath: path.join(root, "auth.json"),
    statePath: path.join(root, "state.json"),
    outfile: path.join(root, "input.json"),
    syncReportPath,
    immichUrl: "https://immich.example/api",
    immichApiKey: "test-key",
    immichCli: "immich-test",
    alert: async (title, body, options) => { alerts.push({ title, body, options }); return true; },
    commandRunner: async command => {
      if (command === process.execPath) {
        fs.unlinkSync(zeroPath);
        fs.writeFileSync(syncReportPath, JSON.stringify({
          failed: 0,
          downloaded: 1,
          downloadedBytes: 11,
          unavailable: 1,
          unavailableItems: [{
            mediaId: "d4b27c89-433b-42d2-81d4-d1aebef5de3e",
            path: "empty.mp4",
            error: "confirmed zero-length remote object HTTP 200 (video/mp4)"
          }]
        }));
        return { code: 0 };
      }
      immichInvocations += 1;
      fs.unlinkSync(mediaPath);
      return { code: 0 };
    }
  });

  assert.equal(result.download.failed, 0);
  assert.equal(result.download.unavailable, 1);
  assert.equal(result.uploaded, 1);
  assert.equal(result.deleted, 1);
  assert.equal(immichInvocations, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /permanently unavailable/);
  assert.match(alerts[0].body, /d4b27c89-433b-42d2-81d4-d1aebef5de3e/);
  assert.match(alerts[0].body, /empty\.mp4/);
  assert.equal(fs.existsSync(mediaPath), false);
  assert.equal(fs.existsSync(zeroPath), false);
});

test("workflow retries are exponential and bounded", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-retry-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const waits = [];
  let attempts = 0;

  await assert.rejects(() => runWorkflowWithRetries({
    attempt: async () => { attempts += 1; throw new Error("offline"); },
    maxRetries: 3,
    retryBaseMs: 10,
    retryMaxMs: 100,
    sleep: async milliseconds => { waits.push(milliseconds); },
    statePath: path.join(root, "workflow-state.json"),
    mediaRoot: root,
    alert: async () => true
  }), /offline/);

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
});

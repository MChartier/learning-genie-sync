import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDownloadBatch } from "../download-media.mjs";
import { loadMediaLedger, saveMediaLedger, sha256 } from "../lib/media-ledger.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-download-test-"));
  const outdir = path.join(root, "child");
  const inputPath = path.join(root, "input.json");
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify({
    items: [{
      id: "note-1",
      type: "Activity",
      payload: "A caption",
      createdAtUtc: "2026-07-20T18:30:00.000Z",
      media: [{ id: "media-1", public_url: "https://media.example/photo.jpg" }]
    }]
  }));
  return { root, outdir, inputPath };
}

function noLimits() {
  return {
    maxStagingBytes: 0,
    minFreeBytes: 0,
    unknownDownloadReserveBytes: 1,
    contentLengthResolver: async () => 4,
    sleep: async () => {}
  };
}

function ariaOutput(args) {
  const directory = args.find(argument => argument.startsWith("--dir=")).slice("--dir=".length);
  const filename = args.find(argument => argument.startsWith("--out=")).slice("--out=".length);
  return path.join(directory, filename);
}

test("an existing complete destination is adopted without invoking aria2 or ExifTool", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(paths.outdir, "photo.jpg"), "already complete");
  const invoked = [];

  const report = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    commandRunner: async command => { invoked.push(command); return { stdout: "", stderr: "" }; }
  });

  assert.equal(report.downloaded, 0);
  assert.equal(report.skipped, 1);
  assert.deepEqual(invoked, []);
  assert.equal(fs.readFileSync(path.join(paths.outdir, "photo.jpg"), "utf8"), "already complete");
  assert.equal(fs.existsSync(path.join(paths.outdir, "photo.1.jpg")), false);
});

test("a known ExifTool encoding warning is recorded as a warning and committed", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));

  const report = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    commandRunner: async (command, args) => {
      if (command === "aria2c") {
        assert.ok(args.includes("--auto-file-renaming=false"));
        fs.writeFileSync(ariaOutput(args), "data");
        return { stdout: "", stderr: "" };
      }
      const error = new Error("ExifTool warning exit");
      error.stderr = "Warning: Malformed UTF-8 character in EXIF description";
      throw error;
    }
  });

  assert.equal(report.downloaded, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.warnings, 1);
  assert.equal(fs.readFileSync(path.join(paths.outdir, "photo.jpg"), "utf8"), "data");
  const ledger = loadMediaLedger(path.join(paths.outdir, ".learning-genie-ledger.json"));
  assert.equal(ledger.media["id:media-1"].status, "complete");
});

test("an interrupted aria2 download resumes from the deterministic temp path without duplicate names", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  let ariaAttempts = 0;
  const commandRunner = async (command, args) => {
    if (command === "exiftool") return { stdout: "", stderr: "" };
    ariaAttempts += 1;
    const temporaryPath = ariaOutput(args);
    if (ariaAttempts === 1) {
      fs.writeFileSync(temporaryPath, "pa");
      fs.writeFileSync(`${temporaryPath}.aria2`, "control");
      throw new Error("connection reset");
    }
    assert.equal(fs.existsSync(`${temporaryPath}.aria2`), true);
    fs.writeFileSync(temporaryPath, "complete");
    fs.unlinkSync(`${temporaryPath}.aria2`);
    return { stdout: "", stderr: "" };
  };

  const first = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    retriesPerRun: 1,
    commandRunner
  });
  assert.equal(first.failed, 1);
  assert.equal(fs.existsSync(path.join(paths.outdir, "photo.jpg")), false);

  const second = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    retriesPerRun: 1,
    commandRunner
  });
  assert.equal(second.downloaded, 1);
  assert.equal(second.failed, 0);
  assert.equal(fs.readFileSync(path.join(paths.outdir, "photo.jpg"), "utf8"), "complete");
  assert.deepEqual(fs.readdirSync(paths.outdir).filter(name => /^photo\.\d+\.jpg$/.test(name)), []);
});

test("a genuine per-file metadata failure stays in the ledger without aborting the batch", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));

  const report = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    retriesPerRun: 1,
    commandRunner: async (command, args) => {
      if (command === "aria2c") {
        fs.writeFileSync(ariaOutput(args), "data");
        return { stdout: "", stderr: "" };
      }
      const error = new Error("bad metadata");
      error.stderr = "Error: File format error";
      throw error;
    }
  });

  assert.equal(report.failed, 1);
  assert.equal(fs.existsSync(path.join(paths.outdir, "photo.jpg")), false);
  const ledger = loadMediaLedger(path.join(paths.outdir, ".learning-genie-ledger.json"));
  assert.equal(ledger.media["id:media-1"].status, "failed");
});

test("the staging ceiling blocks aria2 before disk capacity is consumed", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  let invoked = false;

  const report = await runDownloadBatch({
    ...paths,
    minFreeBytes: 0,
    maxStagingBytes: 3,
    unknownDownloadReserveBytes: 4,
    contentLengthResolver: async () => 4,
    commandRunner: async () => { invoked = true; return { stdout: "", stderr: "" }; }
  });

  assert.equal(report.blocked, 1);
  assert.equal(report.failed, 1);
  assert.equal(invoked, false);
  assert.equal(fs.existsSync(path.join(paths.outdir, "photo.jpg")), false);
});

test("mixed valid and confirmed-empty media commits the valid file and terminalizes the empty source once", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  fs.writeFileSync(paths.inputPath, JSON.stringify({
    items: [{
      id: "note-1",
      type: "Activity",
      payload: "Mixed media",
      createdAtUtc: "2026-07-20T18:30:00.000Z",
      media: [
        {
          id: "d4b27c89-433b-42d2-81d4-d1aebef5de3e",
          public_url: "https://media.example/2c0e7d23-565b-4eab-a6ab-c4d7c2624b21.mp4"
        },
        { id: "media-valid", public_url: "https://media.example/photo.jpg" }
      ]
    }]
  }));

  const emptyDestination = path.join(paths.outdir, "2c0e7d23-565b-4eab-a6ab-c4d7c2624b21.mp4");
  const emptyKey = "id:d4b27c89-433b-42d2-81d4-d1aebef5de3e";
  const tempDirectory = path.join(paths.outdir, ".lg-sync-tmp");
  const emptyTemporary = path.join(tempDirectory, `${sha256(emptyKey).slice(0, 24)}.part.mp4`);
  fs.mkdirSync(tempDirectory, { recursive: true });
  fs.writeFileSync(emptyDestination, "");
  fs.writeFileSync(`${emptyDestination}.aria2`, "control");
  fs.writeFileSync(emptyTemporary, "partial");
  fs.writeFileSync(`${emptyTemporary}.aria2`, "control");
  const warnings = [];

  const first = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    contentLengthResolver: async url => url.endsWith(".mp4")
      ? { confirmed: true, bytes: 0, status: 200, contentType: "video/mp4" }
      : { confirmed: true, bytes: 4, status: 200, contentType: "image/jpeg" },
    logger: { log() {}, error() {}, warn(message) { warnings.push(message); } },
    commandRunner: async (command, args) => {
      if (command === "aria2c") fs.writeFileSync(ariaOutput(args), "valid");
      return { stdout: "", stderr: "" };
    }
  });

  assert.equal(first.downloaded, 1);
  assert.equal(first.unavailable, 1);
  assert.equal(first.terminalUnavailable, 1);
  assert.equal(first.failed, 0);
  assert.equal(first.unavailableItems[0].mediaId, "d4b27c89-433b-42d2-81d4-d1aebef5de3e");
  assert.equal(fs.readFileSync(path.join(paths.outdir, "photo.jpg"), "utf8"), "valid");
  assert.equal(fs.existsSync(emptyDestination), false);
  assert.equal(fs.existsSync(`${emptyDestination}.aria2`), false);
  assert.equal(fs.existsSync(emptyTemporary), false);
  assert.equal(fs.existsSync(`${emptyTemporary}.aria2`), false);
  assert.equal(warnings.filter(message => message.includes("media unavailable")).length, 1);

  const ledgerPath = path.join(paths.outdir, ".learning-genie-ledger.json");
  const firstLedger = loadMediaLedger(ledgerPath);
  const unavailableAt = firstLedger.media[emptyKey].unavailableAt;
  assert.equal(firstLedger.version, 2);
  assert.equal(firstLedger.media[emptyKey].status, "unavailable");
  assert.match(firstLedger.media[emptyKey].terminalReason, /confirmed zero-length remote object/);
  assert.ok(firstLedger.media[emptyKey].warningEmittedAt);
  assert.ok(firstLedger.media[emptyKey].cleanedArtifacts.length >= 4);

  fs.writeFileSync(emptyDestination, "");
  fs.writeFileSync(`${emptyDestination}.aria2`, "stale control");
  fs.writeFileSync(emptyTemporary, "stale partial");
  fs.writeFileSync(`${emptyTemporary}.aria2`, "stale control");
  const secondWarnings = [];
  const second = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    contentLengthResolver: async () => { throw new Error("terminal entry must not be probed"); },
    logger: { log() {}, error() {}, warn(message) { secondWarnings.push(message); } },
    commandRunner: async () => { throw new Error("terminal entry must not be retried"); }
  });

  assert.equal(second.unavailable, 0);
  assert.equal(second.terminalUnavailable, 1);
  assert.equal(second.failed, 0);
  assert.equal(second.skipped, 1);
  assert.deepEqual(secondWarnings, []);
  assert.equal(fs.existsSync(emptyDestination), false);
  assert.equal(fs.existsSync(`${emptyDestination}.aria2`), false);
  assert.equal(fs.existsSync(emptyTemporary), false);
  assert.equal(fs.existsSync(`${emptyTemporary}.aria2`), false);
  assert.equal(loadMediaLedger(ledgerPath).media[emptyKey].unavailableAt, unavailableAt);
});

test("an exhausted legacy failure migrates to unavailable only after a confirmed empty probe", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const ledgerPath = path.join(paths.outdir, ".learning-genie-ledger.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({
    version: 1,
    media: {
      "id:media-1": {
        key: "id:media-1",
        mediaId: "media-1",
        url: "https://media.example/photo.jpg",
        relativePath: "photo.jpg",
        status: "failed",
        attempts: 10,
        lastError: "aria2 did not produce a complete non-empty file"
      }
    }
  }));
  fs.writeFileSync(path.join(paths.outdir, "photo.jpg"), "");

  const report = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    maxAttempts: 10,
    contentLengthResolver: async () => ({ confirmed: true, bytes: 0, status: 200 }),
    logger: { log() {}, error() {}, warn() {} },
    commandRunner: async () => { throw new Error("exhausted empty item must not invoke aria2"); }
  });

  assert.equal(report.failed, 0);
  assert.equal(report.exhausted, 0);
  assert.equal(report.unavailable, 1);
  const migrated = loadMediaLedger(ledgerPath).media["id:media-1"];
  assert.equal(migrated.status, "unavailable");
  assert.equal(migrated.attempts, 10);
  assert.ok(migrated.unavailableAt);
  assert.equal(fs.existsSync(path.join(paths.outdir, "photo.jpg")), false);
});

test("an inconclusive remote probe remains a retryable transient failure", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  let ariaAttempts = 0;
  const commandRunner = async (command, args) => {
    if (command === "exiftool") return { stdout: "", stderr: "" };
    ariaAttempts += 1;
    if (ariaAttempts === 1) throw new Error("temporary DNS failure");
    fs.writeFileSync(ariaOutput(args), "recovered");
    return { stdout: "", stderr: "" };
  };

  const first = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    retriesPerRun: 1,
    contentLengthResolver: async () => { throw new Error("HEAD timeout"); },
    commandRunner
  });
  assert.equal(first.failed, 1);
  assert.equal(first.unavailable, 0);
  assert.equal(loadMediaLedger(path.join(paths.outdir, ".learning-genie-ledger.json")).media["id:media-1"].status, "failed");

  const second = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    retriesPerRun: 1,
    commandRunner
  });
  assert.equal(second.downloaded, 1);
  assert.equal(second.failed, 0);
  assert.equal(second.unavailable, 0);
  assert.equal(fs.readFileSync(path.join(paths.outdir, "photo.jpg"), "utf8"), "recovered");
});

test("an exhausted failure with an inconclusive probe remains failed rather than being silently terminalized", async t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const ledgerPath = path.join(paths.outdir, ".learning-genie-ledger.json");
  saveMediaLedger(ledgerPath, {
    version: 1,
    media: {
      "id:media-1": {
        key: "id:media-1",
        mediaId: "media-1",
        url: "https://media.example/photo.jpg",
        relativePath: "photo.jpg",
        status: "failed",
        attempts: 10
      }
    }
  });

  const report = await runDownloadBatch({
    ...paths,
    ...noLimits(),
    maxAttempts: 10,
    contentLengthResolver: async () => { throw new Error("HEAD timeout"); },
    commandRunner: async () => { throw new Error("exhausted item must not invoke aria2"); }
  });

  assert.equal(report.failed, 1);
  assert.equal(report.exhausted, 1);
  assert.equal(report.unavailable, 0);
  assert.equal(loadMediaLedger(ledgerPath).media["id:media-1"].status, "failed");
});

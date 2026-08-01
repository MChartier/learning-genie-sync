import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDownloadBatch } from "../download-media.mjs";
import { loadMediaLedger } from "../lib/media-ledger.mjs";

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

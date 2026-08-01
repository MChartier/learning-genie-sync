# Learning Genie Sync

Learning Genie Sync downloads family photos and videos, writes capture metadata,
and can import the verified files into Immich. Scheduled containers run one
locked workflow:

```text
download -> verify -> Immich upload -> delete successfully imported files
```

The downloader is designed to be safe to repeat. aria2 writes to deterministic
temporary paths with automatic renaming disabled, ExifTool runs before the
final file is atomically renamed, and a durable per-media ledger prevents a
retry from creating numbered copies.

## Reliability model

- Existing non-empty destination files are adopted instead of downloaded again.
- Interrupted aria2 downloads stay under `.lg-sync-tmp/` and resume on the next attempt.
- A file is marked complete only after metadata is written, the file is synced,
  and it is atomically renamed to its final path.
- Known ExifTool character-encoding warnings are logged without failing the file.
  Genuine metadata failures remain in the ledger for a later retry and do not
  terminate the container.
- Every media ID (or URL hash when no ID exists) has its own durable ledger entry.
  The fetch cursor can advance once the retry queue is durable; the stricter
  completion watermark advances only when every item in that batch succeeds.
- JSON state files use write, fsync, and atomic rename. Legacy timestamp-only
  `sync-state.json` files migrate automatically.
- Workflow and per-file retries use exponential backoff and hard attempt limits.
- A successful remote probe that reports an exact zero-byte object marks that
  media `unavailable`, removes its zero-byte/aria2 artifacts, and emits one
  warning without degrading every future run. Failed or inconclusive probes
  remain retryable and are never treated as permanent.
- `flock` prevents overlapping scheduled or manually triggered runs.
- Downloads stop before the staging ceiling or minimum-free-space reserve is crossed.

## Docker deployment

Every push to the default `master` branch publishes the image to GitHub
Container Registry using the version in `package.json`. For example, version
`0.1.2` publishes both:

```text
ghcr.io/mchartier/learning-genie-sync:0.1.2
ghcr.io/mchartier/learning-genie-sync:latest
```

Use the SemVer tag for a controlled upgrade, or `latest` to track the newest
successful build from `master`:

```bash
docker pull ghcr.io/mchartier/learning-genie-sync:0.1.2
docker pull ghcr.io/mchartier/learning-genie-sync:latest
```

GitHub creates a newly published container package as private. Make the package
public once in its GitHub package settings for anonymous pulls, or authenticate
Docker to `ghcr.io` with an account that has `read:packages` access.

To update a Compose deployment that uses `latest`:

```bash
docker compose pull learning-genie-sync
docker compose up -d learning-genie-sync
```

For local development, the image can still be built directly:

```bash
docker build -t learning-genie-sync .
```

Use an environment file so credentials do not enter shell history:

```dotenv
LG_USER=parent@example.com
LG_PASS=replace-me
IMMICH_INSTANCE_URL=https://immich.example.com/api
IMMICH_API_KEY=replace-me
CRON_EXPRESSION=0 17 * * *
TZ=America/Los_Angeles
NTFY_URL=https://ntfy.example.com
NTFY_TOPIC=darkmachines
```

Then start the scheduled service:

```bash
docker run -d \
  --name learning-genie-sync \
  --restart unless-stopped \
  --env-file learning-genie-sync.env \
  -v /srv/data/learning-genie-sync:/data \
  ghcr.io/mchartier/learning-genie-sync:latest
```

Only this container should schedule the import. Remove the old independent
Immich upload cron job; a fixed ten-minute offset can race a still-running
download. If the initial workflow fails, bounded retries finish and the
container keeps its scheduler alive rather than entering a Docker restart loop.

When `IMMICH_INSTANCE_URL` and `IMMICH_API_KEY` are omitted, the same image runs
in download-only mode and leaves verified media in staging. When configured,
the bundled official `@immich/cli` runs recursively with `--delete` and
`--delete-duplicates`; local media is considered uploaded only after that
command succeeds.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `LG_USER`, `LG_PASS` | required | Learning Genie credentials |
| `CRON_EXPRESSION` | unset | Five-field schedule; unset performs one workflow |
| `AUTH_PATH` | `/data/auth.storage.json` | Persistent Playwright authentication state |
| `STATE_PATH` | `/data/sync-state.json` | Atomic per-enrollment fetch/completion state |
| `OUTDIR` | `/data` | Staging root and per-child media directories |
| `OUTFILE` | `/tmp/input.json` | Temporary Learning Genie response path |
| `SYNC_ARGS` | unset | Additional arguments passed to `lg.mjs sync` |
| `IMMICH_INSTANCE_URL` | unset | Immich API URL, normally ending in `/api` |
| `IMMICH_API_KEY` | unset | Immich API key |
| `DELETE_AFTER_UPLOAD` | `true` | Ask Immich CLI to delete uploaded assets and duplicates |
| `IMMICH_AUTO_CREATE_ALBUM` | `false` | Opt in to creating albums from child folder names |
| `LOCK_PATH` | `/data/.learning-genie-sync.lock` | Non-overlap lock file |
| `DOWNLOAD_MAX_RETRIES` | `3` | Attempts for one media item during one run |
| `MAX_MEDIA_ATTEMPTS` | `10` | Durable maximum attempts for one media item |
| `LEDGER_FLUSH_EVERY` | `100` | Successful entries per atomic ledger checkpoint |
| `WORKFLOW_MAX_RETRIES` | `3` | Attempts for the complete sequential workflow |
| `MAX_STAGING_BYTES` | `21474836480` | 20 GiB hard staging ceiling; `0` disables it |
| `MIN_FREE_BYTES` | `5368709120` | 5 GiB filesystem reserve; `0` disables it |
| `UNKNOWN_DOWNLOAD_RESERVE_BYTES` | `536870912` | Reservation when a server omits content length |
| `STAGING_ALERT_BYTES` | `10737418240` | Alert threshold for staging size |
| `STALE_AFTER_HOURS` | `48` | Alert when no fully successful run is this recent |
| `ALERT_FAILURE_THRESHOLD` | `3` | Consecutive workflow failures before urgent alerting |
| `NTFY_URL`, `NTFY_TOPIC` | unset | Optional ntfy base URL and topic |
| `ALERT_WEBHOOK_URL` | unset | Optional direct ntfy-compatible webhook URL |
| `LOCAL_TZ` | derived | Override the per-child EXIF timezone |

API retries can be tuned with `API_RETRY_BASE_MS` and `API_RETRY_MAX_MS`;
workflow retries use `WORKFLOW_RETRY_BASE_MS` and `WORKFLOW_RETRY_MAX_MS`.

## Persistent state

The volume contains:

- `auth.storage.json`: Learning Genie session data.
- `sync-state.json`: versioned per-enrollment fetch and completion watermarks.
- `<child>/.learning-genie-ledger.json`: status, attempts, URL, destination, and
  errors for each media item. Confirmed empty sources remain here with status
  `unavailable`, their media ID/path/error, cleanup audit, and timestamps.
- `workflow-state.json`: last run, last full success, failure count, and summary.
- `last-sync-report.json`: counts and bytes for the most recent download stage.

Do not delete the ledgers during routine cleanup. They are what keep already
imported assets from being downloaded again after Immich removes local copies.
If Learning Genie repairs an unavailable source, it can be replayed manually by
setting that ledger entry back to `pending` with `attempts` set to `0`; changing
the source object's canonical path also resets it automatically.

## Local development

Install dependencies and Playwright:

```bash
npm install
npx playwright install
```

Run a one-off download-only sync:

```bash
LG_USER='parent@example.com' LG_PASS='replace-me' npm run sync -- \
  --outdir ./downloads
```

Run the regression suite:

```bash
npm test
```

The tests cover existing destinations, benign ExifTool warnings, interrupted
aria2 downloads, genuine per-file failures, failed Immich uploads, bounded
retry behavior, atomic state, legacy migration, and success-only completion
watermarks.

## Upgrading an existing two-cron deployment

1. Keep the old downloader stopped while confirmed numbered duplicates and
   stale `.aria2` remnants are cleaned up.
2. Preserve `auth.storage.json`, `sync-state.json`, and every verified
   unsuffixed original.
3. Build this image and configure the Immich URL/key in this service.
4. Disable the independent Immich upload cron container/job.
5. Start this service with one `CRON_EXPRESSION` and watch the first supervised run.
6. Confirm `workflow-state.json`, `sync-state.json`, and the per-child ledgers advance.
7. Confirm the log summary reports expected downloaded, uploaded, deleted, and byte counts.

The narrowly scoped deletion of historical numbered copies is an operational
migration step, not something this application performs automatically.

# Learning Genie Sync CLI

This project automates downloading photos/videos for parent accounts on [Learning Genie](https://www.learning-genie.com/).
It wraps Playwright to log in, pulls the Notes API for every enrolled child, and runs a bash downloader that saves the media with local EXIF timestamps.

## Features

- Playwright-based login that captures persistent storage state and required headers (`X-UID`, timezone, etc.); the sync command refreshes auth automatically as needed.
- Single `sync` command that logs in (if required), fetches new entries for every enrolled child, and runs the downloader per child.
- Incremental sync: tracks the latest synced timestamp per enrollment in a state file so reruns only fetch new media.
- Per-child timezone detection so downloaded media gets EXIF data in local time.
- Docker container with Chromium/Playwright, `jq`, `supercronic`, and an optional cron schedule via `CRON_EXPRESSION`.

## Prerequisites (local)

- Node.js 20+
- npm
- Playwright dependencies (for Chromium):
  ```bash
  npx playwright install
  sudo npx playwright install-deps
  ```
- Runtime dependencies used by the downloader: `jq`, `aria2c`, `exiftool`, `date` (typically preinstalled on most Linux distributions).

## Setup (local)

1. Install dependencies:
 ```bash
  npm install
  ```
2. Run a sync (the command logs in automatically when `LG_USER`/`LG_PASS` are provided):
   ```bash
   LG_USER="you@example.com" LG_PASS="secret" \
   node ./lg.mjs sync \
     --outdir ./downloads
   ```
   - `--auth`, `--outfile`, and `--outdir` are optional; defaults are `./auth.storage.json`, `./input.json`, and `./downloads`.
   - Subsequent runs fetch only newly posted media. Delete the file at `STATE_PATH` (defaults to `./sync-state.json`) to force a full rescan.

3. Run the downloader script directly (if needed):
   ```bash
   ./learning-genie-download.sh input.json ./downloads
   ```

## Docker Usage

The project ships with a Dockerfile based on `mcr.microsoft.com/playwright:v1.55.1-jammy` and installs everything needed (Chromium, dependencies, `jq`, `supercronic`).

### Build

```bash
docker build -t learning-genie-sync .
```

### Run once

```bash
docker run --rm \
  -e LG_USER='you@example.com' \
  -e LG_PASS='secret' \
  -v /path/on/host:/data \
  learning-genie-sync
```

- `/data` is the default volume used for persistent auth + downloads. The container writes:
  - `/data/auth.storage.json`
  - `/data/<ChildName>/...` (media)

### Scheduled runs (cron)

Set `CRON_EXPRESSION` with any standard 5-field cron string. The entrypoint performs a sync immediately, then schedules future runs with `supercronic`.

```bash
docker run --rm \
  -e LG_USER='you@example.com' \
  -e LG_PASS='secret' \
  -e CRON_EXPRESSION='0 18 * * 1-5' \
  -v /path/on/host:/data \
  learning-genie-sync
```

Example above runs at 6 pm every weekday.

### Environment variables

| Name            | Required | Default                      | Description |
|-----------------|----------|------------------------------|-------------|
| `LG_USER`       | Yes      | —                            | Parent account email |
| `LG_PASS`       | Yes      | —                            | Parent account password |
| `CRON_EXPRESSION` | No     | *(unset)*                    | Cron schedule for recurring syncs |
| `OUTDIR`        | No       | `/data`                      | Root directory for downloads (maps to host volume) |
| `OUTFILE`       | No       | `/tmp/input.json`            | Base JSON output file per sync |
| `AUTH_PATH`     | No       | `/data/auth.storage.json`    | Storage state path |
| `STATE_PATH`    | No       | `/data/sync-state.json`      | Persistent per-enrollment watermark store |
| `LOCAL_TZ`      | No       | *(Derived per child)*        | Override timezone for downloader (rarely needed) |

## Development Tips

- `npm run sync` (after setting `LG_USER`/`LG_PASS`) → convenience wrapper around `node lg.mjs sync`.
- Delete `auth.storage.json` (or the file pointed at by `AUTH_PATH`) if you need to force a fresh login; the next sync will recreate it when credentials are supplied.
- The downloader expects `jq`, `aria2c`, and `exiftool`; the Docker image ships with these, but on bare metal you may need to install them.

## Known Limitations

- Learning Genie occasionally returns duplicate or overlapping Note pages; the CLI dedupes on note/media IDs but may still download revised content if metadata changes.
- During login, Playwright saves the storage state with captured headers (`X-UID`, timezone). If those headers are missing (e.g., network issues), rerun the sync with `LG_USER`/`LG_PASS` so it can refresh the auth file.
- Cron jobs run within the container timezone (UTC). When specifying `CRON_EXPRESSION`, convert to UTC if your host uses a different timezone.

## License

MIT (see `LICENSE` if provided).

# Learning Genie Sync CLI

This project automates downloading photos/videos for parent accounts on [Learning Genie](https://www.learning-genie.com/).
It wraps Playwright to log in, pulls the Notes API for every enrolled child, and runs a bash downloader that saves the media with local EXIF timestamps.

## Features

- Playwright-based login that captures persistent storage state and required headers (`X-UID`, timezone, etc.).
- CLI commands:
  - `login`: interactive login to refresh auth storage.
  - `fetch`: download raw Notes JSON for a single enrollment/date range.
  - `sync`: multi-enrollment workflow that logs in if needed, fetches only new entries, and runs the downloader per child.
- Incremental sync: scans the existing `downloads/<child>` folder and only requests Notes taken after the latest media timestamp.
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
2. Login once to capture auth state (this stores cookies + X-UID under `auth.storage.json`):
   ```bash
   LG_USER="you@example.com" LG_PASS="secret" node ./lg.mjs login --headful
   ```
   > `--headful` is optional; omit it if you trust headless login.

3. Run a one-off sync:
   ```bash
   LG_USER="you@example.com" LG_PASS="secret" \
   node ./lg.mjs sync \
     --start 2025-09-01 --end 2025-09-30 \
     --outdir ./downloads
   ```

   - Omitting `--start/--end` will fetch “all history”, but subsequent runs will only pull new media (the CLI uses `downloads/<child>` timestamps to avoid duplicates).
   - Add `--enrollment <GUID>` to limit to a specific child.
   - Output JSONs are written to `input.json` (or suffixed copies per child) before the downloader runs.

4. Run the downloader script directly (if needed):
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
- You can pass extra CLI args via `SYNC_ARGS`, for example to restrict a date range:
  ```bash
  docker run --rm \
    -e LG_USER='you@example.com' \
    -e LG_PASS='secret' \
    -e SYNC_ARGS='--start 2025-09-01 --end 2025-09-30' \
    -v /path/on/host:/data \
    learning-genie-sync
  ```

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
| `SYNC_ARGS`     | No       | *(empty)*                    | Extra CLI flags for `lg.mjs sync` |
| `OUTDIR`        | No       | `/data`                      | Root directory for downloads (maps to host volume) |
| `OUTFILE`       | No       | `/tmp/input.json`            | Base JSON output file per sync |
| `AUTH_PATH`     | No       | `/data/auth.storage.json`    | Storage state path |
| `LOCAL_TZ`      | No       | *(Derived per child)*        | Override timezone for downloader (rarely needed) |

## Development Tips

- `node lg.mjs login --headful` → capture fresh auth after password changes or when `X-UID` becomes invalid.
- `node lg.mjs fetch --enrollment <GUID> --start YYYY-MM-DD --end YYYY-MM-DD --out out.json` → inspect raw Notes.
- `npm run sync` (after setting `LG_USER`/`LG_PASS`) → convenience wrapper around `node lg.mjs sync`.
- The downloader expects `jq`, `aria2c`, and `exiftool`; the Docker image ships with these, but on bare metal you may need to install them.

## Known Limitations

- Learning Genie occasionally returns duplicate or overlapping Note pages; the CLI dedupes on note/media IDs but may still download revised content if metadata changes.
- During login, Playwright saves the storage state with captured headers (`X-UID`, timezone). If those headers are missing (e.g., network issues), rerun the login command.
- Cron jobs run within the container timezone (UTC). When specifying `CRON_EXPRESSION`, convert to UTC if your host uses a different timezone.

## License

MIT (see `LICENSE` if provided).

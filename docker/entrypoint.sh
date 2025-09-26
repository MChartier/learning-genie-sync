#!/usr/bin/env bash
set -euo pipefail

CRON_EXPRESSION=${CRON_EXPRESSION:-}

if [[ -n "$CRON_EXPRESSION" ]]; then
  if ! command -v supercronic >/dev/null 2>&1; then
    echo "supercronic not installed; cannot use CRON_EXPRESSION" >&2
    exit 1
  fi
  echo "Running initial sync before scheduling …"
  /app/docker/run-sync.sh
  echo "Initial sync finished. Scheduling future runs."
  cat <<EOC >/tmp/cronfile
$CRON_EXPRESSION /bin/bash -lc "/app/docker/run-sync.sh"
EOC
  echo "Starting supercronic with schedule: $CRON_EXPRESSION"
  exec supercronic /tmp/cronfile
fi

exec /app/docker/run-sync.sh

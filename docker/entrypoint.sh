#!/usr/bin/env bash
set -euo pipefail

CRON_EXPRESSION=${CRON_EXPRESSION:-}

if [[ -n "$CRON_EXPRESSION" ]]; then
  if ! command -v supercronic >/dev/null 2>&1; then
    echo "supercronic not installed; cannot use CRON_EXPRESSION" >&2
    exit 1
  fi
  echo "Running initial workflow before scheduling …"
  if /app/docker/run-sync.sh; then
    echo "Initial workflow finished. Scheduling future runs."
  else
    echo "Initial workflow failed after bounded retries; keeping the scheduler alive." >&2
  fi
  cat <<EOC >/tmp/cronfile
$CRON_EXPRESSION /bin/bash -lc "/app/docker/run-sync.sh"
EOC
  echo "Starting supercronic with schedule: $CRON_EXPRESSION"
  exec supercronic /tmp/cronfile
fi

exec /app/docker/run-sync.sh

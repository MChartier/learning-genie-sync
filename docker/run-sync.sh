#!/usr/bin/env bash
set -euo pipefail

: "${LG_USER:?LG_USER env var required}"
: "${LG_PASS:?LG_PASS env var required}"

AUTH_PATH=${AUTH_PATH:-/data/auth.storage.json}
OUTFILE=${OUTFILE:-/tmp/input.json}
OUTDIR=${OUTDIR:-/data}
LOCK_PATH=${LOCK_PATH:-/data/.learning-genie-sync.lock}

mkdir -p "$(dirname "$AUTH_PATH")"
mkdir -p "$OUTDIR"
mkdir -p "$(dirname "$LOCK_PATH")"

exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "[workflow] another sync owns $LOCK_PATH; skipping overlapping run"
  exit 0
fi

exec node /app/workflow.mjs

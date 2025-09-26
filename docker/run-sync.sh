#!/usr/bin/env bash
set -euo pipefail

: "${LG_USER:?LG_USER env var required}"
: "${LG_PASS:?LG_PASS env var required}"

AUTH_PATH=${AUTH_PATH:-/data/auth.storage.json}
OUTFILE=${OUTFILE:-/tmp/input.json}
OUTDIR=${OUTDIR:-/data}
SYNC_ARGS=${SYNC_ARGS:-}

mkdir -p "$(dirname "$AUTH_PATH")"
mkdir -p "$OUTDIR"

CMD=(node /app/lg.mjs sync --auth "$AUTH_PATH" --outfile "$OUTFILE" --outdir "$OUTDIR")
if [[ -n "${SYNC_ARGS}" ]]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=($SYNC_ARGS)
  CMD+=("${EXTRA_ARGS[@]}")
fi

exec "${CMD[@]}"

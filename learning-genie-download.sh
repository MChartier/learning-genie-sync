#!/usr/bin/env bash

set -euo pipefail

JSON=${1:-input.json}
OUTDIR=${2:-downloads}
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for command in node aria2c exiftool; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing dependency: $command" >&2
    exit 1
  fi
done

exec node "$SCRIPT_DIR/download-media.mjs" "$JSON" "$OUTDIR"

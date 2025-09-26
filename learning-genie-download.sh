#!/usr/bin/env bash
# Learning Genie → local files with proper local "date taken" metadata (Linux)
# deps: jq, aria2c, exiftool

set -euo pipefail

# --- config / args ---
JSON="${1:-input.json}"          # input JSON payload from Learning Genie
OUTDIR="${2:-downloads}"         # output folder for media
ARIA_CONN="${ARIA_CONN:-16}"     # aria2 connections per server
ARIA_SPLIT="${ARIA_SPLIT:-16}"   # aria2 split per file
LOCAL_TZ="${LOCAL_TZ:-America/Los_Angeles}"  # target timezone for "date taken"

# --- sanity checks ---
for cmd in jq aria2c exiftool date; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing dependency: $cmd" >&2
    exit 1
  fi
done

mkdir -p "$OUTDIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

MAP="$TMP_DIR/map.tsv"  # <url>\t<utc>
URLS="$TMP_DIR/urls.txt"

echo "1) Extracting URLs, timestamps, and captions from $JSON …"
# Be tolerant of slight key variations: createAtUtc / createdAtUtc / createdAt / createAt
jq -r '
  ..
  | select(type == "object" and (.media? | type == "array"))
  | . as $parent
  | .media[]
  | select(.public_url != null)
  | [
      .public_url,
      (.createAtUtc // .createdAtUtc // .createdAt // .createAt),
      (if ($parent.type // "") == "Activity"
         then ($parent.payload // ""
               | tostring
               | gsub("\r|\n"; " ")
               | gsub("\t"; " ")
               | gsub("  +"; " ")
               | gsub("^ +"; "")
               | gsub(" +$"; ""))
         else ""
       end)
    ]
  | select(.[1] != null)
  | @tsv
' "$JSON" > "$MAP"

if [[ ! -s "$MAP" ]]; then
  echo "No (public_url, timestamp) tuples found in $JSON." >&2
  exit 2
fi

cut -f1 "$MAP" > "$URLS"
COUNT=$(wc -l < "$URLS" | tr -d ' ')
echo "   Found $COUNT media items."

echo "2) Downloading with aria2c into $OUTDIR …"
aria2c \
  --auto-file-renaming=true \
  --max-connection-per-server="$ARIA_CONN" \
  --split="$ARIA_SPLIT" \
  -i "$URLS" \
  -d "$OUTDIR" \
  1>/dev/null

# --- helpers ---
find_downloaded_path() {
  # $1 = expected basename from URL (without query)
  local base="$1"
  local path="$OUTDIR/$base"
  if [[ -f "$path" ]]; then
    echo "$path"; return 0
  fi
  local cand
  cand="$(ls -1 "$OUTDIR/$base"* 2>/dev/null | head -n1 || true)"
  if [[ -n "$cand" && -f "$cand" ]]; then
    echo "$cand"; return 0
  fi
  return 1
}

# sanitize an incoming UTC string (may have T or milliseconds)
sanitize_utc() {
  # $1 raw utc like "2025-09-17 22:33:30" or "2025-09-17T22:33:30.000"
  local s="$1"
  s="${s/T/ }"
  s="${s%%.*}"
  echo "${s:0:19}"
}

# convert "YYYY-MM-DD HH:MM:SS" (UTC) -> local variants
# outputs 4 globals: EXIF_TS, XMP_TS, IPTC_DATE, IPTC_TIME, and FILE_TS (ISO with offset)
to_local() {
  local utc="$1"
  local epoch
  epoch=$(date -ud "$utc" +%s)  # interpret input as UTC
  EXIF_TS=$(TZ="$LOCAL_TZ" date -d "@$epoch" '+%Y:%m:%d %H:%M:%S')      # local, no TZ
  XMP_TS=$(TZ="$LOCAL_TZ"  date -d "@$epoch" '+%Y-%m-%dT%H:%M:%S%:z')   # local ISO, with offset
  IPTC_DATE=$(TZ="$LOCAL_TZ" date -d "@$epoch" '+%Y:%m:%d')             # local date
  IPTC_TIME=$(TZ="$LOCAL_TZ" date -d "@$epoch" '+%H:%M:%S%:z')          # local time with offset
  FILE_TS="$XMP_TS"                                                      # use ISO (with offset) for FileModifyDate
}

stamp_image() {
  # $1 = file path, $2 = raw utc, $3 = caption (optional)
  local f="$1"; local raw="$2"; local caption="${3-}"
  local utc; utc="$(sanitize_utc "$raw")"
  to_local "$utc"
  local ext="${f##*.}"; ext="${ext,,}"

  local -a still_caption_args=()
  local -a xmp_caption_args=()
  if [[ -n "$caption" ]]; then
    still_caption_args=(
      "-EXIF:ImageDescription=$caption"
      "-IPTC:Caption-Abstract=$caption"
    )
    xmp_caption_args=("-XMP-dc:Description=$caption")
  fi

  if [[ "$ext" =~ ^(jpg|jpeg|heic)$ ]]; then
    local -a args=(
      -m
      -P
      -overwrite_original
      "-EXIF:DateTimeOriginal=$EXIF_TS"
      "-EXIF:CreateDate=$EXIF_TS"
      "-EXIF:ModifyDate=$EXIF_TS"
      "-IPTC:DateCreated=$IPTC_DATE"
      "-IPTC:TimeCreated=$IPTC_TIME"
      "-XMP:xmp:CreateDate=$XMP_TS"
      "-XMP:xmp:ModifyDate=$XMP_TS"
      "-XMP:xmp:MetadataDate=$XMP_TS"
      "-XMP-photoshop:DateCreated=$XMP_TS"
      "-FileModifyDate=$FILE_TS"
    )
    exiftool "${args[@]}" "${still_caption_args[@]}" "${xmp_caption_args[@]}" "$f" >/dev/null
    echo "   🖼  EXIF/XMP/IPTC set (LOCAL) → $(basename "$f") ← $XMP_TS"

  elif [[ "$ext" =~ ^(png|webp)$ ]]; then
    # embed XMP + create sidecar; set mtime
    local -a embed_args=(
      -m
      -P
      -overwrite_original
      "-XMP:xmp:CreateDate=$XMP_TS"
      "-XMP:xmp:ModifyDate=$XMP_TS"
      "-XMP:xmp:MetadataDate=$XMP_TS"
      "-XMP-photoshop:DateCreated=$XMP_TS"
      "-FileModifyDate=$FILE_TS"
    )
    exiftool "${embed_args[@]}" "${xmp_caption_args[@]}" "$f" >/dev/null

    local -a sidecar_args=(
      -m
      -P
      -overwrite_original
      -o
      '%d%f.xmp'
      "-XMP:xmp:CreateDate=$XMP_TS"
      "-XMP:xmp:ModifyDate=$XMP_TS"
      "-XMP:xmp:MetadataDate=$XMP_TS"
      "-XMP-photoshop:DateCreated=$XMP_TS"
    )
    exiftool "${sidecar_args[@]}" "${xmp_caption_args[@]}" "$f" >/dev/null
    echo "   🧩 PNG/WEBP XMP+sidecar (LOCAL) → $(basename "$f") ← $XMP_TS"

  else
    # Unknown still image: sidecar + mtime
    local -a sidecar_args=(
      -m
      -P
      -overwrite_original
      -o
      '%d%f.xmp'
      "-XMP:xmp:CreateDate=$XMP_TS"
      "-XMP:xmp:ModifyDate=$XMP_TS"
      "-XMP:xmp:MetadataDate=$XMP_TS"
      "-XMP-photoshop:DateCreated=$XMP_TS"
    )
    exiftool "${sidecar_args[@]}" "${xmp_caption_args[@]}" "$f" >/dev/null

    local -a mtime_args=(
      -m
      -P
      -overwrite_original
      "-FileModifyDate=$FILE_TS"
    )
    exiftool "${mtime_args[@]}" "$f" >/dev/null
    echo "   ℹ  Sidecar+mtime (LOCAL) → $(basename "$f") ← $XMP_TS"
  fi
}

stamp_video() {
  # $1 = file path, $2 = raw utc, $3 = caption (optional)
  local f="$1"; local raw="$2"; local caption="${3-}"
  local utc; utc="$(sanitize_utc "$raw")"
  to_local "$utc"
  local -a caption_args=()
  if [[ -n "$caption" ]]; then
    caption_args=(
      "-QuickTime:Comment=$caption"
      "-XMP-dc:Description=$caption"
    )
  fi
  # IMPORTANT: QuickTime tags are nominally local time (no TZ); do NOT use -api QuickTimeUTC=1 here
  local -a args=(
    -m
    -P
    -overwrite_original
    "-QuickTime:CreateDate=$EXIF_TS"
    "-QuickTime:ModifyDate=$EXIF_TS"
    "-XMP:xmp:CreateDate=$XMP_TS"
    "-FileModifyDate=$FILE_TS"
  )
  exiftool "${args[@]}" "${caption_args[@]}" "$f" >/dev/null
  echo "   🎬 QuickTime/XMP set (LOCAL) → $(basename "$f") ← $EXIF_TS"
}

echo "3) Embedding LOCAL capture dates (TZ=$LOCAL_TZ) with exiftool …"
while IFS=$'\t' read -r url utc caption; do
  base="$(basename "${url%%\?*}")"
  file=""
  if file=$(find_downloaded_path "$base"); then :; else
    echo "   ⚠ Missing file for URL: $url" >&2
    continue
  fi

  ext="${file##*.}"; ext="${ext,,}"
  if [[ "$ext" =~ ^(mp4|mov|m4v)$ ]]; then
    stamp_video "$file" "$utc" "$caption"
  else
    stamp_image "$file" "$utc" "$caption"
  fi
done < "$MAP"

echo "✅ Done. Import '$OUTDIR' into Immich when ready."
echo
echo "Quick verify:"
echo "  exiftool -G -a -s -time:all -xmp:createdate -iptc:datecreated -iptc:timecreated \"$OUTDIR/<somefile>.jpg\""

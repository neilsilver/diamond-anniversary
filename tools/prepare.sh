#!/bin/bash
# Resize/convert source photos into photos/ and generate/merge photos.json.
#
#   tools/prepare.sh <source-photos-folder>
#
# Safe to re-run: only new or changed sources are converted, and existing
# manifest entries keep their position, year and duration.
set -euo pipefail

SRC="${1:?usage: tools/prepare.sh <source-photos-folder>}"
SRC="$(cd "$SRC" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/photos"
MANIFEST="$ROOT/photos.json"
MAX=2000        # longest edge, px (smaller photos are never upscaled)
QUALITY=80
SRGB="/System/Library/ColorSync/Profiles/sRGB Profile.icc"

mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LIST="$TMP/list.tsv"
: > "$LIST"

converted=0
# Folders named Certificate or other, or starting with "_", are skipped.
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  out="$(printf '%s' "$rel" | md5 -q | cut -c1-10).jpg"
  printf '%s\t%s\n' "$rel" "$out" >> "$LIST"

  if [ -f "$OUT/$out" ] && [ ! "$f" -nt "$OUT/$out" ]; then
    continue
  fi

  # Via BMP: bakes in EXIF orientation and drops all metadata (GPS, camera).
  sips -s format bmp -m "$SRGB" "$f" --out "$TMP/a.bmp" >/dev/null 2>&1
  w="$(sips -g pixelWidth "$TMP/a.bmp" | awk '/pixelWidth/{print $2}')"
  h="$(sips -g pixelHeight "$TMP/a.bmp" | awk '/pixelHeight/{print $2}')"
  resize=()
  if [ "$w" -gt "$MAX" ] || [ "$h" -gt "$MAX" ]; then
    resize=(-Z "$MAX")
  fi
  sips -s format jpeg -s formatOptions "$QUALITY" ${resize[@]+"${resize[@]}"} \
    "$TMP/a.bmp" --out "$OUT/$out" >/dev/null 2>&1
  converted=$((converted + 1))
  echo "  $rel"
done < <(find "$SRC" -type f \
  \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.tif' \
     -o -iname '*.tiff' -o -iname '*.heic' \) \
  -not -path '*/Certificate/*' -not -ipath '*/other/*' -not -path '*/_*' -print0 | sort -z)

python3 - "$LIST" "$MANIFEST" "$OUT" <<'PY'
import json, os, re, sys

list_path, manifest_path, out_dir = sys.argv[1:4]

sources = {}
with open(list_path, encoding="utf-8") as fh:
    for line in fh:
        rel, out = line.rstrip("\n").split("\t")
        sources[rel] = "photos/" + out


def year_of(rel):
    name = os.path.basename(rel)
    if name.lower().startswith("screenshot"):
        return None
    m = re.match(r"(19\d\d|20[0-2]\d)", name) or re.search(
        r"(?<!\d)(19\d\d|20[0-2]\d)(?!\d)", name
    )
    return int(m.group(1)) if m else None


def natural(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


try:
    with open(manifest_path, encoding="utf-8") as fh:
        existing = json.load(fh)
except FileNotFoundError:
    existing = []

# Existing entries keep their order and any hand edits; vanished sources drop out.
entries = []
for e in existing:
    if e.get("src") in sources:
        e["file"] = sources[e["src"]]
        entries.append(e)
known = {e["src"] for e in entries}

new = [{"file": sources[s], "src": s, "year": year_of(s)} for s in sources if s not in known]
new.sort(key=lambda e: (e["year"] is None, e["year"] or 0, natural(e["src"])))

# Slot each new photo after the last entry from the same year or earlier;
# undated photos go to the end.
for e in new:
    pos = len(entries)
    if e["year"] is not None:
        pos = 0
        for i, x in enumerate(entries):
            if x.get("year") is not None and x["year"] <= e["year"]:
                pos = i + 1
    entries.insert(pos, e)

with open(manifest_path, "w", encoding="utf-8") as fh:
    fh.write("[\n")
    fh.write(",\n".join("  " + json.dumps(e, ensure_ascii=False) for e in entries))
    fh.write("\n]\n")

keep = {os.path.basename(e["file"]) for e in entries}
stale = [f for f in os.listdir(out_dir) if f.endswith(".jpg") and f not in keep]
for f in stale:
    os.remove(os.path.join(out_dir, f))

undated = sum(1 for e in entries if e.get("year") is None)
print(f"{len(entries)} photos in manifest ({len(new)} new, {len(stale)} removed, {undated} undated)")
PY

echo "$converted converted"

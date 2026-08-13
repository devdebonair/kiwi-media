#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd -- "$script_dir/.." && pwd)
sample_dir="$project_dir/media/samples"
mkdir -p "$sample_dir"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/3/31/Earth-solar-array-timelapse.webm" \
  -o "$sample_dir/Earth Solar Array Timelapse.webm"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/5/53/Five_Minutes_in_Orbit_%28154728%29.webm" \
  -o "$sample_dir/Five Minutes in Orbit.webm"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/a/af/NASA_Misi%C3%B3n_a_la_Tierra.webm" \
  -o "$sample_dir/NASA Mission to Earth.webm"

printf 'Downloaded sample media to %s\n' "$sample_dir"

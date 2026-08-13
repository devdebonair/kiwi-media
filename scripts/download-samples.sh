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

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/1/1d/Namakura_Gatana_with_music.webm" \
  -o "$sample_dir/Namakura Gatana (1917).webm"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/1/10/Spring_Comes_to_Ponsuke_%281934%29.webm" \
  -o "$sample_dir/Spring Comes to Ponsuke (1934).webm"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/8/83/Tar%C3%B4-san_no_kisha_%281929%29.webm" \
  -o "$sample_dir/Taro-san's Train (1929).webm"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/e/ea/Komiku_-_01_-_Tale_on_the_Late_Main_Theme.ogg" \
  -o "$sample_dir/Tale on the Late - Main Theme.ogg"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/0/01/Komiku_-_06_-_Friendss_theme.ogg" \
  -o "$sample_dir/Friends Theme.ogg"

curl -fL --retry 3 \
  "https://upload.wikimedia.org/wikipedia/commons/a/ad/Monplaisir_-_01_-_Theme_Song.ogg" \
  -o "$sample_dir/Theme Song.ogg"

generated_dir="$project_dir/data/generated"
mkdir -p "$generated_dir"
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -loglevel error -y -ss 2 -i "$sample_dir/Namakura Gatana (1917).webm" -frames:v 1 -vf scale=640:-2 "$generated_dir/anime-namakura.jpg"
  ffmpeg -loglevel error -y -ss 2 -i "$sample_dir/Spring Comes to Ponsuke (1934).webm" -frames:v 1 -vf scale=640:-2 "$generated_dir/anime-ponsuke.jpg"
  ffmpeg -loglevel error -y -ss 2 -i "$sample_dir/Taro-san's Train (1929).webm" -frames:v 1 -vf scale=640:-2 "$generated_dir/anime-taro.jpg"
  cp "$generated_dir/anime-ponsuke.jpg" "$generated_dir/anime-music.jpg"
fi

printf 'Downloaded sample media to %s\n' "$sample_dir"

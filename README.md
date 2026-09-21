# Kiwi

Kiwi is a self-hosted media library centered on topics, precise moments, and saved feeds. It browses videos, audio, photos, articles, and arbitrary files through a clean, media-first interface.

## Features

- Browse and search a mixed media library
- Organize media around topic profiles and dynamic feeds
- Attach topics and notes to whole assets or precise moments and regions
- Direct-play local video and audio with HTTP range requests
- Track views and watch history, and give each item up to five likes
- Browse a vertical Shorts feed with a saved duration limit
- Scan read-only filesystem libraries with a persistent background worker
- Run directly with Node.js or through Docker Compose

## Views, likes, and Shorts

A video or audio view counts when playback starts, once per item per page visit.
Pauses, progress saves, retries, and Shorts loops do not add views. Opening a
photo, article, or other non-audio/video item counts once per visit. Counts appear on library cards, search
and history results, and players. Accurate counts use a new session ledger;
legacy inflated counters are retained but excluded from display. Watch history
and saved progress are preserved.

The player and Shorts each offer up to five likes per item for the local user,
with progressively richer heart animations. Likes persist across reloads.

Open **Shorts** in navigation for a vertically snapping feed. Only videos with a
local file and known positive duration qualify. The default cutoff is strictly
under 90 seconds; open the gear button, change **Under … seconds**, and select **Apply** to save a limit
from 1 to 3600 seconds. Shorts fills the browser viewport with cover-sized video and overlay controls.
Videos start muted, crop to fill the screen, and pause
when scrolled out of the active position. More items load as you scroll.

## Run locally

```bash
npm install
npm run dev
```

The Next.js web app listens on `0.0.0.0:4173` and the Fastify API listens on `0.0.0.0:3333`. To import local media, set `KIWI_MEDIA_DIRS` to one or more colon-separated absolute paths and use the Scan library action in Settings, or call `POST /api/v1/library/scan`. The API and worker load the root `.env` when launched through npm; shell environment variables take precedence.

Network folders must already be mounted and readable by both processes. Scanning
registers filenames and paths first, without reading full files for checksums or
adding tags. Videos become browsable and stream directly from the originals.
A separate `enrich-root` job generates thumbnails and technical metadata in the
background. Home supports Load more for large libraries. Playback uses browser
codec support; ingestion does not transcode originals.

To download the small public-domain NASA fixtures used during development:

```bash
./scripts/download-samples.sh
```

Their sources and licensing notes are recorded in `media/samples/SOURCES.md`. Video binaries are intentionally excluded from Git.

## Fingerprint metadata lookups

The monorepo includes `@kiwi/stash-box`, a reusable fingerprint/catalog client, and
`@kiwi/scanner`, its standalone CLI. Neither requires a running Stash application.

```bash
npm run --silent metadata -- fingerprint '/media/example.mp4'
# With STASH_BOX_ENDPOINT and STASH_BOX_API_KEY set:
npm run --silent metadata -- lookup --recursive '/media/videos'
```

Lookups emit JSONL with all metadata candidates; they do not modify Kiwi's library.
See [scanner setup and usage](apps/scanner/README.md) for optional perceptual hashes,
provider configuration, fingerprint caching, and the JavaScript API.

## Enrich people and creator profiles

With the reviewed name export at `data/exports/names-from-titles/evidence.json`
and the existing StashDB/ThePornDB credentials configured:

```bash
npm run profiles:enrich                     # Fetch public metadata and write a reviewable plan
npm run profiles:enrich -- --offline --apply # Apply the cached plan inputs and download portraits
```

This creates person topics with descriptions, locally cached profile pictures,
source links, and social accounts. It merges aliases through source identities,
checks Wikipedia articles, and links only current video titles that match the
reviewed names. Associations mean “mentioned in the title”; they do not verify
on-screen appearances. Ambiguous and unmatched identities remain in the report.
No video files are uploaded; only candidate names are sent to metadata providers.

Plans, provider caches, optional reviewed profile resolutions, and the import
report live in `data/exports/profile-enrichment/`. Each apply creates an SQLite
backup in `data/backups/`, uses one transaction for tags and associations, and
rebuilds search. Reruns reuse cached lookups, avoid duplicate tags/links, and
preserve manually edited topic fields. `--offline` skips profile lookups but may
still download uncached portraits. To refresh metadata, remove the relevant
cache files before running the preview command again.

## Production

```bash
npm run build
NODE_ENV=production npm start
```

Production runs the built web client on port `4173` and API on port `3333`. Put Caddy in front for public TLS. Keep `data/kiwi.db` on local storage; media roots may be network mounts.

## Tailscale access

Both development processes bind to all interfaces. On another device in the same tailnet, open:

```text
http://<server-tailscale-ip>:4173
```

The default Docker Compose setup exposes Caddy on port 80 instead. Access control is currently delegated to Tailscale; do not expose the development server directly to the public internet.

## Data and backups

- SQLite database: `data/kiwi.db`
- Derived thumbnails: `data/generated/`
- Originals are never modified.
- `GET /api/v1/health` reports server and database health.

# Kiwi

Kiwi is a self-hosted media library centered on topics, precise moments, and saved feeds. It browses videos, audio, photos, articles, and arbitrary files through a clean, media-first interface.

## Features

- Browse and search a mixed media library
- Organize media around topic profiles and dynamic feeds
- Attach topics and notes to whole assets or precise moments and regions
- Direct-play local video and audio with HTTP range requests
- Scan read-only filesystem libraries with a persistent background worker
- Run directly with Node.js or through Docker Compose

## Run locally

```bash
npm install
npm run dev
```

The Next.js web app listens on `0.0.0.0:4173` and the Fastify API listens on `0.0.0.0:3333`. To import local media, set `KIWI_MEDIA_DIRS` to one or more colon-separated absolute paths and use the Scan library action in Settings, or call `POST /api/v1/library/scan`.

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

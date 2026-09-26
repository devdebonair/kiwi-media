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
- Download web media into library folders with yt-dlp, debrid services, custom APIs, or plugins, optionally through reusable VPN profiles
- Run directly with Node.js or through Docker Compose

## Playlist and mini player

Hover over a video thumbnail and choose **Add to Playlist**. On touch screens the
button is always visible. Opening any video also creates a playlist. Minimize the
watch player to keep watching while browsing, or expand it back to the watch page
without restarting playback. The playlist panel lets you select or remove items.
Finished videos are removed and the next queued video starts automatically.
The queue is saved in localStorage across navigation and reloads, and is deleted
when it finishes or you close the mini player. Entering Shorts pauses the regular
player. Playlist controls use the existing [Phosphor Icons](https://phosphoricons.com/) library.

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

The Next.js web app listens on `0.0.0.0:4173` and the Fastify API listens on `0.0.0.0:3333`. To import local media, add server-side absolute folder paths in **Settings → Media libraries**, then select **Scan library**. Folders and scanning preferences are stored in SQLite; pausing a folder preserves its imported media and existing jobs. The API and worker load other server settings from the root `.env` when launched through npm; shell environment variables take precedence.

Use **Add tag** beside a connected folder in Settings to choose or create a tag. Folder tags apply to imported content throughout its subfolders, including future imports. Remove a folder tag with its × button; directly assigned content tags remain. SQLite stores one `folder_topics` row per folder/tag pair, and the `effective_asset_topics` view combines these with direct tags at query time for content labels, filters, topic counts, feeds, and search. Inherited tags are not copied into asset annotations or search-index rows.

For an existing installation, run `npm run migrate:library-roots` once before removing the old `KIWI_MEDIA_DIRS` entry from `.env` (or the deployment environment). This backs up the database and imports any missing paths without changing existing folders, IDs, file links, or settings. Repeating the command does not duplicate folders or reset paused folders. Normal startup and scanning no longer use that variable. In Docker, add `/media` in Settings to scan the existing media mount.

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

## Link metadata to a tag

Open a tag's topic page and choose **Edit tag**. Edit its name, description,
picture URL, type, and aliases, or search a metadata provider by name, provider
ID, or profile URL. Select a result to preview its details, choose the fields to
import, and link it. This enriches the existing tag without matching or changing
its media associations.

Wikidata is available without credentials and supplements verified identities
with English Wikipedia summaries. StashDB and ThePornDB provide performer
identities using the same server-side credentials as the scanner (see
`.env.example`). Unconfigured providers appear disabled. Credentials never go
to the browser. TMDB and MusicBrainz are not integrated.

Tags support one identity per provider and multiple providers per tag. Each link
stores a stable ID, source URL, fetched metadata, and refresh time. **Refresh**
fetches the saved identity and updates selected, provider-managed fields;
manually edited fields, including intentionally cleared fields, are preserved.
**Make preferred** applies that source's selected fields where existing values
are empty or provider-managed. **Change match** previews a replacement identity.
**Unlink** keeps imported values and attribution while stopping that source's
updates. Refresh is manual; there is no background refresh schedule.

Existing batch-imported StashDB/ThePornDB identities are brought into the editor
once on server startup. Links live in `topic_provider_links`; field ownership,
manual overrides, and attribution are recorded in topic metadata. Provider
adapters are in `apps/server/src/tag-providers.js`; each supplies `search` and
`get` operations returning the shared entity shape. Preview tokens expire after
10 minutes or a server restart; select a match again if a preview expires.

## Download media from the web

Select **Upload** in the top bar, paste one or more links, magnets, or IDs (one per
line), choose a connected library folder and an optional subfolder, and select
**Download**. Before you submit, the dialog shows which downloader and VPN the
first link will use. The same dialog lists recent downloads with progress,
Cancel, Retry, and Open.

Downloads can only be saved to folders in **Settings → Media libraries**, never to
arbitrary server paths. The folder must be writable by the API and worker, so
read-only mounts appear as unavailable. Files are staged in a hidden
`.kiwi-download-<id>` folder inside the destination and moved into place when
complete. Existing files are never overwritten: a new copy gets a name like
`Video (1).mp4`. Finished media is added to the library immediately, with its
source link, title, and thumbnail, and folder tags apply as usual.

### Downloaders

Manage downloaders in **Settings → Downloaders**. You can add several of the same
kind, for example two Real-Debrid accounts.

| Downloader | Handles | Notes |
| --- | --- | --- |
| yt-dlp (default) | Page links on YouTube and thousands of other sites | Format, MP4 merging, playlists, file-name template, speed limit. Accepts a `cookies.txt` file. |
| Direct link | Direct file URLs | Optional extra headers; accepts `cookies.txt`. |
| Real-Debrid | Hoster links, magnets | Caches torrents, downloads media files, and removes the torrent afterwards (optional). |
| TorBox | Hoster links, magnets | Same options as Real-Debrid. |
| Custom HTTP API | Anything your service understands | Calls your own resolver or proxy endpoints. See below. |

**Automatic** uses the default downloader. If it can't handle a link (for example
a magnet), the first enabled downloader that can is used. yt-dlp is found in
`KIWI_DATA_DIR/bin`, then `PATH`, or at `KIWI_YTDLP_PATH`. For YouTube, it runs
JavaScript with the same Node binary that runs Kiwi.

**Cookies.** Downloaders that accept cookies have a **Cookies (cookies.txt)**
field. Export a Netscape-format file with a browser extension or
`yt-dlp --cookies-from-browser`. Files are stored with owner-only permissions in
`data/downloads/cookies/`. They are never returned to the browser, and each job
uses a temporary copy.

**Custom HTTP API.** Configure a *resolve endpoint*, such as
`https://resolver.example/api/resolve?url={source}` (GET or POST with a JSON
body), and a path to the file URLs in its JSON response, such as `download` or
`data.files[].url`. Optional name and title paths set file names and the asset
title. Add a *search endpoint*, such as `…/search?q={query}`, with result field
paths to enable the dialog's **Search** tab. Selecting a result adds its source
to the link list. Headers such as API keys are stored as secrets.

**Plugins.** To add your own downloader, place an ES module in
`KIWI_DATA_DIR/plugins/downloaders/` (or `KIWI_DOWNLOADER_PLUGINS_DIR`). New and
changed files load without a restart. Settings shows load errors. A plugin
default-exports an object like this:

```js
export default {
  id: "my-source", name: "My source", description: "…",
  fields: [{ key: "apiKey", label: "API key", type: "secret", required: true }], // text, url, secret, textarea, secret-textarea, select, boolean, number
  cookies: false,                             // true to accept a cookies.txt file (ctx.cookies / ctx.cookiesFile)
  accepts: source => source.startsWith("https://my.site/"),
  validate(config) {},                        // optional; throw to reject settings
  async search({ query, config, http }) {},   // optional; return [{ title, source, description?, size? }]
  async download(ctx) {},                     // save files into ctx.workDir; optionally return { title }
};
```

`ctx` provides `source`, `config`, `workDir`, `http` (`fetch`, `json`,
`download(url, { dir, filename, headers, onProgress })`), `run(command, args,
{ onLine })`, `progress({ fraction, bytes, totalBytes, speed, eta, message, title })`,
`log(line)`, `signal`, `proxyUrl`, `cookies`, and `cookiesFile`. Use `ctx.http` and
`ctx.run` for all network access: both are bound to the job's VPN, and the global
`fetch` is not. Plugins run with the server's permissions, so only install code you
trust. See `packages/downloads/examples/internet-archive.mjs` for a complete
example with search.

### VPN profiles

Kiwi routes downloads through a VPN without a VPN client installed on the
server. Add profiles in **Settings → VPN profiles**:

- **SOCKS5 / HTTP proxy** – A provider's proxy endpoint or any SOCKS5, HTTP, or
  HTTPS proxy. Presets fill in Private Internet Access (`proxy-nl.privateinternetaccess.com:1080`
  with the SOCKS credentials from PIA's Client Control Panel), NordVPN (service
  credentials), and a Gluetun HTTP proxy for OpenVPN-only providers. Hostnames are
  resolved through the proxy. Provider SOCKS proxies are not encrypted.
- **WireGuard config** – Paste a `.conf` from Mullvad, Proton VPN, IVPN, AirVPN,
  or your own server. `PostUp` and other `wg-quick` hooks are ignored.
- **Private Internet Access (WireGuard)** – Enter your PIA username, password,
  and region. Each time the tunnel starts, Kiwi signs in and registers a fresh
  WireGuard key through PIA's manual-connection API. Kiwi verifies the server
  against PIA's certificate authority.

WireGuard profiles run [wireproxy](https://github.com/windtf/wireproxy), a
userspace WireGuard client. It needs no root access, kernel module, or change to
the server's routes. Kiwi exposes the tunnel as a local SOCKS5 port with random
credentials, shares one tunnel among concurrent jobs, and stops it after a minute
without use. The generated private key is deleted from disk once the tunnel
starts. Install `wireproxy` on `PATH`, in `KIWI_DATA_DIR/bin`, or at
`KIWI_WIREPROXY_PATH`. The Docker image includes wireproxy and yt-dlp.

**Test** connects through a profile and shows its exit IP address and location
next to the server's own address. It warns when the two match.

**Choosing a VPN.** A download uses the first VPN that applies from this list:

1. The VPN chosen for that download in the dialog, or **No VPN**.
2. The most specific **VPN by website** rule. A rule for `youtube.com` also covers
   `m.youtube.com`, and a rule for `music.youtube.com` takes precedence over it.
3. The downloader's **Default VPN**.

Searches from the dialog use the downloader's default VPN. Retrying a download
re-applies the current rules unless a VPN was chosen explicitly.

**Fail-closed routing.** A download assigned to a VPN never falls back to the
server's own connection. If the proxy or tunnel is unreachable, or the profile
was deleted, the download fails. yt-dlp uses its own HLS/DASH fragment downloader
so that fragments also go through the proxy. A profile can't be deleted while
downloaders, website rules, or active downloads use it.

Settings (`KIWI_DOWNLOAD_CONCURRENCY`, default 2, plus the paths above) are in
`.env.example`. Downloads run in the worker process on their own queue, so long
downloads don't block library scans. When the worker restarts, interrupted
downloads start again.

In Docker Compose, `./media` stays read-only. Downloads go to a separate writable
`./downloads` mount. Add `/downloads` in Settings to use it.

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

### Video compatibility

The watch player tries the original video first. Browser decoding errors automatically
prepare an H.264/AAC MP4 using FFmpeg. Compatible H.264/AAC streams in containers
such as FLV are repackaged without re-encoding; other codecs are converted. The
player also offers a manual compatibility
option for issues such as unsupported audio. Conversion requires `ffmpeg` on PATH
(already included in the Docker image). A single conversion runs at a time, and the
player waits while another video is being prepared. The first conversion must finish
before playback; large videos can take several minutes. Damaged or unsupported inputs
retain a download-original option.

Compatible copies live in `data/generated/playback/` (under `KIWI_DATA_DIR` when set),
with cache keys based on source path, size, and modification time. Originals remain
unchanged. These derived files can be deleted to reclaim disk space when no conversion
is running; they are recreated on demand. The cache has no automatic size limit.

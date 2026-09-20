# Kiwi metadata scanner

A standalone CLI backed by the reusable `@kiwi/stash-box` workspace package.
It fingerprints local videos and queries an existing stash-box GraphQL server.
No Stash application, local stash-box server, GPU, or model is required.

Requires Node.js 22+ and `ffprobe` on PATH. Run `npm install` at the repository root.

## Fingerprint locally

From the repository root:

```bash
npm run --silent metadata -- fingerprint '/media/example.mp4'
npm run --silent metadata -- fingerprint --recursive '/media/videos'
```

The default OSHASH reads at most 128 KiB of each file, plus an FFprobe inspection.
It is compatible with Stash's OpenSubtitles hash, including its short-file behavior.
It is a lookup key, not a cryptographic integrity check. It does not tolerate
re-encoding or edits; different files can also share an OSHASH.

Results are newline-delimited JSON, one record per file. Use npm's `--silent`
option when redirecting stdout to keep npm's script banner out of the JSONL.
Directory inputs select video extensions; explicit file inputs are probed regardless
of extension. Nested directories require `--recursive`; directory symlinks are not
followed. Errors produce an error record and exit code 1 while other files continue.

## Look up metadata

Set these in your shell or process environment:

```bash
export STASH_BOX_ENDPOINT='https://stashdb.org/graphql'
read -rsp 'Stash-box API key: ' STASH_BOX_API_KEY
export STASH_BOX_API_KEY
npm run --silent metadata -- lookup '/media/example.mp4'
npm run --silent metadata -- lookup --recursive '/media/videos' > results.jsonl
```

Use the endpoint and API key for the metadata service you have access to. StashDB
is an example, not a bundled database. `.env` files are not loaded automatically.
The CLI also accepts `--endpoint URL`; keys are only read from the environment.

Only hashes and algorithm names are sent. No paths, images, or video bytes are
uploaded. Requests are read-only queries; the wrapper does not submit fingerprints
to the shared catalog or change Kiwi's database.

Lookup records contain the local fingerprint record plus:

- `source`: endpoint and retrieval time.
- `status`: `unmatched`, `single_candidate`, or `ambiguous`.
- `candidates`: all distinct, non-deleted records returned by the provider,
  including IDs, titles, release dates, durations, codes, URLs, studio, cast credits
  (including credited aliases), tags, and image URLs. Images are not downloaded.

A single candidate is not guaranteed correct. Multiple candidates are never
silently reduced to the first result. An unmatched result is a successful query;
authentication, network, and GraphQL errors are failures, not unmatched results.

Requests have a 30-second timeout. HTTP 429/502/503/504 responses receive at most
two retries, respecting Retry-After up to 30 seconds; longer delays return an error
so a later job can retry. Redirects are rejected to avoid forwarding API keys.
Files are processed sequentially to bound CPU, disk, and provider load.

## Multiple providers: StashDB and ThePornDB

Keep `STASH_BOX_ENDPOINT` and `STASH_BOX_API_KEY` for StashDB. Add a separate
`TPDB_API_KEY` generated at <https://theporndb.net/user/api-tokens> with read access.
`TPDB_ENDPOINT` defaults to `https://theporndb.net/graphql`.

Once both keys are configured, `lookup` queries both providers using the same local
fingerprints. Each provider receives only its own API key. To load the repository's
ignored `.env` explicitly:

```bash
node --env-file=.env apps/scanner/src/cli.js lookup --phash '/media/example.mp4'
node --env-file=.env apps/scanner/src/cli.js lookup --provider tpdb --phash '/media/example.mp4'
node --env-file=.env apps/scanner/src/cli.js lookup --provider stashdb --phash '/media/example.mp4'
```

The default (also `--provider all`) queries providers with nonempty configured keys.
Selecting `--provider tpdb` explicitly requires `TPDB_API_KEY`; it never borrows the
StashDB key. With `--endpoint`, select a single provider; without `--provider`, the
original endpoint override uses `STASH_BOX_API_KEY`.

Single-provider output retains the original format. Multi-provider output contains
one fingerprint record and a `providers` array, each with its own `source`, `status`,
and `candidates`. IDs and matches remain separate across catalogs. Overall status is
`complete` if both queries succeeded, including unmatched results. A failed provider
produces `partial_error` and exit code 1 while retaining the other provider's results.
This also preserves results if both providers fail, with individual error messages.

ThePornDB implements the stash-box API independently. Registration and token setup
are documented in the [provider access guide](https://guidelines.stashdb.org/docs/faq_getting-started/stashdb/accessing-stash-boxes/).

## Optional perceptual fingerprints

PHASH uses Stash's standalone `phasher` command to preserve compatibility with
its frame sampling, montage, resizing, and hash algorithm. A generic image pHash
implementation is not interchangeable. PHASH can help match alternate encodes,
but trimming or adding material can prevent a match. Catalog coverage still matters.

Install Go 1.24.3+ for the one-time build, with toolchain auto-download enabled if
required by dependencies, then run:

```bash
npm run metadata:build-phasher
npm run --silent metadata -- fingerprint --phash '/media/example.mp4'
npm run --silent metadata -- lookup --phash '/media/example.mp4'
```

The build pins upstream Stash **v0.31.1** and puts only the standalone executable in
`data/bin/phasher` (`phasher.exe` on Windows). Go is not needed at runtime.
`ffmpeg` and `ffprobe` must both be on PATH for PHASH. The command decodes sampled
frames on CPU and takes longer than OSHASH; it has a 120-second per-process timeout.
`--phash` includes both fingerprints in the lookup. If PHASH generation fails, the
file reports an error rather than silently falling back to a weaker lookup.

An existing binary can be selected with `--phasher /path/to/phasher` or
`KIWI_PHASHER_PATH`. Without either, the CLI tries `data/bin/phasher`, then PATH.
Use `--ffprobe` or `KIWI_FFPROBE_PATH` to override the wrapper's probe executable;
the upstream phasher independently resolves both FFmpeg tools from PATH.

## Cache and monorepo integration

The CLI caches fingerprints under `data/fingerprints` (`KIWI_DATA_DIR` overrides
the data root). Keys include the absolute path, device/inode, file size, nanosecond
modification/change times, and fingerprint options. Replaced or modified files
are recomputed. Writes are atomic; files changing during hashing are rejected.
Metadata responses are fetched fresh on every lookup.

Use `--cache-dir PATH` to choose a different cache or `--no-cache` to disable it.
Clear the cache after replacing FFprobe/phasher at the same executable path; tool
versions are not introspected. Cache files may be deleted at any time.

Other workspace packages can declare `"@kiwi/stash-box": "0.1.0"` as a dependency:

```js
import { fingerprintFile, identifyFile, StashBoxClient } from '@kiwi/stash-box';

const client = new StashBoxClient({
  endpoint: process.env.STASH_BOX_ENDPOINT,
  apiKey: process.env.STASH_BOX_API_KEY,
});

const result = await identifyFile('/media/example.mp4', {
  client,
  cacheDir: '/path/to/kiwi/data/fingerprints',
  // phash: true, phasherPath: '/path/to/kiwi/data/bin/phasher',
});

// For batching: preserve one fingerprint array per file, in the same order.
const file = await fingerprintFile('/media/example.mp4');
const [candidates] = await client.findScenesByFingerprints([file.fingerprints]);
```

The library is independent of Kiwi's database. A worker can consume its results
without spawning the CLI. API results preserve provider IDs for future upserts;
automatic importing and changes to Kiwi's existing scan jobs are outside this wrapper.

## Verification and upstream contracts

```bash
npm run test -w @kiwi/stash-box
npm run test -w @kiwi/scanner
```

Tests use upstream OSHASH vectors, locally generated synthetic videos, and a mock
stash-box HTTP service. They need FFmpeg/FFprobe but no provider credentials.

- [Stash OSHASH implementation and vectors](https://github.com/stashapp/stash/tree/v0.31.1/pkg/hash/oshash)
- [Stash standalone phasher](https://github.com/stashapp/stash/blob/v0.31.1/cmd/phasher/main.go)
- [stash-box fingerprint query schema](https://github.com/stashapp/stash-box/blob/b4b8aef21372e3843240e3260c5123443239f2fb/graphql/schema/schema.graphql)
- [stash-box scene and fingerprint types](https://github.com/stashapp/stash-box/blob/b4b8aef21372e3843240e3260c5123443239f2fb/graphql/schema/types/scene.graphql)

The independently implemented OSHASH is checked against upstream compatibility
vectors. The optional upstream `phasher` executable is distributed under Stash's
[AGPL-3.0 license](https://github.com/stashapp/stash/blob/v0.31.1/LICENSE);
its source is linked above and is not vendored into this package.

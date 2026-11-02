# Kiwi

## The app is already running

Kiwi runs all the time on this machine as systemd **user** services, against the real `data/kiwi.db`:

| Service | Port | What |
|---|---|---|
| `kiwi-web` | 4173 | `next start`, the production build in `apps/web/.next` |
| `kiwi-api` | 3333 | Fastify API; the web app proxies `/api/*` and `/generated/*` to it |
| `kiwi-worker` | — | Background jobs (scans, downloads, catalog sync) |

They are grouped under `kiwi.target`; the unit files live in `~/.config/systemd/user/`, not the repo.

**Don't start another copy to see a change. Rebuild and restart, then refresh http://localhost:4173:**

```sh
npm run build -w web                                        # only if apps/web changed
systemctl --user restart kiwi-api kiwi-web kiwi-worker      # or just the ones that changed
```

- Web changes only appear after the build plus a `kiwi-web` restart. Server, worker, and package changes need a `kiwi-api` / `kiwi-worker` restart.
- Restarting the API runs migrations (`packages/database/src/index.js`) on the **real** database. Back it up first when a change touches the schema: `sqlite3 data/kiwi.db "VACUUM INTO 'data/backups/kiwi-before-<change>-<date>.db'"`.
- `npm run dev` and `npm test` clash with the services: dev wants the same ports, and `npm test` ends with `npm run build -w web`, which rewrites the live `.next`. Run workspace tests individually instead (`npm run test -w @kiwi/server`, etc.) with `KIWI_DATA_DIR` pointing at a temp dir.
- For an isolated preview, run the API on another port with `KIWI_DATA_DIR` set to a `VACUUM INTO` copy of the DB, and `next dev` (it writes to `.next/dev`, not the production build) with `KIWI_API_ORIGIN` pointing at it.
- Logs: `journalctl --user -u kiwi-api -u kiwi-web -u kiwi-worker`.
- Never `pkill -f` with a pattern that also matches your own shell command. To find a process, check `/proc/<pid>/environ` (e.g. for `KIWI_API_PORT`).

## Profiles and content ratings

Every API request runs as a profile (`apps/server/src/profiles.js` sets it per request; `currentProfile()` and `currentUserId()` come from `packages/database/src/ratings.js`). What a profile can see is decided in one place: add `assetVisibleSql(alias)` / `titleVisibleSql(alias)` to any new query that lists assets or titles. Don't add a second way to hide content, such as tag-based blocking or an NSFW flag. NSFW is the top rung of the one rating ladder.

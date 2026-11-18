---
name: deploy
description: Deploy Kiwi to production — back up the real database, pull main, rebuild the web app, restart the kiwi-api / kiwi-web / kiwi-worker services, and check they came back. Use when the user asks to deploy, ship, release, update or restart the server, or "put this live". Works whether Claude is running on the production machine itself or on another machine (such as the Mac) that has to reach production remotely.
---

# Deploy Kiwi

Kiwi runs in exactly one place: the production machine. The user may be talking to you **from that machine or from any other one**, so the first job is always to work out where you are. Every command below runs **on production**. Do it directly if you're already there, and through the remote route if you're not.

## 1. Work out where you are

Run:

```sh
uname -s; hostname; systemctl --user cat kiwi-api >/dev/null 2>&1 && echo "kiwi services here" || echo "no kiwi services here"
```

| What you see | Where you are | How to run the deploy |
|---|---|---|
| Linux, hostname `cachyos-agents`, and `kiwi services here` | **Production.** The repo is `/home/devdebonair/programs/node/kiwi` and the real DB is `data/kiwi.db` inside it. Node 22 is at `~/.local/bin/node`, and `sqlite3` and `gh` (logged in) are installed. There's no Xcode. | Run the commands below directly, from the repo root. |
| Anything else (e.g. macOS, `Vincents-Laptop`, with checkout `/Users/vincentmoore/programs/kiwi-media`) | **Not production.** This checkout has no services and at most a stub DB. | Don't run the deploy here. Run it on production (next table). |

Only the production machine runs Kiwi. Never start, build into, or restart a Kiwi copy on another machine to "deploy" it, and never treat a non-production checkout's `data/kiwi.db` as the real one. When `CLAUDE.md` says "this machine", it means production.

**Reaching production from another machine:**

| Option | How |
|---|---|
| T3 linked environment (preferred) | Load and call `t3_environment_links` and look for `cachyos-agents` (environmentId `3edc1f46-1551-4a1c-8c47-f106980d233d`, project id `5a59e502-d251-4fa2-a9bb-37d441d27327`). Hand the steps in sections 3–6 to a `delegate_task` with `target.environmentId` and `target.projectId` set to those values. The child has none of your context, so put the full steps in its brief, with the specific commit or branch to deploy and the rule that it stops and reports instead of improvising when a check fails. Use `mode: "async"` and wait for its result. |
| No link, or no T3 tools | Say so and stop. Tell the user to run the deploy from the production machine, or to link it in T3 (Settings → Labs → Linked environments). Don't guess at SSH hosts, keys or passwords. |

**The Apple apps are the exception.** They build only on a Mac with Xcode (section 7). On production, or on any machine without `xcodebuild`, list the Apple step as something the user still has to do on the Mac. Don't attempt it.

## 2. Get the go-ahead

Deploying restarts the services people are watching on and can change the real database. Before you touch production, confirm with the user what is being deployed. This is normally `origin/main` after a PR merges. If they want to deploy a branch that isn't merged yet, ask whether to merge it first or check out the branch on production. The default is merge first, so production stays on `main`.

Make sure the code is on GitHub (`origin`) first. Production pulls from there, so commit and push anything that only exists on the machine you're talking from. When you're on production, `gh` there can open and merge the PR. From another machine, use that machine's `git`/`gh`.

## 3. Check production's checkout

On production, from the repo root:

```sh
git fetch origin
git status -sb          # must be on main, with no local changes
git log --oneline HEAD..origin/main
git diff --stat HEAD..origin/main
```

- If it isn't on `main`, or `git status` shows modified or untracked files, **stop and ask**. Someone, often another Claude session started on production, may have work in progress there: a feature branch, local commits, or edits. Never stash, reset, switch branches or discard work there without the user's say-so. Show them what you found (`git branch -vv`, `git log --oneline origin/main..HEAD`) and ask how to proceed.
- If `HEAD..origin/main` is empty, there's nothing to deploy. Say so. Restart only if the user asked for a restart.
- Use the diff stat to decide what the next steps need:

| Changed paths | Needs |
|---|---|
| `packages/database/**` | Back up the DB first (section 4 always does). The API restart runs the migrations on the real data. |
| `package-lock.json` / any `package.json` | `npm install` after pulling |
| `apps/web/**` | `npm run build -w web`, then restart `kiwi-web` |
| `apps/server/**`, `packages/**` | Restart `kiwi-api` |
| `apps/worker/**`, `packages/**` | Restart `kiwi-worker` |
| `apps/apple/**` | Rebuild the apps on the Mac (section 7) |

If you can't tell, restart all three. It's harmless.

## 4. Back up the database

Always do this, even when no schema change is expected:

```sh
mkdir -p data/backups
sqlite3 data/kiwi.db "VACUUM INTO 'data/backups/kiwi-before-<change>-$(date +%Y%m%d-%H%M%S).db'"   # <change>: short slug, e.g. guide-anchors
ls -lh data/backups | tail -3
```

Check that the new file exists and is about the size of `data/kiwi.db` before you go on. Recent backups have been 15–30 MB. Don't delete old backups unless the user asks.

## 5. Pull, install, build

```sh
git pull --ff-only origin main
npm install                       # only if package.json / package-lock.json changed
npm run build -w web              # only if apps/web changed
```

- `--ff-only` must succeed. If it refuses, stop and report. Don't merge or rebase on production.
- If the web build fails, don't restart `kiwi-web`. The old build in `apps/web/.next` stays up as long as the service isn't restarted. Report the error.
- Never run `npm test` (its last step rebuilds `.next` in place) or `npm run dev` / `npm start` here (they clash with the services). To test on production, run individual workspaces with a temporary data dir, e.g. `KIWI_DATA_DIR=$(mktemp -d) npm run test -w @kiwi/server`. On a Mac, use Node 22, because Node 23's SQLite lacks FTS5 and `@kiwi/database` fails to load. For example, put `~/.nvm/versions/node/v22.*/bin` first on `PATH`.

## 6. Restart and check

```sh
systemctl --user restart kiwi-api kiwi-web kiwi-worker      # or only the ones that changed
sleep 5
systemctl --user is-active kiwi-api kiwi-web kiwi-worker
curl -fsS http://localhost:3333/api/v1/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:4173/
journalctl --user -u kiwi-api -u kiwi-web -u kiwi-worker --since '-2 min' --no-pager | tail -50
```

- All three must be `active`, the health check must return `"ok":true`, and the web app must answer 200.
- Other units can flood the user journal (an `obexd` crash loop has done this), leaving only a few minutes of Kiwi lines. Check right after the restart, and use `systemctl --user status kiwi-api` if the journal is thin.
- If the deploy added a migration, confirm it ran. Look for the new table or `app_state` marker, e.g. `sqlite3 data/kiwi.db ".tables"` or `sqlite3 data/kiwi.db "select * from app_state"`.

**If it doesn't come back:**

1. Read the logs and report the error.
2. Roll back the code: `git checkout <previous HEAD>` (from `git reflog`), rebuild web if it changed, then restart.
3. Restore the backup only if the new code damaged data. Stop the services first (`systemctl --user stop kiwi-api kiwi-web kiwi-worker`), copy the backup over `data/kiwi.db`, delete any `data/kiwi.db-wal` / `data/kiwi.db-shm` left behind, and start them again.

Ask the user before restoring the database. It throws away everything written since the backup.

## 7. Apple apps (Mac only)

If `apps/apple/**` changed, the TV and phone apps need a rebuild. This works only on a Mac with Xcode and XcodeGen:

```sh
git pull --ff-only origin main
npm run apple:build            # xcodegen generate + simulator builds of KiwiiOS and KiwiTV
open apps/apple/Kiwi.xcodeproj # then run KiwiTV / KiwiiOS on the Apple TV and iPhone
```

Installing on real devices needs the user's Apple TV and iPhone and a `DEVELOPMENT_TEAM` (see `apps/apple/README.md`). Leave that step to the user unless they're at the Mac and ask you to do it. If you're on production, put "rebuild and install the Apple apps from the Mac" in your report as an open item.

## 8. Report

Tell the user:

- What was deployed: the commit range, or the PR.
- Where the backup is.
- What was rebuilt and restarted.
- The check results, and anything left open (such as the Apple apps).

# Kiwi for Apple TV and iPhone

Native Kiwi clients for Apple TV and iPhone/iPad. They're built with SwiftUI and use no dependencies beyond Apple's frameworks. Both apps live in one Xcode project, generated from `project.yml`, and share everything except their UI.

| Folder | What's there |
|---|---|
| `Shared/` | Compiled into both apps. API client and models, app state (`AppModel`: server, profile, playback requests), feeds (which rows each page shows), playback planning and the player session, image loading, and the title page model. |
| `TV/` | The tvOS UI, modeled on Netflix's 2025 TV redesign. A text-only navigation bar across the top: Search, Home, Live, Movies, Series, Anime, Videos, and the profile. Pages have a large inset billboard that describes whichever card has focus, rows underneath (including a ranked Top 10 and LIVE "On Now" cards), and a background tinted to match the artwork. The Live tab is a channel guide. The system player gains Like, plus Channel Up / Down while watching live. |
| `iOS/` | The iPhone and iPad UI, modeled on Netflix's 2026 iPhone app. Tabs are Home, Clips, Live, the profile ("My Kiwi") and Search. Home has a brand header, glass category chips, and a tinted hero card with Play and My List. Clips is Shorts as a full-screen vertical feed with a multi-level like button. Live lists what every channel is airing now. The system player opens modally, so it gets the native close button, swipe-down to dismiss, landscape rotation, Picture in Picture and AirPlay. |
| `Tests/` | Unit tests for the shared code: model decoding, the playback planner and resume rules. They run against both apps. |
| `TVUITests/`, `iOSUITests/` | Tours that walk each app against a running server and save a screenshot of every screen. |

Both apps start with a "Who's watching?" profile picker.

**Channels.** Live TV uses the server's guide (`/api/v1/guide`). Tuning in plays whatever is airing now from the current point in the program, through the normal stream flow. When the program ends, the player re-tunes to the next one, and live viewing doesn't save progress.

**Likes.** Likes match the web: each tap adds one, up to five ("Like", "Liked", "Really like", "Love it", "Love it!", "Adored"), through `PUT /assets/:id/likes`. On a title page, the like applies to the next-up asset: the movie, or the episode to watch. Liked videos appear in the profile tab. Locked profiles ask for their 4-digit PIN. Search covers both the library and the TMDB catalog. Playback resumes where you left off, saves progress the same way the web app does, and moves on to the next episode when one ends.

## Requirements

- Xcode 27, with the tvOS and iOS simulators. To download them, run `xcodebuild -downloadPlatform tvOS` and `xcodebuild -downloadPlatform iOS`.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen), installed with `brew install xcodegen`. The `.xcodeproj` is generated and not checked in.
- A running Kiwi API. The apps talk to the API directly on port 3333, not through the web app on 4173.

## Build and run

```bash
cd apps/apple
xcodegen generate          # creates Kiwi.xcodeproj
open Kiwi.xcodeproj        # run the KiwiTV or KiwiiOS scheme
```

From the repo root, `npm run apple:project`, `npm run apple:build` and `npm run apple:test` do the same steps.

In a simulator, the apps connect to `http://localhost:3333` by default, which means an API running on the same Mac. On a real device, the app asks for the server address the first time it opens, for example `http://100.122.182.74:3333` over Tailscale. **Change Server** switches to a different server: on Apple TV it's on the profile picker and the account tab, and on iPhone it's in the profile menu.

To install on a real device, set `DEVELOPMENT_TEAM` in `project.yml`. The bundle IDs are `wild.fennec.KiwiTV` and `wild.fennec.KiwiMedia`.

## Tests

```bash
# Unit tests (shared code), on each platform
xcodebuild test -project Kiwi.xcodeproj -scheme KiwiiOS -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -only-testing:KiwiiOSTests
xcodebuild test -project Kiwi.xcodeproj -scheme KiwiTV -destination 'platform=tvOS Simulator,name=Apple TV 4K (4th generation)' -only-testing:KiwiTVTests

# UI tours. These need a running API and an unlocked profile's name, and are skipped otherwise.
# Screenshots are saved in the .xcresult bundle. Use -scheme KiwiTV and -only-testing:KiwiTVUITests for Apple TV.
TEST_RUNNER_KIWI_SERVER=http://localhost:3333 TEST_RUNNER_KIWI_PROFILE=<profile name> \
xcodebuild test -project Kiwi.xcodeproj -scheme KiwiiOS -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -only-testing:KiwiiOSUITests
```

## How it works

- **Profile cookie.** The API decides which profile a request belongs to from the `kiwi_profile` cookie. API calls, artwork and AVPlayer all go through `URLSession.shared`, so they share that cookie. Image routes need it too.
- **Playback.** For each video, `POST /assets/:id/stream` reports the container and codecs. `PlaybackPlanner` then picks one of two routes:
  - **Direct play.** An MP4 or MOV file with H.264 and an audio codec AVPlayer can decode is played as-is from `/file`.
  - **HLS repackage.** Everything else (MKV, WebM, HEVC, a non-default audio track) is repackaged by the server through `/file?remux=1&hls=1…`. HEVC is tagged `hvc1` so AVPlayer accepts it, and VP9 and AV1 are re-encoded. The HLS stream begins at the resume point, and `stream-start` gives the offset so progress is saved in movie time.
- **Ratings.** Content ratings are enforced only by the server. Items a profile can't see never appear in its lists. If one is opened anyway, the server answers 404 and the app shows "unavailable."
- **Swift settings.** The apps use Swift 6 with `MainActor` as the default isolation. Both are built as the `Kiwi` module, so the shared tests can `@testable import Kiwi` on either platform.

## Not done yet

- Clips and the iPhone player can't show a like button inside the system player; like from the title page or Clips instead.

- Subtitles. The server's HLS output drops subtitle streams, so they would need to be drawn from its WebVTT tracks.
- Choosing an audio track.
- Skip intro and skip credits (the data is at `/assets/:id/segments`).
- Top Shelf content on Apple TV.
- Downloads for offline viewing on iPhone.
- Seeking past the part of an HLS stream the server has already encoded.

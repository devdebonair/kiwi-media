# Prototype Instructions

Watch history must be ordered by date watched, with the most recently watched items first.
The regular watch player must preserve portrait, square, and landscape aspect ratios without cropping; tall videos should fit within the viewport height. Shorts is an exception: use edge-to-edge, viewport-filling video with cover sizing, overlay controls and captions, and no app header, sidebar, outer margins, or permanent settings form.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

Views count once per item playback session, never per progress save, pause, or Shorts loop. Show view counts in the library and player. Each item allows up to five likes per user. Shorts is a vertically snapping video feed, defaults to videos strictly under 90 seconds, and has a persistent configurable duration limit.

Remember playback position and automatically resume unfinished videos/audio when reopened. Explicit timestamp links take priority over saved progress; completed items restart from the beginning.

## Visual direction

Video grids, including home spotlights and related videos, use a single column on mobile (680px and below).

The September 2026 user references replace the earlier light mock: use charcoal surfaces, quiet dividers, spacious media thumbnails, restrained Kiwi green accents, and a collapsible left navigation. Home should feature real library media and topics; the regular player has a related-media column on wide screens. Carry the dark theme through search, topics, feeds, history, settings, and dialogs. Preserve responsive behavior and the existing full-viewport Shorts and uncropped regular-player rules.

Likes should feel playful: each of the five likes advances the heart animation, from a small pop to a richer celebration inspired by mobile social-app reactions. Show only the heart and label; do not show tick marks, progress bars, or a numeric fraction. Keep the five-like cap and a reduced-motion alternative. Do not show a Clear button beside Like.

Library filter tags and topic labels below the player share the same pill styling, sizing, neutral colors, and circular topic image on the left when available. Tags without images remain text-only. Topic-pill labels use 14px text on desktop and 13px on phones for readability.

Mobile filter pills must keep their full content width, including avatars and label padding, inside the horizontally scrollable row.

The watch page's related-video column has no visible heading or divider above it; its first thumbnail must align with the top of the main player.

Like and Save are compact pills with matching 38px heights, 20px icons, and 13px labels. The header search is a compact 38px pill (36px on phones) and suggests matching library media and topics as the user types, with mouse, touch, and keyboard selection.

Keep the top navbar compact: 60px on desktop, 56px on tablets, and 54px on phones. Page and sidebar offsets must track its height.
Keep the header free of the “Personal library” label and settings gear; Settings remains in the sidebar. Do not show a “Back to browsing” link above the regular watch player.

Do not show the promotional “A space for your interests” block or the “A little curiosity goes a long way” footer label in the sidebar.
Do not show the home page's “A world of your own / Your library / Everything you love” heading block or its “Explore topics” link above the library filters.
Home keeps the discovery layout and shows shuffled videos. The separate Library page shows videos in newest-first order. Both pages load more videos automatically as the user scrolls.

The regular video player uses custom charcoal controls with Kiwi green accents and offers automatic codec compatibility fallback plus a manual compatibility option. Preserve uncropped aspect ratios and playback resume behavior.

Videos have a localStorage-backed playlist. Every video thumbnail has a bottom-right Add to Playlist control, revealed on hover or keyboard focus (always available on touch). Opening a video creates a queue if needed. Preserve the same player while switching between the watch page and bottom-right mini player; finished videos leave the queue, the next video plays automatically, and an empty playlist is removed. Use the existing rounded Phosphor icon family for these controls.

Keep the mini player compact, with a smaller thumbnail Add to Playlist button. Hide the original-quality/compatibility footer in the mini player, and use Phosphor chevrons for playlist collapse/expand controls.
The playlist queue automatically scrolls its own list to reveal the currently playing video when playback changes or the queue expands, without scrolling the surrounding page.
In fullscreen, video controls fade away until the cursor moves, then fade away again after movement stops. Include previous and next playlist controls in the player, disabled at the ends of the queue.
The regular player has a theater toggle that expands the video across the viewport below the top bar, moves related videos below it, and restores the standard layout when toggled off.

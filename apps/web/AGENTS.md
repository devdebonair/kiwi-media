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
Below 1800px wide (phones, tablets, laptops) the sidebar is hidden and the hamburger opens it as a YouTube-style overlay drawer over a dimmed page, with its own hamburger and logo aligned to the topbar's. Only full desktops (1800px+) dock the sidebar, where the hamburger collapses it to an icon rail. The breakpoint lives in `DRAWER_NAV_QUERY` (`src/site-shell.jsx`) and the matching `max-width: 1799px` block in `src/modern.css`.
Keep the header free of the “Personal library” label and settings gear; Settings remains in the sidebar. Do not show a “Back to browsing” link above the regular watch player.

Do not show the promotional “A space for your interests” block or the “A little curiosity goes a long way” footer label in the sidebar.
Do not show the home page's “A world of your own / Your library / Everything you love” heading block or its “Explore topics” link above the library filters.
Home keeps the discovery layout and shows shuffled videos. The separate Library page shows videos in newest-first order. Both pages load more videos automatically as the user scrolls.

The regular video player uses custom charcoal controls with Kiwi green accents and offers automatic codec compatibility fallback plus a manual compatibility option. Preserve uncropped aspect ratios and playback resume behavior.

Videos have a localStorage-backed playlist. Every video thumbnail has a bottom-right Add to Playlist control, revealed on hover or keyboard focus (always available on touch). Opening a video creates a queue if needed. Preserve the same player while switching between the watch page and bottom-right mini player; finished videos leave the queue, the next video plays automatically, and an empty playlist is removed. Use the existing rounded Phosphor icon family for these controls.

Hovering a video thumbnail with a mouse plays a muted preview after a short delay (resuming from saved progress), with a mute toggle and a draggable Kiwi-green scrubber along the bottom edge. Clicking the thumbnail opens the watch page at the preview's position via `?t=`. Previews are mouse-only, skip reduced-motion users, never count views or save progress, and live in `src/hover-preview.jsx`.
Keep the mini player compact, with a smaller thumbnail Add to Playlist button. Hide the original-quality/compatibility footer in the mini player, and use Phosphor chevrons for playlist collapse/expand controls.
The playlist queue automatically scrolls its own list to reveal the currently playing video when playback changes or the queue expands, without scrolling the surrounding page.
In fullscreen, video controls fade away until the cursor moves, then fade away again after movement stops. Include previous and next playlist controls in the player, disabled at the ends of the queue.
The regular player has a theater toggle that expands the video across the viewport below the top bar, moves related videos below it, and restores the standard layout when toggled off.

The watch page supports adding tags from a fixed-size searchable popover beside the topic pills. Match the mini player's charcoal background, border color, and 12px radius; show tag avatars and names, support arrow keys and Enter to select or create a tag.
The tag popover search field uses the same pill corner radius and compact height as the navbar search field: 38px on desktop and 36px on phones, with a leading search icon.
The tag search field matches the navbar search background in resting and focused states; use a quiet neutral focus border instead of a green highlight.
Keep the tag popover minimal: only the search field and tag list, with no visible heading, close button, or keyboard-hint footer. Dismiss with Escape or an outside click.

The top bar has a compact **Upload** pill at the right edge (icon only on phones), showing a green count badge while downloads are active. It opens the “Upload from the web” dialog for links, destination library folder and subfolder, downloader, and VPN, with a route preview and recent downloads. Dialogs render into `document.body` (`src/modal.jsx`) because the blurred topbar would contain a fixed backdrop. Downloaders, VPN profiles, and VPN-by-website rules live in Settings under `#downloads`.
The sidebar's **Downloads** page (`src/downloads-page.jsx`) shows In progress, Failed & canceled, and a collapsible Completed section, each as a table or thumbnail grid (the view and collapsed sections persist in localStorage). Completed videos reuse the library `Thumb` for hover previews. The page includes the shared bulk link form (`DownloadForm` in `src/download-dialog.jsx`), whose tags apply when downloads finish, per-item tag controls, and a sticky selection bar for tagging, retrying, canceling, or removing several downloads at once. Table columns are fixed-width so sections align; on phones, rows become stacked cards.
The sidebar's **Liked videos** page (`src/liked-page.jsx`, `/liked`) lists videos the user has liked, ordered by like count (5 → 1), then newest-first. Pill filters sit above the grid: like-level pills (heart tinted with the like button's per-level color, plus a muted count) and, after a divider, the topics most common among liked videos. A level and a topic can be combined; clicking a selected pill clears it, and All clears both. Topics that tag every liked video are omitted since they cannot narrow the list.

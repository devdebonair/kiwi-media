// Every section of the Settings page, grouped, with the individual settings inside it.
// The sidebar lists the sections; its search box looks through all of it so you can jump straight to one field.
// `section` and `target` are element ids on the page; a target that isn't rendered falls back to its section.

export const SETTINGS_GROUPS = [
  {
    id: "household", title: "Household", sections: [
      { id: "profiles", title: "Profiles", keywords: "users people family accounts", items: [
        { label: "Add a profile", keywords: "new person user kid child" },
        { label: "Profile PINs", keywords: "lock pin passcode password code secure" },
        { label: "Content limits", keywords: "rating maturity parental controls kids teens mature nsfw adult unrated restrict" },
        { label: "Admins", keywords: "admin role permissions access member" },
      ] },
    ],
  },
  {
    id: "library", title: "Library", sections: [
      { id: "libraries", title: "Media folders", keywords: "library libraries folders directories roots sources", items: [
        { label: "Add a folder", target: "library-folder-path", keywords: "path directory connect mount drive" },
        { label: "Scan library", keywords: "scan rescan import refresh index" },
        { label: "Folder content rating", keywords: "nsfw rating adult explicit mature parental hide" },
        { label: "Folder tags", keywords: "tag tags topics label" },
        { label: "Read-only folders", keywords: "read only downloads allowed write protect" },
        { label: "Pause scanning", keywords: "pause disable enable scanning" },
      ] },
    ],
  },
  {
    id: "streaming-group", title: "Streaming", sections: [
      { id: "streaming", title: "Catalogs and sources", keywords: "providers keys api movies shows anime", items: [
        { label: "TMDB", target: "provider-tmdb", keywords: "metadata catalog api key token region language posters" },
        { label: "TorBox", target: "provider-torbox", keywords: "debrid api key streams instant" },
        { label: "Torrentio", target: "provider-torrentio", keywords: "indexer torrents releases address" },
        { label: "Nyaa", target: "provider-nyaa", keywords: "anime indexer torrents releases address" },
        { label: "OpenSubtitles", target: "provider-opensubtitles", keywords: "subtitles captions login api key username password" },
      ] },
      { id: "source-rules", title: "Source rules", keywords: "ranking releases quality", items: [
        { label: "Preferred quality", target: "rule-preferred", keywords: "resolution 1080p 720p 4k 2160p" },
        { label: "Lowest quality", target: "rule-min", keywords: "minimum resolution" },
        { label: "Highest quality", target: "rule-max", keywords: "maximum resolution 4k" },
        { label: "Size limit", target: "rule-size", keywords: "gb per hour file size bitrate bandwidth" },
        { label: "Only instant sources", target: "rule-cached", keywords: "cached torbox fast start" },
        { label: "Prefer files that play directly", target: "rule-direct", keywords: "h264 codec direct play transcode convert" },
        { label: "Allow HDR and Dolby Vision", target: "rule-hdr", keywords: "hdr dolby vision dv" },
        { label: "Avoid burned-in subtitles", target: "rule-hardsubs", keywords: "hardcoded hardsubs" },
        { label: "Never use releases containing", target: "rule-exclude", keywords: "exclude block words terms cam" },
        { label: "Preferred release groups", target: "rule-prefer", keywords: "groups favorite" },
        { label: "Avoid release groups", target: "rule-avoid", keywords: "groups block" },
        { label: "Prefer dual audio and English dubs", target: "rule-dual-audio", keywords: "anime dub dubbed japanese english" },
        { label: "Allow batch releases", target: "rule-batches", keywords: "anime season pack batch" },
        { label: "Preferred anime groups", target: "rule-anime-groups", keywords: "fansub subs groups" },
      ] },
      { id: "languages", title: "Language and subtitles", keywords: "audio playback", items: [
        { label: "Audio languages", target: "audio-languages", keywords: "audio track dub language order" },
        { label: "Subtitle languages", target: "subtitle-languages", keywords: "captions subs language order" },
        { label: "When subtitles turn on", target: "subtitle-mode", keywords: "subtitles captions automatic always off" },
      ] },
      { id: "saving-media", title: "Saving movies and episodes", keywords: "download save offline", items: [
        { label: "Download folder", target: "download-root", keywords: "destination where save" },
        { label: "Movies folder", target: "folder-movies", keywords: "path naming" },
        { label: "TV shows folder", target: "folder-shows", keywords: "series path naming" },
        { label: "Anime folder", target: "folder-anime", keywords: "path naming" },
      ] },
      { id: "cache", title: "Cache", keywords: "storage", items: [
        { label: "Clear cache", keywords: "artwork images posters storage reset" },
      ] },
    ],
  },
  {
    id: "downloads-group", title: "Downloads", sections: [
      { id: "downloads", title: "Downloaders", keywords: "upload web media", items: [
        { label: "Add a downloader", keywords: "yt-dlp youtube debrid custom api plugin" },
        { label: "Default downloader", keywords: "default" },
        { label: "Downloader cookies", keywords: "cookies login signed in" },
        { label: "Downloader plugins", keywords: "plugins custom javascript" },
      ] },
      { id: "vpn-profiles", title: "VPN profiles", keywords: "vpn privacy proxy", items: [
        { label: "Add a VPN profile", keywords: "wireguard pia proxy socks tunnel" },
      ] },
      { id: "vpn-sites", title: "VPN by website", keywords: "vpn rules", items: [
        { label: "Website VPN rules", keywords: "domain site always vpn" },
      ] },
    ],
  },
  {
    id: "system", title: "System", sections: [
      { id: "jobs", title: "Background jobs", keywords: "jobs worker queue status progress recent", items: [] },
    ],
  },
];

export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap(group => group.sections.map(section => ({ ...section, group: group.title })));

const normalize = value => String(value || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const words = value => normalize(value).split(/[^a-z0-9+]+/).filter(Boolean);

// Sections and individual settings matching every word typed (by prefix), best matches first.
export function searchSettings(query, limit = 12) {
  const terms = words(query);
  if (!terms.length) return [];
  const results = [];
  for (const section of SETTINGS_SECTIONS) {
    const entries = [{ kind: "section", label: section.title, keywords: section.keywords, target: section.id },
      ...section.items.map(item => ({ kind: "setting", label: item.label, keywords: item.keywords, target: item.target || section.id }))];
    for (const entry of entries) {
      const label = words(entry.label);
      // A setting is also found by its section's name ("source rules hdr").
      const haystack = [...label, ...words(entry.keywords), ...words(section.title), ...words(section.group)];
      if (!terms.every(term => haystack.some(word => word.startsWith(term)))) continue;
      const score = terms.reduce((total, term) => total + (label.some(word => word.startsWith(term)) ? 3 : 0) + (label[0]?.startsWith(term) ? 1 : 0), 0) + (entry.kind === "section" ? 0.5 : 0);
      results.push({ ...entry, section: section.id, sectionTitle: section.title, group: section.group, score, key: `${section.id}:${entry.kind}:${entry.label}` });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
}

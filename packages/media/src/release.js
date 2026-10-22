// Turns torrent and file names into structured facts. Everything downstream (episode matching, ranking,
// filtering) works on these fields, never on raw names.

// Word-ish boundaries that treat . _ - [ ] ( ) and spaces as separators.
const B = "(?<![a-z0-9])";
const E = "(?![a-z0-9])";
const word = source => new RegExp(`${B}(?:${source})${E}`, "i");

const LANGUAGE_TOKENS = [
  ["eng", "eng|english|en-us|en-gb|enx"], ["jpn", "jpn|jap|japanese|jp"], ["zho", "chinese|chi|zho|mandarin|cantonese|chs|cht|zh|mandarin"],
  ["kor", "kor|korean"], ["rus", "rus|russian|rutracker"], ["deu", "ger|german|deutsch|deu"], ["fra", "fre|french|truefrench|vff|vfq|vfi|vf2|fra"],
  ["ita", "ita|italian|italiano"], ["spa", "spa|spanish|castellano|latino"], ["por", "por|portuguese|dublado|ptbr|pt-br|brazilian|bludv|comando|lapumia"],
  ["pol", "pol|polish|lektor|napisy"], ["hin", "hin|hindi"], ["tam", "tam|tamil"], ["tel", "tel|telugu"], ["ukr", "ukr|ukrainian"],
  ["tur", "tur|turkish"], ["nld", "dutch|nld|nl"], ["swe", "swedish|swe"], ["ara", "arabic|ara"], ["tha", "thai|tha"], ["vie", "vietnamese|vie"],
  ["ces", "czech|cze"], ["hun", "hungarian|hun"], ["heb", "hebrew|heb"], ["ell", "greek|gre"], ["ind", "indonesian|ind"],
];
const languageRegexes = LANGUAGE_TOKENS.map(([code, source]) => [code, word(source)]);

export const FLAG_LANGUAGES = {
  "🇬🇧": "eng", "🇺🇸": "eng", "🇯🇵": "jpn", "🇨🇳": "zho", "🇹🇼": "zho", "🇭🇰": "zho", "🇰🇷": "kor", "🇷🇺": "rus", "🇩🇪": "deu", "🇫🇷": "fra",
  "🇮🇹": "ita", "🇪🇸": "spa", "🇲🇽": "spa", "🇧🇷": "por", "🇵🇹": "por", "🇵🇱": "pol", "🇮🇳": "hin", "🇺🇦": "ukr", "🇹🇷": "tur", "🇳🇱": "nld",
};

const RESOLUTIONS = [[2160, /(?<![a-z0-9])(?:2160p?|4k|uhd)(?![a-z0-9])/i], [1440, /(?<![a-z0-9])1440p(?![a-z0-9])/i], [1080, /(?<![a-z0-9])(?:1080[pi]?|fullhd|fhd)(?![a-z0-9])/i],
  [720, /(?<![a-z0-9])(?:720[pi]?|hd)(?![a-z0-9])/i], [576, /(?<![a-z0-9])576[pi]?(?![a-z0-9])/i], [480, /(?<![a-z0-9])(?:480[pi]?|sd)(?![a-z0-9])/i]];

function pickSource(text) {
  if (word("cam|camrip|hdcam|cam-?rip").test(text)) return "cam";
  if (word("hdts|telesync|pdvd|ts-?rip|hdtc|telecine").test(text) || /(?<![a-z0-9])ts(?![a-z0-9])/i.test(text) && !word("hdtv").test(text)) return "telesync";
  if (word("scr|screener|dvdscr|bdscr|r5|workprint").test(text)) return "screener";
  if (word("remux|bdremux|bd-?remux").test(text)) return "remux";
  if (word("web-?rip|webrip").test(text)) return "webrip";
  if (word("web-?dl|webdl|amzn|nf|dsnp|hmax|atvp|pcok|hulu").test(text) || word("web").test(text)) return "web-dl";
  if (word("blu-?ray|bdrip|brrip|bd-?rip|bd|bdmv|uhd-?bd").test(text)) return "bluray";
  if (word("hdtv|pdtv|dsr|tvrip|hdtvrip").test(text)) return "hdtv";
  if (word("dvd-?rip|dvd|dvd-?r|dvd5|dvd9").test(text)) return "dvd";
  return null;
}

const pad = value => String(value).padStart(2, "0");

function parseEpisodes(text) {
  // S01E02, S01E02E03, S01E02-E04, S01E02-04, S01.E02
  let match = text.match(/(?<![a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,4})((?:[ ._-]?e\d{1,4}|-\d{1,4})*)/i);
  if (match) {
    const season = Number(match[1]), episodes = [Number(match[2])];
    for (const extra of match[3].matchAll(/([ ._-]?)e?(\d{1,4})/gi)) {
      const value = Number(extra[2]), previous = episodes.at(-1);
      // A dash joins a range ("E01-E03" is episodes 1, 2, and 3); a bare "E02E03" lists them.
      if (extra[1] === "-" && value > previous && value - previous < 60) for (let next = previous + 1; next <= value; next++) episodes.push(next);
      else episodes.push(value);
    }
    return { season, episodes: [...new Set(episodes)] };
  }
  // 1x02
  match = text.match(/(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![a-z0-9]|\d)/i);
  if (match) return { season: Number(match[1]), episodes: [Number(match[2])] };
  // "Season 2 Episode 5"
  match = text.match(/season[ ._-]*(\d{1,2})[ ._,-]*(?:episode|ep|e)[ ._-]*(\d{1,4})/i);
  if (match) return { season: Number(match[1]), episodes: [Number(match[2])] };
  return null;
}

function parseSeasonPack(text) {
  // "2nd Season", "3rd Season"
  const ordinal = text.match(/(?<![a-z0-9])(\d{1,2})(?:st|nd|rd|th)[ ._-]*season(?![a-z0-9])/i);
  if (ordinal) return [Number(ordinal[1])];
  let match = text.match(/(?<![a-z0-9])s(\d{1,2})[ ._-]?-[ ._-]?s(\d{1,2})(?![a-z0-9])/i);
  if (match) { const seasons = []; for (let value = Number(match[1]); value <= Number(match[2]) && seasons.length < 40; value++) seasons.push(value); return seasons; }
  match = text.match(/seasons?[ ._-]*(\d{1,2})(?:[ ._-]*(?:-|to|&|and)[ ._-]*(?:seasons?)?[ ._-]*(\d{1,2}))?/i);
  if (match) {
    const seasons = [];
    for (let value = Number(match[1]); value <= Number(match[2] || match[1]) && seasons.length < 40; value++) seasons.push(value);
    return seasons;
  }
  match = text.match(/(?<![a-z0-9])s(\d{1,2})(?![a-z0-9]|\d)(?![ ._-]?e\d)/i);
  if (match) return [Number(match[1])];
  return null;
}

// Fansub-style numbering: "Show - 12", "Show - 12v2", "[Group] Show - 105 (1080p)", "Show E12", "Episode 12".
function parseAbsolute(text, strip) {
  const cleaned = strip(text);
  let match = cleaned.match(/(?:^|\s)-\s*(\d{1,4})(?:v\d)?(?:\s|$|\[|\(|\.)/);
  if (match) return Number(match[1]);
  match = cleaned.match(/(?<![a-z0-9])(?:ep?|episode)[ ._-]?(\d{1,4})(?:v\d)?(?![a-z0-9])/i);
  if (match) return Number(match[1]);
  return null;
}

function parseBatch(text) {
  const match = text.match(/(?:^|[\s\[(])(\d{1,4})\s*(?:-|~|to)\s*(\d{1,4})(?:[\s\])]|$)/i);
  if (match && Number(match[2]) > Number(match[1]) && Number(match[2]) - Number(match[1]) < 2000 && !/\d{4}\s*-\s*\d{4}/.test(match[0])) return [Number(match[1]), Number(match[2])];
  return null;
}

const AUDIO = [
  ["truehd", word("truehd|true-?hd")], ["atmos", word("atmos")], ["dts-hd", word("dts-?hd(?:[ ._-]?ma)?|dts-?x")], ["dts", word("dts")],
  ["eac3", word("e-?ac-?3|ddp\\d?|dd\\+|dd-?plus")], ["ac3", word("ac-?3|dd\\d?|dolby[ ._-]?digital")], ["aac", word("aac\\d?|aaclc|he-?aac")],
  ["opus", word("opus")], ["flac", word("flac")], ["mp3", word("mp3")],
];

export function parseRelease(input) {
  const raw = String(input || "");
  const name = raw.replace(/\.(mkv|mp4|m4v|avi|wmv|mov|ts|m2ts|webm|flv)$/i, "");
  const text = name.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  const group = (() => {
    const bracket = name.match(/^\s*\[([^\]]{2,40})\]/);
    if (bracket) return bracket[1].trim();
    const scene = name.match(/-([A-Za-z0-9]{2,20})(?:\[[^\]]+\])?\s*$/);
    if (scene && !/^(?:\d+p?|x26[45]|hevc|dl|rip|ray|hd|uhd|dub|sub|subs)$/i.test(scene[1])) return scene[1];
    return null;
  })();

  const resolution = (RESOLUTIONS.find(([, pattern]) => pattern.test(text)) || [])[0] ?? (/(\d{3,4})x(\d{3,4})/.test(text) ? Number(text.match(/(\d{3,4})x(\d{3,4})/)[2]) : null);
  const source = pickSource(text);

  const codec = word("x265|h[ ._-]?265|hevc|hevc10").test(text) ? "hevc" : word("av1").test(text) ? "av1" : word("x264|h[ ._-]?264|avc|h264").test(text) ? "h264"
    : word("xvid|divx").test(text) ? "xvid" : word("vp9").test(text) ? "vp9" : null;
  const bitDepth = word("10[ ._-]?bit|hi10p?|hi10|main10|x265[ ._-]?10|hevc10").test(text) ? 10 : word("8[ ._-]?bit").test(text) ? 8 : null;
  const dolbyVision = word("dv|dovi|dolby[ ._-]?vision").test(text);
  const hdr10Plus = word("hdr10\\+|hdr10plus").test(text);
  const hdr = hdr10Plus ? "hdr10+" : word("hdr10").test(text) ? "hdr10" : word("hdr").test(text) ? "hdr" : null;
  const audio = AUDIO.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  const channels = (text.match(/(?<![0-9])([1-9])[ .]([01])(?![0-9])/) || []).slice(1, 3).join(".") || null;

  // Language handling: a token beside "sub" is a subtitle language, anything else describes the audio.
  const multiSubs = word("multi[ ._-]?subs?|msubs?|multi[ ._-]?sub|esubs?|multiple[ ._-]?subtitles?|all[ ._-]?subs").test(text);
  const hardSubs = word("hc|hardsubs?|hardsubbed|hard[ ._-]?coded|korsub|hc[ ._-]?subs?").test(text);
  const subLanguages = new Set(), audioLanguages = new Set();
  for (const [code, pattern] of languageRegexes) {
    if (!pattern.test(text)) continue;
    const token = text.match(pattern)[0];
    const index = lower.indexOf(token.toLowerCase());
    const around = lower.slice(Math.max(0, index - 6), index + token.length + 6);
    if (/sub|vost|esub/.test(around) || /(?:cc|napisy)/.test(around)) subLanguages.add(code);
    else audioLanguages.add(code);
  }
  // The spelled-out "ESub"/"VOSTFR" forms mean subtitles, not an audio track.
  if (word("vostfr|vost").test(text)) { audioLanguages.delete("fra"); subLanguages.add("fra"); }
  const dualAudio = word("dual[ ._-]?audio|dual|dualaudio|multi[ ._-]?audio|multiaudio|multi(?![ ._-]?subs?)").test(text);
  const dubbed = word("dubbed|dub|eng[ ._-]?dub|english[ ._-]?dub").test(text);
  const multi = word("multi(?![ ._-]?subs?)|multi[ ._-]?audio|multiaudio|dual[ ._-]?audio|dualaudio").test(text);

  const year = (() => {
    const matches = [...text.matchAll(/(?<![a-z0-9])((?:19|20)\d{2})(?![a-z0-9])/g)].map(item => Number(item[1])).filter(value => value >= 1900 && value <= new Date().getFullYear() + 2);
    return matches.length ? matches[0] : null;
  })();

  const parsedEpisode = parseEpisodes(text);
  const packSeasons = parsedEpisode ? null : parseSeasonPack(text);
  let episode = parsedEpisode;
  const stripBrackets = value => value.replace(/\[[^\]]*\]/g, " ").replace(/\((?:\d{3,4}p|[^)]*(?:bit|hevc|x26\d|aac|flac|dual|multi|bd|web|batch)[^)]*)\)/gi, " ").replace(/\s+/g, " ").trim();
  let absolute = episode ? null : parseAbsolute(text, stripBrackets);
  // "Show S2 - 05" and "Show 2nd Season - 05" number episodes within that season.
  let seasonEpisode = null;
  if (!episode && absolute !== null && packSeasons?.length === 1) { seasonEpisode = { season: packSeasons[0], episodes: [absolute] }; absolute = null; }
  if (seasonEpisode) episode = seasonEpisode;
  const batchRange = !episode && absolute === null ? parseBatch(stripBrackets(text)) : null;
  const complete = word("complete|batch|collection|series|integrale|all[ ._-]?seasons").test(text) || Boolean(batchRange);

  // The title is whatever precedes the first release marker.
  const stop = [
    episode && text.search(/(?<![a-z0-9])s\d{1,2}[ ._-]?e\d|(?<![a-z0-9])\d{1,2}x\d{2}/i), (packSeasons || episode) && text.search(/(?<![a-z0-9])(?:s\d{1,2}(?![a-z0-9]*e\d)|seasons?[ ._-]*\d|\d{1,2}(?:st|nd|rd|th)[ ._-]*season)/i),
    year && text.search(new RegExp(`${B}${year}${E}`)), resolution && text.search(RESOLUTIONS.find(([value]) => value === resolution)?.[1] || /$^/),
    absolute !== null && text.search(/\s-\s*\d{1,4}(?:v\d)?(?:\s|$|\[|\()/), text.search(/\[[^\]]*(?:1080|720|2160|480|bd|web|hevc)[^\]]*\]/i),
    source && text.search(/(?<![a-z0-9])(?:blu-?ray|web-?dl|web-?rip|hdtv|remux|dvd-?rip|bdrip|brrip|hdcam|camrip)(?![a-z0-9])/i),
  ].filter(value => typeof value === "number" && value > 0);
  const stopAt = stop.length ? Math.min(...stop) : text.length;
  const title = text.slice(0, stopAt).replace(/^\s*\[[^\]]*\]\s*/, "").replace(/[\s\-–:([{]+$/g, "").trim();

  return {
    raw, title, year, season: episode?.season ?? (packSeasons?.length === 1 ? packSeasons[0] : null),
    seasons: episode ? [episode.season] : packSeasons || [], episodes: episode?.episodes || [], absolute, batch: batchRange,
    seasonPack: !episode && Boolean(packSeasons), complete,
    resolution, source, codec, bitDepth, hdr, dolbyVision, audio, channels,
    languages: [...audioLanguages], subLanguages: [...subLanguages], multiSubs, hardSubs, dualAudio, dubbed, multi,
    collection: word("trilog\\w*|duology|quadrilogy|pentalogy|hexalogy|collection|anthology|saga|box[ ._-]?set|filmography|movie[ ._-]?pack|complete[ ._-]?(?:series|saga|collection)|all[ ._-]?movies").test(text) || /(?<![0-9])(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}(?![0-9])/.test(text),
    group, proper: word("proper").test(text), repack: word("repack|rerip").test(text), remux: source === "remux", extended: word("extended|unrated|directors?[ ._-]?cut").test(text),
  };
}

// Normalizes names so "Frieren: Beyond Journey's End" and "Frieren Beyond Journeys End" compare equal.
export function normalizeTitle(value) {
  return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
}

// 0..1 overlap between a parsed release title and any known name for the show or movie.
export function titleScore(releaseTitle, names) {
  const release = new Set(normalizeTitle(releaseTitle).split(" ").filter(Boolean));
  if (!release.size) return 0;
  let best = 0;
  for (const name of names) {
    const tokens = normalizeTitle(name).split(" ").filter(Boolean);
    if (!tokens.length) continue;
    const shared = tokens.filter(token => release.has(token)).length;
    const score = Math.min(shared / tokens.length, shared / release.size);
    if (score > best) best = score;
  }
  return best;
}

export const episodeLabel = (season, episode) => `S${pad(season)}E${pad(episode)}`;

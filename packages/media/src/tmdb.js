import { createProviderClient, ProviderError } from "./http.js";
import { getProvider } from "./settings.js";

const HOUR = 3600, DAY = 86_400;
const ISO3 = { en: "eng", ja: "jpn", zh: "zho", cn: "zho", ko: "kor", es: "spa", fr: "fra", de: "deu", it: "ita", pt: "por", ru: "rus", hi: "hin", ar: "ara", th: "tha", tr: "tur", nl: "nld", sv: "swe", pl: "pol", id: "ind" };
export const iso3 = code => ISO3[String(code || "").toLowerCase()] || (code && String(code).length === 3 ? String(code).toLowerCase() : null);

// Services come from TMDB under several spellings; collapse them so one tag exists per service.
const SERVICE_NAMES = new Map([
  ["netflix standard with ads", "Netflix"], ["amazon prime video", "Prime Video"], ["amazon prime video with ads", "Prime Video"], ["prime video", "Prime Video"],
  ["disney plus", "Disney+"], ["disney+", "Disney+"], ["hbo max", "Max"], ["max", "Max"], ["apple tv plus", "Apple TV+"], ["apple tv+", "Apple TV+"], ["apple tv", "Apple TV+"],
  ["paramount plus", "Paramount+"], ["paramount+", "Paramount+"], ["peacock premium", "Peacock"], ["peacock premium plus", "Peacock"],
  ["crunchyroll", "Crunchyroll"], ["hulu", "Hulu"], ["netflix", "Netflix"], ["tubi tv", "Tubi"], ["amc+", "AMC+"], ["starz", "Starz"], ["showtime", "Showtime"],
]);
const SKIP_SERVICE = /(amazon channel|apple tv channel|roku premium channel|hoopla|kanopy|the roku channel|plex|pluto|youtube|google play|fandango|vudu|itunes|microsoft store)/i;
// Networks are only worth a tag when they are streaming services; broadcasters like "Nippon TV" are not.
const STREAMING = new Set(["Netflix", "Prime Video", "Disney+", "Max", "HBO", "Apple TV+", "Paramount+", "Peacock", "Hulu", "Crunchyroll", "AMC+", "Showtime", "Starz",
  "Shudder", "Tubi", "Funimation", "HIDIVE", "BritBox", "Discovery+", "Freevee", "Adult Swim", "Cinemax", "Philo", "ESPN+", "MGM+", "Sundance Now", "Acorn TV"]);
export const isStreamingService = name => STREAMING.has(name);
export function serviceName(raw) {
  const clean = String(raw || "").replace(/\s+(amazon channel|apple tv channel)$/i, "").trim();
  if (!clean || SKIP_SERVICE.test(raw)) return null;
  return SERVICE_NAMES.get(clean.toLowerCase()) || clean;
}

const year = date => { const value = Number(String(date || "").slice(0, 4)); return value > 1800 ? value : null; };

export function isAnimeSummary(raw) {
  const genres = raw.genre_ids || (raw.genres || []).map(genre => genre.id) || [];
  const countries = raw.origin_country || (raw.production_countries || []).map(country => country.iso_3166_1) || [];
  return genres.includes(16) && (raw.original_language === "ja" || countries.includes("JP"));
}

export function normalizeSummary(raw, type) {
  const isMovie = type === "movie";
  return {
    provider: "tmdb", type, tmdbId: raw.id, title: (isMovie ? raw.title : raw.name) || raw.original_title || raw.original_name || "Untitled",
    originalTitle: (isMovie ? raw.original_title : raw.original_name) || null, year: year(isMovie ? raw.release_date : raw.first_air_date),
    overview: raw.overview || "", posterPath: raw.poster_path || null, backdropPath: raw.backdrop_path || null,
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null, voteCount: raw.vote_count || 0,
    genreIds: raw.genre_ids || (raw.genres || []).map(genre => genre.id), originalLanguage: raw.original_language || null,
    originCountries: raw.origin_country || (raw.production_countries || []).map(country => country.iso_3166_1) || [],
    isAnime: isAnimeSummary(raw),
  };
}

const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };

export function normalizeDetails(raw, type, region = "US") {
  const isMovie = type === "movie";
  const summary = normalizeSummary(raw, type);
  const regionProviders = raw["watch/providers"]?.results?.[region] || {};
  const services = new Map();
  const addService = (name, logoPath, kind) => {
    const clean = serviceName(name);
    if (clean && !services.has(clean)) services.set(clean, { name: clean, logoPath: logoPath || null, kind });
  };
  for (const entry of regionProviders.flatrate || []) addService(entry.provider_name, entry.logo_path, "stream");
  for (const network of raw.networks || []) if (isStreamingService(serviceName(network.name))) addService(network.name, network.logo_path, "network");
  const certification = isMovie
    ? (raw.release_dates?.results || []).find(entry => entry.iso_3166_1 === region)?.release_dates?.map(entry => entry.certification).find(Boolean) || null
    : (raw.content_ratings?.results || []).find(entry => entry.iso_3166_1 === region)?.rating || null;
  const aliasSources = [...(raw.alternative_titles?.titles || raw.alternative_titles?.results || []).map(entry => entry.title), summary.originalTitle];
  const logos = raw.images?.logos || [];
  const logo = logos.find(entry => entry.iso_639_1 === "en") || logos[0];
  return {
    ...summary,
    tagline: raw.tagline || null, status: raw.status || null,
    runtimeMin: isMovie ? raw.runtime || null : median(raw.episode_run_time || []) || raw.last_episode_to_air?.runtime || null,
    genres: (raw.genres || []).map(genre => genre.name), certification,
    imdbId: raw.external_ids?.imdb_id || raw.imdb_id || null, tvdbId: raw.external_ids?.tvdb_id || null,
    logoPath: logo?.file_path || null,
    firstAirDate: (isMovie ? raw.release_date : raw.first_air_date) || null, lastAirDate: raw.last_air_date || null,
    seasons: isMovie ? [] : (raw.seasons || []).map(season => ({ number: season.season_number, name: season.name, overview: season.overview || "", posterPath: season.poster_path || null, airDate: season.air_date || null, episodeCount: season.episode_count || 0 })),
    services: [...services.values()], aliases: [...new Set(aliasSources.filter(Boolean))].slice(0, 20),
    cast: (raw.credits?.cast || []).slice(0, 14).map(person => ({ name: person.name, character: person.character || "", profilePath: person.profile_path || null })),
  };
}

export function normalizeEpisode(raw) {
  return { number: raw.episode_number, name: raw.name || `Episode ${raw.episode_number}`, overview: raw.overview || "", airDate: raw.air_date || null, runtimeMin: raw.runtime || null, stillPath: raw.still_path || null, rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null };
}

// Release names often use a different season split than TMDB (a long season may be two seasons there).
// An episode group that mirrors the common split lets both numberings point at the same episode.
export function pickNumberingGroup(groups) {
  const usable = (groups || []).filter(group => group.group_count > 1 || group.episode_count > 0);
  return usable.find(group => /tvdb/i.test(group.name))
    || usable.find(group => group.type === 6 && /^seasons?$/i.test(String(group.name).trim()))
    || usable.find(group => group.type === 6 && !/ova|oad|special|production|sp\b|arc|saga/i.test(group.name))
    || null;
}

// { "tmdbSeason:tmdbEpisode": { season, episode } } in the alternate numbering, only where it differs.
export function buildNumbering(detail) {
  const map = {};
  for (const group of detail.groups || []) {
    if (!group.order || /special|ova|oad/i.test(group.name)) continue;
    for (const episode of group.episodes || []) {
      const alt = { season: group.order, episode: episode.order + 1 };
      if (alt.season !== episode.season_number || alt.episode !== episode.episode_number) map[`${episode.season_number}:${episode.episode_number}`] = alt;
    }
  }
  return map;
}

export function createTmdb({ fetchImpl, config = () => getProvider("tmdb").config } = {}) {
  const auth = () => {
    const token = config().token;
    if (!token) throw new ProviderError("Add your TMDB key in Settings → Streaming to browse movies and shows.", { status: 400, provider: "tmdb" });
    return token;
  };
  const client = createProviderClient({
    name: "tmdb", baseUrl: "https://api.themoviedb.org/3", ratePerSecond: 20, burst: 30, concurrency: 8, fetchImpl,
    headers: () => { const token = auth(); return token.length > 40 ? { authorization: `Bearer ${token}` } : {}; },
    query: () => { const token = auth(); return { language: config().language || "en-US", ...(token.length > 40 ? {} : { api_key: token }) }; },
  });
  const region = () => (config().region || "US").toUpperCase();
  const typePath = type => type === "movie" ? "movie" : "tv";
  const list = async (path, type, params = {}, ttl = 6 * HOUR) => {
    const data = await client.json(path, { params, ttl, swr: DAY });
    return { page: data.page || 1, totalPages: Math.min(data.total_pages || 1, 500), results: (data.results || []).filter(item => item.media_type !== "person").map(item => normalizeSummary(item, type || (item.media_type === "movie" ? "movie" : "show"))) };
  };
  return {
    client,
    async verify() { await client.json("/configuration", { ttl: 0 }); return true; },
    search: (query, { type, page = 1 } = {}) => type
      ? list(`/search/${typePath(type)}`, type, { query, page, include_adult: false }, HOUR)
      : client.json("/search/multi", { params: { query, page, include_adult: false }, ttl: HOUR, swr: DAY }).then(data => ({
        page: data.page, totalPages: Math.min(data.total_pages || 1, 500),
        results: (data.results || []).filter(item => item.media_type === "movie" || item.media_type === "tv").map(item => normalizeSummary(item, item.media_type === "movie" ? "movie" : "show")),
      })),
    trending: (type, page = 1) => list(`/trending/${typePath(type)}/week`, type, { page }),
    popular: (type, page = 1) => list(`/${typePath(type)}/popular`, type, { page }),
    topRated: (type, page = 1) => list(`/${typePath(type)}/top_rated`, type, { page }),
    nowPlaying: (page = 1) => list("/movie/now_playing", "movie", { page }),
    airingToday: (page = 1) => list("/tv/on_the_air", "show", { page }),
    discover: (type, { genre, anime = false, sort = "popularity.desc", page = 1, year: releaseYear, minVotes } = {}) => list(`/discover/${typePath(type)}`, type, {
      sort_by: sort, page, with_genres: [genre, anime ? 16 : null].filter(Boolean).join(",") || undefined, with_original_language: anime ? "ja" : undefined,
      "vote_count.gte": minVotes ?? (sort.startsWith("vote_average") ? 300 : undefined),
      ...(type === "movie" ? { primary_release_year: releaseYear } : { first_air_date_year: releaseYear }), include_adult: false,
    }),
    genres: async type => (await client.json(`/genre/${typePath(type)}/list`, { ttl: 30 * DAY, swr: 30 * DAY })).genres || [],
    async details(type, id) {
      const append = type === "movie" ? "external_ids,credits,keywords,release_dates,watch/providers,alternative_titles,images" : "external_ids,credits,keywords,content_ratings,watch/providers,alternative_titles,images";
      const raw = await client.json(`/${typePath(type)}/${id}`, { params: { append_to_response: append, include_image_language: "en,null" }, ttl: 12 * HOUR, swr: 7 * DAY, priority: "high" });
      const details = normalizeDetails(raw, type, region());
      // TMDB tags anime inconsistently; its keyword list is a good second signal.
      if (!details.isAnime && (raw.keywords?.keywords || raw.keywords?.results || []).some(keyword => keyword.id === 210024 || /^anime$/i.test(keyword.name)) && (raw.genres || []).some(genre => genre.id === 16)) details.isAnime = true;
      return details;
    },
    async season(id, number) {
      const raw = await client.json(`/tv/${id}/season/${number}`, { ttl: 12 * HOUR, swr: 3 * DAY, priority: "high" });
      return { number: raw.season_number, name: raw.name, overview: raw.overview || "", posterPath: raw.poster_path || null, airDate: raw.air_date || null, episodes: (raw.episodes || []).map(normalizeEpisode) };
    },
    async numbering(id) {
      const listing = await client.json(`/tv/${id}/episode_groups`, { ttl: 7 * DAY, swr: 30 * DAY });
      const group = pickNumberingGroup(listing.results);
      if (!group) return { group: null, map: {} };
      const detail = await client.json(`/tv/episode_group/${group.id}`, { ttl: 7 * DAY, swr: 30 * DAY });
      return { group: group.name, map: buildNumbering(detail) };
    },
    async findByImdb(imdbId) {
      const data = await client.json(`/find/${imdbId}`, { params: { external_source: "imdb_id" }, ttl: 7 * DAY, swr: 30 * DAY });
      return [...(data.movie_results || []).map(item => normalizeSummary(item, "movie")), ...(data.tv_results || []).map(item => normalizeSummary(item, "show"))];
    },
  };
}

import { createProviderClient, ProviderError } from "./http.js";
import { getProvider } from "./settings.js";
import { srtToVtt } from "./subtitles.js";

const TWO_LETTER = { eng: "en", jpn: "ja", zho: "zh-cn", kor: "ko", spa: "es", fra: "fr", deu: "de", ita: "it", por: "pt-br", rus: "ru", ara: "ar", hin: "hi" };

// Subtitle search for releases that carry none in your language. Needs an OpenSubtitles account.
export function createOpenSubtitles({ fetchImpl, config = () => getProvider("opensubtitles").config } = {}) {
  let token = null, tokenAt = 0;
  const client = createProviderClient({
    name: "opensubtitles", baseUrl: "https://api.opensubtitles.com/api/v1", ratePerSecond: 2, burst: 3, concurrency: 2, fetchImpl,
    headers: () => ({ "api-key": config().apiKey || "", "content-type": "application/json" }),
  });
  async function login() {
    if (token && Date.now() - tokenAt < 12 * 3600_000) return token;
    const { username, password } = config();
    const body = await client.json("/login", { method: "POST", body: JSON.stringify({ username, password }), ttl: 0 });
    if (!body?.token) throw new ProviderError("OpenSubtitles rejected the login", { status: 401, provider: "opensubtitles" });
    token = body.token; tokenAt = Date.now();
    return token;
  }
  return {
    client,
    available: () => getProvider("opensubtitles").configured,
    async search({ imdbId, season, episode, language, query, year }) {
      const code = TWO_LETTER[language];
      if (!code) return [];
      const params = { languages: code, order_by: "download_count", order_direction: "desc", ai_translated: "exclude", machine_translated: "exclude" };
      if (imdbId) params.parent_imdb_id = imdbId.replace(/^tt/, ""); // series; for movies imdb_id below
      if (season != null) Object.assign(params, { season_number: season, episode_number: episode, type: "episode" });
      else { delete params.parent_imdb_id; if (imdbId) params.imdb_id = imdbId.replace(/^tt/, ""); params.type = "movie"; }
      if (!imdbId && query) { params.query = query; if (year) params.year = year; }
      const body = await client.json("/subtitles", { params, ttl: 6 * 3600, swr: 24 * 3600 });
      return (body.data || []).map(item => ({ fileId: item.attributes?.files?.[0]?.file_id, language, sdh: Boolean(item.attributes?.hearing_impaired), downloads: item.attributes?.download_count || 0, release: item.attributes?.release }))
        .filter(item => item.fileId);
    },
    async fetchTrack(row, writeVtt) {
      const auth = await login();
      const info = await client.json("/download", { method: "POST", body: JSON.stringify({ file_id: Number(row.external_id), sub_format: "srt" }), headers: { authorization: `Bearer ${auth}` }, ttl: 0 });
      if (!info?.link) throw new ProviderError("OpenSubtitles did not return a file", { provider: "opensubtitles" });
      const response = await fetch(info.link, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new ProviderError(`Subtitle download failed (${response.status})`, { provider: "opensubtitles" });
      await writeVtt(row, srtToVtt(await response.text()));
    },
  };
}

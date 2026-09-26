import { FormData } from "undici";
import { DownloadError } from "../http.js";

const mediaExtensions = /\.(mp4|mkv|webm|mov|m4v|avi|wmv|ts|m2ts|flv|mpe?g|mp3|m4a|flac|wav|ogg|opus|jpe?g|png|webp|gif)$/i;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const isMagnet = source => /^magnet:\?/i.test(source);
const accepts = source => /^https?:\/\//i.test(source) || isMagnet(source);
const cacheFields = [
  { key: "mediaOnly", label: "Only download media files from torrents", type: "boolean", default: true, help: "Skips .nfo, .txt, and other extras when a torrent contains media." },
  { key: "deleteAfter", label: "Remove from the service after downloading", type: "boolean", default: true },
  { key: "waitMinutes", label: "Maximum wait for torrents (minutes)", type: "number", default: 240 },
];

async function saveAll(ctx, links) {
  for (const [index, { url, filename }] of links.entries()) {
    ctx.progress({ message: links.length > 1 ? `Downloading file ${index + 1} of ${links.length}` : "Downloading" });
    await ctx.http.download(url, { dir: ctx.workDir, filename, onProgress: update => ctx.progress({ ...update, fraction: update.totalBytes ? (index + update.bytes / update.totalBytes) / links.length : null }) });
  }
}

// Polls until `check` returns a value, reporting remote progress meanwhile.
async function waitFor(ctx, label, check) {
  const deadline = Date.now() + (ctx.config.waitMinutes ?? 240) * 60_000;
  for (;;) {
    const result = await check();
    if (result.done) return result.value;
    ctx.progress({ message: `${label} ${result.percent != null ? `${Math.round(result.percent)}%` : "…"}`, fraction: null, speed: result.speed ?? null });
    if (Date.now() > deadline) throw new DownloadError(`${label} did not finish in time`);
    await sleep(5000, ctx.signal);
  }
}

export const realDebrid = {
  id: "real-debrid",
  name: "Real-Debrid",
  description: "Unrestricts hoster links and caches torrents or magnets with a Real-Debrid account.",
  fields: [{ key: "apiToken", label: "API token", type: "secret", required: true, help: "Find it at real-debrid.com/apitoken." }, ...cacheFields],
  accepts,
  async download(ctx) {
    const api = "https://api.real-debrid.com/rest/1.0";
    const auth = { authorization: `Bearer ${ctx.config.apiToken}` };
    const post = (path, form) => ctx.http.json(`${api}${path}`, { method: "POST", headers: auth, body: new URLSearchParams(form) });
    const unrestrict = async link => { const result = await post("/unrestrict/link", { link }); return { url: result.download, filename: result.filename }; };
    if (!isMagnet(ctx.source)) return saveAll(ctx, [await unrestrict(ctx.source)]);

    ctx.progress({ message: "Adding magnet to Real-Debrid" });
    const { id } = await post("/torrents/addMagnet", { magnet: ctx.source });
    try {
      const info = await waitFor(ctx, "Real-Debrid is caching the torrent", async () => {
        const torrent = await ctx.http.json(`${api}/torrents/info/${encodeURIComponent(id)}`, { headers: auth });
        if (["error", "virus", "dead", "magnet_error"].includes(torrent.status)) throw new DownloadError(`Real-Debrid reported the torrent as ${torrent.status}`);
        if (torrent.status === "waiting_files_selection") {
          const media = torrent.files?.filter(file => mediaExtensions.test(file.path)) || [];
          const files = ctx.config.mediaOnly !== false && media.length ? media.map(file => file.id).join(",") : "all";
          await ctx.http.request(`${api}/torrents/selectFiles/${encodeURIComponent(id)}`, { method: "POST", headers: auth, body: new URLSearchParams({ files }) });
        }
        return { done: torrent.status === "downloaded", value: torrent, percent: torrent.progress, speed: torrent.speed };
      });
      ctx.progress({ title: info.filename });
      const links = [];
      for (const link of info.links) links.push(await unrestrict(link));
      await saveAll(ctx, links);
      return { title: info.filename };
    } finally {
      if (ctx.config.deleteAfter !== false) await ctx.http.request(`${api}/torrents/delete/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
  },
};

export const torBox = {
  id: "torbox",
  name: "TorBox",
  description: "Caches torrents, magnets, and hoster links with a TorBox account.",
  fields: [{ key: "apiKey", label: "API key", type: "secret", required: true, help: "Find it in TorBox settings under API." }, ...cacheFields],
  accepts,
  async download(ctx) {
    const api = "https://api.torbox.app/v1/api", key = ctx.config.apiKey;
    const headers = { authorization: `Bearer ${key}` };
    const call = async (path, init) => {
      const body = await ctx.http.json(`${api}${path}`, { headers, ...init });
      if (body.success === false) throw new DownloadError(`TorBox: ${body.detail || body.error || "request failed"}`);
      return body.data;
    };
    const torrent = isMagnet(ctx.source);
    const kind = torrent ? { create: "/torrents/createtorrent", field: "magnet", list: "/torrents/mylist", request: "/torrents/requestdl", idParam: "torrent_id", idKey: "torrent_id", control: "/torrents/controltorrent" }
      : { create: "/webdl/createwebdownload", field: "link", list: "/webdl/mylist", request: "/webdl/requestdl", idParam: "web_id", idKey: "webdownload_id", control: "/webdl/controlwebdownload" };
    ctx.progress({ message: "Sending to TorBox" });
    const form = new FormData(); // undici's own FormData; its fetch cannot serialize the global one
    form.set(kind.field, ctx.source);
    const created = await call(kind.create, { method: "POST", body: form });
    const id = created?.[kind.idKey] ?? created?.id;
    if (id == null) throw new DownloadError(created?.queued_id ? "TorBox queued the download because all active slots are in use" : "TorBox did not return a download ID");
    try {
      const item = await waitFor(ctx, "TorBox is caching the download", async () => {
        const row = await call(`${kind.list}?id=${encodeURIComponent(id)}&bypass_cache=true`);
        const entry = Array.isArray(row) ? row[0] : row;
        if (/error|failed|stalled \(no seeds\)/i.test(entry?.download_state || "")) throw new DownloadError(`TorBox reported: ${entry.download_state}`);
        return { done: Boolean(entry?.download_present || entry?.download_finished && entry?.files?.length), value: entry, percent: entry?.progress != null ? entry.progress * 100 : null, speed: entry?.download_speed };
      });
      const media = item.files?.filter(file => mediaExtensions.test(file.name || file.short_name || "")) || [];
      const files = ctx.config.mediaOnly !== false && media.length ? media : item.files || [];
      const links = [];
      for (const file of files) {
        const query = new URLSearchParams({ token: key, [kind.idParam]: id, file_id: file.id, zip_link: "false" });
        links.push({ url: await call(`${kind.request}?${query}`), filename: file.short_name || file.name?.split("/").pop() });
      }
      ctx.progress({ title: item.name });
      await saveAll(ctx, links);
      return { title: item.name };
    } finally {
      if (ctx.config.deleteAfter !== false) await ctx.http.request(`${api}${kind.control}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ [torrent ? "torrent_id" : "webdl_id"]: id, operation: "delete" }) }).catch(() => {});
    }
  },
};

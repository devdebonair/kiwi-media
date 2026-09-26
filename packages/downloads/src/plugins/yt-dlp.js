import { DownloadError } from "../http.js";

const number = value => value === "NA" || value === undefined ? null : Number(value);

export function ytDlpArgs({ source, config, workDir, proxyUrl, cookiesFile, jsRuntime = process.execPath }) {
  const template = config.outputTemplate || "%(title).180B [%(id)s].%(ext)s";
  const args = [
    "--newline", "--no-colors", "--progress", "--no-simulate", "--ignore-config",
    "--print", "before_dl:KIWI-TITLE %(title)j",
    "--progress-template", "download:KIWI-PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
    "-P", workDir, "-o", template, config.allowPlaylists ? "--yes-playlist" : "--no-playlist",
    "-f", config.format || "bv*+ba/b",
    // YouTube needs a JavaScript runtime; reuse the Node binary Kiwi already runs on.
    "--js-runtimes", `node:${jsRuntime}`,
  ];
  if (config.mergeMp4 !== false) args.push("--merge-output-format", "mp4");
  if (config.rateLimit) args.push("--limit-rate", config.rateLimit);
  if (cookiesFile) args.push("--cookies", cookiesFile);
  // Native HLS/DASH fetching keeps fragments on the proxy; external ffmpeg would not honor SOCKS.
  if (proxyUrl) args.push("--proxy", proxyUrl, "--downloader", "m3u8:native", "--downloader", "dash:native");
  args.push("--", source);
  return args;
}

export default {
  id: "yt-dlp",
  name: "yt-dlp",
  description: "Downloads from YouTube and thousands of other sites.",
  cookies: true,
  requires: "yt-dlp",
  fields: [
    { key: "format", label: "Format", type: "text", default: "bv*+ba/b", help: "yt-dlp format selector. The default picks the best video and audio." },
    { key: "mergeMp4", label: "Save merged video as MP4", type: "boolean", default: true, help: "MP4 plays in more browsers without conversion." },
    { key: "allowPlaylists", label: "Download whole playlists", type: "boolean", default: false },
    { key: "outputTemplate", label: "File name template", type: "text", default: "%(title).180B [%(id)s].%(ext)s" },
    { key: "rateLimit", label: "Speed limit", type: "text", placeholder: "5M", help: "Optional maximum speed, for example 500K or 5M." },
  ],
  validate(config) {
    const template = config.outputTemplate || "";
    if (template.startsWith("/") || template.split(/[\/\\]/).includes("..")) throw new Error("File name template must stay inside the download folder.");
    if (config.rateLimit && !/^\d+(\.\d+)?[KMG]?$/i.test(config.rateLimit)) throw new Error("Speed limit must look like 500K or 5M.");
  },
  accepts: source => /^https?:\/\//i.test(source),
  async download(ctx) {
    let title;
    const errors = [];
    await ctx.run(ctx.binaryPath("yt-dlp"), ytDlpArgs(ctx), {
      onLine(line) {
        if (line.startsWith("KIWI-PROGRESS ")) {
          const [done, total, estimate, speed, eta] = line.slice(14).split(" ").map(number);
          const totalBytes = total || estimate;
          ctx.progress({ bytes: done, totalBytes, fraction: totalBytes ? done / totalBytes : null, speed, eta });
          return;
        }
        if (line.startsWith("KIWI-TITLE ")) {
          try { title = JSON.parse(line.slice(11)); ctx.progress({ title, message: "Downloading" }); } catch {}
          return;
        }
        if (line.startsWith("ERROR:")) errors.push(line.slice(6).trim());
        if (line.startsWith("[Merger]") || line.startsWith("[FixupM3u8]")) ctx.progress({ message: "Merging audio and video" });
        ctx.log(line);
      },
      onExit(code) { if (code) throw new DownloadError(errors.at(-1) || `yt-dlp exited with code ${code}`); },
    });
    return { title };
  },
};

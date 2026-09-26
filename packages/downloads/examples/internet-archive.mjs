// Example Kiwi downloader plugin. Copy it into <KIWI_DATA_DIR>/plugins/downloaders/ to enable it;
// Kiwi picks up new or changed plugin files without a restart.
//
// Always use ctx.http (or ctx.run for command-line tools) for network access: it is bound to the
// download's VPN profile. The global fetch would bypass the VPN.
export default {
  id: "internet-archive",
  name: "Internet Archive",
  description: "Searches archive.org and downloads an item's original media files.",
  // Settings shown in Kiwi. Secret fields are never sent back to the browser.
  fields: [
    { key: "formats", label: "File formats", type: "text", default: "MPEG4,h.264,Matroska,Ogg Video,VBR MP3", help: "Comma-separated archive.org format names to download." },
    { key: "maxFiles", label: "Maximum files per item", type: "number", default: 5 },
  ],
  // Optional: reject bad settings with a readable message.
  validate(config) {
    if (config.maxFiles !== undefined && (config.maxFiles < 1 || config.maxFiles > 100)) throw new Error("Maximum files must be between 1 and 100.");
  },
  // Which links this plugin can handle. Used to pick a downloader automatically.
  accepts: source => /^(https?:\/\/(www\.)?archive\.org\/details\/[^/?#]+|[A-Za-z0-9._-]+)$/.test(source),
  // Optional: enables the Search tab. Each result's `source` is what gets downloaded.
  async search({ query, http }) {
    const url = new URL("https://archive.org/advancedsearch.php");
    url.search = new URLSearchParams({ q: `(${query}) AND mediatype:(movies OR audio)`, "fl[]": "identifier", rows: "25", output: "json" }).toString();
    url.searchParams.append("fl[]", "title");
    url.searchParams.append("fl[]", "description");
    const body = await http.json(url.href);
    return body.response.docs.map(doc => ({ title: String(doc.title), source: `https://archive.org/details/${doc.identifier}`, description: String(doc.description || "").slice(0, 160) }));
  },
  // Save files into ctx.workDir. Kiwi moves them into the chosen library folder and imports them.
  async download(ctx) {
    const id = ctx.source.replace(/^https?:\/\/(www\.)?archive\.org\/details\//, "");
    ctx.progress({ message: "Reading item metadata" });
    const item = await ctx.http.json(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    if (!item.files) throw new Error(`archive.org item “${id}” was not found`);
    const formats = (ctx.config.formats || "").split(",").map(format => format.trim().toLowerCase());
    const files = item.files.filter(file => file.source === "original" && formats.includes(String(file.format).toLowerCase())).slice(0, ctx.config.maxFiles || 5);
    if (!files.length) throw new Error("No files in the chosen formats");
    ctx.progress({ title: item.metadata?.title });
    for (const [index, file] of files.entries()) {
      ctx.log(`Downloading ${file.name}`);
      await ctx.http.download(`https://archive.org/download/${encodeURIComponent(id)}/${file.name.split("/").map(encodeURIComponent).join("/")}`, {
        dir: ctx.workDir,
        filename: file.name.split("/").pop(),
        onProgress: update => ctx.progress({ ...update, fraction: update.totalBytes ? (index + update.bytes / update.totalBytes) / files.length : null }),
      });
    }
    return { title: item.metadata?.title };
  },
};

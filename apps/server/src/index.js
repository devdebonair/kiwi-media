import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import { db, generatedDir, rebuildSearch, reindexAssetSearch, reindexTopicSearch, assetWithTopics, tagAssetWithTopic } from "@kiwi/database";
import { fileURLToPath } from "node:url";
import { createPlaybackCache } from "./playback.js";
import { parseRange } from "./range.js";
import { registerTagMetadata, tagMetadata } from "./tag-metadata.js";
import { registerDownloads } from "./downloads.js";
import { registerGuide } from "./guide.js";
import { registerMedia } from "./media.js";
import { clipById, listClips, registerClips } from "./clips.js";
import { registerPlugin } from "@kiwi/downloads";
import { mediaDownloadPlugin, nextEpisodeAfter, previousEpisodeBefore, imageUrl } from "@kiwi/media";

const app = Fastify({ logger: true });
const playbackCache = createPlaybackCache(resolve(generatedDir, "playback"), {
  onError: error => app.log.error({ err: error }, "Video compatibility conversion failed"),
});
const host = process.env.KIWI_HOST || "0.0.0.0";
const port = Number(process.env.KIWI_API_PORT || 3333);
const userId = "user-local";
const serverDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const workspaceRoot = resolve(serverDir, "../../..");
const webPublic = resolve(workspaceRoot, "apps/web/public/assets");

await app.register(cors, { origin: true, credentials: true });
await app.register(fastifyStatic, { root: generatedDir, prefix: "/generated/", decorateReply: false });
await app.register(fastifyStatic, { root: webPublic, prefix: "/assets/", decorateReply: false });
registerTagMetadata(app);
// Lazy: resolveTopic is declared further down.
registerDownloads(app, { resolveTopic: (...args) => resolveTopic(...args) });
registerGuide(app);
registerPlugin(mediaDownloadPlugin);
// Lazy: resolveTopic is declared further down.
const streaming = registerMedia(app, { resolveTopic: (...args) => resolveTopic(...args) });
registerClips(app, { resolveTopic: (...args) => resolveTopic(...args) });

const engagement = id => ({
  view_count: db.prepare("SELECT count(*) count FROM asset_views WHERE asset_id=?").get(id).count,
  like_count: db.prepare("SELECT coalesce(sum(count),0) count FROM asset_likes WHERE asset_id=?").get(id).count,
  my_likes: db.prepare("SELECT count FROM asset_likes WHERE asset_id=? AND user_id=?").get(id,userId)?.count || 0,
});
// Movies and episodes from the catalog carry their title, so lists can say "Show · S1E2" and link to the series.
const catalogInfo = row => {
  if (!row.title_id) return {};
  const title = db.prepare("SELECT id,type,title,is_anime,poster_path,year FROM titles WHERE id=?").get(row.title_id);
  if (!title) return {};
  return { catalog: { titleId: title.id, type: title.type, title: title.title, isAnime: Boolean(title.is_anime), year: title.year, poster: imageUrl(title.poster_path, "w185"), season: row.season_number, episode: row.episode_number } };
};
const enrichAsset = row => ({ ...assetWithTopics(row), ...engagement(row.id), ...catalogInfo(row) });
const listAssets = (where = "1=1", params = [], limit = 60, offset = 0, orderBy = "a.added_at DESC,a.id DESC") => db.prepare(`
  SELECT a.*, EXISTS(SELECT 1 FROM saved_assets sa WHERE sa.asset_id=a.id AND sa.user_id=?) saved
  FROM assets a WHERE a.title_id IS NULL AND (${where}) ORDER BY ${orderBy} LIMIT ? OFFSET ?
`).all(userId, ...params, limit, offset).map(enrichAsset);

const searchHits = (query, kind = "all") => {
  const terms = query.split(/\s+/).filter(Boolean).map(term => `"${term.replaceAll('"', '')}"*`);
  if (!terms.length) return [];
  // Videos and clips also match through their tags, including tags implied by topic rules.
  const matches = terms.map(() => `SELECT entity_id,entity_type FROM search_index WHERE search_index MATCH ?
    UNION SELECT et.asset_id,'asset' FROM effective_asset_topics et
      JOIN search_index ON search_index.entity_id=et.topic_id AND search_index.entity_type='topic'
      WHERE search_index MATCH ?
    UNION SELECT ct.clip_id,'clip' FROM clip_topics ct
      JOIN search_index ON search_index.entity_id=ct.topic_id AND search_index.entity_type='topic'
      WHERE search_index MATCH ?`);
  const inheritedHits = db.prepare(`SELECT entity_id,entity_type FROM (
    ${matches.map(sql => `SELECT * FROM (${sql})`).join(" INTERSECT ")}
  ) ORDER BY entity_type,entity_id LIMIT 80`).all(...terms.flatMap(term => [term, term, term]));
  const rankedHits = db.prepare("SELECT entity_id,entity_type FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index) LIMIT 80").all(terms.join(" AND "));
  const seen = new Set();
  const hits = [...rankedHits, ...inheritedHits].filter(hit => {
    const key = `${hit.entity_type}:${hit.entity_id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 80);
  const titleHits = new Set();
  return hits.flatMap(hit => {
    if (hit.entity_type === "title" || (hit.entity_type === "asset" && db.prepare("SELECT title_id FROM assets WHERE id=?").get(hit.entity_id)?.title_id)) {
      if (!["all", "titles", "movies", "shows"].includes(kind)) return [];
      const titleId = hit.entity_type === "title" ? hit.entity_id : db.prepare("SELECT title_id FROM assets WHERE id=?").get(hit.entity_id).title_id;
      if (titleHits.has(titleId)) return [];
      titleHits.add(titleId);
      const title = db.prepare("SELECT * FROM titles WHERE id=?").get(titleId);
      if (!title || (kind === "movies" && title.type !== "movie") || (kind === "shows" && title.type !== "show")) return [];
      return [{ entityType: "title", id: title.id, ref: title.id, type: title.type, title: title.title, year: title.year, overview: title.overview, isAnime: Boolean(title.is_anime), inLibrary: Boolean(title.in_library), poster: imageUrl(title.poster_path, "w342") }];
    }
    if (hit.entity_type === "asset" && (kind === "all" || kind === "assets" || kind === "videos" || kind === "music" || kind === "photos" || kind === "articles")) {
      const row = db.prepare("SELECT a.*, EXISTS(SELECT 1 FROM saved_assets WHERE user_id=? AND asset_id=a.id) saved FROM assets a WHERE a.id=?").get(userId, hit.entity_id);
      if (!row) return [];
      const map = { videos: "video", music: "audio", photos: "image", articles: "article" };
      if (map[kind] && row.kind !== map[kind]) return [];
      return [{ entityType: "asset", ...enrichAsset(row) }];
    }
    if (hit.entity_type === "clip" && (kind === "all" || kind === "clips")) {
      const clip = clipById(hit.entity_id);
      return clip ? [{ entityType: "clip", ...clip }] : [];
    }
    if (hit.entity_type === "topic" && (kind === "all" || kind === "topics")) {
      const row = db.prepare("SELECT * FROM topics WHERE id=?").get(hit.entity_id);
      return row ? [{ entityType: "topic", ...row }] : [];
    }
    return [];
  });
};

app.get("/api/v1/health", async () => ({ ok: true, service: "kiwi", database: "sqlite", time: new Date().toISOString() }));

app.get("/api/v1/assets", async (req, reply) => {
  const { kind, topic, sort, seed, limit = 60, offset = 0 } = req.query;
  if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 200 || !Number.isSafeInteger(Number(offset)) || Number(offset) < 0) return reply.code(400).send({ error: "limit must be 1–200 and offset must be a nonnegative integer" });
  if (sort && sort !== "shuffle") return reply.code(400).send({ error: "Invalid sort" });
  if (sort === "shuffle" && (!Number.isSafeInteger(Number(seed)) || Number(seed) < 1 || Number(seed) > 10000)) return reply.code(400).send({ error: "seed must be an integer from 1 to 10000" });
  const orderBy = sort === "shuffle" ? `((a.rowid * (1103515245 + ${Number(seed)} * 123457)) % 2147483647), a.id` : "a.added_at DESC,a.id DESC";
  const filters = [], params = [];
  if (kind) { filters.push("a.kind=?"); params.push(kind); }
  if (topic) { filters.push("EXISTS(SELECT 1 FROM effective_asset_topics et JOIN topics t ON t.id=et.topic_id WHERE et.asset_id=a.id AND (t.slug=? OR t.id=?))"); params.push(topic, topic); }
  return listAssets(filters.join(" AND ") || "1=1", params, Number(limit), Number(offset), orderBy);
});

const shortsLimit = () => db.prepare("SELECT shorts_max_seconds FROM user_settings WHERE user_id=?").get(userId)?.shorts_max_seconds ?? 90;
app.get("/api/v1/settings", async () => ({ shortsMaxSeconds: shortsLimit() }));
app.put("/api/v1/settings", async (req, reply) => {
  const value = req.body?.shortsMaxSeconds;
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600) return reply.code(400).send({ error: "Duration must be a whole number between 1 and 3600 seconds" });
  db.prepare("INSERT INTO user_settings VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET shorts_max_seconds=excluded.shorts_max_seconds").run(userId,value);
  return { shortsMaxSeconds: value };
});
app.get("/api/v1/shorts", async (req, reply) => {
  const { limit = 20, offset = 0 } = req.query;
  if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 200 || !Number.isSafeInteger(Number(offset)) || Number(offset) < 0) return reply.code(400).send({error:"Invalid pagination"});
  return listAssets("a.kind='video' AND a.file_path IS NOT NULL AND a.file_path!='' AND a.duration_ms>0 AND a.duration_ms<?", [shortsLimit()*1000], Number(limit), Number(offset));
});
app.post("/api/v1/assets/:id/views", async (req, reply) => {
  if (!db.prepare("SELECT 1 FROM assets WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Asset not found" });
  const session = req.body?.sessionId;
  if (typeof session !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(session)) return reply.code(400).send({ error: "A valid sessionId is required" });
  db.prepare("INSERT OR IGNORE INTO asset_views VALUES (?,?,?,?)").run(userId,req.params.id,session,new Date().toISOString());
  return engagement(req.params.id);
});
app.put("/api/v1/assets/:id/likes", async (req, reply) => {
  if (!db.prepare("SELECT 1 FROM assets WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Asset not found" });
  const count = req.body?.count;
  if (!Number.isSafeInteger(count) || count < 0 || count > 5) return reply.code(400).send({ error: "Likes must be between 0 and 5" });
  db.prepare("INSERT INTO asset_likes VALUES (?,?,?) ON CONFLICT(user_id,asset_id) DO UPDATE SET count=excluded.count").run(userId,req.params.id,count);
  return engagement(req.params.id);
});

app.get("/api/v1/assets/:id", async (req, reply) => {
  const row = db.prepare("SELECT a.*, EXISTS(SELECT 1 FROM saved_assets WHERE user_id=? AND asset_id=a.id) saved FROM assets a WHERE a.id=?").get(userId, req.params.id);
  if (!row) return reply.code(404).send({ error: "Asset not found" });
  const progress = db.prepare("SELECT progress_ms, completed FROM consumption_state WHERE user_id=? AND asset_id=?").get(userId, row.id);
  const detail = { ...enrichAsset(row), progress_ms: progress?.progress_ms ?? 0, completed: progress?.completed ?? 0 };
  if (detail.catalog && detail.catalog.type === "show") {
    const next = nextEpisodeAfter(row.id);
    detail.catalog.next = next ? { id: next.id, title: next.title, season: next.season_number, episode: next.episode_number, thumbnail: next.thumbnail_url } : null;
    const previous = previousEpisodeBefore(row.id);
    detail.catalog.previous = previous ? { id: previous.id, title: previous.title, season: previous.season_number, episode: previous.episode_number } : null;
  }
  return detail;
});

app.post("/api/v1/assets/:id/playback", async (req, reply) => {
  const asset = db.prepare("SELECT file_path,kind FROM assets WHERE id=?").get(req.params.id);
  if (!asset?.file_path || !existsSync(asset.file_path)) return reply.code(404).send({ error: "Original file is unavailable" });
  if (asset.kind !== "video") return reply.code(400).send({ error: "Only videos can be converted" });
  const result = playbackCache.prepare(asset.file_path);
  return reply.header("Cache-Control", "no-store").send(result);
});

app.get("/api/v1/assets/:id/file", async (req, reply) => {
  const asset = db.prepare("SELECT file_path, title_id FROM assets WHERE id=?").get(req.params.id);
  const local = Boolean(asset?.file_path && existsSync(asset.file_path));
  if (asset && req.query.remux === "1" && (local || asset.title_id)) {
    try { return await streaming.remux(req, reply, req.params.id); }
    catch (error) { return reply.code(error.statusCode || 502).send({ error: error.message }); }
  }
  // Catalog items without a saved copy stream from TorBox.
  if (asset?.title_id && !local) {
    try { return await streaming.proxy(req, reply, req.params.id); }
    catch (error) { return reply.code(error.statusCode || 502).send({ error: error.message }); }
  }
  if (!local) return reply.code(404).send({ error: "Original file is unavailable" });
  if (req.query.compatible === "1") {
    const file = playbackCache.fileFor(asset.file_path);
    if (!existsSync(file)) return reply.code(409).send({ error: "Compatible video is not ready" });
    asset.file_path = file;
  }
  const size = statSync(asset.file_path).size;
  const contentType = mime.lookup(asset.file_path) || "application/octet-stream";
  const range = req.headers.range;
  reply.header("Accept-Ranges", "bytes").header("Content-Type", contentType);
  if (!range) return reply.header("Content-Length", size).send(createReadStream(asset.file_path));
  const parsed = parseRange(range, size);
  if (!parsed) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
  const { start, end } = parsed;
  reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
  return reply.send(createReadStream(asset.file_path, { start, end }));
});

app.get("/api/v1/search", async req => {
  const query = String(req.query.q || "").trim();
  const kind = String(req.query.kind || "all");
  if (!query) return [];
  return searchHits(query, kind);
});

// item_count is home media only; catalog titles (movies, shows, anime) are counted separately.
app.get("/api/v1/topics", async () => db.prepare(`
  SELECT t.id, t.slug, t.name, t.summary, t.avatar_url, t.topic_type,
    count(DISTINCT a.id) item_count,
    (SELECT count(DISTINCT x.title_id) FROM effective_asset_topics e JOIN assets x ON x.id=e.asset_id WHERE e.topic_id=t.id AND x.title_id IS NOT NULL) title_count,
    EXISTS(SELECT 1 FROM topic_follows f WHERE f.topic_id=t.id AND f.user_id=?) followed
  FROM topics t LEFT JOIN effective_asset_topics et ON et.topic_id=t.id LEFT JOIN assets a ON a.id=et.asset_id AND a.title_id IS NULL
  GROUP BY t.id HAVING item_count>0 OR title_count>0 ORDER BY item_count+title_count DESC
`).all(userId));

app.get("/api/v1/libraries", async () => db.prepare("SELECT id,name,absolute_path,read_only,created_at FROM library_roots ORDER BY name").all());

app.get("/api/v1/assets/:id/annotations", async req => db.prepare(`
  SELECT a.*, s.selector_type,s.start_ms,s.end_ms,s.x,s.y,s.z,s.width,s.height,s.depth,
    s.text_start,s.text_end,s.exact_quote,s.timestamp_value,
    group_concat(DISTINCT t.name) topics
  FROM annotations a LEFT JOIN annotation_selectors s ON s.annotation_id=a.id
  LEFT JOIN annotation_topics at ON at.annotation_id=a.id LEFT JOIN topics t ON t.id=at.topic_id
  WHERE a.asset_id=? GROUP BY a.id,s.id ORDER BY s.start_ms,a.created_at
`).all(req.params.id));

app.post("/api/v1/assets/:id/annotations", async (req, reply) => {
  if (!db.prepare("SELECT 1 FROM assets WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Asset not found" });
  const id = randomUUID(), timestamp = new Date().toISOString();
  const topicIds = Array.isArray(req.body?.topicIds) ? req.body.topicIds : [];
  const selectors = Array.isArray(req.body?.selectors) ? req.body.selectors : [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO annotations (id,asset_id,motivation,note_markdown,confidence,origin,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, req.params.id, selectors.some(selector => selector?.type === "time-range") ? "clipping" : req.body?.motivation || "tagging", req.body?.note || "", req.body?.confidence ?? null, "manual", req.body?.visibility || "private", timestamp, timestamp);
    const link = db.prepare("INSERT INTO annotation_topics VALUES (?,?,?)");
    for (const topicId of topicIds) link.run(id, topicId, req.body?.role || "subject");
    const insertSelector = db.prepare(`INSERT INTO annotation_selectors (id,annotation_id,selector_type,start_ms,end_ms,x,y,z,width,height,depth,text_start,text_end,exact_quote,prefix_text,suffix_text,timestamp_value,selector_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const s of selectors) insertSelector.run(randomUUID(), id, s.type, s.startMs ?? null, s.endMs ?? null, s.x ?? null, s.y ?? null, s.z ?? null, s.width ?? null, s.height ?? null, s.depth ?? null, s.textStart ?? null, s.textEnd ?? null, s.exactQuote ?? null, s.prefix ?? null, s.suffix ?? null, s.timestamp ?? null, JSON.stringify(s.extra || {}));
    db.exec("COMMIT"); rebuildSearch();
    return reply.code(201).send({ id });
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});

const folderTopics = id => db.prepare("SELECT t.id,t.slug,t.name,t.avatar_url FROM topics t JOIN folder_topics ft ON ft.topic_id=t.id WHERE ft.library_root_id=? ORDER BY t.name").all(id);

// Finds the requested tag, creating it by name if needed. Call inside a transaction.
const resolveTopic = (body, timestamp, indexNew) => {
  const topicId = body?.topicId;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (topicId !== undefined ? typeof topicId !== "string" || !topicId : !name || name.length > 100)
    return { code: 400, error: "Choose a tag or enter a name of 1–100 characters" };
  const topic = topicId ? db.prepare("SELECT * FROM topics WHERE id=?").get(topicId)
    : db.prepare("SELECT * FROM topics").all().find(row => row.name.toLowerCase() === name.toLowerCase());
  if (topic) return { topic };
  if (topicId) return { code: 404, error: "Tag not found" };
  const id = randomUUID();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tag"}-${id}`;
  db.prepare("INSERT INTO topics (id,slug,name,topic_type,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, slug, name, "topic", timestamp, timestamp);
  if (indexNew) reindexTopicSearch(id);
  return { topic: { id } };
};

// Returns true when the asset did not already carry the tag directly.
const tagAsset = tagAssetWithTopic;

const addTopic = folder => async (req, reply) => {
  const asset = db.prepare(folder ? "SELECT * FROM library_roots WHERE id=?" : "SELECT * FROM assets WHERE id=?").get(req.params.id);
  if (!asset) return reply.code(404).send({ error: folder ? "Folder not found" : "Asset not found" });
  const timestamp = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const { topic, code, error } = resolveTopic(req.body, timestamp, !folder);
    if (!topic) {
      db.exec("ROLLBACK");
      return reply.code(code).send({ error });
    }
    if (folder) {
      db.prepare("INSERT OR IGNORE INTO folder_topics VALUES (?,?,?)").run(asset.id, topic.id, timestamp);
      // Only index the topic itself; inherited tags are joined at search time.
      reindexTopicSearch(topic.id);
      db.exec("COMMIT");
      return { topics: folderTopics(asset.id) };
    }
    tagAsset(asset.id, topic.id, timestamp);
    db.exec("COMMIT");
    return { topics: assetWithTopics(asset).topics };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
};
app.post("/api/v1/assets/:id/topics", addTopic(false));
app.post("/api/v1/library/roots/:id/topics", addTopic(true));
const topicRules = id => db.prepare("SELECT t.id,t.slug,t.name,t.avatar_url FROM topics t JOIN topic_rules r ON r.target_topic_id=t.id WHERE r.source_topic_id=? ORDER BY t.name").all(id);
// Adds a standing rule: every item under the topic, now or later, also carries the tag.
// Rule tags are derived through effective_asset_topics, so removing the rule removes them.
app.post("/api/v1/topics/:id/topics", async (req, reply) => {
  const source = db.prepare("SELECT id FROM topics WHERE id=?").get(req.params.id);
  if (!source) return reply.code(404).send({ error: "Topic not found" });
  const timestamp = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const { topic, code, error } = resolveTopic(req.body, timestamp, true);
    if (!topic || topic.id === source.id) {
      db.exec("ROLLBACK");
      return reply.code(topic ? 400 : code).send({ error: topic ? "A topic cannot be tagged with itself" : error });
    }
    db.prepare("INSERT OR IGNORE INTO topic_rules VALUES (?,?,?)").run(source.id, topic.id, timestamp);
    db.exec("COMMIT");
    return { topics: topicRules(source.id) };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});
app.delete("/api/v1/topics/:id/topics/:topicId", async (req, reply) => {
  if (!db.prepare("SELECT 1 FROM topics WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Topic not found" });
  db.prepare("DELETE FROM topic_rules WHERE source_topic_id=? AND target_topic_id=?").run(req.params.id, req.params.topicId);
  return { topics: topicRules(req.params.id) };
});
app.delete("/api/v1/library/roots/:id/topics/:topicId", async (req, reply) => {
  if (!db.prepare("SELECT 1 FROM library_roots WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Folder not found" });
  db.prepare("DELETE FROM folder_topics WHERE library_root_id=? AND topic_id=?").run(req.params.id, req.params.topicId);
  return { topics: folderTopics(req.params.id) };
});

app.get("/api/v1/topics/:slug", async (req, reply) => {
  const topic = db.prepare(`SELECT t.*, EXISTS(SELECT 1 FROM topic_follows WHERE user_id=? AND topic_id=t.id) followed FROM topics t WHERE t.slug=?`).get(userId, req.params.slug);
  if (!topic) return reply.code(404).send({ error: "Topic not found" });
  const assets = listAssets("EXISTS(SELECT 1 FROM effective_asset_topics et WHERE et.asset_id=a.id AND et.topic_id=?)", [topic.id]);
  const related = db.prepare(`
    SELECT t.*, count(DISTINCT shared.asset_id) item_count FROM topics t
    JOIN effective_asset_topics et ON et.topic_id=t.id
    JOIN effective_asset_topics shared ON shared.asset_id=et.asset_id AND shared.topic_id=?
    WHERE t.id != ? GROUP BY t.id ORDER BY item_count DESC LIMIT 8
  `).all(topic.id, topic.id);
  const { item_count } = db.prepare("SELECT count(*) item_count FROM effective_asset_topics et JOIN assets a ON a.id=et.asset_id WHERE et.topic_id=? AND a.title_id IS NULL").get(topic.id);
  const titles = db.prepare(`SELECT t.* FROM titles t WHERE t.id IN (SELECT a.title_id FROM effective_asset_topics et JOIN assets a ON a.id=et.asset_id WHERE et.topic_id=? AND a.title_id IS NOT NULL)
    ORDER BY t.in_library DESC, t.rating DESC LIMIT 60`).all(topic.id).map(title => ({ ref: title.id, type: title.type, title: title.title, year: title.year, rating: title.rating, isAnime: Boolean(title.is_anime), inLibrary: Boolean(title.in_library), poster: imageUrl(title.poster_path, "w342") }));
  return { ...topic, item_count, assets, titles, clips: listClips({ topic: topic.id, limit: 48 }), related, rules: topicRules(topic.id), providerLinks: tagMetadata(topic.id).links };
});

app.post("/api/v1/topics/:id/follow", async req => {
  const exists = db.prepare("SELECT 1 FROM topic_follows WHERE user_id=? AND topic_id=?").get(userId, req.params.id);
  if (exists) db.prepare("DELETE FROM topic_follows WHERE user_id=? AND topic_id=?").run(userId, req.params.id);
  else db.prepare("INSERT INTO topic_follows VALUES (?,?,?)").run(userId, req.params.id, new Date().toISOString());
  return { followed: !exists };
});

app.get("/api/v1/feeds", async () => db.prepare("SELECT * FROM feeds ORDER BY updated_at DESC").all().map(f => ({ ...f, query: JSON.parse(f.query_json) })));

app.get("/api/v1/collections", async () => db.prepare(`SELECT c.*,count(ci.asset_id) item_count FROM collections c LEFT JOIN collection_items ci ON ci.collection_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC`).all());

app.post("/api/v1/collections", async (req, reply) => {
  const name = String(req.body?.name || "").trim(); if (!name) return reply.code(400).send({ error: "A collection name is required" });
  const id=randomUUID(),timestamp=new Date().toISOString(),slug=`${name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}-${Date.now().toString(36)}`;
  db.prepare("INSERT INTO collections VALUES (?,?,?,?,?,?,?,?)").run(id,userId,slug,name,req.body?.description||"",req.body?.visibility||"private",timestamp,timestamp);
  return reply.code(201).send({id,slug,name});
});

app.post("/api/v1/collections/:id/items", async (req, reply) => {
  const assetId=req.body?.assetId; if(!assetId)return reply.code(400).send({error:"assetId is required"});
  const position=db.prepare("SELECT coalesce(max(position),-1)+1 position FROM collection_items WHERE collection_id=?").get(req.params.id).position;
  db.prepare("INSERT OR IGNORE INTO collection_items VALUES (?,?,?,?)").run(req.params.id,assetId,position,new Date().toISOString());
  return reply.code(201).send({ok:true});
});

app.get("/api/v1/feeds/:slug", async (req, reply) => {
  const feed = db.prepare("SELECT * FROM feeds WHERE slug=?").get(req.params.slug);
  if (!feed) return reply.code(404).send({ error: "Feed not found" });
  const query = JSON.parse(feed.query_json);
  const assets = query.topicIds?.length
    ? listAssets(`EXISTS(SELECT 1 FROM effective_asset_topics et WHERE et.asset_id=a.id AND et.topic_id IN (${query.topicIds.map(() => "?").join(",")}))`, query.topicIds)
    : query.text ? searchHits(query.text, "assets").filter(item => item.entityType === "asset") : listAssets();
  return { ...feed, query, assets };
});

app.post("/api/v1/feeds", async (req, reply) => {
  const name = String(req.body?.name || "").trim();
  const query = req.body?.query || {};
  if (!name) return reply.code(400).send({ error: "A feed name is required" });
  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomUUID();
  let slug = slugBase;
  if (db.prepare("SELECT 1 FROM feeds WHERE slug=?").get(slug)) slug = `${slugBase}-${Date.now().toString(36)}`;
  const id = randomUUID(), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO feeds (id,owner_id,slug,name,description,query_json,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, userId, slug, name, req.body?.description || "", JSON.stringify(query), "private", timestamp, timestamp);
  return reply.code(201).send({ id, slug, name, query });
});

app.post("/api/v1/assets/:id/save", async req => {
  const exists = db.prepare("SELECT 1 FROM saved_assets WHERE user_id=? AND asset_id=?").get(userId, req.params.id);
  if (exists) db.prepare("DELETE FROM saved_assets WHERE user_id=? AND asset_id=?").run(userId, req.params.id);
  else db.prepare("INSERT INTO saved_assets VALUES (?,?,?)").run(userId, req.params.id, new Date().toISOString());
  return { saved: !exists };
});

// Which media a list covers: everything, home videos only, or movies and shows only.
const scopeFilter = scope => ({ undefined: "", all: "", home: " AND a.title_id IS NULL", catalog: " AND a.title_id IS NOT NULL" })[scope] ?? null;

app.get("/api/v1/history", async (req, reply) => {
  const { limit = 60, offset = 0 } = req.query;
  if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 200 || !Number.isSafeInteger(Number(offset)) || Number(offset) < 0) return reply.code(400).send({ error: "limit must be 1–200 and offset must be a nonnegative integer" });
  const scope = scopeFilter(req.query.scope);
  if (scope === null) return reply.code(400).send({ error: "scope must be all, home, or catalog" });
  return db.prepare(`SELECT a.*, cs.last_viewed_at, cs.progress_ms, cs.completed,
    EXISTS(SELECT 1 FROM saved_assets sa WHERE sa.asset_id=a.id AND sa.user_id=cs.user_id) saved
    FROM consumption_state cs JOIN assets a ON a.id=cs.asset_id
    WHERE cs.user_id=? AND cs.last_viewed_at IS NOT NULL${scope}
    ORDER BY cs.last_viewed_at DESC, a.id DESC LIMIT ? OFFSET ?
  `).all(userId, Number(limit), Number(offset)).map(enrichAsset);
});

const likedVideos = "FROM asset_likes l JOIN assets a ON a.id=l.asset_id WHERE l.user_id=? AND l.count>0 AND a.kind='video'";
app.get("/api/v1/liked", async (req, reply) => {
  const { likes, topic, limit = 60, offset = 0 } = req.query;
  if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 200 || !Number.isSafeInteger(Number(offset)) || Number(offset) < 0) return reply.code(400).send({ error: "limit must be 1–200 and offset must be a nonnegative integer" });
  if (likes !== undefined && !/^[1-5]$/.test(likes)) return reply.code(400).send({ error: "likes must be between 1 and 5" });
  const scope = scopeFilter(req.query.scope);
  if (scope === null) return reply.code(400).send({ error: "scope must be all, home, or catalog" });
  const filters = [], params = [];
  if (scope) filters.push(scope.replace(" AND ", ""));
  if (likes) { filters.push("l.count=?"); params.push(Number(likes)); }
  if (topic) { filters.push("EXISTS(SELECT 1 FROM effective_asset_topics et JOIN topics t ON t.id=et.topic_id WHERE et.asset_id=a.id AND (t.slug=? OR t.id=?))"); params.push(topic, topic); }
  return db.prepare(`SELECT a.*, EXISTS(SELECT 1 FROM saved_assets sa WHERE sa.asset_id=a.id AND sa.user_id=l.user_id) saved
    ${likedVideos}${filters.map(filter => ` AND ${filter}`).join("")}
    ORDER BY l.count DESC, a.added_at DESC, a.id DESC LIMIT ? OFFSET ?
  `).all(userId, ...params, Number(limit), Number(offset)).map(enrichAsset);
});
// Filter pills: how many liked videos sit at each like level, and the topics most common among them.
// Topics that tag every liked video would not narrow anything down, so they are left out.
app.get("/api/v1/liked/filters", async () => ({
  levels: db.prepare(`SELECT l.count likes, count(*) item_count ${likedVideos} GROUP BY l.count ORDER BY l.count DESC`).all(userId),
  topics: db.prepare(`SELECT t.id, t.slug, t.name, t.avatar_url, count(DISTINCT a.id) item_count
    FROM asset_likes l JOIN assets a ON a.id=l.asset_id JOIN effective_asset_topics et ON et.asset_id=a.id JOIN topics t ON t.id=et.topic_id
    WHERE l.user_id=? AND l.count>0 AND a.kind='video' GROUP BY t.id
    HAVING item_count < (SELECT count(*) ${likedVideos}) ORDER BY item_count DESC, t.name LIMIT 12`).all(userId, userId),
}));

app.put("/api/v1/assets/:id/progress", async (req, reply) => {
  if (!db.prepare("SELECT 1 FROM assets WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Asset not found" });
  const progress = Number(req.body?.progressMs ?? 0);
  if (!Number.isSafeInteger(progress) || progress < 0) return reply.code(400).send({ error: "progressMs must be a nonnegative integer" });
  db.prepare(`INSERT INTO consumption_state (user_id,asset_id,progress_ms,completed,last_viewed_at,view_count) VALUES (?,?,?,?,?,0)
    ON CONFLICT(user_id,asset_id) DO UPDATE SET progress_ms=excluded.progress_ms,completed=excluded.completed,last_viewed_at=excluded.last_viewed_at`).run(userId, req.params.id, progress, req.body?.completed ? 1 : 0, new Date().toISOString());
  return { ok: true };
});

app.get("/api/v1/library/roots", async () => db.prepare("SELECT * FROM library_roots ORDER BY created_at,id").all().map(root => ({ ...root, topics: folderTopics(root.id) })));

app.post("/api/v1/library/roots", async (req, reply) => {
  const input = req.body?.path;
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0")) return reply.code(400).send({ error: "An absolute folder path is required" });
  const path = resolve(input);
  try {
    if (!statSync(path).isDirectory()) throw new Error();
  } catch { return reply.code(400).send({ error: "Folder must exist on the server" }); }
  if (db.prepare("SELECT id FROM library_roots WHERE absolute_path=?").get(path)) return reply.code(409).send({ error: "Folder is already connected" });
  const id = randomUUID();
  db.prepare("INSERT INTO library_roots (id,name,absolute_path,read_only,created_at) VALUES (?,?,?,?,?)").run(id, basename(path) || path, path, 0, new Date().toISOString());
  return reply.code(201).send(db.prepare("SELECT * FROM library_roots WHERE id=?").get(id));
});

// Updates scanning (enabled) and whether downloads may be saved into the folder (readOnly).
app.patch("/api/v1/library/roots/:id", async (req, reply) => {
  const { enabled, readOnly } = req.body || {};
  if ((enabled === undefined && readOnly === undefined) || (enabled !== undefined && typeof enabled !== "boolean") || (readOnly !== undefined && typeof readOnly !== "boolean"))
    return reply.code(400).send({ error: "enabled and readOnly must be booleans" });
  const result = db.prepare("UPDATE library_roots SET enabled=coalesce(?,enabled),read_only=coalesce(?,read_only) WHERE id=?")
    .run(enabled === undefined ? null : Number(enabled), readOnly === undefined ? null : Number(readOnly), req.params.id);
  if (!result.changes) return reply.code(404).send({ error: "Folder not found" });
  return db.prepare("SELECT * FROM library_roots WHERE id=?").get(req.params.id);
});

app.post("/api/v1/library/scan", async (req, reply) => {
  const roots = db.prepare("SELECT absolute_path FROM library_roots WHERE enabled=1 ORDER BY created_at,id").all().map(row => row.absolute_path);
  if (!roots.length) return reply.code(400).send({ error: "Add or enable a folder in Settings before scanning" });
  const timestamp = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const root of roots) {
      db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), "scan-root", JSON.stringify({ root }), "queued", 0, 0, timestamp, null, null, 0, null, timestamp, timestamp);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return reply.code(202).send({ queued: roots.length, roots });
});

app.get("/api/v1/jobs", async () => db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50").all());

export { app };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await app.listen({ host, port });

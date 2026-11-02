import { db, currentUserId, assetVisibleSql, ensureWatchlist, titleVisibleSql } from "@kiwi/database";
import { addTitleToList, getMedia, getProvider, getTitle, imageUrl, syncHouseholdLibrary } from "@kiwi/media";
import { randomUUID } from "node:crypto";
import { assetAllowed, titleAllowed } from "./profiles.js";

// Lists: each profile's own collections of movies, shows, and home videos. Every profile has the Watch List,
// where the quick + buttons put things; it can't be renamed or deleted. Episodes and catalog movies are listed
// as their title. A title on anyone's list is part of the household library (see syncHouseholdLibrary).

const MAX_LISTS = 50, MAX_ITEMS_PER_REQUEST = 200;
const now = () => new Date().toISOString();
const userId = currentUserId;

class ListError extends Error { constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; } }

const ownList = id => db.prepare("SELECT * FROM lists WHERE id=? AND user_id=?").get(id, userId());
const visibleItems = `(i.title_id IS NULL OR ${"__T__"}) AND (i.asset_id IS NULL OR ${"__A__"})`;
const visible = () => visibleItems.replace("__T__", titleVisibleSql("t")).replace("__A__", assetVisibleSql("a"));

const KINDS = {
  all: "1=1",
  movies: "t.type='movie' AND t.is_anime=0",
  shows: "t.type='show' AND t.is_anime=0",
  anime: "t.is_anime=1",
  videos: "i.asset_id IS NOT NULL",
};
const SORTS = {
  added: "i.added_at DESC",
  title: "coalesce(t.title, a.title) COLLATE NOCASE",
  year: "coalesce(t.year, 0) DESC, coalesce(t.title, a.title) COLLATE NOCASE",
  rating: "coalesce(t.rating, -1) DESC, coalesce(t.title, a.title) COLLATE NOCASE",
};

const summary = (list, extra = {}) => {
  const counts = db.prepare(`SELECT count(*) total,
      sum(CASE WHEN t.type='movie' AND t.is_anime=0 THEN 1 ELSE 0 END) movies, sum(CASE WHEN t.type='show' AND t.is_anime=0 THEN 1 ELSE 0 END) shows,
      sum(CASE WHEN t.is_anime=1 THEN 1 ELSE 0 END) anime, sum(CASE WHEN i.asset_id IS NOT NULL THEN 1 ELSE 0 END) videos
    FROM list_items i LEFT JOIN titles t ON t.id=i.title_id LEFT JOIN assets a ON a.id=i.asset_id WHERE i.list_id=? AND ${visible()}`).get(list.id);
  const previews = db.prepare(`SELECT t.poster_path, a.thumbnail_url FROM list_items i LEFT JOIN titles t ON t.id=i.title_id LEFT JOIN assets a ON a.id=i.asset_id
    WHERE i.list_id=? AND ${visible()} ORDER BY i.added_at DESC LIMIT 4`).all(list.id)
    .map(row => row.poster_path ? imageUrl(row.poster_path, "w185") : row.thumbnail_url).filter(Boolean);
  return {
    id: list.id, name: list.name, system: list.system_key, createdAt: list.created_at, updatedAt: list.updated_at, previews,
    itemCount: counts.total || 0, counts: { movies: counts.movies || 0, shows: counts.shows || 0, anime: counts.anime || 0, videos: counts.videos || 0 }, ...extra,
  };
};

// { titleId } or { assetId } → what to store. A catalog episode or movie becomes its title.
function resolveItem(entry) {
  if (entry?.titleId !== undefined) {
    const title = typeof entry.titleId === "string" && getTitle(entry.titleId);
    if (!title || !titleAllowed(title.id)) throw new ListError("Title not found", 404);
    return { titleId: title.id };
  }
  if (entry?.assetId !== undefined) {
    const asset = typeof entry.assetId === "string" && db.prepare("SELECT id, title_id FROM assets WHERE id=?").get(entry.assetId);
    if (!asset || !assetAllowed(asset.id)) throw new ListError("Video not found", 404);
    if (asset.title_id) { if (!titleAllowed(asset.title_id)) throw new ListError("Title not found", 404); return { titleId: asset.title_id }; }
    return { assetId: asset.id };
  }
  throw new ListError("Each item needs a titleId or an assetId");
}
const entriesOf = body => {
  const entries = Array.isArray(body?.items) ? body.items : [body];
  if (!entries.length || entries.length > MAX_ITEMS_PER_REQUEST) throw new ListError(`Send 1–${MAX_ITEMS_PER_REQUEST} items`);
  return entries;
};
const listName = value => {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 60) throw new ListError("A list name of 1–60 characters is required");
  return name;
};
const nameTaken = (name, exceptId = null) => db.prepare("SELECT 1 FROM lists WHERE user_id=? AND lower(name)=lower(?) AND id IS NOT ?").get(userId(), name, exceptId);

export function registerLists(app, { titleCard, assetCard }) {
  const handle = fn => async (req, reply) => {
    try { return await fn(req, reply); }
    catch (error) { if (error instanceof ListError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  };
  const media = () => getMedia();
  const tmdb = () => getProvider("tmdb").configured ? media().tmdb : null;

  // Your lists, Watch List first. With ?titleId= or ?assetId=, each says whether it holds that item.
  app.get("/api/v1/lists", handle(async req => {
    ensureWatchlist(userId());
    const probe = req.query.titleId || req.query.assetId ? resolveItem(req.query.titleId ? { titleId: req.query.titleId } : { assetId: req.query.assetId }) : null;
    const lists = db.prepare("SELECT * FROM lists WHERE user_id=? ORDER BY (system_key='watchlist') DESC, lower(name), created_at").all(userId());
    const holds = list => probe ? Boolean(db.prepare(`SELECT 1 FROM list_items WHERE list_id=? AND ${probe.titleId ? "title_id" : "asset_id"}=?`).get(list.id, probe.titleId || probe.assetId)) : undefined;
    return { lists: lists.map(list => summary(list, probe ? { contains: holds(list) } : {})) };
  }));

  app.post("/api/v1/lists", handle(async (req, reply) => {
    const name = listName(req.body?.name);
    if (db.prepare("SELECT count(*) count FROM lists WHERE user_id=?").get(userId()).count >= MAX_LISTS) throw new ListError(`You can have up to ${MAX_LISTS} lists`, 409);
    if (nameTaken(name)) throw new ListError("You already have a list with that name", 409);
    const id = randomUUID(), at = now();
    db.prepare("INSERT INTO lists (id,user_id,name,system_key,created_at,updated_at) VALUES (?,?,?,NULL,?,?)").run(id, userId(), name, at, at);
    return reply.code(201).send({ list: summary(ownList(id)) });
  }));

  app.patch("/api/v1/lists/:id", handle(async (req, reply) => {
    const list = ownList(req.params.id);
    if (!list) return reply.code(404).send({ error: "List not found" });
    if (list.system_key) throw new ListError("The Watch List can't be renamed", 409);
    const name = listName(req.body?.name);
    if (nameTaken(name, list.id)) throw new ListError("You already have a list with that name", 409);
    db.prepare("UPDATE lists SET name=?, updated_at=? WHERE id=?").run(name, now(), list.id);
    return { list: summary(ownList(list.id)) };
  }));

  app.delete("/api/v1/lists/:id", handle(async (req, reply) => {
    const list = ownList(req.params.id);
    if (!list) return reply.code(404).send({ error: "List not found" });
    if (list.system_key) throw new ListError("The Watch List can't be deleted", 409);
    const titles = db.prepare("SELECT title_id FROM list_items WHERE list_id=? AND title_id IS NOT NULL").all(list.id).map(row => row.title_id);
    db.prepare("DELETE FROM lists WHERE id=?").run(list.id);
    for (const titleId of titles) syncHouseholdLibrary(titleId, { images: media().images });
    return { ok: true };
  }));

  // A list's contents, newest first by default, filtered to movies, shows, anime, or home videos.
  app.get("/api/v1/lists/:id/items", handle(async (req, reply) => {
    const list = ownList(req.params.id);
    if (!list) return reply.code(404).send({ error: "List not found" });
    const kind = KINDS[req.query.kind || "all"], order = SORTS[req.query.sort || "added"];
    if (!kind || !order) throw new ListError("kind or sort is not valid");
    const limit = Math.min(Math.max(Number(req.query.limit) || 120, 1), 500), offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = `i.list_id=? AND ${visible()} AND ${kind}`;
    const from = "FROM list_items i LEFT JOIN titles t ON t.id=i.title_id LEFT JOIN assets a ON a.id=i.asset_id";
    const rows = db.prepare(`SELECT i.title_id, i.asset_id, i.added_at ${from} WHERE ${where} ORDER BY ${order}, i.rowid DESC LIMIT ? OFFSET ?`).all(list.id, limit, offset);
    const total = db.prepare(`SELECT count(*) count ${from} WHERE ${where}`).get(list.id).count;
    const items = rows.map(row => row.title_id
      ? { kind: "title", addedAt: row.added_at, title: titleCard(getTitle(row.title_id)) }
      : { kind: "asset", addedAt: row.added_at, asset: assetCard(row.asset_id) }).filter(item => item.title || item.asset);
    return { list: summary(list), items, total };
  }));

  // Adds one item ({ titleId } / { assetId }) or several ({ items: [...] }).
  app.post("/api/v1/lists/:id/items", handle(async (req, reply) => {
    const list = ownList(req.params.id);
    if (!list) return reply.code(404).send({ error: "List not found" });
    const resolved = entriesOf(req.body).map(resolveItem);
    let added = 0;
    for (const item of resolved) {
      if (item.titleId) { if (!db.prepare("SELECT 1 FROM list_items WHERE list_id=? AND title_id=?").get(list.id, item.titleId)) added++; await addTitleToList(item.titleId, { listId: list.id, tmdb: tmdb(), images: media().images }); }
      else added += db.prepare("INSERT OR IGNORE INTO list_items (list_id,asset_id,added_at) VALUES (?,?,?)").run(list.id, item.assetId, now()).changes;
    }
    db.prepare("UPDATE lists SET updated_at=? WHERE id=?").run(now(), list.id);
    return { added, list: summary(ownList(list.id)) };
  }));

  // Removes items: { items: [{ titleId } | { assetId }] }.
  app.post("/api/v1/lists/:id/items/remove", handle(async (req, reply) => {
    const list = ownList(req.params.id);
    if (!list) return reply.code(404).send({ error: "List not found" });
    let removed = 0;
    for (const entry of entriesOf(req.body)) {
      if (typeof entry?.titleId === "string") {
        removed += db.prepare("DELETE FROM list_items WHERE list_id=? AND title_id=?").run(list.id, entry.titleId).changes;
        syncHouseholdLibrary(entry.titleId, { images: media().images });
      } else if (typeof entry?.assetId === "string") {
        const asset = db.prepare("SELECT title_id FROM assets WHERE id=?").get(entry.assetId);
        if (asset?.title_id) { removed += db.prepare("DELETE FROM list_items WHERE list_id=? AND title_id=?").run(list.id, asset.title_id).changes; syncHouseholdLibrary(asset.title_id, { images: media().images }); }
        else removed += db.prepare("DELETE FROM list_items WHERE list_id=? AND asset_id=?").run(list.id, entry.assetId).changes;
      } else throw new ListError("Each item needs a titleId or an assetId");
    }
    db.prepare("UPDATE lists SET updated_at=? WHERE id=?").run(now(), list.id);
    return { removed, list: summary(ownList(list.id)) };
  }));
}

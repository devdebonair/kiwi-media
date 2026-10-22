import { randomUUID } from "node:crypto";
import { db } from "@kiwi/database";

// Clips are tags on a time range of a video: "virtual clips" that can later be browsed as a feed without
// cutting any files. Each is an annotation (motivation 'clipping') with one time-range selector, an optional
// title, and its own tags. Clip tags never become tags of the whole video.

const MIN_MS = 500;
const MAX_MS = 6 * 3600_000;
const MAX_TOPICS = 20;

const transaction = work => {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
};

class ClipError extends Error { constructor(message, status = 400) { super(message); this.statusCode = status; } }

const topicsOf = clipId => db.prepare(`SELECT t.id,t.slug,t.name,t.avatar_url FROM annotation_topics at JOIN topics t ON t.id=at.topic_id
  WHERE at.annotation_id=? ORDER BY t.name COLLATE NOCASE`).all(clipId);

const clipRow = id => db.prepare(`SELECT a.id, a.asset_id, a.note_markdown, a.created_at, a.updated_at, s.start_ms, s.end_ms FROM annotations a
  JOIN annotation_selectors s ON s.annotation_id=a.id AND s.selector_type='time-range' WHERE a.id=? AND a.motivation='clipping'`).get(id);

const present = row => ({
  id: row.id, assetId: row.asset_id, startMs: row.start_ms, endMs: row.end_ms, title: row.note_markdown || "",
  topics: topicsOf(row.id), createdAt: row.created_at, updatedAt: row.updated_at,
});

export const clipsForAsset = assetId => db.prepare(`SELECT a.id, a.asset_id, a.note_markdown, a.created_at, a.updated_at, s.start_ms, s.end_ms FROM annotations a
  JOIN annotation_selectors s ON s.annotation_id=a.id AND s.selector_type='time-range'
  WHERE a.asset_id=? AND a.motivation='clipping' ORDER BY s.start_ms, s.end_ms, a.created_at`).all(assetId).map(present);

// Checks a range against the video. Lengths come from the catalog or a probe, so allow a little slack at the end.
function range(body, asset, current = {}) {
  const startMs = body.startMs === undefined ? current.start_ms : body.startMs;
  const endMs = body.endMs === undefined ? current.end_ms : body.endMs;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) throw new ClipError("startMs and endMs must be whole milliseconds");
  if (startMs < 0 || endMs - startMs < MIN_MS) throw new ClipError("A clip must start at 0 or later and last at least half a second");
  if (endMs - startMs > MAX_MS) throw new ClipError("A clip can be at most 6 hours long");
  if (asset.duration_ms > 0 && endMs > asset.duration_ms + 5_000) throw new ClipError("The clip ends after the video does");
  return { startMs, endMs: asset.duration_ms > 0 ? Math.min(endMs, asset.duration_ms) : endMs };
}

const title = value => {
  if (value === undefined) return undefined;
  if (value !== null && typeof value !== "string") throw new ClipError("title must be text");
  const clean = (value || "").trim();
  if (clean.length > 200) throw new ClipError("A clip title can be at most 200 characters");
  return clean;
};

export function registerClips(app, { resolveTopic }) {
  const handle = fn => async (req, reply) => {
    try { return await fn(req, reply); }
    catch (error) { if (error instanceof ClipError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  };

  // Turns [{ topicId } | { name }] into tag ids, creating named tags. Call inside a transaction.
  const topicIds = (choices, timestamp) => {
    if (!Array.isArray(choices) || choices.length > MAX_TOPICS) throw new ClipError(`Choose up to ${MAX_TOPICS} tags`);
    return [...new Set(choices.map(choice => {
      const { topic, code, error } = resolveTopic(choice, timestamp, true);
      if (!topic) throw new ClipError(error, code);
      return topic.id;
    }))];
  };
  const setTopics = (clipId, ids) => {
    db.prepare("DELETE FROM annotation_topics WHERE annotation_id=?").run(clipId);
    const insert = db.prepare("INSERT INTO annotation_topics (annotation_id,topic_id,role) VALUES (?,?,?)");
    for (const id of ids) insert.run(clipId, id, "subject");
  };
  const assetFor = id => db.prepare("SELECT id, duration_ms FROM assets WHERE id=?").get(id);

  app.get("/api/v1/assets/:id/clips", handle(async (req, reply) => {
    if (!assetFor(req.params.id)) return reply.code(404).send({ error: "Asset not found" });
    return clipsForAsset(req.params.id);
  }));

  app.post("/api/v1/assets/:id/clips", handle(async (req, reply) => {
    const asset = assetFor(req.params.id);
    if (!asset) return reply.code(404).send({ error: "Asset not found" });
    const body = req.body || {};
    const { startMs, endMs } = range(body, asset);
    const name = title(body.title) || "";
    const id = randomUUID(), timestamp = new Date().toISOString();
    transaction(() => {
      const ids = topicIds(body.topics ?? [], timestamp);
      db.prepare("INSERT INTO annotations (id,asset_id,motivation,note_markdown,origin,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, asset.id, "clipping", name, "manual", "private", timestamp, timestamp);
      db.prepare("INSERT INTO annotation_selectors (id,annotation_id,selector_type,start_ms,end_ms) VALUES (?,?,?,?,?)").run(randomUUID(), id, "time-range", startMs, endMs);
      setTopics(id, ids);
    });
    return reply.code(201).send(present(clipRow(id)));
  }));

  // Changes the range, the title, and/or the tags (the list given replaces the current tags).
  app.patch("/api/v1/clips/:id", handle(async (req, reply) => {
    const current = clipRow(req.params.id);
    if (!current) return reply.code(404).send({ error: "Clip not found" });
    const body = req.body || {};
    const { startMs, endMs } = range(body, assetFor(current.asset_id), current);
    const name = title(body.title);
    const timestamp = new Date().toISOString();
    transaction(() => {
      if (body.topics !== undefined) setTopics(current.id, topicIds(body.topics, timestamp));
      db.prepare("UPDATE annotation_selectors SET start_ms=?, end_ms=? WHERE annotation_id=? AND selector_type='time-range'").run(startMs, endMs, current.id);
      db.prepare("UPDATE annotations SET note_markdown=coalesce(?, note_markdown), updated_at=? WHERE id=?").run(name ?? null, timestamp, current.id);
    });
    return present(clipRow(current.id));
  }));

  app.delete("/api/v1/clips/:id", handle(async (req, reply) => {
    if (!clipRow(req.params.id)) return reply.code(404).send({ error: "Clip not found" });
    db.prepare("DELETE FROM annotations WHERE id=?").run(req.params.id);
    return reply.code(204).send();
  }));

  // Clips across the library, newest first, optionally for one tag (including tags implied by topic rules).
  // This is what a clips feed (e.g. in Shorts) is built on: each item says which video to open and where.
  app.get("/api/v1/clips", handle(async (req, reply) => {
    const limit = Number(req.query.limit ?? 40), offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) return reply.code(400).send({ error: "limit must be 1–200 and offset a nonnegative integer" });
    return listClips({ topic: req.query.topic ? String(req.query.topic) : undefined, asset: req.query.asset ? String(req.query.asset) : undefined, limit, offset });
  }));
}

export function listClips({ topic, asset, limit = 40, offset = 0 } = {}) {
  const filters = [], params = [];
  if (topic) {
    filters.push("EXISTS(SELECT 1 FROM clip_topics ct JOIN topics t ON t.id=ct.topic_id WHERE ct.clip_id=a.id AND (t.slug=? OR t.id=?))");
    params.push(topic, topic);
  }
  if (asset) { filters.push("a.asset_id=?"); params.push(asset); }
  const rows = db.prepare(`SELECT a.id, a.asset_id, a.note_markdown, a.created_at, a.updated_at, s.start_ms, s.end_ms,
      v.title asset_title, v.thumbnail_url, v.duration_ms, v.kind, v.title_id
    FROM annotations a JOIN annotation_selectors s ON s.annotation_id=a.id AND s.selector_type='time-range'
    JOIN assets v ON v.id=a.asset_id
    WHERE a.motivation='clipping'${filters.map(filter => ` AND ${filter}`).join("")}
    ORDER BY a.created_at DESC, a.id LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return rows.map(row => ({ ...present(row), asset: { id: row.asset_id, title: row.asset_title, thumbnail_url: row.thumbnail_url, duration_ms: row.duration_ms, kind: row.kind, catalog: Boolean(row.title_id) } }));
}

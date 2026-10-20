import { randomUUID } from "node:crypto";
import { db } from "@kiwi/database";

// Every channel loops its lineup forever from this instant, so "what's on" is the same on
// every request and device without storing a schedule.
export const GUIDE_EPOCH = Date.UTC(2026, 0, 1);
// Tags with fewer playable videos than this would repeat every few minutes, so they get no channel.
export const MIN_CHANNEL_VIDEOS = 3;
// Custom channels take the low numbers; tag channels start here, numbered by tag age.
const TAG_CHANNEL_BASE = 100;
const MAX_TOPICS = 20;
const MAX_PROGRAMS_PER_ROW = 400;
const playable = "a.kind='video' AND a.file_path IS NOT NULL AND a.file_path!='' AND a.duration_ms>0";

// FNV-1a: a stable pseudo-random lineup order that does not reshuffle when videos are added.
const hash = text => {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  return value >>> 0;
};

// Playable videos per tag, plus their durations.
const memberships = () => {
  const byTopic = new Map(), durations = new Map();
  for (const row of db.prepare(`SELECT et.topic_id, a.id, a.duration_ms FROM effective_asset_topics et JOIN assets a ON a.id=et.asset_id WHERE ${playable}`).all()) {
    if (!byTopic.has(row.topic_id)) byTopic.set(row.topic_id, new Set());
    byTopic.get(row.topic_id).add(row.id);
    durations.set(row.id, row.duration_ms);
  }
  return { byTopic, durations };
};

const combine = (byTopic, topicIds, match) => {
  const sets = topicIds.map(id => byTopic.get(id) || new Set());
  if (!sets.length) return new Set();
  if (match === "any") return new Set(sets.flatMap(set => [...set]));
  const [smallest, ...rest] = [...sets].sort((a, b) => a.size - b.size);
  return new Set([...smallest].filter(id => rest.every(set => set.has(id))));
};

const customChannels = () => {
  const topics = db.prepare(`SELECT ct.channel_id, t.id, t.slug, t.name, t.avatar_url FROM guide_channel_topics ct
    JOIN topics t ON t.id=ct.topic_id ORDER BY t.name`).all();
  return db.prepare("SELECT * FROM guide_channels ORDER BY number").all().map(channel => ({
    key: `custom:${channel.id}`, id: channel.id, number: channel.number, name: channel.name, type: "custom",
    match: channel.match_mode, avatar_url: null, topics: topics.filter(topic => topic.channel_id === channel.id).map(({ channel_id, ...topic }) => topic),
  }));
};

// All channels in number order, each with the set of video ids it airs.
export function guideChannels() {
  const { byTopic, durations } = memberships();
  const custom = customChannels().map(channel => ({ ...channel, assets: combine(byTopic, channel.topics.map(topic => topic.id), channel.match) }));
  const tags = db.prepare("SELECT id, slug, name, avatar_url, topic_type FROM topics ORDER BY created_at, id").all()
    .map((topic, index) => ({
      key: `topic:${topic.id}`, id: topic.id, slug: topic.slug, number: TAG_CHANNEL_BASE + index, name: topic.name,
      type: topic.topic_type === "person" ? "person" : "topic", avatar_url: topic.avatar_url, assets: byTopic.get(topic.id) || new Set(),
    }))
    .filter(channel => channel.assets.size >= MIN_CHANNEL_VIDEOS);
  return { channels: [...custom, ...tags], durations };
}

// The programs airing on a channel between start and end (epoch ms), including any already under way at start.
export function schedule(channel, durations, start, end) {
  const lineup = [...channel.assets].map(id => ({ id, order: hash(`${channel.key}:${id}`), duration: durations.get(id) }))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  if (!lineup.length) return [];
  const offsets = [];
  let cycle = 0;
  for (const item of lineup) { offsets.push(cycle); cycle += item.duration; }
  const into = ((start - GUIDE_EPOCH) % cycle + cycle) % cycle;
  // Last program starting at or before `into`.
  let low = 0, high = lineup.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle] <= into) low = middle; else high = middle - 1;
  }
  const programs = [];
  for (let index = low, at = start - (into - offsets[low]); at < end && programs.length < MAX_PROGRAMS_PER_ROW; index = (index + 1) % lineup.length) {
    const { id, duration } = lineup[index];
    programs.push({ id, start: at, end: at + duration });
    at += duration;
  }
  return programs;
}

const publicChannel = ({ assets, ...channel }) => ({ ...channel, item_count: assets.size });

const filters = {
  all: () => true,
  custom: channel => channel.type === "custom",
  people: channel => channel.type === "person",
  tags: channel => channel.type === "topic",
};

const integer = (value, fallback) => value === undefined ? fallback : /^-?\d+$/.test(String(value)) ? Number(value) : NaN;

const lowestFreeNumber = () => {
  const taken = new Set(db.prepare("SELECT number FROM guide_channels").all().map(row => row.number));
  for (let number = 1; number < TAG_CHANNEL_BASE; number++) if (!taken.has(number)) return number;
  return null;
};

// Validates { name, topicIds, match } for creating or editing a custom channel.
const channelInput = body => {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return { error: "Channel name must be 1–60 characters" };
  if (!["all", "any"].includes(body?.match)) return { error: "match must be \"all\" or \"any\"" };
  const topicIds = Array.isArray(body?.topicIds) ? [...new Set(body.topicIds)] : [];
  if (!topicIds.length || topicIds.length > MAX_TOPICS || !topicIds.every(id => typeof id === "string" && id))
    return { error: `Choose 1–${MAX_TOPICS} tags` };
  const known = db.prepare(`SELECT count(*) count FROM topics WHERE id IN (${topicIds.map(() => "?").join(",")})`).get(...topicIds).count;
  if (known !== topicIds.length) return { code: 404, error: "One or more tags no longer exist" };
  return { name, match: body.match, topicIds };
};

const saveTopics = (channelId, topicIds) => {
  db.prepare("DELETE FROM guide_channel_topics WHERE channel_id=?").run(channelId);
  const insert = db.prepare("INSERT INTO guide_channel_topics VALUES (?,?)");
  for (const topicId of topicIds) insert.run(channelId, topicId);
};

const transaction = work => {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
};

export function registerGuide(app) {
  // Channels (paged, in number order) with the programs airing in [start, start + hours).
  app.get("/api/v1/guide", async (req, reply) => {
    const now = Date.now();
    const start = integer(req.query.start, now), hours = integer(req.query.hours, 4);
    const limit = integer(req.query.limit, 40), offset = integer(req.query.offset, 0);
    const filter = req.query.filter || "all", q = String(req.query.q || "").trim().toLowerCase();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(hours) || hours < 1 || hours > 12) return reply.code(400).send({ error: "start must be epoch milliseconds and hours 1–12" });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) return reply.code(400).send({ error: "limit must be 1–100 and offset a nonnegative integer" });
    if (!filters[filter]) return reply.code(400).send({ error: "Invalid filter" });
    const end = start + hours * 3_600_000;
    const { channels, durations } = guideChannels();
    // `channel` picks one channel by key, e.g. for the guide's live player.
    const only = req.query.channel;
    const matching = only ? channels.filter(channel => channel.key === only)
      : channels.filter(filters[filter]).filter(channel => !q || String(channel.number) === q || channel.name.toLowerCase().includes(q));
    const page = matching.slice(offset, offset + limit).map(channel => ({ ...publicChannel(channel), programs: schedule(channel, durations, start, end) }));
    const ids = [...new Set(page.flatMap(channel => channel.programs.map(program => program.id)))];
    const details = new Map();
    // Chunked to stay under SQLite's bound-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const row of db.prepare(`SELECT id, title, thumbnail_url, duration_ms FROM assets WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk)) details.set(row.id, row);
    }
    return {
      start, end, now, total: matching.length,
      channels: page.map(channel => ({ ...channel, programs: channel.programs.map(program => ({ ...details.get(program.id), ...program })) })),
    };
  });

  // How many playable videos a tag combination would air, for the channel editor.
  app.get("/api/v1/guide/count", async (req, reply) => {
    const topicIds = String(req.query.topics || "").split(",").filter(Boolean);
    const match = req.query.match || "all";
    if (!["all", "any"].includes(match) || topicIds.length > MAX_TOPICS) return reply.code(400).send({ error: "Invalid tag combination" });
    return { item_count: combine(memberships().byTopic, topicIds, match).size };
  });

  app.get("/api/v1/guide/channels", async () => {
    const { channels } = guideChannels();
    return channels.filter(channel => channel.type === "custom").map(publicChannel);
  });

  app.post("/api/v1/guide/channels", async (req, reply) => {
    const input = channelInput(req.body);
    if (input.error) return reply.code(input.code || 400).send({ error: input.error });
    const id = randomUUID(), timestamp = new Date().toISOString();
    const number = transaction(() => {
      const number = lowestFreeNumber();
      if (number === null) return null;
      db.prepare("INSERT INTO guide_channels (id,number,name,match_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, number, input.name, input.match, timestamp, timestamp);
      saveTopics(id, input.topicIds);
      return number;
    });
    if (number === null) return reply.code(409).send({ error: `You can create up to ${TAG_CHANNEL_BASE - 1} channels` });
    return reply.code(201).send(customChannels().find(channel => channel.id === id));
  });

  app.put("/api/v1/guide/channels/:id", async (req, reply) => {
    if (!db.prepare("SELECT 1 FROM guide_channels WHERE id=?").get(req.params.id)) return reply.code(404).send({ error: "Channel not found" });
    const input = channelInput(req.body);
    if (input.error) return reply.code(input.code || 400).send({ error: input.error });
    transaction(() => {
      db.prepare("UPDATE guide_channels SET name=?, match_mode=?, updated_at=? WHERE id=?").run(input.name, input.match, new Date().toISOString(), req.params.id);
      saveTopics(req.params.id, input.topicIds);
    });
    return customChannels().find(channel => channel.id === req.params.id);
  });

  app.delete("/api/v1/guide/channels/:id", async (req, reply) => {
    const result = db.prepare("DELETE FROM guide_channels WHERE id=?").run(req.params.id);
    if (!result.changes) return reply.code(404).send({ error: "Channel not found" });
    return reply.code(204).send();
  });
}

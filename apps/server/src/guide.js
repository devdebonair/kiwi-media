import { randomUUID } from "node:crypto";
import { db, assetVisibleSql, currentProfile, isUnrestricted } from "@kiwi/database";
import { ensureAllSeasons, getMedia, getProvider, getTitle, imageUrl, syncHouseholdLibrary } from "@kiwi/media";
import { EPISODE_BLOCKS, ORDERS, readRules, ruleAssets, validateRules } from "./channel-rules.js";
import { titleAllowed, topicAllowed } from "./profiles.js";

// Every channel loops its lineup forever from this instant, so "what's on" is the same on
// every request and device without storing a schedule.
export const GUIDE_EPOCH = Date.UTC(2026, 0, 1);
// Tags with fewer playable videos than this would repeat every few minutes, so they get no channel.
export const MIN_CHANNEL_VIDEOS = 3;
// Custom channels take the low numbers; media-class channels (Movies, TV Shows, Anime, Home Videos) sit just below
// the tag channels, which start here and are numbered by tag age.
const TAG_CHANNEL_BASE = 100;
const CLASS_CHANNEL_BASE = 90;
const MAX_PROGRAMS_PER_ROW = 400;
// Episodes of a series air back to back in order, this many at a time, so a show feels like TV and not a shuffle.
// Channels you make can choose their own (see EPISODE_BLOCKS).
const EPISODE_BLOCK = 2;
// Home videos need a file. Movies and episodes from the catalog can air when they are in the household library
// (on someone's list or picked for a channel) and not unaired (specials are left out), or known to be unavailable;
// the TV guide plays them straight from the source. `extra` titles count as in the library (for a channel preview).
const playable = (extra = []) => `a.kind='video' AND a.duration_ms>0 AND ((a.file_path IS NOT NULL AND a.file_path!='')
  OR (a.title_id IS NOT NULL AND (t.in_library=1${extra.length ? ` OR t.id IN (${extra.map(() => "?").join(",")})` : ""})
    AND (a.season_number IS NULL OR a.season_number>=1) AND a.availability NOT IN ('unaired','unavailable')))`;

// FNV-1a: a stable pseudo-random lineup order that does not reshuffle when videos are added.
const hash = text => {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  return value >>> 0;
};

// Playable videos per tag, what each video is (for ordering episodes and lineups), and the media classes.
const memberships = ({ extraTitleIds = [] } = {}) => {
  const byTopic = new Map(), info = new Map(), classes = { movies: new Set(), shows: new Set(), anime: new Set(), home: new Set() };
  const note = row => {
    if (info.has(row.id)) return;
    info.set(row.id, { duration: row.duration_ms, titleId: row.title_id, season: row.season_number, episode: row.episode_number, date: row.aired || "" });
    if (!row.title_id) classes.home.add(row.id);
    else if (row.is_anime) classes.anime.add(row.id);
    else (row.title_type === "movie" ? classes.movies : classes.shows).add(row.id);
  };
  // When it aired or came out (for "in order" and "newest first" lineups); home videos fall back to when they were added.
  const columns = `a.id, a.duration_ms, a.title_id, a.season_number, a.episode_number, t.type title_type, t.is_anime,
    coalesce(nullif(a.air_date,''), a.captured_at, a.published_at, a.added_at) aired`;
  // Each profile's guide only airs what it may watch.
  const allowed = `${playable(extraTitleIds)} AND ${assetVisibleSql("a")}`;
  for (const row of db.prepare(`SELECT et.topic_id, ${columns} FROM effective_asset_topics et JOIN assets a ON a.id=et.asset_id LEFT JOIN titles t ON t.id=a.title_id WHERE ${allowed}`).all(...extraTitleIds)) {
    if (!byTopic.has(row.topic_id)) byTopic.set(row.topic_id, new Set());
    byTopic.get(row.topic_id).add(row.id);
    note(row);
  }
  for (const row of db.prepare(`SELECT ${columns} FROM assets a LEFT JOIN titles t ON t.id=a.title_id WHERE ${allowed}`).all(...extraTitleIds)) note(row);
  return { byTopic, info, classes };
};

const isAdmin = () => currentProfile().role === "admin";
// Household channels are an admin's to change; a personal channel is its profile's.
const canEdit = row => row.owner_id ? row.owner_id === currentProfile().id : isAdmin();

const placeholders = list => list.map(() => "?").join(",");
const rowsById = (sql, list) => list.length ? db.prepare(sql.replace("(?)", `(${placeholders(list)})`)).all(...list) : [];
const inOrder = (rows, list) => list.map(id => rows.find(row => row.id === id)).filter(Boolean);

// What a channel is made of, for showing it and for its editor. Tags and titles the profile can't see are left out.
const channelSources = rules => {
  const topic = row => ({ id: row.id, slug: row.slug, name: row.name, avatar_url: row.avatar_url });
  const tags = list => inOrder(rowsById("SELECT id, slug, name, avatar_url FROM topics WHERE id IN (?)", list), list).filter(row => topicAllowed(row.id)).map(topic);
  return {
    topics: tags(rules.topicIds),
    titles: inOrder(rowsById("SELECT id, type, title, year, is_anime, poster_path FROM titles WHERE id IN (?)", rules.titleIds), rules.titleIds).filter(row => titleAllowed(row.id))
      .map(row => ({ id: row.id, type: row.type, title: row.title, year: row.year, isAnime: Boolean(row.is_anime), poster: imageUrl(row.poster_path, "w185") })),
    lists: inOrder(rowsById("SELECT l.id, l.name, l.user_id, u.display_name owner FROM lists l JOIN users u ON u.id=l.user_id WHERE l.id IN (?)", rules.listIds), rules.listIds)
      .map(row => ({ id: row.id, name: row.name, owner: row.user_id === currentProfile().id ? null : row.owner })),
    roots: inOrder(rowsById("SELECT id, name FROM library_roots WHERE id IN (?)", rules.rootIds), rules.rootIds),
    excludeTopics: tags(rules.excludeTopicIds),
  };
};

// The channels you made that this profile has: the household's and its own. `everyone` includes every profile's
// personal channels (for background work).
const customChannels = ({ everyone = false } = {}) => {
  const rows = everyone ? db.prepare("SELECT * FROM guide_channels ORDER BY number").all()
    : db.prepare("SELECT * FROM guide_channels WHERE owner_id IS NULL OR owner_id=? ORDER BY number").all(currentProfile().id);
  return rows.map(row => {
    const rules = readRules(row.rules_json);
    return {
      key: `custom:${row.id}`, id: row.id, number: row.number, name: row.name, type: "custom", avatar_url: null,
      scope: row.owner_id ? "personal" : "household", ownerId: row.owner_id, editable: canEdit(row),
      rules, order: row.order_mode, episodeBlock: row.episode_block, sources: channelSources(rules),
    };
  });
};

const CLASS_CHANNELS = [["movies", "Movies", 0], ["shows", "TV Shows", 1], ["anime", "Anime", 2], ["home", "Home Videos", 3]];
const topicKind = type => type === "person" ? "person" : type === "genre" ? "genre" : type === "service" ? "service" : "topic";

// All channels in number order, each with the set of video ids it airs. A household channel with nothing a restricted
// profile may watch doesn't exist for that profile.
export function guideChannels({ everyone = false } = {}) {
  const { byTopic, info, classes } = memberships();
  const restricted = !isUnrestricted();
  const custom = customChannels({ everyone }).map(channel => ({ ...channel, assets: ruleAssets(channel.rules, info) }))
    .filter(channel => !restricted || channel.scope === "personal" || channel.assets.size);
  const media = CLASS_CHANNELS.map(([key, name, offset]) => ({ key: `class:${key}`, id: key, number: CLASS_CHANNEL_BASE + offset, name, type: "media", avatar_url: null, assets: classes[key] }))
    .filter(channel => channel.assets.size >= MIN_CHANNEL_VIDEOS);
  const tags = db.prepare("SELECT id, slug, name, avatar_url, topic_type FROM topics ORDER BY created_at, id").all()
    .map((topic, index) => ({
      key: `topic:${topic.id}`, id: topic.id, slug: topic.slug, number: TAG_CHANNEL_BASE + index, name: topic.name,
      type: topicKind(topic.topic_type), avatar_url: topic.avatar_url, assets: byTopic.get(topic.id) || new Set(),
    }))
    .filter(channel => channel.assets.size >= MIN_CHANNEL_VIDEOS);
  return { channels: [...custom, ...media, ...tags], info };
}

// A channel's repeating order: singles (home videos, movies) and blocks of consecutive episodes (or whole seasons).
// Shuffled by a stable hash, or by when each block first aired: oldest first ("in order") or newest first.
function lineupFor(channel, info) {
  const block = channel.episodeBlock ?? EPISODE_BLOCK, order = channel.order || "shuffle";
  const units = [], episodes = new Map();
  for (const id of channel.assets) {
    const item = info.get(id);
    if (item.titleId && item.season >= 1) {
      if (!episodes.has(item.titleId)) episodes.set(item.titleId, []);
      episodes.get(item.titleId).push({ id, ...item });
    } else units.push({ key: id, ids: [id], date: item.date });
  }
  for (const list of episodes.values()) {
    list.sort((a, b) => a.season - b.season || a.episode - b.episode);
    for (let i = 0; i < list.length;) {
      const size = block || list.filter(item => item.season === list[i].season).length;
      const ids = list.slice(i, i + size);
      units.push({ key: ids[0].id, ids: ids.map(item => item.id), date: ids[0].date });
      i += size;
    }
  }
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const sorted = order === "shuffle"
    ? units.map(unit => ({ ...unit, order: hash(`${channel.key}:${unit.key}`) })).sort((a, b) => a.order - b.order || byKey(a, b))
    : units.sort((a, b) => (order === "newest" ? -1 : 1) * (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || byKey(a, b));
  return sorted.flatMap(unit => unit.ids.map(id => ({ id, duration: info.get(id).duration })));
}

// The programs airing on a channel between start and end (epoch ms), including any already under way at start.
export function schedule(channel, info, start, end) {
  const lineup = lineupFor(channel, info);
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

const publicChannel = ({ assets, ownerId, ...channel }) => ({ ...channel, item_count: assets.size });

const filters = {
  all: () => true,
  custom: channel => channel.type === "custom",
  people: channel => channel.type === "person",
  tags: channel => channel.type === "topic",
  genres: channel => channel.type === "genre",
  services: channel => channel.type === "service",
  media: channel => channel.type === "media",
};

const integer = (value, fallback) => value === undefined ? fallback : /^-?\d+$/.test(String(value)) ? Number(value) : NaN;

const lowestFreeNumber = () => {
  const taken = new Set(db.prepare("SELECT number FROM guide_channels").all().map(row => row.number));
  for (let number = 1; number < CLASS_CHANNEL_BASE; number++) if (!taken.has(number)) return number;
  return null;
};

// Validates { name, scope, rules, order, episodeBlock } for creating or editing a channel. `row` is the channel
// being edited.
const channelInput = (body, row = null) => {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return { error: "Channel name must be 1–60 characters" };
  const scope = body?.scope ?? (row ? (row.owner_id ? "personal" : "household") : isAdmin() ? "household" : "personal");
  if (!["household", "personal"].includes(scope)) return { error: "scope must be \"household\" or \"personal\"" };
  if (scope === "household" && !isAdmin()) return { code: 403, error: "Only an admin can make channels for everyone" };
  const order = body?.order ?? row?.order_mode ?? "shuffle";
  if (!ORDERS.includes(order)) return { error: `order must be ${ORDERS.join(", ")}` };
  const episodeBlock = body?.episodeBlock ?? row?.episode_block ?? EPISODE_BLOCK;
  if (!EPISODE_BLOCKS.includes(episodeBlock)) return { error: `episodeBlock must be ${EPISODE_BLOCKS.join(", ")}` };
  const checked = validateRules(body?.rules, { admin: isAdmin(), userId: currentProfile().id, previous: readRules(row?.rules_json) });
  if (checked.error) return checked;
  return { name, ownerId: scope === "personal" ? (row?.owner_id || currentProfile().id) : null, order, episodeBlock, rules: checked.rules };
};

// Shows picked for a channel need all their episodes known before they can air, like a show added to a list.
const prepareTitles = async titleIds => {
  if (!getProvider("tmdb").configured) return;
  for (const id of titleIds) {
    const title = getTitle(id);
    if (title?.type === "show" && !title.in_library) await ensureAllSeasons(id, getMedia().tmdb).catch(() => {});
  }
};
// After a channel changes: titles it picked join (or leave) the household library.
const syncTitles = titleIds => { for (const id of new Set(titleIds)) syncHouseholdLibrary(id, { images: getMedia().images }); };

const transaction = work => {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
};

// What the guide's programs show: episodes air under their show's name with the episode as a subtitle.
const programDetails = ids => {
  const details = new Map();
  // Chunked to stay under SQLite's bound-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const row of db.prepare(`SELECT a.id, a.title, a.thumbnail_url, a.duration_ms, a.title_id, a.season_number, a.episode_number, t.title show_title, t.type show_type, t.is_anime
      FROM assets a LEFT JOIN titles t ON t.id=a.title_id WHERE a.id IN (${chunk.map(() => "?").join(",")})`).all(...chunk)) {
      const episode = row.title_id && row.show_type === "show" && row.season_number != null;
      details.set(row.id, { id: row.id, title: episode ? row.show_title : row.title, subtitle: episode ? `S${row.season_number}E${row.episode_number} · ${row.title}` : null, thumbnail_url: row.thumbnail_url, duration_ms: row.duration_ms,
        title_id: row.title_id, season: row.season_number, episode: row.episode_number, is_anime: Boolean(row.is_anime), catalog: Boolean(row.title_id) });
    }
  }
  return details;
};

export function registerGuide(app, { warmer } = {}) {
  // The guide's player reports the channel it is showing, so its programs can be readied ahead of time.
  app.post("/api/v1/guide/tune", async (req, reply) => {
    const key = typeof req.body?.channel === "string" ? req.body.channel : "";
    if (!key || key.length > 200) return reply.code(400).send({ error: "channel is required" });
    // Only channels this profile can see are readied.
    if (!guideChannels().channels.some(channel => channel.key === key)) return reply.code(404).send({ error: "Channel not found" });
    warmer?.tune(key);
    return reply.code(204).send();
  });

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
    const { channels, info } = guideChannels();
    // `channel` picks one channel by key, e.g. for the guide's live player.
    const only = req.query.channel;
    const matching = only ? channels.filter(channel => channel.key === only)
      : channels.filter(filters[filter]).filter(channel => !q || String(channel.number) === q || channel.name.toLowerCase().includes(q));
    const page = matching.slice(offset, offset + limit).map(channel => ({ ...publicChannel(channel), programs: schedule(channel, info, start, end) }));
    const details = programDetails([...new Set(page.flatMap(channel => channel.programs.map(program => program.id)))]);
    return {
      start, end, now, total: matching.length,
      channels: page.map(channel => ({ ...channel, programs: channel.programs.map(program => ({ ...details.get(program.id), ...program })) })),
    };
  });

  // What a channel would air, for the editor: how many videos, and what's on next. `channelId` is the channel
  // being edited, so lists already on it count.
  app.post("/api/v1/guide/preview", async (req, reply) => {
    const row = req.body?.channelId ? db.prepare("SELECT * FROM guide_channels WHERE id=?").get(req.body.channelId) : null;
    if (row && !canEdit(row)) return reply.code(404).send({ error: "Channel not found" });
    const order = req.body?.order ?? "shuffle", episodeBlock = req.body?.episodeBlock ?? EPISODE_BLOCK;
    if (!ORDERS.includes(order) || !EPISODE_BLOCKS.includes(episodeBlock)) return reply.code(400).send({ error: "Invalid order or episodeBlock" });
    const checked = validateRules(req.body?.rules, { admin: isAdmin(), userId: currentProfile().id, previous: readRules(row?.rules_json) });
    if (checked.error && /at least one/.test(checked.error)) return { item_count: 0, upcoming: [] };
    if (checked.error) return reply.code(checked.code || 400).send({ error: checked.error });
    // Shows and movies just picked aren't in the household library yet; count them as if saved.
    const { info } = memberships({ extraTitleIds: checked.rules.titleIds });
    const channel = { key: `custom:${row?.id || "preview"}`, order, episodeBlock, assets: ruleAssets(checked.rules, info) };
    const now = Date.now();
    const programs = schedule(channel, info, now, now + 12 * 3_600_000).slice(0, 5);
    const details = programDetails(programs.map(program => program.id));
    return { item_count: channel.assets.size, upcoming: programs.map(program => ({ ...details.get(program.id), ...program })) };
  });

  app.get("/api/v1/guide/channels", async () => {
    const { channels } = guideChannels();
    return channels.filter(channel => channel.type === "custom").map(publicChannel);
  });

  const presentCustom = id => publicChannel(guideChannels().channels.find(channel => channel.key === `custom:${id}`)
    || { ...customChannels().find(channel => channel.id === id), assets: new Set() });

  app.post("/api/v1/guide/channels", async (req, reply) => {
    const input = channelInput(req.body);
    if (input.error) return reply.code(input.code || 400).send({ error: input.error });
    await prepareTitles(input.rules.titleIds);
    const id = randomUUID(), timestamp = new Date().toISOString();
    const number = transaction(() => {
      const number = lowestFreeNumber();
      if (number === null) return null;
      db.prepare("INSERT INTO guide_channels (id,number,name,owner_id,rules_json,order_mode,episode_block,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, number, input.name, input.ownerId, JSON.stringify(input.rules), input.order, input.episodeBlock, timestamp, timestamp);
      return number;
    });
    if (number === null) return reply.code(409).send({ error: `You can create up to ${CLASS_CHANNEL_BASE - 1} channels` });
    syncTitles(input.rules.titleIds);
    return reply.code(201).send(presentCustom(id));
  });

  // Another profile's personal channel doesn't exist for you; a household channel is an admin's to change.
  const editable = (req, reply) => {
    const row = db.prepare("SELECT * FROM guide_channels WHERE id=?").get(req.params.id);
    if (!row || (row.owner_id && row.owner_id !== currentProfile().id)) { reply.code(404).send({ error: "Channel not found" }); return null; }
    if (!canEdit(row)) { reply.code(403).send({ error: "Only an admin can change channels for everyone" }); return null; }
    return row;
  };

  app.put("/api/v1/guide/channels/:id", async (req, reply) => {
    const row = editable(req, reply);
    if (!row) return reply;
    const input = channelInput(req.body, row);
    if (input.error) return reply.code(input.code || 400).send({ error: input.error });
    await prepareTitles(input.rules.titleIds);
    db.prepare("UPDATE guide_channels SET name=?, owner_id=?, rules_json=?, order_mode=?, episode_block=?, updated_at=? WHERE id=?")
      .run(input.name, input.ownerId, JSON.stringify(input.rules), input.order, input.episodeBlock, new Date().toISOString(), row.id);
    syncTitles([...readRules(row.rules_json).titleIds, ...input.rules.titleIds]);
    return presentCustom(row.id);
  });

  app.delete("/api/v1/guide/channels/:id", async (req, reply) => {
    const row = editable(req, reply);
    if (!row) return reply;
    db.prepare("DELETE FROM guide_channels WHERE id=?").run(row.id);
    syncTitles(readRules(row.rules_json).titleIds);
    return reply.code(204).send();
  });
}

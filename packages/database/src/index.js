import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.KIWI_DATA_DIR || resolve(packageDir, "../../../data"));
export const dbPath = resolve(dataDir, "kiwi.db");
export const generatedDir = resolve(dataDir, "generated");
mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(generatedDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_roots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, absolute_path TEXT NOT NULL UNIQUE,
      read_only INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      source_url TEXT, file_path TEXT, thumbnail_url TEXT, duration_ms INTEGER,
      width INTEGER, height INTEGER, captured_at TEXT, published_at TEXT,
      added_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
      visibility TEXT NOT NULL DEFAULT 'private', metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS assets_kind_idx ON assets(kind);
    CREATE INDEX IF NOT EXISTS assets_added_idx ON assets(added_at DESC);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      role TEXT NOT NULL, library_root_id TEXT REFERENCES library_roots(id), relative_path TEXT,
      mime_type TEXT, byte_size INTEGER, checksum_sha256 TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, summary TEXT,
      body_markdown TEXT, avatar_url TEXT, banner_url TEXT, topic_type TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS topic_aliases (
      id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      alias TEXT NOT NULL, normalized_alias TEXT NOT NULL,
      UNIQUE(topic_id, normalized_alias)
    );
    CREATE TABLE IF NOT EXISTS topic_edges (
      id TEXT PRIMARY KEY, source_topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      target_topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      relation TEXT NOT NULL, weight REAL, note TEXT, created_at TEXT NOT NULL,
      UNIQUE(source_topic_id, target_topic_id, relation)
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      motivation TEXT NOT NULL DEFAULT 'tagging', note_markdown TEXT, confidence REAL,
      origin TEXT NOT NULL DEFAULT 'manual', visibility TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS annotation_topics (
      annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'subject', PRIMARY KEY(annotation_id, topic_id, role)
    );
    CREATE TABLE IF NOT EXISTS annotation_selectors (
      id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
      selector_type TEXT NOT NULL, start_ms INTEGER, end_ms INTEGER,
      x REAL, y REAL, z REAL, width REAL, height REAL, depth REAL,
      text_start INTEGER, text_end INTEGER, exact_quote TEXT, prefix_text TEXT,
      suffix_text TEXT, timestamp_value TEXT, selector_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS asset_texts (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, language TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL,
      generated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS text_segments (
      id TEXT PRIMARY KEY, asset_text_id TEXT NOT NULL REFERENCES asset_texts(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, start_ms INTEGER, end_ms INTEGER, content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_sources (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      source_url TEXT, canonical_url TEXT, site_name TEXT, creator_name TEXT,
      retrieved_at TEXT, published_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS feeds (
      id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, query_version INTEGER NOT NULL DEFAULT 1,
      query_json TEXT NOT NULL, sort_mode TEXT NOT NULL DEFAULT 'recent',
      visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topic_follows (
      user_id TEXT NOT NULL REFERENCES users(id), topic_id TEXT NOT NULL REFERENCES topics(id),
      followed_at TEXT NOT NULL, PRIMARY KEY(user_id, topic_id)
    );
    CREATE TABLE IF NOT EXISTS feed_follows (
      user_id TEXT NOT NULL REFERENCES users(id), feed_id TEXT NOT NULL REFERENCES feeds(id),
      followed_at TEXT NOT NULL, PRIMARY KEY(user_id, feed_id)
    );
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, visibility TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_items (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY(collection_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS saved_assets (
      user_id TEXT NOT NULL REFERENCES users(id), asset_id TEXT NOT NULL REFERENCES assets(id),
      saved_at TEXT NOT NULL, PRIMARY KEY(user_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS consumption_state (
      user_id TEXT NOT NULL REFERENCES users(id), asset_id TEXT NOT NULL REFERENCES assets(id),
      progress_ms INTEGER, completed INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT,
      view_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT NOT NULL, locked_at TEXT,
      locked_by TEXT, progress REAL NOT NULL DEFAULT 0, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      entity_id UNINDEXED, entity_type UNINDEXED, title, body, tags,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
}

const now = () => new Date().toISOString();

export function seed() {
  const count = db.prepare("SELECT count(*) count FROM assets").get().count;
  if (count) return;
  const userId = "user-local";
  db.prepare("INSERT OR IGNORE INTO users VALUES (?, ?, ?)").run(userId, "Alex", now());
  const topics = [
    ["topic-nyc", "new-york-city", "New York City", "The city that never sleeps. Five boroughs, endless stories.", "/assets/media/city.png", "/assets/media/city.png", "place"],
    ["topic-jazz", "jazz", "Jazz", "Improvisation, rhythm, and a century of recorded performance.", "/assets/media/jazz.png", "/assets/media/jazz.png", "genre"],
    ["topic-nature", "nature", "Nature", "Wild places, species, and the living world.", "/assets/media/waterfall.png", "/assets/media/waterfall.png", "subject"],
    ["topic-photo", "photography", "Photography", "Images, photographers, and visual culture.", "/assets/media/street.png", "/assets/media/street.png", "medium"],
    ["topic-long", "long-reads", "Long reads", "Essays and articles worth returning to.", "/assets/media/article.png", "/assets/media/article.png", "format"]
  ];
  const topicStmt = db.prepare("INSERT INTO topics (id,slug,name,summary,avatar_url,banner_url,topic_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const t of topics) topicStmt.run(...t, now(), now());
  const assets = [
    ["asset-city", "video", "Sunset Walks in Manhattan", "A quiet golden-hour walk through Manhattan's streets and skyline.", "/assets/media/city.png", 872000, "2026-08-12T18:00:00Z"],
    ["asset-jazz", "video", "Live at the Village Vanguard", "An intimate set recorded in a legendary New York jazz room.", "/assets/media/jazz.png", 2567000, "2026-08-11T18:00:00Z"],
    ["asset-waterfall", "video", "Waterfalls of the Pacific Northwest", "Mossy forests and hidden waterfalls after the rain.", "/assets/media/waterfall.png", 485000, "2026-08-10T18:00:00Z"],
    ["asset-street", "image", "Analog Street Photography", "A black-and-white photo collection from rainy city afternoons.", "/assets/media/street.png", null, "2026-08-09T18:00:00Z"],
    ["asset-brooklyn", "image", "Brooklyn in the Morning", "Rooftops, avenues, and early light across Brooklyn.", "/assets/media/city.png", null, "2026-08-08T18:00:00Z"],
    ["asset-blue-train", "audio", "Blue Train (Remastered)", "A focused hard-bop listening session.", "/assets/media/jazz.png", 2537000, "2026-08-07T18:00:00Z"],
    ["asset-rainforest", "video", "The Secret World of Rainforests", "Small lives and vast ecosystems beneath the canopy.", "/assets/media/waterfall.png", 381000, "2026-08-06T18:00:00Z"],
    ["asset-west-village", "video", "Weekend in the West Village", "An unhurried walk through one of New York's most human neighborhoods.", "/assets/media/street.png", 669000, "2026-08-05T18:00:00Z"],
    ["asset-kind-blue", "audio", "Kind of Blue", "A landmark modal jazz album and perennial favorite.", "/assets/media/jazz.png", 2795000, "2026-08-04T18:00:00Z"],
    ["asset-rockies", "video", "Morning Calm in the Rockies", "Still water, mountain air, and first light.", "/assets/media/waterfall.png", 435000, "2026-08-03T18:00:00Z"],
    ["asset-slow", "article", "The Case for Slow Living", "Finding balance and attention in a frantic world.", "/assets/media/article.png", null, "2026-08-02T18:00:00Z"]
  ];
  const assetStmt = db.prepare("INSERT INTO assets (id,kind,title,description,thumbnail_url,duration_ms,added_at,updated_at,visibility) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const a of assets) assetStmt.run(...a, a[6], "public");
  const links = [
    ["asset-city", "topic-nyc"], ["asset-jazz", "topic-jazz"], ["asset-jazz", "topic-nyc"],
    ["asset-waterfall", "topic-nature"], ["asset-street", "topic-photo"], ["asset-street", "topic-nyc"],
    ["asset-brooklyn", "topic-nyc"], ["asset-blue-train", "topic-jazz"],
    ["asset-rainforest", "topic-nature"], ["asset-west-village", "topic-nyc"],
    ["asset-kind-blue", "topic-jazz"], ["asset-rockies", "topic-nature"], ["asset-slow", "topic-long"]
  ];
  const annotationStmt = db.prepare("INSERT INTO annotations (id,asset_id,note_markdown,origin,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  const annotationTopicStmt = db.prepare("INSERT INTO annotation_topics VALUES (?,?,?)");
  for (const [asset, topic] of links) {
    const id = randomUUID();
    annotationStmt.run(id, asset, "", "seed", "public", now(), now());
    annotationTopicStmt.run(id, topic, "subject");
  }
  const momentId = randomUUID();
  annotationStmt.run(momentId, "asset-city", "Empire State Building appears above the avenue", "seed", "public", now(), now());
  annotationTopicStmt.run(momentId, "topic-nyc", "depicted");
  db.prepare("INSERT INTO annotation_selectors (id,annotation_id,selector_type,start_ms,end_ms) VALUES (?,?,?,?,?)").run(randomUUID(), momentId, "time-range", 45000, 76000);
  const feedStmt = db.prepare("INSERT INTO feeds (id,owner_id,slug,name,description,query_json,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  feedStmt.run("feed-nyc", userId, "new-york-city", "New York City", "Everything connected to New York City.", JSON.stringify({ topicIds: ["topic-nyc"] }), "public", now(), now());
  feedStmt.run("feed-jazz", userId, "jazz", "Jazz", "Performances, albums, photos, and writing.", JSON.stringify({ topicIds: ["topic-jazz"] }), "public", now(), now());
  rebuildSearch();
}

export function rebuildSearch() {
  db.exec("DELETE FROM search_index");
  const insert = db.prepare("INSERT INTO search_index(entity_id,entity_type,title,body,tags) VALUES (?,?,?,?,?)");
  for (const row of db.prepare("SELECT id,title,description FROM assets").all()) {
    const tags = db.prepare("SELECT t.name FROM topics t JOIN annotation_topics at ON at.topic_id=t.id JOIN annotations a ON a.id=at.annotation_id WHERE a.asset_id=?").all(row.id).map(x => x.name).join(" ");
    insert.run(row.id, "asset", row.title, row.description || "", tags);
  }
  for (const row of db.prepare("SELECT id,name,summary,body_markdown FROM topics").all()) insert.run(row.id, "topic", row.name, `${row.summary || ""} ${row.body_markdown || ""}`, "");
}

export function assetWithTopics(row) {
  if (!row) return null;
  const topics = db.prepare("SELECT DISTINCT t.id,t.slug,t.name,t.avatar_url FROM topics t JOIN annotation_topics at ON at.topic_id=t.id JOIN annotations a ON a.id=at.annotation_id WHERE a.asset_id=?").all(row.id);
  const moments = db.prepare("SELECT s.start_ms,s.end_ms,a.note_markdown,t.name topic FROM annotation_selectors s JOIN annotations a ON a.id=s.annotation_id LEFT JOIN annotation_topics at ON at.annotation_id=a.id LEFT JOIN topics t ON t.id=at.topic_id WHERE a.asset_id=? ORDER BY s.start_ms").all(row.id);
  return { ...row, topics, moments, saved: Boolean(row.saved) };
}

migrate();
seed();

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
    CREATE TABLE IF NOT EXISTS asset_views (
      user_id TEXT NOT NULL REFERENCES users(id), asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, viewed_at TEXT NOT NULL,
      PRIMARY KEY(user_id, asset_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS asset_views_asset_idx ON asset_views(asset_id);
    CREATE TABLE IF NOT EXISTS asset_likes (
      user_id TEXT NOT NULL REFERENCES users(id), asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      count INTEGER NOT NULL CHECK(count BETWEEN 0 AND 5), PRIMARY KEY(user_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id), shorts_max_seconds INTEGER NOT NULL DEFAULT 90
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
    ["topic-long", "long-reads", "Long reads", "Essays and articles worth returning to.", "/assets/media/article.png", "/assets/media/article.png", "format"],
    ["topic-anime", "anime", "Anime", "Japanese animation, its history, films, and music.", "/generated/anime-ponsuke.jpg", "/generated/anime-namakura.jpg", "medium"],
    ["topic-anime-music", "anime-music", "Anime Music", "Theme songs and soundtrack music with an anime-inspired spirit.", "/generated/anime-music.jpg", "/generated/anime-music.jpg", "genre"]
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
    ["asset-slow", "article", "The Case for Slow Living", "Finding balance and attention in a frantic world.", "/assets/media/article.png", null, "2026-08-02T18:00:00Z"],
    ["asset-anime-namakura", "video", "Namakura Gatana (The Dull Sword)", "Jun'ichi Kōuchi's landmark 1917 animated short about a samurai whose new sword is not what he expected.", "/generated/anime-namakura.jpg", 257865, "2026-08-13T19:00:00Z"],
    ["asset-anime-ponsuke", "video", "Spring Comes to Ponsuke", "Ikuo Oishi's playful 1934 Japanese animated short.", "/generated/anime-ponsuke.jpg", 425007, "2026-08-13T18:59:00Z"],
    ["asset-anime-taro", "video", "Taro-san's Train", "A 1929 Japanese animated film directed by Yasuji Murata.", "/generated/anime-taro.jpg", 926000, "2026-08-13T18:58:00Z"],
    ["asset-anime-theme-tale", "audio", "Tale on the Late — Main Theme", "A bright, cinematic theme by Komiku, included as an anime soundtrack fixture.", "/generated/anime-music.jpg", 76000, "2026-08-13T18:57:00Z"],
    ["asset-anime-theme-friends", "audio", "Friends' Theme", "An adventurous character theme by Komiku, included as an anime soundtrack fixture.", "/generated/anime-music.jpg", 164000, "2026-08-13T18:56:00Z"],
    ["asset-anime-theme-song", "audio", "Theme Song", "An atmospheric theme by Monplaisir, included as an anime soundtrack fixture.", "/generated/anime-music.jpg", 82000, "2026-08-13T18:55:00Z"]
  ];
  const assetStmt = db.prepare("INSERT INTO assets (id,kind,title,description,thumbnail_url,duration_ms,added_at,updated_at,visibility) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const a of assets) assetStmt.run(...a, a[6], "public");
  const sampleDir = resolve(packageDir, "../../../media/samples");
  const sampleSources = [
    ["asset-anime-namakura", "Namakura Gatana (1917).webm", "https://commons.wikimedia.org/wiki/File:Namakura_Gatana_with_music.webm", "Jun'ichi Kōuchi; music by Kevin MacLeod", "Public domain / CC BY 3.0"],
    ["asset-anime-ponsuke", "Spring Comes to Ponsuke (1934).webm", "https://commons.wikimedia.org/wiki/File:Spring_Comes_to_Ponsuke_(1934).webm", "Ikuo Oishi", "Public domain"],
    ["asset-anime-taro", "Taro-san's Train (1929).webm", "https://commons.wikimedia.org/wiki/File:Tar%C3%B4-san_no_kisha_(1929).webm", "Yasuji Murata", "Public domain"],
    ["asset-anime-theme-tale", "Tale on the Late - Main Theme.ogg", "https://commons.wikimedia.org/wiki/File:Komiku_-_01_-_Tale_on_the_Late_Main_Theme.ogg", "Komiku", "CC0 1.0"],
    ["asset-anime-theme-friends", "Friends Theme.ogg", "https://commons.wikimedia.org/wiki/File:Komiku_-_06_-_Friendss_theme.ogg", "Komiku", "CC0 1.0"],
    ["asset-anime-theme-song", "Theme Song.ogg", "https://commons.wikimedia.org/wiki/File:Monplaisir_-_01_-_Theme_Song.ogg", "Monplaisir", "CC0 1.0"]
  ];
  const sourceStmt = db.prepare("INSERT INTO asset_sources (id,asset_id,source_url,canonical_url,site_name,creator_name,retrieved_at,metadata_json) VALUES (?,?,?,?,?,?,?,?)");
  for (const [assetId, filename, sourceUrl, creator, license] of sampleSources) {
    db.prepare("UPDATE assets SET source_url=?,file_path=?,metadata_json=? WHERE id=?").run(sourceUrl, resolve(sampleDir, filename), JSON.stringify({ license, fixture: true }), assetId);
    sourceStmt.run(randomUUID(), assetId, sourceUrl, sourceUrl, "Wikimedia Commons", creator, "2026-08-13T00:00:00Z", JSON.stringify({ license, localFilename: filename }));
  }
  const links = [
    ["asset-city", "topic-nyc"], ["asset-jazz", "topic-jazz"], ["asset-jazz", "topic-nyc"],
    ["asset-waterfall", "topic-nature"], ["asset-street", "topic-photo"], ["asset-street", "topic-nyc"],
    ["asset-brooklyn", "topic-nyc"], ["asset-blue-train", "topic-jazz"],
    ["asset-rainforest", "topic-nature"], ["asset-west-village", "topic-nyc"],
    ["asset-kind-blue", "topic-jazz"], ["asset-rockies", "topic-nature"], ["asset-slow", "topic-long"],
    ["asset-anime-namakura", "topic-anime"], ["asset-anime-ponsuke", "topic-anime"], ["asset-anime-taro", "topic-anime"],
    ["asset-anime-theme-tale", "topic-anime"], ["asset-anime-theme-tale", "topic-anime-music"],
    ["asset-anime-theme-friends", "topic-anime"], ["asset-anime-theme-friends", "topic-anime-music"],
    ["asset-anime-theme-song", "topic-anime"], ["asset-anime-theme-song", "topic-anime-music"]
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
  feedStmt.run("feed-anime", userId, "anime", "Anime", "Japanese animation and theme music from across the library.", JSON.stringify({ topicIds: ["topic-anime"] }), "public", now(), now());
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

function syncAnimeFixtures() {
  const timestamp = now();
  const topics = [
    ["topic-anime", "anime", "Anime", "Japanese animation, its history, films, and music.", "/generated/anime-ponsuke.jpg", "/generated/anime-namakura.jpg", "medium"],
    ["topic-anime-music", "anime-music", "Anime Music", "Theme songs and soundtrack music with an anime-inspired spirit.", "/generated/anime-music.jpg", "/generated/anime-music.jpg", "genre"]
  ];
  const insertTopic = db.prepare("INSERT OR IGNORE INTO topics (id,slug,name,summary,avatar_url,banner_url,topic_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const topic of topics) insertTopic.run(...topic, timestamp, timestamp);

  const sampleDir = resolve(packageDir, "../../../media/samples");
  const assets = [
    ["asset-anime-namakura", "video", "Namakura Gatana (The Dull Sword)", "Jun'ichi Kōuchi's landmark 1917 animated short about a samurai whose new sword is not what he expected.", "anime-namakura.jpg", 257865, "Namakura Gatana (1917).webm", "https://commons.wikimedia.org/wiki/File:Namakura_Gatana_with_music.webm", "Jun'ichi Kōuchi; music by Kevin MacLeod", "Public domain / CC BY 3.0"],
    ["asset-anime-ponsuke", "video", "Spring Comes to Ponsuke", "Ikuo Oishi's playful 1934 Japanese animated short.", "anime-ponsuke.jpg", 425007, "Spring Comes to Ponsuke (1934).webm", "https://commons.wikimedia.org/wiki/File:Spring_Comes_to_Ponsuke_(1934).webm", "Ikuo Oishi", "Public domain"],
    ["asset-anime-taro", "video", "Taro-san's Train", "A 1929 Japanese animated film directed by Yasuji Murata.", "anime-taro.jpg", 926000, "Taro-san's Train (1929).webm", "https://commons.wikimedia.org/wiki/File:Tar%C3%B4-san_no_kisha_(1929).webm", "Yasuji Murata", "Public domain"],
    ["asset-anime-theme-tale", "audio", "Tale on the Late — Main Theme", "A bright, cinematic theme by Komiku, included as an anime soundtrack fixture.", "anime-music.jpg", 76000, "Tale on the Late - Main Theme.ogg", "https://commons.wikimedia.org/wiki/File:Komiku_-_01_-_Tale_on_the_Late_Main_Theme.ogg", "Komiku", "CC0 1.0"],
    ["asset-anime-theme-friends", "audio", "Friends' Theme", "An adventurous character theme by Komiku, included as an anime soundtrack fixture.", "anime-music.jpg", 164000, "Friends Theme.ogg", "https://commons.wikimedia.org/wiki/File:Komiku_-_06_-_Friendss_theme.ogg", "Komiku", "CC0 1.0"],
    ["asset-anime-theme-song", "audio", "Theme Song", "An atmospheric theme by Monplaisir, included as an anime soundtrack fixture.", "anime-music.jpg", 82000, "Theme Song.ogg", "https://commons.wikimedia.org/wiki/File:Monplaisir_-_01_-_Theme_Song.ogg", "Monplaisir", "CC0 1.0"]
  ];
  const insertAsset = db.prepare("INSERT OR IGNORE INTO assets (id,kind,title,description,source_url,file_path,thumbnail_url,duration_ms,added_at,updated_at,visibility,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let index = 0; index < assets.length; index++) {
    const [id, kind, title, description, thumbnail, duration, filename, sourceUrl, creator, license] = assets[index];
    const addedAt = new Date(Date.parse("2026-08-13T19:00:00Z") - index * 60000).toISOString();
    insertAsset.run(id, kind, title, description, sourceUrl, resolve(sampleDir, filename), `/generated/${thumbnail}`, duration, addedAt, addedAt, "public", JSON.stringify({ license, fixture: true }));
    if (!db.prepare("SELECT 1 FROM asset_sources WHERE asset_id=? AND canonical_url=?").get(id, sourceUrl)) {
      db.prepare("INSERT INTO asset_sources (id,asset_id,source_url,canonical_url,site_name,creator_name,retrieved_at,metadata_json) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), id, sourceUrl, sourceUrl, "Wikimedia Commons", creator, "2026-08-13T00:00:00Z", JSON.stringify({ license, localFilename: filename }));
    }
  }
  const links = [
    ["asset-anime-namakura", "topic-anime"], ["asset-anime-ponsuke", "topic-anime"], ["asset-anime-taro", "topic-anime"],
    ["asset-anime-theme-tale", "topic-anime"], ["asset-anime-theme-tale", "topic-anime-music"],
    ["asset-anime-theme-friends", "topic-anime"], ["asset-anime-theme-friends", "topic-anime-music"],
    ["asset-anime-theme-song", "topic-anime"], ["asset-anime-theme-song", "topic-anime-music"]
  ];
  for (const [assetId, topicId] of links) {
    const exists = db.prepare("SELECT 1 FROM annotations a JOIN annotation_topics at ON at.annotation_id=a.id WHERE a.asset_id=? AND at.topic_id=?").get(assetId, topicId);
    if (!exists) {
      const annotationId = randomUUID();
      db.prepare("INSERT INTO annotations (id,asset_id,note_markdown,origin,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(annotationId, assetId, "", "seed", "public", timestamp, timestamp);
      db.prepare("INSERT INTO annotation_topics VALUES (?,?,?)").run(annotationId, topicId, "subject");
    }
  }
  db.prepare("INSERT OR IGNORE INTO feeds (id,owner_id,slug,name,description,query_json,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("feed-anime", "user-local", "anime", "Anime", "Japanese animation and theme music from across the library.", JSON.stringify({ topicIds: ["topic-anime"] }), "public", timestamp, timestamp);
  rebuildSearch();
}

export function assetWithTopics(row) {
  if (!row) return null;
  const topics = db.prepare("SELECT DISTINCT t.id,t.slug,t.name,t.avatar_url FROM topics t JOIN annotation_topics at ON at.topic_id=t.id JOIN annotations a ON a.id=at.annotation_id WHERE a.asset_id=?").all(row.id);
  const moments = db.prepare("SELECT s.start_ms,s.end_ms,a.note_markdown,t.name topic FROM annotation_selectors s JOIN annotations a ON a.id=s.annotation_id LEFT JOIN annotation_topics at ON at.annotation_id=a.id LEFT JOIN topics t ON t.id=at.topic_id WHERE a.asset_id=? ORDER BY s.start_ms").all(row.id);
  return { ...row, topics, moments, saved: Boolean(row.saved) };
}

migrate();
seed();
syncAnimeFixtures();

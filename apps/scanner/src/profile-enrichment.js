import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { configuredProviders } from "./providers.js";

const fields = `id name aliases disambiguation deleted career_start_year career_end_year urls { url } images { id url width height }`;
const userAgent = "KiwiProfileEnrichment/0.1 (personal media catalog)";
export const normalizeName = value => String(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 20);
const readJSON = path => JSON.parse(readFileSync(path, "utf8"));
const saveJSON = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + "\n"); };
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export function safeURL(value) {
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}

export function titleMatches(title, name) {
  const tokens = name.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean);
  if (!tokens.length) return false;
  const pattern = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s._-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(title);
}

export function exactCandidates(entry, candidates) {
  const key = normalizeName(entry.name);
  const active = candidates.filter(p => !p.deleted);
  const canonical = active.filter(p => normalizeName(p.name) === key);
  return canonical.length ? canonical : active.filter(p => (p.aliases || []).some(n => normalizeName(n) === key));
}

function linkKey(value) {
  const url = safeURL(value);
  if (!url) return null;
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "").replace(/^twitter\.com$/, "x.com");
  if (u.pathname === "/") return null;
  return host + u.pathname.replace(/\/$/, "").toLowerCase() + u.search;
}

export function sameProfile(a, b) {
  if (a.provider === b.provider) return a.id === b.id;
  const refersTo = (from, to) => (from.urls || []).some(x => linkKey(x.url) === `${to.provider === "stashdb" ? "stashdb.org" : "theporndb.net"}/performers/${to.id}`);
  if (refersTo(a, b) || refersTo(b, a)) return true;
  const links = new Set((a.urls || []).map(x => linkKey(x.url)).filter(Boolean));
  return (b.urls || []).some(x => links.has(linkKey(x.url)));
}

async function request(url, options = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000), headers: { "User-Agent": userAgent, ...options.headers } });
    if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
      const delay = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      if (delay > 60) throw new Error("Remote service requested a longer retry delay; retry later");
      await sleep(Math.max(1000 * 2 ** attempt, (Number.isFinite(delay) ? delay : 0) * 1000));
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    return response;
  }
}

async function collect(entries, providers, cachePath) {
  const cache = existsSync(cachePath) ? readJSON(cachePath) : {};
  for (const { name, client } of providers) {
    cache[name] ||= {};
    const pending = entries.filter(e => !cache[name][e.name]);
    for (const batch of chunks(pending, 8)) {
      const variables = Object.fromEntries(batch.map((e, i) => [`q${i}`, { names: e.name, page: 1, per_page: 100, direction: "ASC", sort: "NAME" }]));
      const query = `query(${batch.map((_, i) => `$q${i}:PerformerQueryInput!`).join(",")}){${batch.map((_, i) => `p${i}:queryPerformers(input:$q${i}){count performers{${fields}}}`).join("\n")}}`;
      const response = await request(client.endpoint, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ApiKey: client.apiKey }, body: JSON.stringify({ query, variables }) });
      const payload = await response.json();
      if (payload.errors?.length || !payload.data) throw new Error(`${name}: performer query failed`);
      for (let i = 0; i < batch.length; i++) {
        const result = payload.data[`p${i}`];
        if (!Array.isArray(result?.performers)) throw new Error(`${name}: unexpected result shape`);
        cache[name][batch[i].name] = { ...result, retrievedAt: new Date().toISOString() };
      }
      saveJSON(cachePath, cache);
      console.log(`${name}: ${entries.filter(e => cache[name][e.name]).length}/${entries.length} names checked`);
      await sleep(150);
    }
  }
  return cache;
}

export function resolveProfiles(entries, cache, resolutions = {}) {
  const groups = [], review = [];
  for (let entry of entries) {
    const matches = [];
    let reason;
    const resolution = resolutions[entry.name];
    if (resolution) {
      if (!safeURL(resolution.evidenceURL) || !resolution.titlePattern) throw new Error(`Incomplete reviewed resolution for ${entry.name}`);
      const p = cache[resolution.provider]?.[entry.name]?.performers.find(p => p.id === resolution.id);
      if (!p || !exactCandidates(entry, [p]).length) throw new Error(`Reviewed identity no longer available: ${entry.name}`);
      const sources = entry.sources.filter(s => new RegExp(resolution.titlePattern, "i").test(s.title));
      if (sources.length < entry.sources.length) review.push({ name: entry.name, reason: "title not covered by reviewed disambiguation", titleCount: entry.sources.length - sources.length });
      if (!sources.length) continue;
      entry = { ...entry, sources, resolution };
      matches.push({ ...p, provider: resolution.provider, retrievedAt: cache[resolution.provider][entry.name].retrievedAt });
    }
    for (const [provider, results] of Object.entries(cache)) {
      if (resolution) break;
      const result = results[entry.name];
      if (!result) { reason = "provider lookup missing"; break; }
      if (result.count > result.performers.length) { reason = "provider results truncated"; break; }
      const exact = exactCandidates(entry, result.performers);
      if (exact.length > 1) { reason = `multiple exact identities on ${provider}`; break; }
      if (exact.length === 1) matches.push({ ...exact[0], provider, retrievedAt: result.retrievedAt });
    }
    if (!reason && matches.length > 1 && !sameProfile(matches[0], matches[1])) {
      // A bare secondary record adds no corroboration. Keep the uniquely matched,
      // sourced primary record without importing the uncorroborated record's data.
      const sourced = matches.filter(p => p.urls?.length);
      if (sourced.length === 1 && matches.every(p => normalizeName(p.name) === normalizeName(sourced[0].name))) matches.splice(0, matches.length, sourced[0]);
      else reason = "providers have no shared identity link";
    }
    if (reason || !matches.length) {
      review.push({ name: entry.name, reason: reason || "no exact public performer profile", titleCount: entry.title_count });
      continue;
    }
    let group = groups.find(g => g.providers.some(a => matches.some(b => sameProfile(a, b))));
    if (!group) { group = { name: matches[0].name, providers: [], entries: [] }; groups.push(group); }
    for (const match of matches) if (!group.providers.some(p => p.provider === match.provider && p.id === match.id)) group.providers.push(match);
    group.entries.push(entry);
  }
  return { groups, review };
}

async function wikipedia(groups, cachePath) {
  const cache = existsSync(cachePath) ? readJSON(cachePath) : {};
  const wikidataPath = resolve(dirname(cachePath), "wikidata-cache.json");
  const entities = existsSync(wikidataPath) ? readJSON(wikidataPath) : {};
  const idsFor = group => group.providers.flatMap(p => p.urls || []).map(x => x.url.match(/wikidata\.org\/wiki\/(Q\d+)/)?.[1]).filter(Boolean);
  const ids = [...new Set(groups.flatMap(idsFor))];
  for (const batch of chunks(ids.filter(id => !(id in entities)), 40)) {
    const url = new URL("https://www.wikidata.org/w/api.php");
    url.search = new URLSearchParams({ action: "wbgetentities", ids: batch.join("|"), props: "sitelinks", sitefilter: "enwiki", format: "json" });
    const payload = await (await request(url)).json();
    if (!payload.entities) throw new Error("Wikidata sitelink lookup failed");
    for (const id of batch) entities[id] = payload.entities[id]?.sitelinks?.enwiki?.title || null;
    saveJSON(wikidataPath, entities);
  }
  const articleTitle = group => {
    const linked = group.providers.flatMap(p => p.urls || []).map(x => x.url.match(/^https?:\/\/en\.wikipedia\.org\/wiki\/([^#?]+)/)?.[1]).find(Boolean);
    return linked ? decodeURIComponent(linked).replaceAll("_", " ") : idsFor(group).map(id => entities[id]).find(Boolean) || group.name;
  };
  // Resolve real pages in batches; a title existing is insufficient to establish identity.
  for (const batch of chunks(groups.filter(g => !(g.name in cache) || (!cache[g.name] && articleTitle(g) !== g.name)), 20)) {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.search = new URLSearchParams({ action: "query", titles: batch.map(articleTitle).join("|"), redirects: "1", prop: "extracts|pageimages|pageprops|info", exintro: "1", explaintext: "1", piprop: "thumbnail|name", pithumbsize: "480", inprop: "url", format: "json" });
    const payload = await (await request(url)).json();
    if (!payload.query) throw new Error("Wikipedia lookup failed");
    const pages = Object.values(payload.query.pages);
    const redirects = new Map([...(payload.query.normalized || []), ...(payload.query.redirects || [])].map(r => [r.from, r.to]));
    for (const group of batch) {
      let title = articleTitle(group);
      const seen = new Set();
      while (redirects.has(title) && !seen.has(title)) { seen.add(title); title = redirects.get(title); }
      const page = pages.find(p => p.title === title);
      const knownIds = idsFor(group);
      const isPerformer = /pornographic|pornography|adult (?:film|entertainment|performer)|porn (?:actress|actor|star)/i.test(page?.extract || "");
      const valid = page && !("missing" in page) && !("disambiguation" in (page.pageprops || {})) && (knownIds.includes(page.pageprops?.wikibase_item) || (normalizeName(page.title) === normalizeName(group.name) && isPerformer));
      cache[group.name] = valid ? { title: page.title, url: page.fullurl, extract: page.extract?.split(/\n+/)[0].slice(0, 900), thumbnail: page.thumbnail?.source || null, imageTitle: page.pageimage || null, wikidataId: page.pageprops?.wikibase_item, retrievedAt: new Date().toISOString(), license: "CC BY-SA; see article history for attribution" } : null;
    }
    saveJSON(cachePath, cache);
    console.log(`Wikipedia: ${Object.keys(cache).length}/${groups.length} profiles checked`);
    await sleep(150);
  }
  return cache;
}

function classifyLink(url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (host.endsWith("wikipedia.org")) return "Wikipedia";
  if (["twitter.com", "x.com"].includes(host)) return "X";
  if (host === "instagram.com") return "Instagram";
  if (host === "tiktok.com") return "TikTok";
  if (host === "youtube.com" || host === "youtu.be") return "YouTube";
  if (host === "reddit.com") return "Reddit";
  if (host === "onlyfans.com") return "OnlyFans";
  if (host === "fansly.com") return "Fansly";
  if (host === "bsky.app") return "Bluesky";
  return host;
}

export function makePlan(groups, wiki, assets) {
  const profiles = [];
  for (const group of groups) {
    const primary = group.providers[0];
    const aliases = [...new Set(group.entries.flatMap(e => [e.name, ...e.variants]))];
    const linked = new Map();
    // Recheck both the ID and current title: an old export must not tag changed assets.
    for (const entry of group.entries) for (const source of entry.sources) {
      const asset = assets.get(source.id);
      if (asset?.kind === "video" && [entry.name, ...entry.variants].some(n => titleMatches(asset.title, n))) linked.set(asset.id, { id: asset.id, title: asset.title, matchedName: entry.name });
    }
    if (!linked.size) continue;
    const article = wiki[group.name];
    const summary = article?.extract || group.summary || `${group.name} is an adult performer.${primary.career_start_year ? ` Career began in ${primary.career_start_year}.` : ""}${primary.career_end_year ? ` Listed career end: ${primary.career_end_year}.` : ""}`;
    const links = new Map();
    for (const provider of group.providers) {
      for (const item of provider.urls || []) {
        const url = safeURL(item.url);
        if (!url || new URL(url).hostname.endsWith("wikipedia.org")) continue;
        const key = linkKey(url) || url;
        if (!links.has(key)) links.set(key, { url, label: classifyLink(url), source: provider.provider, status: "source-listed" });
      }
    }
    if (article) links.set(article.url, { url: article.url, label: "Wikipedia", source: "wikipedia", status: "article-checked" });
    const sources = group.providers.map(p => ({ provider: p.provider, id: p.id, name: p.name, retrievedAt: p.retrievedAt, url: p.profile_url || (p.provider === "stashdb" ? `https://stashdb.org/performers/${p.id}` : `https://theporndb.net/performers/${p.id}`) }));
    for (const entry of group.entries) if (entry.resolution) sources.push({ provider: "identity-review", id: hash(entry.resolution.evidenceURL), url: entry.resolution.evidenceURL, titlePattern: entry.resolution.titlePattern });
    const imageCandidates = group.providers.flatMap(p => (p.images || []).map(image => ({ ...image, provider: p.provider }))).filter(i => safeURL(i.url));
    // Prefer a portrait close to thumbnail resolution over a full scene image.
    imageCandidates.sort((a, b) => (Math.abs(a.width / a.height - 0.75) * 1000 + Math.abs(a.width - 480)) - (Math.abs(b.width / b.height - 0.75) * 1000 + Math.abs(b.width - 480)));
    if (article?.thumbnail) imageCandidates.push({ url: article.thumbnail, provider: "wikipedia", attribution: article.url });
    profiles.push({ key: `${primary.provider}:${primary.id}`, name: group.name, aliases, summary, wikipedia: article || null, links: [...links.values()], sources, images: imageCandidates.slice(0, 5), assets: [...linked.values()] });
  }
  return profiles;
}

async function downloadPortrait(profile, dataDir) {
  const directory = resolve(dataDir, "generated/profiles");
  mkdirSync(directory, { recursive: true });
  for (const image of profile.images) {
    const base = hash(image.url);
    for (const ext of ["jpg", "png", "webp"]) if (existsSync(resolve(directory, `${base}.${ext}`))) return { url: `/generated/profiles/${base}.${ext}`, source: image.url, provider: image.provider };
    try {
      const response = await request(image.url);
      const type = response.headers.get("content-type")?.split(";")[0];
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
      if (!ext || Number(response.headers.get("content-length")) > 10000000) { await response.body?.cancel(); continue; }
      const reader = response.body.getReader(), parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 10000000) { await reader.cancel(); throw new Error("Portrait exceeds size limit"); }
        parts.push(value);
      }
      const bytes = Buffer.concat(parts);
      if (!bytes.length) continue;
      writeFileSync(resolve(directory, `${base}.${ext}`), bytes);
      return { url: `/generated/profiles/${base}.${ext}`, source: image.url, provider: image.provider };
    } catch { /* Try the next source image; retain a missing-image result if all fail. */ }
  }
  return null;
}

export function applyProfiles(db, profiles, { runId, timestamp = new Date().toISOString() }) {
  const report = { createdTopics: 0, updatedTopics: 0, createdAssociations: 0, skippedAssociations: 0, profilesWithoutImage: [], topicIds: [] };
  const existing = db.prepare("SELECT * FROM topics").all();
  const existingSources = new Map();
  for (const topic of existing) {
    const metadata = JSON.parse(topic.metadata_json || "{}");
    for (const source of metadata.profile?.sources || []) existingSources.set(`${source.provider}:${source.id}`, topic);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const profile of profiles) {
      const candidates = new Map(profile.sources.map(s => existingSources.get(`${s.provider}:${s.id}`)).filter(Boolean).map(t => [t.id, t]));
      if (candidates.size > 1) throw new Error(`Conflicting existing topics for ${profile.name}`);
      let topic = [...candidates.values()][0];
      if (!topic) {
        const matches = existing.filter(t => normalizeName(t.name) === normalizeName(profile.name));
        if (matches.length) throw new Error(`Existing topic needs identity review: ${profile.name}`);
      }
      const id = topic?.id || randomUUID();
      const previous = topic ? JSON.parse(topic.metadata_json || "{}") : {};
      const metadata = { ...previous, profile: { ...previous.profile, sources: profile.sources, links: profile.links, wikipedia: profile.wikipedia, image: profile.portrait, matching: "exact public name/alias; title mention", runId, updatedAt: timestamp } };
      const body = [profile.summary, "", "Public profiles:", ...profile.links.map(l => `- [${l.label}](${l.url})`), "", "Sources:", ...profile.sources.map(s => `- [${s.provider}](${s.url})`), ...(profile.wikipedia ? [`- [Wikipedia article and attribution](${profile.wikipedia.url})`] : [])].join("\n");
      const avatar = profile.portrait?.url || topic?.avatar_url || null;
      if (!avatar) report.profilesWithoutImage.push(profile.name);
      if (topic) {
        // Enrichment owns only blank fields or fields unchanged since its last write.
        const managed = previous.profile?.managed || {};
        const keep = (field, next) => !topic[field] || topic[field] === managed[field] ? next : topic[field];
        const values = { summary: keep("summary", profile.summary), body_markdown: keep("body_markdown", body), avatar_url: keep("avatar_url", avatar) };
        metadata.profile.managed = Object.fromEntries(Object.entries(values).filter(([field]) => !topic[field] || topic[field] === managed[field]));
        db.prepare("UPDATE topics SET summary=?,body_markdown=?,avatar_url=?,updated_at=?,metadata_json=? WHERE id=?").run(values.summary, values.body_markdown, values.avatar_url, timestamp, JSON.stringify(metadata), id);
        report.updatedTopics++;
      } else {
        metadata.profile.managed = { summary: profile.summary, body_markdown: body, avatar_url: avatar };
        let slug = profile.name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
        if (db.prepare("SELECT 1 FROM topics WHERE slug=?").get(slug)) slug += `-${hash(profile.key).slice(0, 8)}`;
        db.prepare("INSERT INTO topics(id,slug,name,summary,body_markdown,avatar_url,topic_type,created_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, slug, profile.name, profile.summary, body, avatar, "person", timestamp, timestamp, JSON.stringify(metadata));
        report.createdTopics++;
      }
      for (const alias of profile.aliases) db.prepare("INSERT OR IGNORE INTO topic_aliases(id,topic_id,alias,normalized_alias) VALUES(?,?,?,?)").run(randomUUID(), id, alias, normalizeName(alias));
      for (const asset of profile.assets) {
        const current = db.prepare("SELECT title,kind FROM assets WHERE id=?").get(asset.id);
        if (!current || current.kind !== "video" || current.title !== asset.title) { report.skippedAssociations++; continue; }
        if (db.prepare("SELECT 1 FROM annotations a JOIN annotation_topics at ON at.annotation_id=a.id WHERE a.asset_id=? AND at.topic_id=?").get(asset.id, id)) continue;
        const annotationId = randomUUID();
        const note = `Public profile matched to the title mention “${asset.matchedName}”. Title-based association; on-screen appearance has not been verified. Enrichment run: ${runId}.`;
        db.prepare("INSERT INTO annotations(id,asset_id,motivation,note_markdown,confidence,origin,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(annotationId, asset.id, "tagging", note, 0.85, "profile-enrichment", "private", timestamp, timestamp);
        db.prepare("INSERT INTO annotation_topics(annotation_id,topic_id,role) VALUES(?,?,?)").run(annotationId, id, "mentioned");
        report.createdAssociations++;
      }
      report.topicIds.push(id);
    }
    db.exec("DELETE FROM search_index");
    const insert = db.prepare("INSERT INTO search_index(entity_id,entity_type,title,body,tags) VALUES(?,?,?,?,?)");
    for (const asset of db.prepare("SELECT id,title,description FROM assets").all()) {
      const tags = db.prepare("SELECT DISTINCT t.name FROM topics t JOIN annotation_topics at ON at.topic_id=t.id JOIN annotations a ON a.id=at.annotation_id WHERE a.asset_id=?").all(asset.id).map(t => t.name).join(" ");
      insert.run(asset.id, "asset", asset.title, asset.description || "", tags);
    }
    for (const topic of db.prepare("SELECT id,name,summary,body_markdown FROM topics").all()) insert.run(topic.id, "topic", topic.name, `${topic.summary || ""} ${topic.body_markdown || ""}`, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !["--apply", "--offline"].includes(a))) throw new Error("Usage: node --env-file-if-exists=.env apps/scanner/src/profile-enrichment.js [--offline] [--apply]");
  const dataDir = resolve(process.env.KIWI_DATA_DIR || "data");
  const dir = resolve(dataDir, "exports/profile-enrichment");
  const entries = readJSON(resolve(dataDir, "exports/names-from-titles/evidence.json")).entries;
  const cachePath = resolve(dir, "provider-cache.json"), wikiPath = resolve(dir, "wikipedia-cache.json");
  const cache = args.includes("--offline") ? readJSON(cachePath) : await collect(entries, configuredProviders(), cachePath);
  const reviewedPath = resolve(dir, "reviewed-profiles.json");
  const reviewed = existsSync(reviewedPath) ? readJSON(reviewedPath) : {};
  const { groups, review } = resolveProfiles(entries, cache, reviewed.resolutions);
  for (const profile of reviewed.profiles || []) {
    if (!safeURL(profile.sourceURL) || !profile.summary) throw new Error("Reviewed public profile needs a source URL and summary");
    const matchedEntries = entries.filter(e => profile.names.includes(e.name));
    if (!matchedEntries.length || groups.some(g => g.entries.some(e => profile.names.includes(e.name)))) throw new Error(`Reviewed profile overlaps another identity: ${profile.name}`);
    groups.push({ name: profile.name, summary: profile.summary, entries: matchedEntries, providers: [{ provider: "public-profile", id: hash(profile.sourceURL), profile_url: profile.sourceURL, name: profile.name, urls: profile.links.map(url => ({ url })), images: profile.image ? [{ url: profile.image, width: 480, height: 480 }] : [], retrievedAt: profile.retrievedAt }] });
    for (let i = review.length - 1; i >= 0; i--) if (profile.names.includes(review[i].name)) review.splice(i, 1);
  }
  const wiki = args.includes("--offline") ? readJSON(wikiPath) : await wikipedia(groups, wikiPath);
  const dbPath = resolve(dataDir, "kiwi.db");
  const db = new DatabaseSync(dbPath, { readOnly: !args.includes("--apply") });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
  try {
    const assets = new Map(db.prepare("SELECT id,title,kind FROM assets").all().map(a => [a.id, a]));
    const profiles = makePlan(groups, wiki, assets);
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    saveJSON(resolve(dir, "plan.json"), { runId, profiles, review });
    console.log(JSON.stringify({ profiles: profiles.length, wikipedia: profiles.filter(p => p.wikipedia).length, associations: profiles.reduce((n, p) => n + p.assets.length, 0), review: review.length }));
    if (!args.includes("--apply")) return;
    const backupPath = resolve(dataDir, "backups", `before-profiles-${runId}.db`);
    mkdirSync(dirname(backupPath), { recursive: true });
    await backup(db, backupPath);
    for (const batch of chunks(profiles, 4)) {
      const portraits = await Promise.allSettled(batch.map(p => downloadPortrait(p, dataDir)));
      portraits.forEach((r, i) => { batch[i].portrait = r.status === "fulfilled" ? r.value : null; });
      console.log(`Portraits: ${Math.min(profiles.indexOf(batch[0]) + batch.length, profiles.length)}/${profiles.length}`);
    }
    const report = applyProfiles(db, profiles, { runId });
    saveJSON(resolve(dir, `applied-${runId}.json`), { runId, backupPath, ...report, profiles, review });
    saveJSON(resolve(dir, "latest-report.json"), { runId, backupPath, ...report, totalProfiles: profiles.length, wikipedia: profiles.filter(p => p.wikipedia).length, videos: new Set(profiles.flatMap(p => p.assets.map(a => a.id))).size, review });
    console.log(JSON.stringify({ runId, backupPath, ...report, topicIds: undefined }));
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

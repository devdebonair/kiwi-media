import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { db, tagAssetWithTopic } from "@kiwi/database";
import {
  ConfigError, cookiesPath, createHttp, createTunnelManager, describePlugins, destinationFor, getDownloader, getPlugin, getVpnProfile,
  listVpnTypes, normalizeDomain, piaRegions, planDownload, publicDownloader, publicVpnProfile, downloadBlocker, serializeDownload,
  testVpnProfile, validateCookiesFile, validatePluginConfig, validateVpnConfig, vpnTypes, pluginSearchable,
} from "@kiwi/downloads";

const now = () => new Date().toISOString();
const activeStatuses = "('queued','running','canceling')";
const text = (value, label, max = 100) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new ConfigError(`${label} must be 1–${max} characters.`);
  return value.trim();
};
const optionalProfile = id => {
  if (id === null || id === undefined || id === "") return null;
  if (!getVpnProfile(id)) throw new ConfigError("That VPN profile no longer exists.", 404);
  return id;
};
function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
// Known errors carry a status code; anything else is a server fault.
const handle = fn => async (req, reply) => {
  try { return await fn(req, reply); }
  catch (error) {
    if (error.statusCode || error.name === "DownloadError") return reply.code(error.statusCode || 502).send({ error: error.message });
    throw error;
  }
};

// Section filters for the Downloads page. Canceled downloads are listed with failures.
const statusFilters = { active: "status IN ('queued','running','canceling')", completed: "status='completed'", failed: "status IN ('failed','canceled')" };

export function registerDownloads(app, { resolveTopic } = {}) {
  // Resolves tag choices ({ topicId } or { name }), creating named tags. Call inside a transaction.
  const topicIdsFor = (choices, timestamp) => {
    if (choices === undefined) return [];
    if (!Array.isArray(choices) || choices.length > 50) throw new ConfigError("Tags must be a list of up to 50 tags.");
    return [...new Set(choices.map(choice => {
      const { topic, code, error } = resolveTopic(choice, timestamp, true);
      if (!topic) throw new ConfigError(error, code);
      return topic.id;
    }))];
  };
  // Adds tags to downloads: completed ones tag their media now, others when they finish.
  const tagDownloads = (rows, choice) => {
    const timestamp = now();
    transaction(() => {
      const [topicId] = topicIdsFor([choice], timestamp);
      for (const row of rows) {
        const ids = JSON.parse(row.topic_ids_json || "[]");
        if (!ids.includes(topicId)) db.prepare("UPDATE downloads SET topic_ids_json=?,updated_at=? WHERE id=?").run(JSON.stringify([...ids, topicId]), timestamp, row.id);
        if (row.status === "completed") for (const assetId of JSON.parse(row.asset_ids_json)) {
          if (db.prepare("SELECT 1 FROM assets WHERE id=?").get(assetId)) tagAssetWithTopic(assetId, topicId, timestamp);
        }
      }
    });
  };
  const listed = row => { const { log, ...rest } = serializeDownload(row, { withAssets: true }); return rest; };

  const tunnels = createTunnelManager({ idleMs: 30_000, log: message => app.log.info(message) });
  app.addHook("onClose", async () => tunnels.closeAll());

  app.get("/api/v1/downloads/plugins", handle(async () => describePlugins()));

  app.get("/api/v1/downloaders", handle(async () => Promise.all(db.prepare("SELECT * FROM downloaders ORDER BY is_default DESC, name, id").all().map(row => publicDownloader(getDownloader(row.id))))));

  const setDefault = id => { db.prepare("UPDATE downloaders SET is_default=0 WHERE id!=?").run(id); db.prepare("UPDATE downloaders SET is_default=1 WHERE id=?").run(id); };
  app.post("/api/v1/downloaders", handle(async (req, reply) => {
    const body = req.body || {};
    const plugin = await getPlugin(body.plugin);
    const name = text(body.name ?? plugin.name, "Name");
    const config = validatePluginConfig(plugin, {}, body.config || {});
    const vpnProfileId = optionalProfile(body.vpnProfileId);
    const id = randomUUID(), timestamp = now();
    transaction(() => {
      db.prepare("INSERT INTO downloaders (id,name,plugin,config_json,vpn_profile_id,enabled,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, name, plugin.id, JSON.stringify(config), vpnProfileId, body.enabled === false ? 0 : 1, 0, timestamp, timestamp);
      if (body.isDefault || !db.prepare("SELECT 1 FROM downloaders WHERE is_default=1").get()) setDefault(id);
    });
    return reply.code(201).send(await publicDownloader(getDownloader(id)));
  }));

  app.patch("/api/v1/downloaders/:id", handle(async req => {
    const downloader = getDownloader(req.params.id);
    if (!downloader) throw new ConfigError("Downloader not found.", 404);
    const body = req.body || {};
    const updates = { name: downloader.name, config: downloader.config, vpn_profile_id: downloader.vpn_profile_id, enabled: downloader.enabled };
    if (body.name !== undefined) updates.name = text(body.name, "Name");
    if (body.config !== undefined) updates.config = validatePluginConfig(await getPlugin(downloader.plugin), downloader.config, body.config, Array.isArray(body.clearSecrets) ? body.clearSecrets : []);
    if (body.vpnProfileId !== undefined) updates.vpn_profile_id = optionalProfile(body.vpnProfileId);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw new ConfigError("enabled must be a boolean.");
      updates.enabled = Number(body.enabled);
    }
    transaction(() => {
      db.prepare("UPDATE downloaders SET name=?,config_json=?,vpn_profile_id=?,enabled=?,updated_at=? WHERE id=?").run(updates.name, JSON.stringify(updates.config), updates.vpn_profile_id, updates.enabled, now(), downloader.id);
      if (body.isDefault === true) setDefault(downloader.id);
    });
    return publicDownloader(getDownloader(downloader.id));
  }));

  app.delete("/api/v1/downloaders/:id", handle(async (req, reply) => {
    if (!getDownloader(req.params.id)) throw new ConfigError("Downloader not found.", 404);
    if (db.prepare(`SELECT 1 FROM downloads WHERE downloader_id=? AND status IN ${activeStatuses}`).get(req.params.id)) throw new ConfigError("Wait for this downloader's active downloads to finish, or cancel them first.", 409);
    transaction(() => {
      const wasDefault = db.prepare("SELECT is_default FROM downloaders WHERE id=?").get(req.params.id).is_default;
      db.prepare("DELETE FROM downloaders WHERE id=?").run(req.params.id);
      const next = wasDefault && db.prepare("SELECT id FROM downloaders ORDER BY created_at,id LIMIT 1").get();
      if (next) setDefault(next.id);
    });
    await rm(cookiesPath(req.params.id), { force: true });
    return reply.code(204).send();
  }));

  app.put("/api/v1/downloaders/:id/cookies", { bodyLimit: 3 * 1024 * 1024 }, handle(async req => {
    const downloader = getDownloader(req.params.id);
    if (!downloader) throw new ConfigError("Downloader not found.", 404);
    if (!(await getPlugin(downloader.plugin)).cookies) throw new ConfigError("This downloader does not use cookies.");
    const content = validateCookiesFile(req.body?.content);
    const path = cookiesPath(downloader.id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
    return publicDownloader(downloader);
  }));
  app.delete("/api/v1/downloaders/:id/cookies", handle(async req => {
    const downloader = getDownloader(req.params.id);
    if (!downloader) throw new ConfigError("Downloader not found.", 404);
    await rm(cookiesPath(downloader.id), { force: true });
    return publicDownloader(downloader);
  }));

  // Searches run through the downloader's default VPN profile, if it has one.
  app.post("/api/v1/downloaders/:id/search", handle(async req => {
    const downloader = getDownloader(req.params.id);
    if (!downloader) throw new ConfigError("Downloader not found.", 404);
    const plugin = await getPlugin(downloader.plugin);
    if (!pluginSearchable(plugin, downloader.config)) throw new ConfigError(`${downloader.name} does not support search.`);
    const query = text(req.body?.query, "Search", 300);
    const profile = getVpnProfile(downloader.vpn_profile_id);
    const tunnel = profile ? await tunnels.acquire(profile) : null;
    const http = createHttp({ proxyUrl: tunnel?.proxyUrl, signal: AbortSignal.timeout(45_000) });
    try { return { results: await plugin.search({ query, config: downloader.config, http }) }; }
    finally { http.close(); tunnel?.release(); }
  }));

  app.get("/api/v1/vpn/types", handle(async () => listVpnTypes()));
  app.get("/api/v1/vpn/pia/regions", handle(async () => piaRegions()));

  app.get("/api/v1/vpn/profiles", handle(async () => db.prepare("SELECT id FROM vpn_profiles ORDER BY name,id").all().map(publicVpnProfile)));
  app.post("/api/v1/vpn/profiles", handle(async (req, reply) => {
    const body = req.body || {};
    if (!Object.hasOwn(vpnTypes, body.type)) throw new ConfigError("Choose a VPN type.");
    const name = text(body.name, "Name");
    const config = validateVpnConfig(body.type, {}, body.config || {});
    const id = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO vpn_profiles (id,name,type,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, name, body.type, JSON.stringify(config), timestamp, timestamp);
    return reply.code(201).send(publicVpnProfile(getVpnProfile(id)));
  }));
  app.patch("/api/v1/vpn/profiles/:id", handle(async req => {
    const profile = getVpnProfile(req.params.id);
    if (!profile) throw new ConfigError("VPN profile not found.", 404);
    const body = req.body || {};
    const name = body.name === undefined ? profile.name : text(body.name, "Name");
    const config = body.config === undefined ? profile.config : validateVpnConfig(profile.type, profile.config, body.config, Array.isArray(body.clearSecrets) ? body.clearSecrets : []);
    // A new updated_at also retires any running tunnel built from the old settings.
    db.prepare("UPDATE vpn_profiles SET name=?,config_json=?,updated_at=? WHERE id=?").run(name, JSON.stringify(config), now(), profile.id);
    return publicVpnProfile(getVpnProfile(profile.id));
  }));
  app.delete("/api/v1/vpn/profiles/:id", handle(async (req, reply) => {
    const profile = getVpnProfile(req.params.id);
    if (!profile) throw new ConfigError("VPN profile not found.", 404);
    const users = [
      ...db.prepare("SELECT name FROM downloaders WHERE vpn_profile_id=?").all(profile.id).map(row => `downloader “${row.name}”`),
      ...db.prepare("SELECT domain FROM vpn_domain_rules WHERE vpn_profile_id=?").all(profile.id).map(row => `rule for ${row.domain}`),
    ];
    if (db.prepare(`SELECT 1 FROM downloads WHERE vpn_profile_id=? AND status IN ${activeStatuses}`).get(profile.id)) users.push("active downloads");
    // Removing a profile that is still referenced would silently send those downloads over the server's own connection.
    if (users.length) throw new ConfigError(`${profile.name} is still used by ${users.join(", ")}. Change those first.`, 409);
    db.prepare("DELETE FROM vpn_profiles WHERE id=?").run(profile.id);
    return reply.code(204).send();
  }));
  app.post("/api/v1/vpn/profiles/:id/test", handle(async req => {
    const profile = getVpnProfile(req.params.id);
    if (!profile) throw new ConfigError("VPN profile not found.", 404);
    return testVpnProfile(profile, tunnels);
  }));

  const rules = () => db.prepare("SELECT r.domain,r.vpn_profile_id,p.name vpn_name,r.created_at FROM vpn_domain_rules r JOIN vpn_profiles p ON p.id=r.vpn_profile_id ORDER BY r.domain").all();
  app.get("/api/v1/vpn/rules", handle(async () => rules()));
  app.post("/api/v1/vpn/rules", handle(async (req, reply) => {
    const domain = normalizeDomain(req.body?.domain);
    const profile = optionalProfile(req.body?.vpnProfileId);
    if (!profile) throw new ConfigError("Choose a VPN profile.");
    db.prepare("INSERT INTO vpn_domain_rules (domain,vpn_profile_id,created_at) VALUES (?,?,?) ON CONFLICT(domain) DO UPDATE SET vpn_profile_id=excluded.vpn_profile_id").run(domain, profile, now());
    return reply.code(201).send(rules());
  }));
  app.delete("/api/v1/vpn/rules/:domain", handle(async req => {
    db.prepare("DELETE FROM vpn_domain_rules WHERE domain=?").run(req.params.domain);
    return rules();
  }));

  app.get("/api/v1/downloads/destinations", handle(async () => db.prepare("SELECT id,name,absolute_path,enabled,read_only FROM library_roots ORDER BY name,id").all()
    .map(root => { const blocked = downloadBlocker(root); return { ...root, writable: !blocked, blocked_reason: blocked }; })));

  const vpnSummary = plan => ({ id: plan.profile?.id || null, name: plan.profile?.name || null, type: plan.profile?.type || null, mode: plan.vpnMode, reason: plan.reason });
  app.get("/api/v1/downloads/plan", handle(async req => {
    const source = text(req.query.source, "Link", 4096);
    const plan = await planDownload({ source, downloaderId: req.query.downloaderId || undefined, vpn: req.query.vpn || "auto" });
    return { downloader: { id: plan.downloader.id, name: plan.downloader.name, plugin: plan.plugin.id }, vpn: vpnSummary(plan) };
  }));

  // Active first, then newest. `status` narrows to one Downloads page section; `q` matches title or link.
  app.get("/api/v1/downloads", handle(async req => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200), offset = Math.max(Number(req.query.offset) || 0, 0);
    if (req.query.status && !statusFilters[req.query.status]) throw new ConfigError("status must be active, completed, or failed.");
    const filters = [statusFilters[req.query.status] || "1=1"], params = [];
    const query = String(req.query.q || "").trim().toLowerCase();
    if (query) { filters.push("(instr(lower(coalesce(title,'')),?) OR instr(lower(source),?))"); params.push(query, query); }
    const rows = db.prepare(`SELECT * FROM downloads WHERE ${filters.join(" AND ")} ORDER BY CASE WHEN status IN ${activeStatuses} THEN 0 ELSE 1 END, created_at DESC, id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return rows.map(req.query.status ? listed : row => { const { log, assets, ...rest } = listed(row); return rest; });
  }));
  app.get("/api/v1/downloads/summary", handle(async () => {
    const counts = Object.fromEntries(Object.entries(statusFilters).map(([key, where]) => [key, db.prepare(`SELECT count(*) n FROM downloads WHERE ${where}`).get().n]));
    return counts;
  }));
  app.post("/api/v1/downloads/topics", handle(async req => {
    const ids = req.body?.downloadIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== "string")) throw new ConfigError("Choose 1–500 downloads.");
    const rows = ids.map(id => db.prepare("SELECT * FROM downloads WHERE id=?").get(id)).filter(Boolean);
    tagDownloads(rows, req.body);
    return { downloads: rows.map(row => listed(db.prepare("SELECT * FROM downloads WHERE id=?").get(row.id))) };
  }));
  app.post("/api/v1/downloads/:id/topics", handle(async req => {
    const row = db.prepare("SELECT * FROM downloads WHERE id=?").get(req.params.id);
    if (!row) throw new ConfigError("Download not found.", 404);
    tagDownloads([row], req.body);
    const download = listed(db.prepare("SELECT * FROM downloads WHERE id=?").get(row.id));
    return { topics: download.topics, download };
  }));
  // Only queued tags can be removed here; tags on imported media are managed on the media itself.
  app.delete("/api/v1/downloads/:id/topics/:topicId", handle(async req => {
    const row = db.prepare("SELECT * FROM downloads WHERE id=?").get(req.params.id);
    if (!row) throw new ConfigError("Download not found.", 404);
    if (row.status === "completed") throw new ConfigError("This download finished; remove the tag from the media instead.", 409);
    db.prepare("UPDATE downloads SET topic_ids_json=?,updated_at=? WHERE id=?").run(JSON.stringify(JSON.parse(row.topic_ids_json).filter(id => id !== req.params.topicId)), now(), row.id);
    const download = listed(db.prepare("SELECT * FROM downloads WHERE id=?").get(row.id));
    return { topics: download.topics, download };
  }));
  app.get("/api/v1/downloads/:id", handle(async req => {
    const row = db.prepare("SELECT * FROM downloads WHERE id=?").get(req.params.id);
    if (!row) throw new ConfigError("Download not found.", 404);
    return serializeDownload(row);
  }));

  app.post("/api/v1/downloads", handle(async (req, reply) => {
    const body = req.body || {};
    const sources = [...new Set((Array.isArray(body.sources) ? body.sources : [body.source]).filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean))];
    if (!sources.length) throw new ConfigError("Paste at least one link.");
    if (sources.length > 200) throw new ConfigError("Add at most 200 links at a time.");
    if (sources.some(source => source.length > 4096)) throw new ConfigError("Links must be shorter than 4096 characters.");
    const { root, subfolder } = destinationFor(body.libraryRootId, body.subfolder || "");
    const blocked = downloadBlocker(root);
    if (blocked) throw new ConfigError(blocked);
    const plans = [];
    for (const source of sources) {
      try { plans.push({ source, ...await planDownload({ source, downloaderId: body.downloaderId || undefined, vpn: body.vpn || "auto" }) }); }
      catch (error) { if (error.statusCode) error.message = sources.length > 1 ? `${source.slice(0, 80)}: ${error.message}` : error.message; throw error; }
    }
    const start = Date.now(), ids = [];
    transaction(() => {
      const topicIds = JSON.stringify(topicIdsFor(body.topics, new Date(start).toISOString()));
      const insert = db.prepare("INSERT INTO downloads (id,source,downloader_id,plugin,library_root_id,subfolder,vpn_mode,vpn_profile_id,vpn_reason,status,message,topic_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const [index, plan] of plans.entries()) {
        const id = randomUUID();
        ids.push(id);
        // Millisecond steps keep pasted links queued in their original order.
        const timestamp = new Date(start + index).toISOString();
        insert.run(id, plan.source, plan.downloader.id, plan.plugin.id, root.id, subfolder, plan.vpnMode, plan.profile?.id || null, plan.reason, "queued", "Waiting to start", topicIds, timestamp, timestamp);
      }
    });
    return reply.code(202).send(ids.map(id => serializeDownload(db.prepare("SELECT * FROM downloads WHERE id=?").get(id))));
  }));

  app.post("/api/v1/downloads/:id/cancel", handle(async req => {
    const row = db.prepare("SELECT * FROM downloads WHERE id=?").get(req.params.id);
    if (!row) throw new ConfigError("Download not found.", 404);
    if (row.status === "queued") db.prepare("UPDATE downloads SET status='canceled',message='Canceled',finished_at=?,updated_at=? WHERE id=? AND status='queued'").run(now(), now(), row.id);
    else if (row.status === "running") db.prepare("UPDATE downloads SET status='canceling',message='Canceling',updated_at=? WHERE id=? AND status='running'").run(now(), row.id);
    else if (row.status !== "canceling") throw new ConfigError("Only queued or running downloads can be canceled.", 409);
    return serializeDownload(db.prepare("SELECT * FROM downloads WHERE id=?").get(row.id));
  }));

  // Automatic VPN choices are resolved again so retries follow the current rules.
  app.post("/api/v1/downloads/:id/retry", handle(async req => {
    const row = db.prepare("SELECT * FROM downloads WHERE id=?").get(req.params.id);
    if (!row) throw new ConfigError("Download not found.", 404);
    if (!["failed", "canceled"].includes(row.status)) throw new ConfigError("Only failed or canceled downloads can be retried.", 409);
    const downloader = getDownloader(row.downloader_id);
    if (!downloader) throw new ConfigError("The downloader for this job was removed.", 409);
    const plan = await planDownload({ source: row.source, downloaderId: downloader.id, vpn: row.vpn_mode === "profile" ? row.vpn_profile_id : row.vpn_mode });
    db.prepare("UPDATE downloads SET status='queued',vpn_profile_id=?,vpn_reason=?,message='Waiting to start',error=NULL,progress=NULL,bytes_done=NULL,bytes_total=NULL,speed=NULL,eta_seconds=NULL,finished_at=NULL,updated_at=? WHERE id=?")
      .run(plan.profile?.id || null, plan.reason, now(), row.id);
    return serializeDownload(db.prepare("SELECT * FROM downloads WHERE id=?").get(row.id));
  }));

  app.delete("/api/v1/downloads/:id", handle(async (req, reply) => {
    const result = db.prepare(`DELETE FROM downloads WHERE id=? AND status NOT IN ${activeStatuses}`).run(req.params.id);
    if (!result.changes) {
      if (db.prepare("SELECT 1 FROM downloads WHERE id=?").get(req.params.id)) throw new ConfigError("Cancel the download before removing it.", 409);
      throw new ConfigError("Download not found.", 404);
    }
    return reply.code(204).send();
  }));
}

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getMedia, syncHouseholdLibrary } from "@kiwi/media";
import { db, ensureWatchlist, profileContext, currentProfile, ratingKey, ratingLevel, levelAllowed, MAX_LEVEL, RATINGS } from "@kiwi/database";

// Netflix-style profiles. A profile is a row in users; choosing one sets a signed cookie naming it.
// Every API request runs as that profile (see profileContext), which limits what content it can see.
// With a single profile that has no PIN, it is chosen automatically, so a one-person install never sees a picker.

export const OWNER_ID = "user-local";
const COOKIE = "kiwi_profile";
const COOKIE_MAX_AGE = 365 * 86_400;
const MAX_PROFILES = 12;
const PIN = /^\d{4}$/;
const COLORS = ["#2f9e6b", "#3d7be0", "#d9534f", "#e8a33d", "#8e5bd8", "#2bb3c0", "#d0569b", "#6b7a8f"];
// Wrong PINs: this many tries, then the profile is locked for a while.
const MAX_ATTEMPTS = 5, LOCKOUT_MS = 5 * 60_000;

const now = () => new Date().toISOString();

const secret = (() => {
  let row = db.prepare("SELECT value FROM app_state WHERE key='profile-secret'").get();
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO app_state VALUES ('profile-secret', ?)").run(randomBytes(32).toString("base64url"));
    row = db.prepare("SELECT value FROM app_state WHERE key='profile-secret'").get();
  }
  return row.value;
})();
const sign = value => createHmac("sha256", secret).update(value).digest("base64url");

const hashPin = pin => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${scryptSync(pin, salt, 32).toString("base64url")}`;
};
const pinMatches = (pin, stored) => {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(String(pin), Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
};

const row = id => db.prepare("SELECT * FROM users WHERE id=?").get(id);
const allRows = () => db.prepare("SELECT * FROM users ORDER BY position, created_at, id").all();

// What a request runs as.
const toProfile = user => ({
  id: user.id, name: user.display_name, role: user.role, isAdmin: user.role === "admin", isOwner: user.id === OWNER_ID,
  maxRating: user.max_rating, allowUnrated: Boolean(user.allow_unrated), locked: Boolean(user.pin_hash),
});
// What the picker shows: nothing about limits.
const publicProfile = user => ({
  id: user.id, name: user.display_name, avatar: user.avatar, color: user.color || COLORS[0],
  locked: Boolean(user.pin_hash), isAdmin: user.role === "admin", isOwner: user.id === OWNER_ID,
});
const fullProfile = user => ({ ...publicProfile(user), maxRating: ratingKey(user.max_rating), allowUnrated: Boolean(user.allow_unrated) });

const parseCookies = header => Object.fromEntries(String(header || "").split(";").map(part => part.trim().split("=")).filter(([key]) => key).map(([key, ...rest]) => [key, decodeURIComponent(rest.join("="))]));
const cookieFor = user => { const value = `${user.id}.${user.session_version}`; return `${value}.${sign(value)}`; };
const setCookie = (reply, user) => reply.header("Set-Cookie", `${COOKIE}=${encodeURIComponent(cookieFor(user))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
const clearCookie = reply => reply.header("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

function fromCookie(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 3) return null;
  const signature = parts.pop(), value = parts.join(".");
  const expected = sign(value);
  const given = Buffer.from(signature), wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  const version = Number(parts.pop()), id = parts.join(".");
  const user = row(id);
  return user && user.session_version === version ? user : null;
}

export function resolveProfile(req) {
  const user = fromCookie(req);
  if (user) return toProfile(user);
  const users = db.prepare("SELECT * FROM users LIMIT 2").all();
  return users.length === 1 && !users[0].pin_hash ? toProfile(users[0]) : null;
}

// --------------------------------------------------------------------------------------------------
// Which routes need what

// Reachable before a profile is chosen: the picker and what it needs.
const PUBLIC = [
  ["GET", /^\/api\/v1\/health$/], ["GET", /^\/api\/v1\/profiles$/], ["GET", /^\/api\/v1\/session$/], ["GET", /^\/api\/v1\/ratings$/],
  ["POST", /^\/api\/v1\/profiles\/:id\/select$/], ["POST", /^\/api\/v1\/session\/sign-out$/],
  // HLS segments: Apple's native player may fetch them without cookies. A session id is an unguessable
  // capability that only the profile-checked /file route hands out.
  ["GET", /^\/api\/v1\/hls\/:session\/:file$/],
];
// Server configuration, downloads, and library management are for admins. Tagging stays open to everyone.
const ADMIN = [
  [null, /^\/api\/v1\/(media|downloads|downloaders|vpn)(\/|$)/], [null, /^\/api\/v1\/library\/(roots|scan)/], [null, /^\/api\/v1\/(jobs|libraries)/],
  [null, /^\/api\/v1\/(assets|titles)\/:id\/(download|rating)$/], [null, /^\/api\/v1\/library\/roots\/:id\/rating$/],
  ["POST", /^\/api\/v1\/profiles$/], ["PATCH", /^\/api\/v1\/profiles\/:id$/], ["DELETE", /^\/api\/v1\/profiles\/:id$/],
];
const matches = (list, method, url) => list.some(([verb, pattern]) => (!verb || verb === method) && pattern.test(url));
// Tag edits on folders (/library/roots/:id/topics) follow the folder rule above; that is server configuration.

const assetLevel = id => db.prepare("SELECT level FROM asset_ratings WHERE asset_id=?").get(id);
const titleLevel = id => db.prepare("SELECT level FROM title_ratings WHERE title_id=?").get(id);
export const assetAllowed = (id, profile = currentProfile()) => { const found = assetLevel(id); return !found || levelAllowed(found.level, profile); };
export const titleAllowed = (id, profile = currentProfile()) => { const found = titleLevel(id); return !found || levelAllowed(found.level, profile); };

// Single-item routes answer 404 for content the profile may not see, as if it did not exist.
function hiddenFrom(req, profile) {
  const url = req.routeOptions?.url || "";
  const { id, file, ref } = req.params || {};
  if (/^\/api\/v1\/assets\/:id(\/|$)/.test(url)) return !assetAllowed(id, profile);
  if (/^\/api\/v1\/titles\/:id(\/|$)/.test(url)) return !titleAllowed(id, profile);
  if (url === "/api/v1/titles/:ref") { const decoded = decodeURIComponent(ref || ""); return !decoded.startsWith("tmdb:") && !titleAllowed(decoded, profile); }
  if (url === "/api/v1/subtitles/:file") {
    const track = db.prepare("SELECT asset_id FROM subtitle_tracks WHERE id=?").get(String(file || "").replace(/\.vtt$/, ""));
    return Boolean(track) && !assetAllowed(track.asset_id, profile);
  }
  if (/^\/api\/v1\/clips\/:id$/.test(url)) {
    const clip = db.prepare("SELECT asset_id FROM annotations WHERE id=?").get(id);
    return Boolean(clip) && !assetAllowed(clip.asset_id, profile);
  }
  return false;
}

// Must be called before any other route or plugin is registered, so the hooks cover them all.
export function registerProfiles(app) {
  app.decorateRequest("profile", null);
  app.addHook("onRequest", async (req, reply) => {
    const url = req.routeOptions?.url;
    const path = req.url.split("?")[0];
    // Web app files (logos, placeholder art) are public; generated thumbnails and the API need a profile.
    if (path.startsWith("/assets/")) return;
    req.profile = resolveProfile(req);
    if (url && matches(PUBLIC, req.method, url)) return;
    if (!req.profile) return reply.code(401).send({ error: "Choose a profile first.", code: "profile_required" });
    if (url && matches(ADMIN, req.method, url) && !req.profile.isAdmin) return reply.code(403).send({ error: "Only an admin can do that.", code: "admin_only" });
  });
  app.addHook("preHandler", (req, reply, done) => {
    const profile = req.profile;
    if (!profile) return done();
    if (hiddenFrom(req, profile)) { reply.code(404).send({ error: "Not found" }); return; }
    // Choosing a different source for a stream is an admin action; searching again after a failure is not.
    if (req.routeOptions?.url === "/api/v1/assets/:id/stream" && req.body?.sourceId && !profile.isAdmin) { reply.code(403).send({ error: "Only an admin can switch sources.", code: "admin_only" }); return; }
    // Everything after this (the handler and whatever it awaits) runs as the profile.
    profileContext.run(profile, done);
  });

  app.get("/api/v1/ratings", async () => RATINGS.map(({ key, label, description }) => ({ key, label, description })));

  app.get("/api/v1/profiles", async req => {
    const users = allRows();
    return { profiles: users.map(req.profile?.isAdmin ? fullProfile : publicProfile), current: req.profile?.id || null };
  });

  // Who this browser is, and what it may do. 401 means show the picker.
  app.get("/api/v1/session", async (req, reply) => {
    if (!req.profile) return reply.code(401).send({ error: "Choose a profile first.", code: "profile_required" });
    const user = row(req.profile.id);
    return { profile: fullProfile(user), profileCount: db.prepare("SELECT count(*) count FROM users").get().count };
  });

  const attempts = new Map();
  app.post("/api/v1/profiles/:id/select", async (req, reply) => {
    const user = row(req.params.id);
    if (!user) return reply.code(404).send({ error: "Profile not found" });
    if (user.pin_hash) {
      const state = attempts.get(user.id) || { count: 0, until: 0 };
      if (state.until > Date.now()) return reply.code(429).send({ error: `Too many tries. Try again in ${Math.ceil((state.until - Date.now()) / 60_000)} min.`, code: "pin_locked" });
      const pin = req.body?.pin;
      if (typeof pin !== "string" || !PIN.test(pin) || !pinMatches(pin, user.pin_hash)) {
        state.count += 1;
        if (state.count >= MAX_ATTEMPTS) Object.assign(state, { count: 0, until: Date.now() + LOCKOUT_MS });
        attempts.set(user.id, state);
        return reply.code(403).send({ error: pin === undefined ? "Enter the PIN for this profile." : "That PIN isn't right.", code: "pin_required" });
      }
      attempts.delete(user.id);
    }
    setCookie(reply, user);
    return { profile: fullProfile(user) };
  });

  app.post("/api/v1/session/sign-out", async (req, reply) => { clearCookie(reply); return { ok: true }; });

  // ------------------------------------------------------------------------------------------------
  // Managing profiles (admins), and a profile's own PIN

  const ProfileError = (code, error) => ({ code, error });
  const validName = value => typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 40;
  const adminsWithoutPin = () => db.prepare("SELECT count(*) count FROM users WHERE role='admin' AND pin_hash IS NULL").get().count;

  // Shared by create and update. Returns column values, or { error }.
  function readFields(body, { creating }) {
    const fields = {};
    if (creating || body.name !== undefined) { if (!validName(body.name)) return ProfileError(400, "A name of 1–40 characters is required"); fields.display_name = body.name.trim(); }
    if (body.avatar !== undefined) { if (body.avatar !== null && (typeof body.avatar !== "string" || body.avatar.length > 8)) return ProfileError(400, "avatar must be a short emoji or null"); fields.avatar = body.avatar; }
    if (body.color !== undefined) { if (!COLORS.includes(body.color)) return ProfileError(400, "Pick one of the offered colors"); fields.color = body.color; }
    if (body.role !== undefined) { if (!["admin", "member"].includes(body.role)) return ProfileError(400, "role must be admin or member"); fields.role = body.role; }
    if (body.maxRating !== undefined) { const level = ratingLevel(body.maxRating); if (!level) return ProfileError(400, "maxRating must be one of the rating levels"); fields.max_rating = level; }
    if (body.allowUnrated !== undefined) { if (typeof body.allowUnrated !== "boolean") return ProfileError(400, "allowUnrated must be true or false"); fields.allow_unrated = Number(body.allowUnrated); }
    // Admins see everything; limits only apply to members.
    if (fields.role === "admin") Object.assign(fields, { max_rating: MAX_LEVEL, allow_unrated: 1 });
    return { fields };
  }

  app.post("/api/v1/profiles", async (req, reply) => {
    const count = db.prepare("SELECT count(*) count FROM users").get().count;
    if (count >= MAX_PROFILES) return reply.code(409).send({ error: `Kiwi supports up to ${MAX_PROFILES} profiles.` });
    // Once there is more than one profile, an admin without a PIN could be chosen by anyone.
    if (adminsWithoutPin()) return reply.code(409).send({ error: "Set a PIN on every admin profile before adding profiles.", code: "admin_pin_required" });
    const { fields, code, error } = readFields(req.body || {}, { creating: true });
    if (error) return reply.code(code).send({ error });
    if (fields.role === "admin" && !(typeof req.body.pin === "string" && PIN.test(req.body.pin))) return reply.code(400).send({ error: "A new admin profile needs a 4-digit PIN." });
    if (req.body.pin !== undefined && req.body.pin !== null && !(typeof req.body.pin === "string" && PIN.test(req.body.pin))) return reply.code(400).send({ error: "A PIN is 4 digits." });
    // New members start at Teens with unrated content hidden; the admin can change it right away.
    const max = fields.max_rating ?? 3;
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id,display_name,created_at,avatar,color,role,max_rating,allow_unrated,pin_hash,position)
      VALUES (?,?,?,?,?,?,?,?,?,(SELECT coalesce(max(position),0)+1 FROM users))`).run(
      id, fields.display_name, now(), fields.avatar ?? null, fields.color ?? COLORS[count % COLORS.length], fields.role || "member",
      max, fields.allow_unrated ?? Number(max >= 4), req.body.pin ? hashPin(req.body.pin) : null);
    ensureWatchlist(id);
    return reply.code(201).send({ profile: fullProfile(row(id)) });
  });

  app.patch("/api/v1/profiles/:id", async (req, reply) => {
    const user = row(req.params.id);
    if (!user) return reply.code(404).send({ error: "Profile not found" });
    const { fields, code, error } = readFields(req.body || {}, { creating: false });
    if (error) return reply.code(code).send({ error });
    if (user.id === OWNER_ID && fields.role === "member") return reply.code(409).send({ error: "The owner profile is always an admin." });
    if (fields.role === "admin" && user.role !== "admin" && !user.pin_hash) return reply.code(409).send({ error: "Give this profile a PIN before making it an admin.", code: "admin_pin_required" });
    if (user.role === "admin" && fields.role !== "member") for (const key of ["max_rating", "allow_unrated"]) delete fields[key];
    if (!Object.keys(fields).length) return { profile: fullProfile(user) };
    const roleChanged = fields.role && fields.role !== user.role;
    const assignments = Object.keys(fields).map(key => `${key}=?`);
    if (roleChanged) assignments.push("session_version=session_version+1");
    db.prepare(`UPDATE users SET ${assignments.join(",")} WHERE id=?`).run(...Object.values(fields), user.id);
    const updated = row(user.id);
    // Changing your own role signs out other devices, but keeps this one signed in.
    if (roleChanged && req.profile.id === user.id) setCookie(reply, updated);
    return { profile: fullProfile(updated) };
  });

  // A profile may set or remove its own PIN; an admin may do it for anyone.
  app.put("/api/v1/profiles/:id/pin", async (req, reply) => {
    const user = row(req.params.id);
    if (!user) return reply.code(404).send({ error: "Profile not found" });
    if (req.profile.id !== user.id && !req.profile.isAdmin) return reply.code(403).send({ error: "Only an admin can change another profile's PIN.", code: "admin_only" });
    const pin = req.body?.pin;
    if (pin !== null && !(typeof pin === "string" && PIN.test(pin))) return reply.code(400).send({ error: "A PIN is 4 digits." });
    const profileCount = db.prepare("SELECT count(*) count FROM users").get().count;
    if (pin === null && user.role === "admin" && profileCount > 1) return reply.code(409).send({ error: "Admin profiles need a PIN while there is more than one profile.", code: "admin_pin_required" });
    db.prepare("UPDATE users SET pin_hash=?, session_version=session_version+1 WHERE id=?").run(pin === null ? null : hashPin(pin), user.id);
    const updated = row(user.id);
    if (req.profile.id === user.id) setCookie(reply, updated);
    return { profile: fullProfile(updated) };
  });

  // Removes the profile and everything that was only its own: history, likes, saved items, follows, settings.
  app.delete("/api/v1/profiles/:id", async (req, reply) => {
    const user = row(req.params.id);
    if (!user) return reply.code(404).send({ error: "Profile not found" });
    if (user.id === OWNER_ID) return reply.code(409).send({ error: "The owner profile can't be removed." });
    const listed = db.prepare("SELECT DISTINCT i.title_id FROM list_items i JOIN lists l ON l.id=i.list_id WHERE l.user_id=? AND i.title_id IS NOT NULL").all(user.id).map(entry => entry.title_id);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["consumption_state", "asset_views", "asset_likes", "topic_follows", "feed_follows", "user_settings", "lists", "profile_preferences"]) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
      // Feeds and collections stay with the household.
      db.prepare("UPDATE feeds SET owner_id=? WHERE owner_id=?").run(OWNER_ID, user.id);
      db.prepare("UPDATE collections SET owner_id=? WHERE owner_id=?").run(OWNER_ID, user.id);
      db.prepare("DELETE FROM users WHERE id=?").run(user.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    // Titles only this profile had listed leave the household library.
    for (const titleId of listed) syncHouseholdLibrary(titleId, { images: getMedia().images });
    if (req.profile.id === user.id) clearCookie(reply);
    return { ok: true };
  });
}

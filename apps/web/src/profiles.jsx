"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Backspace, Check, Gear, LockSimple, LockSimpleOpen, PencilSimple, Plus, ShieldCheck, SpinnerGap, Trash, UsersThree, X } from "@phosphor-icons/react";
import { PLAYLIST_KEY } from "./playlist-state.mjs";
import { locateSetting } from "./settings-nav.jsx";

// Profiles: who is watching. The server decides what each profile may see; the browser only picks one.
// Any API call answering 401 "profile_required" (see client-app's api helper) brings the picker back.

export const PROFILE_REQUIRED_EVENT = "kiwi:profile-required";
export const COLORS = ["#2f9e6b", "#3d7be0", "#d9534f", "#e8a33d", "#8e5bd8", "#2bb3c0", "#d0569b", "#6b7a8f"];
const AVATARS = ["🦊", "🐼", "🐯", "🐸", "🐙", "🦄", "🐧", "🐻", "🦁", "🐨", "🚀", "⭐"];

const request = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || `Request failed (${response.status})`); error.code = body.code; error.status = response.status; throw error; }
  return body;
};

// Switching profiles starts the app fresh, so nothing from the last profile (queue, player) carries over.
const restart = () => {
  try { localStorage.removeItem(PLAYLIST_KEY); } catch { /* Storage may be unavailable. */ }
  window.location.assign("/");
};

const SessionContext = createContext({ profile: null, isAdmin: false, profileCount: 1, refresh: () => {} });
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: "loading" });
  const load = () => request("/api/v1/session")
    .then(value => setState({ status: "ready", profile: value.profile, profileCount: value.profileCount }))
    .catch(error => setState(error.status === 401 ? { status: "picking" } : { status: "error", message: error.message }));
  useEffect(() => {
    load();
    const pick = () => setState({ status: "picking" });
    window.addEventListener(PROFILE_REQUIRED_EVENT, pick);
    return () => window.removeEventListener(PROFILE_REQUIRED_EVENT, pick);
  }, []);
  if (state.status === "loading") return <div className="profile-gate"><SpinnerGap className="spin" size={28} /></div>;
  if (state.status === "error") return <div className="profile-gate"><p>Kiwi isn't reachable right now: {state.message}</p><button className="outline-button" onClick={load}>Try again</button></div>;
  if (state.status === "picking") return <ProfilePicker />;
  const value = { profile: state.profile, isAdmin: state.profile.isAdmin, profileCount: state.profileCount, refresh: load };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function ProfileAvatar({ profile, size = 40 }) {
  const label = profile.avatar || (profile.name || "?").trim().charAt(0).toUpperCase();
  return <span className={`profile-avatar-badge ${profile.avatar ? "is-emoji" : ""}`} style={{ "--avatar-size": `${size}px`, background: profile.color || COLORS[0] }} aria-hidden="true">{label}</span>;
}

// "Who's watching?"
export function ProfilePicker() {
  const [profiles, setProfiles] = useState(null), [choosing, setChoosing] = useState(null), [error, setError] = useState("");
  useEffect(() => { request("/api/v1/profiles").then(value => setProfiles(value.profiles)).catch(e => setError(e.message)); }, []);
  const choose = async (profile, pin) => {
    setError("");
    try { await request(`/api/v1/profiles/${profile.id}/select`, { method: "POST", body: JSON.stringify(pin ? { pin } : {}) }); restart(); }
    catch (e) { if (!profile.locked) setError(e.message); throw e; }
  };
  return <div className="profile-gate profile-picker">
    <h1>Who's watching?</h1>
    {!profiles ? <SpinnerGap className="spin" size={28} /> : <ul className="profile-tiles">
      {profiles.map(profile => <li key={profile.id}><button onClick={() => profile.locked ? setChoosing(profile) : choose(profile).catch(() => {})} aria-label={`${profile.name}${profile.locked ? " (locked)" : ""}`}>
        <ProfileAvatar profile={profile} size={112} />
        <span className="profile-tile-name">{profile.name}{profile.locked && <LockSimple size={14} weight="fill" />}</span>
      </button></li>)}
    </ul>}
    {error && <p className="profile-error" role="alert">{error}</p>}
    {choosing && <PinDialog title={`Enter ${choosing.name}'s PIN`} profile={choosing} close={() => setChoosing(null)} submit={pin => choose(choosing, pin)} />}
  </div>;
}

// Four digits, typed or tapped; submits on the fourth.
export function PinPad({ submit, autoFocus = true }) {
  const [digits, setDigits] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, []);
  const update = async next => {
    const clean = next.replace(/\D/g, "").slice(0, 4);
    setDigits(clean); setError("");
    if (clean.length !== 4) return;
    setBusy(true);
    try { await submit(clean); }
    catch (e) { setError(e.message); setDigits(""); }
    finally { setBusy(false); input.current?.focus(); }
  };
  return <div className="pin-pad">
    <label className="pin-dots" onClick={() => input.current?.focus()}>
      <input ref={input} value={digits} onChange={event => update(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={4} disabled={busy} aria-label="PIN" className="pin-input" />
      {[0, 1, 2, 3].map(index => <span key={index} className={index < digits.length ? "is-filled" : ""} />)}
    </label>
    <p className="pin-error" role="alert">{error}</p>
    <div className="pin-keys">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(key => <button key={key} type="button" disabled={busy} onClick={() => update(digits + key)}>{key}</button>)}
      <span />
      <button type="button" disabled={busy} onClick={() => update(digits + "0")}>0</button>
      <button type="button" disabled={busy || !digits} onClick={() => update(digits.slice(0, -1))} aria-label="Delete digit"><Backspace size={20} /></button>
    </div>
  </div>;
}

function PinDialog({ title, profile, close, submit }) {
  useEffect(() => {
    const onKey = event => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <div className="dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div className="dialog pin-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog-head">{profile && <ProfileAvatar profile={profile} size={36} />}<h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close"><X /></button></div>
      <PinPad submit={submit} />
    </div>
  </div>;
}

// The avatar in the header: switch profile, lock your own profile, and (admins) manage profiles.
export function ProfileMenu({ navigate }) {
  const { profile, isAdmin, profileCount, refresh } = useSession();
  const [open, setOpen] = useState(false), [pinMode, setPinMode] = useState(null), [message, setMessage] = useState("");
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = event => { if (!menu.current?.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", onKey); };
  }, [open]);
  if (!profile) return null;
  const switchProfile = async () => { await request("/api/v1/session/sign-out", { method: "POST" }).catch(() => {}); restart(); };
  const setPin = async pin => { await request(`/api/v1/profiles/${profile.id}/pin`, { method: "PUT", body: JSON.stringify({ pin }) }); setPinMode(null); setMessage(pin ? "PIN saved" : "PIN removed"); refresh(); };
  const removePin = async () => { setOpen(false); try { await setPin(null); } catch (e) { setMessage(e.message); } };
  return <div className="profile-menu" ref={menu}>
    <button type="button" className="profile-menu-button" onClick={() => setOpen(value => !value)} aria-haspopup="menu" aria-expanded={open} aria-label={`Profile: ${profile.name}`}><ProfileAvatar profile={profile} size={30} /></button>
    {open && <div className="profile-menu-panel" role="menu">
      <div className="profile-menu-head"><ProfileAvatar profile={profile} size={36} /><div><strong>{profile.name}</strong><small>{isAdmin ? "Admin" : profile.locked ? "Locked with a PIN" : "Profile"}</small></div></div>
      {profileCount > 1 && <button role="menuitem" onClick={switchProfile}><UsersThree size={18} /> Switch profile</button>}
      <button role="menuitem" onClick={() => { setOpen(false); setPinMode("set"); }}>{profile.locked ? <LockSimple size={18} /> : <LockSimpleOpen size={18} />} {profile.locked ? "Change PIN" : "Lock with a PIN"}</button>
      {profile.locked && !(isAdmin && profileCount > 1) && <button role="menuitem" onClick={removePin}><LockSimpleOpen size={18} /> Remove PIN</button>}
      {isAdmin && <button role="menuitem" onClick={() => { setOpen(false); navigate("/settings#profiles"); locateSetting("profiles"); }}><Gear size={18} /> {profileCount > 1 ? "Manage profiles" : "Add profiles"}</button>}
    </div>}
    {message && <div className="profile-toast" role="status" onAnimationEnd={() => setMessage("")}>{message}</div>}
    {pinMode && <PinDialog title={profile.locked ? "Choose a new PIN" : "Choose a 4-digit PIN"} profile={profile} close={() => setPinMode(null)} submit={setPin} />}
  </div>;
}

// --------------------------------------------------------------------------------------------------
// Ratings

let ratingsPromise;
export const loadRatings = () => (ratingsPromise ||= request("/api/v1/ratings").catch(error => { ratingsPromise = null; throw error; }));
export function useRatings() {
  const [ratings, setRatings] = useState([]);
  useEffect(() => { loadRatings().then(setRatings).catch(() => {}); }, []);
  return ratings;
}
export const ratingLabel = (ratings, key) => ratings.find(rating => rating.key === key)?.label || "Unrated";

// One control for every place a rating is set: folders, titles, and home videos. Admins only.
export function RatingSelect({ value, onChange, label = "Content rating", unratedLabel = "Unrated", disabled = false, id }) {
  const ratings = useRatings();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const change = async event => {
    setBusy(true); setError("");
    try { await onChange(event.target.value || null); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <label className="rating-select" htmlFor={id}>
    <span>{label}</span>
    <select id={id} value={value || ""} onChange={change} disabled={disabled || busy || !ratings.length}>
      <option value="">{unratedLabel}</option>
      {ratings.map(rating => <option key={rating.key} value={rating.key}>{rating.label}{rating.description ? ` — ${rating.description}` : ""}</option>)}
    </select>
    {error && <small role="alert">{error}</small>}
  </label>;
}

// --------------------------------------------------------------------------------------------------
// Settings → Profiles (admins)

export function ProfilesSettings({ api }) {
  const { profile: me, refresh } = useSession();
  const ratings = useRatings();
  const [profiles, setProfiles] = useState(null), [editing, setEditing] = useState(null), [pinFor, setPinFor] = useState(null), [message, setMessage] = useState("");
  const load = () => api("/api/v1/profiles").then(value => setProfiles(value.profiles)).catch(e => setMessage(e.message));
  useEffect(() => { load(); }, []);
  const act = async work => { setMessage(""); try { await work(); await load(); refresh(); } catch (e) { setMessage(e.message); } };
  const adminNeedsPin = profiles?.some(profile => profile.isAdmin && !profile.locked);
  const savePin = async pin => {
    await api(`/api/v1/profiles/${pinFor.id}/pin`, { method: "PUT", body: JSON.stringify({ pin }) });
    setPinFor(null); setMessage(`PIN ${pin ? "saved" : "removed"} for ${pinFor.name}`); await load(); refresh();
  };
  return <section className="settings-card profiles-settings" id="profiles">
    <div><h3>Profiles</h3><p>Everyone gets their own history, likes, and progress. Limit a profile to a content rating; admins see everything and manage settings.</p></div>
    {adminNeedsPin && <div className="notice">Set a PIN on every admin profile before adding profiles, so no one else can open them.</div>}
    <div className="profile-rows">
      {profiles === null ? <p>Loading profiles…</p> : profiles.map(profile => <div className="profile-row" key={profile.id}>
        <ProfileAvatar profile={profile} size={44} />
        <div className="profile-row-copy">
          <strong>{profile.name}{profile.id === me.id && <span className="profile-chip">You</span>}</strong>
          <small>{profile.isAdmin ? <><ShieldCheck size={13} /> Admin · sees everything</> : <>Up to {ratingLabel(ratings, profile.maxRating)} · {profile.allowUnrated ? "unrated shown" : "unrated hidden"}</>} · {profile.locked ? "PIN set" : "no PIN"}</small>
        </div>
        <div className="profile-row-actions">
          <button className="outline-button" onClick={() => setEditing(profile)}><PencilSimple /> Edit</button>
          <button className="outline-button" onClick={() => setPinFor(profile)}>{profile.locked ? <LockSimple /> : <LockSimpleOpen />} {profile.locked ? "Change PIN" : "Set PIN"}</button>
          {profile.locked && !profile.isAdmin && <button className="outline-button" onClick={() => act(() => api(`/api/v1/profiles/${profile.id}/pin`, { method: "PUT", body: JSON.stringify({ pin: null }) }))}>Remove PIN</button>}
          {!profile.isOwner && <button className="outline-button danger" aria-label={`Delete ${profile.name}`} onClick={() => { if (confirm(`Delete ${profile.name}? Their history, likes, and progress are removed.`)) act(() => api(`/api/v1/profiles/${profile.id}`, { method: "DELETE" })); }}><Trash /></button>}
        </div>
      </div>)}
    </div>
    <button className="primary-button" disabled={!profiles || adminNeedsPin} onClick={() => setEditing({})}><Plus /> Add profile</button>
    {message && <div className="notice" role="status">{message}</div>}
    {editing && <ProfileEditor api={api} profile={editing} ratings={ratings} close={() => setEditing(null)} saved={async () => { setEditing(null); await load(); refresh(); }} />}
    {pinFor && <PinDialog title={`${pinFor.locked ? "New" : "Set a"} PIN for ${pinFor.name}`} profile={pinFor} close={() => setPinFor(null)} submit={savePin} />}
  </section>;
}

function ProfileEditor({ api, profile, ratings, close, saved }) {
  const creating = !profile.id;
  const [form, setForm] = useState({
    name: profile.name || "", avatar: profile.avatar ?? null, color: profile.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    role: profile.isAdmin ? "admin" : "member", maxRating: profile.maxRating || "teens", allowUnrated: profile.allowUnrated ?? false, pin: "",
  });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const set = patch => setForm(current => ({ ...current, ...patch }));
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError("");
    const body = { name: form.name, avatar: form.avatar, color: form.color, role: form.role, ...(form.role === "member" ? { maxRating: form.maxRating, allowUnrated: form.allowUnrated } : {}) };
    try {
      if (creating) await api("/api/v1/profiles", { method: "POST", body: JSON.stringify({ ...body, ...(form.pin ? { pin: form.pin } : {}) }) });
      else await api(`/api/v1/profiles/${profile.id}`, { method: "PATCH", body: JSON.stringify(profile.isOwner ? { name: body.name, avatar: body.avatar, color: body.color } : body) });
      await saved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const preview = { name: form.name || "?", avatar: form.avatar, color: form.color };
  return <div className="dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div className="dialog profile-editor" role="dialog" aria-modal="true" aria-label={creating ? "Add profile" : `Edit ${profile.name}`}>
      <div className="dialog-head"><h2>{creating ? "Add profile" : `Edit ${profile.name}`}</h2><button className="icon-button" onClick={close} aria-label="Close"><X /></button></div>
      <form onSubmit={submit}>
        <div className="profile-editor-preview"><ProfileAvatar profile={preview} size={72} /></div>
        <label>Name<input autoFocus value={form.name} maxLength={40} onChange={event => set({ name: event.target.value })} required /></label>
        <fieldset className="profile-swatches"><legend>Picture</legend>
          <button type="button" className={!form.avatar ? "selected" : ""} onClick={() => set({ avatar: null })} aria-label="Use initial">{(form.name || "?").charAt(0).toUpperCase()}</button>
          {AVATARS.map(avatar => <button type="button" key={avatar} className={form.avatar === avatar ? "selected" : ""} onClick={() => set({ avatar })} aria-label={`Use ${avatar}`}>{avatar}</button>)}
        </fieldset>
        <fieldset className="profile-swatches"><legend>Color</legend>
          {COLORS.map(color => <button type="button" key={color} className={`swatch ${form.color === color ? "selected" : ""}`} style={{ background: color }} onClick={() => set({ color })} aria-label={`Color ${color}`}>{form.color === color && <Check size={16} weight="bold" />}</button>)}
        </fieldset>
        {!profile.isOwner && <fieldset className="profile-role"><legend>Access</legend>
          <label className="radio"><input type="radio" name="role" checked={form.role === "member"} onChange={() => set({ role: "member" })} /> <span><strong>Member</strong><small>Sees content up to a rating. Can't change settings or download.</small></span></label>
          <label className="radio"><input type="radio" name="role" checked={form.role === "admin"} onChange={() => set({ role: "admin" })} /> <span><strong>Admin</strong><small>Sees everything, manages profiles, ratings, and settings. Needs a PIN.</small></span></label>
        </fieldset>}
        {form.role === "member" && !profile.isOwner && <>
          <label>Allowed up to<select value={form.maxRating} onChange={event => set({ maxRating: event.target.value })}>{ratings.map(rating => <option key={rating.key} value={rating.key}>{rating.label} — {rating.description}</option>)}</select></label>
          <label className="checkbox"><input type="checkbox" checked={form.allowUnrated} onChange={event => set({ allowUnrated: event.target.checked })} /> Show unrated content <small>Home videos and titles without a rating</small></label>
        </>}
        {creating && <label>PIN {form.role === "admin" ? "(required)" : "(optional)"}<input value={form.pin} onChange={event => set({ pin: event.target.value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" placeholder="4 digits" required={form.role === "admin"} pattern="\d{4}" /></label>}
        {error && <p className="profile-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy || !form.name.trim()}>{creating ? <><Plus /> Add profile</> : <><Check /> Save</>}</button>
      </form>
    </div>
  </div>;
}


"use client";

import { createContext, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { CaretDown, CaretUp, Check, ListPlus, Playlist, Play, X } from '@phosphor-icons/react';
import { emptyPlaylist, PLAYLIST_KEY, playlistReducer, restorePlaylist } from './playlist-state.mjs';

const Context = createContext(null);
export const usePlaylist = () => useContext(Context);
export function PlaylistProvider({ children }) {
  const [state, dispatch] = useReducer(playlistReducer, undefined, emptyPlaylist);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    try { dispatch({ type: 'restore', value: restorePlaylist(localStorage.getItem(PLAYLIST_KEY)) }); } catch { /* Storage may be unavailable. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      if (state.items.length) localStorage.setItem(PLAYLIST_KEY, JSON.stringify(state));
      else localStorage.removeItem(PLAYLIST_KEY);
    } catch { /* The in-memory queue remains usable. */ }
  }, [state, ready]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 2500); return () => clearTimeout(timer); } }, [notice]);
  return <Context.Provider value={{ ...state, ready, dispatch, add: asset => { dispatch({ type: 'add', asset }); setNotice(`Added ${asset.title} to playlist`); } }}>
    {children}<div className="playlist-notice" role="status">{notice}</div>
  </Context.Provider>;
}

export function AddToPlaylist({ asset }) {
  const playlist = usePlaylist();
  if (asset.kind !== 'video') return null;
  const added = playlist.items.some(item => item.id === asset.id);
  return <button type="button" className="add-to-playlist" aria-label={added ? `${asset.title} is in playlist` : `Add ${asset.title} to playlist`} title={added ? 'In playlist' : 'Add to Playlist'} aria-disabled={added} onClick={event => {
    event.preventDefault(); event.stopPropagation(); if (!added) playlist.add(asset);
  }}>{added ? <Check size={16} /> : <ListPlus size={16} />}</button>;
}

export function PlaylistQueue({ navigate, mini = false }) {
  const { items, activeId, dispatch } = usePlaylist();
  const [open, setOpen] = useState(!mini);
  const listRef = useRef(null);
  const activeItemRef = useRef(null);
  useEffect(() => {
    const list = listRef.current;
    const activeItem = activeItemRef.current;
    if (!open || !list || !activeItem) return;
    const viewport = list.getBoundingClientRect();
    const row = activeItem.getBoundingClientRect();
    // Scroll only the queue, keeping the page and player in place.
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }, [activeId, open, mini, items.length]);
  if (!items.length) return null;
  return <section className="playlist-queue" aria-label="Playlist">
    <button className="playlist-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}><Playlist size={20} /><strong>Playlist</strong><span>{items.length} {items.length === 1 ? 'video' : 'videos'}</span><span className="playlist-chevron" aria-hidden="true">{open ? <CaretUp size={16} /> : <CaretDown size={16} />}</span></button>
    {open && <ol ref={listRef}>{items.map(asset => <li key={asset.id} ref={asset.id === activeId ? activeItemRef : null} className={asset.id === activeId ? 'is-playing' : ''}>
      <button className="playlist-item" onClick={() => { dispatch({ type: 'play', asset }); if (!mini) navigate(`/watch/${asset.id}`); }} aria-label={`Play ${asset.title}`}>
        {asset.thumbnail_url ? <img src={asset.thumbnail_url} alt="" /> : <Play size={24} />}<span><strong>{asset.title}</strong>{asset.id === activeId && <small>Now playing</small>}</span>
      </button><button className="icon-button" aria-label={`Remove ${asset.title} from playlist`} onClick={() => {
        const next = playlistReducer({ items, activeId }, { type: 'remove', id: asset.id });
        dispatch({ type: 'remove', id: asset.id });
        if (asset.id === activeId && !mini) navigate(next.activeId ? `/watch/${next.activeId}` : '/');
      }}><X size={16} /></button>
    </li>)}</ol>}
  </section>;
}

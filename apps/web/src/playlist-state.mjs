export const PLAYLIST_KEY = 'kiwi.playlist.v1';
export const emptyPlaylist = () => ({ items: [], activeId: null });
const item = asset => ({ id: asset.id, title: asset.title, kind: 'video', thumbnail_url: asset.thumbnail_url || null });
export function restorePlaylist(raw) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value?.items)) return emptyPlaylist();
    const items = value.items.filter((a, index, all) => typeof a?.id === 'string' && typeof a.title === 'string' && a.kind === 'video' && all.findIndex(b => b?.id === a.id) === index).map(item);
    return { items, activeId: items.some(a => a.id === value.activeId) ? value.activeId : items[0]?.id || null };
  } catch { return emptyPlaylist(); }
}
export function playlistReducer(state, action) {
  if (action.type === 'restore') return action.value;
  if (action.type === 'clear') return emptyPlaylist();
  if (action.type === 'add' || action.type === 'play') {
    if (action.asset.kind !== 'video') return state;
    const items = state.items.some(a => a.id === action.asset.id) ? state.items : [...state.items, item(action.asset)];
    return { items, activeId: action.type === 'play' ? action.asset.id : state.activeId || items[0].id };
  }
  if (action.type === 'remove') {
    const index = state.items.findIndex(a => a.id === action.id);
    const items = state.items.filter(a => a.id !== action.id);
    return { items, activeId: state.activeId === action.id ? (items[index] || items[0])?.id || null : state.activeId };
  }
  return state;
}

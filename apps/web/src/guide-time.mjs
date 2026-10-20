export const SLOT_MS = 30 * 60_000;
export const halfHour = time => Math.floor(time / SLOT_MS) * SLOT_MS;
export const slots = (start, end) => {
  const list = [];
  for (let time = start; time < end; time += SLOT_MS) list.push(time);
  return list;
};
export const airing = (programs, time) => programs.find(program => program.start <= time && time < program.end) || null;
// Up/down in the guide keeps its place in time, like a remote: the program covering `time`, else the nearest after it.
export const programAt = (programs, time) => airing(programs, time) || programs.find(program => program.start >= time) || programs.at(-1) || null;
// Seconds into a program that is on now, or null when it is not airing.
export const liveOffset = (program, now) => program.start <= now && now < program.end ? Math.floor((now - program.start) / 1000) : null;
// Where a program sits inside the guide window, in minutes, clipped to the window's edges.
export const placement = (program, start, end) => {
  const from = Math.max(program.start, start), to = Math.min(program.end, end);
  return { x: (from - start) / 60_000, width: Math.max(0, (to - from) / 60_000), continued: program.start < start };
};
export const clock = time => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const dayLabel = (time, now = Date.now()) => {
  const midnight = value => new Date(value).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(time) - midnight(now)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return new Date(time).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};
export const span = ms => {
  const minutes = Math.max(1, Math.round(ms / 60_000)), hours = Math.floor(minutes / 60);
  return hours ? `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
};

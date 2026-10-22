// Minimal WebVTT handling for the player's own subtitle layer. Rendering cues ourselves (instead of a
// <track> element) keeps timing correct when playback is repackaged from an offset, and lets the
// user pick size, background, and delay.

const STAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;
const toSeconds = text => {
  const match = STAMP.exec(text);
  if (!match) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || "0").padEnd(3, "0")) / 1000;
};

export function parseVtt(source) {
  const blocks = String(source).replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex(line => line.includes("-->"));
    if (at === -1 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const [from, rest] = lines[at].split("-->");
    const start = toSeconds(from), end = toSeconds((rest || "").trim().split(/\s+/)[0]);
    const text = lines.slice(at + 1).join("\n").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Cues that are showing at `time`. Cues may overlap, so look back past the first later cue.
export function activeCues(cues, time) {
  let low = 0, high = cues.length;
  while (low < high) { const middle = (low + high) >> 1; if (cues[middle].start <= time) low = middle + 1; else high = middle; }
  const active = [];
  for (let index = low - 1; index >= 0 && index > low - 8; index--) if (cues[index].end > time) active.unshift(cues[index]);
  return active;
}

const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };

// Cue text → lines of styled runs, without trusting any markup: only italic, bold, and underline survive.
export function cueLines(text) {
  const cleaned = String(text).replace(/\{\\[^}]*\}/g, "").replace(/\\N/g, "\n").replace(/\\n/g, "\n");
  const lines = [[]];
  const style = { italic: 0, bold: 0, underline: 0 };
  for (const part of cleaned.split(/(<\/?[a-zA-Z][^>]*>|<\d[\d:.]*>|\n)/)) {
    if (!part) continue;
    if (part === "\n") { lines.push([]); continue; }
    const tag = /^<(\/?)([a-zA-Z]+)[^>]*>$/.exec(part);
    if (tag) {
      const key = { i: "italic", b: "bold", u: "underline" }[tag[2].toLowerCase()];
      if (key) style[key] = Math.max(0, style[key] + (tag[1] ? -1 : 1));
      continue;
    }
    if (/^<\d/.test(part)) continue;
    const value = part.replace(/&(?:amp|lt|gt|quot|#39|nbsp|lrm|rlm);/g, entity => entities[entity]);
    if (value) lines.at(-1).push({ text: value, italic: style.italic > 0, bold: style.bold > 0, underline: style.underline > 0 });
  }
  return lines.filter(line => line.length);
}

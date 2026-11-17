// Small shared helpers: deterministic random numbers and formatting.
//
// Reproducibility policy: all randomness flows through `rand(stream)`, where a
// stream is a plain object {s: int}. The game state owns one stream (state.rng)
// that advances as the player acts; world generation uses separate streams
// derived by hashing the world seed with a place, so the world is a pure
// function of the seed and never depends on what the player did first.

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const lerp = (a, b, t) => a + (b - a) * t;

// FNV-1a string hash -> unsigned 32-bit int.
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const stream = (str) => ({ s: hash32(str) | 0 });

// mulberry32: one step, mutates the stream, returns uniform [0, 1).
export function rand(st) {
  st.s = (st.s + 0x6d2b79f5) | 0;
  let t = st.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Standard normal via Box-Muller.
export function randn(st) {
  const u = Math.max(rand(st), 1e-12);
  const v = rand(st);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const pick = (st, arr) => arr[Math.floor(rand(st) * arr.length)];

// Number formatting for amounts: 3 -> "3", 0.25 -> "0.25", 12.345 -> "12.3".
export function fmt(x) {
  if (!isFinite(x)) return '∞';
  const a = Math.abs(x);
  if (a >= 100) return String(Math.round(x));
  if (a >= 10) return String(Math.round(x * 10) / 10);
  return String(Math.round(x * 100) / 100);
}

export function fmtTime(min) {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

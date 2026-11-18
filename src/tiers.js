// Quality tiers: the thresholds the game actually tests, per kind and quality.
//
// A cobble's hardness matters only where some recipe checks it: knapping
// needs a hammer of 35, which for a cobble means hardness 39 or more. The
// tiers of a quality are the intervals between such thresholds. Two pieces
// in the same tier can do exactly the same things, and their average is
// still in that tier (an interval is closed under averaging), so stacks may
// merge within a tier without ever making anything worse for any recipe.
//
// Thresholds come from the library itself, with no annotation:
//   * input and slot minimums (a spear shaft needs straightness 45);
//   * tool minimums, turned into a quality by bisecting the kind's own
//     capability formula (hammer 35 = 0.9 x hardness -> hardness 38.9),
//     other qualities held at their defaults.
//
// Pieces also vary within one deposit. PIECE_SPREAD is the guess that they
// scatter around the deposit's mean by 70% of the scatter between deposits.

import { KINDS } from './data/items.js';
import { RECIPES, CAP_NAMES } from './data/recipes.js';
import { RESOURCES } from './data/resources.js';
import { stream, randn } from './util.js';

export const PIECE_SPREAD = 0.7;

let T = null; // kind -> { quality: [{v, label, cap, min}] sorted by v }, plus .caps: [cap] that depend on qualities
const specKinds = (spec) => (spec.kind ? [spec.kind] : Object.keys(KINDS).filter((k) => KINDS[k].tags.includes(spec.tag)));

function build() {
  T = {};
  const add = (kind, q, v, label, cap, min) => {
    const t = (T[kind] = T[kind] || { q: {}, caps: [] });
    const list = (t.q[q] = t.q[q] || []);
    if (!list.some((x) => Math.abs(x.v - v) < 1e-6)) list.push({ v, label, cap, min });
  };
  const inputs = [];
  for (const r of Object.values(RECIPES)) for (const spec of r.in) inputs.push(spec);
  for (const k of Object.values(KINDS)) for (const sl in k.slots || {}) inputs.push(k.slots[sl]);
  for (const spec of inputs) for (const q in spec.q || {}) for (const kind of specKinds(spec)) if (q in KINDS[kind].q) add(kind, q, spec.q[q], `${q} ${spec.q[q]}+`);
  // upper limits are lines too ("can still be resharpened"), but say nothing
  for (const spec of inputs) for (const q in spec.qmax || {}) for (const kind of specKinds(spec)) if (q in KINDS[kind].q) add(kind, q, spec.qmax[q], '');
  // food below 25 freshness is risky to eat (actions.js, doEat)
  for (const id in KINDS) if (KINDS[id].q.fresh != null) add(id, 'fresh', 25, '');

  const mins = {};
  const need = (cap, min) => (mins[cap] = mins[cap] || new Set()).add(min);
  for (const r of Object.values(RECIPES)) for (const t of r.tools) need(t.cap, t.min);
  for (const res of Object.values(RESOURCES)) if (res.gather && res.gather.tool) need(res.gather.tool.cap, res.gather.tool.min);
  for (const id in KINDS) {
    const k = KINDS[id];
    if (k.slots || !k.caps) continue;
    for (const cap in k.caps) {
      if (!mins[cap]) continue;
      for (const q in k.q) {
        const f = (v) => k.caps[cap]({ kind: id, n: 1, q: Object.assign({}, k.q, { [q]: v }) });
        if (Math.abs(f(100) - f(0)) < 1e-6) continue;
        for (const min of mins[cap]) {
          if (!(f(100) >= min && f(0) < min)) continue;
          let lo = 0, hi = 100;
          for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (f(mid) >= min) hi = mid; else lo = mid; }
          add(id, q, Math.round(hi * 10) / 10, `${CAP_NAMES[cap] || cap} ${min}+`, cap, min);
          if (!T[id].caps.includes(cap)) T[id].caps.push(cap);
        }
      }
    }
  }
  for (const id in T) for (const q in T[id].q) T[id].q[q].sort((a, b) => a.v - b.v);
}

export function tiersOf(kind) {
  if (!T) build();
  return T[kind] || null;
}

// Which tier an item is in, quality by quality ("2,0").
export const tierRank = (it) => tierKey(it).split(',').reduce((a, x) => a + Number(x || 0), 0);
export function tierKey(it) {
  const t = tiersOf(it.kind);
  if (!t) return '';
  return Object.keys(t.q).map((q) => t.q[q].filter((x) => (it.q[q] ?? 0) >= x.v - 1e-9).length).join(',');
}

// A few words for what a piece is good enough for: "hammer 35+".
// `capOf` is passed in to avoid a module cycle with items.js.
export function tierWords(it, capOf) {
  const t = tiersOf(it.kind);
  if (!t) return '';
  const out = [];
  for (const cap of t.caps) {
    const v = capOf(it, cap);
    let met = null;
    for (const q in t.q) for (const x of t.q[q]) if (x.cap === cap && v >= x.min - 1e-9 && (!met || x.min > met.min)) met = x;
    if (met) out.push(met.label);
  }
  if (!out.length) for (const q in t.q) { const met = t.q[q].filter((x) => !x.cap && x.label && (it.q[q] ?? 0) >= x.v - 1e-9).pop(); if (met) out.push(met.label); }
  return out.slice(0, 2).join(', ');
}

// Scatter of single pieces around a deposit's mean, for each quality the
// resource's deposits vary in.
export function pieceSpread(rid, env) {
  const out = {};
  const spec = RESOURCES[rid].q || {};
  for (const q in spec) {
    const ms = typeof spec[q] === 'function' ? spec[q](env || {}) : spec[q];
    out[q] = PIECE_SPREAD * ms[1];
  }
  return out;
}
// For an unknown deposit: the scatter of pieces and of deposits together.
export function searchSpread(rid) {
  const out = {};
  const spec = RESOURCES[rid].q || {};
  for (const q in spec) {
    if (typeof spec[q] === 'function') { out[q] = 12; continue; }
    out[q] = spec[q][1] * Math.sqrt(1 + PIECE_SPREAD * PIECE_SPREAD);
  }
  return out;
}

// Fixed standard-normal draws, so that the planner's odds are deterministic.
const Z = (() => { const st = stream('tiers|odds'); const out = []; for (let i = 0; i < 200; i++) out.push([randn(st), randn(st), randn(st), randn(st)]); return out; })();

// Fraction of pieces from a deposit with mean qualities `mean` and scatter
// `sd` that pass `test(piece)`.
export function passRate(kind, mean, sd, test) {
  const keys = Object.keys(sd);
  let pass = 0;
  for (const z of Z) {
    const q = Object.assign({}, KINDS[kind].q);
    for (const key in mean) if (key in q) q[key] = mean[key];
    keys.forEach((key, i) => { if (key in q) q[key] = Math.max(0, Math.min(100, q[key] + sd[key] * z[i % 4])); });
    if (test({ id: 0, kind, n: 1, q })) pass++;
  }
  return pass / Z.length;
}

// Typical best piece among n from a deposit: mean + scatter x the expected
// largest of n standard normal draws (Blom's approximation).
export function bestOf(n) {
  if (n <= 1) return 0;
  const p = (n - 0.375) / (n + 0.25);
  // inverse normal CDF, Acklam's rational approximation (enough for this)
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// How many separate pieces one collecting trip of n units holds: items
// counted one by one are pieces; loose material is taken in handfuls.
export const pieceSize = (kind) => { const k = KINDS[kind]; return k.unit === 'ea' ? 1 : Math.max(0.05, (k.lump ? 1 : k.hand) / 2); };
export function piecesIn(kind, n) {
  if (KINDS[kind].unit === 'ea') return Math.max(0, Math.floor(n));
  return Math.max(1, Math.min(12, Math.round(n / pieceSize(kind))));
}

// Item instances: creation, capabilities, containment, and the tree of
// "what is inside what".
//
// Position policy: every item sits in exactly one array. The arrays are
//   location.items   on the ground / built at a place
//   char.hands       held (two hands' worth, total)
//   char.worn        worn, one item per body slot
//   item.in          inside a container item
// and composite items own their components in item.parts[slot] (not an array:
// a part is not "inside" the tool, it IS part of the tool).
// Moving something means removing it from one array and adding it to another.

import { KINDS, UNIT } from './data/items.js';
import { clamp, fmt } from './util.js';
import { tiersOf, tierWords, tierKey } from './tiers.js';

export const kindOf = (it) => KINDS[it.kind];

// ---- pieces
// Countable things (cobbles, poles, flakes) keep every piece's own
// qualities in `it.ps`, an array of quality objects, one per piece; `it.q`
// is their mean, kept for display. A stack holds pieces of one tier only
// (see tiers.js), so the mean is on the same side of every tested line as
// each piece. Without `ps`, all n pieces are taken to be alike.
export const pieceKind = (kind) => { const k = KINDS[kind]; return k.unit === 'ea' && !k.food && !k.slots && !k.cont && !k.fixed && !k.lump && !k.trap && !k.worn && !k.liquid; };
export const piecesOf = (it) => it.ps || Array.from({ length: Math.max(0, Math.round(it.n)) }, () => Object.assign({}, it.q));
export function setPieces(it, ps) {
  it.ps = ps; it.n = ps.length;
  if (!ps.length) return it;
  const q = {};
  for (const key of new Set(ps.flatMap((p) => Object.keys(p)))) q[key] = Math.round((ps.reduce((a, p) => a + (p[key] ?? 0), 0) / ps.length) * 10) / 10;
  it.q = q;
  return it;
}
// How good a piece is, for choosing which to use first: the sum of the
// qualities some rule tests.
export function pieceScore(kind, q) {
  const t = tiersOf(kind);
  if (!t) return q.integrity ?? 0;
  return Object.keys(t.q).reduce((a, key) => a + (q[key] ?? 0), 0);
}
// New item ids for pieces split off inside addTo; act() points this at the game.
export const ids = { s: null };
const newId = () => (ids.s ? ids.s.nextId++ : 1e9 + Math.floor(Math.random() * 1e9));

export function mk(s, kind, n = 1, q = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error('unknown item kind: ' + kind);
  const it = { id: s.nextId++, kind, n, q: Object.assign({}, k.q, q) };
  for (const key in it.q) it.q[key] = Math.round(clamp(it.q[key], 0, key === 'fuel' || key === 'heat' || key === 'size' ? 1e6 : 100) * 10) / 10;
  return it;
}

// ---- description
export function missingSlots(it) {
  const k = kindOf(it);
  if (!k.slots) return [];
  return Object.keys(k.slots).filter((sl) => !k.slots[sl].opt && !(it.parts && it.parts[sl]));
}

export function itemName(it) {
  const k = kindOf(it);
  if (it.proj) return 'unfinished ' + it.proj.name;
  let name = k.name;
  const miss = missingSlots(it);
  if (miss.length) name += ' (missing ' + miss.join(', ') + ')';
  return name;
}

export function amountText(it) {
  const k = kindOf(it);
  if (k.fixed || (k.unit === 'ea' && it.n === 1)) return '';
  return k.unit === 'ea' ? `×${fmt(it.n)}` : fmt(it.n) + UNIT[k.unit];
}

export const label = (it) => { const a = amountText(it); return a ? `${itemName(it)} ${a}` : itemName(it); };

// ---- physical properties
export function massOf(it) {
  const k = kindOf(it);
  let m = it.n * k.mass;
  if (it.parts) for (const sl in it.parts) m += massOf(it.parts[sl]);
  if (it.in) for (const c of it.in) m += massOf(c);
  return m;
}

export function contSpec(it) {
  const c = kindOf(it).cont;
  if (!c) return null;
  const val = (v) => (typeof v === 'function' ? v(it) : v);
  return { vol: val(c.vol), mesh: c.mesh || 0, liquid: !!c.liquid, ret: c.liquid ? val(c.ret) : 0, fireproof: !!c.fireproof, cool: !!c.cool, drag: c.drag || 0 };
}

export const usedVol = (it) => (it.in || []).reduce((a, c) => a + c.n * kindOf(c).vol, 0);

// Why can't `cont` hold `n` units of `it`? Returns null if it can.
export function whyNotHold(cont, it, n = it.n) {
  const c = contSpec(cont);
  const k = kindOf(it);
  if (!c) return 'not a container';
  if (missingSlots(cont).length) return 'it is broken';
  if (cont === it) return 'cannot hold itself';
  if (k.fixed) return 'that is built in place';
  if (k.liquid && (!c.liquid || c.ret <= 0)) return `the ${kindOf(cont).name} does not hold liquid`;
  if (!k.liquid && k.grain < c.mesh) return `${k.name} would fall through the ${kindOf(cont).name}`;
  if (usedVol(cont) + n * k.vol > c.vol + 1e-9) return `not enough room in the ${kindOf(cont).name}`;
  return null;
}

// How many units of `it` fit in `cont` right now.
export function roomFor(cont, it) {
  if (whyNotHold(cont, it, 0)) return 0;
  return Math.max(0, (contSpec(cont).vol - usedVol(cont)) / kindOf(it).vol);
}

// ---- capabilities
// What level of capability `cap` does this item provide? 0 if none. An item
// with a missing required part, or one still being processed, does nothing.
export function capOf(it, cap) {
  const k = kindOf(it);
  if (it.proc || it.proj || missingSlots(it).length) return 0;
  if (k.caps && k.caps[cap]) {
    if (it.ps) return Math.max(0, ...it.ps.map((p) => k.caps[cap]({ kind: it.kind, n: 1, q: p })));
    return Math.max(0, k.caps[cap](it));
  }
  const c = k.cont && contSpec(it);
  if (c) {
    if (cap === 'vessel' && c.liquid) return (c.vol * c.ret) / 100;      // litres it can usefully hold
    if (cap === 'leach' && c.liquid && c.ret > 0) return (c.vol * c.ret) / 100;        // soak, pour off, repeat
    if (cap === 'leach' && !c.liquid && c.mesh === 0 && !k.open && !k.fixed) return c.vol; // a closed bag sunk in a stream
    if (cap === 'fireproof' && c.liquid && c.fireproof) return c.vol;                 // a pot that can sit on the fire
    if (cap === 'bag' && !c.liquid && c.mesh <= 1 && !k.fixed) return Math.min(c.vol, 30); // litres of loose small stuff you can carry while picking
  }
  return 0;
}

export function capsOf(it) {
  const out = {};
  const k = kindOf(it);
  for (const cap in k.caps || {}) { const v = capOf(it, cap); if (v >= 1) out[cap] = Math.round(v); }
  return out;
}

// ---- stacks
// Policy: like things merge unless some line that the game tests (see
// tiers.js) falls between them. Within a tier, averaging can never move a
// stack across such a line, so nothing that matters is lost; qualities no
// rule tests just average.
export function canMerge(a, b) {
  const k = kindOf(a);
  if (a.kind !== b.kind || a === b) return false;
  if (k.lump || k.slots || k.cont || k.fixed || a.proc || b.proc || a.parts || b.parts) return false;
  const tiers = tiersOf(a.kind);
  if (!tiers) return true;
  for (const key in tiers.q) {
    const x = a.q[key] ?? 0, y = b.q[key] ?? 0;
    if (tiers.q[key].some((c) => (x >= c.v - 1e-9) !== (y >= c.v - 1e-9))) return false;
  }
  return true;
}

// What a piece is good enough for, if some recipe draws a line: "hammer 35+".
export const tierLabel = (it) => tierWords(it, capOf);

// Add an item to an array, merging into a similar stack when one exists.
// Qualities of a merged stack are the amount-weighted mean, except that
// countable pieces keep their own qualities. Pieces of several tiers (the
// frame poles of a dismantled hut) are sorted into a stack per tier; the
// best tier's stack is returned.
export function addTo(list, it) {
  if (it.ps && it.ps.length > 1) {
    const groups = {};
    for (const p of it.ps) (groups[tierKey({ kind: it.kind, q: p })] = groups[tierKey({ kind: it.kind, q: p })] || []).push(p);
    const keys = Object.keys(groups);
    if (keys.length > 1) {
      const order = keys.sort((a, b) => pieceScore(it.kind, groups[b][0]) - pieceScore(it.kind, groups[a][0]));
      let first = null;
      order.forEach((key, i) => {
        const part = setPieces(i === 0 ? it : { id: newId(), kind: it.kind, n: 0, q: {} }, groups[key]);
        const placed = addTo(list, part);
        if (!first) first = placed;
      });
      return first;
    }
  }
  for (const o of list) {
    if (canMerge(o, it)) {
      if (pieceKind(o.kind) && (o.ps || it.ps)) setPieces(o, piecesOf(o).concat(piecesOf(it)));
      else {
        const tot = o.n + it.n;
        for (const key in o.q) o.q[key] = Math.round(((o.q[key] * o.n + (it.q[key] ?? 0) * it.n) / tot) * 10) / 10;
        o.n = tot;
      }
      list.splice(list.indexOf(o), 1); // a topped-up stack counts as the newest thing in the list
      list.push(o);
      return o;
    }
  }
  list.push(it);
  return it;
}

// Split n units off a stack as a new item (the caller must place it).
// Countable pieces leave best first ('best', for using as a tool) or worst
// first ('worst', using up the least good pieces that will do).
export function split(s, it, n, order = 'best') {
  if (pieceKind(it.kind) && it.n > 1) {
    const sign = order === 'worst' ? 1 : -1;
    const ps = piecesOf(it).sort((a, b) => sign * (pieceScore(it.kind, a) - pieceScore(it.kind, b)));
    const k = Math.round(n);
    const piece = setPieces({ id: s.nextId++, kind: it.kind, n: 0, q: {} }, ps.slice(0, k));
    setPieces(it, ps.slice(k));
    if (piece.n === 1) { piece.q = piece.ps[0]; delete piece.ps; }
    if (it.n === 1) { it.q = it.ps[0]; delete it.ps; }
    return piece;
  }
  const piece = { id: s.nextId++, kind: it.kind, n, q: Object.assign({}, it.q) };
  it.n = Math.round((it.n - n) * 1e6) / 1e6;
  return piece;
}

// The piece of a stack that gives the most of a capability (the one you
// would pick up to use), as an index into its pieces.
export function bestPieceFor(it, cap) {
  const k = kindOf(it);
  if (!it.ps || !k.caps || !k.caps[cap]) return -1;
  let top = -1, v = -1;
  it.ps.forEach((p, i) => { const c = k.caps[cap]({ kind: it.kind, n: 1, q: p }); if (c > v) { v = c; top = i; } });
  return top;
}

// ---- the tree
// Visit every item under a list, including contents and parts.
// fn(item, ctx) where ctx = {list, parent, slot, depth}.
export function walk(list, fn, parent = null, depth = 0) {
  for (const it of list.slice()) {
    fn(it, { list, parent, slot: null, depth });
    if (it.parts) for (const sl of Object.keys(it.parts)) {
      const p = it.parts[sl];
      fn(p, { list: null, parent: it, slot: sl, depth: depth + 1 });
    }
    if (it.in) walk(it.in, fn, it, depth + 1);
  }
}

export const here = (s) => s.locs[s.at];
export const roots = (s) => [s.c.hands, s.c.worn, here(s).items];

// Everything the character can use right now: carried things, things at this
// place, and anything inside those. Parts of composites are not separately
// reachable, and the contents of set traps are unknown until checked.
export function reach(s) {
  const out = [];
  const rec = (list, where) => {
    for (const it of list) {
      out.push({ it, list, where });
      if (it.in && !kindOf(it).trap) rec(it.in, where);
    }
  };
  rec(s.c.hands, 'hands'); rec(s.c.worn, 'worn'); rec(here(s).items, 'here');
  return out;
}

export function find(s, id) {
  for (const r of reach(s)) if (r.it.id === id) return r;
  const trash = trashHere(s);
  for (const it of trash) if (it.id === id) return { it, list: trash, where: 'trash' };
  return null;
}

// Things set aside at a place: out of the way of recipes and the stash list,
// but still there (and still rotting) until you move them back.
export function trashHere(s) {
  const L = s.locs[s.at];
  return L.trash || (L.trash = []);
}

export function removeFrom(list, it) {
  const i = list.indexOf(it);
  if (i >= 0) list.splice(i, 1);
}

// Best provider of a capability within reach.
export function best(s, cap) {
  let top = null, level = 0;
  for (const { it } of reach(s)) {
    const v = capOf(it, cap);
    if (v > level) { level = v; top = it; }
  }
  return { it: top, level };
}

// ---- carrying
export function handsFor(it) {
  const k = kindOf(it);
  if (k.hands === 2) return 2;
  return Math.max(1, Math.ceil(it.n / k.hand - 1e-9));
}
export const handsUsed = (s) => s.c.hands.reduce((a, it) => a + handsFor(it), 0);

// Mass the character feels: dragged loads count for a fraction.
export function carriedMass(s) {
  let m = 0;
  for (const it of s.c.hands.concat(s.c.worn)) {
    const c = contSpec(it);
    m += c && c.drag ? massOf(it) * c.drag : massOf(it);
  }
  return m;
}

export function wornIn(s, slot) {
  return s.c.worn.find((it) => kindOf(it).worn && kindOf(it).worn.slot === slot) || null;
}

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

export const kindOf = (it) => KINDS[it.kind];

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
  if (k.caps && k.caps[cap]) return Math.max(0, k.caps[cap](it));
  const c = k.cont && contSpec(it);
  if (c) {
    if (cap === 'vessel' && c.liquid) return (c.vol * c.ret) / 100;      // litres it can usefully hold
    if (cap === 'bag' && !c.liquid && c.mesh <= 1) return c.vol;        // litres of loose small stuff
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
const TOL = 12; // qualities closer than this merge into one stack

export function canMerge(a, b) {
  const k = kindOf(a);
  if (a.kind !== b.kind || a === b) return false;
  if (k.slots || k.cont || k.fixed || a.proc || b.proc || a.parts || b.parts) return false;
  for (const key in a.q) if (Math.abs(a.q[key] - (b.q[key] ?? 0)) > TOL) return false;
  return true;
}

// Add an item to an array, merging into a similar stack when one exists.
// Qualities of a merged stack are the amount-weighted mean.
export function addTo(list, it) {
  for (const o of list) {
    if (canMerge(o, it)) {
      const tot = o.n + it.n;
      for (const key in o.q) o.q[key] = Math.round(((o.q[key] * o.n + (it.q[key] ?? 0) * it.n) / tot) * 10) / 10;
      o.n = tot;
      return o;
    }
  }
  list.push(it);
  return it;
}

// Split n units off a stack as a new item (the caller must place it).
export function split(s, it, n) {
  const piece = { id: s.nextId++, kind: it.kind, n, q: Object.assign({}, it.q) };
  it.n = Math.round((it.n - n) * 1e6) / 1e6;
  return piece;
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
  return null;
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

// The planner: "how far am I from being able to do X, and by what route?"
//
// The game's requirements form an AND/OR graph. An action needs ALL of its
// requirements (tools, inputs, a resource at this place). Each requirement
// can be met by ANY of several providers: a kind of item, which in turn comes
// from gathering here, walking to a known place, searching for a new one, or
// another recipe. The planner picks the cheapest provider by estimated time,
// recursively, and returns the resulting list of steps.
//
// Two policies worth knowing:
//  * Time is summed, not maxed. One person works serially, so a job that
//    needs a blade AND cordage costs the time for both.
//  * It only uses what the character knows: resources already noticed, places
//    already found. Anything else is priced as a search, using the average
//    over the whole world of how long exploring takes to turn that thing up.
//    Actual searches scatter widely around that average.
//
// Everything here is an estimate for display. It never changes game state.

import { KINDS } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES } from './data/recipes.js';
import { capOf, reach, here } from './items.js';
import { capInfo, planInput, recipeStatus, gatherStatus, travelInfo } from './actions.js';
import { genLocation, prospect } from './world.js';
import { stream, rand, randn, clamp } from './util.js';

// ------------------------------------------------------------------ static tables (built once from the library)
const tagKinds = {};
export const kindsFor = (spec) => (spec.kind ? [spec.kind] : tagKinds[spec.tag] || (tagKinds[spec.tag] = Object.keys(KINDS).filter((k) => KINDS[k].tags.includes(spec.tag))));
export const unitsOf = (spec, kind) => (spec.kg != null ? spec.kg / KINDS[kind].mass : spec.n);

// A representative instance of a kind: default qualities, default parts.
const typicalCache = {};
export function typical(kind, depth = 0) {
  if (typicalCache[kind]) return typicalCache[kind];
  const k = KINDS[kind];
  const it = { id: 0, kind, n: 1, q: Object.assign({}, k.q) };
  if (k.slots && depth < 3) {
    it.parts = {};
    for (const sl in k.slots) {
      const spec = k.slots[sl];
      if (spec.opt) continue;
      const pk = kindsFor(spec)[0];
      const p = typical(pk, depth + 1);
      it.parts[sl] = { id: 0, kind: pk, n: unitsOf(spec, pk), q: Object.assign({}, p.q, spec.q || {}) };
    }
  }
  return (typicalCache[kind] = it);
}

let TABLES = null;
function tables() {
  if (TABLES) return TABLES;
  const producers = {}, gatherers = {}, capKinds = {}, procWait = {};
  // What does each recipe make? Rather than annotate every recipe by hand,
  // run its `make` against a recording stand-in and see what comes out.
  for (const rid in RECIPES) {
    const r = RECIPES[rid];
    const outs = {};
    const inKinds = new Set();
    let pFail = 0;
    for (const rv of [0.25, 0.6, 0.95]) {
      const ins = {};
      for (const spec of r.in) {
        if (spec.opt) continue;
        const kind = kindsFor(spec)[0];
        inKinds.add(kind);
        ins[spec.id] = { id: 0, kind, n: unitsOf(spec, kind), q: Object.assign({}, typical(kind).q, spec.q || {}), parts: typical(kind).parts };
      }
      const rec = (kind, n, wait) => { if (!outs[kind] || outs[kind].n < n) outs[kind] = { n, wait }; };
      const c = { ins, k: 1, wet: false, loc: { res: new Proxy({}, { get: () => ({ amt: 1e9 }) }) }, resCap: () => 1e9, r: () => rv, rn: () => 0, lvl: () => 60,
        say() {}, findKind: () => ({ q: { fuel: 0 } }), removeKind() {}, takeRes() {}, boil: () => 1,
        give: (kind, n, q, extra) => { const p = extra && extra.proc; if (p && !p.to) return; if (p) rec(p.to, p.n || n * (p.y || 1), p.left); else rec(kind, n, 0); },
        build: (kind) => rec(kind, 1, 0) };
      try { if (rv === 0.6 && r.fail) pFail = clamp(r.fail(c), 0, 0.95); r.make(c); } catch (e) { /* a recipe that only alters things makes nothing new */ }
    }
    for (const kind in outs) {
      if (inKinds.has(kind) || outs[kind].n <= 0) continue;
      (producers[kind] = producers[kind] || []).push({ rid, n: outs[kind].n * (1 - pFail), wait: outs[kind].wait });
      procWait[rid] = Math.max(procWait[rid] || 0, outs[kind].wait);
      const trap = KINDS[kind].trap; // a set trap "makes" its catch, eventually
      if (trap) for (const c of new Set(trap.catch)) (producers[c] = producers[c] || []).push({ rid, n: 1, wait: 60 / trap.rate, trap: true });
    }
  }
  for (const rid in RESOURCES) { const g = RESOURCES[rid].gather; if (g) (gatherers[g.kind] = gatherers[g.kind] || []).push(rid); }
  for (const kind in KINDS) {
    const k = KINDS[kind];
    if (kind === 'project') continue;
    for (const cap of Object.keys(k.caps || {}).concat(k.cont ? ['vessel', 'bag', 'leach', 'fireproof'] : [])) {
      const level = capOf(typical(kind), cap);
      if (level > 0) (capKinds[cap] = capKinds[cap] || []).push({ kind, level });
    }
  }
  const outputs = {};
  for (const kind in producers) for (const p of producers[kind]) if (!p.trap) (outputs[p.rid] = outputs[p.rid] || []).push(kind);
  return (TABLES = { producers, gatherers, capKinds, procWait, outputs });
}

// Kinds of thing a recipe makes, and the capability levels a typical one has.
export const outputsOf = (rid) => tables().outputs[rid] || [];
// What one batch of a recipe yields on average, kind by kind (traps excluded).
const yieldCache = {};
export function yieldsOf(rid) {
  if (yieldCache[rid]) return yieldCache[rid];
  const out = (yieldCache[rid] = []);
  for (const kind of outputsOf(rid)) for (const p of tables().producers[kind]) if (p.rid === rid && !p.trap) out.push({ kind, n: p.n, wait: p.wait });
  return out;
}
export function capsFromRecipe(rid) {
  const out = {};
  for (const kind of outputsOf(rid)) for (const cap in tables().capKinds) {
    const hit = tables().capKinds[cap].find((x) => x.kind === kind);
    if (hit) out[cap] = Math.max(out[cap] || 0, hit.level);
  }
  return out;
}

// ------------------------------------------------------------------ how long does exploring for X take, on average?
// Replays the game's own exploration procedure from 40 random origins that
// lack the resource, for each trip length, and counts successes. This is the
// character's "background knowledge": how common things are in this kind of
// country, not where any of them actually is.
const oddsCache = {};
export function exploreOdds(seed) {
  if (oddsCache[seed]) return oddsCache[seed];
  const st = stream('odds|' + seed);
  const HOURS = [1, 2, 4, 8];
  const hit = {}, tries = {};
  for (const rid in RESOURCES) { hit[rid] = {}; tries[rid] = {}; for (const h of HOURS) { hit[rid][h] = 0; tries[rid][h] = 0; } }
  for (let o = 0; o < 40; o++) {
    const origin = genLocation(seed, (rand(st) - 0.5) * 60, (rand(st) - 0.5) * 60);
    for (const h of HOURS) {
      const radius = 0.9 * h, cands = [];
      for (let i = 0; i < 5 * h; i++) {
        const rr = 0.5 + (radius - 0.5) * Math.sqrt(rand(st)), th = 2 * Math.PI * rand(st);
        cands.push({ loc: genLocation(seed, origin.x + rr * Math.cos(th), origin.y + rr * Math.sin(th)), noise: 0.08 * randn(st) });
      }
      for (const rid in RESOURCES) {
        if (origin.res[rid]) continue;
        tries[rid][h]++;
        let top = null, score = -Infinity;
        for (const c of cands) { const v = prospect(c.loc, rid) + c.noise; if (v > score) { score = v; top = c; } }
        if (prospect(top.loc, rid) >= 0.15) hit[rid][h]++;
      }
    }
  }
  const out = {};
  for (const rid in RESOURCES) {
    let bestM = Infinity, pick = { hours: 8, p: 0.02 };
    for (const h of HOURS) {
      const p = tries[rid][h] >= 5 ? Math.max(hit[rid][h] / tries[rid][h], 0.02) : 0.5;
      const m = (h * 60) / p + ((0.55 * 0.9 * h) / 3.2) * 60; // trips until success, plus the walk there afterwards
      if (m < bestM) { bestM = m; pick = { hours: h, p }; }
    }
    out[rid] = { m: bestM, hours: pick.hours, p: pick.p };
  }
  return (oddsCache[seed] = out);
}

// ------------------------------------------------------------------ the planner for one moment of one game
// `extra` ({cap: level}) pretends you already hold those capabilities: used
// to price a goal as it would be after some other project.
export function makePlanner(s, extra = null) {
  const T = tables(), L = here(s), odds = exploreOdds(s.seed);
  const capLv = {}, whereMemo = {}, optMemo = {}, nodeMemo = {}, statusMemo = {};
  const stack = new Set();
  const capNow = (cap) => (capLv[cap] != null ? capLv[cap] : (capLv[cap] = Math.max(capInfo(s, cap).level, (extra && extra[cap]) || 0)));
  const status = (rid) => statusMemo[rid] || (statusMemo[rid] = recipeStatus(s, RECIPES[rid], (s.choices || {})[rid] || {}));
  const enough = (rid, r) => r && r.known && (r.cap === Infinity || !RESOURCES[rid].gather || r.amt >= (KINDS[RESOURCES[rid].gather.kind].unit === 'ea' ? 1 : 0.05));

  // Where is the nearest known source of a resource?
  function resWhere(rid) {
    if (whereMemo[rid]) return whereMemo[rid];
    let w;
    if (enough(rid, L.res[rid])) w = { mode: 'here', m: 0 };
    else {
      let to = null, m = Infinity;
      for (const id in s.locs) {
        if (id === s.at || !enough(rid, s.locs[id].res[rid])) continue;
        const t = travelInfo(s, id).minutes;
        if (t < m) { m = t; to = id; }
      }
      w = to ? { mode: 'goto', to, m } : Object.assign({ mode: 'search' }, odds[rid]);
    }
    return (whereMemo[rid] = w);
  }

  // Every known way to come by one kind of item, with a cost model
  //   minutes(n) = setup + (per unit or per batch) * n
  function optionsFor(kind) {
    if (optMemo[kind]) return optMemo[kind];
    if (stack.has(kind)) return [];
    stack.add(kind);
    const opts = [];
    for (const rid of T.gatherers[kind] || []) {
      const g = RESOURCES[rid].gather, w = resWhere(rid);
      const rate = w.mode === 'here' ? Math.max(gatherStatus(s, rid).rate, 1e-3) : g.rate * 0.8;
      opts.push({ type: 'gather', rid, w, setup: w.m + (g.tool ? capEst(g.tool.cap, g.tool.min).m : 0), unit: 60 / rate });
    }
    for (const p of T.producers[kind] || []) {
      const r = RECIPES[p.rid];
      let setup = p.wait, per = r.time;
      for (const t of r.tools) if (!t.opt) setup += capEst(t.cap, t.min).m;
      if (r.res) setup += resWhere(r.res).m;
      for (const spec of r.in) if (!spec.opt) per += inputEst(spec, 1).m;
      opts.push({ type: 'recipe', rid: p.rid, n0: p.n, wait: p.wait, setup, per });
    }
    stack.delete(kind);
    if (!stack.size) optMemo[kind] = opts; // only cache results that no cycle guard truncated
    return opts;
  }
  const cost = (o, n) => (o.type === 'gather' ? o.setup + Math.max(30, o.unit * n) : o.setup + Math.ceil(n / o.n0 - 1e-9) * o.per);
  function bestOpt(kind, n) {
    let o = null, m = Infinity;
    for (const x of optionsFor(kind)) { const c = cost(x, n); if (c < m) { m = c; o = x; } }
    return { o, m };
  }
  function capEst(cap, min) {
    if (capNow(cap) >= min) return { m: 0, met: true };
    if (cap === 'boil') return { m: capEst('fire', 1).m + capEst('vessel', 0.5).m + bestOpt('cobble', 3).m };
    let kind = null, m = Infinity;
    for (const c of T.capKinds[cap] || []) {
      if (c.level < min) continue;
      const b = bestOpt(c.kind, 1);
      if (b.m < m) { m = b.m; kind = c.kind; }
    }
    return { m, kind };
  }
  function inputEst(spec, times) {
    const p = planInput(s, spec, null);
    let kind = null, m = Infinity, deficit = 0;
    for (const k of kindsFor(spec)) {
      const d = unitsOf(spec, k) * times - (p.kind === k ? p.have : 0);
      if (d <= 1e-9) return { m: 0, met: true };
      const b = bestOpt(k, d);
      if (b.m < m) { m = b.m; kind = k; deficit = d; }
    }
    return { m, kind, deficit };
  }

  // Expand one target into an ordered, de-duplicated list of steps. A tool
  // planned for one requirement also satisfies later ones.
  function expand(target) {
    const steps = [], byKey = {}, planned = {}, active = new Set(), reqs = { tool: {}, in: {}, res: null };
    let unknown = false;
    const add = (step, forKey) => {
      let e = byKey[step.key];
      if (e) { e.minutes += step.minutes; e.times += step.times; } else { e = byKey[step.key] = Object.assign({ for: [] }, step); steps.push(e); }
      if (forKey && forKey !== e.key && !e.for.includes(forKey)) e.for.push(forKey);
      return e.key;
    };
    function needCap(cap, min, forKey) {
      if (capNow(cap) >= min || (planned[cap] || 0) >= min) return null;
      if (cap === 'boil') {
        const keys = [needCap('fire', 1, forKey), needCap('vessel', 0.5, forKey)];
        const stones = inputEst({ kind: 'cobble', n: 3 }, 1);
        if (!stones.met) keys.push(obtain('cobble', stones.deficit, forKey));
        return keys.find((k) => k) || null;
      }
      const e = capEst(cap, min);
      if (!e.kind) { unknown = true; return null; }
      return obtain(e.kind, 1, forKey);
    }
    function obtain(kind, n, forKey) {
      const b = bestOpt(kind, n);
      if (!b.o || !isFinite(b.m) || active.has(kind) || steps.length > 80) { unknown = true; return null; }
      active.add(kind);
      let key;
      if (b.o.type === 'gather') {
        const g = RESOURCES[b.o.rid].gather;
        key = 'g.' + b.o.rid;
        if (g.tool) needCap(g.tool.cap, g.tool.min, key);
        add({ key, minutes: b.o.w.m + Math.max(30, Math.ceil((b.o.unit * n) / 30) * 30), wait: 0, times: 1 }, forKey);
      } else key = recipe(b.o.rid, Math.ceil(n / b.o.n0 - 1e-9), forKey, b.o.wait, false);
      active.delete(kind);
      for (const c in T.capKinds) { const hit = T.capKinds[c].find((x) => x.kind === kind); if (hit) planned[c] = Math.max(planned[c] || 0, hit.level); }
      return key;
    }
    function recipe(rid, times, forKey, wait, top) {
      const r = RECIPES[rid], key = 'r.' + rid;
      if (active.has(key)) { unknown = true; return null; }
      active.add(key);
      for (const t of r.tools) if (!t.opt) { const k = needCap(t.cap, t.min, key); if (top) reqs.tool[t.cap] = k; }
      if (r.res) { const w = resWhere(r.res); if (w.mode !== 'here') { const k = add({ key: 'g.' + r.res, minutes: w.m, wait: 0, times: 1 }, key); if (top) reqs.res = k; } }
      for (const spec of r.in) {
        if (spec.opt) continue;
        const e = inputEst(spec, spec.keep ? 1 : times);
        if (e.met) continue;
        const k = e.kind ? obtain(e.kind, e.deficit, key) : null;
        if (!k) unknown = true;
        if (top) reqs.in[spec.id] = k;
      }
      add({ key, minutes: r.time * times, wait: wait || 0, times }, forKey);
      active.delete(key);
      return key;
    }
    if (target[0] === 'r') recipe(target.slice(2), 1, null, T.procWait[target.slice(2)] || 0, true);
    else {
      const rid = target.slice(2), g = RESOURCES[rid].gather, w = resWhere(rid);
      if (g && g.tool) reqs.tool[g.tool.cap] = needCap(g.tool.cap, g.tool.min, target);
      add({ key: target, minutes: w.m + (g ? 30 : 0), wait: 0, times: 1 }, null);
    }
    return { steps, reqs, unknown };
  }

  // A node is one thing the player might set out to do.
  function node(key) {
    if (nodeMemo[key]) return nodeMemo[key];
    const n = Object.assign({ key }, expand(key));
    if (key[0] === 'r') {
      const r = RECIPES[key.slice(2)];
      n.recipe = r; n.st = status(r.id); n.name = r.name; n.group = r.group; n.ready = n.st.ok;
      if (!n.ready && n.steps.length <= 1) n.unknown = true; // blocked by something the planner cannot route around
      n.steps[n.steps.length - 1].minutes = n.st.time || r.time;
    } else {
      const rid = key.slice(2), def = RESOURCES[rid];
      n.res = def; n.w = resWhere(rid); n.group = 'Collect and find';
      const what = def.gather ? KINDS[def.gather.kind].name : def.name.toLowerCase();
      if (n.w.mode === 'here') { n.gs = def.gather ? gatherStatus(s, rid) : null; n.name = def.gather ? 'Collect ' + what : def.name + ' (here)'; n.ready = !!(n.gs && n.gs.ok); n.passive = !def.gather; }
      else if (n.w.mode === 'goto') { n.name = `Walk to ${s.locs[n.w.to].name.toLowerCase()} for ${what}`; n.ready = true; }
      else { n.name = 'Find ' + def.name.toLowerCase(); n.ready = true; }
    }
    n.total = n.unknown ? Infinity : n.steps.reduce((a, st) => a + st.minutes + st.wait, 0);
    n.away = n.steps.length - 1;
    return (nodeMemo[key] = n);
  }

  const keys = Object.keys(RESOURCES).map((r) => 'g.' + r).concat(Object.keys(RECIPES).map((r) => 'r.' + r));
  return { node, keys, has: (key) => keys.includes(key) };
}

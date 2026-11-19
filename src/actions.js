// Actions: the only way game state changes. The UI builds a command object
// and calls act(state, cmd); tests do exactly the same, with no browser.
//
//   {t:'gather', rid, min}            {t:'recipe', id, choose:{inputId:itemId}}
//   {t:'work', id}                    {t:'replace', id, slot, with}   {t:'dismantle', id}
//   {t:'eat', id}  {t:'drink'}  {t:'drinkItem', id}  {t:'fill', id}
//   {t:'rest', min}  {t:'sleep'}
//   {t:'survey'}  {t:'checkTraps'}  {t:'explore', hours, targets:[rid]}  {t:'travel', to}
//   {t:'move', id, to:'hands'|'ground'|'wear'|<container item id>}
//
// Every handler returns {ok, msg}. A refused action changes nothing.

import { clamp, rand, randn, fmt, fmtTime, stream } from './util.js';
import { KINDS, UNIT } from './data/items.js';
import { RESOURCES, PLACE_HA, encounter } from './data/resources.js';
import { RECIPES, TAG_NAMES, CAP_NAMES } from './data/recipes.js';
import { genLocation, findStart, prospect, dist, bearing } from './world.js';
import { pieceSpread, piecesIn, pieceSize, tierKey, tierRank, tiersOf } from './tiers.js';
import { kindOf, mk, itemName, label, massOf, contSpec, whyNotHold, roomFor, capOf, addTo, split, reach, find, removeFrom, canMerge,
  best, here, handsFor, handsUsed, carriedMass, wornIn, missingSlots, trashHere, tierLabel, pieceKind, piecesOf, setPieces, pieceScore, bestPieceFor, ids } from './items.js';
import { say, advance, isDark, raining, condSev, footwear, impairment } from './sim.js';

export const MAX_CARRY = 35; // kg felt

// ------------------------------------------------------------------ new game
function addLocation(s, loc, alsoKnown = []) {
  loc.id = 'L' + s.nextLoc++;
  for (const rid in loc.res) loc.res[rid].known = alsoKnown.includes(rid) || rand(s.rng) < RESOURCES[rid].vis;
  loc.surveys = 0;
  s.locs[loc.id] = loc;
  return loc;
}

export function newGame(seed) {
  seed = String(seed);
  const s = {
    v: 1, seed, rng: stream('play|' + seed), t: 8 * 60, nextId: 1, nextLoc: 1, at: null, locs: {},
    c: { stomach: 300, glyc: 1500, fat: 60000, thirst: 0.3, fatigue: 10, chill: 0, health: 100, cond: [], hands: [], worn: [] },
    weather: { kind: 'clear', dT: 1, until: 8 * 60 + 300 }, log: [], seen: {}, goals: {}, dead: null, rv: 2,
  };
  const start = addLocation(s, findStart(seed), ['water', 'deadwood']);
  s.at = start.id; s.home = start.id;
  say(s, 'You come to yourself standing in open country: no clothes, no tools, nothing in your hands.');
  say(s, 'You know, with a certainty you cannot explain, how everything is made. You do not know what is over the next rise.');
  say(s, `This place: ${start.name.toLowerCase()}. It is morning.`);
  return s;
}

// Saves from before resources were restated as densities (rv 2): the world
// is a pure function of the seed, so regenerate each known place's amounts
// and keep how depleted each resource was. New resources (sticks) appear,
// and new deposit qualities (pole strength) are filled in.
export function migrate(s) {
  if (s.rv >= 2) return s;
  for (const id in s.locs) {
    const loc = s.locs[id], fresh = genLocation(s.seed, loc.x, loc.y);
    for (const rid in fresh.res) {
      const r = loc.res[rid], f = fresh.res[rid];
      if (!r) { loc.res[rid] = Object.assign(f, { known: RESOURCES[rid].vis >= 1 || loc.surveys >= 3 }); continue; }
      const frac = isFinite(r.cap) && r.cap > 0 ? clamp(r.amt / r.cap, 0, 1) : 1;
      r.cap = f.cap; r.amt = isFinite(f.cap) ? f.cap * frac : f.amt;
      for (const q in f.q) if (r.q[q] == null) r.q[q] = f.q[q];
    }
  }
  s.rv = 2;
  return s;
}

// ------------------------------------------------------------------ small helpers
const loc = here;
const R = (s) => () => rand(s.rng);
const hasKind = (s, kind) => reach(s).some((r) => r.it.kind === kind);
const findKind = (s, kind) => { const r = reach(s).find((x) => x.it.kind === kind); return r ? r.it : null; };

export function addCond(s, type, sev) {
  const c = s.c.cond.find((x) => x.type === type);
  if (c) c.sev = Math.min(100, Math.max(c.sev, sev) + 0.3 * Math.min(c.sev, sev)); else s.c.cond.push({ type, sev });
  s.c.health = Math.max(1, s.c.health - sev * 0.12);
  const text = { cut: 'You cut your hand.', blister: 'Your palms blister.', sprain: 'You twist an ankle.', bruise: 'You take a hard knock.',
    gastro: 'Your gut cramps. Something you ate or drank was bad.', burn: 'You burn yourself.' }[type];
  say(s, `${text} (${sev < 20 ? 'minor' : sev < 45 ? 'painful' : 'serious'})`, 'bad');
}

function rollRisks(s, risks, mult) {
  for (const r of risks || []) {
    if (rand(s.rng) < r.p * mult * impairment(s).risk) addCond(s, r.type, Math.round(r.sev[0] + (r.sev[1] - r.sev[0]) * rand(s.rng)));
  }
}

// Work goes slower with injured hands, and in the dark.
function slowdown(s, outdoor) {
  let m = 1 + (condSev(s, 'cut') + condSev(s, 'blister') + condSev(s, 'burn')) / 150;
  if (isDark(s)) m *= outdoor ? 1.6 : (best(s, 'fire').level > 0 ? 1 : 1.4);
  return m * impairment(s).slow;
}

function give(s, kind, n, q = {}, extra = null, pieces = null) {
  const k = KINDS[kind];
  if (k.unit === 'ea') n = Math.floor(n + rand(s.rng) * 0.999 * (n % 1 ? 1 : 0)); else n = Math.round(n * 1000) / 1000;
  if (pieces) n = pieces.length;
  if (n <= 0) return null;
  const it = mk(s, kind, n, pieces ? pieces[0] : q);
  if (pieces && pieces.length > 1) setPieces(it, pieces.map((p) => Object.assign({}, k.q, p)));
  else if (pieces) it.q = Object.assign({}, k.q, pieces[0]);
  if (extra) Object.assign(it, extra);
  const placed = addTo(loc(s).items, it);
  if (s._made && !s._made.includes(placed)) s._made.push(placed);
  return placed;
}

// ------------------------------------------------------------------ capabilities, including the composite "boil"
// Boiling is not a property of one object: it needs a lit fire, water in a
// vessel, and either a fireproof pot or stones to heat and drop in.
export function boilSetup(s) {
  if (best(s, 'fire').level <= 0) return { why: 'no fire' };
  let vessel = null, water = 0;
  for (const { it } of reach(s)) {
    const c = contSpec(it);
    if (!c || !c.liquid) continue;
    const w = (it.in || []).filter((x) => x.kind === 'water').reduce((a, x) => a + x.n, 0);
    if (w >= 0.5 && (!vessel || (c.fireproof && !contSpec(vessel).fireproof))) { vessel = it; water = w; }
  }
  if (!vessel) return { why: 'no vessel holding at least 0.5 L of water' };
  if (contSpec(vessel).fireproof) return { vessel, water };
  const stones = reach(s).filter((r) => r.it.kind === 'cobble').reduce((a, r) => a + r.it.n, 0);
  if (stones < 3) return { why: 'need 3 cobbles to heat, or a fireproof pot' };
  return { vessel, water, stones: true };
}

export function capInfo(s, cap) {
  if (cap === 'boil') { const b = boilSetup(s); return { level: b.vessel ? 50 : 0, it: b.vessel || null, why: b.why }; }
  return best(s, cap);
}

// A stack whose pieces have drifted into different tiers splits up.
function retier(s, it) {
  if (!it.ps || new Set(it.ps.map((p) => tierKey({ kind: it.kind, q: p }))).size < 2) return;
  const f = find(s, it.id);
  if (!f) return;
  removeFrom(f.list, it);
  addTo(f.list, it);
}

function wearTool(s, cap, hours) {
  const tool = best(s, cap).it;
  if (!tool) return;
  if (s._used) s._used.push(tool);
  const spec = (kindOf(tool).wear || {})[cap];
  for (const slot in spec || {}) {
    const target = slot === '_' ? tool : tool.parts && tool.parts[slot];
    if (!target) continue;
    // of a stack, only the piece in use wears
    const pi = slot === '_' ? bestPieceFor(tool, cap) : -1, q0 = pi >= 0 ? target.ps[pi] : target.q;
    for (const q in spec[slot]) {
      if (q0[q] == null) continue;
      // mostly gradual, occasionally a bad stroke: this is how hafts shatter
      const amt = spec[slot][q] * hours * (0.5 + rand(s.rng)) * (rand(s.rng) < 0.03 ? 6 : 1);
      q0[q] = Math.max(0, Math.round((q0[q] - amt) * 10) / 10);
    }
    if (pi >= 0) { setPieces(target, target.ps); retier(s, target); }
  }
  if (tool.kind === 'flake' && (cap === 'cut' || cap === 'scrape') && rand(s.rng) < 0.04 * hours) addCond(s, 'cut', 5 + Math.round(15 * rand(s.rng)));
}

// ------------------------------------------------------------------ gathering
export function gatherStatus(s, rid) {
  const r = loc(s).res[rid], def = RESOURCES[rid], g = def.gather;
  if (!r || !g) return null;
  const lines = [];
  let ok = true;
  if (g.tool) {
    const b = best(s, g.tool.cap);
    const good = b.level >= g.tool.min;
    ok = ok && good;
    lines.push({ ok: good, text: `${CAP_NAMES[g.tool.cap]} ${g.tool.min}+ ${b.it ? `(${itemName(b.it)}: ${Math.round(b.level)})` : '(none)'}` });
  }
  let level = 0;
  if (g.boost) {
    const b = g.boost.cap === 'bag' ? bagFor(s, g.kind) : best(s, g.boost.cap);
    level = b.level;
    lines.push({ ok: b.level > 0, opt: true, text: `faster handling with a ${CAP_NAMES[g.boost.cap]} ${b.it ? `(${itemName(b.it)}: ×${fmt(1 + b.level / g.boost.per)})` : ''}` });
  }
  // search plus handling: the thinner a resource gets, the longer the search
  const rate = encounter(def, r.amt / PLACE_HA, level) / slowdown(s, true);
  const boost = g.boost ? 1 + level / g.boost.per : 1;
  if (r.amt < (KINDS[g.kind].unit === 'ea' ? 1 : 0.05)) { ok = false; lines.push({ ok: false, text: 'none left for now' }); }
  return { ok, lines, rate, boost, level, def, r };
}

// A requirement on what you collect: {cap, min} (good enough for a hammer)
// or {q: {quality: min}} (straight enough for a spear shaft).
export function reqTest(req) {
  if (!req) return null;
  if (req.cap) return (it) => capOf(it, req.cap) >= req.min;
  return (it) => Object.keys(req.q).every((k) => (it.q[k] ?? 0) >= req.q[k]);
}
export const reqText = (req) => (!req ? '' : req.cap ? `a ${CAP_NAMES[req.cap] || req.cap} (${req.min}+)` : Object.keys(req.q).map((k) => `${k} ${req.q[k]}+`).join(', '));

// Collecting, piece by piece: search until you come on a candidate (random,
// at the encounter rate), look it over, and if it will do, take it (the
// handling time). With requirements, pieces that will not do are left.
//   cmd: {rid, wants: [{n: units, req}], min: or else this long}
//   (the strictest wants are filled first: the ridge pole before the uprights)
function doGather(s, cmd) {
  const st = gatherStatus(s, cmd.rid);
  if (!st || !st.r.known) return { ok: false, msg: 'Nothing like that here.' };
  if (!st.ok) return { ok: false, msg: 'You cannot gather that right now.' };
  const def = st.def, g = def.gather, r = st.r, kind = KINDS[g.kind], f = def.find;
  const u = pieceSize(g.kind);
  const wants = (cmd.wants || [{ n: cmd.n || (cmd.min ? (st.rate * cmd.min) / 60 : 2 * kind.hand), req: cmd.req }])
    .map((w) => ({ n: kind.unit === 'ea' ? Math.max(1, Math.round(w.n)) : w.n, req: w.req, test: reqTest(w.req), got: 0 }))
    .sort((a, b) => (b.req ? 1 : 0) - (a.req ? 1 : 0));
  let want = Math.min(wants.reduce((a2, w) => a2 + w.n, 0), r.amt);
  const test = wants.every((w) => w.test) ? true : null; // only take pieces some want accepts
  const open = () => wants.filter((w) => w.got < w.n - 1e-9);
  const D = r.amt / PLACE_HA, a = (f.speed * f.sweep) / 10, h = f.handle / 60 / st.boost;
  const spread = pieceSpread(cmd.rid, here(s).env), wet = raining(s), maxH = 4;
  let t = 0, seen = 0;
  const got = [];
  while (open().length && got.length * u < want - 1e-9 && t < maxH && seen < 20000) {
    t += (u / (a * D)) * -Math.log(1 - rand(s.rng) * 0.999999); // searching for the next candidate
    seen++;
    const q = {};
    for (const key in r.q) q[key] = clamp(r.q[key] + (spread[key] ?? 5) * randn(s.rng), 0, 100);
    if (q.dryness != null && wet) q.dryness = Math.max(0, q.dryness - 35);
    const piece = { id: 0, kind: g.kind, n: 1, q: Object.assign({}, kind.q, q) };
    const w = open().find((x) => !x.test || x.test(piece));
    if (!w) continue; // nothing still wanted will take this one
    t += u * h; // taking it
    w.got += u;
    got.push(q);
  }
  const minutes = Math.max(2, t * 60 * slowdown(s, true)), hours = minutes / 60;
  if (g.tool) wearTool(s, g.tool.cap, hours);
  if (g.boost && best(s, g.boost.cap).level > 0) wearTool(s, g.boost.cap, hours);
  advance(s, minutes, g.met || 3, 'act');
  rollRisks(s, g.risk || [{ type: 'cut', p: 0.01, sev: [3, 12] }], hours * (isDark(s) ? 3 : 1));
  r.assessed = true;
  const n = kind.unit === 'ea' ? got.length : Math.round(got.length * u * 100) / 100;
  r.amt = Math.max(0, r.amt - n);
  const strict = wants.filter((w) => w.req);
  if (!got.length) { say(s, `You spend ${fmtTime(minutes)} and find no ${kind.name}${strict.length ? ` good enough for ${reqText(strict[0].req)}` : ' worth taking'}.`); return { ok: true }; }
  // countable things keep each piece; loose stuff averages within a tier
  let placed;
  if (pieceKind(g.kind)) placed = give(s, g.kind, 0, {}, null, got);
  else {
    const groups = {};
    for (const q of got) { const key = tierKey({ kind: g.kind, q }); (groups[key] = groups[key] || []).push(q); }
    const list = Object.values(groups).sort((x, y) => pieceScore(g.kind, y[0]) - pieceScore(g.kind, x[0]));
    for (const grp of list) {
      const q = {};
      for (const key in grp[0]) q[key] = grp.reduce((acc, p) => acc + p[key], 0) / grp.length;
      const it = give(s, g.kind, Math.round(grp.length * u * 100) / 100, q);
      if (!placed) placed = it;
    }
  }
  if (s._made) s._made = placed ? [placed] : []; // only the best of the trip goes to hand
  const top = placed ? tierLabel(placed) : '';
  const short = got.length * u < want - 1e-9 ? ` (you wanted ${kind.unit === 'ea' ? want : fmt(want) + UNIT[kind.unit]})` : '';
  const goodFor = strict.length ? `, ${strict.map((w) => `${kind.unit === 'ea' ? Math.round(w.got) : fmt(w.got) + UNIT[kind.unit]} good enough for ${reqText(w.req)}`).join(', ')}` : '';
  say(s, `You gather ${kind.unit === 'ea' ? n + ' × ' : fmt(n) + UNIT[kind.unit] + ' of '}${kind.name}${goodFor} in ${fmtTime(minutes)}${short}${!strict.length && top ? `; the best ${kind.unit === 'ea' && placed.n === 1 ? 'is' : 'are'} good for ${top}` : ''}.`);
  return { ok: true, done: 'g.' + cmd.rid };
}

// The best carried container that will actually hold what you are picking
// (seed sifts through a basket; a hide bag holds it).
export function bagFor(s, kind) {
  let top = null, level = 0;
  for (const { it } of reach(s)) {
    const v = capOf(it, 'bag');
    if (v > level && KINDS[kind].grain >= contSpec(it).mesh) { level = v; top = it; }
  }
  return { it: top, level };
}

// ------------------------------------------------------------------ recipe requirements
function matches(it, spec) {
  const k = kindOf(it);
  if (k.fixed || it.proc || it.proj || (it.in && it.in.length) || missingSlots(it).length) return false;
  if (spec.kind ? it.kind !== spec.kind : !k.tags.includes(spec.tag)) return false;
  for (const key in spec.q || {}) if ((it.q[key] ?? 0) < spec.q[key]) return false;
  for (const key in spec.qmax || {}) if ((it.q[key] ?? 0) > spec.qmax[key]) return false;
  return true;
}
const unitsNeeded = (spec, kind) => (spec.kg != null ? spec.kg / KINDS[kind].mass : spec.n);
const metric = (it, spec) => {
  const key = spec.prefer || Object.keys(spec.q || {})[0];
  return key ? it.q[key] ?? 0 : it.q.integrity ?? it.q.fresh ?? 0;
};

// Decide which stacks would supply an input. Material for one input always
// comes from a single kind (you do not thatch half in grass, half in bark),
// but may be drawn from several stacks of it.
// `used` (id -> units) holds what other inputs of the same recipe have
// already claimed, so two slots never count the same pile twice.
export function planInput(s, spec, chosenId, scaleMax = 0, used = null) {
  const left = (it) => it.n - ((used && used.get(it.id)) || 0);
  const cands = reach(s).map((r) => r.it).filter((it) => matches(it, spec) && left(it) > 1e-9);
  const byKind = {};
  for (const it of cands) (byKind[it.kind] = byKind[it.kind] || []).push(it);
  const chosen = cands.find((it) => it.id === chosenId);
  let pickKind = null, bestScore = -1;
  for (const kind in byKind) {
    const total = byKind[kind].reduce((a, it) => a + left(it), 0);
    const enough = total + 1e-9 >= unitsNeeded(spec, kind);
    // with a quality to maximise, the best kind; otherwise the plainest that will do (sticks before poles for ribs)
    const grade = spec.prefer ? Math.max(...byKind[kind].map((it) => metric(it, spec))) : -Math.min(...byKind[kind].map((it) => pieceScore(kind, it.q))) / 1000;
    const score = (chosen && chosen.kind === kind ? 1e6 : 0) + (enough ? 1e3 : 0) + grade;
    if (score > bestScore) { bestScore = score; pickKind = kind; }
  }
  if (!pickKind) return { ok: false, have: 0, cands };
  // use up the least good stacks that will do, unless the result depends on quality
  const stacks = byKind[pickKind].sort((a, b) => (b === chosen) - (a === chosen) || (spec.prefer ? metric(b, spec) - metric(a, spec) : pieceScore(pickKind, a.q) - pieceScore(pickKind, b.q)));
  const have = stacks.reduce((a, it) => a + left(it), 0);
  const base = unitsNeeded(spec, pickKind);
  let k = 1;
  if (scaleMax) {
    k = Math.min(have, scaleMax * (base / (spec.kg ?? spec.n))) / base;
    if (KINDS[pickKind].unit === 'ea') k = Math.floor(k * base + 1e-9) / base;
    k = Math.max(1, k);
  }
  return { ok: have + 1e-9 >= base, kind: pickKind, stacks, have, base, k, cands, first: stacks[0] };
}

function describeInput(spec, plan) {
  const kind = spec.kind || (plan.ok || plan.kind ? plan.kind : null);
  const amount = spec.kg != null ? `${fmt(spec.kg)} kg` : `${fmt(spec.n)}${spec.kind ? UNIT[KINDS[spec.kind].unit] : kind ? UNIT[KINDS[kind].unit] : ''}`;
  const name = spec.kind ? KINDS[spec.kind].name : TAG_NAMES[spec.tag] || spec.tag;
  const quals = Object.keys(spec.q || {}).map((q) => `${q} ${spec.q[q]}+`).concat(Object.keys(spec.qmax || {}).map((q) => `${q} below ${Math.round(spec.qmax[q])}`));
  return `${amount} ${name}${quals.length ? ' (' + quals.join(', ') + ')' : ''}`;
}

export function recipeStatus(s, r, choose = {}) {
  const lines = [], plans = {};
  let ok = true, k = 1;
  for (const t of r.tools) {
    const b = capInfo(s, t.cap);
    const good = b.level >= t.min;
    if (!t.opt && !good) ok = false;
    const have = b.level > 0 && b.it ? `${itemName(b.it)}${t.cap === 'boil' || t.cap === 'fire' ? '' : ': ' + Math.round(b.level)}` : b.why || 'none';
    lines.push({ ok: good, opt: !!t.opt, cap: t.cap, text: `${t.opt ? 'helps: ' : ''}${CAP_NAMES[t.cap] || t.cap}${t.min > 1 ? ' ' + t.min + '+' : ''} (${have})` });
  }
  if (r.res) {
    const res = loc(s).res[r.res];
    const good = !!(res && res.known);
    if (!good) ok = false;
    lines.push({ ok: good, res: r.res, text: `${RESOURCES[r.res].name.toLowerCase()} at this place` });
  }
  const used = new Map(), inLines = {};
  for (const spec of inputOrder(r)) {
    const max = scaleMaxOf(s, r, spec);
    const p = planInput(s, spec, choose[spec.id], max, used);
    plans[spec.id] = p;
    if (r.scale === spec.id && p.ok) k = p.k;
    if (!p.ok && !spec.opt) ok = false;
    if (p.ok) { // claim what this input will take
      let need = p.base * (r.scale === spec.id ? p.k : 1);
      for (const it of p.stacks) { if (need <= 1e-9) break; const take = Math.min(it.n - (used.get(it.id) || 0), need); used.set(it.id, (used.get(it.id) || 0) + take); need -= take; }
    }
    inLines[spec.id] = { ok: p.ok, opt: !!spec.opt, input: spec.id, plan: p,
      text: `${spec.opt ? 'optional: ' : ''}${describeInput(spec, p)}${p.ok ? '' : p.have ? ` (have ${fmt(p.have)})` : ''}` };
  }
  for (const spec of r.in) lines.push(inLines[spec.id]);
  if (r.check) {
    const why = r.check(s, { hasKind: (kind) => hasKind(s, kind) });
    if (why) { ok = false; lines.push({ ok: false, text: why }); }
  }
  const time = r.time * (r.flat ? 1 : k) * slowdown(s, r.outdoor);
  return { ok, lines, plans, k, time, choose };
}

// A recipe is worth showing once the player holds about half of what it needs.
export function recipeVisible(s, r, st) {
  if (s.seen[r.id]) return true;
  const req = st.lines.filter((l) => !l.opt);
  const met = req.filter((l) => l.ok).length;
  const inputs = req.filter((l) => l.input);
  const show = st.ok || (req.length > 0 && met / req.length >= 0.5 && (inputs.length === 0 || inputs.some((l) => l.ok)));
  if (show) s.seen[r.id] = 1;
  return show;
}

// ------------------------------------------------------------------ doing recipes
// Inputs with quality requirements are settled first, so a plain slot
// (ribs) cannot use up the one pole good enough for the ridge.
const inputOrder = (r) => r.in.slice().sort((a, b) => (b.q ? 1 : 0) - (a.q ? 1 : 0));
const scaleMaxOf = (s, r, spec) => (r.scale === spec.id ? spec.max * (spec.maxWith && capInfo(s, spec.maxWith.cap).level > 0 ? spec.maxWith.mult : 1) : 0);

function takeInputs(s, r, st) {
  const ins = {};
  for (const spec of inputOrder(r)) {
    if (!st.plans[spec.id].ok) continue;
    // plan again on the state as it now is: earlier inputs have taken their share
    const p = planInput(s, spec, (st.choose || {})[spec.id], scaleMaxOf(s, r, spec));
    if (!p.ok) continue;
    let need = p.base * (r.scale === spec.id ? st.k : 1);
    let merged = null;
    for (const stack of p.stacks) {
      if (need <= 1e-9) break;
      const n = Math.min(stack.n, need);
      need -= n;
      let piece;
      if (n >= stack.n - 1e-9) { piece = stack; removeFrom(find(s, stack.id).list, stack); }
      else { piece = split(s, stack, n, spec.prefer ? 'best' : 'worst'); if (s._partial && s.c.hands.includes(stack)) s._partial.push(stack); }
      if (!merged) merged = piece;
      else if (pieceKind(merged.kind)) setPieces(merged, piecesOf(merged).concat(piecesOf(piece)));
      else {
        const tot = merged.n + piece.n;
        for (const key in merged.q) merged.q[key] = (merged.q[key] * merged.n + (piece.q[key] ?? 0) * piece.n) / tot;
        merged.n = tot;
      }
    }
    if (merged && merged.ps && merged.ps.length === 1) { merged.q = merged.ps[0]; delete merged.ps; }
    ins[spec.id] = merged;
  }
  return ins;
}

function makeCtx(s, r, ins, k) {
  return {
    s, ins, k, loc: loc(s), wet: raining(s) && best(s, 'roof').level < 40,
    r: R(s), rn: () => randn(s.rng), lvl: (cap) => capInfo(s, cap).level,
    say: (msg, cls) => say(s, msg, cls),
    give: (kind, n, q, extra) => give(s, kind, n, q, extra),
    build: (kind, parts, q) => {
      const it = mk(s, kind, 1, q);
      it.parts = {};
      for (const sl in parts) if (parts[sl]) it.parts[sl] = parts[sl];
      loc(s).items.push(it);
      return it;
    },
    findKind: (kind) => findKind(s, kind),
    removeKind: (kind) => { const f = reach(s).find((x) => x.it.kind === kind); if (f) removeFrom(f.list, f.it); },
    resCap: (rid) => RESOURCES[rid].cap,
    takeRes: (rid, n) => { const res = loc(s).res[rid]; if (res) res.amt = Math.max(0, res.amt - n); },
    boil: (useL, purify) => {
      const b = boilSetup(s);
      if (!b.vessel) return 0;
      if (b.stones) {
        const f = reach(s).filter((x) => x.it.kind === 'cobble').sort((a, c) => a.it.q.thermal - c.it.q.thermal)[0];
        if (f && rand(s.rng) < (100 - f.it.q.thermal) / 250) {
          if (f.it.n <= 1) removeFrom(f.list, f.it); else split(s, f.it, 1, 'worst');
          say(s, 'A cooking stone cracks apart in the heat.', 'warn');
        }
      }
      const waters = b.vessel.in.filter((x) => x.kind === 'water');
      if (purify) for (const w of waters) w.q.purity = 100;
      let left = useL;
      for (const w of waters) { const n = Math.min(w.n, left); w.n -= n; left -= n; }
      b.vessel.in = b.vessel.in.filter((x) => x.n > 0.001);
      return b.water;
    },
  };
}

// One sitting of work on a recipe: wear the tools, risk injury, spend the time.
function session(s, r, minutes) {
  const hours = minutes / 60;
  for (const t of r.tools) if (capInfo(s, t.cap).level >= t.min) wearTool(s, t.cap, hours);
  advance(s, minutes, r.met, 'act');
  rollRisks(s, r.risk, minutes / Math.max(r.time, 1) * (r.outdoor && isDark(s) ? 2 : 1));
}

function finish(s, r, ins, k) {
  const c = makeCtx(s, r, ins, k);
  const failed = r.fail && rand(s.rng) < r.fail(c);
  if (failed) say(s, r.failMsg || 'It does not work.', 'warn');
  else r.make(c);
  for (const spec of r.in) {
    const it = ins[spec.id];
    if (it && (spec.keep || (failed && r.failKeeps))) addTo(loc(s).items, it);
  }
  return !failed;
}

const SESSION = 120; // minutes of work per click on a long job

function doRecipe(s, cmd) {
  const r = RECIPES[cmd.id];
  if (!r) return { ok: false, msg: 'Unknown technique.' };
  const st = recipeStatus(s, r, cmd.choose || {});
  if (!st.ok) return { ok: false, msg: 'Missing: ' + st.lines.filter((l) => !l.ok && !l.opt).map((l) => l.text).join('; ') };
  const ins = takeInputs(s, r, st);
  if (st.time > SESSION + 30 && !r.outdoor) {
    const it = mk(s, 'project', 1);
    it.proj = { rid: r.id, name: r.name.replace(/^(Build|Assemble|Weave|Knot|Burn out|Sew|Peck and grind|Brain-tan|Flesh and scrape) (an? )?/, ''), left: st.time, total: st.time, ins, k: st.k };
    loc(s).items.push(it);
    say(s, `You begin: ${r.name.toLowerCase()}. About ${fmtTime(st.time)} of work in all.`);
    return doWork(s, { id: it.id });
  }
  session(s, r, st.time);
  let done = false;
  if (!s.dead) { const n = s.log.length; done = finish(s, r, ins, st.k); if (done && s.log.length === n) say(s, `Done: ${r.name.toLowerCase()}.`); }
  return { ok: true, done: done ? 'r.' + r.id : null };
}

function doWork(s, cmd) {
  const f = find(s, cmd.id);
  if (!f || !f.it.proj) return { ok: false, msg: 'That is not here.' };
  const p = f.it.proj, r = RECIPES[p.rid];
  const missing = r.tools.filter((t) => !t.opt && capInfo(s, t.cap).level < t.min);
  if (missing.length) return { ok: false, msg: 'You need: ' + missing.map((t) => `${CAP_NAMES[t.cap]} ${t.min}+`).join(', ') };
  const minutes = Math.min(p.left, SESSION);
  session(s, r, minutes);
  p.left -= minutes;
  if (s.dead) return { ok: true };
  if (p.left <= 0.5) {
    removeFrom(f.list, f.it);
    const n = s.log.length, done = finish(s, r, p.ins, p.k);
    if (done && s.log.length === n) say(s, `Finished: ${r.name.toLowerCase()}.`, 'good');
    return { ok: true, done: done ? 'r.' + r.id : null };
  } else say(s, `You work on the ${p.name}. ${fmtTime(p.left)} to go.`);
  return { ok: true };
}

// ------------------------------------------------------------------ repair and dismantling
export function slotSpec(it, slot) { return Object.assign({ id: slot }, kindOf(it).slots[slot]); }

function doReplace(s, cmd) {
  const f = find(s, cmd.id);
  if (!f || !kindOf(f.it).slots || !kindOf(f.it).slots[cmd.slot]) return { ok: false, msg: 'That cannot be repaired that way.' };
  const it = f.it, spec = slotSpec(it, cmd.slot);
  const plan = planInput(s, spec, cmd.with);
  if (!plan.ok) return { ok: false, msg: `You need ${describeInput(spec, plan)}.` };
  const ins = takeInputs(s, { in: [spec] }, { plans: { [cmd.slot]: plan }, k: 1, choose: { [cmd.slot]: cmd.with } });
  it.parts = it.parts || {};
  const old = it.parts[cmd.slot];
  it.parts[cmd.slot] = ins[cmd.slot];
  if (old) addTo(loc(s).items, old);
  advance(s, kindOf(it).fixed ? 30 : 15, 2.5, 'act');
  say(s, `You ${old ? 'replace' : 'fit'} the ${cmd.slot} of the ${kindOf(it).name} with ${label(ins[cmd.slot])}.`);
  return { ok: true };
}

function doDismantle(s, cmd) {
  const f = find(s, cmd.id);
  if (!f) return { ok: false, msg: 'That is not here.' };
  const it = f.it, k = kindOf(it);
  if (!(it.proj || k.slots || k.unset)) return { ok: false, msg: 'There is nothing to take apart.' };
  removeFrom(f.list, it);
  const ground = loc(s).items;
  if (it.proj) for (const id in it.proj.ins) if (it.proj.ins[id]) addTo(ground, it.proj.ins[id]);
  for (const sl in it.parts || {}) addTo(ground, it.parts[sl]);
  for (const c of it.in || []) if (!kindOf(c).liquid) addTo(ground, c);
  if (k.unset) { const q = {}; for (const key in KINDS[k.unset].q) if (it.q[key] != null) q[key] = it.q[key]; addTo(ground, mk(s, k.unset, 1, q)); }
  advance(s, k.fixed ? 15 : 5, 2.5, 'act');
  say(s, `You take apart the ${itemName(it)}.`);
  return { ok: true };
}

// ------------------------------------------------------------------ eating and drinking
function doEat(s, cmd) {
  const f = find(s, cmd.id);
  const food = f && kindOf(f.it).food;
  if (!food) return { ok: false, msg: 'You cannot eat that.' };
  const c = s.c, it = f.it;
  if (c.stomach >= 2000) return { ok: false, msg: 'You are too full to eat more.' };
  let n = Math.min(it.n, food.portion, (2300 - c.stomach) / food.kcal);
  if (kindOf(it).unit === 'ea') n = Math.max(1, Math.floor(n));
  if (n < 0.01) { removeFrom(f.list, it); return { ok: false, msg: 'Only crumbs were left; you brush them away.' }; }
  const share = n / food.portion;
  let kcal = food.kcal * n;
  advance(s, 10, 1.5, 'rest');
  const tannin = it.q.tannin || 0;
  if (tannin > 25) { kcal *= 0.5; say(s, 'It is mouth-puckeringly bitter.', 'warn'); }
  c.stomach += kcal;
  c.thirst = Math.max(0, c.thirst - food.water * n);
  say(s, `You eat ${fmt(n)}${UNIT[kindOf(it).unit]} of ${kindOf(it).name} (${Math.round(kcal)} kcal).`);
  let p = food.risk * share + (tannin > 25 ? 0.5 * share : 0);
  if (it.q.fresh != null && it.q.fresh < 25) p += 0.4 * share;
  if (rand(s.rng) < p) addCond(s, 'gastro', 25 + Math.round(40 * rand(s.rng)));
  it.n = Math.round((it.n - n) * 1000) / 1000;
  if (it.n < 0.01) removeFrom(f.list, it);
  return { ok: true };
}

export function waterHere(s) {
  const r = loc(s).res.water;
  if (!r || !r.known) return null;
  return { purity: Math.max(r.q.purity, best(s, 'well').level) };
}

function drink(s, liters, purity, what) {
  const c = s.c;
  c.thirst = Math.max(0, c.thirst - liters);
  advance(s, 3, 1.5, 'rest');
  say(s, `You drink ${what}.`);
  const p = Math.pow((100 - purity) / 100, 2) * 0.25 * (liters / 1.5);
  if (rand(s.rng) < p) addCond(s, 'gastro', 30 + Math.round(40 * rand(s.rng)));
}

function doDrink(s) {
  const w = waterHere(s);
  if (!w) return { ok: false, msg: 'There is no water here that you know of.' };
  if (s.c.thirst < 0.1) return { ok: false, msg: 'You are not thirsty.' };
  drink(s, Math.min(1.5, s.c.thirst), w.purity, 'from the water here');
  return { ok: true };
}

function doDrinkItem(s, cmd) {
  const f = find(s, cmd.id);
  if (!f || f.it.kind !== 'water') return { ok: false, msg: 'That is not water.' };
  if (s.c.thirst < 0.1) return { ok: false, msg: 'You are not thirsty.' };
  const n = Math.min(1.5, s.c.thirst, f.it.n);
  f.it.n -= n;
  if (f.it.n < 0.01) removeFrom(f.list, f.it);
  drink(s, n, f.it.q.purity, `${fmt(n)} L of carried water`);
  return { ok: true };
}

function doFill(s, cmd) {
  const w = waterHere(s);
  const f = find(s, cmd.id);
  if (!w) return { ok: false, msg: 'There is no water here.' };
  if (!f || !contSpec(f.it) || !contSpec(f.it).liquid) return { ok: false, msg: 'That will not hold water.' };
  const probe = mk(s, 'water', 0, { purity: w.purity });
  const n = Math.floor(roomFor(f.it, probe) * 10) / 10;
  if (n < 0.1) return { ok: false, msg: 'It is already full.' };
  probe.n = n;
  addTo((f.it.in = f.it.in || []), probe);
  advance(s, 5, 2.5, 'act');
  say(s, `You fill the ${kindOf(f.it).name} with ${fmt(n)} L of water.`);
  return { ok: true };
}

// ------------------------------------------------------------------ rest
function doRest(s, cmd) {
  advance(s, cmd.min || 60, 1.1, 'rest');
  say(s, `You rest for ${fmtTime(cmd.min || 60)}.`);
  return { ok: true };
}

function doSleep(s, forced = 0) {
  const t0 = s.t;
  let why = '';
  for (let i = 0; i < 30 && !s.dead; i++) {
    advance(s, 30, 0.95, 'sleep');
    if (forced ? s.t - t0 >= forced : s.c.fatigue <= 3 && s.t - t0 >= 60) break;
    if (s.c.chill > 85) { why = ' The cold wakes you, shivering hard.'; break; }
    if (s.c.thirst > 2.5) { why = ' Thirst wakes you.'; break; }
  }
  if (!s.dead) say(s, `You sleep for ${fmtTime(s.t - t0)}.${why}`);
  return { ok: true };
}

// ------------------------------------------------------------------ knowing the land
function doSurvey(s) {
  const l = loc(s);
  advance(s, 45, 2.8, 'act');
  l.surveys++;
  const found = [];
  for (const rid in l.res) {
    const r = l.res[rid];
    r.assessed = true;
    if (!r.known && (l.surveys >= 3 || rand(s.rng) < 0.4 + 0.5 * RESOURCES[rid].vis)) { r.known = true; found.push(RESOURCES[rid].name.toLowerCase()); }
  }
  say(s, found.length ? `Searching carefully, you find: ${found.join(', ')}.` : l.surveys >= 3 ? 'You are now sure you have seen everything this place offers.' : 'You search carefully and find nothing new.', found.length ? 'good' : '');
  return { ok: true };
}

export const trapsHere = (s) => loc(s).items.filter((it) => kindOf(it).trap && !it.proj);

function doCheckTraps(s) {
  const traps = trapsHere(s);
  if (!traps.length) return { ok: false, msg: 'You have no traps set here.' };
  advance(s, 10 + 3 * traps.length, 3, 'act');
  const got = [];
  let empty = 0, robbed = 0;
  for (const t of traps) {
    if (t.q.robbed) { robbed++; delete t.q.robbed; }
    if (t.in && t.in.length) { for (const c of t.in) { got.push(kindOf(c).name); addTo(loc(s).items, c); } t.in = []; } else empty++;
    t.q.sprung = 0;
  }
  say(s, `You check ${traps.length} trap${traps.length > 1 ? 's' : ''}: ${got.length ? got.join(', ') : 'nothing'}.${robbed ? ' Something got to a catch before you did.' : ''}`, got.length ? 'good' : '');
  return { ok: true };
}

// Exploration. Range out for some hours, look at N candidate spots, come back
// knowing the way to the best one. With targets, "best" is the mean prospect
// over the targets as judged from a distance (noisily); without, it is just
// somewhere new. More hours means more candidates and a wider radius. More
// targets dilutes the search: the best-on-average spot is rarely the best
// for any one thing.
function doExplore(s, cmd) {
  const hours = cmd.hours || 2, targets = (cmd.targets || []).filter((t) => RESOURCES[t]);
  const from = loc(s);
  const radius = 0.9 * hours, n = Math.round(5 * hours);
  const known = Object.values(s.locs);
  let pickLoc = null, pickScore = -Infinity, pickTrue = 0;
  for (let i = 0; i < n; i++) {
    const rr = 0.5 + (radius - 0.5) * Math.sqrt(rand(s.rng)), th = 2 * Math.PI * rand(s.rng);
    const cand = genLocation(s.seed, from.x + rr * Math.cos(th), from.y + rr * Math.sin(th));
    const noise = 0.08 * randn(s.rng), coin = rand(s.rng);
    if (known.some((k) => dist(k, cand) < 0.5)) continue;
    const truth = targets.length ? targets.reduce((a, t) => a + prospect(cand, t), 0) / targets.length : 1;
    const score = targets.length ? truth + noise : coin;
    if (score > pickScore) { pickScore = score; pickLoc = cand; pickTrue = truth; }
  }
  const dark = isDark(s);
  advance(s, hours * 60, 3.5, 'travel');
  rollRisks(s, [{ type: 'sprain', p: 0.015 * (1 - footwear(s)), sev: [10, 40] }], hours * (dark ? 3 : 1));
  const names = targets.map((t) => RESOURCES[t].name.toLowerCase());
  if (!pickLoc || (targets.length && pickTrue < 0.15)) {
    say(s, `You range up to ${fmt(radius)} km out and back${targets.length ? `, looking for ${names.join(', ')}, and find no promising sign` : ' and find nowhere worth noting'}.`);
    return { ok: true };
  }
  const found = addLocation(s, pickLoc, targets);
  const has = targets.filter((t) => found.res[t]).map((t) => RESOURCES[t].name.toLowerCase());
  const lacks = targets.filter((t) => !found.res[t]).map((t) => RESOURCES[t].name.toLowerCase());
  say(s, `You find a new place: ${found.name}, ${fmt(dist(from, found))} km to the ${bearing(from, found)}.` +
    (has.length ? ` It has ${has.join(', ')}.` : '') + (lacks.length ? ` No sign of ${lacks.join(', ')}.` : ''), 'good');
  return { ok: true, found: found.id };
}

export function travelInfo(s, toId) {
  const a = loc(s), b = s.locs[toId];
  const km = dist(a, b), mass = carriedMass(s);
  const speed = 4 * (1 - 0.35 * (a.roughness + b.roughness) / 2) * (1 - 0.45 * Math.min(1, mass / MAX_CARRY)) / (1 + condSev(s, 'sprain') / 40) / (isDark(s) ? 1.5 : 1) / impairment(s).slow;
  return { km, mass, minutes: (km / speed) * 60, met: 3.5 + 2 * Math.min(1, mass / MAX_CARRY), dir: bearing(a, b) };
}

function doTravel(s, cmd) {
  if (!s.locs[cmd.to] || cmd.to === s.at) return { ok: false, msg: 'You are already there.' };
  const info = travelInfo(s, cmd.to);
  if (info.mass > MAX_CARRY) return { ok: false, msg: `You cannot move ${fmt(info.mass)} kg. Leave something behind.` };
  const dark = isDark(s), hours = info.minutes / 60;
  advance(s, info.minutes, info.met, 'travel');
  for (const it of s.c.worn) if (kindOf(it).travelWear) it.q.integrity = Math.max(0, it.q.integrity - kindOf(it).travelWear * hours);
  s.at = cmd.to;
  rollRisks(s, [{ type: 'sprain', p: 0.02 * (1 - footwear(s)) * (1 + loc(s).roughness) * (1 + info.mass / MAX_CARRY), sev: [10, 45] }], hours * (dark ? 3 : 1));
  say(s, `You walk ${fmt(info.km)} km to ${loc(s).name} (${fmtTime(info.minutes)}).`);
  return { ok: true };
}

// ------------------------------------------------------------------ moving things
function doMove(s, cmd) {
  const f = find(s, cmd.id);
  if (!f) return { ok: false, msg: 'That is not within reach.' };
  const it = f.it, k = kindOf(it);
  if (k.fixed) return { ok: false, msg: 'That is built in place.' };
  const carriedNow = f.where !== 'here';
  const addMass = (n) => (carriedNow ? 0 : (massOf(it) * n) / it.n);
  let dest, n = it.n;
  if (cmd.to === 'ground') {
    if (k.liquid) return { ok: false, msg: 'It would just soak into the ground.' };
    dest = loc(s).items;
  } else if (cmd.to === 'hands') {
    if (k.liquid) return { ok: false, msg: 'You cannot carry water in your hands.' };
    if (f.list === s.c.hands) return { ok: false, msg: 'Already in hand.' };
    const free = 2 - handsUsed(s);
    if (k.hands === 2 ? free < 2 : free < 1) return { ok: false, msg: 'Your hands are full.' };
    // topping up a stack already in hand uses the slack in that hand first
    const same = s.c.hands.find((o) => o.kind === it.kind && o !== it);
    const slack = same && !k.cont && !k.slots ? handsFor(same) * k.hand - same.n : 0;
    n = k.hands === 2 ? it.n : Math.min(it.n, free * k.hand + Math.max(0, slack));
    if (k.unit === 'ea') n = Math.floor(n + 1e-9);
    dest = s.c.hands;
  } else if (cmd.to === 'trash') {
    if (k.liquid) return { ok: false, msg: 'Pour it out instead.' };
    if (f.where === 'trash') return { ok: false, msg: 'Already set aside.' };
    removeFrom(f.list, it);
    addTo(trashHere(s), it);
    return { ok: true };
  } else if (cmd.to === 'wear') {
    if (!k.worn) return { ok: false, msg: 'You cannot wear that.' };
    if (wornIn(s, k.worn.slot)) return { ok: false, msg: `You are already wearing something on your ${k.worn.slot}.` };
    dest = s.c.worn;
  } else {
    const t = find(s, cmd.to);
    if (!t) return { ok: false, msg: 'That container is not within reach.' };
    n = Math.min(it.n, roomFor(t.it, it));
    if (k.unit === 'ea') n = Math.floor(n + 1e-9);
    const why = whyNotHold(t.it, it, Math.max(n, k.unit === 'ea' ? 1 : 0.001));
    if (why) return { ok: false, msg: why[0].toUpperCase() + why.slice(1) + '.' };
    if (n <= 0) return { ok: false, msg: 'There is no room.' };
    dest = t.it.in = t.it.in || [];
    if (t.where === 'here') { removeFromAndAdd(s, f, it, n, dest); return { ok: true }; }
  }
  if (n <= 0) return { ok: false, msg: 'You cannot take any of it.' };
  if (dest !== loc(s).items && carriedMass(s) + addMass(n) > MAX_CARRY + 1e-6 && !(contSpec(it) && contSpec(it).drag))
    return { ok: false, msg: `That would be more than you can carry (${MAX_CARRY} kg).` };
  removeFromAndAdd(s, f, it, n, dest);
  return { ok: true };
}

function removeFromAndAdd(s, f, it, n, dest) {
  let piece = it;
  if (n < it.n - 1e-9) piece = split(s, it, n); else removeFrom(f.list, it);
  addTo(dest, piece);
}

// ------------------------------------------------------------------ dispatch
// ------------------------------------------------------------------ hands
// What you just collected or made ends up in your hand. Policy:
//  * what is left of something you were working from (a core you knapped,
//    fiber you twisted) is set down, freeing that hand;
//  * each new thing goes first into a container you hold or wear that fits
//    it, otherwise into one hand: topping up a like stack, taking a free hand,
//    or setting down the thing you have held longest;
//  * tools you just used are never set down, nor is something just picked up.
//  * Only one hand's worth is picked up; the rest stays on the ground.
function freeHandFor(s, it, keep) {
  const k = kindOf(it), want = k.hands === 2 ? 2 : 1;
  while (2 - handsUsed(s) < want) {
    const drop = s.c.hands.find((h) => !keep.includes(h));
    if (!drop) return false;
    removeFrom(s.c.hands, drop);
    addTo(loc(s).items, drop);
  }
  return true;
}

function pickUp(s, it, list, keep, handful = true, auto = false) {
  const k = kindOf(it);
  if (k.fixed || k.liquid || it.proc || it.proj) return null;
  // Picking up on your own: never trade a better piece in hand for a worse
  // one of the same kind; trade a worse one for a better.
  const rival = auto && tiersOf(it.kind) && s.c.hands.find((h) => h.kind === it.kind && !canMerge(h, it) && !keep.includes(h));
  if (rival) { if (tierRank(rival) >= tierRank(it)) return null; removeFrom(s.c.hands, rival); addTo(loc(s).items, rival); }
  const room = MAX_CARRY - carriedMass(s);
  for (const c of s.c.hands.concat(s.c.worn)) {
    if (!contSpec(c) || whyNotHold(c, it, k.unit === 'ea' ? 1 : 0.001)) continue;
    let n = Math.min(it.n, roomFor(c, it), (room / massOf(it)) * it.n);
    if (k.unit === 'ea') n = Math.floor(n + 1e-9);
    if (n <= 1e-6) continue;
    const piece = n < it.n - 1e-9 ? split(s, it, n) : (removeFrom(list, it), it);
    return addTo((c.in = c.in || []), piece);
  }
  const same = s.c.hands.find((h) => canMerge(h, it));
  let cap;
  if (same) cap = handsFor(same) * k.hand - same.n;
  if (!same || cap < (k.unit === 'ea' ? 1 : 1e-3)) {
    if (!freeHandFor(s, it, keep)) return null;
    cap = k.hands === 2 ? it.n : handful ? k.hand : (2 - handsUsed(s)) * k.hand;
  }
  let n = Math.min(it.n, cap, (room / Math.max(massOf(it), 1e-9)) * it.n);
  if (k.unit === 'ea') n = Math.floor(n + 1e-9);
  if (n <= 1e-6) return null;
  const piece = n < it.n - 1e-9 ? split(s, it, n) : (removeFrom(list, it), it);
  return addTo(s.c.hands, piece);
}

function settleHands(s) {
  const ground = loc(s).items;
  for (const p of s._partial) if (s.c.hands.includes(p) && p.n > 1e-6) { removeFrom(s.c.hands, p); addTo(ground, p); }
  const keep = s._used.filter((t) => s.c.hands.includes(t));
  for (const it of s._made) {
    if (!ground.includes(it)) continue;
    const held = pickUp(s, it, ground, keep, true, true);
    if (held) keep.push(held);
  }
}

// Tap something on the ground: one handful of it goes into a hand, setting
// down whatever you have held longest if both hands are full.
function doGrab(s, cmd) {
  const f = find(s, cmd.id);
  if (!f) return { ok: false, msg: 'That is not within reach.' };
  if (f.list === s.c.hands) return { ok: false, msg: 'Already in hand.' };
  if (kindOf(f.it).fixed) return { ok: false, msg: 'That is built in place.' };
  const got = pickUp(s, f.it, f.list, [], true);
  return got ? { ok: true } : { ok: false, msg: `Too heavy to carry with everything else (${MAX_CARRY} kg).` };
}

// Eat the most filling thing within reach that will not make you sick.
function bestFood(s) {
  let top = null, score = 0;
  for (const { it } of reach(s)) {
    const f = kindOf(it).food;
    if (!f || (it.q.tannin || 0) > 25 || (it.q.fresh != null && it.q.fresh < 25)) continue;
    const v = f.kcal * Math.min(it.n, f.portion) * (1 - 3 * f.risk) + (it.q.fresh != null ? (100 - it.q.fresh) : 0); // eat what will spoil first
    if (v > score) { score = v; top = it; }
  }
  return top;
}
export const bestFoodItem = bestFood;

const HANDLERS = {
  gather: doGather, recipe: doRecipe, work: doWork, replace: doReplace, dismantle: doDismantle, eat: doEat, drink: doDrink, drinkItem: doDrinkItem,
  fill: doFill, grab: doGrab, eatBest: (s) => { const it = bestFood(s); return it ? doEat(s, { id: it.id }) : { ok: false, msg: 'Nothing worth eating within reach.' }; }, rest: doRest, sleep: (s) => doSleep(s), survey: doSurvey, checkTraps: doCheckTraps, explore: doExplore, travel: doTravel, move: doMove,
};
const STRENUOUS = { gather: 1, recipe: 1, work: 1, survey: 1, checkTraps: 1, explore: 1, travel: 1, replace: 1 };

export function act(s, cmd) {
  if (s.dead) return { ok: false, msg: 'Your story has ended.' };
  const h = HANDLERS[cmd.t];
  if (!h) return { ok: false, msg: 'Unknown action.' };
  if (STRENUOUS[cmd.t] && s.c.fatigue >= 92 && !(cmd.t === 'recipe' && RECIPES[cmd.id] && RECIPES[cmd.id].met <= 2))
    return { ok: false, msg: 'You are too exhausted for that. Rest or sleep.' };
  s._made = []; s._used = []; s._partial = []; ids.s = s;
  const res = h(s, cmd);
  if (res.ok) settleHands(s);
  delete s._made; delete s._used; delete s._partial;
  if (res.ok && !s.dead && s.c.fatigue >= 100) {
    say(s, 'Your legs give way. You collapse where you stand and sleep.', 'bad');
    doSleep(s, 240);
  }
  return res;
}


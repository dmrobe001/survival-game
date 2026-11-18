// Upkeep: how many hours of each day go to staying alive at this place, and
// how much a project would cut that.
//
//   U = sleep + food + water + fire + repairs        (hours per day)
//
// Only the body's needs are demanded directly: energy, water, rest, warmth.
// Everything else (firewood for cooking, cordage for a snare, grass to
// re-thatch a roof) is derived demand and reaches U through prices: the
// hours it takes to make one more unit with what you have.
//
// The evaluator works on a *kit*: the capability providers you hold or that
// are at this place, optionally plus hypothetical items ("as if you had made
// a bark basin"). Comparing U with and without a project's products gives
// that project's saving. Nothing here changes game state or draws random
// numbers.
//
// Policies (see docs/DESIGN.md, "Upkeep"):
//  * Long-run rates. Each resource can give its regrowth per day at about
//    the abundance it settles to; demand beyond that is "beyond regrowth":
//    priced at depleted-patch rates and reported, because it will run out.
//  * One night-fire decision: sleep by a fire, or without one, whichever
//    makes the whole day cheaper. Cooking and boiling ride on the night fire
//    when there is one, and otherwise each costs its own burning time.
//  * Tools wear in proportion to the hours they are used, and structures rot
//    by the day; both are charged as the hours to replace what wears out.
//  * Every number marked (guess) is a judgment call, not a sourced value.

import { KINDS } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES } from './data/recipes.js';
import { capOf, contSpec, reach, here } from './items.js';
import { travelInfo } from './actions.js';
import { typical, sample, yieldsOf, outputsOf, kindsFor, unitsOf, makePlanner } from './plan.js';
import { WEATHER } from './sim.js';
import { clamp, fmt } from './util.js';

export const NEEDS = ['sleep', 'food', 'water', 'fire', 'repairs'];
export const SICK_HOURS = 10;   // hours lost to one bout of gut sickness (guess)
const HARM_HOURS = 1;           // hours charged per point of health lost to cold (guess)
const MET_AWAKE = 2.2;          // average metabolic rate while awake (1 = lying still)
const TIRE = 3.2;               // fatigue gained per waking hour at that pace
const FEED = 0.05 / 12;         // hours of feeding the fire per kg of wood
const COMMUTE = 1;              // hours a day to reach country you have not stripped (guess: ~2 km out and back)
const TRANCHES = [{ x: 0.85, f: 0.5, sus: true }, { x: 0.6, f: 0.5, sus: true }, { x: 0.85, f: Infinity, sus: false }];

// ------------------------------------------------------------------ climate (long-run weather)
let CLIMATE = null;
function climate() {
  if (CLIMATE) return CLIMATE;
  const { NEXT, DT } = WEATHER, ks = Object.keys(NEXT);
  let p = Object.fromEntries(ks.map((k) => [k, 1 / ks.length]));
  for (let i = 0; i < 300; i++) {
    const q = Object.fromEntries(ks.map((k) => [k, 0]));
    for (const k of ks) for (const n of NEXT[k]) q[n] += p[k] / NEXT[k].length;
    p = q;
  }
  const rain = p.rain + p.storm;
  return (CLIMATE = { p, rain, dT: ks.reduce((a, k) => a + p[k] * DT[k], 0), wetBurn: 1 - rain + 2 * p.rain + 4 * p.storm });
}

// ------------------------------------------------------------------ the kit
const ALLCAPS = [...new Set(Object.values(KINDS).flatMap((k) => Object.keys(k.caps || {})).concat(['vessel', 'leach', 'bag', 'fireproof']))]
  .filter((c) => c !== 'fire' && c !== 'embers');

function makeKit(s, extraKinds, baseItems) {
  const items = (baseItems || reach(s).map((r) => r.it).filter((it) => !it.proj)).slice();
  for (const k of extraKinds) items.push(typeof k === 'string' ? typical(k) : k); // a kind, or a sample piece
  const lv = {}, top = {};
  const scan = (cap) => {
    let v = 0, it = null;
    for (const x of items) { const c = capOf(x, cap); if (c > v) { v = c; it = x; } }
    lv[cap] = v; top[cap] = it;
  };
  return {
    items, extra: extraKinds,
    lvl: (cap) => { if (lv[cap] == null) scan(cap); return lv[cap]; },
    top: (cap) => { if (lv[cap] == null) scan(cap); return top[cap]; },
    has: (pred) => items.some(pred),
  };
}

// The best container in the kit that holds `kind` while you pick it.
function bagLevel(kit, kind) {
  let v = 0;
  for (const it of kit.items) { const c = contSpec(it); if (!c) continue; const b = capOf(it, 'bag'); if (b > v && KINDS[kind].grain >= c.mesh) v = b; }
  return v;
}

// Units per hour of collecting, at abundance fraction x.
function gatherRate(kit, rid, x) {
  const g = RESOURCES[rid].gather;
  if (!g || (g.tool && kit.lvl(g.tool.cap) < g.tool.min)) return 0;
  const boost = g.boost ? 1 + (g.boost.cap === 'bag' ? bagLevel(kit, g.kind) : kit.lvl(g.boost.cap)) / g.boost.per : 1;
  return g.rate * Math.sqrt(x) * boost;
}

// Hours of replacement work per hour of using a capability: the part that
// wears is priced, and its life is how long until it drops from new to 25.
function wearPerHour(kit, cap, price) {
  const tool = kit.top(cap);
  const spec = tool && (KINDS[tool.kind].wear || {})[cap];
  if (!spec) return 0;
  let h = 0;
  for (const slot in spec) {
    const part = slot === '_' ? tool : tool.parts && tool.parts[slot];
    if (!part) continue;
    const cost = (price[part.kind] ?? Infinity) * (slot === '_' ? 1 : part.n) + (slot === '_' ? 0 : 0.1);
    if (!isFinite(cost)) continue;
    for (const q in spec[slot]) {
      const fresh = KINDS[part.kind].q[q] ?? 100;
      h += cost / Math.max(0.5, (fresh - 25) / spec[slot][q]);
    }
  }
  return h;
}

// ------------------------------------------------------------------ recipes as flows
const needsFire = (r) => r.tools.some((t) => !t.opt && (t.cap === 'fire' || t.cap === 'boil'));
function recipeOk(r, kit, ctx) {
  for (const t of r.tools) {
    if (t.opt) continue;
    if (t.cap === 'fire') { if (!ctx.fire) return false; } else if (t.cap === 'boil') { if (!ctx.boil) return false; } else if (t.cap === 'embers') return false;
    else if (kit.lvl(t.cap) < t.min) return false;
  }
  if (r.res && !(ctx.L.res[r.res] && ctx.L.res[r.res].known)) return false;
  return true;
}
// A full batch: as much as the recipe takes at once.
function batch(r, kit) {
  const spec = r.scale && r.in.find((x) => x.id === r.scale);
  let k = 1;
  if (spec && spec.max) k = (spec.max * (spec.maxWith && kit.lvl(spec.maxWith.cap) > 0 ? spec.maxWith.mult : 1)) / (spec.kg ?? spec.n);
  return { k, hours: (r.time / 60) * (r.flat ? 1 : k) };
}
// Hands-on hours, and hours of burning fire, per unit of a recipe's main input.
function unitCost(rid, kit, ctx) {
  if (ctx.uc && rid in ctx.uc) return ctx.uc[rid];
  const r = RECIPES[rid];
  if (!r || !recipeOk(r, kit, ctx)) return ctx.uc ? (ctx.uc[rid] = null) : null;
  const b = batch(r, kit), spec = r.in.find((x) => x.id === 'x') || r.in[0];
  const units = unitsOf(spec, spec.kind || kindsFor(spec)[0]) * b.k;
  let h = b.hours;
  for (const t of r.tools) if (!t.opt && t.cap !== 'fire' && t.cap !== 'boil') h += b.hours * wearPerHour(kit, t.cap, ctx.price);
  const out = { h: h / units, fire: needsFire(r) ? b.hours / units : 0 };
  if (ctx.uc) ctx.uc[rid] = out;
  return out;
}

// Prices: hours per unit of every kind you can come by here, built from the
// ground up. Start from what can be collected here, then repeatedly let every
// recipe you could do offer its products at (time + wear + fire + inputs) /
// yield, keeping the cheapest offer, until nothing changes. This is Knuth's
// generalisation of Dijkstra's algorithm to AND/OR graphs, run in
// Bellman-Ford order. A recipe with several products charges its whole cost
// to each, so joint products (a butchered deer) are over-priced one by one.
function sweep(kit, ctx) {
  const price = {}, how = {};
  ctx.price = price;
  const set = (kind, p, h) => { if (p < (price[kind] ?? Infinity) - 1e-9) { price[kind] = p; how[kind] = h; return true; } return false; };
  for (const rid in ctx.L.res) {
    const r = ctx.L.res[rid], g = RESOURCES[rid].gather;
    if (!r.known || !g) continue;
    const rate = gatherRate(kit, rid, 0.85);
    if (rate > 0) set(g.kind, 1 / rate, 'g.' + rid);
  }
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const rid in RECIPES) {
      const r = RECIPES[rid];
      if (!recipeOk(r, kit, ctx)) continue;
      const ys = yieldsOf(rid);
      if (!ys.length) continue;
      const b = batch(r, kit);
      let cost = b.hours;
      for (const t of r.tools) if (!t.opt && t.cap !== 'fire' && t.cap !== 'boil') cost += b.hours * wearPerHour(kit, t.cap, price);
      if (needsFire(r)) cost += b.hours * ctx.fireHour;
      let ok = true;
      for (const spec of r.in) {
        if (spec.opt || spec.keep) continue;
        const k = r.scale === spec.id ? b.k : 1;
        let cheapest = Infinity;
        for (const kind of kindsFor(spec)) cheapest = Math.min(cheapest, (price[kind] ?? Infinity) * unitsOf(spec, kind) * k);
        if (!isFinite(cheapest)) { ok = false; break; }
        cost += cheapest;
      }
      if (!ok) continue;
      for (const y of ys) if (y.n > 0 && set(y.kind, cost / (y.n * b.k), 'r.' + rid)) changed = true;
    }
    if (!changed) break;
  }
  return { price, how };
}

// How much of a resource you can take per day, and at what abundance it
// settles. Regrowth is logistic, so the most it can give, at half its
// capacity, is about 1.06 x regen x capacity per day. The first half of that
// leaves the patch nearly full; the second half thins it. Anything more
// comes from further afield: country like this (the land varies smoothly),
// at the same rates, but a walk away, so it pays a daily commute and, for
// what must come back to camp, the trips to carry it.
function tranches(r, def) {
  const msy = def.regen > 0 && isFinite(r.cap) ? 1.06 * def.regen * r.cap : 0;
  if (!msy) return [{ x: clamp(r.amt / (r.cap || 1), 0.05, 1), n: Infinity, sus: !isFinite(r.cap) }];
  return TRANCHES.map((t) => ({ x: t.x, n: t.f * msy, sus: t.sus }));
}

// ------------------------------------------------------------------ food
// Ways to turn one unit of `kind` into food you can eat, each with the kcal
// it gives (v), the hands-on hours it takes (h, including the expected cost
// of being made sick), the hours a fire must burn for it, and the steps.
function foodRoutes(kind, kit, ctx, bitter, depth = 0) {
  const mk = kind + (bitter ? '!' : '');
  if (ctx.fr[mk]) return ctx.fr[mk];
  const k = KINDS[kind], out = [];
  if (depth > 5) return out;
  const via = (list, y, u, step) => { for (const o of list) out.push({ v: o.v * y, h: o.h * y + u.h, fire: o.fire * y + u.fire, how: step ? [step].concat(o.how) : o.how, kf: o.kf }); };
  if (k.food) {
    const f = k.food, sick = (f.risk + (bitter ? 0.5 : 0)) / f.portion;
    out.push({ v: f.kcal * (bitter ? 0.5 : 1), h: SICK_HOURS * sick, fire: 0, how: bitter ? ['eaten bitter'] : [], kf: kind });
  }
  let u;
  if (k.roast && (u = unitCost('roast_' + kind, kit, ctx))) via(foodRoutes(k.roast.to, kit, ctx, bitter, depth + 1), k.roast.y, u, kind.includes('meal') ? 'baked' : 'roasted');
  if (k.boil && (u = unitCost('boil_' + kind, kit, ctx))) via(foodRoutes(k.boil.to, kit, ctx, bitter, depth + 1), k.boil.y, u, 'boiled');
  if (k.crush && kit.lvl(k.crush.cap) >= k.crush.min && (u = unitCost('crush_' + kind, kit, ctx))) {
    const tannin = (k.crush.q && k.crush.q.tannin) ?? KINDS[k.crush.to].q.tannin ?? 0;
    via(foodRoutes(k.crush.to, kit, ctx, tannin > 25, depth + 1), k.crush.y, u, k.crush.cap === 'grind' ? 'ground' : 'shelled and pounded');
  }
  if (k.soak && bitter && (u = unitCost('soak_' + kind, kit, ctx))) via(foodRoutes(kind, kit, ctx, false, depth + 1), 1, u, 'leached');
  if (k.dry && !bitter && (u = unitCost('dry_' + kind, kit, ctx))) via(foodRoutes(k.dry.to, kit, ctx, false, depth + 1), k.dry.y, u, 'dried');
  if (k.butcher && kit.lvl('cut') >= k.butcher.cut) {
    // A carcass is a lump: what you cannot eat before it spoils is lost,
    // unless it is dried or kept cool.
    const cool = kit.has((it) => { const c = contSpec(it); return c && c.cool; });
    let v = 0, h = (k.butcher.time / 60) * (1 + wearPerHour(kit, 'cut', ctx.price)), fire = 0;
    const how = [];
    for (const [o, n] of k.butcher.out) {
      if (!KINDS[o].food) continue;
      const b = pick(foodRoutes(o, kit, ctx, false, depth + 1), 0, ctx.c);
      if (!b) continue;
      const rot = ((KINDS[b.kf] && KINDS[b.kf].decay) || {}).fresh || 1;
      const shelf = (75 / rot) * (cool ? 2.5 : 1); // days until it is no longer safe
      const use = Math.min(1, (ctx.E * shelf) / (n * b.v));
      v += n * b.v * use; h += n * b.h * use; fire += n * b.fire * use;
      if (KINDS[o].food.kcal > 800) how.push(...b.how.filter((x) => !how.includes(x)));
      if (use < 0.95 && o !== 'fat') how.push(`${Math.round((1 - use) * 100)}% spoils`);
    }
    if (v > 0) out.push({ v, h, fire, how: ['butchered'].concat(how), kf: null });
  }
  return (ctx.fr[mk] = out);
}
const pick = (routes, unitH, c) => {
  let top = null, score = Infinity;
  for (const o of routes) { if (o.v <= 0) continue; const sc = (unitH + o.h + o.fire * c) / o.v; if (sc < score) { score = sc; top = o; } }
  return top;
};
const bitterOf = (kind) => (KINDS[kind].q.tannin || 0) > 25;

// Ways of taking food from one resource here: hours per unit taken at
// abundance x, and what one unit becomes.
function foodMethods(kit, ctx, rid) {
  const def = RESOURCES[rid], g = def.gather, out = [], P = ctx.price;
  if (g) {
    const k = KINDS[g.kind];
    if (k.food || k.crush || k.roast || k.butcher) {
      const wear = (g.tool ? wearPerHour(kit, g.tool.cap, P) : 0) + (g.boost && g.boost.cap !== 'bag' && kit.lvl(g.boost.cap) > 0 ? wearPerHour(kit, g.boost.cap, P) : 0);
      out.push({ name: 'collect', kinds: [[g.kind, 1]], unitH: (x) => { const r = gatherRate(kit, rid, x); return r > 0 ? (1 + wear) / r : Infinity; } });
    }
  }
  const has = (kind) => kit.has((it) => it.kind === kind);
  if (rid === 'fish') {
    const fs = kit.lvl('fishspear');
    if (fs >= 15) out.push({ name: 'spear', kinds: [['fish', 1]], unitH: (x) => (1 + wearPerHour(kit, 'fishspear', P)) / Math.max(1e-6, (1.3 * x * fs) / 55) });
    if (kit.lvl('line') >= 20 && isFinite(P.grubs ?? P.meat ?? Infinity))
      out.push({ name: 'hook and line', kinds: [['fish', 1]], unitH: (x) => (1.5 * (1 + wearPerHour(kit, 'line', P)) + 0.02 * (P.grubs ?? P.meat)) / Math.max(1e-6, 1.1 * x) });
    if (has('fish_weir')) out.push({ name: 'weir', kinds: [['fish', 1]], cap: 1.68, unitH: (x) => 0.05 / Math.max(1e-6, 1.68 * x) });
    const traps = kit.items.filter((it) => it.kind === 'fish_trap' || it.kind === 'fish_trap_set').length;
    if (traps) out.push({ name: 'fish trap', kinds: [['fish', 1]], unitH: (x) => 0.06 / Math.max(1e-6, 0.72 * x) });
  }
  if (rid === 'small_game') {
    const hu = kit.lvl('hunt');
    if (hu >= 10) out.push({ name: 'hunting', kinds: [['rabbit', 0.7], ['grouse', 0.3]], unitH: (x) => 3 / clamp((0.1 + 0.5 * x) * Math.min(1.2, hu / 45), 0.01, 0.85) });
    // A set snare catches about 0.008 an hour at full abundance; a quarter
    // pull free and a tenth are taken by scavengers before you check.
    const snare = Math.min(P.snare ?? Infinity, has('snare') || has('set_snare') ? 0.2 : Infinity);
    if (isFinite(snare)) out.push({ name: 'snares', kinds: [['rabbit', 0.75], ['grouse', 0.25]], unitH: (x) => (0.06 + (snare + 0.25) / 60) / Math.max(1e-6, 0.008 * 24 * x * 0.7) });
    else if (kit.lvl('cut') >= 10 && isFinite(P.slab ?? Infinity)) out.push({ name: 'deadfalls', kinds: [['rabbit', 0.5], ['grouse', 0.5]], unitH: (x) => (0.06 + (P.slab + 0.5) / 90) / Math.max(1e-6, 0.005 * 24 * x * 0.9) });
  }
  if (rid === 'large_game') {
    const hu = kit.lvl('hunt');
    if (hu >= 40) out.push({ name: 'hunting', kinds: [['deer', 1]], unitH: (x) => (5 * (1 + wearPerHour(kit, 'hunt', P))) / clamp((0.35 * (0.3 + 0.7 * x) * hu) / 70, 0.01, 0.6) });
  }
  return out;
}

// Cheapest food first, until the day's calories are covered. Food from
// further afield is eaten where it is found, so it costs only the walk.
function foodSupply(kit, ctx, E) {
  const offers = [];
  for (const rid in ctx.L.res) {
    const r = ctx.L.res[rid];
    if (!r.known) continue;
    const ms = foodMethods(kit, ctx, rid);
    if (!ms.length) continue;
    for (const t of tranches(r, RESOURCES[rid])) {
      let top = null;
      for (const m of ms) {
        const unitH = m.unitH(t.x);
        if (!isFinite(unitH)) continue;
        let v = 0, h = 0, fire = 0, how = null;
        for (const [kind, w] of m.kinds) {
          const b = pick(foodRoutes(kind, kit, ctx, bitterOf(kind)), unitH, ctx.c);
          if (!b) { v = 0; break; }
          v += w * b.v; h += w * b.h; fire += w * b.fire; how = how || b.how;
        }
        if (v <= 0) continue;
        const sel = (unitH + h + fire * ctx.c) / v;
        if (!top || sel < top.sel) top = { rid, method: m.name, sel, lab: (unitH + h) / v, fire: fire / v, n: t.n * v, sus: t.sus, how };
      }
      if (top) offers.push(top);
    }
  }
  offers.sort((a, b) => a.sel - b.sel);
  // Either live off what regrows here, or walk out each day and take the
  // cheapest food wherever it is: whichever costs less.
  const home = fillFood(offers.filter((o) => o.sus), E, ctx.c), away = fillFood(offers, E, ctx.c);
  return home.cost <= away.cost ? home : away;
}
function fillFood(offers, E, c) {
  let left = E, hours = 0, fire = 0, short = 0;
  const mix = [];
  for (const o of offers) {
    if (left <= 1e-6) break;
    const take = Math.min(left, o.n);
    left -= take; hours += take * o.lab; fire += take * o.fire;
    if (!o.sus) { if (!short) hours += COMMUTE; short += take; }
    const prev = mix.find((m) => m.rid === o.rid && m.method === o.method && m.sus === o.sus);
    if (prev) { prev.kcal += take; prev.hours += take * o.lab; } else mix.push({ rid: o.rid, method: o.method, how: o.how, kcal: take, hours: take * o.lab, sus: o.sus });
  }
  if (left > 1e-6) hours = Infinity;
  return { hours, fire, short, mix, unmet: left > 1e-6 ? left : 0, cost: hours + fire * c };
}

// ------------------------------------------------------------------ fire
// Units of `kind` you can carry in one trip: both hands, plus the best
// container that holds it (a dragged one counts for part of its weight).
function carryUnits(kit, kind) {
  const k = KINDS[kind];
  let cont = 0, drag = 1;
  for (const it of kit.items) {
    const c = contSpec(it);
    if (!c || c.liquid || KINDS[it.kind].fixed || k.grain < c.mesh) continue;
    const u = c.vol / k.vol;
    if (u > cont) { cont = u; drag = c.drag || 1; }
  }
  return Math.max(1e-6, Math.min(35 / (k.mass * drag), (k.hands === 2 ? 1 : 2 * k.hand) + cont));
}
// Fire-hours of fuel per unit of wood, and the work of gathering it. Wood
// from further afield also costs the trips to carry it home.
function fuelOffers(kit, ctx) {
  const out = [];
  for (const rid of ['deadwood', 'twigs']) {
    const r = ctx.L.res[rid];
    if (!r || !r.known) continue;
    const kind = RESOURCES[rid].gather.kind, k = KINDS[kind], fh = k.mass * k.fuel * (0.5 + (r.q.dryness ?? 60) / 200);
    const haul = COMMUTE / carryUnits(kit, kind);
    for (const t of tranches(r, RESOURCES[rid])) {
      const rate = gatherRate(kit, rid, t.x);
      if (rate > 0) out.push({ rid, n: t.n * fh, hp: (1 / rate + FEED + (t.sus ? 0 : haul)) / fh, sus: t.sus });
    }
  }
  return out.sort((a, b) => a.hp - b.hp);
}
function fuelFor(offers, fh) {
  let left = fh, hours = 0, short = 0;
  for (const o of offers) { if (left <= 1e-6) break; const take = Math.min(left, o.n); left -= take; hours += take * o.hp; if (!o.sus) short += take; }
  return { hours: left > 1e-6 ? Infinity : hours, short };
}
// Expected work to light one fire by friction: failed attempts keep the
// tinder but wear the spindle and board.
function lightCost(kit, ctx) {
  const lv = Math.min(kit.lvl('spindle'), kit.lvl('fireboard')), cl = climate();
  const wet = kit.lvl('roof') >= 40 ? 1 : 1 - 0.6 * cl.rain;
  const p = clamp(0.1 + 0.0095 * lv, 0.05, 0.95) * 0.7 * wet;
  const attempt = (20 / 60) * (1 + wearPerHour(kit, 'spindle', ctx.price) + wearPerHour(kit, 'fireboard', ctx.price));
  return attempt / p + (ctx.price.tinder ?? 0) + 0.5 * (ctx.price.kindling ?? 0);
}

// ------------------------------------------------------------------ sleep and warmth
function wornWarmth(kit) {
  const slot = {};
  let rain = false;
  for (const it of kit.items) {
    const w = KINDS[it.kind].worn;
    if (!w) continue;
    slot[w.slot] = Math.max(slot[w.slot] || 0, (w.warm || 0) * Math.min(1, (it.q.integrity ?? 100) / 50));
    if (w.rain) rain = true;
  }
  return { warm: Object.values(slot).reduce((a, b) => a + b, 0), rain };
}
// A night from 22:00, hour by hour, with the same felt-temperature and
// chill rules as the simulation, once for each kind of weather and averaged
// by how often that weather comes. Chill past 85 wakes you for good, so a
// night that gets that cold gives only the sleep before it; chill past 70
// costs health.
function night(s, kit, fire, hours) {
  const e = here(s).env, cl = climate(), bed = kit.lvl('bed'), shelter = kit.lvl('shelter'), roof = kit.lvl('roof') >= 40;
  const w = wornWarmth(kit), n = Math.max(1, Math.round(hours));
  let q = 0, cold = 0, harm = 0, woke = 0;
  for (const wk in cl.p) {
    const pw = cl.p[wk], wet = wk === 'rain' || wk === 'storm';
    let chill = 0, pen = 0, slept = n, c30 = 0, dmg = 0;
    for (let i = 0; i < n; i++) {
      const h = (22 + i + 0.5) % 24;
      const air = 17 - 9 * e.elev + 6 * Math.cos((2 * Math.PI * (h - 15)) / 24) + WEATHER.DT[wk];
      let T = air - 0.125 + w.warm + (shelter / 100) * 7 + (fire ? 9 : 0) + (bed / 100) * 6 - 3;
      if (wet && !roof && !w.rain) T -= 5;
      chill = T < 12 ? Math.min(100, chill + (12 - T) * 0.9) : Math.max(0, chill - ((T - 12) * 2 + 2));
      if (chill > 30) c30++;
      if (chill > 40) pen += 0.2;
      if (chill > 70) dmg += (chill - 70) * 0.12;
      if (chill > 85 && slept === n) slept = i + 1;
    }
    const qn = clamp(0.45 + (0.2 * bed) / 100 + (0.25 * shelter) / 100 - (wet && !roof ? 0.15 : 0) - pen / n, 0.15, 1) * (slept / n);
    q += pw * qn; cold += pw * c30; harm += pw * dmg; woke += pw * (slept < n ? 1 : 0);
  }
  return { q: Math.max(0.05, q), cold: Math.round(cold), harm, woke };
}
// Hours of sleep a day: waking hours build fatigue at TIRE per hour, and
// sleep clears 12 x quality per hour, so S = 24 TIRE / (12 q + TIRE).
function sleepNeed(s, kit, fire) {
  let S = 8, r;
  for (let i = 0; i < 3; i++) { r = night(s, kit, fire, S); S = clamp((24 * TIRE) / (12 * r.q + TIRE), 4, 14); }
  return Object.assign(r, { S });
}

// ------------------------------------------------------------------ water
function waterNeed(s, kit, ctx, W) {
  const L = ctx.L, r = L.res.water, drink = (W / 1.5) * 0.05;
  const opts = [];
  if (r && r.known) {
    const pur = Math.max(r.q.purity, kit.lvl('well'));
    const sick = (W / 1.5) * Math.pow((100 - pur) / 100, 2) * 0.25;
    opts.push({ h: drink + sick * SICK_HOURS, fire: 0, how: `drunk as it is, purity ${Math.round(pur)}${kit.lvl('well') > r.q.purity ? ' (well)' : ''}` });
    if (ctx.boil) {
      const V = Math.max(0.5, kit.lvl('vessel'));
      opts.push({ h: drink + W * (25 / 60 / V), fire: (W * (20 / 60)) / V, how: `boiled ${fmt(V)} L at a time` });
    }
  } else {
    let m = Infinity, to = null;
    for (const id in s.locs) if (id !== s.at && s.locs[id].res.water && s.locs[id].res.water.known) { const t = travelInfo(s, id).minutes; if (t < m) { m = t; to = id; } }
    if (to) { const V = kit.lvl('vessel'); opts.push({ h: (W / (1.5 + V)) * ((2 * m) / 60) + drink, fire: 0, how: `walked to ${s.locs[to].name.toLowerCase()}${V >= 0.5 ? `, carrying ${fmt(V)} L back` : ''}` }); }
  }
  if (!opts.length) return { h: Infinity, fire: 0, how: 'no water known' };
  return opts.reduce((a, b) => (a.h + a.fire * ctx.c <= b.h + b.fire * ctx.c ? a : b));
}

// ------------------------------------------------------------------ repairs
// Things that rot by the day: a structure's cover, a basket, bedding. Each
// part lasts until it is half gone (where it starts to fail), and then costs
// its material plus a little work to refit.
function repairs(kit, price) {
  const tops = new Set();
  for (const cap of ALLCAPS) { const t = kit.top(cap); if (t && kit.lvl(cap) > 0) tops.add(t); }
  const best = {};
  for (const it of kit.items) { const w = KINDS[it.kind].worn; if (w && w.warm && (!best[w.slot] || w.warm > KINDS[best[w.slot].kind].worn.warm)) best[w.slot] = it; }
  Object.values(best).forEach((it) => tops.add(it));
  let h = 0;
  const list = [];
  for (const it of tops) {
    const k = KINDS[it.kind];
    if (k.trap) continue;
    let d = 0;
    if (k.slots && it.parts) {
      for (const sl in it.parts) {
        const p = it.parts[sl], rate = (((KINDS[p.kind].decay || {}).integrity) || 0) + ((((k.partDecay || {})[sl]) || {}).integrity || 0);
        const cost = (price[p.kind] ?? Infinity) * p.n + (k.fixed ? 0.5 : 0.25);
        if (rate > 0 && isFinite(cost)) d += cost / (50 / rate);
      }
    } else if (k.decay && k.decay.integrity && isFinite(price[it.kind] ?? Infinity)) d += price[it.kind] / (50 / k.decay.integrity);
    if (d > 1e-4) { h += d; list.push({ kind: it.kind, h: d }); }
  }
  return { h, list: list.sort((a, b) => b.h - a.h) };
}

// ------------------------------------------------------------------ upkeep
export function upkeep(s, extraKinds = [], baseItems = null) {
  const kit = makeKit(s, extraKinds, baseItems), cl = climate(), L = here(s);
  const ctx = { L, fire: false, boil: false, fireHour: 0, c: 0, E: 3000, price: {} };
  let sw = sweep(kit, ctx);
  const fuel = fuelOffers(kit, ctx);
  const burn = (kit.lvl('hearth') > 0 ? 0.7 : 1) * (kit.lvl('roof') >= 40 ? 1 : cl.wetBurn); // fuel-hours burned per hour of fire
  const canLight = kit.lvl('spindle') >= 20 && kit.lvl('fireboard') >= 20 && isFinite(sw.price.tinder ?? Infinity) && isFinite(sw.price.kindling ?? Infinity);
  const lit = kit.has((it) => it.kind === 'fire' || it.kind === 'embers');
  const mode = canLight ? 'light' : lit ? 'keep' : null;
  if (mode && fuel.length) {
    ctx.fire = true; ctx.fireHour = fuel[0].hp * burn;
    const stones = kit.has((it) => it.kind === 'cobble' && it.n >= 3) || isFinite(sw.price.cobble ?? Infinity);
    ctx.boil = kit.lvl('vessel') >= 0.5 && (kit.lvl('fireproof') > 0 || stones);
    sw = sweep(kit, ctx);
  }
  const lightH = mode === 'light' && ctx.fire ? lightCost(kit, ctx) : 0;
  const rep = repairs(kit, sw.price);
  let best = null;
  for (const nightFire of ctx.fire ? [false, true] : [false]) {
    const sl = sleepNeed(s, kit, nightFire);
    const awake = 24 - sl.S;
    ctx.E = 70 * (0.95 * sl.S + MET_AWAKE * awake + 0.4 * sl.cold);
    const W = 0.1 * sl.S + (0.1 + 0.12 * (MET_AWAKE - 1)) * awake;
    ctx.c = nightFire ? 0 : ctx.fireHour;
    ctx.uc = {}; ctx.fr = {};
    const food = foodSupply(kit, ctx, ctx.E);
    const water = waterNeed(s, kit, ctx, W);
    let F = nightFire ? sl.S : food.fire + water.fire;
    if (mode === 'keep' && ctx.fire) F = 24; // nothing to relight it with: never let it die
    const f = F > 0 ? fuelFor(fuel, F * burn) : { hours: 0, short: 0 };
    const fireH = F > 0 ? f.hours + lightH * (mode === 'light' ? 1 : 0) : 0;
    const parts = { sleep: sl.S + HARM_HOURS * sl.harm, food: food.hours, water: water.h, fire: fireH, repairs: rep.h };
    const U = NEEDS.reduce((a, k) => a + parts[k], 0);
    if (!best || U < best.U) best = { U, parts, nightFire, sleep: sl, E: ctx.E, W, food, water, fire: { F, mode, burn, short: f.short, light: lightH }, repairs: rep, price: sw.price };
  }
  return best;
}

// ------------------------------------------------------------------ projects
const labor = (n) => n.steps.reduce((a, st) => a + st.minutes, 0);
const waitOf = (n) => n.steps.reduce((a, st) => a + (st.wait || 0), 0);
const useful = (kind) => { const k = KINDS[kind]; return !!(k.caps || k.cont || k.worn || k.trap); };

// What you would hold after doing a project once by its planned route:
// everything with a use that its steps make or collect, minus what a later
// step uses up (the hand axe that becomes an axe head). Something collected
// both as a tool and as material (cobbles as hammerstone and as hearth ring)
// leaves a tool over. Collected things are as good as the deposit they come
// from (soft cobbles make a poor hammer); made things are typical.
function gainedKinds(s, P, n) {
  const made = [], picked = {}, recipes = n.steps.filter((st) => st.key[0] === 'r').map((st) => RECIPES[st.key.slice(2)]);
  for (const st of n.steps) {
    let kinds = [], q = null;
    if (st.key[0] === 'r') kinds = outputsOf(st.key.slice(2));
    else if (st.key[0] === 'g') {
      const rid = st.key.slice(2).split('@')[0], g = RESOURCES[rid].gather;
      if (g) {
        const w = P.node(st.key).w, r = w.mode === 'here' ? here(s).res[rid] : w.mode === 'goto' ? s.locs[w.to].res[rid] : null;
        kinds = [g.kind]; q = r ? r.q : null;
        if (!(g.kind in picked) || q) picked[g.kind] = q;
      }
    }
    for (const k of kinds) if (useful(k) && !made.includes(k)) made.push(k);
  }
  const piece = (k) => (k in picked ? sample(k, picked[k]) : typical(k));
  const asTool = (k) => k in picked && recipes.some((r) => r.tools.some((t) => !t.opt && capOf(piece(k), t.cap) >= t.min));
  const used = new Set();
  for (const r of recipes) {
    for (const spec of r.in) if (!spec.keep && !spec.opt) for (const k of kindsFor(spec)) if (made.includes(k) && !asTool(k) && !outputsOf(r.id).includes(k)) used.add(k);
  }
  const kinds = made.filter((k) => !used.has(k) && k !== 'project');
  return { kinds, items: kinds.map(piece), sig: kinds.map((k) => k + (picked[k] ? JSON.stringify(picked[k]) : '')).sort().join(',') };
}
function capsOfItems(items) {
  const out = {};
  for (const it of items) for (const cap of ALLCAPS.concat(['fire'])) { const v = capOf(it, cap); if (v > (out[cap] || 0)) out[cap] = v; }
  return out;
}
const subset = (a, b) => a.every((x) => b.includes(x));
const diff = (a, b) => (isFinite(a) ? (isFinite(b) ? a - b : -Infinity) : isFinite(b) ? Infinity : 0);

// Every technique, as a project: needs (hours of work to do it once, by its
// planned route, from where you stand), saves (hours of upkeep a day it would
// take off, with what its route leaves you holding), and horizon (days until
// it has paid for itself, counting any shortening of your goals). Projects
// that change nothing are left out, as is any project that only repeats a
// quicker one's gains with extra steps. Keys in `include` are always kept
// (the project you picked, even if it saves nothing).
export function projectRows(s, P, include = []) {
  const L = here(s);
  const baseItems = reach(s).map((r) => r.it).filter((it) => !it.proj);
  const base = upkeep(s, [], baseItems);
  const goals = Object.keys(s.goals || {}).filter((g) => P.has(g));
  const goalH = (pl) => goals.map((g) => { const n = pl.node(g); return isFinite(n.total) ? labor(n) / 60 : Infinity; });
  const g0 = goalH(P);
  const cache = new Map(), rows = [];
  const keys = Object.keys(RECIPES).map((r) => 'r.' + r)
    .concat(Object.keys(RESOURCES).filter((r) => RESOURCES[r].gather && useful(RESOURCES[r].gather.kind)).map((r) => 'g.' + r));
  for (const key of keys) {
    const rid = key.slice(2), n = P.node(key);
    const prog = key[0] === 'r' && L.items.find((it) => it.proj && it.proj.rid === rid);
    const goal = !!(s.goals && s.goals[key]);
    if (!prog && (!isFinite(n.total) || n.unknown || n.passive)) continue;
    const gi = gainedKinds(s, P, n), gained = gi.kinds;
    let ev = cache.get(gi.sig);
    if (!ev) {
      const u = gained.length ? upkeep(s, gi.items, baseItems) : base;
      let oneoff = 0;
      if (goals.length && gained.length) {
        const P2 = makePlanner(s, capsOfItems(gi.items));
        goalH(P2).forEach((h, i) => { if (isFinite(g0[i]) && isFinite(h)) oneoff += Math.max(0, g0[i] - h); });
      }
      const by = {};
      for (const k of NEEDS) by[k] = diff(base.parts[k], u.parts[k]);
      ev = { u, oneoff, by, saves: diff(base.U, u.U) };
      cache.set(gi.sig, ev);
    }
    const needs = prog ? prog.proj.left : labor(n);
    const nh = needs / 60;
    const horizon = ev.saves > 1e-6 ? Math.max(0, (nh - ev.oneoff) / ev.saves) : ev.oneoff >= nh - 1e-9 && ev.oneoff > 0 ? 0 : Infinity;
    rows.push({ key, rid, name: n.name, node: n, prog, goal, ready: n.ready || !!prog, needs, wait: prog ? 0 : waitOf(n), saves: ev.saves, by: ev.by, oneoff: ev.oneoff, horizon, gained, after: ev.u });
  }
  const EPS = 0.05;
  const pinned = (r) => r.goal || r.prog || include.includes(r.key);
  let keep = rows.filter((r) => pinned(r) || r.saves > EPS || r.oneoff > EPS);
  const beats = (b, a) => b.needs <= a.needs + 1e-9 && subset(b.gained, a.gained) && a.saves <= b.saves + EPS && a.oneoff <= b.oneoff + EPS
    && (b.needs < a.needs - 1e-9 || !subset(a.gained, b.gained) || b.key < a.key);
  keep = keep.filter((a) => pinned(a) || !keep.some((b) => b !== a && beats(b, a)));
  return { base, rows: keep };
}

export const SORTS = {
  horizon: (a, b) => a.horizon - b.horizon || b.saves - a.saves || a.needs - b.needs,
  needs: (a, b) => a.needs - b.needs || a.horizon - b.horizon,
  saves: (a, b) => b.saves - a.saves || a.needs - b.needs,
};

// The one or two needs a project helps (or costs) most, in words.
export function tagsOf(row) {
  return NEEDS.filter((k) => Math.abs(row.by[k]) >= 0.05).sort((a, b) => Math.abs(row.by[b]) - Math.abs(row.by[a])).slice(0, 2)
    .map((k) => `${k} ${row.by[k] > 0 ? '−' : '+'}${isFinite(row.by[k]) ? fmt(Math.abs(row.by[k])) : '∞'}`);
}

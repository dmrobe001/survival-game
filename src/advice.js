// Advice for the main screen: which projects matter for the one you picked,
// which tasks to do next, and which of your reserves runs out first.
// Like plan.js, this only reads state.
//
// Three measures:
//  * saving(P | goal): minutes of the goal's planned route that P's own route
//    covers. Exact under the plan; blind to shortcuts the plan did not take.
//  * flow gain: for repeating needs (eating, sleeping, drinking, keeping a
//    fire), the rate you could sustain now versus with what P makes, holding
//    everything else fixed.
//  * time to empty: each reserve divided by its drain rate at the
//    metabolic intensity of the task at the top of the list.

import { KINDS } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES } from './data/recipes.js';
import { kindOf, here, reach, contSpec } from './items.js';
import { capInfo, gatherStatus, waterHere, bestFoodItem, travelInfo, trapsHere, bagFor } from './actions.js';
import { feltTemp, sleepQuality, raining, LIMITS, thirstRate } from './sim.js';
import { capsFromRecipe, outputsOf } from './plan.js';
import { clamp, fmt, fmtTime } from './util.js';

// ------------------------------------------------------------------ repeating needs
export const REPEAT = {
  'x.eat': { name: 'Eat', flow: 'food', unit: 'kcal/h' },
  'x.drink': { name: 'Drink', flow: 'water', unit: '' },
  'x.sleep': { name: 'Sleep', flow: 'sleep', unit: '' },
  'r.add_fuel': { name: 'Feed the fire', flow: 'fuel', unit: '' },
};


// Calories per hour of the best way you have of getting food here, given
// capability levels lvl(cap). Counts gathering, small-game hunting and fish
// spearing; processing (roasting, pounding, leaching) raises the value of
// what is gathered when you have what it takes.
// Ways to turn one unit of a gathered kind into food, each with kcal per
// unit and hands-on hours per unit (shelling, pounding, baking). Waiting
// that needs no attention, like leaching overnight, costs nothing here.
function recipeHours(rid, perUnitOf) {
  const r = RECIPES[rid];
  if (!r) return 0;
  const spec = r.in.find((x) => x.id === 'x');
  return r.time / 60 / (r.flat ? spec.max : spec.n) * (perUnitOf || 1);
}
function foodRoutes(kind, lvl) {
  const k = KINDS[kind], out = [];
  if (k.food) out.push({ v: k.food.kcal * (1 - 2 * k.food.risk), h: 0, how: 'raw' });
  if (k.roast && lvl('fire') >= 1) out.push({ v: KINDS[k.roast.to].food.kcal * k.roast.y, h: recipeHours('roast_' + kind), how: 'roasted' });
  if (k.crush && lvl(k.crush.cap) >= k.crush.min) {
    const o = KINDS[k.crush.to], y = k.crush.y;
    const bitter = o.q.tannin > 25, leached = bitter && lvl('leach') >= 1;
    const keep = bitter && !leached ? 0.35 : 1; // bitter food: half the energy, and it often makes you sick
    const h = recipeHours('crush_' + kind) + (leached ? recipeHours('soak_' + k.crush.to, y) : 0);
    const steps = [k.crush.cap === 'grind' ? 'ground' : 'shelled and pounded'].concat(leached ? ['leached'] : bitter ? ['eaten bitter'] : []);
    out.push({ v: o.food.kcal * y * keep, h, how: steps.join(', ') });
    if (o.roast && lvl('fire') >= 1) out.push({ v: KINDS[o.roast.to].food.kcal * o.roast.y * y * keep, h: h + recipeHours('roast_' + k.crush.to, y), how: steps.concat(['baked']).join(', ') });
  }
  return out;
}

// Bag level for picking `kind`: a container you have that holds it, or one
// that recipe `rid` would make.
function bagLevel(s, kind, rid) {
  let v = bagFor(s, kind).level;
  for (const out of rid ? outputsOf(rid) : []) {
    const k = KINDS[out], c = k.cont;
    if (!c || k.fixed || c.liquid || (c.mesh || 0) > 1 || KINDS[kind].grain < (c.mesh || 0)) continue;
    v = Math.max(v, Math.min(typeof c.vol === 'function' ? 4 : c.vol, 30));
  }
  return v;
}

// Calories per hour of work, collecting and processing, from one resource here.
function resourceFood(s, rid, lvl, viaRecipe) {
  const r = here(s).res[rid], g = RESOURCES[rid].gather;
  if (!r || !r.known || !g || !(KINDS[g.kind].food || KINDS[g.kind].crush)) return null;
  if (g.tool && lvl(g.tool.cap) < g.tool.min) return null;
  const bag = g.boost && g.boost.cap === 'bag' ? bagLevel(s, g.kind, viaRecipe) : 0;
  const boost = g.boost ? (g.boost.cap === 'bag' ? bag : lvl(g.boost.cap)) : 0;
  const rate = g.rate * Math.sqrt(clamp(r.amt / r.cap, 0, 1)) * (g.boost ? 1 + boost / g.boost.per : 1);
  let top = null;
  for (const o of foodRoutes(g.kind, lvl)) {
    const v = o.v / (1 / Math.max(rate, 1e-6) + o.h);
    if (!top || v > top.v) top = { v, how: `${KINDS[g.kind].name}, ${o.how}${bag > 0 ? ', picked into a container' : ''}` };
  }
  return top;
}

function foodRate(s, lvl, rid) {
  const L = here(s);
  let top = 0, how = '';
  for (const res in L.res) {
    const f = resourceFood(s, res, lvl, rid);
    if (f && f.v > top) { top = f.v; how = f.how; }
  }
  const game = (rid) => (L.res[rid] && L.res[rid].known ? clamp(L.res[rid].amt / RESOURCES[rid].cap, 0, 1) : 0);
  if (lvl('hunt') >= 10 && game('small_game')) {
    const v = clamp((0.1 + 0.5 * game('small_game')) * Math.min(1.2, lvl('hunt') / 45), 0, 0.85) * 860 / 3.4;
    if (v > top) { top = v; how = 'hunting small game'; }
  }
  if (lvl('fishspear') >= 15 && game('fish')) {
    const v = (1.3 * game('fish') * lvl('fishspear') / 55 + 0.5) * 400;
    if (v > top) { top = v; how = 'spearing fish'; }
  }
  return { v: top, how };
}

function flowValue(s, flow, lvl, rid) {
  if (flow === 'food') return foodRate(s, lvl, rid).v;
  if (flow === 'sleep') return clamp(0.45 + 0.2 * lvl('bed') / 100 + 0.25 * lvl('shelter') / 100, 0.15, 1);
  if (flow === 'water') { const w = waterHere(s); return w ? Math.max(w.purity, lvl('well')) : 0; }
  if (flow === 'fuel') {
    const L = here(s);
    let kgph = 0;
    for (const rid of ['deadwood', 'twigs']) { const r = L.res[rid]; if (r && r.known) kgph = Math.max(kgph, RESOURCES[rid].gather.rate * Math.sqrt(clamp(r.amt / r.cap, 0, 1)) * (rid === 'deadwood' ? 0.4 : 0.25)); }
    const burn = (lvl('hearth') > 0 ? 0.7 : 1) * (lvl('roof') >= 40 ? 1 : 1.3); // rain, on average, doubles the burn a third of the time
    return (kgph * 0.85) / burn;
  }
  return 0;
}

export function flowText(flow, v) {
  if (flow === 'food') return `${Math.round(v)} kcal per hour`;
  if (flow === 'sleep') return `sleep ${Math.round(v * 100)}% restful`;
  if (flow === 'water') return `water purity ${Math.round(v)}`;
  if (flow === 'fuel') return `${fmt(v)} h of fire per hour of wood-gathering`;
  return fmt(v);
}

export function flowNow(s, flow) {
  const lvl = (cap) => capInfo(s, cap).level;
  return { v: flowValue(s, flow, lvl), how: flow === 'food' ? foodRate(s, lvl).how : '' };
}

// How much would making recipe `rid` improve a repeating need?
export function flowGain(s, flow, rid, base) {
  const extra = capsFromRecipe(rid);
  if (!Object.keys(extra).length && !outputsOf(rid).some((k) => KINDS[k].cont)) return 0;
  const lvl = (cap) => Math.max(capInfo(s, cap).level, extra[cap] || 0);
  return flowValue(s, flow, lvl, rid) - base;
}

// In words: what would be different with what recipe `rid` makes?
export function gainHow(s, flow, rid) {
  const extra = capsFromRecipe(rid);
  if (flow === 'food') return foodRate(s, (cap) => Math.max(capInfo(s, cap).level, extra[cap] || 0), rid).how;
  const names = { sleep: ['bed', 'shelter'], water: ['well'], fuel: ['hearth', 'roof'] }[flow] || [];
  return names.filter((c) => (extra[c] || 0) > capInfo(s, c).level).map((c) => ({ bed: 'a softer bed', shelter: 'warmer shelter', well: 'filtered water', hearth: 'slower burning', roof: 'a roof over the fire' }[c])).join(', ');
}

export function gainText(flow, g) {
  if (flow === 'food') return `+${Math.round(g)} kcal/h`;
  if (flow === 'sleep') return `+${Math.round(g * 100)}% rest`;
  if (flow === 'water') return `+${Math.round(g)} purity`;
  if (flow === 'fuel') return `+${fmt(g)} h fire per h`;
  return '+' + fmt(g);
}

// ------------------------------------------------------------------ projects
export function projectList(s, P) {
  const out = [];
  for (const key of Object.keys(REPEAT)) {
    if (key[0] === 'x') out.push(repeatNode(s, key));
  }
  for (const rid in RECIPES) {
    const n = P.node('r.' + rid);
    const prog = here(s).items.find((it) => it.proj && it.proj.rid === rid);
    out.push(Object.assign({}, n, { prog, total: prog ? prog.proj.left : n.total, ready: n.ready || !!prog }));
  }
  return out;
}

function repeatNode(s, key) {
  const R = REPEAT[key];
  let ready = false, total = Infinity, cmd = null, why = '';
  if (key === 'x.eat') { const f = bestFoodItem(s); ready = !!f && s.c.stomach < 2000; total = 10; cmd = { t: 'eatBest' }; why = f ? `best within reach: ${kindOf(f).name}` : 'nothing edible within reach'; if (s.c.stomach >= 2000) why = 'too full'; }
  if (key === 'x.drink') {
    const w = waterHere(s), carried = reach(s).find((r) => r.it.kind === 'water');
    ready = (!!w || !!carried) && s.c.thirst >= 0.1; total = 3;
    cmd = w ? { t: 'drink' } : carried ? { t: 'drinkItem', id: carried.it.id } : null;
    why = s.c.thirst < 0.1 ? 'not thirsty' : w ? `water here, purity ${Math.round(w.purity)}` : carried ? 'carried water' : 'no water here';
  }
  if (key === 'x.sleep') { ready = true; total = Math.max(60, (s.c.fatigue / (12 * sleepQuality(s))) * 60); cmd = { t: 'sleep' }; why = `sleep here is ${Math.round(sleepQuality(s) * 100)}% restful`; }
  return { key, name: R.name, repeat: R.flow, ready, total, cmd, why, steps: [{ key, minutes: total, wait: 0, times: 1, for: [] }], away: 0 };
}

// Sort projects. With nothing selected: by time to completion. With a
// one-off project selected: by minutes of its route they would cover. With a
// repeating need selected: by how much they raise its rate.
export function rankProjects(s, P, list, selKey) {
  const sel = selKey ? list.find((n) => n.key === selKey) : null;
  const rest = list.filter((n) => n !== sel);
  const flow = sel && (sel.repeat || (REPEAT[selKey] && REPEAT[selKey].flow));
  if (!sel) {
    rest.sort((a, b) => a.total - b.total || a.name.localeCompare(b.name));
    return { sel: null, rest };
  }
  if (flow) {
    const base = flowValue(s, flow, (cap) => capInfo(s, cap).level);
    for (const n of rest) { n.gain = n.key[0] === 'r' ? flowGain(s, flow, n.key.slice(2), base) : 0; n.gainHow = n.gain > 1e-6 ? gainHow(s, flow, n.key.slice(2)) : ''; }
    rest.sort((a, b) => (b.gain > 1e-6) - (a.gain > 1e-6) || (b.gain > 1e-6 && a.gain > 1e-6 ? b.gain / Math.max(b.total, 30) - a.gain / Math.max(a.total, 30) : a.total - b.total));
    return { sel, rest, flow, base };
  }
  const route = {};
  for (const st of sel.steps) route[st.key] = st.minutes + st.wait;
  for (const n of rest) {
    let saved = 0;
    for (const st of n.steps || []) if (route[st.key] != null && st.key !== sel.key) saved += route[st.key];
    n.saved = saved;
  }
  rest.sort((a, b) => b.saved - a.saved || a.total - b.total);
  return { sel, rest };
}

// ------------------------------------------------------------------ tasks
// A task is something you can do right now with one tap.
function gatherTask(s, rid, why) {
  const st = gatherStatus(s, rid);
  if (!st || !st.r.known || !st.ok) return null;
  const k = KINDS[RESOURCES[rid].gather.kind];
  return { key: 'g.' + rid, name: 'Collect ' + k.name, cmd: { t: 'gather', rid, min: 30 }, minutes: 30, met: RESOURCES[rid].gather.met || 3, mode: 'act', why,
    note: `${fmt(st.rate)}${k.unit === 'ea' ? '' : ' ' + k.unit}/h` };
}

function taskForStep(s, P, key, why) {
  const n = P.node(key);
  if (!n.ready || n.passive) return null;
  if (n.recipe) {
    const r = n.recipe;
    return { key, name: r.name, cmd: { t: 'recipe', id: r.id, choose: (s.choices || {})[r.id] || {} }, minutes: Math.min(n.st.time, 120), met: r.met, mode: 'act', why, note: n.st.time > 150 && !r.outdoor ? `${fmtTime(n.st.time)} in all` : '' };
  }
  const rid = key.slice(2);
  if (n.w.mode === 'here') return gatherTask(s, rid, why);
  if (n.w.mode === 'goto') { const info = travelInfo(s, n.w.to); return { key: 'go.' + n.w.to, name: `Walk to ${s.locs[n.w.to].name.toLowerCase()}`, cmd: { t: 'travel', to: n.w.to }, minutes: info.minutes, met: info.met, mode: 'travel', why: why || `for ${RESOURCES[rid].name.toLowerCase()}`, note: `${fmt(info.km)} km` }; }
  return { key: 'x.find.' + rid, name: `Explore for ${RESOURCES[rid].name.toLowerCase()}`, cmd: { t: 'explore', hours: n.w.hours, targets: [rid] }, minutes: n.w.hours * 60, met: 3.5, mode: 'travel', why,
    note: `about ${Math.round(n.w.p * 100)}% chance per trip` };
}

export function taskList(s, P, ranked) {
  const out = [], seen = new Set();
  const push = (t, front) => { if (t && !seen.has(t.key)) { seen.add(t.key); t.front = !!front; out.push(t); } };
  const sel = ranked.sel;
  const L = here(s);
  // 1. what moves the selected project forward
  if (sel) {
    if (sel.prog) push({ key: 'w.' + sel.prog.id, name: `Keep working: ${sel.name.toLowerCase()}`, cmd: { t: 'work', id: sel.prog.id }, minutes: Math.min(120, sel.prog.proj.left), met: RECIPES[sel.prog.proj.rid].met, mode: 'act', note: `${fmtTime(sel.prog.proj.left)} left` }, true);
    if (sel.repeat) {
      if (sel.cmd && sel.ready) push({ key: sel.key, name: sel.name, cmd: sel.cmd, minutes: sel.total, met: sel.key === 'x.sleep' ? 0.95 : 1.5, mode: sel.key === 'x.sleep' ? 'sleep' : 'rest', note: sel.why }, true);
      if (sel.repeat === 'food') {
        for (const { it } of reach(s)) if (kindOf(it).food && (it.q.tannin || 0) <= 25) push({ key: 'e.' + it.kind, name: `Eat ${kindOf(it).name}`, cmd: { t: 'eat', id: it.id }, minutes: 10, met: 1.5, mode: 'rest', note: `${Math.round(kindOf(it).food.kcal * Math.min(it.n, kindOf(it).food.portion))} kcal` }, true);
        const foods = Object.keys(L.res).map((rid) => gatherTask(s, rid, '')).filter((t) => t && (KINDS[RESOURCES[t.key.slice(2)].gather.kind].food || KINDS[RESOURCES[t.key.slice(2)].gather.kind].crush));
        for (const t of foods) { const f = resourceFood(s, t.key.slice(2), (cap) => capInfo(s, cap).level); t.kcal = f ? f.v : 0; t.why = f ? f.how.split(', ').slice(1).join(', ') : ''; }
        foods.sort((a, b) => b.kcal - a.kcal).forEach((t) => { t.note = `~${Math.round(t.kcal)} kcal/h`; push(t, true); });
        for (const rid of ['hunt_small', 'spear_fish', 'angle']) push(taskForStep(s, P, 'r.' + rid, ''), true);
      }
      if (sel.repeat === 'water') for (const { it } of reach(s)) { const c = contSpec(it); if (c && c.liquid && waterHere(s)) push({ key: 'f.' + it.id, name: `Fill the ${kindOf(it).name}`, cmd: { t: 'fill', id: it.id }, minutes: 5, met: 2.5, mode: 'act' }, true); }
      if (sel.repeat === 'fuel') { push(taskForStep(s, P, 'r.add_fuel', ''), true); push(gatherTask(s, 'deadwood', ''), true); push(gatherTask(s, 'twigs', ''), true); }
      if (sel.repeat === 'sleep') push({ key: 'rest', name: 'Rest an hour', cmd: { t: 'rest', min: 60 }, minutes: 60, met: 1.1, mode: 'rest' }, true);
    } else {
      for (const st of sel.steps) push(taskForStep(s, P, st.key, st.key === sel.key ? '' : 'toward ' + sel.name.toLowerCase()), true);
    }
  }
  // 2. everything else you could do right now
  for (const it of L.items) if (it.proj && (!sel || !sel.prog || sel.prog !== it)) push({ key: 'w.' + it.id, name: `Keep working: ${it.proj.name}`, cmd: { t: 'work', id: it.id }, minutes: Math.min(120, it.proj.left), met: RECIPES[it.proj.rid].met, mode: 'act', note: `${fmtTime(it.proj.left)} left` });
  if (trapsHere(s).length) push({ key: 'traps', name: `Check ${trapsHere(s).length} trap${trapsHere(s).length > 1 ? 's' : ''}`, cmd: { t: 'checkTraps' }, minutes: 10 + 3 * trapsHere(s).length, met: 3, mode: 'act' });
  if (waterHere(s) && s.c.thirst >= 0.1) push({ key: 'x.drink', name: 'Drink', cmd: { t: 'drink' }, minutes: 3, met: 1.5, mode: 'rest', note: `purity ${Math.round(waterHere(s).purity)}` });
  for (const rid in L.res) push(gatherTask(s, rid, ''));
  if (L.surveys < 3) push({ key: 'survey', name: 'Search this place', cmd: { t: 'survey' }, minutes: 45, met: 2.8, mode: 'act', note: 'may turn up more' });
  for (const id in s.locs) if (id !== s.at) { const info = travelInfo(s, id); push({ key: 'go.' + id, name: `Walk to ${s.locs[id].name.toLowerCase()}`, cmd: { t: 'travel', to: id }, minutes: info.minutes, met: info.met, mode: 'travel', note: `${fmt(info.km)} km` }); }
  push({ key: 'explore', name: 'Explore 2 h', cmd: { t: 'explore', hours: 2, targets: [] }, minutes: 120, met: 3.5, mode: 'travel', note: 'somewhere new' });
  push({ key: 'rest', name: 'Rest an hour', cmd: { t: 'rest', min: 60 }, minutes: 60, met: 1.1, mode: 'rest' });
  push({ key: 'x.sleep', name: 'Sleep', cmd: { t: 'sleep' }, minutes: 480, met: 0.95, mode: 'sleep' });
  return out;
}

// ------------------------------------------------------------------ reserves at the pace of the top task
// For each reserve: where it stands (frac), where the comfort line is
// (tfrac), whether you are already past it, and how long until the next
// line at the metabolic rate of `task`: the comfort line if you are above
// it, the harm line if you are below.
export function runway(s, task) {
  const c = s.c, L = LIMITS, met = (task ? task.met : 1.5) + (c.chill > 30 ? 0.4 : 0), mode = task ? task.mode : 'act';
  const sick = c.cond.some((x) => x.type === 'gastro');
  const lines = [];
  const E = c.stomach + c.glyc, burn = 70 * met;
  if (E > L.food.ok) lines.push({ name: 'Food', frac: E / L.food.full, tfrac: L.food.ok / L.food.full, h: (E - L.food.ok) / burn, word: 'until hungry' });
  else if (E > 0) lines.push({ name: 'Food', frac: E / L.food.full, tfrac: L.food.ok / L.food.full, low: true, h: E / burn, word: 'hungry · until weak' });
  else lines.push({ name: 'Food', frac: 0, tfrac: L.food.ok / L.food.full, low: true, h: c.fat / burn, word: 'weak · living on fat' });
  const tr = thirstRate(met, sick);
  const wf = (x) => 1 - x / L.water.harm;
  lines.push(c.thirst < L.water.ok
    ? { name: 'Water', frac: wf(c.thirst), tfrac: wf(L.water.ok), h: (L.water.ok - c.thirst) / tr, word: 'until thirsty' }
    : { name: 'Water', frac: wf(c.thirst), tfrac: wf(L.water.ok), low: true, h: Math.max(0, L.water.harm - c.thirst) / tr, word: 'thirsty · until harmed' });
  const fr = mode === 'sleep' || met <= 1.3 ? 0 : (met - 1.2) * 2 + 0.6;
  const sf = (x) => 1 - x / L.stamina.harm;
  lines.push(c.fatigue < L.stamina.ok
    ? { name: 'Stamina', frac: sf(c.fatigue), tfrac: sf(L.stamina.ok), h: fr ? (L.stamina.ok - c.fatigue) / fr : Infinity, word: 'until tired' }
    : { name: 'Stamina', frac: sf(c.fatigue), tfrac: sf(L.stamina.ok), low: true, h: fr ? (L.stamina.harm - c.fatigue) / fr : Infinity, word: 'tired · until you drop' });
  const T = feltTemp(s, met, mode), cr = T < 12 ? (12 - T) * 0.9 : 0;
  const cf = (x) => 1 - x / L.warmth.harm;
  lines.push(c.chill < L.warmth.ok
    ? { name: 'Warmth', frac: cf(c.chill), tfrac: cf(L.warmth.ok), h: cr ? (L.warmth.ok - c.chill) / cr : Infinity, word: 'until cold' }
    : { name: 'Warmth', frac: cf(c.chill), tfrac: cf(L.warmth.ok), low: true, h: cr ? Math.max(0, L.warmth.harm - c.chill) / cr : Infinity, word: 'cold · until harmed' });
  const fire = here(s).items.find((it) => it.kind === 'fire');
  if (fire) lines.push({ name: 'Fire', frac: Math.min(1, fire.q.fuel / 6), tfrac: 0, h: fire.q.fuel / (raining(s) ? 2 : 1), word: 'until embers' });
  // already-impaired reserves first (soonest harm first), then the rest by time to their comfort line
  lines.sort((a, b) => (b.low ? 1 : 0) - (a.low ? 1 : 0) || a.h - b.h);
  return lines;
}

// Advice for the main screen: which tasks to do next, and which of your
// reserves runs out first. Which projects are worth doing is econ.js's job.
// Like plan.js, this only reads state.

import { KINDS } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES } from './data/recipes.js';
import { kindOf, here, reach, contSpec } from './items.js';
import { recipeStatus, gatherStatus, waterHere, travelInfo, trapsHere, reqText } from './actions.js';
import { feltTemp, raining, LIMITS, thirstRate, hourOf } from './sim.js';
import { fmt, fmtTime } from './util.js';

// ------------------------------------------------------------------ tasks
// A task is something you can do right now with one tap.
// o: {wants: [{n, req}]} to collect set amounts (some needing to be good
// enough for something), {min} for a stretch of time; by default both
// hands' worth.
function gatherTask(s, rid, why, o = {}, minutes = 0) {
  const st = gatherStatus(s, rid);
  if (!st || !st.r.known || !st.ok) return null;
  const k = KINDS[RESOURCES[rid].gather.kind], rate = Math.max(st.rate, 1e-3);
  const wants = o.min ? null : o.wants && o.wants.length ? o.wants : [{ n: 2 * k.hand }];
  const n = wants ? wants.reduce((a, w) => a + w.n, 0) : 0;
  const amt = (x) => (k.unit === 'ea' ? `${Math.max(1, Math.round(x))}` : `${fmt(x)} ${k.unit}`);
  const strict = wants ? wants.filter((w) => w.req) : [];
  const plural = k.unit === 'ea' && Math.round(n) > 1 && !k.name.endsWith('s') ? k.name + 's' : k.name;
  const name = o.min ? `Collect ${k.name}` : `Collect ${amt(n)}${k.unit === 'ea' ? ' ' : ' of '}${plural}${strict.length ? ` (${strict.map((w) => (wants.length > 1 ? amt(w.n) + ' ' : '') + reqText(w.req)).join('; ')})` : ''}`;
  const mins = o.min || minutes || Math.max(2, (60 * n) / rate);
  return { key: 'g.' + rid, name, cmd: o.min ? { t: 'gather', rid, min: o.min } : { t: 'gather', rid, wants }, minutes: mins, met: RESOURCES[rid].gather.met || 3, mode: 'act', why,
    note: `${fmt(rate)}${k.unit === 'ea' ? '' : ' ' + k.unit}/h` };
}

function recipeTask(s, rid, why) {
  const r = RECIPES[rid];
  if (!r) return null;
  const st = recipeStatus(s, r, (s.choices || {})[rid] || {});
  if (!st.ok) return null;
  return { key: 'r.' + rid, name: r.name, cmd: { t: 'recipe', id: rid, choose: (s.choices || {})[rid] || {} }, minutes: Math.min(st.time, 120), met: r.met, mode: 'act', why, note: st.time > 150 && !r.outdoor ? `${fmtTime(st.time)} in all` : '' };
}

function taskForStep(s, P, key, why, step) {
  const n = P.node(key);
  if (!n.ready || n.passive) return null;
  if (n.recipe) return recipeTask(s, n.recipe.id, why);
  const rid = key.slice(2).split('@')[0];
  const reason = step ? step.why || '' : P.whyOf(key); // why this step, for this project
  if (reason) why = reason;
  if (n.w.mode === 'here') return gatherTask(s, rid, why, step && step.wants ? { wants: step.wants } : {}, step && step.wants && step.wants.some((w) => w.req) ? step.minutes : 0);
  if (n.w.mode === 'goto') { const info = travelInfo(s, n.w.to); return { key: 'go.' + n.w.to, name: `Walk to ${s.locs[n.w.to].name.toLowerCase()}`, cmd: { t: 'travel', to: n.w.to }, minutes: info.minutes, met: info.met, mode: 'travel', why: why || `for ${RESOURCES[rid].name.toLowerCase()}`, note: `${fmt(info.km)} km` }; }
  return { key: 'x.find.' + rid, name: `Explore for ${reason ? 'better ' : ''}${RESOURCES[rid].name.toLowerCase()}`, cmd: { t: 'explore', hours: n.w.hours, targets: [rid] }, minutes: n.w.hours * 60, met: 3.5, mode: 'travel', why,
    note: reason ? 'quality varies by place' : `about ${Math.round(n.w.p * 100)}% chance per trip` };
}

// How each way of getting food turns into one tap.
const METHOD_RECIPES = { hunting: { small_game: ['hunt_small'], large_game: ['hunt_large'] }, spear: { fish: ['spear_fish'] }, 'hook and line': { fish: ['angle'] },
  snares: { small_game: ['set_snare', 'snare'] }, deadfalls: { small_game: ['deadfall'] }, 'fish trap': { fish: ['set_fish_trap'] } };
const FOOD_WORK = /^(crush_|roast_|boil_|soak_|dry_|butcher_)/;

const SLEEP_TASK = { key: 'x.sleep', name: 'Sleep', cmd: { t: 'sleep' }, minutes: 480, met: 0.95, mode: 'sleep' };
const REST_TASK = { key: 'rest', name: 'Rest an hour', cmd: { t: 'rest', min: 60 }, minutes: 60, met: 1.1, mode: 'rest' };

const MEAL = 1500; // kcal: what one sitting of eating should bring
const hoursOf = (n) => (isFinite(n.total) ? n.total / 60 : Infinity);
function firstTask(s, P, node, why) {
  for (const st of node.steps) { const t = taskForStep(s, P, st.key, why, st); if (t) return t; }
  return null;
}
const edible = (it) => { const f = kindOf(it).food; return f && (it.q.tannin || 0) <= 25 && (it.q.fresh == null || it.q.fresh >= 25); };

// The next step of the cheapest way to a meal (the upkeep evaluator's main
// food), and the time from here until you could eat: collecting, each
// recipe of the route, and any waiting (leaching overnight). Picks up where
// you are: if you already hold acorn meal, the next step is leaching it.
function foodChain(s, P, up) {
  const mix = up ? up.food.mix.filter((m) => m.sus).sort((a, b) => b.kcal - a.kcal) : [];
  const m = mix[0];
  if (!m) return null;
  const def = RESOURCES[m.rid], g = def.gather;
  let units = MEAL / Math.max(m.v, 1), bitter = g ? (KINDS[g.kind].q.tannin || 0) > 25 : false;
  // the stages: what each recipe needs going in, and how long it takes
  const stages = [];
  for (const rid of m.rids || []) {
    const r = RECIPES[rid], spec = r.in.find((x) => x.id === 'x') || r.in[0], kind = spec.kind, k = KINDS[kind];
    const verb = rid.split('_')[0], base = spec.n;
    const minutes = r.flat ? r.time : (r.time * Math.max(base, units)) / base;
    const wait = verb === 'soak' ? k.soak.hours : verb === 'dry' ? k.dry.hours : 0;
    stages.push({ rid, kind, bitter, h: minutes / 60 + wait });
    const y = verb === 'crush' ? k.crush.y : verb === 'roast' ? k.roast.y : verb === 'boil' ? k.boil.y : verb === 'dry' ? k.dry.y : 1;
    if (verb === 'crush') bitter = ((k.crush.q && k.crush.q.tannin) ?? KINDS[k.crush.to].q.tannin ?? 0) > 25;
    if (verb === 'soak') bitter = false;
    units *= y;
  }
  const items = reach(s).map((x) => x.it);
  const matchesStage = (it, st) => it.kind === st.kind && (st.bitter ? (it.q.tannin || 0) > 25 : (it.q.tannin || 0) <= 25);
  for (let i = stages.length - 1; i >= 0; i--) {
    const st = stages[i], later = stages.slice(i + 1).reduce((a, x) => a + x.h, 0) + 1 / 6;
    const waiting = items.find((it) => it.kind === st.kind && it.proc && i > 0 && stages[i - 1].rid.startsWith('soak'));
    if (waiting) return { task: null, prepH: waiting.proc.left / 60 + st.h + later }; // nothing to do but wait
    if (!items.some((it) => !it.proc && matchesStage(it, st))) continue;
    const task = recipeTask(s, st.rid, '') || firstTask(s, P, P.node('r.' + st.rid), '');
    return { task, prepH: st.h + later };
  }
  // nothing in hand yet: collect a meal's worth
  const prep = stages.reduce((a, x) => a + x.h, 0) + 1 / 6;
  if (m.method === 'collect') {
    const gs = gatherStatus(s, m.rid), n = MEAL / Math.max(m.v, 1);
    if (!gs || !gs.ok || gs.r.amt < n) return null;
    return { task: gatherTask(s, m.rid, '', { wants: [{ n: KINDS[g.kind].unit === 'ea' ? Math.ceil(n) : Math.round(n * 100) / 100 }] }), prepH: n / Math.max(gs.rate, 1e-3) + prep };
  }
  for (const rid of (METHOD_RECIPES[m.method] || {})[m.rid] || []) { const t = recipeTask(s, rid, ''); if (t) return { task: t, prepH: t.minutes / 60 + prep }; }
  return null;
}

// When the food you can get here will run out: look for more in time.
// Goes to a known place with a food you can use, or explores for the best
// kinds (by kcal per hour with what you have) that are quickest to find.
function foodScout(s, P, up, burn) {
  if (!up) return null;
  let kcal = 0;
  const L = here(s);
  for (const m of up.food.mix) { const r = L.res[m.rid]; if (r && r.known && isFinite(r.amt)) kcal += r.amt * (m.v || 0); }
  const lineH = kcal / burn - 12; // keep half a day in hand
  let best = null;
  for (const f of (up.foodRank || []).slice(0, 4)) {
    if (L.res[f.rid] && L.res[f.rid].known) continue;
    const n = P.node('g.' + f.rid), h = hoursOf(n);
    if (!best || h < best.h) best = { rid: f.rid, h, n };
  }
  if (!best || !isFinite(best.h)) return null;
  return { task: firstTask(s, P, best.n, `before the food here runs out`), prepH: best.h, lineH };
}

// What it takes to have a fire burning for `hours`: feed it, rekindle it,
// or make one from scratch, plus the wood.
function fireChain(s, P, hours) {
  const fire = reach(s).find((x) => x.it.kind === 'fire'), embers = reach(s).find((x) => x.it.kind === 'embers');
  const fuelHave = reach(s).filter((x) => KINDS[x.it.kind].tags.includes('fuel') && !KINDS[x.it.kind].fixed).reduce((a, x) => a + x.it.n * KINDS[x.it.kind].mass * KINDS[x.it.kind].fuel * 0.8, 0);
  const need = Math.max(0, hours - (fire ? fire.it.q.fuel : 0) - fuelHave);
  const wood = gatherStatus(s, 'deadwood');
  const woodH = need > 0 && wood && wood.ok ? (need / 0.32) / Math.max(wood.rate, 1e-3) : 0;
  const woodTask = need > 0 && wood && wood.ok ? gatherTask(s, 'deadwood', '', { wants: [{ n: Math.ceil(need / 0.32) }] }) : null;
  if (fire) {
    if (fire.it.q.fuel >= hours) return null;
    return { task: recipeTask(s, 'add_fuel', '') || woodTask, prepH: 0.05 + woodH };
  }
  if (embers) return { task: recipeTask(s, 'rekindle', '') || firstTask(s, P, P.node('r.rekindle'), ''), prepH: 0.1 + woodH };
  const n = P.node('r.light_fire');
  return { task: firstTask(s, P, n, '') || woodTask, prepH: hoursOf(n) + woodH };
}

// Needs: anything that has to start now so that a need is met before it
// crosses its comfort line, given that the task at the top would take its
// time first. Each need has a step that meets it directly (eat, drink,
// sleep) and a chain that makes that possible (prepare a meal, walk to
// water, light a fire before bed). A step is due when its preparation plus
// the top task would run past the line; the most overdue comes first.
function needTasks(s, P, up, top) {
  const met = top ? top.met : 2.5, mode = top ? top.mode : 'act', topH = top ? top.minutes / 60 : 0.5;
  const lines = runway(s, { met, mode });
  const until = (name) => { const l = lines.find((x) => x.name === name); return !l ? Infinity : l.low ? 0 : l.h; };
  const due = [];
  const consider = (task, prepH, lineH) => { if (task && isFinite(prepH) && lineH - prepH - topH <= 0) due.push({ task, slack: lineH - prepH - topH }); };
  const burn = 70 * met;
  // food: eat what you hold, keep a meal coming, and find more before it runs out
  const held = reach(s).filter((x) => edible(x.it)).reduce((a, x) => a + KINDS[x.it.kind].food.kcal * x.it.n, 0);
  const tHungry = until('Food');
  if (held > 100 && s.c.stomach < 2000) consider({ key: 'x.eatBest', name: 'Eat', cmd: { t: 'eatBest' }, minutes: 10, met: 1.5, mode: 'rest', note: `${Math.round(held)} kcal within reach` }, 1 / 6, tHungry);
  const fc = foodChain(s, P, up);
  if (fc) consider(fc.task, fc.prepH, tHungry + held / burn);
  else if (!(up && up.food.mix.some((m) => m.sus))) { const sc = foodScout(s, P, up, burn); if (sc) consider(sc.task, sc.prepH, tHungry + held / burn); }
  const sc = foodScout(s, P, up, (up ? up.E : 3000) / 24);
  if (sc) consider(sc.task, sc.prepH, sc.lineH);
  // water: drink here, drink what you carry, or get to water in time
  const tThirsty = until('Water'), w = waterHere(s);
  const carried = reach(s).filter((x) => x.it.kind === 'water');
  const litres = carried.reduce((a, x) => a + x.it.n, 0);
  if (s.c.thirst >= 0.1) {
    if (w) consider({ key: 'x.drink', name: 'Drink', cmd: { t: 'drink' }, minutes: 3, met: 1.5, mode: 'rest', note: `purity ${Math.round(w.purity)}` }, 0.05, tThirsty);
    else if (carried.length) consider({ key: 'd.' + carried[0].it.id, name: 'Drink carried water', cmd: { t: 'drinkItem', id: carried[0].it.id }, minutes: 3, met: 1.5, mode: 'rest' }, 0.05, tThirsty);
  }
  if (!w) { const n = P.node('g.water'); consider(firstTask(s, P, n, ''), hoursOf(n), tThirsty + litres / thirstRate(met, false)); }
  // sleep: by bedtime or when tired, with a fire first if nights here want one
  const hr = hourOf(s), tBed = hr >= 22 || hr < 5 ? 0 : hr >= 12 ? 22 - hr : Infinity;
  const tSleep = Math.min(until('Stamina'), tBed);
  if (up && up.nightFire && up.fire.mode) { const f = fireChain(s, P, up.sleep.S); if (f) consider(f.task, f.prepH, tSleep); }
  consider(SLEEP_TASK, 0, tSleep);
  // warmth while awake: a fire, if you can make one
  const tCold = until('Warmth');
  if (isFinite(tCold) && up && up.fire.mode) { const f = fireChain(s, P, 2); if (f) consider(f.task, f.prepH, tCold); }
  return due.sort((a, b) => a.slack - b.slack);
}

// sel: null, or a project row. up: the current upkeep (econ.upkeep).
export function taskList(s, P, sel, up) {
  const out = [], seen = new Set();
  const push = (t, front) => { if (t && !seen.has(t.key)) { seen.add(t.key); t.front = !!front; out.push(t); } };
  const L = here(s);
  const drinkTask = () => (waterHere(s) && s.c.thirst >= 0.1 ? { key: 'x.drink', name: 'Drink', cmd: { t: 'drink' }, minutes: 3, met: 1.5, mode: 'rest', note: `purity ${Math.round(waterHere(s).purity)}` } : null);
  // 1. what moves the selected project forward
  if (sel) {
    if (sel.prog) push({ key: 'w.' + sel.prog.id, name: `Keep working: ${sel.name.toLowerCase()}`, cmd: { t: 'work', id: sel.prog.id }, minutes: Math.min(120, sel.prog.proj.left), met: RECIPES[sel.prog.proj.rid].met, mode: 'act', note: `${fmtTime(sel.prog.proj.left)} left` }, true);
    for (const st of sel.node.steps) push(taskForStep(s, P, st.key, st.key === sel.key ? '' : 'toward ' + sel.name.toLowerCase(), st), true);
  }
  // 2. everything else you could do right now
  for (const it of L.items) if (it.proj) push({ key: 'w.' + it.id, name: `Keep working: ${it.proj.name}`, cmd: { t: 'work', id: it.id }, minutes: Math.min(120, it.proj.left), met: RECIPES[it.proj.rid].met, mode: 'act', note: `${fmtTime(it.proj.left)} left` });
  if (trapsHere(s).length) push({ key: 'traps', name: `Check ${trapsHere(s).length} trap${trapsHere(s).length > 1 ? 's' : ''}`, cmd: { t: 'checkTraps' }, minutes: 10 + 3 * trapsHere(s).length, met: 3, mode: 'act' });
  push(drinkTask());
  for (const { it } of reach(s)) if (edible(it) && s.c.stomach < 2000) push({ key: 'e.' + it.kind, name: `Eat ${kindOf(it).name}`, cmd: { t: 'eat', id: it.id }, minutes: 10, met: 1.5, mode: 'rest', note: `${Math.round(kindOf(it).food.kcal * Math.min(it.n, kindOf(it).food.portion))} kcal` });
  for (const { it } of reach(s)) { const c = contSpec(it); if (c && c.liquid && waterHere(s)) push({ key: 'f.' + it.id, name: `Fill the ${kindOf(it).name}`, cmd: { t: 'fill', id: it.id }, minutes: 5, met: 2.5, mode: 'act' }); }
  for (const rid in L.res) push(gatherTask(s, rid, ''));
  const ready = Object.keys(RECIPES).map((rid) => recipeTask(s, rid, '')).filter(Boolean).sort((a, b) => a.minutes - b.minutes);
  for (const t of ready) push(t);
  if (L.surveys < 3) push({ key: 'survey', name: 'Search this place', cmd: { t: 'survey' }, minutes: 45, met: 2.8, mode: 'act', note: 'may turn up more' });
  for (const id in s.locs) if (id !== s.at) { const info = travelInfo(s, id); push({ key: 'go.' + id, name: `Walk to ${s.locs[id].name.toLowerCase()}`, cmd: { t: 'travel', to: id }, minutes: info.minutes, met: info.met, mode: 'travel', note: `${fmt(info.km)} km` }); }
  push({ key: 'explore', name: 'Explore 2 h', cmd: { t: 'explore', hours: 2, targets: [] }, minutes: 120, met: 3.5, mode: 'travel', note: 'somewhere new' });
  push(REST_TASK);
  push(SLEEP_TASK);
  // 3. needs that cannot wait for the top task go above it
  const due = needTasks(s, P, up, out[0]);
  for (const d of due.slice().reverse()) {
    const i = out.findIndex((x) => x.key === d.task.key);
    if (i >= 0) out.splice(i, 1);
    out.unshift(Object.assign({}, d.task, { front: true }));
  }
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

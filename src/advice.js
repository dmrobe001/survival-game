// Advice for the main screen: which tasks to do next, and which of your
// reserves runs out first. Which projects are worth doing is econ.js's job.
// Like plan.js, this only reads state.

import { KINDS } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES } from './data/recipes.js';
import { kindOf, here, reach, contSpec } from './items.js';
import { recipeStatus, gatherStatus, waterHere, travelInfo, trapsHere } from './actions.js';
import { feltTemp, raining, LIMITS, thirstRate } from './sim.js';
import { fmt, fmtTime } from './util.js';

// ------------------------------------------------------------------ tasks
// A task is something you can do right now with one tap.
function gatherTask(s, rid, why) {
  const st = gatherStatus(s, rid);
  if (!st || !st.r.known || !st.ok) return null;
  const k = KINDS[RESOURCES[rid].gather.kind];
  return { key: 'g.' + rid, name: 'Collect ' + k.name, cmd: { t: 'gather', rid, min: 30 }, minutes: 30, met: RESOURCES[rid].gather.met || 3, mode: 'act', why,
    note: `${fmt(st.rate)}${k.unit === 'ea' ? '' : ' ' + k.unit}/h` };
}

function recipeTask(s, rid, why) {
  const r = RECIPES[rid];
  if (!r) return null;
  const st = recipeStatus(s, r, (s.choices || {})[rid] || {});
  if (!st.ok) return null;
  return { key: 'r.' + rid, name: r.name, cmd: { t: 'recipe', id: rid, choose: (s.choices || {})[rid] || {} }, minutes: Math.min(st.time, 120), met: r.met, mode: 'act', why, note: st.time > 150 && !r.outdoor ? `${fmtTime(st.time)} in all` : '' };
}

function taskForStep(s, P, key, why) {
  const n = P.node(key);
  if (!n.ready || n.passive) return null;
  if (n.recipe) return recipeTask(s, n.recipe.id, why);
  const rid = key.slice(2).split('@')[0];
  if (n.why) why = n.why;
  if (n.w.mode === 'here') return gatherTask(s, rid, why);
  if (n.w.mode === 'goto') { const info = travelInfo(s, n.w.to); return { key: 'go.' + n.w.to, name: `Walk to ${s.locs[n.w.to].name.toLowerCase()}`, cmd: { t: 'travel', to: n.w.to }, minutes: info.minutes, met: info.met, mode: 'travel', why: why || `for ${RESOURCES[rid].name.toLowerCase()}`, note: `${fmt(info.km)} km` }; }
  return { key: 'x.find.' + rid, name: `Explore for ${n.why ? 'better ' : ''}${RESOURCES[rid].name.toLowerCase()}`, cmd: { t: 'explore', hours: n.w.hours, targets: [rid] }, minutes: n.w.hours * 60, met: 3.5, mode: 'travel', why,
    note: n.why ? 'quality varies by place' : `about ${Math.round(n.w.p * 100)}% chance per trip` };
}

// How each way of getting food turns into one tap.
const METHOD_RECIPES = { hunting: { small_game: ['hunt_small'], large_game: ['hunt_large'] }, spear: { fish: ['spear_fish'] }, 'hook and line': { fish: ['angle'] },
  snares: { small_game: ['set_snare', 'snare'] }, deadfalls: { small_game: ['deadfall'] }, 'fish trap': { fish: ['set_fish_trap'] } };
const FOOD_WORK = /^(crush_|roast_|boil_|soak_|dry_|butcher_)/;

const SLEEP_TASK = { key: 'x.sleep', name: 'Sleep', cmd: { t: 'sleep' }, minutes: 480, met: 0.95, mode: 'sleep' };
const REST_TASK = { key: 'rest', name: 'Rest an hour', cmd: { t: 'rest', min: 60 }, minutes: 60, met: 1.1, mode: 'rest' };

// sel: null, {need} for one of the upkeep needs, or a project row.
// up: the current upkeep (econ.upkeep), for the order food is best got in.
export function taskList(s, P, sel, up) {
  const out = [], seen = new Set();
  const push = (t, front) => { if (t && !seen.has(t.key)) { seen.add(t.key); t.front = !!front; out.push(t); } };
  const L = here(s);
  const drinkTask = () => (waterHere(s) && s.c.thirst >= 0.1 ? { key: 'x.drink', name: 'Drink', cmd: { t: 'drink' }, minutes: 3, met: 1.5, mode: 'rest', note: `purity ${Math.round(waterHere(s).purity)}` } : null);
  // 1. what moves the selection forward
  if (sel && sel.need) {
    const need = sel.need;
    if (need === 'food') {
      for (const { it } of reach(s)) if (kindOf(it).food && (it.q.tannin || 0) <= 25) push({ key: 'e.' + it.kind, name: `Eat ${kindOf(it).name}`, cmd: { t: 'eat', id: it.id }, minutes: 10, met: 1.5, mode: 'rest', note: `${Math.round(kindOf(it).food.kcal * Math.min(it.n, kindOf(it).food.portion))} kcal` }, true);
      for (const m of up ? up.food.mix : []) {
        const why = m.how.join(', ') + (m.sus ? '' : ' (you are using more than regrows here)');
        if (m.method === 'collect') { const t = gatherTask(s, m.rid, why); if (t) { t.note = `~${Math.round(m.kcal / Math.max(m.hours, 1e-3))} kcal/h`; push(t, true); } }
        for (const rid of (METHOD_RECIPES[m.method] || {})[m.rid] || []) push(recipeTask(s, rid, why), true);
      }
      if (trapsHere(s).length) push({ key: 'traps', name: `Check ${trapsHere(s).length} trap${trapsHere(s).length > 1 ? 's' : ''}`, cmd: { t: 'checkTraps' }, minutes: 10 + 3 * trapsHere(s).length, met: 3, mode: 'act' }, true);
      for (const rid in RECIPES) if (FOOD_WORK.test(rid)) push(recipeTask(s, rid, ''), true);
    }
    if (need === 'water') {
      push(drinkTask(), true);
      for (const { it } of reach(s)) if (it.kind === 'water' && s.c.thirst >= 0.1) push({ key: 'd.' + it.id, name: `Drink carried water`, cmd: { t: 'drinkItem', id: it.id }, minutes: 3, met: 1.5, mode: 'rest', note: `purity ${Math.round(it.q.purity)}` }, true);
      push(recipeTask(s, 'boil_water', up ? up.water.how : ''), true);
      for (const { it } of reach(s)) { const c = contSpec(it); if (c && c.liquid && waterHere(s)) push({ key: 'f.' + it.id, name: `Fill the ${kindOf(it).name}`, cmd: { t: 'fill', id: it.id }, minutes: 5, met: 2.5, mode: 'act' }, true); }
    }
    if (need === 'sleep') { push(SLEEP_TASK, true); push(REST_TASK, true); }
    if (need === 'fire') {
      for (const rid of ['add_fuel', 'rekindle', 'light_fire', 'tinder']) push(recipeTask(s, rid, ''), true);
      push(gatherTask(s, 'deadwood', ''), true); push(gatherTask(s, 'twigs', ''), true);
    }
  } else if (sel) {
    if (sel.prog) push({ key: 'w.' + sel.prog.id, name: `Keep working: ${sel.name.toLowerCase()}`, cmd: { t: 'work', id: sel.prog.id }, minutes: Math.min(120, sel.prog.proj.left), met: RECIPES[sel.prog.proj.rid].met, mode: 'act', note: `${fmtTime(sel.prog.proj.left)} left` }, true);
    for (const st of sel.node.steps) push(taskForStep(s, P, st.key, st.key === sel.key ? '' : 'toward ' + sel.name.toLowerCase()), true);
  }
  // 2. everything else you could do right now
  for (const it of L.items) if (it.proj) push({ key: 'w.' + it.id, name: `Keep working: ${it.proj.name}`, cmd: { t: 'work', id: it.id }, minutes: Math.min(120, it.proj.left), met: RECIPES[it.proj.rid].met, mode: 'act', note: `${fmtTime(it.proj.left)} left` });
  if (trapsHere(s).length) push({ key: 'traps', name: `Check ${trapsHere(s).length} trap${trapsHere(s).length > 1 ? 's' : ''}`, cmd: { t: 'checkTraps' }, minutes: 10 + 3 * trapsHere(s).length, met: 3, mode: 'act' });
  push(drinkTask());
  for (const rid in L.res) push(gatherTask(s, rid, ''));
  const ready = Object.keys(RECIPES).map((rid) => recipeTask(s, rid, '')).filter(Boolean).sort((a, b) => a.minutes - b.minutes);
  for (const t of ready) push(t);
  if (L.surveys < 3) push({ key: 'survey', name: 'Search this place', cmd: { t: 'survey' }, minutes: 45, met: 2.8, mode: 'act', note: 'may turn up more' });
  for (const id in s.locs) if (id !== s.at) { const info = travelInfo(s, id); push({ key: 'go.' + id, name: `Walk to ${s.locs[id].name.toLowerCase()}`, cmd: { t: 'travel', to: id }, minutes: info.minutes, met: info.met, mode: 'travel', note: `${fmt(info.km)} km` }); }
  push({ key: 'explore', name: 'Explore 2 h', cmd: { t: 'explore', hours: 2, targets: [] }, minutes: 120, met: 3.5, mode: 'travel', note: 'somewhere new' });
  push(REST_TASK);
  push(SLEEP_TASK);
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

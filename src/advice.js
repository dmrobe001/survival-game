// Advice for the main screen: which tasks to do next, and which of your
// reserves runs out first. Which projects are worth doing is econ.js's job.
// Like plan.js, this only reads state.

import { KINDS } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES } from './data/recipes.js';
import { kindOf, here, reach, contSpec, whyNotHold } from './items.js';
import { recipeStatus, gatherStatus, waterHere, travelInfo, trapsHere, reqText, mealStages, FULL } from './actions.js';
import { feltTemp, raining, LIMITS, thirstRate, hourOf, sleepQuality, SLEEP_RECOVERY } from './sim.js';
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
  if (n.w.mode === 'goto') { const info = travelInfo(s, n.w.to); return { key: 'go.' + n.w.to, name: `Walk to ${s.locs[n.w.to].name.toLowerCase()}`, cmd: { t: 'travel', to: n.w.to }, minutes: info.minutes, met: info.met, mode: 'travel', why: `for ${thingOf(rid)}`, note: `${fmt(info.km)} km` }; }
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
// What you would go somewhere for, in a word or two: "water", "berries", "cobbles".
function thingOf(rid) {
  const g = RESOURCES[rid].gather;
  if (!g) return rid === 'water' ? 'water' : RESOURCES[rid].name.toLowerCase();
  const k = KINDS[g.kind], name = k.name.replace(/ in shell$/, '');
  return k.unit === 'ea' && !name.endsWith('s') ? name + 's' : name;
}
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
const VERB_WORDS = { crush: (k) => (k.crush.cap === 'grind' ? 'grind' : 'shell'), roast: () => 'roast', boil: () => 'boil', soak: () => 'leach', dry: () => 'dry' };
const andList = (w) => (w.length < 2 ? w.join('') : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1]);

// Collecting, each stage and eating, as one action that runs until you are
// full; it stops by itself at a stage that leaves the food alone (leaching).
// `from`: the first stage still to do (0 = collect first).
function mealTask(s, m, stages, from, collect, extra, prepH) {
  if (!mealStages(m.rid, m.rids)) return null;
  const rest = stages.slice(from), w = rest.findIndex((x) => x.wait);
  const doing = w >= 0 ? rest.slice(0, w + 1) : rest;
  const words = (collect ? ['collect'] : []).concat(doing.map((x) => x.word)).concat(w >= 0 ? [] : ['eat']);
  const waitH = w >= 0 ? rest.slice(w).reduce((a, x) => a + x.wait, 0) : 0;
  const minutes = Math.max(5, 60 * (prepH - waitH - (w >= 0 ? rest.slice(w + 1).reduce((a, x) => a + x.h - x.wait, 0) : 0)));
  const name = andList(words);
  return { key: 'meal.' + m.rid, name: name[0].toUpperCase() + name.slice(1) + ' ' + thingOf(m.rid), cmd: { t: 'meal', rid: m.rid, stages: m.rids || [], extra },
    minutes, met: 2.5, mode: 'act', note: w >= 0 ? `then ${fmtTime(waitH * 60)} to ${doing[doing.length - 1].word}` : 'until full' };
}

function foodChain(s, P, up) {
  const mix = up ? up.food.mix.filter((m) => m.sus).sort((a, b) => b.kcal - a.kcal) : [];
  const m = mix.find((x) => !x.at) || mix[0]; // what is here first; else the place you would fetch it from
  if (!m) return null;
  const def = RESOURCES[m.rid], g = def.gather;
  // when the year's plan puts this food by, each meal's collecting takes a share for later too
  // a sitting goes on until full (actions FULL): plan for that, at least MEAL
  const sitting = Math.max(MEAL, FULL - s.c.stomach);
  const meal = sitting + (up.year && up.year.putRids.includes(m.rid) ? up.year.putByToday / 2 : 0);
  const M = mealStages(m.rid, m.rids), fin = M && KINDS[M.end].food;
  const eatH = fin ? Math.min(60, Math.max(4, (10 * sitting) / fin.kcal / fin.portion)) / 60 : 1 / 6; // ten minutes a portion
  let units = meal / Math.max(m.v, 1), bitter = g ? (KINDS[g.kind].q.tannin || 0) > 25 : false;
  // the stages: what each recipe needs going in, and how long it takes
  const stages = [];
  for (const rid of m.rids || []) {
    const r = RECIPES[rid], spec = r.in.find((x) => x.id === 'x') || r.in[0], kind = spec.kind, k = KINDS[kind];
    const verb = rid.split('_')[0], base = spec.n;
    const minutes = r.flat ? r.time : (r.time * Math.max(base, units)) / base;
    const wait = verb === 'soak' ? k.soak.hours : verb === 'dry' ? k.dry.hours : 0;
    stages.push({ rid, kind, bitter, verb, wait, word: VERB_WORDS[verb] ? VERB_WORDS[verb](k) : verb, h: minutes / 60 + wait });
    const y = verb === 'crush' ? k.crush.y : verb === 'roast' ? k.roast.y : verb === 'boil' ? k.boil.y : verb === 'dry' ? k.dry.y : 1;
    if (verb === 'crush') bitter = ((k.crush.q && k.crush.q.tannin) ?? KINDS[k.crush.to].q.tannin ?? 0) > 25;
    if (verb === 'soak') bitter = false;
    units *= y;
  }
  const items = reach(s).map((x) => x.it);
  const matchesStage = (it, st) => it.kind === st.kind && (st.bitter ? (it.q.tannin || 0) > 25 : (it.q.tannin || 0) <= 25);
  for (let i = stages.length - 1; i >= 0; i--) {
    const st = stages[i], later = stages.slice(i + 1).reduce((a, x) => a + x.h, 0) + eatH;
    const waiting = items.find((it) => it.kind === st.kind && it.proc && i > 0 && stages[i - 1].rid.startsWith('soak'));
    if (waiting) return { task: null, prepH: waiting.proc.left / 60 + st.h + later }; // nothing to do but wait
    if (!items.some((it) => !it.proc && matchesStage(it, st))) continue;
    // if this step cannot be done yet (the fire has gone out), its own preparation counts too
    const ready = recipeTask(s, st.rid, ''), n = ready ? null : P.node('r.' + st.rid);
    const prepH = (ready ? st.h : Math.max(st.h, hoursOf(n))) + later;
    return { task: (ready && m.method === 'collect' && !m.at && mealTask(s, m, stages, i, false, 0, prepH)) || ready || firstTask(s, P, n, ''), prepH };
  }
  // nothing in hand yet: collect a meal's worth (going there first, if it is elsewhere)
  const prep = stages.reduce((a, x) => a + x.h, 0) + eatH;
  if (m.at) {
    const info = travelInfo(s, m.at), n = meal / Math.max(m.v, 1);
    const collectH = n / Math.max(def.gather ? def.gather.rate * 0.6 : 1, 1e-3);
    return { task: { key: 'go.' + m.at, name: `Walk to ${s.locs[m.at].name.toLowerCase()}`, cmd: { t: 'travel', to: m.at }, minutes: info.minutes, met: info.met, mode: 'travel', why: `for ${thingOf(m.rid)}`, note: `${fmt(info.km)} km` },
      prepH: (2 * info.minutes) / 60 + collectH + prep };
  }
  if (m.method === 'collect') {
    const gs = gatherStatus(s, m.rid), n = meal / Math.max(m.v, 1);
    if (!gs || !gs.ok || gs.r.amt < n) return null;
    const prepH = n / Math.max(gs.rate, 1e-3) + prep, extra = (meal - sitting) / Math.max(m.v, 1);
    return { task: mealTask(s, m, stages, 0, true, extra, prepH) || gatherTask(s, m.rid, '', { wants: [{ n: KINDS[g.kind].unit === 'ea' ? Math.ceil(n) : Math.round(n * 100) / 100 }] }), prepH };
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
  // getting there, then collecting and preparing a first meal (an allowance: the place is not known yet)
  return { task: firstTask(s, P, best.n, `before the food here runs out`), prepH: best.h + 1.5, lineH };
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
// When bed is due, the night is the top task: whatever would cross its line
// before morning (a meal, a drink) comes first, so you can sleep through.
function needTasks(s, P, up, top) {
  const due = bodyNeeds(s, P, up, top, false);
  const met = top ? top.met : 2.5, mode = top ? top.mode : 'act', topH = top ? top.minutes / 60 : 0.5;
  const lines = runway(s, { met, mode });
  const until = (name) => { const l = lines.find((x) => x.name === name); return !l ? Infinity : l.low ? 0 : l.rec ? Infinity : l.h; };
  const consider = (task, prepH, lineH) => { if (task && isFinite(prepH) && lineH - prepH - topH <= 0) { due.push({ task, slack: lineH - prepH - topH }); return due[due.length - 1]; } return null; };
  // sleep: by bedtime or when tired, with a fire first if nights here want one
  const hr = hourOf(s), tBed = hr >= 22 || hr < 5 ? 0 : hr >= 12 ? 22 - hr : Infinity;
  const tSleep = Math.min(until('Stamina'), tBed);
  // one chain: the fire for the night (if nights here want one), then sleep;
  // due when the top task plus all of it would run past bedtime
  const f = up && up.nightFire && up.fire.mode ? fireChain(s, P, up.sleep.S) : null;
  const bed = consider(f && f.task ? f.task : SLEEP_TASK, f ? f.prepH : 0, tSleep);
  if (bed) {
    const night = Object.assign({}, SLEEP_TASK, { minutes: 60 * (up ? up.sleep.S : 8) });
    for (const d of bodyNeeds(s, P, up, night, true)) if (!due.some((x) => x.task.key === d.task.key)) due.push({ task: d.task, slack: bed.slack - 0.01 });
  }
  // warmth while awake: a fire, if you can make one
  const tCold = until('Warmth');
  if (isFinite(tCold) && up && up.fire.mode) { const f = fireChain(s, P, 2); if (f) consider(f.task, f.prepH, tCold); }
  return due.sort((a, b) => a.slack - b.slack);
}

// Food and water, against the pace and length of `top`. At night (asleep),
// water within reach needs nothing: you drink from it in the night.
function bodyNeeds(s, P, up, top, night) {
  const met = top ? top.met : 2.5, mode = top ? top.mode : 'act', topH = top ? top.minutes / 60 : 0.5;
  const lines = runway(s, { met, mode });
  const until = (name) => { const l = lines.find((x) => x.name === name); return !l ? Infinity : l.low ? 0 : l.rec ? Infinity : l.h; };
  const due = [];
  const consider = (task, prepH, lineH) => { if (task && isFinite(prepH) && lineH - prepH - topH <= 0) due.push({ task, slack: lineH - prepH - topH }); };
  const burn = 70 * met;
  // food: eat what you hold, keep a meal coming, and find more before it runs out
  const ed = reach(s).filter((x) => edible(x.it));
  const held = ed.reduce((a, x) => a + KINDS[x.it.kind].food.kcal * x.it.n, 0), portions = ed.reduce((a, x) => a + x.it.n / KINDS[x.it.kind].food.portion, 0);
  const tHungry = until('Food'), room = FULL - s.c.stomach, eatMin = held ? Math.min(60, Math.max(4, (10 * portions * Math.min(held, room)) / held)) : 0;
  if (held > 100 && room > 50) consider({ key: 'x.eatBest', name: 'Eat', cmd: { t: 'eatBest' }, minutes: eatMin, met: 1.5, mode: 'rest', note: held > room ? 'until full' : `${Math.round(held)} kcal within reach` }, eatMin / 60, tHungry);
  const fc = foodChain(s, P, up);
  if (fc) consider(fc.task, fc.prepH, tHungry + held / burn);
  else if (!night && !(up && up.food.mix.some((m) => m.sus))) { const sc = foodScout(s, P, up, burn); if (sc) consider(sc.task, sc.prepH, tHungry + held / burn); }
  const sc = night ? null : foodScout(s, P, up, (up ? up.E : 3000) / 24);
  if (sc) consider(sc.task, sc.prepH, sc.lineH);
  // water: drink here, drink what you carry, or get to water in time
  const tThirsty = until('Water'), w = waterHere(s);
  const carried = reach(s).filter((x) => x.it.kind === 'water');
  const litres = carried.reduce((a, x) => a + x.it.n, 0);
  if (night && litres > 0.3) return due;
  if (s.c.thirst >= 0.1) {
    if (w) consider({ key: 'x.drink', name: 'Drink', cmd: { t: 'drink' }, minutes: 3, met: 1.5, mode: 'rest', note: `purity ${Math.round(w.purity)}` }, 0.05, tThirsty);
    else if (carried.length) consider({ key: 'd.' + carried[0].it.id, name: 'Drink carried water', cmd: { t: 'drinkItem', id: carried[0].it.id }, minutes: 3, met: 1.5, mode: 'rest' }, 0.05, tThirsty);
  }
  if (!w) { const n = P.node('g.water'); consider(firstTask(s, P, n, ''), hoursOf(n) + 0.05, tThirsty + litres / thirstRate(met, false, mode === 'sleep')); }
  return due;
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
  for (const { it } of reach(s)) if (edible(it) && s.c.stomach < FULL - 50) {
    const f = kindOf(it).food, n = Math.min(it.n, (FULL - s.c.stomach) / f.kcal);
    push({ key: 'e.' + it.kind, name: `Eat ${kindOf(it).name}`, cmd: { t: 'eat', id: it.id }, minutes: Math.min(60, Math.max(4, (10 * n) / f.portion)), met: 1.5, mode: 'rest', note: n < it.n - 1e-6 ? 'until full' : `${Math.round(f.kcal * n)} kcal` });
  }
  for (const { it } of reach(s)) { const c = contSpec(it); if (c && c.liquid && waterHere(s)) push({ key: 'f.' + it.id, name: `Fill the ${kindOf(it).name}`, cmd: { t: 'fill', id: it.id }, minutes: 5, met: 2.5, mode: 'act' }); }
  // food that keeps, lying in the open: put it under cover (a cool pit first)
  const store = L.items.filter((it) => contSpec(it) && !contSpec(it).liquid && kindOf(it).fixed).sort((a, b) => (contSpec(b).cool ? 1 : 0) - (contSpec(a).cool ? 1 : 0));
  for (const it of L.items) {
    const k = kindOf(it), rot = (k.decay || {}).fresh;
    if (!(k.food || k.crush) || !rot || rot > 2.5 || it.proc) continue;
    const box = store.find((c) => !whyNotHold(c, it, Math.min(it.n, 0.1)));
    if (box) push({ key: 'st.' + it.id, name: `Store the ${k.name} in the ${kindOf(box).name}`, cmd: { t: 'move', id: it.id, to: box.id }, minutes: 2, met: 2, mode: 'act', note: 'keeps far longer' });
  }
  for (const rid in L.res) push(gatherTask(s, rid, ''));
  const ready = Object.keys(RECIPES).map((rid) => recipeTask(s, rid, '')).filter(Boolean).sort((a, b) => a.minutes - b.minutes);
  for (const t of ready) push(t);
  if (L.surveys < 3) push({ key: 'survey', name: 'Search this place', cmd: { t: 'survey' }, minutes: 45, met: 2.8, mode: 'act', note: 'may turn up more' });
  for (const id in s.locs) if (id !== s.at) {
    const info = travelInfo(s, id), there = s.locs[id];
    // what is known there and not here: the reason anyone would walk over
    const only = Object.keys(there.res).filter((r) => there.res[r].known && RESOURCES[r].gather && !(L.res[r] && L.res[r].known)).slice(0, 3).map(thingOf);
    push({ key: 'go.' + id, name: `Walk to ${there.name.toLowerCase()}`, cmd: { t: 'travel', to: id }, minutes: info.minutes, met: info.met, mode: 'travel', why: only.length ? 'for ' + only.join(', ') : '', note: `${fmt(info.km)} km` });
  }
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
  const tr = thirstRate(met, sick, mode === 'sleep');
  const wf = (x) => 1 - x / L.water.harm;
  lines.push(c.thirst < L.water.ok
    ? { name: 'Water', frac: wf(c.thirst), tfrac: wf(L.water.ok), h: (L.water.ok - c.thirst) / tr, word: 'until thirsty' }
    : { name: 'Water', frac: wf(c.thirst), tfrac: wf(L.water.ok), low: true, h: Math.max(0, L.water.harm - c.thirst) / tr, word: 'thirsty · until harmed' });
  const fr = mode === 'sleep' || met <= 1.3 ? 0 : (met - 1.2) * 2 + 0.6;
  const sf = (x) => 1 - x / L.stamina.harm;
  // asleep or resting, fatigue falls: say how long until you are rested
  const rec = mode === 'sleep' ? SLEEP_RECOVERY * sleepQuality(s) : met <= 1.3 ? 3 : 0;
  if (rec && c.fatigue > 3) lines.push({ name: 'Stamina', frac: sf(c.fatigue), tfrac: sf(L.stamina.ok), rec: true, low: c.fatigue >= L.stamina.ok, h: c.fatigue / rec,
    word: (c.fatigue >= L.stamina.ok ? 'tired · ' : '') + (mode === 'sleep' ? 'until rested' : 'until rested, resting') });
  else lines.push(c.fatigue < L.stamina.ok
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
  // (a reserve that is filling back up goes last: it is not running out)
  lines.sort((a, b) => (b.low ? 1 : 0) - (a.low ? 1 : 0) || (a.rec ? 1 : 0) - (b.rec ? 1 : 0) || a.h - b.h);
  return lines;
}

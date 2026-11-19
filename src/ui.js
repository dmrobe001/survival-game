// The interface: menus, tabs, buttons and lists. No game rules live here.
// render() rebuilds the page from state; clicks become command objects that
// go through act() in actions.js, the same door the tests use.

import { esc, fmt, fmtTime, clamp } from './util.js';
import { KINDS, UNIT, QUALITY_NOTE } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES, GROUPS, CAP_NAMES } from './data/recipes.js';
import { tierLabel, kindOf, itemName, amountText, massOf, contSpec, usedVol, whyNotHold, capsOf, reach, here, handsUsed, handsFor, carriedMass, missingSlots, trashHere } from './items.js';
import { hourOf, dayOf, airTemp, feltTemp, isDark, sleepQuality, impairment, LIMITS } from './sim.js';
import { newGame, migrate, act, gatherStatus, recipeStatus, planInput, slotSpec, waterHere, trapsHere, travelInfo, MAX_CARRY } from './actions.js';
import { dist, bearing } from './world.js';
import { makePlanner } from './plan.js';
import { taskList, runway } from './advice.js';
import { projectRows, SORTS, tagsOf, NEEDS } from './econ.js';

const SAVE_KEY = 'foothold-save-v1';
let S = null;
const ui = { sort: 'horizon', ver: 0, theme: 'auto', overlay: null, menu: false, inv: false, vitals: false, collapsed: {}, projBack: [], tab: 'plan', sel: null, planFilter: 'all', edges: [], view: null, choices: {}, targets: {}, hours: 2, notice: '', busy: false, fast: false, confirmNew: false };

// ------------------------------------------------------------------ persistence
// JSON cannot hold Infinity; water sources have infinite abundance.
const freeze = (s) => JSON.stringify(s, (k, v) => (v === Infinity ? '__inf' : v));
export const thaw = (str) => JSON.parse(str, (k, v) => (v === '__inf' ? Infinity : v));
function save() { try { localStorage.setItem(SAVE_KEY, freeze(S)); } catch (e) { /* storage unavailable: play on without saving */ } }
function load() { try { const t = localStorage.getItem(SAVE_KEY); return t ? thaw(t) : null; } catch (e) { return null; } }
const randomSeed = () => Math.random().toString(36).slice(2, 8);

// Light, dark, or follow the device. Remembered in this browser only.
const THEME_KEY = 'foothold-theme', SORT_KEY = 'foothold-sort';
function applyTheme() {
  const root = document.documentElement;
  if (ui.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', ui.theme);
  try { localStorage.setItem(THEME_KEY, ui.theme); } catch (e) { /* not saved; fine */ }
}

// ------------------------------------------------------------------ little HTML builders
const btn = (text, cmd, o = {}) => `<button class="${o.cls || ''}" ${o.off ? 'disabled' : ''} ${o.title ? `title="${esc(o.title)}"` : ''} data-cmd="${esc(JSON.stringify(cmd))}">${text}</button>`;
const uibtn = (text, action, o = {}) => `<button class="${o.cls || ''}" ${o.on ? 'aria-pressed="true"' : ''} data-ui="${esc(action)}">${text}</button>`;
const chip = (text, cls = '') => `<span class="chip ${cls}">${text}</span>`;
const meter = (name, frac, word, cls = '') => `<div class="meter ${cls}"><div class="meter-top"><span>${name}</span><span>${word}</span></div><div class="track"><i style="width:${Math.round(clamp(frac, 0, 1) * 100)}%"></i></div></div>`;
const clock = (t) => { const h = Math.floor((t / 60) % 24), m = Math.floor(t % 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };

const Q_ORDER = Object.keys(QUALITY_NOTE);
function qualChips(it) {
  const out = [];
  for (const q of Q_ORDER) {
    if (it.q[q] == null || q === 'size' || q === 'retention') continue;
    if (q === 'smoked') { if (it.q[q] > 50) out.push(chip('smoked')); continue; }
    if (q === 'fuel') { out.push(chip(`burns ${fmt(it.q.fuel)} h more`, 'warm')); continue; }
    if (q === 'heat') { out.push(chip(`glowing ${fmt(it.q.heat)} h more`, 'warm')); continue; }
    const v = Math.round(it.q[q]);
    const low = (q === 'integrity' || q === 'fresh' || q === 'tack') && v < 30;
    out.push(`<span class="chip ${low ? 'low' : ''}" title="${esc(QUALITY_NOTE[q])}">${q} ${v}</span>`);
  }
  return out.join('');
}
function capChips(it) {
  const caps = capsOf(it);
  return Object.keys(caps).map((c) => `<span class="chip cap" title="works as a ${esc(CAP_NAMES[c] || c)}">${CAP_NAMES[c] || c} ${caps[c]}</span>`).join('');
}
function contText(it) {
  const c = contSpec(it);
  if (!c) return '';
  const bits = [`holds ${fmt(usedVol(it))}/${fmt(c.vol)} L`];
  if (c.liquid) bits.push(`${Math.round(c.ret)}% watertight`); else if (c.mesh >= 1) bits.push(`gaps ${c.mesh} cm`);
  if (c.cool) bits.push('cool');
  return chip(bits.join(', '), 'cont');
}

// ------------------------------------------------------------------ item lists
// where: 'here' | 'hands' | 'worn' | 'in' (inside a container)
function itemRow(it, where, depth, editable) {
  const k = kindOf(it);
  const ctrl = [];
  if (editable) {
    if (k.food) ctrl.push(btn('Eat', { t: 'eat', id: it.id }));
    if (it.kind === 'water') ctrl.push(btn('Drink', { t: 'drinkItem', id: it.id }));
    const c = contSpec(it);
    if (c && c.liquid && waterHere(S) && !missingSlots(it).length) ctrl.push(btn('Fill', { t: 'fill', id: it.id }));
    if (it.proj) ctrl.push(btn(`Work on it (${fmtTime(Math.min(120, it.proj.left))})`, { t: 'work', id: it.id }, { cls: 'primary' }));
    if (!k.fixed && !k.liquid) {
      if (where !== 'hands') ctrl.push(btn(where === 'here' ? 'Take' : 'Hold', { t: 'move', id: it.id, to: 'hands' }));
      if (k.worn && where !== 'worn') ctrl.push(btn(k.cont ? 'Sling on' : 'Wear', { t: 'move', id: it.id, to: 'wear' }));
      if (where !== 'here') ctrl.push(btn(where === 'in' ? 'Take out' : 'Drop', { t: 'move', id: it.id, to: 'ground' }));
    }
    if (!k.fixed) {
      const conts = reach(S).map((r) => r.it).filter((o) => o !== it && contSpec(o) && !kindOf(o).trap && !(it.in && o === it) && !whyNotHold(o, it, k.unit === 'ea' ? 1 : 0.001));
      if (conts.length) ctrl.push(`<select data-move="${it.id}" aria-label="Put ${esc(k.name)} in a container"><option value="">${k.liquid ? 'Pour into…' : 'Put in…'}</option>${conts.map((o) => `<option value="${o.id}">${esc(itemName(o))}</option>`).join('')}</select>`);
    }
    if (it.proj || k.slots || k.unset) ctrl.push(btn(it.proj ? 'Abandon' : 'Take apart', { t: 'dismantle', id: it.id }, { cls: 'quiet' }));
  }
  let extra = '';
  if (it.proc) extra += chip(`ready in ${fmtTime(it.proc.left)}`, 'warm');
  if (it.proj) extra += chip(`${Math.round(100 * (1 - it.proj.left / it.proj.total))}% done`, 'warm');
  if (k.trap) extra += chip(it.q.sprung >= 50 ? 'sprung?' : 'set', 'warm');
  if (where === 'hands') extra += chip(handsFor(it) === 2 ? 'both hands' : 'one hand', 'cont');
  else if (where === 'here' && !k.fixed && !k.liquid && depth === 0) extra += chip(k.hands === 2 ? 'needs both hands' : handsFor(it) > 2 ? `${k.unit === 'ea' ? fmt(k.hand) : fmt(k.hand) + UNIT[k.unit]} per hand` : handsFor(it) === 2 ? 'two handfuls' : 'one handful', 'muted');
  let html = `<li class="item" style="--d:${depth}"><div class="item-main"><span class="item-name">${esc(itemName(it))} <b>${amountText(it)}</b></span>` +
    `<span class="chips">${capChips(it)}${contText(it)}${k.trap ? '' : qualChips(it)}${extra}</span></div>` +
    (ctrl.length ? `<div class="ctrl">${ctrl.join('')}</div>` : '') + '</li>';
  if (k.slots) {
    for (const sl in k.slots) {
      const p = it.parts && it.parts[sl];
      const spec = slotSpec(it, sl);
      let sel = '';
      if (editable) {
        const plan = planInput(S, spec, null);
        const opts = plan.cands.filter((c) => planInput(S, spec, c.id).ok);
        if (opts.length) sel = `<select data-replace="${it.id}:${sl}" aria-label="Replace ${esc(sl)}"><option value="">${p ? 'Replace with…' : 'Fit…'}</option>${opts.map((o) => `<option value="${o.id}">${esc(itemName(o))} ${amountText(o)} ${briefQ(o)}</option>`).join('')}</select>`;
      }
      html += `<li class="item part" style="--d:${depth + 1}"><div class="item-main"><span class="item-name"><i>${esc(sl)}:</i> ${p ? `${esc(itemName(p))} <b>${amountText(p)}</b>` : `<span class="${spec.opt ? 'muted' : 'bad'}">${spec.opt ? 'none (optional)' : 'missing'}</span>`}</span>` +
        `<span class="chips">${p ? qualChips(p) : ''}</span></div>${sel ? `<div class="ctrl">${sel}</div>` : ''}</li>`;
    }
  }
  if (it.in && !k.trap) for (const c of it.in) html += itemRow(c, 'in', depth + 1, editable);
  return html;
}
const briefQ = (it) => { const keys = Object.keys(it.q).filter((q) => QUALITY_NOTE[q]).slice(0, 2); return keys.length ? '(' + keys.map((q) => `${q} ${Math.round(it.q[q])}`).join(', ') + ')' : ''; };
const itemList = (list, where, editable = true, empty = 'Nothing.') => (list.length ? `<ul class="items">${list.map((it) => itemRow(it, where, 0, editable)).join('')}</ul>` : `<p class="muted">${empty}</p>`);

// ------------------------------------------------------------------ header and vitals
function header() {
  const c = S.c;
  const T = airTemp(S);
  const sky = { clear: isDark(S) ? 'clear night' : 'clear', cloudy: 'overcast', rain: 'rain', storm: 'storm' }[S.weather.kind];
  const food = c.stomach + c.glyc;
  const foodWord = c.stomach > 1500 ? 'full' : c.stomach > 400 ? 'fed' : c.glyc > 800 ? 'peckish' : c.glyc > 0 ? 'hungry' : 'running on reserves';
  const days = c.fat / 2400;
  const thirstWord = c.thirst < 0.5 ? 'quenched' : c.thirst < LIMITS.water.ok ? 'a little thirsty' : c.thirst < 2.5 ? 'thirsty, distracted' : c.thirst < LIMITS.water.harm ? 'parched, impaired' : 'dangerously dry';
  const fatWord = c.fatigue < 25 ? 'fresh' : c.fatigue < 55 ? 'working' : c.fatigue < 80 ? 'tired' : 'exhausted';
  const chillWord = c.chill < 15 ? 'comfortable' : c.chill < 40 ? 'chilly' : c.chill < 70 ? 'cold' : 'hypothermic';
  const conds = c.cond.map((x) => chip(`${{ cut: 'cut hand', blister: 'blistered palms', sprain: 'sprained ankle', bruise: 'bruised', gastro: 'sick gut', burn: 'burn' }[x.type]} ${Math.round(x.sev)}`, 'low')).join('');
  return `<header class="top"><div class="title"><h1>Foothold</h1><span class="when">Day ${dayOf(S)} · ${clock(S.t)} · ${sky} · ${Math.round(T)} °C</span></div>
    <div class="vitals">
      ${meter('Food', food / 4000, foodWord, c.glyc <= 0 ? 'bad' : '')}
      ${meter('Reserves', c.fat / 60000, `${Math.round(days)} days of fat`, days < 5 ? 'bad' : '')}
      ${meter('Water', 1 - c.thirst / LIMITS.water.harm, thirstWord, c.thirst > LIMITS.water.ok ? 'bad' : '')}
      ${meter('Stamina', 1 - c.fatigue / 100, fatWord, c.fatigue > 80 ? 'bad' : '')}
      ${meter('Warmth', 1 - c.chill / 100, chillWord, c.chill > 40 ? 'bad' : '')}
      ${meter('Health', c.health / 100, `${Math.round(c.health)}%`, c.health < 50 ? 'bad' : '')}
    </div>${conds ? `<div class="chips conds">${conds}</div>` : ''}
    <div class="progress" id="progress" hidden><i></i></div>
    ${ui.notice ? `<p class="notice" role="status">${esc(ui.notice)}</p>` : ''}</header>`;
}

// ------------------------------------------------------------------ place tab
function envWords(e) {
  const w = [];
  w.push(e.elev > 0.7 ? 'high ground' : e.elev < 0.3 ? 'low ground' : 'rolling ground');
  w.push(e.water > 0.85 ? 'standing water everywhere' : e.water > 0.6 ? 'running water close by' : e.water > 0.42 ? 'a trickle of water' : 'dry');
  w.push(e.canopy > 0.7 ? 'dense trees' : e.canopy > 0.42 ? 'scattered trees' : e.canopy > 0.22 ? 'brush' : 'open sky');
  if (e.conifer > 0.6 && e.canopy > 0.3) w.push('mostly conifers');
  w.push(e.rock > 0.7 ? 'bare rock showing' : e.rock > 0.45 ? 'stony soil' : 'deep soil');
  return w.join(', ');
}

function resourceRow(rid, r, current) {
  const def = RESOURCES[rid];
  const frac = r.cap === Infinity ? 1 : r.amt / r.cap;
  const word = r.cap === Infinity ? 'unlimited' : frac < 0.04 ? 'exhausted' : frac < 0.25 ? 'nearly gone' : frac < 0.55 ? 'thinning' : frac < 0.85 ? 'plentiful' : 'untouched';
  const unit = def.gather ? UNIT[KINDS[def.gather.kind].unit] : '';
  const amount = r.cap === Infinity ? '' : `about ${fmt(r.amt < 10 ? Math.round(r.amt * 10) / 10 : Math.round(r.amt))}${unit}`;
  const quals = r.assessed ? Object.keys(r.q).map((q) => `<span class="chip" title="${esc(QUALITY_NOTE[q] || '')}">${q} ${r.q[q]}</span>`).join('') : Object.keys(r.q).length ? chip('quality unknown', 'muted') : '';
  let ctrl = '', lines = '';
  if (current) {
    if (rid === 'water') {
      const w = waterHere(S);
      ctrl = btn('Drink', { t: 'drink' }, { cls: 'primary', title: `purity ${Math.round(w.purity)}` });
    } else if (def.gather) {
      const st = gatherStatus(S, rid);
      const per = `${fmt(st.rate)}${unit}/h`;
      ctrl = btn('30 min', { t: 'gather', rid, min: 30 }, { off: !st.ok, cls: 'primary', title: 'Gather for 30 minutes at ' + per }) + btn('2 h', { t: 'gather', rid, min: 120 }, { off: !st.ok, title: 'Gather for 2 hours at ' + per });
      lines = `<span class="req ok">${per}</span>` + st.lines.map((l) => `<span class="req ${l.ok ? 'ok' : l.opt ? 'opt' : 'no'}">${esc(l.text)}</span>`).join('');
    }
  }
  return `<li class="res"><div class="res-main"><div class="res-head"><span class="item-name">${esc(def.name)}</span><span class="muted">${word}${amount ? ', ' + amount : ''}</span></div>
    <div class="track thin"><i style="width:${Math.round(frac * 100)}%"></i></div>
    <div class="chips">${quals}${lines}</div>${def.note ? `<p class="muted small">${esc(def.note)}</p>` : ''}</div><div class="ctrl">${ctrl}</div></li>`;
}

function placeTab() {
  const ids = Object.keys(S.locs);
  if (!ui.view || (ui.view !== 'explore' && !S.locs[ui.view])) ui.view = S.at;
  const tabs = ids.map((id) => uibtn(`${id === S.at ? '● ' : ''}${esc(S.locs[id].name)}`, 'view:' + id, { on: ui.view === id })).join('') + uibtn('Explore…', 'view:explore', { on: ui.view === 'explore', cls: 'quiet' });
  let body;
  if (ui.view === 'explore') body = exploreView();
  else {
    const l = S.locs[ui.view], current = ui.view === S.at;
    const known = Object.keys(l.res).filter((rid) => l.res[rid].known);
    const home = S.locs[S.home];
    const where = l.id === S.home ? 'where you woke' : `${fmt(dist(home, l))} km ${bearing(home, l)} of where you woke`;
    let actions = '';
    if (current) {
      actions = btn('Search this place (45 min)', { t: 'survey' }, { title: 'Look for what is not obvious, and judge the quality of what is.' });
      const traps = trapsHere(S);
      if (traps.length) actions += btn(`Check ${traps.length} trap${traps.length > 1 ? 's' : ''}`, { t: 'checkTraps' }, { cls: 'primary' });
    } else {
      const info = travelInfo(S, l.id);
      actions = btn(`Walk here: ${fmt(info.km)} km ${info.dir}, about ${fmtTime(info.minutes)}`, { t: 'travel', to: l.id }, { cls: 'primary', off: info.mass > MAX_CARRY }) +
        `<span class="muted small">You take only what you carry (${fmt(info.mass)} kg now). Everything else stays where it lies.</span>`;
    }
    body = `<div class="place-head"><h2>${esc(l.name)}</h2><p class="muted">${envWords(l.env)}; ${where}.</p><div class="ctrl left">${actions}</div></div>
      <section><h3>What the land offers</h3>${known.length ? `<ul class="reslist">${known.map((rid) => resourceRow(rid, l.res[rid], current)).join('')}</ul>` : '<p class="muted">Nothing obvious. Search more carefully.</p>'}
      ${current && l.surveys < 3 ? '<p class="muted small">There may be more here than you have noticed.</p>' : ''}</section>
      <section><h3>${current ? 'On the ground and built here' : 'What you left here'}</h3>${itemList(l.items, 'here', current, current ? 'Nothing yet. What you gather and make is set down here.' : 'Nothing.')}</section>`;
  }
  return `<nav class="subtabs" aria-label="Known places">${tabs}</nav>${body}`;
}

function exploreView() {
  const chosen = Object.keys(ui.targets).filter((t) => ui.targets[t]);
  const groups = [['Water and food', ['water', 'berries', 'tubers', 'greens', 'nuts', 'acorns', 'seeds', 'eggs', 'grubs', 'shellfish', 'fish', 'small_game', 'large_game']],
    ['Plants and wood', ['deadwood', 'branches', 'saplings', 'softwood', 'stalks', 'logs', 'bark', 'resin', 'grass', 'leaves', 'reeds', 'withies', 'fiber_plants']],
    ['Stone and earth', ['cobbles', 'toolstone', 'slabs', 'clay']]];
  return `<div class="place-head"><h2>Explore</h2>
    <p>Range out, look around, and come back knowing the way to somewhere new. Nearby country resembles where you stand; real change takes distance.</p>
    <p class="muted">Pick what to look for and you will be led to the most promising spot you pass. Each extra thing you look for makes you less likely to find the best place for any one of them.</p></div>
    ${groups.map(([name, list]) => `<section><h3>${name}</h3><div class="ctrl left wrap">${list.map((rid) => uibtn(esc(RESOURCES[rid].name), 'target:' + rid, { on: !!ui.targets[rid], cls: 'toggle' })).join('')}</div></section>`).join('')}
    <section><h3>How long</h3><div class="ctrl left">${[1, 2, 4, 8].map((h) => uibtn(`${h} h, out to ${fmt(0.9 * h)} km`, 'hours:' + h, { on: ui.hours === h, cls: 'toggle' })).join('')}</div>
    <div class="ctrl left go">${btn(`Explore for ${ui.hours} h${chosen.length ? ', looking for ' + chosen.length + ' thing' + (chosen.length > 1 ? 's' : '') : ''}`, { t: 'explore', hours: ui.hours, targets: chosen }, { cls: 'primary' })}</div></section>`;
}

// ------------------------------------------------------------------ plan tab: the web of actions
// Columns are time until you could have it done, counting everything you
// would have to do first. Rows are kinds of work.
const BUCKETS = [[15, 'within 15 min'], [60, 'within 1 h'], [180, 'within 3 h'], [480, 'within 8 h'], [1440, 'within a day'], [Infinity, 'days']];
const bucketOf = (n) => (isFinite(n.total) ? BUCKETS.findIndex((b) => n.total <= b[0]) : BUCKETS.length);
const away = (n) => (!isFinite(n.total) ? 'no known route' : n.ready ? fmtTime(n.total) : `~${fmtTime(n.total)}`);

function stepCmd(n) {
  if (n.recipe) return { t: 'recipe', id: n.recipe.id, choose: ui.choices[n.recipe.id] || {} };
  const rid = n.key.slice(2);
  if (n.w.mode === 'here') return { t: 'gather', rid, min: 30 };
  if (n.w.mode === 'goto') return { t: 'travel', to: n.w.to };
  return { t: 'explore', hours: n.w.hours, targets: [rid] };
}
const stepLabel = (n) => (n.recipe ? n.name : n.w.mode === 'search' ? `Explore ${n.w.hours} h for ${n.res.name.toLowerCase()}` : n.name);
const goalBox = (n) => `<label class="check goal"><input type="checkbox" id="goal-${n.key}" data-ui="goal:${n.key}" ${S.goals[n.key] ? 'checked' : ''}> Goal</label>`;
const jump = (key, text) => `<button class="link" data-ui="sel:${key}">${text}</button>`;

function detail(P, n) {
  let body = '', act1 = '';
  if (n.recipe) {
    const r = n.recipe, st = recipeStatus(S, r, ui.choices[r.id] || {}), ch = ui.choices[r.id] || {};
    const lines = st.lines.map((l) => {
      let sel = '';
      if (l.input && l.plan.cands.length > 1) sel = `<select data-choose="${r.id}:${l.input}" aria-label="Choose which to use"><option value="">best available</option>${l.plan.cands.map((c) => `<option value="${c.id}" ${String(ch[l.input]) === String(c.id) ? 'selected' : ''}>${esc(itemName(c))} ${amountText(c)} ${briefQ(c)}</option>`).join('')}</select>`;
      const using = l.input && l.plan.ok && !sel ? ` <span class="muted">using ${esc(itemName(l.plan.first))} ${briefQ(l.plan.first)}</span>` : '';
      const via = l.ok ? null : l.input ? n.reqs.in[l.input] : l.cap ? n.reqs.tool[l.cap] : l.res ? n.reqs.res : null;
      const how = via ? ` ${jump(via, '› ' + esc(P.node(via).name) + ' (' + away(P.node(via)) + ')')}` : '';
      return `<li class="req ${l.ok ? 'ok' : l.opt ? 'opt' : 'no'}">${esc(l.text)}${using}${sel}${how}</li>`;
    }).join('');
    const batch = st.k > 1.01 ? ` ×${fmt(st.k)}` : '';
    act1 = btn(st.time > 150 && !r.outdoor ? `Start (${fmtTime(st.time)} in all)` : `Do it${batch}: ${fmtTime(st.time)}`, { t: 'recipe', id: r.id, choose: ch }, { off: !st.ok, cls: 'primary' });
    body = `<p class="muted small">${esc(r.desc || '')}</p><ul class="reqs">${lines}</ul>`;
  } else {
    const rid = n.key.slice(2), def = n.res, l = here(S);
    const places = Object.values(S.locs).filter((p) => p.id !== S.at && p.res[rid] && p.res[rid].known);
    let how = '';
    if (n.w.mode === 'here') {
      if (n.gs) {
        const unit = UNIT[KINDS[def.gather.kind].unit];
        act1 = btn('Collect for 30 min', { t: 'gather', rid, min: 30 }, { off: !n.gs.ok, cls: 'primary' }) + btn('2 h', { t: 'gather', rid, min: 120 }, { off: !n.gs.ok });
        how = `<ul class="reqs"><li class="req ok">here, at ${fmt(n.gs.rate)}${unit}/h</li>${n.gs.lines.map((x) => { const via = !x.ok && !x.opt && def.gather.tool ? n.reqs.tool[def.gather.tool.cap] : null; return `<li class="req ${x.ok ? 'ok' : x.opt ? 'opt' : 'no'}">${esc(x.text)}${via ? ' ' + jump(via, '› ' + esc(P.node(via).name) + ' (' + away(P.node(via)) + ')') : ''}</li>`; }).join('')}</ul>`;
      } else how = '<p class="req ok">Present at this place.</p>';
    } else if (n.w.mode === 'search') {
      act1 = btn(`Explore ${n.w.hours} h for it`, { t: 'explore', hours: n.w.hours, targets: [rid] }, { cls: 'primary' }) + (l.surveys < 3 ? btn('Search this place first (45 min)', { t: 'survey' }) : '');
      how = `<p class="muted small">You have not seen this anywhere yet. In country like this, a ${n.w.hours} h trip looking for it succeeds about ${Math.round(n.w.p * 100)} times in 100, so expect roughly ${fmtTime(n.w.m)} including the walk there. It could be the first trip or the sixth.${l.surveys < 3 ? ' It may also be here, unnoticed.' : ''}</p>`;
    }
    const walks = places.map((p) => { const info = travelInfo(S, p.id); return btn(`Walk to ${esc(p.name.toLowerCase())}: ${fmt(info.km)} km, ${fmtTime(info.minutes)}`, { t: 'travel', to: p.id }, { cls: n.w.to === p.id ? 'primary' : '' }); }).join('');
    body = `${def.note ? `<p class="muted small">${esc(def.note)}</p>` : ''}${how}${walks ? `<div class="ctrl left wrap">${walks}</div>` : ''}`;
  }
  const chain = n.steps.length > 1 ? `<div class="chain"><span class="muted small">Route:</span>${n.steps.map((st) => { const m = P.node(st.key); return `<button class="node ${m.ready ? 'ready' : ''} ${st.key === n.key ? 'sel' : ''}" data-ui="sel:${st.key}">${esc(stepLabel(m))}${st.times > 1 ? ' ×' + st.times : ''} <small>${fmtTime(st.minutes + st.wait)}${st.wait ? ' incl. waiting' : ''}</small></button>`; }).join('<span class="chev">›</span>')}</div>` : '';
  const head = n.ready ? (n.passive ? 'Here' : 'Ready now') : isFinite(n.total) ? `About ${fmtTime(n.total)} away, ${n.away} step${n.away === 1 ? '' : 's'} first` : 'No known route right now';
  return `<section class="detail" id="detail"><div class="recipe-head"><div><span class="item-name">${esc(n.name)}</span> <span class="chip ${n.ready ? 'cap' : 'warm'}">${head}</span></div>
    <div class="ctrl">${goalBox(n)}${uibtn('Make it my project', 'proj:' + n.key)}${act1}${uibtn('Close', 'sel:', { cls: 'quiet' })}</div></div>${body}${chain}</section>`;
}

function planTab() {
  const P = makePlanner(S);
  for (const k in S.goals) if (!S.goals[k] || !P.has(k)) delete S.goals[k];
  const goals = Object.keys(S.goals);
  const support = new Set(), next = [];
  for (const g of goals) for (const st of P.node(g).steps) {
    if (st.key !== g) support.add(st.key);
    const m = P.node(st.key);
    if (m.ready && !m.passive && !next.includes(st.key)) next.push(st.key);
  }
  const sel = ui.sel && P.has(ui.sel) ? P.node(ui.sel) : null;
  const inRoute = new Set(sel ? sel.steps.map((s) => s.key) : []);
  ui.edges = [];
  for (const n of sel ? [sel] : goals.map(P.node)) for (const st of n.steps) for (const f of st.for) ui.edges.push([st.key, f]);

  const rows = ['Collect and find'].concat(GROUPS);
  const cols = BUCKETS.map((b) => b[1]).concat(['no known route']);
  const cells = {};
  let count = 0;
  for (const key of P.keys) {
    const n = P.node(key);
    if (ui.planFilter === 'ready' && !n.ready) continue;
    if (ui.planFilter === 'goals' && !S.goals[key] && !support.has(key)) continue;
    if (n.passive && ui.planFilter !== 'all') continue;
    count++;
    (cells[bucketOf(n) + '|' + n.group] = cells[bucketOf(n) + '|' + n.group] || []).push(n);
  }
  const chipFor = (n) => `<button class="node ${n.ready ? 'ready' : ''} ${S.goals[n.key] ? 'goal' : support.has(n.key) ? 'support' : ''} ${sel && sel.key === n.key ? 'sel' : inRoute.has(n.key) ? 'route' : ''}" data-ui="sel:${n.key}" data-key="${n.key}">${esc(n.name)} <small>${n.passive ? 'here' : n.ready ? fmtTime(n.total) : isFinite(n.total) ? n.away + (n.away === 1 ? ' step' : ' steps') : ''}</small></button>`;
  let grid = '<div class="corner"></div>' + rows.map((g, r) => `<div class="rowhead" style="grid-row:${r + 2}">${g}</div>`).join('');
  cols.forEach((c, ci) => {
    grid += `<div class="colhead" style="grid-column:${ci + 2}">${c}</div>`;
    rows.forEach((g, r) => {
      const list = (cells[ci + '|' + g] || []).sort((a, b) => a.total - b.total);
      grid += `<div class="cell ${list.length ? '' : 'empty'}" style="grid-column:${ci + 2};grid-row:${r + 2}" data-row="${esc(g)}">${list.map(chipFor).join('')}</div>`;
    });
  });
  const nextHtml = goals.length
    ? `<section class="next"><h3>Toward your goals <small>${goals.map((g) => esc(P.node(g).name) + ' (' + away(P.node(g)) + ')').join(' · ')}</small></h3>
        ${next.length ? `<ul class="items">${next.map((k) => { const m = P.node(k); return `<li class="item"><div class="item-main">${jump(k, esc(stepLabel(m)))}</div><div class="ctrl">${btn(m.recipe ? fmtTime(m.st.time) : m.w.mode === 'here' ? '30 min' : fmtTime(m.w.mode === 'goto' ? m.w.m : m.w.hours * 60), stepCmd(m), { cls: 'primary' })}</div></li>`; }).join('')}</ul>` : '<p class="muted">Nothing you can do toward these right now.</p>'}</section>`
    : '<p class="muted">Pick any action below to see what it needs and the quickest route to it. Tick <b>Goal</b> on the ones you are working toward and the steps that lead there are marked, with the ones you can do right now listed here.</p>';
  const filters = [['all', 'Everything'], ['ready', 'Can do now'], ['goals', 'Toward goals']].map(([k, t]) => uibtn(t, 'planFilter:' + k, { on: ui.planFilter === k })).join('');
  return `${nextHtml}${sel ? detail(P, sel) : ''}
    <nav class="subtabs" aria-label="Filter actions">${filters}<span class="muted small legend"><span class="node ready">can do now</span><span class="node">needs steps first</span><span class="node support">leads to a goal</span><span class="node goal">goal</span></span></nav>
    <div class="webwrap" id="webwrap"><div class="web" id="web" style="--rows:${rows.length}">${grid}<svg id="edges" aria-hidden="true"><defs><marker id="chev" viewBox="0 0 8 8" markerWidth="9" markerHeight="9" refX="4" refY="4" orient="auto"><path d="M1.5 1 L5.5 4 L1.5 7" fill="none" stroke-width="1.6"/></marker></defs></svg></div></div>
    <p class="muted small">${count} actions. Times count everything you would have to do first, one thing after another, by the quickest route you know of; searches are averages.</p>`;
}

// Draw the selected action's dependencies as lines of chevrons between chips.
function drawEdges() {
  const svg = document.getElementById('edges'), web = document.getElementById('web');
  if (!svg || !web) return;
  const box = web.getBoundingClientRect();
  svg.setAttribute('width', web.scrollWidth); svg.setAttribute('height', web.scrollHeight);
  let out = '';
  for (const [a, b] of ui.edges || []) {
    const ea = web.querySelector(`[data-key="${a}"]`), eb = web.querySelector(`[data-key="${b}"]`);
    if (!ea || !eb) continue;
    const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect();
    const forward = rb.left > ra.right + 8;
    const x1 = (forward ? ra.right : ra.left + ra.width / 2) - box.left, y1 = ra.top + ra.height / 2 - box.top + (forward ? 0 : (rb.top > ra.top ? ra.height / 2 : -ra.height / 2));
    const x2 = (forward ? rb.left : rb.left + rb.width / 2) - box.left, y2 = rb.top + rb.height / 2 - box.top + (forward ? 0 : (rb.top > ra.top ? -rb.height / 2 : rb.height / 2));
    const len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(2, Math.round(len / 16));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(`${(x1 + ((x2 - x1) * i) / n).toFixed(1)},${(y1 + ((y2 - y1) * i) / n).toFixed(1)}`);
    out += `<polyline points="${pts.join(' ')}" marker-mid="url(#chev)"/>`;
  }
  svg.insertAdjacentHTML('beforeend', out);
}

// ------------------------------------------------------------------ self tab
function selfTab() {
  const c = S.c;
  const mass = carriedMass(S);
  const felt = feltTemp(S, 1.1, 'rest');
  const eat = reach(S).filter((r) => kindOf(r.it).food);
  return `<section><h3>Rest</h3><div class="ctrl left wrap">
      ${btn('Rest 1 h', { t: 'rest', min: 60 })}${btn('Sleep until rested', { t: 'sleep' }, { cls: 'primary' })}${waterHere(S) ? btn('Drink', { t: 'drink' }) : ''}</div>
      <p class="muted small">Resting here now would feel like ${Math.round(felt)} °C (below 12 °C you lose heat). Sleep here restores ${Math.round(sleepQuality(S) * 100)}% of what good sleep would: bedding, shelter and warmth all count.</p></section>
    <section><h3>Body</h3><dl class="facts">
      <dt>In your stomach</dt><dd>${Math.round(c.stomach)} kcal</dd><dt>Quick energy</dt><dd>${Math.round(c.glyc)} of 2000 kcal</dd>
      <dt>Body fat</dt><dd>${Math.round(c.fat / 1000)} thousand kcal</dd><dt>Water deficit</dt><dd>${fmt(c.thirst)} L</dd>
      <dt>Fatigue</dt><dd>${Math.round(c.fatigue)} / 100</dd><dt>Chill</dt><dd>${Math.round(c.chill)} / 100</dd></dl></section>
    <section><h3>Food within reach</h3>${eat.length ? `<ul class="items">${eat.map((r) => itemRow(r.it, r.where === 'here' ? 'here' : 'in', 0, true)).join('')}</ul>` : '<p class="muted">Nothing edible.</p>'}</section>
    <section><h3>In your hands <small>${handsUsed(S)} of 2</small></h3>${itemList(S.c.hands, 'hands', true, 'Empty.')}</section>
    <section><h3>Worn and slung</h3>${itemList(S.c.worn, 'worn', true, 'Nothing. You are naked.')}
      <p class="muted small">Carrying ${fmt(mass)} of ${MAX_CARRY} kg. When you walk to another place you take only what is in your hands, worn, or packed inside those.</p></section>`;
}

// ------------------------------------------------------------------ guide tab
function guideTab() {
  return `<section class="prose"><h3>How this works</h3>
    <p><b>Time is the currency.</b> Every button costs minutes or hours, and with them calories, water and stamina. Hover a button to see its rate. Night work is slow and risky without a fire.</p>
    <p><b>Things are particular.</b> Two stones are not the same stone. Each object carries its own qualities, and what it can do follows from them: a hard cobble <i>is</i> a hammer, a stick <i>is</i> a poor digging tool. A task that needs "cutting edge 20+" is open to you exactly as long as you have something that sharp.</p>
    <p><b>Made things have parts.</b> An axe is a head, a haft, a binding and maybe glue, each wearing out in its own way. When a part fails the tool stops working until you fit a replacement from its entry in a list.</p>
    <p><b>A place only has what it has.</b> What you take grows back slowly or not at all. Search a place to find what is hidden; explore to find better country.</p>
    <p><b>You carry two hands' worth.</b> Baskets, bags, frames and a travois extend that, and can be nested. A net will not hold berries, but it will hold a bag of them.</p>
    <p><b>The main screen is what you are up to.</b> Pick a project and the list beneath it reorders around it: other projects by how much of its route they would cover, tasks by what moves it forward now. For eating, sleeping, drinking and keeping a fire, projects are ranked by how much they would raise that rate. The bar at the top is whichever reserve runs out first if you kept doing the top task.</p>
    <p><b>Your hands are at the bottom.</b> What you collect or make lands in your hand, setting down whatever you have held longest. Tap something on the ground to pick up a handful; tap something in your hand to set it down. Inventory shows every container here with full detail; drag the handle to move things between them.</p>
    <p><b>The technique web</b> (from the menu) lays every action out by how far off it is. Click an unmet requirement to jump to whatever supplies it.</p>
    <p><b>First day:</b> find water, pick up cobbles, look for stone that flakes, cut a sapling, twist cord, and get a fire and a bed together before dark.</p></section>
    <section><h3>This world</h3><p>Seed <code>${esc(S.seed)}</code>. The same seed always grows the same country.</p>
    <div class="ctrl left wrap"><input id="seed-input" type="text" maxlength="24" placeholder="seed for a new world" aria-label="Seed for a new world">
    ${ui.confirmNew ? uibtn('Really abandon this life?', 'new!', { cls: 'danger' }) + uibtn('Keep playing', 'cancelNew') : uibtn('Start a new game', 'new')}</div>
    <p><label class="check"><input type="checkbox" id="fast" data-ui="fast" ${ui.fast ? 'checked' : ''}> Skip the waiting bar</label></p>
    <p class="muted small">Progress is kept in this browser only.</p></section>`;
}

// ------------------------------------------------------------------ journal
function logView() {
  const rows = S.log.slice(-80).reverse().map((l, i) => `<li class="${l.cls} ${i < ui.fresh ? 'fresh' : ''}"><time>d${Math.floor(l.t / 1440) + 1} ${clock(l.t)}</time> ${esc(l.msg)}</li>`).join('');
  return `<section class="log"><ol>${rows}</ol></section>`;
}

// ------------------------------------------------------------------ main screen
const VITAL_CLS = (l) => (l.low ? (l.h < 3 ? 'bad' : 'warn') : '');
const zoned = (l, big) => `<span class="track zoned ${big ? 'big' : ''}" style="--t:${Math.round(clamp(l.tfrac, 0, 1) * 1000) / 10}%"><i style="width:${Math.round(clamp(l.frac, 0, 1) * 1000) / 10}%"></i></span>`;
const until = (l) => (l.h > 99 ? (l.low ? l.word.split(' · ')[0] + ' · holding' : 'fine for days') : `${l.low ? l.word.split(' · ')[0] + ' · ' : ''}~${fmtTime(l.h * 60)} ${l.low ? l.word.split(' · ')[1] : l.word}`);
function statusBar(lines, top) {
  const soon = lines[0];
  const imp = impairment(S);
  const sky = { clear: isDark(S) ? 'clear night' : 'clear', cloudy: 'overcast', rain: 'rain', storm: 'storm' }[S.weather.kind];
  const conds = S.c.cond.map((x) => chip(`${{ cut: 'cut hand', blister: 'blisters', sprain: 'sprained ankle', bruise: 'bruised', gastro: 'sick gut', burn: 'burn' }[x.type]} ${Math.round(x.sev)}`, 'low')).join('')
    + (imp.why.length ? chip(`${imp.why.join(', ')}: work ${Math.round((imp.slow - 1) * 100)}% slower${imp.risk > 1.05 ? `, injury ×${fmt(imp.risk)}` : ''}`, 'warm') : '');
  const all = ui.vitals ? `<div class="vitals-all">${lines.map((l) => `<div class="vline ${VITAL_CLS(l)}"><span>${l.name}</span>${zoned(l)}<span>${until(l)}</span></div>`).join('')}
      <div class="vline ${S.c.health < 50 ? 'bad' : ''}"><span>Health</span><span class="track"><i style="width:${Math.round(S.c.health)}%"></i></span><span>${Math.round(S.c.health)}%</span></div>
      <div class="vline"><span>Fat</span><span class="track"><i style="width:${Math.round(clamp(S.c.fat / 60000, 0, 1) * 100)}%"></i></span><span>${Math.round(S.c.fat / 2400)} days</span></div>
      <p class="muted small">The tick on each bar is where discomfort starts; left of it, work slows and accidents get likelier. Times assume you keep ${esc(top ? top.name.toLowerCase() : 'going')}.</p></div>` : '';
  return `<header class="sbar">
    <button class="soon ${VITAL_CLS(soon)}" data-ui="vitals" aria-expanded="${ui.vitals}">
      <span class="soon-top"><b>${soon.name}</b><span>${until(soon)}</span></span>
      ${zoned(soon, true)}</button>
    <div class="sbar-right"><span class="when">D${dayOf(S)} ${clock(S.t)}<br>${sky} ${Math.round(airTemp(S))}°</span>${uibtn('☰', 'menu', { cls: 'menu-btn', on: ui.menu })}</div>
    ${conds ? `<div class="chips conds">${conds}</div>` : ''}${all}
    ${ui.menu ? `<nav class="menu">${uibtn(`Theme: ${{ auto: 'follow device', light: 'light', dark: 'dark' }[ui.theme]}`, 'theme')}${[['body', 'Body'], ['web', 'Technique web'], ['places', 'Places and exploring'], ['journal', 'Journal'], ['guide', 'Guide and new game']].map(([k, n]) => uibtn(n, 'overlay:' + k)).join('')}</nav>` : ''}
  </header>
  <div class="progress" id="progress" hidden><i></i></div>
  ${ui.notice ? `<p class="notice" role="status">${esc(ui.notice)}</p>` : `<button class="lastlog ${S.log.length && S.log[S.log.length - 1].cls}" data-ui="overlay:journal">${esc(S.log.length ? S.log[S.log.length - 1].msg : '')}</button>`}`;
}

// ------------------------------------------------------------------ projects and upkeep
const hrs = (h) => (!isFinite(h) ? '∞' : h < 0.05 ? '0' : h < 9.95 ? fmt(Math.round(h * 10) / 10) : String(Math.round(h)));
const days = (d) => (!isFinite(d) ? '—' : d < 0.05 ? 'now' : d < 9.95 ? `${fmt(Math.round(d * 10) / 10)} d` : `${Math.round(d)} d`);
const NEED_NAMES = { sleep: 'Sleep', food: 'Food', water: 'Water', fire: 'Fire', repairs: 'Repairs' };
const resName = (rid) => (RESOURCES[rid].gather ? KINDS[RESOURCES[rid].gather.kind].name : RESOURCES[rid].name.toLowerCase());

// What one need's hours are made of, in a few short lines.
function needLines(need, up) {
  const L = [];
  if (need === 'food') {
    for (const m of up.food.mix) L.push(`${m.method === 'collect' ? resName(m.rid) : `${resName(m.rid)} by ${m.method}`}${m.how.length ? ', ' + m.how.join(', ') : ''} · ${Math.round(m.kcal)} kcal · ${hrs(m.hours)} h${m.sus ? '' : ' · further afield'}`);
    if (up.food.short) L.push(`${Math.round(up.food.short)} of ${Math.round(up.E)} kcal a day is more than regrows here, so it adds a walk out each day (counted as 1 h).`);
    if (up.food.unmet) L.push(`No known way to get ${Math.round(up.food.unmet)} kcal a day here.`);
  }
  if (need === 'sleep') {
    const sl = up.sleep;
    L.push(`${hrs(sl.S)} h a night, ${Math.round(sl.q * 100)}% restful on average${up.nightFire ? ', by a fire' : ''}${sl.cold ? `; chilled for about ${sl.cold} h of it` : ''}.`);
    if (sl.woke > 0.02) L.push(`On ${Math.round(sl.woke * 100)}% of nights the cold wakes you for good.`);
    if (sl.harm > 0.05) L.push(`Cold costs about ${fmt(Math.round(sl.harm * 10) / 10)} health a night, counted here as an hour each.`);
  }
  if (need === 'water') L.push(`${fmt(Math.round(up.W * 10) / 10)} L a day, ${up.water.how}.`);
  if (need === 'fire') {
    const f = up.fire;
    if (!f.mode) L.push('No way to make fire yet.');
    else if (!f.F) L.push('Not worth keeping a fire at the moment.');
    else L.push(`${hrs(f.F)} h of fire a day${up.nightFire ? ', mostly through the night' : ', for cooking and boiling'}${f.mode === 'keep' ? ', never let out (nothing to relight it with)' : f.light ? `; lighting it takes ~${hrs(f.light)} h` : ''}.`);
    if (f.short) L.push('Some of the wood comes from further afield and has to be carried back.');
  }
  if (need === 'repairs') for (const x of up.repairs.list) L.push(`${KINDS[x.kind].name} · ${fmt(Math.round(x.h * 100) / 100)} h a day`);
  return L;
}

function selectedCard(P, sel, up) {
  let title, meta, lines = '';
  if (sel.need) {
    title = NEED_NAMES[sel.need]; meta = `${hrs(up.parts[sel.need])} h a day`;
    lines = '<ul class="reqs">' + needLines(sel.need, up).map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>';
  } else {
    title = (sel.goal ? '★ ' : '') + sel.name;
    meta = sel.prog ? `${fmtTime(sel.needs)} left` : `needs ${hrs(sel.needs / 60)} h${sel.saves > 0.05 ? ` · saves ${hrs(sel.saves)} h/day · ${days(sel.horizon)}` : ''}`;
    const n = sel.node;
    if (n.recipe) {
      const st = recipeStatus(S, n.recipe, ui.choices[n.recipe.id] || {});
      lines = '<ul class="reqs">' + st.lines.filter((l) => !l.opt || l.ok).map((l) => {
        const via = l.ok ? null : l.input ? n.reqs.in[l.input] : l.cap ? n.reqs.tool[l.cap] : l.res ? n.reqs.res : null;
        const vn = via && P.node(via);
        const link = vn ? (vn.recipe ? ` <button class="link" data-ui="proj+:${via}">› ${esc(vn.name)}</button>` : ` <span class="muted">› ${esc(vn.name.toLowerCase())}</span>`) : '';
        return `<li class="req ${l.ok ? 'ok' : 'no'}">${esc(l.text)}${link}</li>`;
      }).join('') + '</ul>';
    }
  }
  const back = ui.projBack.length ? uibtn('‹', 'projBack', { cls: 'quiet small-btn' }) : '';
  return `<div class="selcard"><div class="selhead">${back}<div class="seltitle"><span class="item-name">${esc(title)}</span><span class="chip ${sel.ready || sel.need ? 'cap' : 'warm'}">${meta}</span></div>
    ${uibtn('×', 'projClear', { cls: 'quiet small-btn' })}</div>${lines}</div>`;
}

function projectsPane(P, ec, sel) {
  const up = ec.base;
  let list = ec.rows.filter((r) => !sel || r.key !== sel.key);
  if (sel && sel.need) list = list.filter((r) => r.by[sel.need] > 0.05).sort((a, b) => b.by[sel.need] - a.by[sel.need] || a.needs - b.needs);
  else list.sort(SORTS[ui.sort]);
  const rows = list.map((r) => {
    const sub = tagsOf(r).concat(r.wait > 60 ? [`+${fmtTime(r.wait)} waiting`] : []).join(' · ');
    return `<li><button class="row proj ${r.ready ? 'ready' : ''} ${r.goal ? 'goal' : ''}" data-ui="proj:${r.key}"><span class="row-name">${r.goal ? '★ ' : ''}${esc(r.name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`
      + `<span class="num">${r.prog ? '<i>…</i>' : ''}${hrs(r.needs / 60)}</span><span class="num">${hrs(r.saves)}</span><span class="num">${days(r.horizon)}</span></button></li>`;
  }).join('') || '<li class="muted small">Nothing you know how to make would change this here.</li>';
  const col = (k, label) => `<button class="num ${ui.sort === k && !(sel && sel.need) ? 'on' : ''}" data-ui="sort:${k}" title="sort by ${k}">${label}</button>`;
  const needs = NEEDS.map((k) => `<button class="need ${sel && sel.need === k ? 'on' : ''}" data-ui="proj:need:${k}"><span>${NEED_NAMES[k]}</span><b>${hrs(up.parts[k])}</b></button>`).join('');
  return `<section class="pane projects" aria-label="Projects">
    <div class="upkeep"><h2 class="pane-h">Upkeep <b>${hrs(up.U)} h a day</b><small>${isFinite(up.U) && up.U < 24 ? `${hrs(24 - up.U)} h free` : 'more than a day'}</small></h2><div class="needs">${needs}</div></div>
    ${sel ? selectedCard(P, sel, up) : ''}
    <div class="cols"><span>Project</span>${col('needs', 'needs h')}${col('saves', 'saves h/d')}${col('horizon', 'pays in')}</div>
    <ul class="rows" id="proj-list" data-keep-scroll>${rows}</ul></section>`;
}

function tasksPane(tasks) {
  const rows = tasks.map((t, i) => `<li><button class="row task ${t.front ? 'front' : ''} ${i === 0 ? 'first' : ''}" data-cmd="${esc(JSON.stringify(t.cmd))}">
      <span class="row-name">${esc(t.name)}${t.why ? `<small>${esc(t.why)}</small>` : ''}</span><span class="row-meta">${t.note ? esc(t.note) + ' · ' : ''}${fmtTime(t.minutes)}</span></button></li>`).join('');
  return `<section class="pane tasks" aria-label="Tasks"><h2 class="pane-h">Do now <small>${esc(here(S).name)}</small></h2><ul class="rows" id="task-list" data-keep-scroll>${rows}</ul></section>`;
}

function builtChip(it) {
  const k = kindOf(it);
  if (it.kind === 'fire') return chip(`fire ${fmt(it.q.fuel)} h`, 'warm');
  if (it.kind === 'embers') return chip(`embers ${fmt(it.q.heat)} h`, 'warm');
  if (it.proj) return chip(`unfinished ${it.proj.name}`, 'warm');
  if (k.trap) return chip(itemName(it) + ((it.in || []).length ? ' (something in it?)' : ''), '');
  if (it.proc) return chip(`${itemName(it)}, ready in ${fmtTime(it.proc.left)}`, 'warm');
  const miss = missingSlots(it);
  return chip(itemName(it), miss.length ? 'low' : '');
}

function stashPane() {
  const L = here(S);
  const loose = L.items.filter((it) => !kindOf(it).fixed && !it.proc).slice().reverse();
  const built = L.items.filter((it) => kindOf(it).fixed || it.proc);
  return `<section class="pane stash" aria-label="Stash"><div class="pane-h"><h2>Stash</h2>${uibtn('Inventory', 'inv', { cls: 'small-btn' })}</div>
    ${built.length ? `<div class="chips built">${built.map(builtChip).join('')}</div>` : ''}
    <div class="ground" id="ground" data-keep-scroll>${loose.length ? loose.map((it) => `<span class="gitem"><button class="gtake" data-cmd="${esc(JSON.stringify({ t: 'grab', id: it.id }))}">${esc(itemName(it))} <b>${amountText(it)}</b>${tierLabel(it) ? ` <i>${esc(tierLabel(it))}</i>` : ''}</button><button class="gx" aria-label="Move ${esc(itemName(it))} to the trash" data-cmd="${esc(JSON.stringify({ t: 'move', id: it.id, to: 'trash' }))}">×</button></span>`).join('') : '<span class="muted small">Nothing here yet.</span>'}</div></section>`;
}

function handStats(it) {
  const out = [];
  const caps = capsOf(it);
  Object.keys(caps).sort((a, b) => caps[b] - caps[a]).slice(0, 2).forEach((c) => out.push(`${CAP_NAMES[c] || c} ${caps[c]}`));
  const c = contSpec(it);
  if (c) out.push((it.in || []).length ? it.in.map((x) => `${kindOf(x).name} ${amountText(x)}`).join(', ') : `empty, holds ${fmt(c.vol)} L`);
  if (!out.length) for (const q of Q_ORDER) {
    if (it.q[q] == null || out.length >= 2) continue;
    if ((q === 'integrity' || q === 'fresh') && it.q[q] > 50) continue;
    if (q === 'smoked' || q === 'size' || q === 'retention') continue;
    out.push(`${q} ${Math.round(it.q[q])}`);
  }
  const m = massOf(it);
  if (kindOf(it).unit === 'ea' && m >= 0.3) out.push(`${fmt(m)} kg`);
  return out;
}

function handsBar() {
  const slots = [];
  for (const it of S.c.hands) { const h = handsFor(it); slots.push({ it, w: h }); }
  let html = '', used = 0;
  for (const { it, w } of slots) {
    used += w;
    html += `<button class="hand ${w === 2 ? 'both' : ''}" data-cmd="${esc(JSON.stringify({ t: 'move', id: it.id, to: 'ground' }))}" title="Set it down">
      <span class="hand-name">${esc(itemName(it))} <b>${amountText(it)}</b>${tierLabel(it) ? ` <i>${esc(tierLabel(it))}</i>` : ''}</span><span class="hand-stats">${handStats(it).map(esc).join(' · ')}</span></button>`;
  }
  for (; used < 2; used++) html += `<div class="hand empty"><span class="muted small">${used === 0 && !slots.length ? 'left' : 'right'} hand empty</span></div>`;
  const worn = S.c.worn.length ? `<div class="worn small muted">wearing ${S.c.worn.map((it) => esc(itemName(it))).join(', ')}</div>` : '';
  return `<footer class="hands" data-drop="hands">${html}${worn}</footer>`;
}

// ------------------------------------------------------------------ inventory
function invRow(it) {
  const k = kindOf(it);
  let extra = '';
  if (it.proc) extra += chip(`ready in ${fmtTime(it.proc.left)}`, 'warm');
  if (it.proj) extra += chip(`${Math.round(100 * (1 - it.proj.left / it.proj.total))}% done`, 'warm');
  let parts = '';
  if (k.slots) for (const sl in k.slots) {
    const p = it.parts && it.parts[sl], spec = slotSpec(it, sl);
    const opts = planInput(S, spec, null).cands.filter((c) => planInput(S, spec, c.id).ok);
    const sel = opts.length ? `<select data-replace="${it.id}:${sl}" aria-label="Replace ${esc(sl)}"><option value="">${p ? 'Replace…' : 'Fit…'}</option>${opts.map((o) => `<option value="${o.id}">${esc(itemName(o))} ${amountText(o)} ${briefQ(o)}</option>`).join('')}</select>` : '';
    parts += `<div class="part"><i>${esc(sl)}:</i> ${p ? `${esc(itemName(p))} ${amountText(p)} <span class="chips">${qualChips(p)}</span>` : `<span class="${spec.opt ? 'muted' : 'bad'}">${spec.opt ? 'none' : 'missing'}</span>`} ${sel}</div>`;
  }
  const c = contSpec(it);
  const fill = c && c.liquid && waterHere(S) && !k.fixed ? btn('Fill', { t: 'fill', id: it.id }, { cls: 'small-btn' }) : '';
  const apart = it.proj || k.slots || k.unset ? btn(it.proj ? 'Abandon' : 'Take apart', { t: 'dismantle', id: it.id }, { cls: 'quiet small-btn' }) : '';
  const wear = k.worn && !S.c.worn.includes(it) ? btn(k.cont ? 'Sling on' : 'Wear', { t: 'move', id: it.id, to: 'wear' }, { cls: 'small-btn' }) : '';
  const handle = k.fixed ? '<span class="handle off"></span>' : `<span class="handle" data-drag="${it.id}" aria-label="Drag ${esc(k.name)}">⠿</span>`;
  return `<li class="inv-item">${handle}<div class="inv-main"><span class="item-name">${esc(itemName(it))} <b>${amountText(it)}</b></span>
    <span class="chips">${capChips(it)}${contText(it)}${k.trap ? '' : qualChips(it)}${extra}</span>${parts}${fill || apart || wear ? `<div class="ctrl left">${wear}${fill}${apart}</div>` : ''}</div></li>`;
}
function invPanel(id, title, sub, list, drop) {
  const shut = ui.collapsed[id];
  return `<section class="inv-panel" data-drop="${drop}"><button class="inv-h" data-ui="collapse:${id}" aria-expanded="${!shut}"><span>${shut ? '▸' : '▾'} ${esc(title)}</span><span class="muted small">${sub}</span></button>
    ${shut ? '' : list.length ? `<ul>${list.map(invRow).join('')}</ul>` : '<p class="muted small empty-drop">Empty. Drag something here.</p>'}</section>`;
}
function inventoryPane() {
  const L = here(S);
  const panels = [invPanel('ground', 'Ground: ' + L.name, `${L.items.length} thing${L.items.length === 1 ? '' : 's'}`, L.items, 'ground'), invPanel('worn', 'Worn', S.c.worn.length ? '' : 'nothing', S.c.worn, 'wear')];
  for (const { it } of reach(S)) {
    const c = contSpec(it);
    if (!c || kindOf(it).trap) continue;
    panels.push(invPanel('c' + it.id, itemName(it), `${fmt(usedVol(it))} of ${fmt(c.vol)} L${c.liquid ? `, ${Math.round(c.ret)}% watertight` : c.mesh >= 1 ? `, gaps ${c.mesh} cm` : ''}`, it.in || [], it.id));
  }
  const trash = trashHere(S);
  panels.push(invPanel('trash', 'Trash', trash.length ? 'set aside here, out of the stash' : 'nothing set aside', trash, 'trash'));
  panels.push(invPanel('hands', 'In your hands', `${handsUsed(S)} of 2 hands · ${fmt(carriedMass(S))} of ${MAX_CARRY} kg carried`, S.c.hands, 'hands'));
  return `<section class="pane inventory" id="inv" data-keep-scroll><div class="pane-h"><h2>Inventory</h2>${uibtn('Done', 'inv', { cls: 'primary small-btn' })}</div>
    <p class="muted small">Drag the ⠿ handle onto a panel, or onto your hands below, to move as much as fits.</p>${panels.join('')}</section>`;
}

// ------------------------------------------------------------------ overlays (the older full views)
function overlay() {
  const O = { body: ['Body', () => header() + selfTab()], web: ['Technique web', planTab], places: ['Places and exploring', placeTab], journal: ['Journal', logView], guide: ['Guide', guideTab] }[ui.overlay];
  return `<div class="overlay ${ui.overlay}"><div class="ov-h"><h2>${O[0]}</h2>${uibtn('Close', 'overlay:', { cls: 'primary' })}</div><div class="ov-body">${O[1]()}</div></div>`;
}

function render() {
  const app = document.getElementById('app');
  const keep = {};
  document.querySelectorAll('[data-keep-scroll]').forEach((el) => { keep[el.id] = el.scrollTop; });
  const y = window.scrollY, wrap = document.getElementById('webwrap'), x = wrap ? wrap.scrollLeft : 0;
  if (S.dead) {
    app.innerHTML = `<section class="dead"><h2>You lasted ${dayOf(S) - 1} days.</h2><p>${{ thirst: 'Thirst', starvation: 'Starvation', exposure: 'Cold', injury: 'Injury and sickness' }[S.dead.cause]} ended it at ${esc(here(S).name.toLowerCase())}.</p>
      <div class="ctrl left">${uibtn('Wake again in a new world', 'new!', { cls: 'primary' })}${uibtn('Same world, from the start', 'again', {})}${uibtn('Read the journal', 'overlay:journal')}</div></section>${ui.overlay ? overlay() : ''}`;
    return;
  }
  if (ui.overlay) {
    app.innerHTML = overlay();
    const wrap2 = document.getElementById('webwrap');
    if (wrap2) wrap2.scrollLeft = x;
    window.scrollTo(0, y);
    drawEdges();
    if (ui.reveal) { ui.reveal = false; const d = document.getElementById('detail'); if (d) d.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  const { P, ec } = econNow();
  let sel = null;
  if (S.project && S.project.startsWith('need:')) sel = { need: S.project.slice(5) };
  else if (S.project) sel = ec.rows.find((r) => r.key === S.project) || null;
  if (S.project && !sel) S.project = null;
  const tasks = taskList(S, P, sel, ec.base);
  // pace the forecast on the first task that takes real time, not on a 3-minute drink
  const pace = tasks.find((x) => x.minutes >= 20) || tasks[0];
  const lines = runway(S, pace);
  app.innerHTML = `<div class="screen">${statusBar(lines, pace)}
    ${ui.inv ? inventoryPane() : projectsPane(P, ec, sel) + tasksPane(tasks) + stashPane()}
    ${handsBar()}</div>`;
  if (ui.resetProjScroll) { keep['proj-list'] = 0; keep['task-list'] = 0; ui.resetProjScroll = false; }
  for (const id in keep) { const el = document.getElementById(id); if (el) el.scrollTop = keep[id]; }
}

// The planner and the upkeep evaluator are rebuilt only when the game state
// (or the goals) changed, not on every tap that just changes the view.
let econCache = null;
function econNow() {
  const key = ui.ver + '|' + S.t + '|' + S.nextId + '|' + S.at + '|' + Object.keys(S.goals).join(',');
  const pick = S.project && !S.project.startsWith('need:') ? S.project : null;
  if (econCache && econCache.key === key && (!pick || econCache.ec.rows.some((r) => r.key === pick))) return econCache;
  const P = econCache && econCache.key === key ? econCache.P : makePlanner(S);
  return (econCache = { key, P, ec: projectRows(S, P, pick && P.has(pick) ? [pick] : []) });
}

// ------------------------------------------------------------------ input
function run(cmd) {
  if (ui.busy) return;
  const t0 = S.t, n0 = S.log.length;
  const res = act(S, cmd);
  ui.ver++;
  ui.notice = res.ok ? '' : res.msg || '';
  ui.fresh = S.log.length - n0;
  if (res.found) ui.view = res.found;
  if (res.done) {
    delete S.goals[res.done];
    // finishing the selected project closes it, or goes back up to the project it was a step toward
    if (S.project === res.done) { S.project = ui.projBack.pop() || null; ui.resetProjScroll = true; }
  }
  if (cmd.t === 'travel' && res.ok) ui.view = S.at;
  save();
  const elapsed = S.t - t0;
  const bar = document.getElementById('progress');
  if (!res.ok || elapsed < 4 || ui.fast || !bar || matchMedia('(prefers-reduced-motion: reduce)').matches) return render();
  // The waiting bar: purely cosmetic, the game state has already advanced.
  ui.busy = true;
  const ms = Math.min(1600, 220 + elapsed * 5);
  document.getElementById('app').classList.add('busy');
  bar.hidden = false;
  bar.firstElementChild.style.transition = `width ${ms}ms linear`;
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.firstElementChild.style.width = '100%'; }));
  setTimeout(() => { ui.busy = false; document.getElementById('app').classList.remove('busy'); render(); }, ms + 30);
}

function start(seed) {
  S = newGame(seed || randomSeed());
  Object.assign(ui, { overlay: null, menu: false, inv: false, projBack: [], tab: 'plan', sel: null, view: null, choices: {}, targets: {}, notice: '', confirmNew: false, fresh: 0 });
  S.choices = ui.choices;
  save(); render();
}

function uiAction(a, el) {
  const i = a.indexOf(':'), k = i < 0 ? a : a.slice(0, i), v = i < 0 ? '' : a.slice(i + 1);
  if (k === 'tab') ui.tab = v;
  else if (k === 'sel') { ui.sel = v || null; ui.tab = 'plan'; ui.reveal = !!v; }
  else if (k === 'planFilter') ui.planFilter = v;
  else if (k === 'goal') { if (el.checked) S.goals[v] = 1; else delete S.goals[v]; save(); }
  else if (k === 'sort') { ui.sort = v; try { localStorage.setItem(SORT_KEY, v); } catch (e) { /* not saved; fine */ } }
  else if (k === 'proj') { S.project = S.project === v && !ui.overlay ? null : v; ui.projBack = []; ui.overlay = null; ui.inv = false; ui.resetProjScroll = true; save(); }
  else if (k === 'proj+') { if (S.project) ui.projBack.push(S.project); S.project = v; ui.resetProjScroll = true; save(); }
  else if (k === 'projBack') { S.project = ui.projBack.pop() || null; ui.resetProjScroll = true; save(); }
  else if (k === 'projClear') { S.project = null; ui.projBack = []; ui.resetProjScroll = true; save(); }
  else if (k === 'overlay') { ui.overlay = v || null; ui.menu = false; window.scrollTo(0, 0); }
  else if (k === 'menu') ui.menu = !ui.menu;
  else if (k === 'theme') { ui.theme = { auto: 'light', light: 'dark', dark: 'auto' }[ui.theme]; applyTheme(); }
  else if (k === 'vitals') ui.vitals = !ui.vitals;
  else if (k === 'inv') ui.inv = !ui.inv;
  else if (k === 'collapse') ui.collapsed[v] = !ui.collapsed[v];
  else if (k === 'view') ui.view = v;
  else if (k === 'target') ui.targets[v] = !ui.targets[v];
  else if (k === 'hours') ui.hours = Number(v);
  else if (k === 'fast') ui.fast = el.checked;
  else if (k === 'new') { ui.seedDraft = (document.getElementById('seed-input') || {}).value || ''; ui.confirmNew = true; }
  else if (k === 'cancelNew') ui.confirmNew = false;
  else if (k === 'new!') return start(ui.seedDraft || '');
  else if (k === 'again') return start(S.seed);
  ui.notice = '';
  render();
}

// Dragging in the inventory. Pointer events rather than HTML drag-and-drop,
// which does not work on touch screens. Only the handle starts a drag, so
// the lists still scroll normally under a finger.
function setupDrag() {
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-drag]');
    if (!h || ui.busy) return;
    e.preventDefault();
    const row = h.closest('.inv-item');
    drag = { id: Number(h.dataset.drag), ghost: null, x: e.clientX, y: e.clientY, label: row.querySelector('.item-name').textContent };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'ghost';
      drag.ghost.textContent = drag.label;
      document.body.appendChild(drag.ghost);
    }
    drag.ghost.style.transform = `translate(${e.clientX + 8}px, ${e.clientY - 18}px)`;
    document.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest('[data-drop]');
    if (target) target.classList.add('drop-hover');
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.ghost) d.ghost.remove();
    document.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
    if (!d.ghost || e.type === 'pointercancel') return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest('[data-drop]');
    if (!target) return;
    const to = target.dataset.drop;
    run(to === 'hands' ? { t: 'grab', id: d.id } : { t: 'move', id: d.id, to: /^\d+$/.test(to) ? Number(to) : to });
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

export function boot(saved) {
  S = saved || load();
  if (S && S.v !== 1) S = null;
  if (S && !S.goals) S.goals = {};
  if (S) migrate(S);
  if (S && S.project) S.project = { 'x.eat': 'need:food', 'x.drink': 'need:water', 'x.sleep': 'need:sleep', 'r.add_fuel': 'need:fire' }[S.project] || S.project;
  if (S) { ui.choices = S.choices = S.choices || {}; }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd],[data-ui]');
    if (!el || el.disabled || ui.busy || el.tagName === 'INPUT') return;
    if (el.dataset.cmd) run(JSON.parse(el.dataset.cmd)); else uiAction(el.dataset.ui, el);
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.ui) return uiAction(el.dataset.ui, el);
    if (el.dataset.choose) { const [rid, input] = el.dataset.choose.split(':'); (ui.choices[rid] = ui.choices[rid] || {})[input] = el.value ? Number(el.value) : undefined; return render(); }
    if (!el.value) return;
    if (el.dataset.move) run({ t: 'move', id: Number(el.dataset.move), to: Number(el.value) });
    else if (el.dataset.replace) { const [id, slot] = el.dataset.replace.split(':'); run({ t: 'replace', id: Number(id), slot, with: Number(el.value) }); }
  });
  setupDrag();
  try { const th = localStorage.getItem(THEME_KEY); if (th === 'light' || th === 'dark') ui.theme = th; } catch (e) { /* default */ }
  try { const so = localStorage.getItem(SORT_KEY); if (SORTS[so]) ui.sort = so; } catch (e) { /* default */ }
  if (ui.theme !== 'auto') applyTheme();
  if (S) render(); else start();
  return () => freeze(S);
}

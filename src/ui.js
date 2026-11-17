// The interface: menus, tabs, buttons and lists. No game rules live here.
// render() rebuilds the page from state; clicks become command objects that
// go through act() in actions.js, the same door the tests use.

import { esc, fmt, fmtTime, clamp } from './util.js';
import { KINDS, UNIT, QUALITY_NOTE } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES, GROUPS, CAP_NAMES } from './data/recipes.js';
import { kindOf, itemName, amountText, massOf, contSpec, usedVol, whyNotHold, capsOf, reach, here, handsUsed, handsFor, carriedMass, missingSlots } from './items.js';
import { hourOf, dayOf, airTemp, feltTemp, isDark, sleepQuality } from './sim.js';
import { newGame, act, gatherStatus, recipeStatus, planInput, slotSpec, waterHere, trapsHere, travelInfo, MAX_CARRY } from './actions.js';
import { dist, bearing } from './world.js';
import { makePlanner } from './plan.js';

const SAVE_KEY = 'foothold-save-v1';
let S = null;
const ui = { tab: 'plan', sel: null, planFilter: 'all', edges: [], view: null, choices: {}, targets: {}, hours: 2, notice: '', busy: false, fast: false, confirmNew: false };

// ------------------------------------------------------------------ persistence
// JSON cannot hold Infinity; water sources have infinite abundance.
const freeze = (s) => JSON.stringify(s, (k, v) => (v === Infinity ? '__inf' : v));
export const thaw = (str) => JSON.parse(str, (k, v) => (v === '__inf' ? Infinity : v));
function save() { try { localStorage.setItem(SAVE_KEY, freeze(S)); } catch (e) { /* storage unavailable: play on without saving */ } }
function load() { try { const t = localStorage.getItem(SAVE_KEY); return t ? thaw(t) : null; } catch (e) { return null; } }
const randomSeed = () => Math.random().toString(36).slice(2, 8);

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
  const thirstWord = c.thirst < 0.5 ? 'quenched' : c.thirst < 1.5 ? 'thirsty' : c.thirst < 3 ? 'parched' : 'dangerously dry';
  const fatWord = c.fatigue < 25 ? 'fresh' : c.fatigue < 55 ? 'working' : c.fatigue < 80 ? 'tired' : 'exhausted';
  const chillWord = c.chill < 15 ? 'comfortable' : c.chill < 40 ? 'chilly' : c.chill < 70 ? 'cold' : 'hypothermic';
  const conds = c.cond.map((x) => chip(`${{ cut: 'cut hand', blister: 'blistered palms', sprain: 'sprained ankle', bruise: 'bruised', gastro: 'sick gut', burn: 'burn' }[x.type]} ${Math.round(x.sev)}`, 'low')).join('');
  return `<header class="top"><div class="title"><h1>Foothold</h1><span class="when">Day ${dayOf(S)} · ${clock(S.t)} · ${sky} · ${Math.round(T)} °C</span></div>
    <div class="vitals">
      ${meter('Food', food / 4000, foodWord, c.glyc <= 0 ? 'bad' : '')}
      ${meter('Reserves', c.fat / 60000, `${Math.round(days)} days of fat`, days < 5 ? 'bad' : '')}
      ${meter('Water', 1 - c.thirst / 5, thirstWord, c.thirst > 1.5 ? 'bad' : '')}
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
    <div class="ctrl">${goalBox(n)}${act1}${uibtn('Close', 'sel:', { cls: 'quiet' })}</div></div>${body}${chain}</section>`;
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
    <p><b>The Plan tab is a map of what is possible.</b> Further right means further off. Pick an action to see its requirements and the quickest route you know of; click an unmet requirement to jump to whatever supplies it. Tick Goal on what you are after and the steps toward it are marked.</p>
    <p><b>First day:</b> find water, pick up cobbles, look for stone that flakes, cut a sapling, twist cord, and get a fire and a bed together before dark.</p></section>
    <section><h3>This world</h3><p>Seed <code>${esc(S.seed)}</code>. The same seed always grows the same country.</p>
    <div class="ctrl left wrap"><input id="seed-input" type="text" maxlength="24" placeholder="seed for a new world" aria-label="Seed for a new world">
    ${ui.confirmNew ? uibtn('Really abandon this life?', 'new!', { cls: 'danger' }) + uibtn('Keep playing', 'cancelNew') : uibtn('Start a new game', 'new')}</div>
    <p><label class="check"><input type="checkbox" id="fast" data-ui="fast" ${ui.fast ? 'checked' : ''}> Skip the waiting bar</label></p>
    <p class="muted small">Progress is kept in this browser only.</p></section>`;
}

// ------------------------------------------------------------------ log and frame
function logView() {
  const rows = S.log.slice(-60).reverse().map((l, i) => `<li class="${l.cls} ${i < ui.fresh ? 'fresh' : ''}"><time>d${Math.floor(l.t / 1440) + 1} ${clock(l.t)}</time> ${esc(l.msg)}</li>`).join('');
  return `<aside class="log" aria-label="What has happened"><h3>Journal</h3><ol>${rows}</ol></aside>`;
}

function render() {
  const app = document.getElementById('app');
  const TABS = { plan: ['Plan', planTab], place: ['Places', placeTab], self: ['Self', selfTab], guide: ['Guide', guideTab] };
  let main;
  if (S.dead) {
    main = `<section class="dead"><h2>You lasted ${dayOf(S) - 1} days.</h2><p>${{ thirst: 'Thirst', starvation: 'Starvation', exposure: 'Cold', injury: 'Injury and sickness' }[S.dead.cause]} ended it at ${esc(here(S).name.toLowerCase())}.</p>
      <div class="ctrl left">${uibtn('Wake again in a new world', 'new!', { cls: 'primary' })}${uibtn('Same world, from the start', 'again', {})}</div></section>`;
  } else {
    main = `<nav class="tabs" aria-label="Sections">${Object.keys(TABS).map((t) => uibtn(TABS[t][0], 'tab:' + t, { on: ui.tab === t })).join('')}</nav><div class="panel">${TABS[ui.tab][1]()}</div>`;
  }
  const y = window.scrollY, wrap = document.getElementById('webwrap'), x = wrap ? wrap.scrollLeft : 0;
  app.innerHTML = `${header()}<div class="cols"><main>${main}</main>${logView()}</div>`;
  const wrap2 = document.getElementById('webwrap');
  if (wrap2) wrap2.scrollLeft = x;
  window.scrollTo(0, y);
  drawEdges();
  if (ui.reveal) { ui.reveal = false; const d = document.getElementById('detail'); if (d) d.scrollIntoView({ block: 'nearest' }); }
}

// ------------------------------------------------------------------ input
function run(cmd) {
  if (ui.busy) return;
  const t0 = S.t, n0 = S.log.length;
  const res = act(S, cmd);
  ui.notice = res.ok ? '' : res.msg || '';
  ui.fresh = S.log.length - n0;
  if (res.found) ui.view = res.found;
  if (cmd.t === 'recipe' && res.ok) delete S.goals['r.' + cmd.id];
  if (cmd.t === 'travel' && res.ok) ui.view = S.at;
  save();
  const elapsed = S.t - t0;
  if (!res.ok || elapsed < 4 || ui.fast || matchMedia('(prefers-reduced-motion: reduce)').matches) return render();
  // The waiting bar: purely cosmetic, the game state has already advanced.
  ui.busy = true;
  const bar = document.getElementById('progress');
  const ms = Math.min(1600, 220 + elapsed * 5);
  document.getElementById('app').classList.add('busy');
  bar.hidden = false;
  bar.firstElementChild.style.transition = `width ${ms}ms linear`;
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.firstElementChild.style.width = '100%'; }));
  setTimeout(() => { ui.busy = false; document.getElementById('app').classList.remove('busy'); render(); }, ms + 30);
}

function start(seed) {
  S = newGame(seed || randomSeed());
  Object.assign(ui, { tab: 'plan', sel: null, view: null, choices: {}, targets: {}, notice: '', confirmNew: false, fresh: 0 });
  save(); render();
}

function uiAction(a, el) {
  const i = a.indexOf(':'), k = i < 0 ? a : a.slice(0, i), v = i < 0 ? '' : a.slice(i + 1);
  if (k === 'tab') ui.tab = v;
  else if (k === 'sel') { ui.sel = v || null; ui.tab = 'plan'; ui.reveal = !!v; }
  else if (k === 'planFilter') ui.planFilter = v;
  else if (k === 'goal') { if (el.checked) S.goals[v] = 1; else delete S.goals[v]; save(); }
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

export function boot(saved) {
  S = saved || load();
  if (S && S.v !== 1) S = null;
  if (S && !S.goals) S.goals = {};
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
  if (S) render(); else start();
  return () => freeze(S);
}


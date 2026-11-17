// The interface: menus, tabs, buttons and lists. No game rules live here.
// render() rebuilds the page from state; clicks become command objects that
// go through act() in actions.js, the same door the tests use.

import { esc, fmt, fmtTime, clamp } from './util.js';
import { KINDS, UNIT, QUALITY_NOTE } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { RECIPES, GROUPS, CAP_NAMES } from './data/recipes.js';
import { kindOf, itemName, amountText, massOf, contSpec, usedVol, whyNotHold, capsOf, reach, here, handsUsed, carriedMass, missingSlots } from './items.js';
import { hourOf, dayOf, airTemp, feltTemp, isDark, sleepQuality } from './sim.js';
import { newGame, act, gatherStatus, recipeStatus, recipeVisible, planInput, slotSpec, waterHere, trapsHere, travelInfo, MAX_CARRY } from './actions.js';
import { dist, bearing } from './world.js';

const SAVE_KEY = 'foothold-save-v1';
let S = null;
const ui = { tab: 'place', view: null, group: 'All', showAll: false, choices: {}, targets: {}, hours: 2, notice: '', busy: false, fast: false, confirmNew: false };

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

// ------------------------------------------------------------------ make tab
function recipeCard(r, st) {
  const ch = ui.choices[r.id] || {};
  const lines = st.lines.map((l) => {
    let sel = '';
    if (l.input && l.plan.cands.length > 1) {
      sel = `<select data-choose="${r.id}:${l.input}" aria-label="Choose which to use"><option value="">best available</option>${l.plan.cands.map((c) => `<option value="${c.id}" ${String(ch[l.input]) === String(c.id) ? 'selected' : ''}>${esc(itemName(c))} ${amountText(c)} ${briefQ(c)}</option>`).join('')}</select>`;
    }
    const using = l.input && l.plan.ok && !sel ? ` <span class="muted">using ${esc(itemName(l.plan.first))} ${briefQ(l.plan.first)}</span>` : '';
    return `<li class="req ${l.ok ? 'ok' : l.opt ? 'opt' : 'no'}">${esc(l.text)}${using}${sel}</li>`;
  }).join('');
  const batch = st.k > 1.01 ? ` ×${fmt(st.k)}` : '';
  return `<li class="recipe ${st.ok ? '' : 'blocked'}"><div class="recipe-head"><span class="item-name">${esc(r.name)}${batch}</span>
    ${btn(st.time > 150 && !r.outdoor ? `Start (${fmtTime(st.time)} in all)` : fmtTime(st.time), { t: 'recipe', id: r.id, choose: ch }, { off: !st.ok, cls: 'primary' })}</div>
    <p class="muted small">${esc(r.desc || '')}</p><ul class="reqs">${lines}</ul></li>`;
}

function makeTab() {
  const shown = {};
  let hidden = 0;
  for (const id in RECIPES) {
    const r = RECIPES[id], st = recipeStatus(S, r, ui.choices[id] || {});
    if (ui.showAll || recipeVisible(S, r, st)) (shown[r.group] = shown[r.group] || []).push([r, st]); else hidden++;
  }
  const groups = GROUPS.filter((g) => shown[g]);
  if (ui.group !== 'All' && !shown[ui.group]) ui.group = 'All';
  const chips = ['All'].concat(groups).map((g) => uibtn(g === 'All' ? 'All' : `${g} <small>${shown[g].filter((x) => x[1].ok).length}/${shown[g].length}</small>`, 'group:' + g, { on: ui.group === g })).join('');
  const body = groups.filter((g) => ui.group === 'All' || ui.group === g).map((g) => {
    const list = shown[g].slice().sort((a, b) => b[1].ok - a[1].ok);
    return `<section><h3>${g}</h3><ul class="recipes">${list.map(([r, st]) => recipeCard(r, st)).join('')}</ul></section>`;
  }).join('');
  return `<nav class="subtabs" aria-label="Kinds of work">${chips}</nav>
    <p class="muted">You know how to do everything. Techniques appear here once you hold roughly half of what they need.
    <label class="check"><input type="checkbox" id="show-all" data-ui="showAll" ${ui.showAll ? 'checked' : ''}> Show all ${hidden + Object.values(shown).reduce((a, l) => a + l.length, 0)} techniques</label></p>
    ${body || '<p class="muted">Nothing to make yet. Gather some materials: stones, sticks, fiber.</p>'}`;
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
  const TABS = { place: ['Places', placeTab], make: ['Make', makeTab], self: ['Self', selfTab], guide: ['Guide', guideTab] };
  let main;
  if (S.dead) {
    main = `<section class="dead"><h2>You lasted ${dayOf(S) - 1} days.</h2><p>${{ thirst: 'Thirst', starvation: 'Starvation', exposure: 'Cold', injury: 'Injury and sickness' }[S.dead.cause]} ended it at ${esc(here(S).name.toLowerCase())}.</p>
      <div class="ctrl left">${uibtn('Wake again in a new world', 'new!', { cls: 'primary' })}${uibtn('Same world, from the start', 'again', {})}</div></section>`;
  } else {
    main = `<nav class="tabs" aria-label="Sections">${Object.keys(TABS).map((t) => uibtn(TABS[t][0], 'tab:' + t, { on: ui.tab === t })).join('')}</nav><div class="panel">${TABS[ui.tab][1]()}</div>`;
  }
  const y = window.scrollY;
  app.innerHTML = `${header()}<div class="cols"><main>${main}</main>${logView()}</div>`;
  window.scrollTo(0, y);
}

// ------------------------------------------------------------------ input
function run(cmd) {
  if (ui.busy) return;
  const t0 = S.t, n0 = S.log.length;
  const res = act(S, cmd);
  ui.notice = res.ok ? '' : res.msg || '';
  ui.fresh = S.log.length - n0;
  if (res.found) ui.view = res.found;
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
  Object.assign(ui, { tab: 'place', view: null, choices: {}, targets: {}, notice: '', confirmNew: false, fresh: 0 });
  save(); render();
}

function uiAction(a, el) {
  const [k, v] = a.split(':');
  if (k === 'tab') ui.tab = v;
  else if (k === 'view') ui.view = v;
  else if (k === 'group') ui.group = v;
  else if (k === 'target') ui.targets[v] = !ui.targets[v];
  else if (k === 'hours') ui.hours = Number(v);
  else if (k === 'showAll') ui.showAll = el.checked;
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


// The passage of time. Every action ends up calling advance(), which steps
// the clock in slices of at most 15 minutes and, each slice, updates:
//   the body      (calories, water, fatigue, cold, health, healing)
//   the weather
//   every item    (decay, wetting/drying, leaks, unattended processes, fires, traps)
//   every place   (regrowth of what was gathered)
// Places you are not at keep running: the meat on a distant rack still dries,
// the snare still catches, and the catch still spoils.

import { clamp, rand, pick } from './util.js';
import { KINDS } from './data/items.js';
import { RESOURCES } from './data/resources.js';
import { kindOf, capOf, contSpec, mk, here, itemName, wornIn } from './items.js';

export function say(s, msg, cls = '') {
  s.log.push({ t: s.t, msg, cls });
  if (s.log.length > 250) s.log.splice(0, s.log.length - 250);
}

export const hourOf = (s) => (s.t / 60) % 24;
export const dayOf = (s) => Math.floor(s.t / 1440) + 1;
export const isDark = (s) => { const h = hourOf(s); return h < 5 || h >= 21; };
export const raining = (s) => s.weather.kind === 'rain' || s.weather.kind === 'storm';

// ---- weather: a small Markov chain over spells of a few hours
const NEXT = {
  clear: ['clear', 'clear', 'clear', 'cloudy'], cloudy: ['clear', 'cloudy', 'cloudy', 'rain'],
  rain: ['cloudy', 'cloudy', 'rain', 'storm'], storm: ['rain', 'cloudy'],
};
const DT = { clear: 1, cloudy: 0, rain: -3, storm: -5 };
function tickWeather(s) {
  if (s.t < s.weather.until) return;
  const kind = pick(s.rng, NEXT[s.weather.kind]);
  if (kind !== s.weather.kind) {
    if (kind === 'rain') say(s, 'It begins to rain.', 'warn');
    else if (kind === 'storm') say(s, 'The wind rises. A storm breaks.', 'warn');
    else if (raining(s)) say(s, 'The rain stops.');
  }
  s.weather = { kind, dT: DT[kind], until: s.t + 180 + rand(s.rng) * 420 };
}

// ---- temperature
export function airTemp(s) {
  const e = here(s).env;
  return 17 - 9 * e.elev + 6 * Math.cos((2 * Math.PI * (hourOf(s) - 15)) / 24) + s.weather.dT;
}

function siteLevel(loc, cap) {
  let v = 0;
  for (const it of loc.items) v = Math.max(v, capOf(it, cap));
  return v;
}

// What the body experiences: air temperature adjusted for clothing, exertion,
// and (when at rest in camp) shelter, bedding and fire.
export function feltTemp(s, met, mode) {
  const loc = here(s);
  let T = airTemp(s) + (met - 1) * 2.5;
  let rainproof = false;
  for (const it of s.c.worn) {
    const w = kindOf(it).worn;
    if (w && w.warm) T += w.warm * Math.min(1, (it.q.integrity || 0) / 50);
    if (w && w.rain) rainproof = true;
  }
  const atCamp = mode !== 'travel';
  const resting = mode === 'sleep' || mode === 'rest';
  const fire = atCamp && siteLevel(loc, 'fire') > 0;
  let roofed = false;
  if (atCamp && resting) {
    T += (siteLevel(loc, 'shelter') / 100) * 7;
    roofed = siteLevel(loc, 'roof') >= 40;
    if (fire) T += 9;
    if (mode === 'sleep') T += (siteLevel(loc, 'bed') / 100) * 6 - 3; // bare ground steals heat
  } else if (fire && met < 3.5) T += 4;
  if (raining(s) && !roofed && !rainproof) T -= 5;
  return T;
}

export function sleepQuality(s) {
  const loc = here(s);
  let q = 0.45 + 0.2 * siteLevel(loc, 'bed') / 100 + 0.25 * siteLevel(loc, 'shelter') / 100;
  if (s.c.chill > 40) q -= 0.2;
  if (raining(s) && siteLevel(loc, 'roof') < 40) q -= 0.15;
  return clamp(q, 0.15, 1);
}

// ---- body
// ---- reserves, thresholds and impairment
// Each reserve has a comfort threshold and a harm threshold. Above the first
// nothing happens; you just get closer to it. Between the two you are
// distracted or weakened, and work, travel and injury odds suffer in
// proportion to how far below the line you are. Past the second, health
// itself starts to go.
//   food     quick energy (stomach + glycogen), kcal: hungry below 800; below 0 you live on fat
//   water    deficit in litres: thirsty and distracted past 1 L (about 1.5% of body mass,
//            where measurable impairment starts); harm past 4.5 L (about 6%)
//   stamina  fatigue 0..100: tired past 60, collapse at 100
//   warmth   chill 0..100: shivering and clumsy past 30, harm past 70
export const LIMITS = { food: { ok: 800, full: 3000 }, water: { ok: 1, harm: 4.5 }, stamina: { ok: 60, harm: 100 }, warmth: { ok: 30, harm: 70 } };

// Litres per hour: about 2.4 L a day at rest, several times that working hard.
export const thirstRate = (met, sick) => (0.1 + 0.12 * Math.max(0, met - 1)) * (sick ? 2.2 : 1);

export function impairment(s) {
  const c = s.c, L = LIMITS, why = [];
  let slow = 0, risk = 0;
  const E = c.stomach + c.glyc;
  if (E < L.food.ok) { slow += 0.15 * (1 - E / L.food.ok); why.push('hungry'); }
  if (E <= 0) { slow += 0.15; why[why.length - 1] = 'weak with hunger'; }
  if (c.thirst > L.water.ok) { const d = clamp((c.thirst - L.water.ok) / (L.water.harm - L.water.ok), 0, 1); slow += 0.3 * d; risk += 0.5 * d; why.push('thirsty'); }
  if (c.fatigue > L.stamina.ok) { const d = (c.fatigue - L.stamina.ok) / (L.stamina.harm - L.stamina.ok); slow += 0.4 * d; risk += d; why.push('tired'); }
  if (c.chill > L.warmth.ok) { const d = clamp((c.chill - L.warmth.ok) / (L.warmth.harm - L.warmth.ok), 0, 1); slow += 0.3 * d; risk += 0.5 * d; why.push('cold'); }
  return { slow: 1 + slow, risk: 1 + risk, why };
}

export function condSev(s, type) {
  const c = s.c.cond.find((x) => x.type === type);
  return c ? c.sev : 0;
}
const HEAL = { cut: 10, blister: 25, sprain: 8, bruise: 12, gastro: 28, burn: 9 };

function tickBody(s, h, met, mode) {
  const c = s.c;
  const sick = condSev(s, 'gastro') > 0;
  if (c.chill > 30) met += 0.4; // shivering
  // energy: stomach -> blood sugar/glycogen -> fat
  const digest = Math.min(c.stomach, 320 * h * (sick ? 0.5 : 1));
  c.stomach -= digest; c.glyc += digest * (sick ? 0.7 : 1);
  if (c.glyc > 2000) { c.fat += (c.glyc - 2000) * 0.9; c.glyc = 2000; }
  c.glyc -= met * 70 * h;
  if (c.glyc < 0) { c.fat += c.glyc; c.glyc = 0; }
  // water
  c.thirst += h * thirstRate(met, sick);
  // fatigue
  if (mode === 'sleep') c.fatigue -= 12 * sleepQuality(s) * h;
  else if (met <= 1.3) c.fatigue -= 3 * h;
  else {
    const strain = 1 + (c.glyc <= 0 ? 0.5 : 0) + (c.thirst > LIMITS.water.ok ? 0.4 : 0) + (c.chill > 50 ? 0.3 : 0) + (sick ? 0.4 : 0);
    c.fatigue += ((met - 1.2) * 2 + 0.6) * h * strain;
  }
  c.fatigue = clamp(c.fatigue, 0, 100);
  // cold
  const T = feltTemp(s, met, mode);
  if (T < 12) c.chill += (12 - T) * 0.9 * h; else c.chill -= ((T - 12) * 2 + 2) * h;
  c.chill = clamp(c.chill, 0, 100);
  // health
  const dmg = { thirst: c.thirst > LIMITS.water.harm ? (c.thirst - LIMITS.water.harm) * 1.5 * h : 0, starvation: c.fat <= 0 ? 1.5 * h : 0, exposure: c.chill > 70 ? (c.chill - 70) * 0.12 * h : 0, injury: 0 };
  for (const x of c.cond) {
    if (x.sev > 50) dmg.injury += 0.15 * h * (x.sev / 50);
    x.sev -= (HEAL[x.type] || 10) * (h / 24) * (met <= 1.3 ? 1.5 : 1) * (c.glyc > 0 ? 1 : 0.5);
  }
  c.cond = c.cond.filter((x) => x.sev > 0);
  const total = dmg.thirst + dmg.starvation + dmg.exposure + dmg.injury;
  if (total > 0) c.health -= total; else if (c.glyc > 0 && c.thirst < LIMITS.water.ok) c.health = Math.min(100, c.health + 0.3 * h);
  c.fat = Math.max(0, c.fat);
  if (c.health <= 0 && !s.dead) {
    c.health = 0;
    const cause = Object.keys(dmg).sort((a, b) => dmg[b] - dmg[a])[0];
    s.dead = { cause, t: s.t };
    say(s, { thirst: 'You die of thirst.', starvation: 'You starve.', exposure: 'The cold takes you.', injury: 'Your injuries overcome you.' }[cause], 'bad');
  }
}

// ---- items
// Returns true if the item has ceased to exist (rotted, broken, burned out).
function tickItem(s, it, env, h, cool, extra) {
  const k = kindOf(it);
  const d = h / 24;
  const slow = k.smokedSlows && it.q.smoked > 50 ? k.smokedSlows : 1;
  for (const src of [k.decay, extra]) {
    if (!src) continue;
    for (const q in src) if (it.q[q] != null) it.q[q] -= src[q] * d * slow * (q === 'fresh' && cool ? 0.4 : 1);
  }
  if (env.wet) { for (const q in k.rain || {}) it.q[q] -= k.rain[q] * d; }
  else for (const q in k.dries || {}) it.q[q] = Math.min(100, it.q[q] + k.dries[q] * d);
  for (const q in it.q) if (it.q[q] < 0) it.q[q] = 0;

  // leaky vessels
  const c = contSpec(it);
  if (c && c.liquid && it.in) {
    for (const w of it.in) if (kindOf(w).liquid) w.n -= w.n * ((100 - c.ret) / 100) * 0.15 * h;
    it.in = it.in.filter((w) => !(kindOf(w).liquid && w.n < 0.02));
  }

  // unattended processes: drying, leaching, charcoal burning
  if (it.proc && !(it.proc.needsDry && env.wet)) {
    it.proc.left -= h * 60;
    if (it.proc.left <= 0) {
      const p = it.proc;
      delete it.proc;
      if (p.to) {
        const nk = KINDS[p.to], old = it.q;
        it.kind = p.to; it.q = Object.assign({}, nk.q);
        for (const q in nk.q) if (q !== 'fresh' && old[q] != null) it.q[q] = old[q];
      }
      if (p.set) Object.assign(it.q, p.set);
      if (p.n) it.n = p.n; else if (p.y) it.n = Math.round(it.n * p.y * 100) / 100;
      say(s, `${p.name || itemName(it)} is ready${env.visible ? '' : ' at ' + env.loc.name}: ${itemName(it)}.`, 'good');
    }
  }

  // fire burns fuel, then lingers as embers, then leaves a little charcoal
  if (it.kind === 'fire') {
    it.q.fuel -= h * (env.hearth ? 0.7 : 1) * (env.wet ? (s.weather.kind === 'storm' ? 4 : 2) : 1);
    if (it.q.fuel <= 0) {
      it.kind = 'embers'; it.q = { heat: env.hearth ? 8 : 3 };
      if (env.visible) say(s, 'The fire has burned down to embers.', 'warn');
    }
  } else if (it.kind === 'embers') {
    it.q.heat -= h * (env.wet ? 3 : 1);
    if (it.q.heat <= 0) {
      it.kind = 'charcoal'; it.n = 0.15; it.q = {};
      if (env.visible) say(s, 'The embers have gone cold.', 'warn');
    }
  }

  // traps work on their own
  if (k.trap && !it.proj) {
    const t = k.trap, res = env.loc.res[t.res];
    const held = (it.in || []).length;
    const armed = t.multi ? held < t.multi : it.q.sprung < 50;
    const whole = !t.needs || (it.parts && it.parts[t.needs]);
    if (armed && whole && res && res.amt >= 1) {
      const norm = Math.min(1, res.amt / RESOURCES[t.res].cap);
      if (rand(s.rng) < t.rate * h * norm) {
        const strength = it.q.strength == null ? 100 : it.q.strength;
        if (rand(s.rng) > 0.5 + strength / 200) { it.q.sprung = 100; it.q.integrity -= 30; } // broke free
        else {
          (it.in = it.in || []).push(mk(s, pick(s.rng, t.catch), 1));
          res.amt -= 1;
          if (!t.multi) it.q.sprung = 100;
        }
      }
    }
    // a catch left too long is taken by scavengers
    if (it.in && it.in.length && rand(s.rng) < 0.01 * h) { it.in.shift(); it.q.robbed = 1; }
  }

  return (it.q.integrity != null && it.q.integrity <= 0) || (it.q.fresh != null && it.q.fresh <= 0);
}

function tickList(s, list, env, h, cool) {
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    const k = kindOf(it);
    if (tickItem(s, it, env, h, cool, null)) {
      list.splice(i, 1);
      if (it.in) for (const c of it.in) if (!kindOf(c).liquid) list.push(c);
      if (it.parts) for (const sl in it.parts) list.push(it.parts[sl]);
      if (env.visible) say(s, it.q.fresh != null ? `The ${k.name} has spoiled.` : `Your ${k.name} has fallen apart.`, 'warn');
      continue;
    }
    if (it.parts) for (const sl of Object.keys(it.parts)) {
      if (tickItem(s, it.parts[sl], env, h, cool, k.partDecay && k.partDecay[sl])) {
        const pk = kindOf(it.parts[sl]);
        delete it.parts[sl];
        if (env.visible) say(s, `The ${sl} (${pk.name}) of your ${k.name} has failed.`, 'warn');
      }
    }
    if (it.in) tickList(s, it.in, env, h, cool || (k.cont && k.cont.cool));
  }
}

function tickWorld(s, h) {
  const wet0 = raining(s);
  for (const id in s.locs) {
    const loc = s.locs[id];
    for (const rid in loc.res) {
      const r = loc.res[rid], def = RESOURCES[rid];
      if (def.regen && r.amt < r.cap) r.amt = Math.min(r.cap, r.amt + def.regen * (h / 24) * (r.amt + 0.03 * r.cap) * (1 - r.amt / r.cap) * 4);
    }
    if (!loc.items.length && !(loc.trash && loc.trash.length)) continue;
    const roofed = siteLevel(loc, 'roof') >= 40;
    const env = { loc, wet: wet0 && !roofed, hearth: siteLevel(loc, 'hearth') > 0, visible: id === s.at };
    tickList(s, loc.items, env, h, false);
    if (loc.trash && loc.trash.length) tickList(s, loc.trash, env, h, false);
  }
  const loc = here(s);
  const env = { loc, wet: wet0 && siteLevel(loc, 'roof') < 40, hearth: false, visible: true };
  tickList(s, s.c.hands, env, h, false);
  tickList(s, s.c.worn, env, h, false);
}

// Advance the clock. `met` is the metabolic intensity of what the character
// is doing; `mode` is 'act' | 'rest' | 'sleep' | 'travel'.
export function advance(s, minutes, met = 1.5, mode = 'act') {
  let left = minutes;
  while (left > 1e-6 && !s.dead) {
    const dt = Math.min(left, 15);
    left -= dt;
    tickWeather(s);
    tickBody(s, dt / 60, met, mode);
    tickWorld(s, dt / 60);
    s.t += dt;
  }
}

export const footwear = (s) => { const f = wornIn(s, 'feet'); return f ? kindOf(f).worn.feet : 0; };

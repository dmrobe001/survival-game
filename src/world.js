// Procedural world: a handful of smooth random fields over an abstract 2-D
// plane (kilometres). A "location" is a sample of those fields at one point,
// plus the resources its environment supports.
//
// Each field is a sum of random plane waves (a cheap Gaussian random field):
//     z(x, y) = sqrt(2/K) * sum_k cos(k_k . r + phi_k)
// which is ~N(0,1) at any point and correlated over the chosen wavelengths.
// Nearby places are therefore similar, far places are independent, and no
// map needs to be stored: the world is a pure function of the seed.

import { clamp, stream, rand, randn, pick } from './util.js';
import { RESOURCES } from './data/resources.js';

// [shortest, longest] wavelength in km. Broad fields vary slowly (you must
// travel to find different country); "deposit" fields vary quickly (an
// outcrop can be a short walk from none at all).
const FIELDS = {
  elev: [6, 16], water: [2.5, 8], canopy: [3, 9], rock: [2.5, 7],
  fert: [3, 9], conifer: [5, 14], flint: [1.2, 3.5], clay: [1.2, 3.5],
};
const K = 8;
const waveCache = {};

function waves(seed, name) {
  const key = seed + '|' + name;
  if (waveCache[key]) return waveCache[key];
  const st = stream('field|' + key);
  const [lo, hi] = FIELDS[name];
  const out = [];
  for (let i = 0; i < K; i++) {
    const lambda = lo * Math.pow(hi / lo, rand(st));
    const th = 2 * Math.PI * rand(st);
    const k = (2 * Math.PI) / lambda;
    out.push([k * Math.cos(th), k * Math.sin(th), 2 * Math.PI * rand(st)]);
  }
  return (waveCache[key] = out);
}

function z(seed, name, x, y) {
  let sum = 0;
  for (const [kx, ky, ph] of waves(seed, name)) sum += Math.cos(kx * x + ky * y + ph);
  return sum * Math.sqrt(2 / K);
}

const squash = (v) => 1 / (1 + Math.exp(-1.7 * v)); // N(0,1) -> roughly uniform 0..1

// Environment vector at a point. The couplings are what make places
// self-consistent: water collects low, rock shows high, forest thins on rock.
export function envAt(seed, x, y) {
  const ze = z(seed, 'elev', x, y);
  const zr = z(seed, 'rock', x, y) + 0.5 * ze;
  const zw = z(seed, 'water', x, y) - 0.6 * ze;
  const zc = z(seed, 'canopy', x, y) - 0.4 * zr + 0.2 * zw;
  return {
    elev: squash(ze), water: squash(zw), rock: squash(zr), canopy: squash(zc),
    fert: squash(z(seed, 'fert', x, y) + 0.3 * zw - 0.3 * zr),
    conifer: squash(z(seed, 'conifer', x, y) + 0.6 * ze),
    flint: clamp((squash(z(seed, 'flint', x, y)) - 0.55) / 0.4, 0, 1),
    clay: clamp((squash(z(seed, 'clay', x, y)) - 0.5) / 0.4, 0, 1),
  };
}

function placeName(e, st) {
  let noun;
  if (e.water > 0.85) noun = e.canopy > 0.55 ? 'swamp' : 'marsh';
  else if (e.water > 0.62) noun = e.canopy > 0.55 ? 'wooded stream' : 'stream bank';
  else if (e.rock > 0.75) noun = e.elev > 0.65 ? 'ridge' : 'outcrop';
  else if (e.canopy > 0.7) noun = e.conifer > 0.6 ? 'pine stand' : 'hardwood forest';
  else if (e.canopy > 0.42) noun = e.conifer > 0.6 ? 'open pinewood' : 'open woodland';
  else if (e.canopy > 0.22) noun = 'brushy clearing';
  else noun = e.fert > 0.55 ? 'meadow' : 'dry grassland';
  const adj = [];
  if (e.flint > 0.5) adj.push('flinty');
  if (e.clay > 0.5 && e.water > 0.4) adj.push('clay-banked');
  if (e.elev > 0.75) adj.push('high');
  else if (e.elev < 0.2) adj.push('low');
  if (e.rock > 0.6 && !/ridge|outcrop/.test(noun)) adj.push('stony');
  if (e.fert > 0.75) adj.push('lush');
  if (!adj.length) adj.push(pick(st, ['quiet', 'sheltered', 'windy', 'sunlit', 'shaded', 'broad', 'narrow']));
  const s = adj[0] + ' ' + noun;
  return s[0].toUpperCase() + s.slice(1);
}

// Generate the full description of the place at (x, y). Pure: same seed and
// coordinates always give the same place.
export function genLocation(seed, x, y) {
  x = Math.round(x * 100) / 100; y = Math.round(y * 100) / 100;
  const env = envAt(seed, x, y);
  const st = stream(`place|${seed}|${x}|${y}`);
  const res = {};
  for (const id in RESOURCES) {
    const def = RESOURCES[id];
    // Always draw the same number of randoms per resource so that adding a
    // resource to the library does not reshuffle every other one.
    const noise = Math.exp(0.45 * randn(st));
    const fill = 0.6 + 0.4 * rand(st);
    const q = {};
    for (const k in def.q) {
      if (def.qLate && def.qLate.includes(k)) continue;
      const spec = typeof def.q[k] === 'function' ? def.q[k](env) : def.q[k];
      q[k] = Math.round(clamp(spec[0] + spec[1] * randn(st), 3, 97));
    }
    if (def.qLate && def.qLate.length) {
      const st2 = stream(`late|${seed}|${x}|${y}|${id}`);
      for (const k of def.qLate) { const spec = typeof def.q[k] === 'function' ? def.q[k](env) : def.q[k]; q[k] = Math.round(clamp(spec[0] + spec[1] * randn(st2), 3, 97)); }
    }
    const a = clamp(def.habitat(env), 0, 1) * noise;
    if (a < 0.25) continue; // below this the place simply does not have it
    const cap = def.cap === Infinity ? Infinity : def.cap * Math.min(a, 1.6);
    res[id] = { cap, amt: cap === Infinity ? Infinity : cap * fill, q, known: false, assessed: false };
  }
  return { x, y, env, name: placeName(env, st), res, items: [], trash: [], roughness: 0.5 * env.rock + 0.3 * env.elev + 0.2 * env.water };
}

// How good is this place for a resource, 0..~1? Used to score exploration
// candidates: abundance relative to the library cap, scaled by key quality.
export function prospect(loc, rid) {
  const r = loc.res[rid];
  if (!r) return 0;
  const def = RESOURCES[rid];
  const abundance = def.cap === Infinity ? 1 : Math.min(1, r.cap / def.cap);
  const quality = def.keyQ ? r.q[def.keyQ] / 70 : 1;
  return abundance * quality;
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function bearing(from, to) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  return ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
}

// A survivable but unremarkable starting point: water, firewood, something to eat.
export function findStart(seed) {
  const st = stream('start|' + seed);
  let best = null, bestScore = -1;
  for (let i = 0; i < 300; i++) {
    const loc = genLocation(seed, (rand(st) - 0.5) * 40, (rand(st) - 0.5) * 40);
    const r = loc.res;
    if (!r.water || !r.deadwood) continue;
    const food = ['berries', 'tubers', 'greens', 'acorns', 'nuts', 'shellfish'].filter((k) => r[k]).length;
    const score = food + (r.cobbles ? 1 : 0) + (r.fiber_plants ? 1 : 0) - 2 * loc.env.flint - Math.abs(loc.env.canopy - 0.55);
    if (score > bestScore) { best = loc; bestScore = score; }
    if (score >= 5) break;
  }
  return best || genLocation(seed, 0, 0);
}

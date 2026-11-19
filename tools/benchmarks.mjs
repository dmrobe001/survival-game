// Benchmarks: whole-task times that the game's numbers should reproduce,
// shared by the test suite (test/calibration.mjs) and the calibration report
// (tools/calibrate.mjs). Each has a plausible range and the basis for it.
// Ranges are judgment informed by survival practice and experimental
// archaeology, not measurements; tighten them as better figures turn up.
//
// They run at synthetic "typical" places: one environment vector, every
// resource it supports at its expected amount and mean quality, all known.

import { newGame, gatherStatus } from '../src/actions.js';
import { RESOURCES } from '../src/data/resources.js';
import { here } from '../src/items.js';
import { makePlanner, typical } from '../src/plan.js';
import { upkeep } from '../src/econ.js';
import { clamp } from '../src/util.js';

export const PLACES = {
  woodland: { elev: 0.3, water: 0.55, canopy: 0.7, rock: 0.4, fert: 0.5, conifer: 0.2, flint: 0.35, clay: 0.35 },
  meadow: { elev: 0.35, water: 0.5, canopy: 0.25, rock: 0.3, fert: 0.65, conifer: 0.2, flint: 0.3, clay: 0.3 },
};

// A fresh character at a typical place, holding the given kinds (typical pieces).
export function typicalState(place, kit = [], doy = 200) {
  const s = newGame('calibration');
  s.doy0 = doy; // the day of the year the benchmark is set on
  const L = here(s), env = PLACES[place];
  Object.assign(L, { env, name: 'typical ' + place, res: {}, surveys: 3, items: [] });
  for (const id in RESOURCES) {
    const def = RESOURCES[id], a = clamp(def.habitat(env), 0, 1);
    if (a < 0.25) continue;
    const cap = def.cap === Infinity ? Infinity : def.cap * Math.min(a, 1.6), q = {};
    for (const k in def.q) q[k] = (typeof def.q[k] === 'function' ? def.q[k](env) : def.q[k])[0];
    L.res[id] = { cap, amt: cap * (def.season ? def.stock[doy] : 1), q, known: true, assessed: true };
  }
  for (const k of kit) L.items.push(Object.assign(JSON.parse(JSON.stringify(typical(k))), { id: s.nextId++ }));
  return s;
}

const hours = (n) => (isFinite(n.total) ? n.steps.reduce((a, st) => a + st.minutes, 0) / 60 : Infinity);
const plan = (key) => (s) => hours(makePlanner(s).node(key));
const CAMP = ['cobble', 'flake', 'stalk', 'hearth_board', 'bed', 'debris_hut'];

export const BENCH = [
  { name: 'Find a stone to crack nuts with', place: 'woodland', unit: 'h', range: [0, 0.17], get: plan('g.cobbles'),
    basis: 'loose stones are everywhere along streams and paths: minutes, not half an hour' },
  { name: 'Bedding pile, from nothing', place: 'woodland', unit: 'h', range: [0.15, 0.75], get: plan('r.build_bed'),
    basis: 'a few armfuls of leaf litter heaped and fluffed' },
  { name: 'Debris hut, from nothing', place: 'woodland', unit: 'h', range: [2, 5], get: plan('r.build_debris_hut'),
    basis: 'survival manuals commonly quote 2-3 hours with materials close by' },
  { name: 'Lean-to, from nothing', place: 'woodland', unit: 'h', range: [1.5, 5], get: plan('r.build_lean_to'),
    basis: 'ridge pole, uprights, rafters and a thick cover' },
  { name: 'Knap flakes, from nothing', place: 'woodland', unit: 'h', range: [0.25, 1.5], get: plan('r.knap_flakes'),
    basis: 'find a hammerstone and a nodule, a few minutes of striking' },
  { name: 'First friction fire, from nothing', place: 'woodland', unit: 'h', range: [1, 6], get: plan('r.light_fire'),
    basis: 'make board and spindle, gather tinder and kindling, several tries' },
  { name: 'Hafted stone axe, from nothing', place: 'woodland', unit: 'h', range: [2, 10], get: plan('r.build_stone_axe'),
    basis: 'a knapped head, a haft, cordage lashing (experimental archaeology: hours, not days)' },
  { name: 'Five metres of cordage, from nothing', place: 'woodland', unit: 'h', range: [0.75, 3], get: plan('r.cordage'),
    basis: 'gathering and stripping fibre, then reverse-wrapping a few metres an hour' },
  { name: 'Firewood for a night by a fire (25 kg)', place: 'woodland', unit: 'h', range: [0.75, 3], get: (s) => 25 / gatherStatus(s, 'deadwood').rate,
    basis: 'dead wood is abundant in woodland; armloads of 5-10 kg' },
  { name: 'A day\'s food from nuts in autumn, with a hammerstone', place: 'woodland', kit: ['cobble'], doy: 280, unit: 'h', range: [1.2, 6], get: (s) => upkeep(s).now.parts.food,
    basis: 'ethnographic nut return rates: roughly 1,000-2,500 kcal per hour once processed, more in a rich autumn' },
  { name: 'Sleep on bare ground', place: 'woodland', unit: 'h', range: [9, 15], get: (s) => upkeep(s).sleep.S,
    basis: 'cold, broken sleep: long hours for little rest' },
  { name: 'Sleep in a debris hut on a bed', place: 'woodland', kit: ['bed', 'debris_hut'], unit: 'h', range: [6.5, 9.5], get: (s) => upkeep(s).sleep.S,
    basis: 'a warm, dry night' },
  { name: 'Water a day', place: 'woodland', unit: 'L', range: [3, 6], get: (s) => upkeep(s).W,
    basis: 'about 2.5 L at rest, more with work' },
  { name: 'Upkeep in summer with a basic camp', place: 'woodland', kit: CAMP, unit: 'h', range: [10, 17], get: (s) => upkeep(s).now.U,
    basis: 'with tools, fire, bed and hut, staying alive should leave a good part of the day free' },
];

export function runBench(b) {
  const v = b.get(typicalState(b.place, b.kit || [], b.doy));
  return { v, ok: v >= b.range[0] && v <= b.range[1] };
}

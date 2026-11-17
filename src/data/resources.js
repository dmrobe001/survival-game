// Natural resources: things a place "has", as opposed to items you hold.
//
// Each resource declares a habitat function over the place's environment
// vector (all components 0..1). World generation multiplies habitat
// suitability by lognormal noise to get the local carrying capacity, so the
// mix of resources at a place is self-consistent: reeds only where it is wet,
// resin only under conifers, good toolstone only on a flint outcrop.
//
// Fields:
//   habitat(env) -> suitability 0..1
//   cap          carrying capacity at suitability 1, in units of the gathered item
//   regen        logistic regrowth rate per day (0 for minerals)
//   vis          chance it is noticed on arrival; the rest need a deliberate search
//   q            deposit-level quality distribution {quality: [mean, sd]} or env => [mean, sd]
//   keyQ         quality that matters most when exploring for this resource
//   gather       {kind, rate (units/hour at full abundance), tool:{cap,min}, boost:{cap,per}, met, risk}

import { clamp } from '../util.js';

export const RESOURCES = {};
const R = (id, o) => { RESOURCES[id] = Object.assign({ id, regen: 0, vis: 1, q: {} }, o); };
const ramp = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);

// ---- water ----
R('water', { name: 'Surface water', habitat: (e) => ramp(e.water, 0.42, 0.6), cap: Infinity, keyQ: 'purity',
  q: { purity: (e) => [48 + 35 * e.elev - 25 * ramp(e.water, 0.8, 1), 10] },
  note: 'Streams, seeps and ponds. Clearer and safer higher up; stagnant in marshy ground.' });

// ---- wood ----
R('deadwood', { name: 'Dead wood', habitat: (e) => e.canopy, cap: 350, regen: 0.01,
  q: { dryness: [62, 12] }, gather: { kind: 'firewood', rate: 12, met: 3.5 } });
R('twigs', { name: 'Twigs and small sticks', habitat: (e) => e.canopy, cap: 60, regen: 0.03,
  q: { dryness: [62, 12] }, gather: { kind: 'kindling', rate: 4, met: 2.5 } });
R('branches', { name: 'Stout branches', habitat: (e) => e.canopy, cap: 40, regen: 0.01, keyQ: 'straightness',
  q: { straightness: [45, 12] }, gather: { kind: 'pole', rate: 5, met: 4, boost: { cap: 'chop', per: 60 } } });
R('saplings', { name: 'Straight saplings', habitat: (e) => 0.8 * e.canopy + 0.2 * e.water, cap: 25, regen: 0.01, vis: 0.9, keyQ: 'straightness',
  q: { straightness: [60, 12], hardness: [35, 8] }, gather: { kind: 'shaft', rate: 3, met: 3.5, tool: { cap: 'cut', min: 10 } } });
R('softwood', { name: 'Dead softwood limbs', habitat: (e) => Math.max(e.water * e.canopy * 1.4, e.conifer * e.canopy), cap: 12, regen: 0.01, vis: 0.6, keyQ: 'softness',
  q: { softness: [60, 15], dryness: [60, 14] }, gather: { kind: 'softwood', rate: 2, met: 3 },
  note: 'Willow, cedar, basswood: wood soft enough to dent with a thumbnail, for friction fire.' });
R('stalks', { name: 'Dry weed stalks', habitat: (e) => (1 - e.canopy) * (0.3 + 0.7 * e.fert), cap: 30, regen: 0.02, vis: 0.6, keyQ: 'straightness',
  q: { straightness: [62, 12], dryness: [65, 12] }, gather: { kind: 'stalk', rate: 8, met: 2.5 },
  note: 'Mullein, cattail, yucca and the like: hand-drill spindles.' });
R('logs', { name: 'Sound fallen logs', habitat: (e) => e.canopy * 0.9, cap: 6, regen: 0.002, vis: 0.9,
  gather: { kind: 'log', rate: 0.7, met: 6, tool: { cap: 'chop', min: 40 } } });
R('bark', { name: 'Peelable bark', habitat: (e) => e.canopy * (1 - 0.5 * e.conifer), cap: 20, regen: 0.005, vis: 0.8, keyQ: 'flex',
  q: { flex: [65, 10] }, gather: { kind: 'bark_sheet', rate: 2.5, met: 3, tool: { cap: 'cut', min: 20 } } });
R('resin', { name: 'Conifer resin', habitat: (e) => e.canopy * ramp(e.conifer, 0.35, 0.8), cap: 3, regen: 0.01, vis: 0.5,
  gather: { kind: 'resin', rate: 0.2, met: 2.5 } });

// ---- soft plant material ----
R('grass', { name: 'Tall grass', habitat: (e) => 1 - e.canopy, cap: 200, regen: 0.03,
  q: { dryness: [40, 15] }, gather: { kind: 'grass', rate: 6, met: 3, boost: { cap: 'cut', per: 80 } } });
R('leaves', { name: 'Leaf litter', habitat: (e) => e.canopy, cap: 300, regen: 0.01,
  gather: { kind: 'leaves', rate: 10, met: 3 } });
R('reeds', { name: 'Reeds and cattails', habitat: (e) => ramp(e.water, 0.6, 0.95), cap: 150, regen: 0.03,
  gather: { kind: 'reeds', rate: 5, met: 3.5, boost: { cap: 'cut', per: 60 } } });
R('withies', { name: 'Flexible shoots', habitat: (e) => 0.7 * e.water + 0.3 * e.canopy - 0.2, cap: 300, regen: 0.03, vis: 0.8, keyQ: 'flex',
  q: { flex: [80, 8] }, gather: { kind: 'withies', rate: 50, met: 3, boost: { cap: 'cut', per: 60 } },
  note: 'Willow, dogwood, hazel: basketry and wattle.' });
R('fiber_plants', { name: 'Fiber plants', habitat: (e) => e.fert * (1 - 0.6 * e.canopy), cap: 4, regen: 0.03, vis: 0.6, keyQ: 'strength',
  q: { strength: [55, 12] }, gather: { kind: 'fiber', rate: 0.25, met: 2.5 },
  note: 'Nettle, dogbane, milkweed: stripped and cleaned into raw fiber as you go.' });

// ---- plant foods ----
R('greens', { name: 'Edible greens', habitat: (e) => e.fert, cap: 8, regen: 0.15, vis: 0.8,
  gather: { kind: 'greens', rate: 1, met: 2.5 } });
R('berries', { name: 'Berries', habitat: (e) => e.fert * (1 - 2 * Math.abs(e.canopy - 0.45)), cap: 10, regen: 0.08, vis: 0.7,
  gather: { kind: 'berries', rate: 0.9, met: 2.5, boost: { cap: 'bag', per: 16 } } });
R('nuts', { name: 'Nut trees', habitat: (e) => e.canopy * (1 - e.conifer) * 0.8, cap: 12, regen: 0.02, vis: 0.6,
  gather: { kind: 'nuts', rate: 1.5, met: 2.5, boost: { cap: 'bag', per: 16 } } });
R('acorns', { name: 'Acorns', habitat: (e) => e.canopy * (1 - e.conifer) * 0.9, cap: 30, regen: 0.02, vis: 0.7,
  gather: { kind: 'acorns', rate: 3, met: 2.5, boost: { cap: 'bag', per: 16 } } });
R('seeds', { name: 'Seeding grasses', habitat: (e) => (1 - e.canopy) * e.fert, cap: 6, regen: 0.03, vis: 0.6,
  gather: { kind: 'seeds', rate: 0.35, met: 2.5, boost: { cap: 'bag', per: 10 } } });
R('tubers', { name: 'Roots and tubers', habitat: (e) => Math.max(0.7 * e.fert, 0.8 * ramp(e.water, 0.5, 0.9)), cap: 15, regen: 0.03, vis: 0.35,
  gather: { kind: 'tubers', rate: 0.5, met: 4, boost: { cap: 'dig', per: 25 } },
  note: 'Slow with bare hands. A digging stick multiplies the take.' });

// ---- animals ----
R('eggs', { name: 'Bird nests', habitat: (e) => 0.25 + 0.35 * e.canopy, cap: 10, regen: 0.1, vis: 0.15,
  gather: { kind: 'eggs', rate: 3, met: 3, risk: [{ type: 'sprain', p: 0.02, sev: [10, 30] }] } });
R('grubs', { name: 'Grubs and insects', habitat: (e) => e.canopy, cap: 3, regen: 0.1, vis: 0.4,
  gather: { kind: 'grubs', rate: 0.25, met: 3, boost: { cap: 'dig', per: 50 } } });
R('shellfish', { name: 'Mussels and crayfish', habitat: (e) => ramp(e.water, 0.6, 0.9), cap: 15, regen: 0.05, vis: 0.5,
  gather: { kind: 'shellfish', rate: 2, met: 3 } });
R('fish', { name: 'Fish', habitat: (e) => ramp(e.water, 0.55, 0.85), cap: 30, regen: 0.05, vis: 0.6,
  note: 'Taken with a fish spear, hook and line, basket trap or weir.' });
R('small_game', { name: 'Small game sign', habitat: (e) => 0.3 + 0.4 * e.canopy + 0.2 * e.fert, cap: 20, regen: 0.04, vis: 0.4,
  note: 'Rabbit runs, droppings, grouse dusting spots. Snares, deadfalls or a thrown stick.' });
R('large_game', { name: 'Large game sign', habitat: (e) => 0.15 + 0.45 * e.canopy, cap: 4, regen: 0.02, vis: 0.3,
  note: 'Deer trails. You will want a real spear.' });

// ---- minerals ----
R('cobbles', { name: 'Cobbles', habitat: (e) => Math.max(e.rock, 0.8 * ramp(e.water, 0.5, 0.8)), cap: 200, keyQ: 'hardness',
  q: { hardness: [60, 14], thermal: (e) => [72 - 40 * e.water, 12] }, gather: { kind: 'cobble', rate: 15, met: 3 },
  note: 'Hammerstones, cooking stones, hearth rings. Water-worn stones tend to crack when heated.' });
R('toolstone', { name: 'Knappable stone', habitat: (e) => Math.max(e.flint, 0.45 * e.rock), cap: 40, vis: 0.5, keyQ: 'knappability',
  q: { knappability: (e) => [28 + 55 * e.flint, 10] }, gather: { kind: 'toolstone', rate: 3, met: 3 },
  note: 'Anything that breaks with a shell-shaped fracture. Quality varies enormously from place to place.' });
R('slabs', { name: 'Flat slabs', habitat: (e) => e.rock, cap: 15, vis: 0.8,
  q: { hardness: [60, 14] }, gather: { kind: 'slab', rate: 2, met: 4 } });
R('clay', { name: 'Clay bank', habitat: (e) => e.clay * ramp(e.water, 0.3, 0.6), cap: 300, vis: 0.4, keyQ: 'plasticity',
  q: { plasticity: [60, 15] }, gather: { kind: 'clay', rate: 6, met: 4.5, boost: { cap: 'dig', per: 40 } } });

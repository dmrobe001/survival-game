// Natural resources: things a place "has", as opposed to items you hold.
//
// Each resource declares a habitat function over the place's environment
// vector (all components 0..1). World generation multiplies habitat
// suitability by lognormal noise to get the local amount, so the mix of
// resources at a place is self-consistent: reeds only where it is wet,
// resin only under conifers, good toolstone only on a flint outcrop.
//
// Collecting follows Holling's disc equation (search plus handling):
//
//   units per hour = a·D·p / (1 + a·D·p·h)
//
//   a  area searched per hour = speed (km/h) x sweep width (m) / 10, in ha/h
//   D  units per hectare at this place right now (amount / PLACE_HA)
//   p  fraction good enough for the job (1 when you take anything)
//   h  handling hours per unit, divided by (1 + boost/per) with a helping tool
//
// So scarce things are slow because you search, common things because you
// handle them, and a stricter requirement only costs search time.
//
// Fields:
//   habitat(env) -> suitability 0..1
//   find         {density (units/ha at suitability 1, year-averaged), sweep (m),
//                 speed (km/h while searching), handle (minutes per unit),
//                 perYear (fraction of a full stock that regrows in a year), why}
//                The place's full amount (cap) is density x PLACE_HA, and the
//                logistic regrowth rate is set so the most it can give for ever
//                is perYear x cap a year. All are judgment calls; see
//                docs/CALIBRATION.md for the derived rates and the checks.
//   season       {grow: share of the year's production in each month, loss: share of
//                the standing stock lost a day to animals and rot}. For these, density
//                is the peak, perYear is set so the stock just reaches it, and stock[day]
//                is the expected standing fraction through the year.
//   cap, regen   for animals (not collected by hand): count per place, logistic rate per day
//   vis          chance it is noticed on arrival; the rest need a deliberate search
//   q            deposit-level quality distribution {quality: [mean, sd]} or env => [mean, sd]
//   q2           the same, for qualities added later (drawn separately so existing worlds do not change)
//   keyQ         quality that matters most when exploring for this resource
//   gather       {kind, tool:{cap,min}, boost:{cap,per}, met, risk}; rate is derived

import { clamp } from '../util.js';
import { stockProfile } from '../calendar.js';

export const RESOURCES = {};
const R = (id, o) => { RESOURCES[id] = Object.assign({ id, regen: 0, vis: 1, q: {} }, o); };
const ramp = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);

export const PLACE_HA = 20; // a place is what lies within ~250 m: places are found at least 500 m apart

// Units per hour of collecting at density D (units/ha), with a helping tool
// at `boost` and a fraction `p` of what you find good enough.
// How much of a ground-level resource snow leaves findable, by the day's
// mean temperature: all of it above 3 °C, only def.find.snow below -1 °C.
export function snowFactor(def, meanT) {
  const g = def.find && def.find.snow;
  if (g == null) return 1;
  const f = clamp((meanT + 1) / 4, 0, 1);
  return g + (1 - g) * f;
}

export function encounter(def, D, boost = 0, p = 1) {
  const f = def.find, g = def.gather;
  if (!f || !(D > 0) || !(p > 0)) return 0;
  const a = (f.speed * f.sweep) / 10, h = f.handle / 60 / (g && g.boost ? 1 + boost / g.boost.per : 1);
  const found = a * D * p;
  return found / (1 + found * h);
}

// ---- water ----
R('water', { name: 'Surface water', habitat: (e) => ramp(e.water, 0.42, 0.6), cap: Infinity, keyQ: 'purity',
  q: { purity: (e) => [48 + 35 * e.elev - 25 * ramp(e.water, 0.8, 1), 10] },
  note: 'Streams, seeps and ponds. Clearer and safer higher up; stagnant in marshy ground.' });

// ---- wood ----
R('deadwood', { find: { snow: 0.6, density: 3000, sweep: 10, speed: 1.5, handle: 3, perYear: 0.5, why: 'dead wood thin enough to break or drag' }, name: 'Dead wood', habitat: (e) => e.canopy,   q: { dryness: [62, 12] }, gather: { kind: 'firewood', met: 3.5 } });
R('twigs', { find: { snow: 0.5, density: 600, sweep: 6, speed: 1.2, handle: 5, perYear: 1 }, name: 'Twigs and small sticks', habitat: (e) => e.canopy,   q: { dryness: [62, 12] }, gather: { kind: 'kindling', met: 2.5 } });
R('branches', { find: { density: 40, sweep: 15, speed: 1.5, handle: 3, perYear: 0.3, why: 'fallen limbs 2-3 m long and a few cm thick' }, name: 'Stout branches', habitat: (e) => e.canopy, keyQ: 'straightness',
  q: { straightness: [45, 12] }, q2: { strength: [50, 15] }, gather: { kind: 'pole', met: 4, boost: { cap: 'chop', per: 60 } } });
R('saplings', { find: { density: 150, sweep: 8, speed: 1, handle: 8, perYear: 0.2, why: 'straight stems 2-4 cm, cut and trimmed' }, name: 'Straight saplings', habitat: (e) => 0.8 * e.canopy + 0.2 * e.water, vis: 0.9, keyQ: 'straightness',
  q: { straightness: [60, 12], hardness: [35, 8] }, gather: { kind: 'shaft', met: 3.5, tool: { cap: 'cut', min: 10 } } });
R('softwood', { find: { density: 8, sweep: 12, speed: 1.5, handle: 6, perYear: 0.2 }, name: 'Dead softwood limbs', habitat: (e) => Math.max(e.water * e.canopy * 1.4, e.conifer * e.canopy), vis: 0.6, keyQ: 'softness',
  q: { softness: [60, 15], dryness: [60, 14] }, gather: { kind: 'softwood', met: 3 },
  note: 'Willow, cedar, basswood: wood soft enough to dent with a thumbnail, for friction fire.' });
R('stalks', { find: { density: 200, sweep: 5, speed: 1.2, handle: 1, perYear: 1, why: 'only the straight, dry ones' }, name: 'Dry weed stalks', habitat: (e) => (1 - e.canopy) * (0.3 + 0.7 * e.fert), vis: 0.6, keyQ: 'straightness',
  q: { straightness: [62, 12], dryness: [65, 12] }, gather: { kind: 'stalk', met: 2.5 },
  note: 'Mullein, cattail, yucca and the like: hand-drill spindles.' });
R('logs', { find: { density: 4, sweep: 20, speed: 1.5, handle: 60, perYear: 0.05, why: 'handling is chopping one to length' }, name: 'Sound fallen logs', habitat: (e) => e.canopy * 0.9, vis: 0.9,
  gather: { kind: 'log', met: 6, tool: { cap: 'chop', min: 40 } } });
R('bark', { find: { density: 80, sweep: 10, speed: 1, handle: 15, perYear: 0.1, why: 'trees that will peel; handling is scoring and prying a sheet' }, name: 'Peelable bark', habitat: (e) => e.canopy * (1 - 0.5 * e.conifer), vis: 0.8, keyQ: 'flex',
  q: { flex: [65, 10] }, gather: { kind: 'bark_sheet', met: 3, tool: { cap: 'cut', min: 20 } } });
R('resin', { find: { density: 0.4, sweep: 10, speed: 1, handle: 40, perYear: 1 }, name: 'Conifer resin', habitat: (e) => e.canopy * ramp(e.conifer, 0.35, 0.8), vis: 0.5,
  gather: { kind: 'resin', met: 2.5 } });

// ---- soft plant material ----
R('grass', { find: { snow: 0.5, density: 3000, sweep: 5, speed: 1, handle: 8, perYear: 1 }, name: 'Tall grass', habitat: (e) => 1 - e.canopy,   q: { dryness: [40, 15] }, gather: { kind: 'grass', met: 3, boost: { cap: 'cut', per: 80 } } });
R('leaves', { find: { snow: 0.3, density: 4000, sweep: 5, speed: 1, handle: 0.6, perYear: 1, why: 'handling is scooping armfuls and carrying them to where you need them' }, name: 'Leaf litter', habitat: (e) => e.canopy,   gather: { kind: 'leaves', met: 3 } });
R('reeds', { find: { density: 6000, sweep: 5, speed: 0.8, handle: 10, perYear: 1 }, name: 'Reeds and cattails', habitat: (e) => ramp(e.water, 0.6, 0.95),   gather: { kind: 'reeds', met: 3.5, boost: { cap: 'cut', per: 60 } } });
R('withies', { find: { density: 1500, sweep: 5, speed: 0.6, handle: 1, perYear: 1 }, name: 'Flexible shoots', habitat: (e) => 0.7 * e.water + 0.3 * e.canopy - 0.2, vis: 0.8, keyQ: 'flex',
  q: { flex: [80, 8] }, gather: { kind: 'withies', met: 3, boost: { cap: 'cut', per: 60 } },
  note: 'Willow, dogwood, hazel: basketry and wattle.' });
R('fiber_plants', { find: { density: 25, sweep: 5, speed: 1, handle: 240, perYear: 1, why: 'kg of finished fibre; handling is stripping and cleaning' }, name: 'Fiber plants', habitat: (e) => e.fert * (1 - 0.6 * e.canopy), vis: 0.6, keyQ: 'strength',
  q: { strength: [55, 12] }, gather: { kind: 'fiber', met: 2.5 },
  note: 'Nettle, dogbane, milkweed: stripped and cleaned into raw fiber as you go.' });

// ---- plant foods ----
R('greens', { find: { snow: 0.2, density: 40, sweep: 3, speed: 1, handle: 15, perYear: 6, why: 'peak density; leaves from April to September' }, season: { grow: [0, 0, 0, 0.1, 0.25, 0.25, 0.2, 0.1, 0.1, 0, 0, 0], loss: 0.06 }, name: 'Edible greens', habitat: (e) => e.fert, vis: 0.8,
  gather: { kind: 'greens', met: 2.5 } });
R('berries', { find: { density: 40, sweep: 5, speed: 1, handle: 30, perYear: 2, why: 'peak density; ripe July to September' }, season: { grow: [0, 0, 0, 0, 0, 0, 0.3, 0.5, 0.2, 0, 0, 0], loss: 0.05 }, name: 'Berries', habitat: (e) => e.fert * (1 - 2 * Math.abs(e.canopy - 0.45)), vis: 0.7,
  gather: { kind: 'berries', met: 2.5, boost: { cap: 'bag', per: 16 } } });
R('nuts', { find: { snow: 0.25, density: 100, sweep: 5, speed: 0.5, handle: 15, perYear: 1, why: 'peak density; fall in September and October, eaten by animals through winter' }, season: { grow: [0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.5, 0.1, 0], loss: 0.012 }, name: 'Nut trees', habitat: (e) => e.canopy * (1 - e.conifer) * 0.8, vis: 0.6,
  gather: { kind: 'nuts', met: 2.5, boost: { cap: 'bag', per: 16 } } });
R('acorns', { find: { snow: 0.25, density: 160, sweep: 5, speed: 0.5, handle: 10, perYear: 1, why: 'peak density; fall in September and October, eaten by animals through winter' }, season: { grow: [0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.5, 0.1, 0], loss: 0.012 }, name: 'Acorns', habitat: (e) => e.canopy * (1 - e.conifer) * 0.9, vis: 0.7,
  gather: { kind: 'acorns', met: 2.5, boost: { cap: 'bag', per: 16 } } });
R('seeds', { find: { density: 50, sweep: 5, speed: 0.5, handle: 120, perYear: 1, why: 'peak density; heads ripen August to October; handling is beating them into a container' }, season: { grow: [0, 0, 0, 0, 0, 0, 0, 0.4, 0.5, 0.1, 0, 0], loss: 0.03 }, name: 'Seeding grasses', habitat: (e) => (1 - e.canopy) * e.fert, vis: 0.6,
  gather: { kind: 'seeds', met: 2.5, boost: { cap: 'bag', per: 10 } } });
R('tubers', { find: { snow: 0.2, density: 300, sweep: 3, speed: 0.5, handle: 60, perYear: 0.5, why: 'handling is digging' }, name: 'Roots and tubers', habitat: (e) => Math.max(0.7 * e.fert, 0.8 * ramp(e.water, 0.5, 0.9)), vis: 0.35,
  gather: { kind: 'tubers', met: 4, boost: { cap: 'dig', per: 25 } },
  note: 'Slow with bare hands. A digging stick multiplies the take.' });

// ---- animals ----
R('eggs', { find: { density: 12, sweep: 10, speed: 1, handle: 5, perYear: 2, why: 'peak density; nesting April to June' }, season: { grow: [0, 0, 0, 0.3, 0.5, 0.2, 0, 0, 0, 0, 0, 0], loss: 0.1 }, name: 'Bird nests', habitat: (e) => 0.25 + 0.35 * e.canopy, vis: 0.15,
  gather: { kind: 'eggs', met: 3, risk: [{ type: 'sprain', p: 0.02, sev: [10, 30] }] } });
R('grubs', { find: { snow: 0.2, density: 4, sweep: 5, speed: 0.5, handle: 60, perYear: 2, why: 'peak density; active April to October; handling is splitting rotten wood' }, season: { grow: [0, 0, 0, 0.15, 0.15, 0.14, 0.14, 0.14, 0.14, 0.14, 0, 0], loss: 0.04 }, name: 'Grubs and insects', habitat: (e) => e.canopy, vis: 0.4,
  gather: { kind: 'grubs', met: 3, boost: { cap: 'dig', per: 50 } } });
R('shellfish', { find: { snow: 0.4, density: 200, sweep: 2, speed: 0.5, handle: 10, perYear: 0.5 }, name: 'Mussels and crayfish', habitat: (e) => ramp(e.water, 0.6, 0.9), vis: 0.5,
  gather: { kind: 'shellfish', met: 3 } });
R('fish', { name: 'Fish', habitat: (e) => ramp(e.water, 0.55, 0.85), cap: 30, regen: 0.05, vis: 0.6,
  note: 'Taken with a fish spear, hook and line, basket trap or weir.' });
R('small_game', { name: 'Small game sign', habitat: (e) => 0.3 + 0.4 * e.canopy + 0.2 * e.fert, cap: 20, regen: 0.04, vis: 0.4,
  note: 'Rabbit runs, droppings, grouse dusting spots. Snares, deadfalls or a thrown stick.' });
R('large_game', { name: 'Large game sign', habitat: (e) => 0.15 + 0.45 * e.canopy, cap: 4, regen: 0.02, vis: 0.3,
  note: 'Deer trails. You will want a real spear.' });

// ---- minerals ----
R('cobbles', { find: { snow: 0.3, density: 3000, sweep: 3, speed: 1, handle: 0.5, perYear: 0 }, name: 'Cobbles', habitat: (e) => Math.max(e.rock, 0.8 * ramp(e.water, 0.5, 0.8)), keyQ: 'hardness',
  q: { hardness: [60, 14], thermal: (e) => [72 - 40 * e.water, 12] }, gather: { kind: 'cobble', met: 3 },
  note: 'Hammerstones, cooking stones, hearth rings. Water-worn stones tend to crack when heated.' });
R('toolstone', { find: { density: 400, sweep: 3, speed: 0.5, handle: 5, perYear: 0, why: 'handling is test-breaking nodules' }, name: 'Knappable stone', habitat: (e) => Math.max(e.flint, 0.45 * e.rock), vis: 0.5, keyQ: 'knappability',
  q: { knappability: (e) => [28 + 55 * e.flint, 10] }, gather: { kind: 'toolstone', met: 3 },
  note: 'Anything that breaks with a shell-shaped fracture. Quality varies enormously from place to place.' });
R('slabs', { find: { density: 40, sweep: 10, speed: 1, handle: 5, perYear: 0 }, name: 'Flat slabs', habitat: (e) => e.rock, vis: 0.8,
  q: { hardness: [60, 14] }, gather: { kind: 'slab', met: 4 } });
R('clay', { find: { snow: 0.1, density: 50000, sweep: 2, speed: 0.3, handle: 6, perYear: 0, why: 'handling is digging it out' }, name: 'Clay bank', habitat: (e) => e.clay * ramp(e.water, 0.3, 0.6), vis: 0.4, keyQ: 'plasticity',
  q: { plasticity: [60, 15] }, gather: { kind: 'clay', met: 4.5, boost: { cap: 'dig', per: 40 } } });

// ---- added later (kept last so older worlds generate the same places) ----
R('sticks', { find: { snow: 0.5, density: 400, sweep: 8, speed: 1.5, handle: 0.4, perYear: 1, why: 'dead sticks a metre or two long, any shape' }, name: 'Dead sticks', habitat: (e) => e.canopy,
  gather: { kind: 'stick', met: 3 }, note: 'Ribs for a debris hut, rafters for a lean-to, stakes.' });

// Derived: a full place's amount, regrowth, and the rate at full abundance.
for (const def of Object.values(RESOURCES)) {
  // qualities added after worlds existed (q2) are drawn from their own stream, so old places stay as they were
  def.qLate = Object.keys(def.q2 || {});
  def.q = Object.assign({}, def.q, def.q2);
  const f = def.find;
  if (!f) continue;
  if (def.season) { // production so that the standing stock peaks at the stated density
    const unit = stockProfile(def.season.grow, def.season.loss, 1);
    f.perYear = 1 / Math.max(...unit);
    def.stock = unit.map((x) => x * f.perYear);
  }
  def.cap = f.density * PLACE_HA;
  def.regen = f.perYear / (365 * 1.06); // logistic: the most it can give is 1.06 x regen x cap a day
  if (def.gather) def.gather.rate = encounter(def, f.density);
}

// Recipes: everything the character knows how to do with materials.
//
// A recipe is data plus one small `make` function. The engine (actions.js)
// handles the bookkeeping: checking requirements, choosing and consuming
// inputs, wearing tools, rolling for injury, spending time and calories.
//
//   time    minutes for one batch          met   metabolic intensity (1 = lying still)
//   tools   [{cap, min, opt}]  capabilities that must be within reach; `opt` ones only help
//   in      [{id, kind|tag, n|kg, q:{mins}, qmax:{maxes}, opt, keep, max}]
//             keep: not consumed, handed back after `make` (which may alter it)
//             max:  with `scale`, take up to this much and multiply time and output
//   scale   id of the input that sets batch size;  flat: true -> time does not grow with batch
//   res     natural resource that must be known at this place
//   check   (state, api) -> reason string if impossible right now
//   fail    ctx -> probability the attempt fails;  failKeeps: inputs survive failure
//   risk    [{type, p, sev:[lo,hi]}]  chance of injury per batch
//   make    ctx -> void.  ctx: {ins, k, lvl(cap), r(), rn(), give(kind,n,q,extra), build(kind,parts,q), say(msg), ...}
//
// Jobs longer than a couple of hours become an "unfinished" object at the
// work site and are completed over several sessions.

import { KINDS } from './items.js';
import { clamp } from '../util.js';

export const RECIPES = {};
const R = (o) => { RECIPES[o.id] = Object.assign({ met: 2.5, tools: [], in: [] }, o); };
const Q = (it, k, d = 0) => (it && it.q && it.q[k] != null ? it.q[k] : d);

// ================================================================ stone
R({ id: 'knap_flakes', name: 'Knap flakes', group: 'Stone', time: 20,
  desc: 'Strike sharp flakes off a core. The stone decides how well this goes.',
  tools: [{ cap: 'pound', min: 35 }, { cap: 'billet', min: 30, opt: true }],
  in: [{ id: 'core', kind: 'toolstone', n: 0.4, prefer: 'knappability' }],
  risk: [{ type: 'cut', p: 0.07, sev: [5, 25] }],
  fail: (c) => (100 - Q(c.ins.core, 'knappability')) / 170, failMsg: 'The core crumbles along hidden flaws. Nothing usable.',
  make: (c) => {
    const kn = Q(c.ins.core, 'knappability');
    const n = 2 + Math.floor(kn / 25 + c.r() * 2);
    c.give('flake', n, { sharpness: 35 + 0.55 * kn + 6 * c.rn() + (c.lvl('billet') >= 30 ? 5 : 0) });
  } });
R({ id: 'knap_biface', name: 'Knap a hand axe', group: 'Stone', time: 50,
  desc: 'Work a core down from both faces into a heavy edged tool: chops, cuts, scrapes, digs.',
  tools: [{ cap: 'pound', min: 40 }, { cap: 'billet', min: 30, opt: true }],
  in: [{ id: 'core', kind: 'toolstone', n: 1, q: { knappability: 35 }, prefer: 'knappability' }],
  risk: [{ type: 'cut', p: 0.1, sev: [5, 25] }],
  fail: (c) => (100 - Q(c.ins.core, 'knappability')) / 140 - (c.lvl('billet') >= 30 ? 0.1 : 0), failMsg: 'A bad blow snaps the piece in half.',
  make: (c) => { const kn = Q(c.ins.core, 'knappability'); c.give('biface', 1, { sharpness: 30 + 0.5 * kn + 5 * c.rn() }); c.give('flake', 2, { sharpness: 30 + 0.5 * kn }); } });
R({ id: 'knap_point', name: 'Knap a spear point', group: 'Stone', time: 40,
  desc: 'A thin symmetrical point. Demands good stone; an antler tool helps.',
  tools: [{ cap: 'pound', min: 35 }, { cap: 'billet', min: 30, opt: true }],
  in: [{ id: 'core', kind: 'toolstone', n: 0.5, q: { knappability: 45 }, prefer: 'knappability' }],
  risk: [{ type: 'cut', p: 0.1, sev: [5, 25] }],
  fail: (c) => (100 - Q(c.ins.core, 'knappability')) / 120 - (c.lvl('billet') >= 30 ? 0.15 : 0), failMsg: 'The point snaps across the middle as you thin it.',
  make: (c) => { const kn = Q(c.ins.core, 'knappability'); c.give('point', 1, { sharpness: 40 + 0.5 * kn + (c.lvl('billet') >= 30 ? 8 : 0) }); c.give('flake', 1, { sharpness: 30 + 0.5 * kn }); } });
R({ id: 'grind_celt', name: 'Peck and grind an axe head', group: 'Stone', time: 300, met: 3,
  desc: 'No flint? A tough cobble can be pecked to shape and ground to an edge on a slab. Slow, but the result is durable.',
  tools: [{ cap: 'pound', min: 50 }, { cap: 'grind', min: 40 }],
  in: [{ id: 'blank', kind: 'cobble', n: 1, q: { hardness: 55 }, prefer: 'hardness' }],
  make: (c) => c.give('celt', 1, { sharpness: 35 + 0.3 * Q(c.ins.blank, 'hardness'), integrity: 100 }) });
R({ id: 'resharpen', name: 'Resharpen an edge', group: 'Stone', time: 15,
  desc: 'Retouch a dulled edge. Each resharpening eats a little of the tool. (Take a hafted tool apart first.)',
  tools: [{ cap: 'pound', min: 30 }],
  in: [{ id: 'edge', tag: 'edge', n: 1, keep: true, qmax: { sharpness: 60 } }],
  make: (c) => { const e = c.ins.edge; e.q.sharpness = Math.min(75, e.q.sharpness + 25); e.q.integrity = Math.max(1, e.q.integrity - 12); } });

// ================================================================ simple tools
R({ id: 'digging_stick', name: 'Bevel a digging stick', group: 'Tools', time: 20,
  desc: 'Any stout stick digs a little. A chisel-pointed one digs properly.',
  tools: [{ cap: 'cut', min: 10 }], in: [{ id: 'stick', kind: 'shaft', n: 1, prefer: 'hardness' }],
  make: (c) => c.give('digging_stick', 1, { hardness: Q(c.ins.stick, 'hardness'), integrity: Q(c.ins.stick, 'integrity') }) });
R({ id: 'fire_harden', name: 'Fire-harden a wooden tool', group: 'Tools', time: 20,
  desc: 'Turn the working end slowly in the coals until it is dry and hard, never charred.',
  tools: [{ cap: 'fire', min: 1 }], in: [{ id: 'tool', tag: 'hardenable', n: 1, keep: true, qmax: { hardness: 60 } }],
  make: (c) => { c.ins.tool.q.hardness = Math.min(85, c.ins.tool.q.hardness + 30); } });
R({ id: 'spear', name: 'Sharpen a wooden spear', group: 'Tools', time: 30,
  tools: [{ cap: 'cut', min: 15 }], in: [{ id: 'shaft', kind: 'shaft', n: 1, q: { straightness: 45 }, prefer: 'straightness' }],
  desc: 'A straight shaft scraped to a point. Harden the tip in a fire.',
  make: (c) => c.give('spear', 1, { hardness: Q(c.ins.shaft, 'hardness'), straightness: Q(c.ins.shaft, 'straightness'), integrity: Q(c.ins.shaft, 'integrity') }) });
R({ id: 'throwing_stick', name: 'Shape a throwing stick', group: 'Tools', time: 25,
  tools: [{ cap: 'cut', min: 10 }], in: [{ id: 'pole', kind: 'pole', n: 1 }],
  desc: 'A heavy curved stick thrown side-arm at rabbits and birds.',
  make: (c) => c.give('throwing_stick', 1, { integrity: Q(c.ins.pole, 'integrity') }) });
R({ id: 'bone_awl', name: 'Grind a bone awl', group: 'Hide and bone', time: 30,
  tools: [{ cap: 'pound', min: 20 }], in: [{ id: 'bone', kind: 'bone', n: 0.1 }],
  desc: 'A splinter of bone ground to a needle point, for piercing hide.',
  make: (c) => c.give('bone_awl', 1) });
R({ id: 'gorge', name: 'Carve a gorge hook', group: 'Hide and bone', time: 25,
  tools: [{ cap: 'cut', min: 20 }], in: [{ id: 'bone', kind: 'bone', n: 0.05 }],
  desc: 'A double-pointed sliver that turns sideways in a fish\'s throat.',
  make: (c) => c.give('gorge', 1) });

// ================================================================ fiber
R({ id: 'cordage', name: 'Twist cordage', group: 'Fiber', time: 60, met: 1.8,
  desc: 'Reverse-wrap fiber into two-ply cord: about five metres an hour.',
  in: [{ id: 'fiber', tag: 'fiber', n: 0.05, max: 0.1, prefer: 'strength' }], scale: 'fiber',
  make: (c) => c.give('cordage', 100 * c.ins.fiber.n, { strength: Q(c.ins.fiber, 'strength') + 4 * c.rn(), integrity: Q(c.ins.fiber, 'integrity') }) });
R({ id: 'shred_bark', name: 'Shred bark into fiber', group: 'Fiber', time: 20, met: 2,
  desc: 'Pound and strip the inner bark. Weaker than nettle or dogbane, but bark is everywhere.',
  tools: [{ cap: 'pound', min: 20 }], in: [{ id: 'bark', kind: 'bark_sheet', n: 1 }],
  make: (c) => c.give('fiber', 0.08, { strength: 36 + 5 * c.rn() }) });
R({ id: 'tinder', name: 'Make a tinder bundle', group: 'Fire', time: 5, met: 1.8,
  desc: 'Buff dry grass or fiber into a fluffy nest that will take a coal.',
  in: [{ id: 'stuff', tag: 'tinderstuff', kg: 0.1, prefer: 'dryness' }],
  make: (c) => c.give('tinder', 1, { dryness: Q(c.ins.stuff, 'dryness', 60) }) });

// ================================================================ fire
R({ id: 'hearth_board', name: 'Split a hearth board', group: 'Fire', time: 20,
  desc: 'A flat slat of soft, dry wood with a notch to collect the dust. Soft and dry both matter.',
  tools: [{ cap: 'cut', min: 15 }], in: [{ id: 'wood', kind: 'softwood', n: 1, prefer: 'softness' }],
  make: (c) => c.give('hearth_board', 1, { softness: Q(c.ins.wood, 'softness'), dryness: Q(c.ins.wood, 'dryness') }) });
R({ id: 'drill_spindle', name: 'Carve a drill spindle', group: 'Fire', time: 20,
  desc: 'A thumb-thick spindle for a bow drill.',
  tools: [{ cap: 'cut', min: 15 }], in: [{ id: 'wood', kind: 'softwood', n: 1, prefer: 'dryness' }],
  make: (c) => c.give('drill_spindle', 1, { dryness: Q(c.ins.wood, 'dryness') }) });
R({ id: 'light_fire', name: 'Light a fire by friction', group: 'Fire', time: 20, met: 5.5,
  desc: 'Spin a spindle in a hearth board until the dust smoulders, tip the coal into tinder, breathe it to flame. Exhausting, and often fails.',
  tools: [{ cap: 'spindle', min: 20 }, { cap: 'fireboard', min: 20 }],
  in: [{ id: 'tinder', kind: 'tinder', n: 1, q: { dryness: 35 }, prefer: 'dryness' }, { id: 'kindling', kind: 'kindling', n: 0.5, q: { dryness: 30 }, prefer: 'dryness' }],
  check: (s, a) => (a.hasKind('fire') ? 'A fire is already burning here.' : null),
  fail: (c) => 1 - clamp(0.1 + 0.0095 * Math.min(c.lvl('spindle'), c.lvl('fireboard')), 0.05, 0.95) * (Q(c.ins.tinder, 'dryness') / 100 + 0.2) * (c.wet ? 0.4 : 1),
  failKeeps: true, failMsg: 'Smoke, a little brown dust, aching palms. No coal.',
  risk: [{ type: 'blister', p: 0.12, sev: [5, 15] }],
  make: (c) => { c.give('fire', 1, { fuel: 0.4 }); c.say('The coal catches. Flame climbs through the kindling. You have fire.', 'good'); } });
R({ id: 'rekindle', name: 'Rekindle from embers', group: 'Fire', time: 5, met: 2,
  desc: 'Blow the banked coals back to life.',
  tools: [{ cap: 'embers', min: 1 }], in: [{ id: 'kindling', kind: 'kindling', n: 0.3 }],
  make: (c) => { c.removeKind('embers'); c.give('fire', 1, { fuel: 0.3 }); } });
R({ id: 'add_fuel', name: 'Feed the fire', group: 'Fire', time: 3, met: 2, flat: true,
  desc: 'Each kilogram of dry wood burns for roughly 25 minutes; wet wood for much less.',
  tools: [{ cap: 'fire', min: 1 }], in: [{ id: 'fuel', tag: 'fuel', kg: 2, max: 12, prefer: 'dryness' }], scale: 'fuel',
  make: (c) => {
    const f = c.ins.fuel, fire = c.findKind('fire');
    if (!fire) { c.give(f.kind, f.n, f.q); c.say('The fire died before you could feed it.', 'warn'); return; }
    fire.q.fuel += f.n * KINDS[f.kind].mass * KINDS[f.kind].fuel * (0.5 + Q(f, 'dryness', 100) / 200);
    c.say(`You feed the fire. It should burn about ${Math.round(fire.q.fuel * 10) / 10} h.`);
  } });
R({ id: 'charcoal', name: 'Burn a charcoal mound', group: 'Fire', time: 90, met: 4,
  desc: 'Stack wood tight, cap it with grass and earth, light it and let it smoulder airless for most of a day.',
  tools: [{ cap: 'dig', min: 20 }, { cap: 'fire', min: 1 }],
  in: [{ id: 'wood', kind: 'firewood', n: 12 }, { id: 'cap', tag: 'cover', kg: 4 }],
  make: (c) => c.give('charcoal_mound', 1, {}, { proc: { to: 'charcoal', n: 2.5, left: 18 * 60, name: 'The charcoal mound' } }) });
R({ id: 'pitch', name: 'Cook pitch glue', group: 'Fire', time: 20,
  desc: 'Melt resin and temper it with powdered charcoal so it sets hard instead of brittle.',
  tools: [{ cap: 'fire', min: 1 }], in: [{ id: 'resin', kind: 'resin', n: 0.1 }, { id: 'char', kind: 'charcoal', n: 0.03 }],
  make: (c) => c.give('pitch', 2) });

// ================================================================ water
R({ id: 'boil_water', name: 'Boil water', group: 'Food', time: 20, flat: true,
  desc: 'Bring a vessel of water to the boil, with hot stones or in a fireproof pot. Boiled water is safe.',
  tools: [{ cap: 'boil', min: 1 }],
  make: (c) => { const n = c.boil(0, true); c.say(`${Math.round(n * 10) / 10} L of water is now safe to drink.`); } });

// ================================================================ generic food verbs (from kind data)
for (const id in KINDS) {
  const k = KINDS[id];
  const base = k.unit === 'ea' ? 3 : 0.5;
  const carry = (c) => (k.q.tannin != null ? { tannin: Q(c.ins.x, 'tannin') } : {});
  if (k.roast) R({ id: 'roast_' + id, name: `Roast ${k.name}`, group: 'Food', time: 25, flat: true,
    desc: 'In the coals, on a hot stone, or on a stick. An earth oven bakes much more at once.',
    tools: [{ cap: 'fire', min: 1 }, { cap: 'oven', min: 1, opt: true }],
    in: [{ id: 'x', kind: id, n: base, max: base * 4, maxWith: { cap: 'oven', mult: 4 } }], scale: 'x',
    make: (c) => c.give(k.roast.to, c.ins.x.n * k.roast.y, carry(c)) });
  if (k.boil) R({ id: 'boil_' + id, name: `Boil ${k.name}`, group: 'Food', time: 25, flat: true,
    desc: 'Simmered in a vessel. Uses half a litre of water.',
    tools: [{ cap: 'boil', min: 1 }], in: [{ id: 'x', kind: id, n: base, max: base * 4 }], scale: 'x',
    make: (c) => { c.boil(0.5); c.give(k.boil.to, c.ins.x.n * k.boil.y, carry(c)); } });
  if (k.crush) R({ id: 'crush_' + id, name: (k.crush.cap === 'grind' ? 'Grind ' : 'Shell and pound ') + k.name, group: 'Food', time: 30, met: 3,
    desc: k.crush.cap === 'grind' ? 'Between a slab and a handstone.' : 'With a hammerstone on any firm surface.',
    tools: [{ cap: k.crush.cap, min: k.crush.min }], in: [{ id: 'x', kind: id, n: base, max: base * 4 }], scale: 'x',
    make: (c) => c.give(k.crush.to, c.ins.x.n * k.crush.y, k.crush.q || {}) });
  if (k.soak) R({ id: 'soak_' + id, name: `Leach ${k.name}`, group: 'Food', time: 15, flat: true,
    desc: 'Left in a fine bag or basket in running water until the bitterness is gone.',
    tools: [{ cap: 'bag', min: 1 }], res: 'water',
    in: [{ id: 'x', kind: id, n: base, max: base * 6, q: { tannin: 25 } }], scale: 'x',
    make: (c) => c.give(id, c.ins.x.n, Object.assign({}, c.ins.x.q), { proc: { left: k.soak.hours * 60, set: k.soak.set, name: 'The leaching ' + k.name } }) });
  if (k.dry) R({ id: 'dry_' + id, name: `Dry ${k.name}`, group: 'Food', time: 20, flat: true,
    desc: 'Sliced thin and laid out to the sun and wind. Rain stops the clock unless there is a roof.',
    tools: k.dry.rack ? [{ cap: 'rack', min: 50 }] : [], in: [{ id: 'x', kind: id, n: base, max: base * 8 }], scale: 'x',
    make: (c) => c.give(id, c.ins.x.n, Object.assign({}, c.ins.x.q), { proc: { to: k.dry.to, y: k.dry.y, left: k.dry.hours * 60, needsDry: true, name: 'The drying ' + k.name } }) });
  if (k.butcher) R({ id: 'butcher_' + id, name: `Butcher ${k.name}`, group: 'Food', time: k.butcher.time, met: 3,
    desc: 'Skin, gut and joint it. Everything is useful: meat, hide, sinew, bone.',
    tools: [{ cap: 'cut', min: k.butcher.cut }], in: [{ id: 'x', kind: id, n: 1 }],
    risk: [{ type: 'cut', p: 0.03, sev: [5, 20] }],
    make: (c) => {
      for (const [out, n] of k.butcher.out) {
        if (out === 'antler' && c.r() < 0.5) continue;
        const ok = KINDS[out];
        c.give(out, ok.unit === 'ea' ? n : n * (0.85 + 0.3 * c.r()), ok.q.fresh != null ? { fresh: Q(c.ins.x, 'fresh') } : {});
      }
    } });
}

// ================================================================ hide
R({ id: 'scrape_hide', name: 'Flesh and scrape a hide', group: 'Hide and bone', time: 8, met: 3.5,
  desc: 'Scrape off every scrap of flesh and fat, then stretch it to dry into rawhide. Raw hide rots within days.',
  tools: [{ cap: 'scrape', min: 25 }], in: [{ id: 'hide', kind: 'raw_hide', n: 0.1, max: 1.5 }], scale: 'hide',
  make: (c) => c.give('scraped_hide', c.ins.hide.n, {}, { proc: { to: 'rawhide', left: 24 * 60, needsDry: true, name: 'The stretched hide' } }) });
R({ id: 'tan_hide', name: 'Brain-tan a hide', group: 'Hide and bone', time: 20, met: 3.5,
  desc: 'Work an emulsion of brains or fat into the hide, then pull and stretch it until it dries soft. Hours of labour.',
  in: [{ id: 'hide', kind: 'rawhide', n: 0.1, max: 1.5 }, { id: 'agent', tag: 'tanagent', kg: 0.1 }], scale: 'hide',
  make: (c) => c.give('buckskin', c.ins.hide.n, { integrity: Q(c.ins.hide, 'integrity') }) });
R({ id: 'smoke_hide', name: 'Smoke buckskin', group: 'Hide and bone', time: 60, met: 2,
  desc: 'Hang it over a smouldering, smoky fire. Smoked hide resists rot and stays soft after wetting.',
  tools: [{ cap: 'fire', min: 1 }], in: [{ id: 'hide', kind: 'buckskin', n: 0.1, max: 3, qmax: { smoked: 50 } }], scale: 'hide', flat: true,
  make: (c) => c.give('buckskin', c.ins.hide.n, Object.assign({}, c.ins.hide.q, { smoked: 100 })) });

// ================================================================ containers
R({ id: 'bark_tray', name: 'Fold a bark tray', group: 'Containers', time: 10, met: 2,
  desc: 'A sheet of bark creased up at the edges. Carries berries, seeds, coals. One hand.',
  in: [{ id: 'bark', kind: 'bark_sheet', n: 1, q: { flex: 30 }, prefer: 'flex' }],
  make: (c) => c.give('bark_tray', 1, { integrity: Q(c.ins.bark, 'integrity') }) });
R({ id: 'bark_basin', name: 'Fold and stitch a bark basin', group: 'Containers', time: 40, met: 2,
  desc: 'Folded at the corners without cutting, pinned and stitched. It weeps; pitch on the seams helps a lot.',
  tools: [{ cap: 'cut', min: 15 }],
  in: [{ id: 'bark', kind: 'bark_sheet', n: 1, q: { flex: 45 }, prefer: 'flex' }, { id: 'stitch', tag: 'binding', n: 0.5 }, { id: 'seal', tag: 'adhesive', n: 1, opt: true }],
  make: (c) => c.give('bark_basin', 1, { size: 4, retention: 48 + 0.25 * Q(c.ins.bark, 'flex') + (c.ins.seal ? 28 : 0) }) });
R({ id: 'seal', name: 'Seal seams with pitch', group: 'Containers', time: 15, met: 2,
  tools: [{ cap: 'fire', min: 1 }],
  desc: 'Run warm pitch into every seam of a leaky vessel.',
  in: [{ id: 'vessel', tag: 'sealable', n: 1, keep: true, qmax: { retention: 88 } }, { id: 'pitch', tag: 'adhesive', n: 1 }],
  make: (c) => { c.ins.vessel.q.retention = Math.min(96, c.ins.vessel.q.retention + 28); } });
R({ id: 'basket', name: 'Weave a basket', group: 'Containers', time: 150, met: 2,
  desc: 'Stake-and-strand weaving with fresh shoots. Holds berries and nuts; fine seed still sifts through.',
  in: [{ id: 'w', tag: 'withy', n: 30, q: { flex: 40 } }], make: (c) => c.give('basket', 1) });
R({ id: 'pack_basket', name: 'Weave a pack basket', group: 'Containers', time: 240, met: 2,
  desc: 'A tall basket with cordage shoulder straps. Leaves both hands free.',
  in: [{ id: 'w', tag: 'withy', n: 50, q: { flex: 40 } }, { id: 'straps', tag: 'binding', n: 3 }], make: (c) => c.give('pack_basket', 1) });
R({ id: 'net_bag', name: 'Knot a net bag', group: 'Containers', time: 180, met: 1.8,
  desc: 'A looped carrying net slung from the shoulder. Anything smaller than a fist falls through, but it will carry a bag that would not.',
  in: [{ id: 'cord', tag: 'cord', n: 25, prefer: 'strength' }], make: (c) => c.give('net_bag', 1, { integrity: Q(c.ins.cord, 'integrity') }) });
R({ id: 'hide_bag', name: 'Sew a hide bag', group: 'Containers', time: 60, met: 2,
  desc: 'Holds anything, even meal and seed.',
  tools: [{ cap: 'pierce', min: 30 }], in: [{ id: 'hide', tag: 'leather', n: 0.3 }, { id: 'cord', tag: 'cord', n: 2 }],
  make: (c) => c.give('hide_bag', 1, { integrity: Q(c.ins.hide, 'integrity') }) });
R({ id: 'waterskin', name: 'Sew a waterskin', group: 'Containers', time: 60, met: 2,
  desc: 'Three litres of water that travel with you.',
  tools: [{ cap: 'pierce', min: 30 }], in: [{ id: 'hide', tag: 'leather', n: 0.25 }, { id: 'cord', tag: 'cord', n: 1.5 }, { id: 'seal', tag: 'adhesive', n: 1, opt: true }],
  make: (c) => c.give('waterskin', 1, { size: 3, retention: c.ins.seal ? 92 : 74, integrity: Q(c.ins.hide, 'integrity') }) });
R({ id: 'pack_frame', name: 'Lash a pack frame', group: 'Containers', time: 60,
  desc: 'A ladder-like frame for the back. Bulky things are tied on; small loose things need a bag first.',
  in: [{ id: 'poles', tag: 'pole', n: 3 }, { id: 'lash', tag: 'binding', n: 6 }], make: (c) => c.give('pack_frame', 1) });
R({ id: 'travois', name: 'Build a travois', group: 'Containers', time: 90,
  desc: 'Two long poles dragged behind you with a platform between. Takes both hands, but moves a deer.',
  in: [{ id: 'poles', tag: 'pole', n: 4 }, { id: 'lash', tag: 'binding', n: 8 }], make: (c) => c.give('travois', 1) });
R({ id: 'form_pot', name: 'Coil a clay pot', group: 'Containers', time: 45, met: 2,
  desc: 'Coil-built and smoothed. It must dry completely, under cover, before firing.',
  in: [{ id: 'clay', kind: 'clay', n: 2, q: { plasticity: 40 }, prefer: 'plasticity' }],
  make: (c) => c.give('green_pot', 1, { plasticity: Q(c.ins.clay, 'plasticity') }, { proc: { to: 'dry_pot', left: 36 * 60, needsDry: true, name: 'The clay pot' } }) });
R({ id: 'fire_pot', name: 'Fire a pot', group: 'Containers', time: 120, met: 2.5,
  desc: 'Warm it slowly, then bury it in a hot fire. Poor clay and open fires crack pots; a pit kiln is kinder.',
  tools: [{ cap: 'fire', min: 1 }, { cap: 'kiln', min: 1, opt: true }],
  in: [{ id: 'pot', kind: 'dry_pot', n: 1, prefer: 'plasticity' }, { id: 'fuel', kind: 'firewood', n: 8 }],
  fail: (c) => 0.5 - Q(c.ins.pot, 'plasticity') / 250 - (c.lvl('kiln') >= 1 ? 0.2 : 0), failMsg: 'A sharp crack from the fire. The pot has split.',
  make: (c) => { c.give('clay_pot', 1); c.say('The pot rings when tapped. It will sit directly on a fire.', 'good'); } });
R({ id: 'trough', name: 'Burn out a dugout trough', group: 'Containers', time: 360, met: 3.5,
  desc: 'Char the top of a log with coals, scrape out the char, repeat. A big watertight basin for hot-stone boiling.',
  tools: [{ cap: 'fire', min: 1 }, { cap: 'scrape', min: 20 }], in: [{ id: 'log', kind: 'log', n: 1 }], make: (c) => c.give('trough', 1) });

// ================================================================ traps and hunting
const game = (c, rid) => { const r = c.loc.res[rid]; return r ? clamp(r.amt / c.resCap(rid), 0, 1) : 0; };
R({ id: 'snare', name: 'Tie a snare', group: 'Traps and hunting', time: 10, met: 1.8,
  desc: 'A running noose. Weak cord gets chewed or snapped.',
  in: [{ id: 'cord', tag: 'cord', n: 1.2, q: { strength: 40 }, prefer: 'strength' }],
  make: (c) => c.give('snare', 1, { strength: Q(c.ins.cord, 'strength'), integrity: Q(c.ins.cord, 'integrity') }) });
R({ id: 'set_snare', name: 'Set a snare', group: 'Traps and hunting', time: 15, met: 2.5,
  desc: 'On a run, at head height for a rabbit. Works while you sleep. Check it before scavengers do.',
  res: 'small_game', in: [{ id: 'snare', kind: 'snare', n: 1, prefer: 'strength' }],
  make: (c) => c.give('set_snare', 1, { strength: Q(c.ins.snare, 'strength'), integrity: Q(c.ins.snare, 'integrity'), sprung: 0 }) });
R({ id: 'deadfall', name: 'Set a deadfall', group: 'Traps and hunting', time: 30, met: 3,
  desc: 'A slab propped on a figure-four trigger. Needs no cordage at all.',
  res: 'small_game', tools: [{ cap: 'cut', min: 10 }], in: [{ id: 'slab', kind: 'slab', n: 1 }, { id: 'sticks', kind: 'kindling', n: 0.2 }],
  make: (c) => c.give('deadfall_set', 1) });
R({ id: 'fish_trap', name: 'Weave a basket fish trap', group: 'Traps and hunting', time: 150, met: 2,
  desc: 'A funnel-mouthed basket. Fish find their way in and not out.',
  in: [{ id: 'w', tag: 'withy', n: 25, q: { flex: 40 } }, { id: 'tie', tag: 'binding', n: 2 }], make: (c) => c.give('fish_trap', 1) });
R({ id: 'set_fish_trap', name: 'Set the fish trap', group: 'Traps and hunting', time: 15, met: 3,
  res: 'fish', in: [{ id: 'trap', kind: 'fish_trap', n: 1 }], desc: 'Weighted down in a channel, mouth downstream.',
  make: (c) => c.give('fish_trap_set', 1, { integrity: Q(c.ins.trap, 'integrity'), sprung: 0 }) });
R({ id: 'hunt_small', name: 'Hunt small game', group: 'Traps and hunting', time: 180, met: 3.5, outdoor: true,
  desc: 'Three hours of stalking and waiting. Costs more than it pays unless game is plentiful and your aim is good.',
  res: 'small_game', tools: [{ cap: 'hunt', min: 10 }],
  risk: [{ type: 'sprain', p: 0.03, sev: [10, 30] }],
  fail: (c) => 1 - clamp((0.1 + 0.5 * game(c, 'small_game')) * Math.min(1.2, c.lvl('hunt') / 45), 0, 0.85), failMsg: 'You come back with nothing.',
  make: (c) => { c.give(c.r() < 0.7 ? 'rabbit' : 'grouse', 1); c.takeRes('small_game', 1); } });
R({ id: 'hunt_large', name: 'Hunt deer', group: 'Traps and hunting', time: 300, met: 4, outdoor: true,
  desc: 'Half a day on a trail for one chance at a close thrust. A deer is weeks of food and a wardrobe, and more than you can carry whole.',
  res: 'large_game', tools: [{ cap: 'hunt', min: 40 }],
  risk: [{ type: 'sprain', p: 0.06, sev: [10, 40] }, { type: 'bruise', p: 0.05, sev: [10, 40] }],
  fail: (c) => 1 - clamp(0.35 * (0.3 + 0.7 * game(c, 'large_game')) * c.lvl('hunt') / 70, 0, 0.6), failMsg: 'You find fresh sign and once hear them crash away, but never get close.',
  make: (c) => { c.give('deer', 1); c.takeRes('large_game', 1); c.say('A deer is down.', 'good'); } });
R({ id: 'spear_fish', name: 'Spear fish', group: 'Traps and hunting', time: 60, met: 3, outdoor: true,
  desc: 'Stand still in the shallows and strike below where the fish appears to be.',
  res: 'fish', tools: [{ cap: 'fishspear', min: 15 }],
  make: (c) => { const n = Math.floor(1.3 * game(c, 'fish') * c.lvl('fishspear') / 55 + c.r()); if (n) { c.give('fish', n); c.takeRes('fish', n); } else c.say('Every strike misses.'); } });
R({ id: 'angle', name: 'Fish with hook and line', group: 'Traps and hunting', time: 90, met: 1.6, outdoor: true,
  desc: 'Restful, and you can do it tired.',
  res: 'fish', tools: [{ cap: 'line', min: 20 }], in: [{ id: 'bait', tag: 'bait', kg: 0.02 }],
  make: (c) => { const n = Math.floor(1.1 * game(c, 'fish') + c.r() * 0.9); if (n) { c.give('fish', n); c.takeRes('fish', n); } else c.say('Not a bite.'); } });

// ================================================================ clothing
R({ id: 'grass_cape', name: 'Tie a grass cape', group: 'Clothing', time: 120, met: 2,
  desc: 'Bundles of long grass tied to a cord in overlapping rows. Sheds rain surprisingly well. Lasts a few weeks.',
  in: [{ id: 'grass', tag: 'thatch', kg: 3 }, { id: 'cord', tag: 'cord', n: 4 }], make: (c) => c.give('grass_cape', 1) });
R({ id: 'sandals', name: 'Plait cordage sandals', group: 'Clothing', time: 60, met: 1.8,
  desc: 'Bare feet are how most travel injuries start.',
  in: [{ id: 'cord', tag: 'cord', n: 6 }], make: (c) => c.give('sandals', 1) });
R({ id: 'moccasins', name: 'Sew moccasins', group: 'Clothing', time: 60, met: 2,
  tools: [{ cap: 'pierce', min: 30 }, { cap: 'cut', min: 20 }], in: [{ id: 'hide', tag: 'softleather', n: 0.25 }, { id: 'thread', tag: 'cord', n: 1.5 }],
  desc: 'Soft-soled shoes.', make: (c) => c.give('moccasins', 1) });
R({ id: 'hide_tunic', name: 'Sew a buckskin tunic', group: 'Clothing', time: 180, met: 2,
  tools: [{ cap: 'pierce', min: 30 }, { cap: 'cut', min: 20 }], in: [{ id: 'hide', tag: 'softleather', n: 1.2 }, { id: 'thread', tag: 'cord', n: 4 }],
  desc: 'Most of a deer hide.', make: (c) => c.give('hide_tunic', 1) });
R({ id: 'leggings', name: 'Sew buckskin leggings', group: 'Clothing', time: 120, met: 2,
  tools: [{ cap: 'pierce', min: 30 }, { cap: 'cut', min: 20 }], in: [{ id: 'hide', tag: 'softleather', n: 0.8 }, { id: 'thread', tag: 'cord', n: 3 }],
  desc: 'Warm legs, and protection in brush.', make: (c) => c.give('leggings', 1) });
R({ id: 'hide_cloak', name: 'Cut a hide cloak', group: 'Clothing', time: 30, met: 2,
  tools: [{ cap: 'cut', min: 20 }], in: [{ id: 'hide', tag: 'leather', n: 1.2 }, { id: 'tie', tag: 'cord', n: 1 }],
  desc: 'A whole hide worn over the shoulders. No sewing needed.', make: (c) => c.give('hide_cloak', 1) });

// ================================================================ assembly recipes generated from kinds with slots
for (const id in KINDS) {
  const k = KINDS[id];
  if (!k.build) continue;
  R({ id: 'build_' + id, name: (k.fixed ? 'Build a ' : 'Assemble a ') + k.name, group: k.build.group, time: k.build.time, met: k.build.met || 2.5,
    desc: k.build.desc, tools: k.build.tools, res: k.build.res,
    in: Object.keys(k.slots || {}).map((sl) => Object.assign({ id: sl }, k.slots[sl])),
    make: (c) => { c.build(id, c.ins); if (k.fixed) c.say(`The ${k.name} is finished.`, 'good'); } });
}

export const GROUPS = ['Stone', 'Tools', 'Fiber', 'Fire', 'Food', 'Hide and bone', 'Containers', 'Traps and hunting', 'Clothing', 'Shelter and camp'];

export const TAG_NAMES = {
  binding: 'binding (cordage or sinew)', cord: 'cord', cover: 'covering (grass, leaves, reeds or bark)',
  insulation: 'loose fill (leaves, grass, reeds or feathers)', thatch: 'thatch (grass or reeds)', pole: 'poles', withy: 'withies',
  cobble: 'cobbles', axehead: 'axe head (hand axe or ground head)', haft: 'haft (a shaft)', handle: 'handle (shaft, bone or antler)',
  blade: 'blade (flake or hand axe)', point: 'stone point', shaft: 'shaft', adhesive: 'pitch', leather: 'rawhide or buckskin',
  softleather: 'buckskin', fuel: 'fuel', gorge: 'gorge hook', drillspindle: 'carved spindle', tinderstuff: 'dry grass or fiber',
  tanagent: 'brains or fat', bait: 'bait (grubs, meat or fish)', hardenable: 'wooden tool', edge: 'edged stone tool',
  sealable: 'bark basin or waterskin', fiber: 'fiber',
};
export const CAP_NAMES = {
  pound: 'hammer', cut: 'cutting edge', chop: 'chopping edge', scrape: 'scraper', pierce: 'piercer', dig: 'digging tool', grind: 'grinding surface',
  billet: 'soft hammer', spindle: 'fire spindle', fireboard: 'hearth board', fire: 'lit fire', boil: 'boiling setup', bag: 'fine container',
  vessel: 'watertight vessel', rack: 'drying rack', oven: 'earth oven', kiln: 'kiln', hunt: 'hunting weapon', fishspear: 'fish spear', line: 'hook and line',
  embers: 'live embers', shelter: 'shelter', roof: 'roof', bed: 'bed', hearth: 'hearth', well: 'well',
};

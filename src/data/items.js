// Item kinds: the library of everything that can exist as an object.
//
// An item INSTANCE is plain data: {id, kind, n, q:{...}, parts?:{slot:item},
// in?:[items], proc?:{...}}. Everything about what it can do is looked up
// here by `kind`. Nothing in this file touches game state.
//
// Kind fields (all optional except name):
//   unit     'ea' | 'kg' | 'm' | 'L' | 'm2'   what `n` counts
//   mass     kg per unit            vol   litres per unit
//   grain    size in cm of one piece: a container with mesh M cannot hold grain < M
//   hand     units one hand can carry;  hands: 2  -> needs both hands
//   tags     what recipes and slots match on
//   q        default qualities (0..100 unless noted)
//   caps     {capability: item => level}   what the item can do, from its qualities
//   decay    {quality: loss per day}       always
//   rain     {quality: loss per day}       while rained on without a roof
//   dries    {quality: gain per day}       while not rained on
//   wear     {capability: {slotOrSelf: {quality: loss per hour of use}}}   ('_' = the item itself)
//   food     {kcal (per unit), water (L per unit), risk (chance of illness per portion), portion}
//   cont     {vol, mesh, liquid, ret, fireproof, cool, drag}   container behaviour
//   worn     {slot, warm (deg C), rain, feet}
//   slots    {name: {tag|kind, n|kg, q, opt}}    composite: parts keep their own identity
//   partDecay{slot: {quality: extra loss per day}}
//   build    {group, time, tools, res, desc}     auto-generates the assembly recipe from slots
//   fixed    true: a structure, stays where it was built
//   roast / boil / crush / soak / dry            generic processing verbs (see recipes.js)

export const KINDS = {};
const K = (id, o) => { KINDS[id] = Object.assign({ id, unit: 'ea', mass: 1, vol: 1, grain: 20, hand: 1, tags: [], q: {} }, o); };

// helpers for capability formulas
const Q = (it, k) => (it && it.q && it.q[k]) || 0;
const P = (it, slot) => (it.parts ? it.parts[slot] : null);
const sound = (it, at = 50) => (it ? Math.min(1, Q(it, 'integrity') / at) : 0); // 1 while integrity >= at
const bind = (b) => Q(b, 'strength') * sound(b);
const glue = (it) => { const a = P(it, 'adhesive'); return a ? 1 + 0.15 * Math.min(1, Q(a, 'tack') / 50) : 1; };

// ------------------------------------------------------------ plant materials
K('grass', { name: 'grass', unit: 'kg', vol: 10, grain: 30, hand: 0.5, tags: ['cover', 'insulation', 'thatch', 'tinderstuff'], coverQ: 0.8,
  q: { dryness: 40, integrity: 100 }, decay: { integrity: 0.6 }, rain: { dryness: 400 }, dries: { dryness: 25 } });
K('leaves', { name: 'leaf litter', unit: 'kg', vol: 14, grain: 8, hand: 0.3, tags: ['cover', 'insulation'], coverQ: 0.55,
  q: { integrity: 100 }, decay: { integrity: 1 } });
K('reeds', { name: 'reeds', unit: 'kg', vol: 6, grain: 100, hand: 1.5, tags: ['cover', 'thatch', 'insulation'], coverQ: 0.95,
  q: { integrity: 100 }, decay: { integrity: 0.4 } });
K('withies', { name: 'withies', mass: 0.08, vol: 0.3, grain: 100, hand: 20, tags: ['withy'],
  q: { flex: 80, integrity: 100 }, decay: { flex: 5, integrity: 0.3 } });
K('fiber', { name: 'raw fiber', unit: 'kg', vol: 6, grain: 30, hand: 0.3, tags: ['fiber', 'tinderstuff'],
  q: { strength: 55, integrity: 100 }, decay: { integrity: 0.3 } });
K('cordage', { name: 'cordage', unit: 'm', mass: 0.015, vol: 0.02, grain: 40, hand: 40, tags: ['cord', 'binding'],
  q: { strength: 55, integrity: 100 }, decay: { integrity: 0.35 }, rain: { integrity: 1.5 } });
K('sinew', { name: 'sinew', unit: 'm', mass: 0.005, vol: 0.01, grain: 40, hand: 40, tags: ['cord', 'binding'],
  q: { strength: 85, integrity: 100 }, decay: { integrity: 0.1 }, rain: { integrity: 3 } });
K('bark_sheet', { name: 'bark sheet', mass: 0.7, vol: 2, grain: 60, hand: 2, tags: ['cover', 'bark'], coverQ: 1.1,
  q: { flex: 65, integrity: 100 }, decay: { flex: 4, integrity: 0.3 } });
K('tinder', { name: 'tinder bundle', mass: 0.05, vol: 0.6, grain: 10, hand: 3,
  q: { dryness: 50 }, rain: { dryness: 600 }, dries: { dryness: 30 } });
K('kindling', { name: 'kindling', unit: 'kg', vol: 5, grain: 25, hand: 1, tags: ['fuel'], fuel: 0.25,
  q: { dryness: 60 }, rain: { dryness: 300 }, dries: { dryness: 20 } });
K('firewood', { name: 'firewood', unit: 'kg', vol: 2.5, grain: 50, hand: 5, tags: ['fuel'], fuel: 0.4,
  q: { dryness: 60 }, rain: { dryness: 150 }, dries: { dryness: 10 } });
K('pole', { name: 'pole', mass: 2.5, vol: 5, grain: 200, hand: 2, tags: ['pole', 'rib', 'straightenable'],
  q: { straightness: 50, strength: 50, integrity: 100 }, decay: { integrity: 0.15 }, caps: { pound: () => 25, hunt: () => 10 } });
K('stick', { name: 'stick', mass: 0.4, vol: 1, grain: 100, hand: 10, tags: ['rib'], q: { integrity: 100 }, decay: { integrity: 0.3 } });
K('shaft', { name: 'shaft', mass: 0.7, vol: 1.5, grain: 150, hand: 3, tags: ['shaft', 'haft', 'handle', 'hardenable', 'straightenable'],
  q: { straightness: 60, hardness: 30, integrity: 100 }, decay: { integrity: 0.1 },
  caps: { dig: (it) => 10 + 0.15 * Q(it, 'hardness'), hunt: () => 12 }, wear: { dig: { _: { integrity: 6 } } } });
K('stalk', { name: 'dry stalk', mass: 0.04, vol: 0.2, grain: 60, hand: 12,
  q: { straightness: 60, dryness: 60, integrity: 100 }, rain: { dryness: 400 }, dries: { dryness: 30 },
  caps: { spindle: (it) => Math.min(Q(it, 'straightness'), Q(it, 'dryness')) * sound(it, 20) }, wear: { spindle: { _: { integrity: 60 } } } });
K('softwood', { name: 'softwood limb', mass: 0.8, vol: 1.5, grain: 40, hand: 2,
  q: { softness: 60, dryness: 60, integrity: 100 }, rain: { dryness: 200 }, dries: { dryness: 15 } });
K('hearth_board', { name: 'hearth board', mass: 0.3, vol: 0.5, grain: 30, hand: 2,
  q: { softness: 60, dryness: 60, integrity: 100 }, rain: { dryness: 300 }, dries: { dryness: 20 },
  caps: { fireboard: (it) => Math.min(Q(it, 'softness'), Q(it, 'dryness')) * sound(it, 10) }, wear: { fireboard: { _: { integrity: 45 } } } });
K('drill_spindle', { name: 'carved spindle', mass: 0.1, vol: 0.2, grain: 30, hand: 5, tags: ['drillspindle'],
  q: { straightness: 75, dryness: 60, integrity: 100 }, rain: { dryness: 300 }, dries: { dryness: 20 } });
K('log', { name: 'log', mass: 25, vol: 30, grain: 150, hands: 2, q: { integrity: 100 }, decay: { integrity: 0.05 } });
K('resin', { name: 'resin', unit: 'kg', vol: 1, grain: 2, hand: 0.2 });
K('charcoal', { name: 'charcoal', unit: 'kg', vol: 4, grain: 3, hand: 0.3, tags: ['fuel'], fuel: 0.7 });
K('pitch', { name: 'pitch stick', mass: 0.05, vol: 0.05, grain: 3, hand: 5, tags: ['adhesive'], q: { tack: 95 }, decay: { tack: 1 } });

// ------------------------------------------------------------ stone, clay, bone
K('cobble', { name: 'cobble', mass: 0.8, vol: 0.4, grain: 9, tags: ['cobble'],
  q: { hardness: 60, thermal: 60, integrity: 100 },
  caps: { pound: (it) => 0.9 * Q(it, 'hardness') * sound(it, 20), hunt: () => 12 }, wear: { pound: { _: { integrity: 3 } } } });
K('toolstone', { name: 'toolstone', unit: 'kg', mass: 1, vol: 0.4, grain: 10, hand: 6, lump: true, q: { knappability: 50 } });
K('flake', { name: 'stone flake', mass: 0.03, vol: 0.01, grain: 3, hand: 3, tags: ['blade'],
  q: { sharpness: 60, integrity: 100 },
  caps: { cut: (it) => 0.85 * Q(it, 'sharpness'), scrape: (it) => 0.6 * Q(it, 'sharpness'), pierce: (it) => 0.3 * Q(it, 'sharpness') },
  wear: { cut: { _: { sharpness: 6 } }, scrape: { _: { sharpness: 4 } }, pierce: { _: { sharpness: 6 } } } });
K('biface', { name: 'hand axe', mass: 0.5, vol: 0.2, grain: 12, tags: ['blade', 'axehead', 'edge'],
  q: { sharpness: 55, integrity: 100 },
  caps: { cut: (it) => 0.7 * Q(it, 'sharpness'), chop: (it) => 0.5 * Q(it, 'sharpness'), scrape: (it) => 0.5 * Q(it, 'sharpness'), dig: () => 22 },
  wear: { cut: { _: { sharpness: 2 } }, chop: { _: { sharpness: 4, integrity: 2 } }, scrape: { _: { sharpness: 2 } }, dig: { _: { sharpness: 8 } } } });
K('celt', { name: 'ground stone axe head', mass: 0.6, vol: 0.2, grain: 12, tags: ['axehead', 'edge'],
  q: { sharpness: 50, integrity: 100 },
  caps: { chop: (it) => 0.4 * Q(it, 'sharpness'), cut: (it) => 0.3 * Q(it, 'sharpness') }, wear: { chop: { _: { sharpness: 2 } }, cut: { _: { sharpness: 2 } } } });
K('point', { name: 'stone point', mass: 0.03, vol: 0.01, grain: 4, hand: 2, tags: ['point', 'edge'],
  q: { sharpness: 60, integrity: 100 }, caps: { pierce: (it) => 0.7 * Q(it, 'sharpness'), cut: (it) => 0.5 * Q(it, 'sharpness') },
  wear: { pierce: { _: { sharpness: 5 } }, cut: { _: { sharpness: 6 } } } });
K('slab', { name: 'stone slab', mass: 6, vol: 3, grain: 30, hands: 2, q: { hardness: 60, integrity: 100 },
  caps: { grind: (it) => 0.85 * Q(it, 'hardness') } });
K('clay', { name: 'clay', unit: 'kg', vol: 0.6, grain: 0.1, hand: 1, q: { plasticity: 60 } });
K('bone', { name: 'bone', unit: 'kg', vol: 1, grain: 10, hand: 1, tags: ['handle'], q: { integrity: 100 } });
K('antler', { name: 'antler', mass: 0.5, vol: 1, grain: 30, tags: ['handle'], q: { integrity: 100 },
  caps: { billet: () => 65, dig: () => 28 }, wear: { billet: { _: { integrity: 3 } }, dig: { _: { integrity: 3 } } } });
K('bone_awl', { name: 'bone awl', mass: 0.03, vol: 0.02, grain: 10, hand: 6, q: { sharpness: 70, integrity: 100 },
  caps: { pierce: (it) => 0.95 * Q(it, 'sharpness') }, wear: { pierce: { _: { sharpness: 3 } } } });
K('gorge', { name: 'bone gorge hook', mass: 0.005, vol: 0.005, grain: 3, hand: 10, tags: ['gorge'], q: { integrity: 100 } });
K('feathers', { name: 'feathers', unit: 'kg', vol: 30, grain: 5, hand: 0.05, tags: ['insulation'], q: { integrity: 100 }, decay: { integrity: 0.3 } });

// ------------------------------------------------------------ simple shaped tools
K('digging_stick', { name: 'digging stick', mass: 0.7, vol: 1.5, grain: 120, tags: ['hardenable'],
  q: { hardness: 30, integrity: 100 }, decay: { integrity: 0.1 },
  caps: { dig: (it) => (30 + 0.5 * Q(it, 'hardness')) * sound(it, 30) }, wear: { dig: { _: { integrity: 2.5, hardness: 0.5 } } } });
K('spear', { name: 'wooden spear', mass: 0.7, vol: 1.5, grain: 180, tags: ['hardenable'],
  q: { hardness: 30, straightness: 60, integrity: 100 }, decay: { integrity: 0.1 },
  caps: { hunt: (it) => (22 + 0.3 * Q(it, 'hardness') + 0.15 * Q(it, 'straightness')) * sound(it, 30), fishspear: () => 20, dig: () => 15 },
  wear: { hunt: { _: { integrity: 2, hardness: 2 } }, fishspear: { _: { integrity: 2 } }, dig: { _: { integrity: 6 } } } });
K('throwing_stick', { name: 'throwing stick', mass: 0.6, vol: 1, grain: 60, q: { integrity: 100 },
  caps: { hunt: (it) => 30 * sound(it, 30), pound: () => 25 }, wear: { hunt: { _: { integrity: 2 } } } });

// ------------------------------------------------------------ composite tools
const BIND = (n) => ({ tag: 'binding', n });
const GLUE = { tag: 'adhesive', n: 1, opt: true };

K('stone_axe', { name: 'hafted stone axe', mass: 0, vol: 2, grain: 60,
  slots: { head: { tag: 'axehead', n: 1 }, haft: { tag: 'haft', n: 1 }, binding: BIND(2), adhesive: GLUE },
  partDecay: { adhesive: { tack: 0 } },
  caps: {
    chop: (it) => Math.min(Q(P(it, 'head'), 'sharpness') * 1.1, 1.3 * bind(P(it, 'binding')) + 15) * sound(P(it, 'haft'), 40) * glue(it),
    cut: (it) => 0.4 * Q(P(it, 'head'), 'sharpness') * sound(P(it, 'binding')),
  },
  wear: { chop: { head: { sharpness: 2.5 }, binding: { integrity: 3 }, haft: { integrity: 1.2 }, adhesive: { tack: 3 } }, cut: { head: { sharpness: 2 } } },
  build: { group: 'Tools', time: 60, tools: [{ cap: 'cut', min: 15 }], desc: 'Split or socket the haft, seat the head, lash it tight. Pitch keeps the head from working loose.' } });
K('knife', { name: 'hafted knife', mass: 0, vol: 0.3, grain: 15, hand: 2,
  slots: { blade: { tag: 'blade', n: 1 }, handle: { tag: 'handle', n: 1 }, binding: BIND(0.7), adhesive: GLUE },
  caps: {
    cut: (it) => Math.min(100, Q(P(it, 'blade'), 'sharpness') * 1.15 * glue(it)) * sound(P(it, 'binding')),
    scrape: (it) => 0.7 * Q(P(it, 'blade'), 'sharpness') * sound(P(it, 'binding')),
  },
  wear: { cut: { blade: { sharpness: 3 }, binding: { integrity: 1.5 } }, scrape: { blade: { sharpness: 3 }, binding: { integrity: 1 } } },
  build: { group: 'Tools', time: 30, tools: [], desc: 'A flake set in a split handle. Safer and far more comfortable than a bare flake.' } });
K('stone_spear', { name: 'stone-tipped spear', mass: 0, vol: 1.5, grain: 180,
  slots: { point: { tag: 'point', n: 1 }, shaft: { tag: 'shaft', n: 1, q: { straightness: 45 } }, binding: BIND(1.5), adhesive: GLUE },
  caps: {
    hunt: (it) => Math.min(40 + 0.5 * Q(P(it, 'point'), 'sharpness'), 1.4 * bind(P(it, 'binding')) + 20)
      * (0.6 + 0.4 * Q(P(it, 'shaft'), 'straightness') / 100) * sound(P(it, 'shaft'), 40) * glue(it),
    fishspear: () => 25,
  },
  wear: { hunt: { point: { sharpness: 4, integrity: 4 }, binding: { integrity: 3 }, shaft: { integrity: 1.5 }, adhesive: { tack: 4 } } },
  build: { group: 'Tools', time: 45, tools: [{ cap: 'cut', min: 15 }], desc: 'A knapped point lashed into a notched shaft.' } });
K('fish_spear', { name: 'fish spear', mass: 0, vol: 1.5, grain: 180,
  slots: { shaft: { tag: 'shaft', n: 1 }, binding: BIND(1) },
  caps: { fishspear: (it) => 55 * sound(P(it, 'shaft'), 40) * (0.5 + 0.5 * sound(P(it, 'binding'))) },
  wear: { fishspear: { shaft: { integrity: 2 }, binding: { integrity: 4 } } },
  build: { group: 'Tools', time: 40, tools: [{ cap: 'cut', min: 15 }], desc: 'Split the tip four ways, wedge the tines apart, sharpen each, bind below the split.' } });
K('fishing_line', { name: 'hook and line', mass: 0, vol: 0.2, grain: 10, hand: 3,
  slots: { hook: { tag: 'gorge', n: 1 }, line: { tag: 'cord', n: 6, q: { strength: 40 } } },
  caps: { line: (it) => 0.8 * bind(P(it, 'line')) },
  wear: { line: { line: { integrity: 2 }, hook: { integrity: 8 } } },
  build: { group: 'Traps and hunting', time: 10, tools: [], desc: 'A baited gorge on a hand line.' } });
K('bow_drill', { name: 'bow drill', mass: 0, vol: 2, grain: 60,
  slots: { spindle: { tag: 'drillspindle', n: 1 }, bow: { tag: 'shaft', n: 1 }, cord: { tag: 'cord', n: 1, q: { strength: 45 } }, socket: { tag: 'cobble', n: 1 } },
  caps: { spindle: (it) => { const s = P(it, 'spindle'); return Math.min(100, 1.5 * Math.min(Q(s, 'straightness'), Q(s, 'dryness'))) * sound(s, 15) * (bind(P(it, 'cord')) > 20 ? 1 : 0); } },
  wear: { spindle: { spindle: { integrity: 30 }, cord: { integrity: 25 } } },
  build: { group: 'Fire', time: 25, tools: [{ cap: 'cut', min: 15 }], desc: 'The bow does the spinning, a stone socket takes the downward pressure: far more reliable than bare palms, until the cord frays.' } });

// ------------------------------------------------------------ containers and carrying
K('bark_tray', { name: 'bark tray', open: true, mass: 0.6, vol: 3, grain: 50, q: { integrity: 100 }, decay: { integrity: 1.2 },
  cont: { vol: 6, mesh: 0 } });
K('bark_basin', { name: 'bark basin', mass: 0.8, vol: 5, grain: 30, tags: ['sealable'],
  q: { size: 4, retention: 60, integrity: 100 }, decay: { integrity: 0.8, retention: 0.8 },
  cont: { vol: (it) => Q(it, 'size'), liquid: true, ret: (it) => Q(it, 'retention') } });
K('basket', { name: 'basket', mass: 0.8, vol: 16, grain: 40, q: { integrity: 100 }, decay: { integrity: 0.25 }, cont: { vol: 15, mesh: 0.8 } });
K('pack_basket', { name: 'pack basket', mass: 1.5, vol: 32, grain: 50, q: { integrity: 100 }, decay: { integrity: 0.25 },
  cont: { vol: 30, mesh: 0.8 }, worn: { slot: 'back' } });
K('net_bag', { name: 'net bag', mass: 0.4, vol: 2, grain: 20, q: { integrity: 100 }, decay: { integrity: 0.35 }, rain: { integrity: 1 },
  cont: { vol: 25, mesh: 4 }, worn: { slot: 'shoulder' } });
K('hide_bag', { name: 'hide bag', mass: 0.4, vol: 2, grain: 20, q: { integrity: 100 }, decay: { integrity: 0.2 },
  cont: { vol: 12, mesh: 0 }, worn: { slot: 'shoulder' } });
K('waterskin', { name: 'waterskin', mass: 0.3, vol: 3.5, grain: 20, tags: ['sealable'],
  q: { size: 3, retention: 75, integrity: 100 }, decay: { integrity: 0.2 },
  cont: { vol: (it) => Q(it, 'size'), liquid: true, ret: (it) => Q(it, 'retention') }, worn: { slot: 'waist' } });
K('bladder', { name: 'bladder flask', mass: 0.1, vol: 2.2, grain: 15, q: { integrity: 100 }, decay: { integrity: 0.5 },
  cont: { vol: 2, liquid: true, ret: 92 }, worn: { slot: 'waist' } });
K('pack_frame', { name: 'pack frame', mass: 2, vol: 20, grain: 80, q: { integrity: 100 }, decay: { integrity: 0.2 },
  cont: { vol: 60, mesh: 12 }, worn: { slot: 'back' } });
K('travois', { name: 'travois', mass: 8, vol: 60, grain: 250, hands: 2, q: { integrity: 100 }, decay: { integrity: 0.2 },
  cont: { vol: 150, mesh: 12, drag: 0.35 } });
K('green_pot', { name: 'unfired pot (drying)', mass: 2, vol: 5, grain: 20, q: { plasticity: 60, integrity: 100 }, rain: { integrity: 400 } });
K('dry_pot', { name: 'bone-dry pot', mass: 1.7, vol: 5, grain: 20, q: { plasticity: 60, integrity: 100 }, rain: { integrity: 400 } });
K('clay_pot', { name: 'clay pot', mass: 1.6, vol: 5, grain: 20, q: { integrity: 100 },
  cont: { vol: 4, liquid: true, ret: 96, fireproof: true } });
K('trough', { name: 'dugout trough', mass: 14, vol: 25, grain: 100, hands: 2, q: { integrity: 100 }, decay: { integrity: 0.05 },
  cont: { vol: 15, liquid: true, ret: 97 } });

// ------------------------------------------------------------ hides and animal parts
K('raw_hide', { name: 'raw hide', unit: 'm2', mass: 3, vol: 4, grain: 40, hand: 0.6, q: { fresh: 100 }, decay: { fresh: 22 } });
K('scraped_hide', { name: 'scraped hide (drying)', unit: 'm2', mass: 2, vol: 3, grain: 40, hand: 0.6, q: { fresh: 100 }, decay: { fresh: 8 } });
K('rawhide', { name: 'rawhide', unit: 'm2', mass: 1, vol: 2, grain: 40, hand: 1, tags: ['leather'],
  q: { integrity: 100 }, decay: { integrity: 0.15 }, rain: { integrity: 3 } });
K('buckskin', { name: 'buckskin', unit: 'm2', mass: 0.8, vol: 2, grain: 40, hand: 1, tags: ['leather', 'softleather'],
  q: { integrity: 100, smoked: 0 }, decay: { integrity: 0.25 }, rain: { integrity: 2 }, smokedSlows: 0.25 });
K('brains', { name: 'brains', mass: 0.3, vol: 0.3, grain: 5, tags: ['tanagent'], q: { fresh: 100 }, decay: { fresh: 45 } });
const carcass = (id, name, mass, butcher, o = {}) => K(id, Object.assign({ name, mass, vol: mass, grain: 15, tags: ['carcass'], butcher,
  q: { fresh: 100 }, decay: { fresh: 35 } }, o));
carcass('rabbit', 'rabbit', 1.5, { time: 20, cut: 10, out: [['meat', 0.8], ['raw_hide', 0.1], ['bone', 0.2], ['sinew', 1]] });
carcass('grouse', 'grouse', 0.6, { time: 15, cut: 5, out: [['meat', 0.35], ['feathers', 0.04], ['bone', 0.05]] });
carcass('fish', 'fish', 0.7, { time: 5, cut: 5, out: [['fish_meat', 0.4], ['bone', 0.02]] }, { decay: { fresh: 45 } });
carcass('deer', 'deer', 55, { time: 120, cut: 25, out: [['meat', 22], ['fat', 2], ['raw_hide', 1.3], ['bone', 6], ['sinew', 8], ['brains', 1], ['antler', 1], ['bladder', 1]] }, { hands: 2, grain: 100, decay: { fresh: 30 } });

// ------------------------------------------------------------ food and water
K('water', { name: 'water', unit: 'L', vol: 1, grain: 0, liquid: true, q: { purity: 60 } });
const food = (id, name, kcal, o = {}) => {
  const f = { kcal, water: o.water || 0, risk: o.risk || 0, portion: o.portion || 0.3 };
  K(id, Object.assign({ name, unit: 'kg', vol: 1.3, grain: 2, hand: 0.25, q: { fresh: 100 }, decay: { fresh: o.rot == null ? 10 : o.rot } }, o.kind || {},
    o.inedible ? {} : { food: f }, { roast: o.roast, boil: o.boil, crush: o.crush, soak: o.soak, dry: o.dry }));
};
food('berries', 'berries', 550, { water: 0.8, portion: 0.4, rot: 18, kind: { grain: 1, hand: 0.15 }, dry: { to: 'dried_berries', y: 0.19, hours: 48 } });
food('dried_berries', 'dried berries', 2900, { portion: 0.15, rot: 0.5, kind: { grain: 0.8 } });
food('greens', 'greens', 250, { water: 0.85, portion: 0.3, rot: 30, kind: { grain: 5, vol: 5, hand: 0.1 }, boil: { to: 'boiled_greens', y: 0.9 } });
food('boiled_greens', 'boiled greens', 300, { water: 0.8, rot: 35 });
food('nuts', 'nuts in shell', 0, { inedible: true, rot: 0.3, kind: { grain: 1.5 }, crush: { to: 'nutmeat', y: 0.5, cap: 'pound', min: 20 } });
food('nutmeat', 'nut meats', 6000, { portion: 0.15, rot: 1.5, kind: { grain: 1 } });
food('acorns', 'acorns', 0, { inedible: true, rot: 0.4, kind: { grain: 2 }, crush: { to: 'acorn_meal', y: 0.6, cap: 'pound', min: 20, q: { tannin: 80 } } });
food('acorn_meal', 'acorn meal', 3400, { portion: 0.25, rot: 5, kind: { grain: 0.1, q: { fresh: 100, tannin: 80 } },
  soak: { hours: 14, set: { tannin: 8 } }, roast: { to: 'cake', y: 1.1 } });
food('seeds', 'grass seed', 1500, { portion: 0.2, rot: 0.2, kind: { grain: 0.2 }, crush: { to: 'seed_meal', y: 0.85, cap: 'grind', min: 30 } });
food('seed_meal', 'seed meal', 3000, { portion: 0.2, rot: 1, kind: { grain: 0.05 }, roast: { to: 'cake', y: 1.2 }, boil: { to: 'porridge', y: 3 } });
food('cake', 'ash cake', 3000, { portion: 0.3, rot: 6, kind: { grain: 6, q: { fresh: 100, tannin: 0 } } });
food('porridge', 'porridge', 1000, { water: 0.6, portion: 0.6, rot: 35, kind: { liquidish: true } });
food('tubers', 'raw tubers', 500, { risk: 0.06, portion: 0.4, rot: 2, kind: { grain: 5 }, roast: { to: 'roasted_tubers', y: 0.85 }, boil: { to: 'boiled_tubers', y: 1 } });
food('roasted_tubers', 'roasted tubers', 1050, { portion: 0.5, rot: 12, kind: { grain: 5 } });
food('boiled_tubers', 'boiled tubers', 850, { water: 0.3, portion: 0.5, rot: 15, kind: { grain: 5 } });
food('eggs', 'eggs', 70, { risk: 0.03, portion: 6, rot: 4, kind: { unit: 'ea', mass: 0.05, vol: 0.06, grain: 4, hand: 3 }, roast: { to: 'cooked_eggs', y: 1 }, boil: { to: 'cooked_eggs', y: 1 } });
food('cooked_eggs', 'cooked eggs', 75, { portion: 6, rot: 12, kind: { unit: 'ea', mass: 0.05, vol: 0.06, grain: 4, hand: 3 } });
food('grubs', 'grubs', 1500, { risk: 0.04, portion: 0.15, rot: 40, kind: { grain: 1, tags: ['bait'] }, roast: { to: 'roasted_grubs', y: 0.8 } });
food('roasted_grubs', 'roasted grubs', 1900, { portion: 0.15, rot: 15, kind: { grain: 1 } });
food('shellfish', 'shellfish', 250, { risk: 0.15, portion: 1, rot: 50, kind: { grain: 4 }, roast: { to: 'cooked_shellfish', y: 1 }, boil: { to: 'cooked_shellfish', y: 1 } });
food('cooked_shellfish', 'cooked shellfish', 300, { risk: 0.01, portion: 1.2, rot: 35, kind: { grain: 4 } });
food('fish_meat', 'raw fish', 1000, { risk: 0.08, portion: 0.4, rot: 45, kind: { grain: 6, tags: ['bait'] }, roast: { to: 'cooked_fish', y: 0.8 }, dry: { to: 'dried_fish', y: 0.3, hours: 30, rack: true } });
food('cooked_fish', 'cooked fish', 1300, { portion: 0.45, rot: 25, kind: { grain: 6 } });
food('dried_fish', 'dried fish', 3200, { portion: 0.15, rot: 0.8, kind: { grain: 6 } });
food('meat', 'raw meat', 1300, { risk: 0.15, portion: 0.4, rot: 35, kind: { grain: 6, tags: ['bait'] },
  roast: { to: 'cooked_meat', y: 0.7 }, boil: { to: 'cooked_meat', y: 0.8 }, dry: { to: 'jerky', y: 0.35, hours: 36, rack: true } });
food('cooked_meat', 'cooked meat', 1900, { portion: 0.45, rot: 22, kind: { grain: 6 } });
food('jerky', 'jerky', 3300, { portion: 0.15, rot: 0.6, kind: { grain: 6 } });
food('fat', 'fat', 7500, { risk: 0.03, portion: 0.08, rot: 6, kind: { grain: 4, tags: ['tanagent'] } });

// ------------------------------------------------------------ traps
K('snare', { name: 'snare', mass: 0.02, vol: 0.05, grain: 15, hand: 6, q: { strength: 55, integrity: 100 }, decay: { integrity: 0.35 } });
K('set_snare', { name: 'set snare', fixed: true, unset: 'snare', q: { strength: 55, integrity: 100, sprung: 0 }, decay: { integrity: 0.5 },
  trap: { res: 'small_game', rate: 0.008, catch: ['rabbit', 'rabbit', 'rabbit', 'grouse'] } });
K('deadfall_set', { name: 'set deadfall', fixed: true, unset: 'slab', q: { integrity: 100, sprung: 0 },
  trap: { res: 'small_game', rate: 0.005, catch: ['rabbit', 'grouse'] } });
K('fish_trap', { name: 'basket fish trap', mass: 1.2, vol: 20, grain: 50, q: { integrity: 100 }, decay: { integrity: 0.3 } });
K('fish_trap_set', { name: 'set fish trap', fixed: true, unset: 'fish_trap', q: { integrity: 100, sprung: 0 }, decay: { integrity: 0.6 },
  trap: { res: 'fish', rate: 0.03, catch: ['fish'] } });
K('fish_weir', { name: 'fish weir', fixed: true, q: { sprung: 0 },
  slots: { stakes: { tag: 'pole', n: 6 }, wattle: { tag: 'withy', n: 40 } }, partDecay: { wattle: { integrity: 1.5 } },
  trap: { res: 'fish', rate: 0.07, catch: ['fish'], multi: 5, needs: 'wattle' },
  build: { group: 'Traps and hunting', time: 240, met: 4.5, tools: [{ cap: 'pound', min: 25 }], res: 'fish', desc: 'A fence of stakes and wattle across the shallows that funnels fish into a pen. Holds several until you come for them.' } });

// ------------------------------------------------------------ clothing
K('grass_cape', { name: 'grass cape', mass: 2, vol: 15, grain: 50, q: { integrity: 100 }, decay: { integrity: 2 }, worn: { slot: 'cloak', warm: 3, rain: true } });
K('sandals', { name: 'cordage sandals', mass: 0.3, vol: 1, grain: 20, q: { integrity: 100 }, decay: { integrity: 0.3 }, worn: { slot: 'feet', warm: 0, feet: 0.5 }, travelWear: 5 });
K('moccasins', { name: 'moccasins', mass: 0.3, vol: 1, grain: 20, q: { integrity: 100 }, decay: { integrity: 0.2 }, worn: { slot: 'feet', warm: 1, feet: 0.6 }, travelWear: 3 });
K('hide_tunic', { name: 'buckskin tunic', mass: 1.2, vol: 4, grain: 30, q: { integrity: 100 }, decay: { integrity: 0.15 }, worn: { slot: 'torso', warm: 4 } });
K('leggings', { name: 'buckskin leggings', mass: 0.8, vol: 3, grain: 30, q: { integrity: 100 }, decay: { integrity: 0.15 }, worn: { slot: 'legs', warm: 3 } });
K('hide_cloak', { name: 'hide cloak', mass: 1.3, vol: 5, grain: 40, q: { integrity: 100 }, decay: { integrity: 0.15 }, worn: { slot: 'cloak', warm: 5, rain: true } });

// ------------------------------------------------------------ structures (fixed composites)
// the frame stands if every load-bearing part is sound: uprights, ridge pole, ribs
const frameOK = (it) => ['frame', 'ridge', 'ribs'].reduce((a, sl) => a * (sl in (KINDS[it.kind].slots || {}) ? sound(P(it, sl)) : 1), 1);
const coverOK = (it, slot = 'cover') => { const c = P(it, slot); return c ? sound(c) * (KINDS[c.kind].coverQ || 0.7) : 0; };

K('windbreak', { name: 'windbreak', fixed: true,
  slots: { frame: { tag: 'pole', n: 3 }, cover: { tag: 'cover', kg: 8 } }, partDecay: { cover: { integrity: 2.5 } },
  caps: { shelter: (it) => 28 * frameOK(it) * coverOK(it) },
  build: { group: 'Shelter and camp', time: 40, met: 3.5, tools: [], desc: 'Poles propped against each other and stuffed with whatever is to hand. Takes the edge off the wind.' } });
K('lean_to', { name: 'lean-to', fixed: true,
  slots: { ridge: { tag: 'pole', n: 1, q: { strength: 45 } }, frame: { tag: 'pole', n: 2 }, ribs: { tag: 'rib', n: 10 }, cover: { tag: 'cover', kg: 20 }, lashing: { tag: 'binding', n: 4, opt: true } }, partDecay: { cover: { integrity: 1.5 } },
  caps: { shelter: (it) => (45 + (P(it, 'lashing') ? 8 : 0)) * frameOK(it) * coverOK(it), roof: (it) => 60 * frameOK(it) * coverOK(it) },
  build: { group: 'Shelter and camp', time: 120, met: 3.5, tools: [], desc: 'A sloped roof open to a fire on one side. Keeps rain off you and your tinder.' } });
K('debris_hut', { name: 'debris hut', fixed: true,
  slots: { ridge: { tag: 'pole', n: 1, q: { strength: 50 } }, frame: { tag: 'pole', n: 2 }, ribs: { tag: 'rib', n: 25 }, cover: { tag: 'insulation', kg: 45 } }, partDecay: { cover: { integrity: 1.5 } },
  caps: { shelter: (it) => 72 * frameOK(it) * sound(P(it, 'cover')), roof: (it) => 60 * frameOK(it) * sound(P(it, 'cover')) },
  build: { group: 'Shelter and camp', time: 120, met: 3.5, tools: [], desc: 'A body-sized cocoon under an arm\'s depth of debris. Warm without fire, and needs no cordage.' } });
K('hut', { name: 'thatched hut', fixed: true,
  slots: { frame: { tag: 'pole', n: 14 }, wattle: { tag: 'withy', n: 40 }, cover: { tag: 'thatch', kg: 60 }, lashing: { tag: 'binding', n: 15 } }, partDecay: { cover: { integrity: 0.4 } },
  caps: { shelter: (it) => 92 * frameOK(it) * coverOK(it) * sound(P(it, 'lashing'), 30), roof: (it) => 95 * frameOK(it) * coverOK(it) },
  build: { group: 'Shelter and camp', time: 600, met: 3.5, tools: [{ cap: 'chop', min: 20 }], desc: 'A domed frame of bent poles, woven round with withies and thatched thick. A real home: weatherproof, with room for a fire.' } });
K('bed', { name: 'bedding pile', fixed: true,
  slots: { bedding: { tag: 'insulation', kg: 8 } }, partDecay: { bedding: { integrity: 3 } },
  caps: { bed: (it) => 55 * sound(P(it, 'bedding'), 60) },
  build: { group: 'Shelter and camp', time: 15, tools: [], desc: 'A thick mattress between you and the ground, which otherwise drinks your heat all night. It packs down; refresh it.' } });
K('raised_bed', { name: 'raised bed', fixed: true,
  slots: { frame: { tag: 'pole', n: 4, q: { strength: 45 } }, lashing: { tag: 'binding', n: 3 }, bedding: { tag: 'insulation', kg: 8 } }, partDecay: { bedding: { integrity: 2 } },
  caps: { bed: (it) => 88 * frameOK(it) * sound(P(it, 'bedding'), 60) },
  build: { group: 'Shelter and camp', time: 90, tools: [], desc: 'A lashed platform off the damp ground, topped with bedding.' } });
K('hearth', { name: 'stone hearth', fixed: true, slots: { ring: { tag: 'cobble', n: 8 } },
  caps: { hearth: () => 100 },
  build: { group: 'Shelter and camp', time: 30, tools: [], desc: 'A ring of stones that reflects heat, stretches fuel, and keeps embers alive far longer.' } });
K('drying_rack', { name: 'drying rack', fixed: true,
  slots: { frame: { tag: 'pole', n: 4 }, lashing: { tag: 'binding', n: 4 } },
  caps: { rack: (it) => 100 * frameOK(it) * sound(P(it, 'lashing'), 30) },
  build: { group: 'Shelter and camp', time: 45, tools: [], desc: 'For drying meat and fish into food that keeps.' } });
K('earth_oven', { name: 'earth oven', fixed: true, slots: { stones: { tag: 'cobble', n: 10 } },
  caps: { oven: () => 80 },
  build: { group: 'Shelter and camp', time: 90, met: 4.5, tools: [{ cap: 'dig', min: 25 }], desc: 'A stone-lined pit. Bake four times as much food per batch.' } });
K('kiln', { name: 'pit kiln', fixed: true, slots: { lining: { tag: 'cobble', n: 6 } },
  caps: { kiln: () => 80 },
  build: { group: 'Shelter and camp', time: 120, met: 4.5, tools: [{ cap: 'dig', min: 30 }], desc: 'A sheltered firing pit. Far fewer pots crack.' } });
K('seep_well', { name: 'seep well', fixed: true, caps: { well: () => 85 },
  build: { group: 'Shelter and camp', time: 120, met: 5, tools: [{ cap: 'dig', min: 30 }], res: 'water', desc: 'A hole dug a few paces back from the water. What seeps in has been filtered through the bank.' } });
K('storage_pit', { name: 'storage pit', fixed: true, slots: { lining: { tag: 'cover', kg: 3 } }, cont: { vol: 150, mesh: 0, cool: true },
  build: { group: 'Shelter and camp', time: 120, met: 5, tools: [{ cap: 'dig', min: 30 }], desc: 'A lined, covered pit. Cool and dark: food kept here spoils at less than half the rate.' } });
K('clay_basin', { name: 'clay-lined basin pit', fixed: true, slots: { lining: { kind: 'clay', n: 6 } },
  cont: { vol: 20, liquid: true, ret: (it) => 55 + 0.3 * Q(P(it, 'lining'), 'plasticity') },
  build: { group: 'Containers', time: 90, met: 4.5, tools: [{ cap: 'dig', min: 25 }], desc: 'A pit puddled with clay. A big, immovable basin for hot-stone boiling.' } });
K('hide_basin', { name: 'hide-lined basin pit', fixed: true, slots: { lining: { tag: 'leather', n: 1 } },
  cont: { vol: 20, liquid: true, ret: (it) => 90 * sound(P(it, 'lining')) },
  build: { group: 'Containers', time: 60, met: 4.5, tools: [{ cap: 'dig', min: 25 }], desc: 'A pit lined with a hide pegged around the rim.' } });

K('fire', { name: 'fire', fixed: true, q: { fuel: 0.5 }, caps: { fire: () => 60 } });
K('embers', { name: 'bed of embers', fixed: true, q: { heat: 3 }, caps: { embers: () => 100 } });
K('charcoal_mound', { name: 'charcoal mound (burning)', fixed: true });
K('project', { name: 'unfinished work', fixed: true });

// Finish composite kinds: mass comes from parts, so the declared mass is 0.
export const UNIT = { ea: '', kg: ' kg', m: ' m', L: ' L', m2: ' m²' };
export const QUALITY_NOTE = {
  integrity: 'how far from breaking or rotting away', fresh: 'spoils at 0', dryness: 'wet things will not light',
  sharpness: 'edge keenness; dulls with use', hardness: 'resists denting and wear', knappability: 'how predictably it fractures',
  straightness: 'matters for shafts and spindles', strength: 'load a cord can take', flex: 'pliability; lost as it dries',
  tack: 'adhesive grip; pitch hardens and turns brittle', retention: 'how well it holds water', size: 'litres it holds',
  tannin: 'bitter and sickening above ~25', purity: 'chance the water is safe', softness: 'friction-fire wood must be soft',
  thermal: 'resistance to cracking when heated', plasticity: 'how well clay works and survives firing', smoked: 'smoked hide resists rot',
  fuel: 'hours of burning left', heat: 'hours until the embers die',
};

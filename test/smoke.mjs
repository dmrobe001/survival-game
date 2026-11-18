// Headless playthrough: drives the engine exactly as the UI does.
// Run with:  node test/smoke.mjs [seed]
import { newGame, act, recipeStatus, gatherStatus } from '../src/actions.js';
import { RECIPES } from '../src/data/recipes.js';
import { KINDS } from '../src/data/items.js';
import { RESOURCES } from '../src/data/resources.js';
import { reach, here, best, label } from '../src/items.js';
import { dayOf, hourOf } from '../src/sim.js';
import { makePlanner } from '../src/plan.js';
import { taskList } from '../src/advice.js';
import { upkeep, projectRows, NEEDS } from '../src/econ.js';
import { tiersOf, passRate, tierKey } from '../src/tiers.js';
import { canMerge, capOf } from '../src/items.js';

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL:', msg); } };
const seed = process.argv[2] || 'test-1';

// --- static checks on the content library
for (const id in RECIPES) {
  const r = RECIPES[id];
  for (const spec of r.in) {
    if (spec.kind) check(KINDS[spec.kind], `${id}: unknown input kind ${spec.kind}`);
    else check(Object.values(KINDS).some((k) => k.tags.includes(spec.tag)), `${id}: no kind has tag ${spec.tag}`);
    check(spec.n != null || spec.kg != null, `${id}: input ${spec.id} has no amount`);
  }
  if (r.res) check(RESOURCES[r.res], `${id}: unknown resource ${r.res}`);
}
for (const id in RESOURCES) if (RESOURCES[id].gather) check(KINDS[RESOURCES[id].gather.kind], `resource ${id}: unknown kind`);
for (const id in KINDS) for (const v of ['roast', 'boil', 'crush', 'dry']) if (KINDS[id][v]) check(KINDS[KINDS[id][v].to], `${id}.${v}: unknown kind`);

// --- determinism: same seed and commands give the same state
const a = newGame(seed), b = newGame(seed);
for (const s of [a, b]) { act(s, { t: 'survey' }); act(s, { t: 'explore', hours: 2, targets: ['toolstone'] }); act(s, { t: 'gather', rid: 'deadwood', min: 30 }); }
check(JSON.stringify(a) === JSON.stringify(b), 'same seed + same commands must give identical state');
check(JSON.stringify(JSON.parse(JSON.stringify(a))) === JSON.stringify(a), 'state must survive a JSON round trip');

// --- the planner: every action gets a route, and a fresh character can reach most of them
{
  const P = makePlanner(a);
  const nodes = P.keys.map(P.node);
  const lost = nodes.filter((n) => !isFinite(n.total)).map((n) => n.key);
  check(lost.length <= 3, 'planner finds no route to: ' + lost.join(', '));
  check(nodes.every((n) => n.steps.length && n.steps[n.steps.length - 1].key === n.key), 'every plan ends with its own action');
}

// --- upkeep: finite, made of its parts, and projects that save something
{
  const s = newGame(seed);
  for (let i = 0; i < 3; i++) act(s, { t: 'survey' });
  const u = upkeep(s);
  check(NEEDS.every((k) => u.parts[k] >= 0 && !isNaN(u.parts[k])), 'upkeep parts must be non-negative numbers: ' + JSON.stringify(u.parts));
  check(Math.abs(u.U - NEEDS.reduce((a, k) => a + u.parts[k], 0)) < 1e-9, 'upkeep must be the sum of its parts');
  check(u.sleep.S >= 4 && u.sleep.S <= 14, 'sleep hours out of range: ' + u.sleep.S);
  const P = makePlanner(s);
  const { base, rows } = projectRows(s, P);
  check(rows.length >= 5, 'expected several projects that cut upkeep, got ' + rows.length);
  check(rows.every((r) => !isNaN(r.saves) && !isNaN(r.horizon) && r.needs > 0), 'project rows must have numbers');
  check(rows.some((r) => r.by.sleep > 0.5), 'some project should cut sleep (a bed or shelter)');
  // a better bed means less sleep, all else equal
  const bed = upkeep(s, ['bed']), raised = upkeep(s, ['raised_bed']);
  check(bed.parts.sleep < base.parts.sleep && raised.parts.sleep < bed.parts.sleep, 'better bedding should cut sleep in order');
  // nothing is free: a project's saving is never more than the whole upkeep
  check(rows.every((r) => r.saves <= base.U + 1e-9), 'a project cannot save more than the upkeep');
  for (const sel of [null, ...NEEDS.map((need) => ({ need })), rows[0]]) taskList(s, P, sel, base);
  // determinism: evaluating upkeep must not touch the game state
  const before = JSON.stringify(s);
  upkeep(s, ['hearth', 'bark_basin']);
  check(JSON.stringify(s) === before, 'upkeep must not change the game state');
}

// --- quality tiers: merge only within a tier; better deposits pass more often
{
  const c = (h) => ({ id: 0, kind: 'cobble', n: 1, q: { hardness: h, thermal: 60, integrity: 100 } });
  check(tiersOf('cobble').q.hardness.some((x) => Math.abs(x.v - 38.9) < 0.1), 'knapping (hammer 35) should put a hardness line near 38.9');
  check(canMerge(c(40), c(43)) && !canMerge(c(37), c(41)), 'cobbles merge within a tier and not across a line');
  const soft = passRate('cobble', { hardness: 30 }, { hardness: 8 }, (it) => capOf(it, 'pound') >= 35);
  const hard = passRate('cobble', { hardness: 50 }, { hardness: 8 }, (it) => capOf(it, 'pound') >= 35);
  check(soft > 0 && soft < 0.3 && hard > 0.9, `pass rates should follow the deposit (soft ${soft}, hard ${hard})`);
  const s2 = newGame(seed);
  for (let i = 0; i < 3; i++) act(s2, { t: 'survey' });
  if (here(s2).res.cobbles && here(s2).res.cobbles.known) {
    for (let i = 0; i < 3; i++) act(s2, { t: 'gather', rid: 'cobbles', min: 30 });
    const keys = here(s2).items.filter((it) => it.kind === 'cobble').map(tierKey);
    check(new Set(keys).size === keys.length, 'cobble stacks on the ground should be one per tier: ' + keys.join(' | '));
  }
}

// --- a greedy bot: tries to stay alive and make everything it can
const s = newGame(seed);
const made = new Set();
const can = (id) => recipeStatus(s, RECIPES[id]).ok;
const tryR = (id) => { if (RECIPES[id] && can(id)) { const r = act(s, { t: 'recipe', id }); if (r.ok) made.add(id); return r.ok; } return false; };
const gather = (rid, min = 30) => { const st = gatherStatus(s, rid); return st && st.r.known && st.ok ? act(s, { t: 'gather', rid, min }).ok : false; };
const WANT = ['cobbles', 'toolstone', 'saplings', 'fiber_plants', 'softwood', 'stalks', 'twigs', 'deadwood', 'grass', 'branches', 'leaves', 'bark', 'withies', 'tubers', 'berries', 'acorns', 'nuts', 'greens', 'shellfish', 'grubs', 'slabs', 'clay', 'reeds', 'resin', 'eggs', 'seeds'];

const fuelLeft = () => { const f = reach(s).find((r) => r.it.kind === 'fire'); return f ? f.it.q.fuel : 0; };
const PRIORITY = ['knap_flakes', 'hearth_board', 'tinder', 'light_fire', 'rekindle', 'build_bed', 'build_debris_hut', 'build_lean_to', 'digging_stick'];
let maxChill = 0;
for (let step = 0; step < 1500 && !s.dead; step++) {
  const c = s.c;
  maxChill = Math.max(maxChill, c.chill);
  if (c.thirst > 0.8) act(s, { t: 'drink' });
  if (c.stomach < 800) for (const { it } of reach(s)) if (KINDS[it.kind].food && (it.q.tannin || 0) < 25 && act(s, { t: 'eat', id: it.id }).ok) break;
  if (fuelLeft() > 0 && fuelLeft() < 9 && (hourOf(s) > 17 || c.chill > 30)) { if (!tryR('add_fuel')) gather('deadwood', 30); }
  if (c.fatigue > 75 || (hourOf(s) >= 21 && c.fatigue > 40)) { act(s, { t: 'sleep' }); continue; }
  if (step % 40 === 0) act(s, { t: 'survey' });
  if (step % 60 === 30 && Object.keys(s.locs).length < 4) act(s, { t: 'explore', hours: 2, targets: ['toolstone', 'softwood', 'stalks'].filter((r) => !here(s).res[r]) });
  if (step % 25 === 5) act(s, { t: 'checkTraps' });
  if (PRIORITY.some((id) => !(id === 'knap_flakes' && best(s, 'cut').level > 30) && !(/build_|digging|hearth_board/.test(id) && made.has(id)) && !(id === 'tinder' && reach(s).some((r) => r.it.kind === 'tinder')) && tryR(id))) continue;
  let worked = false;
  for (const { it } of reach(s)) if (it.proj) { worked = act(s, { t: 'work', id: it.id }).ok; break; }
  if (worked) continue;
  let did = false;
  for (const id in RECIPES) {
    if (/^(add_fuel|resharpen|fire_harden|charcoal|build_windbreak)$/.test(id)) continue;
    if (!made.has(id) || (/roast|crush|cordage|butcher|set_snare|^snare/.test(id) && step % 3 === 0)) { if (tryR(id)) { did = true; break; } }
  }
  if (!did) gather(WANT[step % WANT.length], 30);
}

console.log(`seed ${seed}: day ${dayOf(s)}, ${s.dead ? 'DIED of ' + s.dead.cause : 'alive'}, health ${Math.round(s.c.health)}, fat ${Math.round(s.c.fat)} kcal, places ${Object.keys(s.locs).length}, worst chill ${Math.round(maxChill)}`);
console.log('made:', [...made].join(', '));
console.log('camp:', here(s).items.map(label).join('; '));
console.log('best tools:', ['cut', 'chop', 'pound', 'dig', 'hunt', 'fire', 'shelter', 'bed'].map((cap) => `${cap} ${Math.round(best(s, cap).level)}`).join(', '));
console.log(s.log.slice(-12).map((l) => '  | ' + l.msg).join('\n'));
check(made.size >= 8, 'bot should manage at least 8 different techniques');
check(Object.values(s).every((v) => !(typeof v === 'number' && isNaN(v))) && !isNaN(s.c.health + s.c.fat + s.c.thirst + s.c.fatigue + s.c.chill), 'no NaN in character state');
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);

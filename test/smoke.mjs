// Headless playthrough: drives the engine exactly as the UI does.
// Run with:  node test/smoke.mjs [seed]
import { newGame, act, recipeStatus, gatherStatus } from '../src/actions.js';
import { RECIPES } from '../src/data/recipes.js';
import { KINDS } from '../src/data/items.js';
import { RESOURCES } from '../src/data/resources.js';
import { reach, here, best, label } from '../src/items.js';
import { dayOf, hourOf } from '../src/sim.js';
import { makePlanner } from '../src/plan.js';

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

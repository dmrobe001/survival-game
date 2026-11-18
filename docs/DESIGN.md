# Design

## The four ideas

**1. Qualities, then capabilities, then actions.**
An item instance is plain data: `{id, kind, n, q, parts?, in?, proc?}`.
`q` holds its qualities (sharpness, dryness, integrity, ...). Its kind
declares *capabilities* as functions of those qualities:
`cobble.caps.pound = hardness * 0.9`. Actions ask for capabilities, never for
named tools: knapping needs `pound >= 35`. So a hard cobble is a hammerstone
the moment you pick it up, a stick is a poor digging tool, and when an edge
dulls below a task's threshold that task closes. Nothing is "unlocked" by a
flag; every lock is a live inequality.

**2. Composites keep their parts.**
A hafted axe is `{kind:'stone_axe', parts:{head, haft, binding, adhesive}}`,
each part a full item with its own qualities and its own decay. The axe's
`chop` is a weakest-link formula over the parts. Use wears parts at different
rates; time rots the binding and hardens the pitch. A part that reaches zero
is removed, the capability drops to zero, and the player fits a replacement
into that slot. Structures are the same thing with `fixed: true`: a lean-to
is a frame, a cover and lashings, and its thatch is what you re-do.

**3. One containment tree.**
Every item is in exactly one array: a place's ground, the hands, the worn
slots, or another item's contents. A container declares a volume, a mesh
size, and whether it holds liquid; an item declares a grain size. Berries
(grain 1 cm) fall through a net (mesh 4 cm); a hide bag (grain 20 cm) does
not. Crafting uses anything within reach and sets products on the ground.
The two-hands limit bites only when you walk away.

**4. Places are samples of smooth fields.**
The world is eight random fields over a plane (elevation, water, canopy,
rock, fertility, conifer share, flint, clay), each a sum of random plane
waves. A place is the fields' values at a point. Each resource has a habitat
function over that vector, so reeds occur only where it is wet and good
toolstone only on an outcrop. Nearby places are similar because the fields
are smooth; the "deposit" fields have short wavelengths, so an outcrop can be
a short walk from none. Nothing is stored: the world is a pure function of
the seed.

## Exploration procedure

`explore(hours, targets)` draws `5 * hours` candidate points within
`0.9 * hours` km, generates each, and scores it by the mean over targets of
(abundance x key quality), plus perception noise. The best-scoring candidate
becomes a new place if its true score clears a threshold; otherwise the trip
fails. With no targets the pick is random and always succeeds.

Stacking targets dilutes the search for a statistical reason rather than an
imposed penalty: the maximum of N draws of a mean of k roughly independent
values sits about 1/sqrt(k) as far into the tail as the maximum for one.

## The planner (Plan tab)

Requirements form an AND/OR graph: an action needs all of its tools, inputs
and resources; each of those can be supplied by any of several providers
(gather here, walk to a known place, search for a new one, or another
recipe). `src/plan.js` picks the cheapest provider by estimated minutes,
recursively, and returns the ordered steps. Policies:

- Times add up rather than taking the maximum, because one person works one
  thing at a time.
- It only uses what the character knows. A resource not yet seen is priced
  as a search, using the success rate of the game's own exploration
  procedure replayed from 40 random origins in this world. That is the
  character's "background knowledge" of how common things are; real searches
  scatter around the average.
- What each recipe produces is discovered by running its `make` function
  against a recording stand-in, so new recipes need no extra annotation.

The web lays actions out by total time (columns) and kind of work (rows).
Goals mark every step on their route; the steps you can do now are listed at
the top.

## The main screen

Top to bottom: the reserve that runs out first, projects, tasks you can do
now, what is on the ground, and your two hands.

- **Upkeep** heads the projects panel: the hours a day that staying alive
  here costs, split into sleep, food, water, fire and repairs (see
  *Upkeep* below). Tap a need to see what its hours are made of; the
  projects then sort by how much they cut that need.
- **Projects** are techniques, and collecting things that work as tools
  (a cobble is a hammerstone), shown with three numbers: *needs*, the hours
  of work to do it once by its planned route from where you stand; *saves*,
  the hours of upkeep a day it would take off, with everything that route
  leaves you holding; and *pays in*, needs ÷ saves in days. Tap a column to
  sort by it. Projects that change nothing are left out, and so is any
  project that only repeats a quicker one's gains with extra steps. The
  route is the bundle: "Boil water" needs the fire and the basin too, and
  saves what having all of them saves.
- **Tasks** are only what one tap can do now. Steps on the selected
  project's route come first, in route order. A collecting step that has
  to turn up a good-enough piece says how often one does ("about 47% of
  the cobbles here will do for a hammer (35+)").
- **Finishing the selected project** (the technique succeeds, or one
  collecting trip for a collecting project) closes it, or, if you reached
  it through a requirement link, goes back up to the project it was a step
  toward.
- **The status bar** shows reserves in two zones, split by a comfort line
  (the tick). Above it nothing happens; the bar just counts down. Below it
  you are impaired: work and travel slow and injuries get likelier, in
  proportion to depth, until a harm line where health starts to go. The
  soonest crossing is shown, paced on the first task that takes real time;
  tap for all. Thresholds live in `LIMITS` in `src/sim.js`:

  | Reserve | Impaired past | Harmed past | Max penalty at harm line |
  | --- | --- | --- | --- |
  | Food (stomach + glycogen) | under 800 kcal | under 0 (then fat) | +30% work time |
  | Water deficit | 1 L | 4.5 L | +30% time, injury ×1.5 |
  | Fatigue | 60 | 100 (collapse) | +40% time, injury ×2 |
  | Chill | 30 | 70 | +30% time, injury ×1.5 |

  Water loss is 0.1 L/h at rest plus 0.12 L/h per unit of metabolic rate
  above rest, so a few hours of work without drinking makes you thirsty.
  The thresholds sit near where measurable impairment is reported (about
  1.5–2% of body mass for water), but every number here is a judgment
  call, not a sourced value.
- **Hands.** What you collect or make lands in a hand (or a container you
  hold or wear that fits it). The remainder of something you worked from,
  such as a knapped core, is set down. Tools just used are never displaced;
  otherwise the thing held longest is set down. Only one hand's worth is
  picked up per action. Toolstone is now a lump measured in kilograms that
  knapping wears down. Of a collecting trip, only the best stack goes to
  hand, and it never displaces a better piece of the same kind (it does
  displace a worse one).

## Quality tiers (src/tiers.js)

A quality matters only where some rule tests it, so stocks are stratified
by those tests rather than tracked as continuous distributions.

- **Lines come from the library.** Input and slot minimums are lines as
  they stand (a spear shaft needs straightness 45). Tool minimums are
  turned into lines on the quality a kind's capability formula depends on,
  by bisection with its other qualities at their defaults: knapping needs a
  hammer of 35, and a cobble's hammer is 0.9 × hardness, so hardness 38.9.
  Upper limits ("can still be resharpened") and freshness 25 (safe to eat)
  are lines too. A tier is the interval between two lines.
- **Merging.** Like items merge unless a line falls between them. An
  interval is closed under averaging, so a merged stack is never worse for
  any recipe than its parts; qualities no rule tests just average. A good
  hammer therefore keeps its identity until good hammers are common enough
  to stack.
- **Collecting.** Pieces scatter around their deposit's mean by 70% of the
  scatter between deposits (a guess). A trip draws them one by one (loose
  material by the half handful, lumps by the half kilogram, at most 12
  draws), sorts them into tiers, and gives each tier its own stack, so the
  best of the trip stands apart. The journal says what the best is good
  for. Stash pills and hands show the highest line a piece clears.
- **Planning.** Expected time to a passing piece = pieces needed ÷ (pieces
  an hour × fraction that pass). The fraction comes from 200 fixed normal
  draws per deposit, so it is deterministic. The planner compares here,
  every known place (plus the walk) and searching (an unknown deposit:
  typical mean, the two scatters combined). The upkeep evaluator values a
  collected tool as the typical best of one half-hour trip (the expected
  largest of that many normal draws).

## Upkeep (src/econ.js)

A survivor's progress is measured as the hours a day that staying alive
takes, and every project is judged by how much it cuts them.

    U = sleep + food + water + fire + repairs      (hours a day, at this place)

Only the body's needs are demanded directly: energy, water, rest and
warmth. Everything else is derived demand and reaches U through *prices*,
the hours it takes to make one more unit of a thing with what you have.

**Prices, from the ground up.** Start from what can be collected here
(hours per unit = 1 / collecting rate). Then let every recipe whose tools
you have offer its products at (time + tool wear + fire + inputs) / yield,
keep the cheapest offer for each kind, and repeat until nothing changes.
This is Knuth's 1977 generalisation of Dijkstra's algorithm to AND/OR
graphs, run in Bellman–Ford order. Its known weakness: a recipe with
several products charges its whole cost to each, so joint products (a
butchered deer) are over-priced one by one; linear programming would split
them exactly.

**Long-run supply.** Each resource regrows logistically, so the most it
can give for ever is its maximum sustainable yield, about
1.06 × regen × capacity a day. The first half of that is taken at 85%
abundance, the second half at 60%. More than that comes "from further
afield": country like this (the fields vary smoothly) at the same rates,
for a daily walk (1 h, a guess) and, for firewood, the trips to carry it
home with whatever you can carry. Food is filled cheapest first, choosing
between living off what regrows here and walking out each day.

**Each need.**

| Need | How its hours are found |
| --- | --- |
| Sleep | Fatigue builds at 3.2 an hour awake and clears at 12 × quality an hour asleep, so sleep = 24·3.2 / (12q + 3.2). Quality comes from bed, shelter and roof, and from a night simulated hour by hour (same chill rules as the game) for each kind of weather: chill past 40 spoils sleep, past 85 wakes you for good, past 70 costs health, charged at 1 h per point (a guess). |
| Food | Energy at 70 kcal/h × metabolic rate (0.95 asleep, 2.2 awake). Each resource offers its food by its best route (raw, roasted, boiled, pounded, leached, dried, butchered), costing collecting, hands-on processing, and illness: each bout of gut sickness is charged 10 h (a guess). A carcass spoils faster than you can eat it unless dried or kept cool. |
| Water | 0.1 L/h asleep and about 0.25 L/h awake; drinking as it is (illness odds from purity) or boiling, whichever costs less; a walk if there is no water here. |
| Fire | Hours of burning a day (all night if sleeping by a fire is cheaper overall, otherwise just cooking and boiling) × wood per hour, plus lighting it once a day by friction (failed attempts wear the spindle and board). With a fire but nothing to relight it, it must burn all day. |
| Repairs | Things that rot by the day (bedding, thatch, baskets) last until half gone, then cost their material plus refitting. |

**A project's saving** is U now minus U with everything its planned route
makes or collects (less what a later step uses up). Goals add a one-off
term: the hours a project takes off your ticked goals, so
pays-in = (needs − goal hours saved) / saves.

What is reproducible: given a state, every number here is deterministic
and the evaluator never changes the state (tested). What is guessed: the
1 h walk, 10 h per sickness, 1 h per health point, and the 85%/60%
abundance split are judgment calls; the rest follows the game's own rules.

## Time

Every action calls `advance(minutes, met, mode)`, which steps in 15-minute
slices. `met` is metabolic intensity (1 = lying still, about 70 kcal/h).
Each slice updates the body (stomach to glycogen to fat; water; fatigue;
chill from felt temperature; health), the weather, every item at every known
place, and regrowth. Abundance regrows logistically; minerals do not.

Jobs longer than about two hours become an "unfinished" object holding their
materials, worked on in sessions. Unattended processes (drying, leaching,
charcoal) are a `proc` on the item that counts down on its own.

## What is reproducible and what is guessed

Reproducible: given a seed and a command sequence, the state is identical
(tested). All randomness goes through one stream in the state.

Guessed: nearly every number. Gathering rates, calorie values and work times
are order-of-magnitude figures from the ethnographic and experimental
archaeology literature as I remember it, not sourced values. Injury and
illness odds, the cold model and trap rates are invented to feel plausible.
Treat the library as a first draft to be corrected against sources.

## Infrastructure in the library now

Windbreak, lean-to, debris hut, thatched hut; bedding pile, raised bed; stone
hearth; drying rack; earth oven; pit kiln; charcoal mound; seep well; storage
pit; clay-lined and hide-lined basin pits; fish weir; dugout trough.

## Suggested next steps

- **Upkeep, next:** tool wear by the hour of use is in, but resharpening
  is not; daytime cold is ignored; bringing resources from other known
  places (and so the value of better transport) is approximated by the
  fixed daily walk.

- **Seasons.** A day-of-year term in temperature and in each resource's
  habitat (acorns in autumn, eggs in spring) turns storage from an option
  into the point of the game.
- **Skill as a quality of the person.** Knowledge is total, but hands are
  not: a per-technique practice level that scales failure odds and time.
- **Fire as a managed object.** Banking, carrying coals in a bark tray,
  smoke for hides and meat, a fire's heat reaching only what is near it.
- **Wetness on the body and on items generally**, with drying by a fire.
- **Predators and scavengers** acting on unattended camps, which gives caches
  and raised platforms a job.
- **More infrastructure:** smokehouse, root cellar, wattle-and-daub walls,
  raised cache, hide-stretching frame, tanning pit, rain catch, pit-fall
  trap, garden plot, bloomery (the charcoal is already there).
- **More tools:** bow and arrows, atlatl, adze, bone needle, hide glue,
  rawhide lacing, tallow lamp, sled, coracle.
- **A command log** saved with the state, so any game can be replayed and
  shared as seed plus commands.
- **Location memory.** Show a distant place as last seen, not as it is now.

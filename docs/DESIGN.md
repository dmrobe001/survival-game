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

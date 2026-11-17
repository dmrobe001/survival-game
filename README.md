# Foothold

A browser game about realistic survival, in the style of incremental games
(menus, tabs, buttons and lists; no graphics). One person wakes empty-handed
and exposed, knowing how everything is made but not what is over the next
rise, and tries to establish a technological foothold.

## Play

No build step and no dependencies. The game is plain JavaScript modules, which
browsers only load over http, so either:

```bash
python3 -m http.server 8000
```

and open <http://localhost:8000>, or bundle it into one file you can
double-click:

```bash
node tools/bundle.mjs
```

which writes `dist/foothold.html`.

## Test

```bash
npm test
```

runs a headless bot through the engine on three seeds. It checks the content
library for dangling references, checks that the same seed and the same
commands give byte-identical state, and reports how the bot fared.

## Layout

| Path | What it is |
| --- | --- |
| `src/data/items.js` | Every kind of object: qualities, capabilities, decay, parts, containers |
| `src/data/resources.js` | What a place can offer, and the habitat each thing needs |
| `src/data/recipes.js` | Everything the character knows how to do |
| `src/world.js` | Procedural places from smooth random fields |
| `src/items.js` | Item instances: containment tree, stacks, capability lookup |
| `src/sim.js` | Passage of time: body, weather, decay, fires, traps, regrowth |
| `src/actions.js` | Commands: the only way state changes |
| `src/ui.js` | The page. No rules live here |
| `test/smoke.mjs` | Headless bot |
| `tools/bundle.mjs` | Single-file bundler |

To add content you usually touch only `src/data/`. See
[docs/DESIGN.md](docs/DESIGN.md) for how the framework fits together and why.

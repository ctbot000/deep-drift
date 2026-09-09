# Deep Drift

A browser mining game in 3D. Dig a hole, get rich, buy a bigger drill, and find
out what is humming at 250 metres.

**▶ [Play it](https://ctbot000.github.io/deep-drift/)**

No build step, no dependencies, no assets — the whole game is a few files of
JavaScript. The world is drawn as instanced voxels in raw WebGL2 (no Three.js,
no import map), the sounds are a WebAudio synth, and the only thing loaded over
the network is the source itself.

---

## The loop

Drill down, fill the hold with ore, fly back to the surface and sell it. Spend
the money on a drill that bites harder rock, a tank that gets you deeper, and a
hold that makes the trip worth it. Repeat until you can cut the Core.

The catch: **you cannot drill upwards.** Thrusters are the only way home, and
they drink fuel. Every metre down is a metre you still have to climb.

### Controls

| Key | |
|---|---|
| <kbd>←</kbd> <kbd>→</kbd> / <kbd>A</kbd> <kbd>D</kbd> | Move, and drill sideways into rock |
| <kbd>↓</kbd> / <kbd>S</kbd> | Drill straight down |
| <kbd>↑</kbd> / <kbd>W</kbd> / <kbd>Space</kbd> | Thrusters |
| <kbd>E</kbd> | Use the building you are parked on |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> | Recall Beacon · Patch Kit · Fuel Cell |
| <kbd>R</kbd> | Call a rescue tug when stranded |
| <kbd>Esc</kbd> <kbd>H</kbd> <kbd>M</kbd> | Pause · help · mute |

Touch controls appear automatically on phones and tablets.

### What will kill you

- **Falling.** Long drops into open caves hurt.
- **Magma.** Bright orange, and it does not care about your hull.
- **Gas pockets.** The green ones detonate when the tile beside them goes.
- **Running dry.** No fuel means no thrusters, and the surface is a long way up.

A wreck is survivable: the salvage crew tows you up and recovers about a third
of the load. Running out of fuel is survivable too — a rescue tug costs a
quarter of your cash, and never strands you permanently.

### The look

Rock is a solid slab of blocks facing the camera, and everything you have dug is
a corridor carved into it — so the shaft behind you is a real trench with walls,
lit by the rig's headlamp. Ambient light drains away with depth until the lamp
is all you have. Ore crystals, lava and the Core are emissive, which is why you
can spot a diamond in the dark before you can see the rock around it.

If WebGL2 is unavailable the game falls back to a flat canvas-2D renderer with
the same framing and the same rules.

### The world

256 metres of hand-tuned bands, from topsoil to the core shell, with nine ores
whose value climbs roughly a hundredfold on the way down. Every world is
generated from a seed, so no two runs dig the same hole.

| Depth | Rock | What is down there |
|---|---|---|
| 0–35 m | Topsoil | Coal, copper |
| 35–85 m | Rock | Copper, iron |
| 85–140 m | Dense rock | Iron, silver, first gold |
| 140–190 m | Obsidian | Gold, platinum, emerald |
| 190–240 m | Magma rock | Emerald, diamond — and lava |
| 240–255 m | Core shell | Aetherium, and the Core itself |

Each band is harder than the last, and the drill head is the gate: reaching the
Core needs the fourth of six drill tiers, which is roughly a $30,000 rig.

---

## Running it locally

Any static file server will do — the game uses ES modules, so `file://` will
not work.

```bash
python3 -m http.server 8123
```

Then open <http://localhost:8123>.

## Layout

```
index.html          markup, HUD and screens
css/style.css       all styling
js/config.js        tiles, ores, upgrades, physics constants — pure data
js/world.js         seeded world generation, fog of war
js/sim.js           game state and the fixed-step simulation
js/render3d.js      WebGL2 voxel renderer
js/mat4.js          the four matrix operations that renderer needs
js/render.js        canvas-2D renderer, used when WebGL2 is missing
js/ui.js            HUD, depth gauge and the base panels
js/audio.js         WebAudio synth — no sound files
js/main.js          renderer selection, input, game loop, saving
tools/balance.mjs   headless playtest bot
tools/*.html        dev-only render and UI inspection pages
```

`config.js`, `world.js` and `sim.js` never touch the DOM. That is what lets the
playtest harness run the real game logic in Node.

## Playtesting

The game ships with a bot that plays it — it digs, hunts for scanned ore with a
committed target, retraces its tunnels home with a breadth-first search, shops,
and dies in lava. It exists to answer "is this still winnable and still paced?"
after a balance change:

```bash
node tools/balance.mjs           # default seeds
node tools/balance.mjs 11 12 13  # specific seeds
PHASES=1 node tools/balance.mjs  # time spent descending vs climbing vs shopping
```

It also asserts the loop invariants: that chopping the same wall time into
30/60/144 Hz frames lands the simulation in exactly the same place, and that a
backwards timestamp cannot silently stall it.

A typical result — the bot is a mediocre player, and a person is faster:

```
seed   4 WON     36m 55s  deepest 250m  earned $59,079  wrecks 3  [d4 f4 h3 c4 e4 s3]
seed   6 WON     44m 13s  deepest 250m  earned $58,776  wrecks 3  [d4 f3 h3 c3 e3 s3]
```

## Notes on the build

A few things that were less obvious than they looked:

- **The rig is narrower than a tile**, so its footprint can straddle two
  columns. Aiming the drill at the tile under its centre meant that a rig
  resting on one tile drilled at the empty one beside it — pressing down did
  nothing, forever. The drill now scans the whole face it is pushed against and
  takes the diggable tile nearest the centre, then eases the hull onto it.
- **The simulation runs on its own accumulated clock**, never on wall time, and
  every particle and toast expires against it. A hidden tab delivers no
  animation frames, and effects counted in frames simply freeze on screen.
- **A headlamp on a flat wall needs wrapped diffuse.** Almost every surface the
  player sees is a front face with the same normal, so a textbook `N·L`
  terminator leaves everything more than a few tiles out unlit however bright
  the lamp is. Softening the term, and pushing the lamp well in front of the
  rock face, is what makes the light pool read as a pool.
- **Palettes do not survive a change of shading model.** The rock colours were
  picked against flat 2D fills; run through diffuse lighting and distance fog
  they came out near-black, and every deep band had to be brightened.
- **The 2D fallback snaps its camera to whole device pixels.** A fractional
  offset seams every tile edge while the view moves, and only while it moves.
- **A collapsed canvas measures 0×0**, and every value derived from it — zoom,
  viewport, camera clamp — is nonsense from there, so the measurement has a
  floor.

## Licence

MIT — see [LICENSE](LICENSE).

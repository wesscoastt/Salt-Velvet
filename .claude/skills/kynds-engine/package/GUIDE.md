# The Kynds Engine

The reusable engine under Kynds: Medieval, built by extracting what already works (never a
rewrite). The plan, audit and roadmap are in `docs/ENGINE_PLAN.md`; this file is the module map.

## The seam
- `src/engine/` is the engine. Everything else (`src/game`, `src/ui`, `src/sim`, `src/render`) is
  Kynds: Medieval: its content, lots, kingdom, UI and the systems not yet extracted.
- The engine **never imports the game**. Its `core/` and `sim/` layers stay **headless** (no
  three.js, no DOM), so the simulation keeps running in Node. `tests/engine-boundary.test.ts`
  enforces both.
- Moved modules keep a one-line re-export at their old path, so the game's imports are unchanged.
  New code should import from `src/engine/` directly.
- Content plugs in through registries (`Registry<T>`), not by the engine knowing the game.

## Modules
| Path | What it is | Since |
| --- | --- | --- |
| `engine/core/EventBus.ts` | Typed publish/subscribe | M1 (from `src/core`) |
| `engine/core/Rng.ts` | Seeded random numbers (deterministic worlds and tests) | M1 (from `src/core`) |
| `engine/core/math.ts` | Vectors, boxes, angles, distances | M1 (from `src/core`) |
| `engine/core/Registry.ts` | Content by id: ordered, no silent replacement | M1 |
| `engine/core/Profiler.ts` | Frame spans, counters, rolling stats (off unless switched on) | M0 |
| `engine/core/BuildJobs.ts` | Time-sliced building: generator jobs by key and priority, run a few ms a frame; `finish` when needed now | M2 |
| `engine/sim/nav/NavGrid.ts` | The walkable grid: blocking boxes, doors, stairs, storeys; remembers each centre-to-centre step and every walk found impossible until it changes (M4) | M1 (from `src/sim/nav`), M4 |
| `engine/sim/nav/Pathfinder.ts` | A* over the grid, with stairways between storeys | M1 (from `src/sim/nav`) |
| `engine/sim/save/SlotStore.ts` | Guarded save slots and a reload handoff over any key-value storage; `{ packed: true }` writes packed values and reads either form | M1, M4 |
| `engine/sim/SimTiers.ts` | Simulation tiers: assign each agent a tier per tick; promotion and demotion events; counts | M4 |
| `engine/sim/Archive.ts` | The persistent memory store: records about those who have left the world, by id, bounded, saved | M4 |
| `engine/sim/save/pack.ts` | `pack` / `unpack`: a dictionary coder written 15 bits to a UTF-16 unit, safe in Web Storage (saves about 6× smaller) | M4 |
| `engine/render/instancing.ts` | Chunked instancing with crossfading LOD (`FadeLOD`) | M1 (from `src/render`) |
| `engine/render/MaterialFeatures.ts` | Material features: each a GLSL patch (WebGLRenderer) and, once ported, a TSL graph (WebGPURenderer); materials record theirs; `toNodeMaterial` rebuilds one as a node material | M5 |
| `engine/render/release.ts` | Free an unloaded part of the world's GPU resources, keeping anything still on show shares (`releaseUnshared`, `heldBy`) | M3 |
| `engine/render/merge.ts` | Merge same-material meshes, keeping the hierarchy | M1 (from `src/render`) |
| `engine/render/coplanar.ts` | `separateCoplanar`: set faces that share a plane a few millimetres apart (no z-fighting) | M5 era |
| `engine/anim/ik.ts` | Two-bone IK: `twoBonePlanar` (a leg seen side on), `twoBone` (in space, with a pole), `reach`, `crouchAngle` | M6 |
| `engine/anim/pose.ts` | Poses as joint records; `PoseGraph` (ordered layers with conditions), `easePose`/`easeFactor`, `blendPose`, `PoseClip` (authored keyframes, looped or held, weighted) | M6 |
| `engine/sim/slots.ts` | Slots (where someone uses an object) authored in the object's frame and placed in the world; `Reservations`: who holds which | M7 |
| `engine/sim/customise.ts` | The customisation model: channels, append-only palettes, choices kept as indices, `index` and `sanitize` | M7 |
| `engine/build/placement.ts` | Build tools' placement modes (grid, half, fine, free): `snapTo`, `turn`, `settle`, whether overlap is allowed | M7 |
| `engine/anim/rig.ts` | `RiggedAnimal` (what every animal model offers the game) and `GaitClock` (gait phases from distance walked) | M6 |

Still in the game, and next to move (see the roadmap): avoidance (it reads `Kynd` and
`Simulation` directly), the action framework, autonomy, needs, emotion, time and climate, the
character kits, water, `detailMaterial`, audio and `sdfMesh`.

## Staged builds (M2)
Anything that takes more than a frame to make is written as a generator that `yield`s between
steps, with a synchronous wrapper that runs it in one go (`runAll`):

```ts
export function* buildThingSteps(args): Generator<void, Thing> { /* ...; yield; ... */ return thing; }
export const buildThing = (args) => runAll(buildThingSteps(args));
```

Staged builders compose with `yield*` (a lot scene runs its terrain, vegetation, furniture and
cottages as sub-steps). The game queues them on one `BuildJobs` and calls `tick(budgetMs)` once a
frame; a result is registered only when its last step has run, so nothing ever shows a half-built
place, and anything that needs one sooner calls `finish(key)`. Staged today: `LotScene`,
`LotScenery`, `Vegetation`, `ObjectViews.syncSteps`, the lot ground paint, `KingdomWorld`, and the
market procession, jousting knight and hunt party. A single step should stay well under a frame; the
longest left are one Kynd avatar (~0.18 s in software rendering) and one heavy object.

## Streaming (M3)
Lot scenes come and go with the view. The game keeps the home lot, the lot on show and every lot
near it, plus the six most recently seen (`Game.SPARE_SCENES`); every five seconds the rest are
taken out of the scene and released with `releaseUnshared(gone, kept)`. That works like a collector
rather than reference counts: whatever the unloaded scene reaches and nothing kept reaches is
disposed, and three.js re-uploads anything disposed that is used again, so a missed share costs an
upload, never a broken frame. The kingdom itself is not partitioned: measured, it is static,
chunk-culled and cheap (≤ 54 draws), and the map needs it whole. Lots are built ahead of the camera along its smoothed pace
(`Game.LOOK_AHEAD`, 2.5 s), so a quick pan finds the place ready.

## Material features and WebGPU (M5)
WebGPURenderer draws only node materials, so every custom look is a registered feature with both
versions (`defineFeature({ id, glsl, key, tsl })`) and is put on a material with `addFeature`
(which composes with any older hand-written patch). The game stays on WebGLRenderer; a feature is
ported by writing its `tsl` and passing the parity check:

```bash
npm run dev            # then, in another shell:
node scripts/parity.mjs .shots/parity   # one scene through both renderers, plain and with features
```

A port passes when its share of pixels off by more than 16 levels is within one point of the two
renderers' own difference on plain materials (0.02 %). Ported:

| Feature | Scene | Pixels over 16 |
| --- | --- | --- |
| `detail` (tri-planar surface detail, its own screen-derivative bump) | 12 kinds | 0 % |
| `season` (8 kinds; grass and flowers squashed before instancing; per-tree autumn colour from each instance's origin) | autumn and wet | 0.01 % |
| `season` | winter, snow 0.7 | 0.47 % |
| `garment` (9 cloth kinds by vertex: weave, patterns, mail rings, folds, dye, hem, sheen; rest pose before skinning) | 9 cloth columns | 0 % (mean 0.6) |
| `skin`, `eye`, `hair` (face texture masks, age, stubble, freckles, scar, warm scatter; procedural iris, whites and catch-light; hair rim on the strand bump) | a face ball, three eyes, a hair column | 0 % (mean 1.2) |
| `fur`, `fur-shell` (pet coats: fields, markings, stripes, ticking, locks and strands, relief, rim; shells pushed out after skinning via `positionNode`) | two pet bodies, one with 3 shells | 0 % (mean 1.0) |
| `water` (fixed, per-vertex and mapped depth; foam, ripples, sky mirror, sun glitter, glow) | pond, river, shore | 0 % (mean 3.1: a touch paler in the deeps) |

Hooks a feature can use besides `tsl` (whole-material nodes): `tslDiffuse` (the finished diffuse
colour, after vertex and instance colours and the alpha test; may discard) and `tslPosition` (the
vertex in the object's own frame, before instancing). `instanceOrigin(T)` is the world position of
the instance a fragment belongs to. Node materials carry their features in their program cache
key: without it, materials differing only in a hook share one program (found by the parity check).

The water's GLSL reads three's first directional light for the sun's glitter; node materials can't,
so its node version reads `WATER_SUN` (world direction toward the sun, colour × intensity), which
whoever draws with WebGPU keeps in step with the sun.

Shared helper: `bumpNormal(T, height)`, the screen-derivative bump GLSL patches write by hand.

`toNodeMaterial` also carries over the plain maps (bump, normal, roughness, emissive, alpha).

Every material the game draws now has its node version (15 parity scenes pass). A whole
hand-written `ShaderMaterial` gets one with `portShader(material, (gpu, T) => nodeMaterial)`.
Left for M5b, the backend switch: snow as sprites, the leaves' seasonal shadow twins, the far haze,
fog mixed after the output conversion as WebGL does, and PostFX. The WebGPU build of
three.js is a separate copy of the library, so game code never imports it; only the parity page
(and, later, the opt-in backend) does.

## Animation (M6)
A Kynd's body pose is built each frame by `BODY_GRAPH` (KyndAvatar), a `PoseGraph` of layers in
order (mount, ride, walk, climb, posture, activity, life, traits, emotion, habit, hold, plant
feet); the hands, head turn, reach to the mouth and the book follow, then `easePose` eases the
skeleton toward the result. Authored animation is a `PoseClip` laid over that with a weight (the
wave hello). Every animal model is a `RiggedAnimal`; legs reach their footfalls through
`engine/anim/ik.ts`, and the horse's walk and trot run on a `GaitClock`.

## The package and the skill (M8)
`src/engine/index.ts` is the headless entry point, `src/engine/render/index.ts` the three.js one.
The `kynds-engine` skill exports the engine as a package for a new Kynds game
(`node .claude/skills/kynds-engine/scripts/export-engine.mjs <dir>`): the sources, a generated
`API.md`, this guide, and a starter game with tests. `tests/engine-kit.test.ts` keeps the committed
package current.

## Using it
```ts
import { Registry } from './engine/core/Registry.ts';
import { SlotStore } from './engine/sim/save/SlotStore.ts';

const defs = new Registry<ObjectDef>('object def');
defs.registerAll(MY_OBJECTS, (d) => d.id);

const saves = new SlotStore<MySave>('my-game:save:'); // localStorage by default
saves.write('1', snapshot);
```

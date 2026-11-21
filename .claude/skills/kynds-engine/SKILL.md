---
name: kynds-engine
description: Start or build a new Kynds game (a life sim, or any people-and-places sim in three.js) on the Kynds Engine — the reusable core under Kynds: Medieval — navigation and pathfinding with stairs, furniture slots and reservations, saves packed for Web Storage, simulation tiers, a memory archive, time-sliced build jobs, a customisation model, build-tool placement modes, two-bone IK, pose graphs and authored clips, animal rig interfaces, and its three.js half (material features with WebGPU node versions and a parity check, chunked LOD instancing, merging, freeing unloaded scenes, z-fighting removal). Use when asked to start a new Kynds game, reuse the Kynds engine, export or update the engine package, or add an engine module.
---

# Kynds Engine

The engine is `src/engine` in the Kynds: Medieval repository. It never imports the game; its core,
sim, anim and build layers are headless (they run in Node, no three.js); `render/` is the three.js
half. `docs/ENGINE.md` is the guide (also shipped as `GUIDE.md`), `docs/ENGINE_PLAN.md` the roadmap.

## Starting a new Kynds game
1. Export the package from a Kynds: Medieval checkout:
   `node .claude/skills/kynds-engine/scripts/export-engine.mjs <newGame>/kynds-engine`
   (with no argument it refreshes `.claude/skills/kynds-engine/package/`, committed with this skill).
2. In the new game, depend on it (`"kynds-engine": "file:./kynds-engine"`) and import
   `kynds-engine` (headless) or `kynds-engine/render` (three.js). Its only peer is `three`.
   It ships TypeScript sources with `.ts` imports: Vite and Node ≥ 22.6 (type stripping) run them
   as they are. Keep to erasable TypeScript (no `enum`, `namespace`, constructor parameter properties).
3. Start from `starter/world.ts`: a room, a hearth and stools, people who find a free seat by the
   fire and sit (Registry, NavGrid, findPath, placeSlots, Reservations, SimTiers, pack). Run its
   tests with `node --test starter/*.test.ts`. Grow it the way Kynds: Medieval is built:
   - simulation in its own folder that never touches three.js or the DOM (the `life-sim-core`
     skill has the architecture: needs, autonomy, actions, interactions, saving);
   - people from the `humanoid-characters` / `kynd-characters` kit, animals from `animal-models`
     (both use this engine's `anim` and `MaterialFeatures`);
   - every custom shader look as a material feature (below), never a bare `onBeforeCompile`.

## The modules (API.md lists every export)
| Need | Module |
| --- | --- |
| Seeded randomness (repeatable worlds and tests) | `core/Rng.ts` |
| Content by id, in order, no silent replacement | `core/Registry.ts` |
| Vectors, oriented boxes, quarter-turn rotations | `core/math.ts` |
| Events, frame profiling | `core/EventBus.ts`, `core/Profiler.ts` |
| Building big things a few ms a frame | `core/BuildJobs.ts` (generator jobs; `finish` when needed now) |
| A walkable grid with storeys and stairs; A* | `sim/nav/NavGrid.ts`, `sim/nav/Pathfinder.ts` |
| Where people use objects; who holds which | `sim/slots.ts` |
| Saves: guarded slots over any storage, packed ~6× smaller | `sim/save/SlotStore.ts`, `sim/save/pack.ts` |
| Full/reduced simulation by where someone is | `sim/SimTiers.ts` |
| Remembering people who've left the world | `sim/Archive.ts` |
| Re-colouring things from palettes that only grow | `sim/customise.ts` |
| Build-tool placement modes (grid, half, fine, free) | `build/placement.ts` |
| Limbs reaching targets; poses, layers, clips; animal rigs and gaits | `anim/ik.ts`, `anim/pose.ts`, `anim/rig.ts` |
| Custom material looks for WebGL and WebGPU | `render/MaterialFeatures.ts` |
| Chunked instancing with crossfading LOD; merging; freeing unloaded scenes | `render/instancing.ts`, `render/merge.ts`, `render/release.ts` |
| No z-fighting in procedural models | `render/coplanar.ts` (`separateCoplanar` before merging) |

## Recipes
- **A custom look** (a coat, wind sway, a ground's detail): `defineFeature({ id, key, glsl, tsl/tslDiffuse/tslPosition })`
  once, then `addFeature(material, id, params)`. Prove the TSL version with the parity page
  (Kynds: Medieval's `parity.html` + `node scripts/parity.mjs`: a case passes within the plain
  baseline + 1 % of pixels off by more than 16 levels). A whole `ShaderMaterial`: `portShader`.
  Instances: `instanceOffset`, `instanceColumn`, `instanceOrigin`. Never clone a featured material
  without carrying `userData.features` by reference.
- **A pose layer or gesture**: add a `PoseLayer` to the character's `PoseGraph`, or author a
  `PoseClip` and `sample(t, target, weight)` it over the graph's result before easing.
- **A leg or arm on a target**: `twoBonePlanar` (side plane) or `twoBone` (with a pole).
- **An object people use**: `SlotSpec`s in its own frame; `placeSlots` for the world;
  `Reservations` so two never take one seat.
- **Loading a lot without a hitch**: build it as a generator and hand it to `BuildJobs`.

## Rules
- The engine never imports game code (a test in Kynds: Medieval, `tests/engine-boundary.test.ts`,
  enforces it); `core`, `sim`, `anim`, `build` stay headless.
- Moving a module into the engine leaves a re-export at its old path.
- After changing the engine, refresh the package (`export-engine.mjs`) and run
  `node --test tests/engine-kit.test.ts`: it checks the package is the engine's own code, the API
  reference names each module's exports, and the starter passes on the package alone.

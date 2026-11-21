/**
 * The Kynds Engine: its headless half (core, simulation, animation, build tools). Runs anywhere,
 * Node included, with no three.js. The three.js half is `engine/render/index.ts`.
 * docs/ENGINE.md is the guide; the `kynds-engine` skill exports it as a package for a new game.
 */
export * from './core/math.ts';
export { Rng } from './core/Rng.ts';
export { Registry } from './core/Registry.ts';
export { EventBus, type Listener } from './core/EventBus.ts';
export { Profiler, profiler, type ProfileSnapshot, type Stat } from './core/Profiler.ts';
export { BuildJobs, runAll, type JobOptions } from './core/BuildJobs.ts';

export { NavGrid, type Cell, type NavLink, type StairWay } from './sim/nav/NavGrid.ts';
export { findPath, pathLength, type PathOptions, type StairPoint } from './sim/nav/Pathfinder.ts';
export { SlotStore, Handoff, browserLocal, browserSession, NO_STORAGE, type StorageLike, type StoreOptions } from './sim/save/SlotStore.ts';
export { pack, unpack } from './sim/save/pack.ts';
export { SimTiers, type TierChange } from './sim/SimTiers.ts';
export { Archive, type ArchiveSave } from './sim/Archive.ts';
export { placeSlots, parseSlotKey, slotKey, Reservations, toWorld, type PlacedSlot, type Placement, type SlotSpec } from './sim/slots.ts';
export { Customisation, type Offer, type Swatch } from './sim/customise.ts';

export { crouchAngle, reach, rootAngle, twoBone, twoBonePlanar, type Planar, type Spatial, type V3 } from './anim/ik.ts';
export { blendPose, easeFactor, easePose, PoseClip, PoseGraph, type ClipKey, type Pose, type PoseLayer } from './anim/pose.ts';
export { GaitClock, type LookPoint, type RiggedAnimal } from './anim/rig.ts';

export { PLACEMENT_MODES, settle, snapTo, turn, type PlacementMode } from './build/placement.ts';

/**
 * The Kynds Engine's three.js half: material features (WebGL today, node materials for WebGPU),
 * chunked instancing with crossfading LOD, merging, releasing unloaded parts, and z-fighting
 * removal. The headless half is `engine/index.ts`.
 */
export * from './MaterialFeatures.ts';
export { chunkedInstances, farDetail, setFarDetail, type ChunkOpts, type Instance } from './instancing.ts';
export { flattenStatic, mergeSiblings } from './merge.ts';
export { heldBy, releaseUnshared, type Held } from './release.ts';
export { COPLANAR_GAP, separateCoplanar } from './coplanar.ts';

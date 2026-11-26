import * as THREE from 'three';
import type * as TSLModule from 'three/tsl';
import type * as WebGPUModule from 'three/webgpu';
import { Registry } from '../core/Registry.ts';

/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M5): material features. A feature is one look a material can
 * carry (tri-planar surface detail, snow on top, a coat's sheen), written twice: as a GLSL patch
 * for today's WebGLRenderer, and as a TSL node graph for WebGPURenderer. A material records the
 * features it carries and their settings (`featuresOf`), so it can be rebuilt as a node
 * material (`toNodeMaterial`) once every feature it carries has a TSL version.
 *
 * The WebGPU build of three.js is a separate copy of the library, so nothing here imports it: the
 * caller that renders with nodes passes the `three/webgpu` and `three/tsl` modules in.
 */

export type TSL = typeof TSLModule;
export type WebGPU = typeof WebGPUModule;
export type NodeStandardMaterial = InstanceType<WebGPU['MeshStandardNodeMaterial']>;
/** Any TSL node (kept loose: features build graphs from whichever three/tsl they're handed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TNode = any;

/** The shader as `onBeforeCompile` sees it. */
export type Shader = THREE.WebGLProgramParametersWithUniforms;

export interface MaterialFeature<P = unknown> {
  id: string;
  /** Patch the compiled shader (WebGLRenderer). Features apply in the order they were added. */
  glsl(shader: Shader, params: P): void;
  /** What makes two uses compile differently (the program cache key part). */
  key(params: P): string;
  /** The same look as nodes on a node material (WebGPURenderer). */
  tsl?(material: NodeStandardMaterial, params: P, tsl: TSL): void;
  /**
   * A change to the finished diffuse colour (after the map, vertex and instance colours and the
   * alpha test: where a GLSL patch after `alphatest_fragment` works). May discard.
   */
  tslDiffuse?(params: P, tsl: TSL): (diffuse: TNode) => TNode;
  /** A change to the vertex position in the object's own frame, before instancing (`begin_vertex`). */
  tslPosition?(params: P, tsl: TSL): (position: TNode) => TNode;
}

export interface FeatureUse {
  id: string;
  params: unknown;
}

const FEATURES = new Registry<MaterialFeature<never>>('material feature');

/** Make a feature available (once, at module load). */
export function defineFeature<P>(f: MaterialFeature<P>): MaterialFeature<P> {
  FEATURES.register(f.id, f as unknown as MaterialFeature<never>);
  return f;
}

export function featureById(id: string): MaterialFeature<unknown> | undefined {
  return FEATURES.get(id) as MaterialFeature<unknown> | undefined;
}

const ported = (f: MaterialFeature<unknown> | undefined) => !!f && (!!f.tsl || !!f.tslDiffuse || !!f.tslPosition);

/** Every feature defined, and whether each has its node version yet. */
export function featureTable(): { id: string; tsl: boolean }[] {
  return FEATURES.all().map((f) => ({ id: f.id, tsl: ported(f as MaterialFeature<unknown>) }));
}

/**
 * Which features each material carries. Kept here, not in `userData`: `clone()` copies userData
 * through JSON, which would leave a clone holding dead copies of the settings (a texture becomes a
 * plain object). A plain clone carries no features (as it carries no GLSL patch); copies meant to
 * keep them use `carryFeatures`.
 */
const USES = new WeakMap<THREE.Material, FeatureUse[]>();

/** The features a material carries, in order. */
export function featuresOf(material: THREE.Material): FeatureUse[] {
  return USES.get(material) ?? [];
}

/** Give a copy of a material the same features (its GLSL patch, cache key and node settings). */
export function carryFeatures<M extends THREE.Material>(from: THREE.Material, to: M): M {
  to.onBeforeCompile = from.onBeforeCompile;
  to.customProgramCacheKey = from.customProgramCacheKey;
  const uses = USES.get(from);
  if (uses) USES.set(to, uses);
  return to;
}

/**
 * Give a material a feature. Its GLSL patch wraps whatever patch the material has now (that runs
 * first), so features and older hand-written patches apply in the order they were given.
 */
export function addFeature<P>(material: THREE.Material, id: string, params: P): THREE.Material {
  const feature = FEATURES.require(id) as MaterialFeature<unknown>;
  let uses = USES.get(material);
  if (!uses) USES.set(material, (uses = []));
  uses.push({ id, params });
  const own = material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    if (!own) prev.call(material, shader, renderer);
    feature.glsl(shader, params);
  };
  const part = `${id}:${feature.key(params)}`;
  material.customProgramCacheKey = () => `${own ? '' : prevKey()}|${part}`;
  material.needsUpdate = true;
  return material;
}

/** Can this material be drawn by the node renderer (every feature it carries is ported)? */
export function nodeReady(material: THREE.Material): boolean {
  return featuresOf(material).every((u) => ported(featureById(u.id)));
}


/**
 * The translation column of each instance's matrix, as a per-instance attribute. (It must be an
 * *instanced* interleaved buffer, as three's own instancing uses: a plain array read through
 * `instancedBufferAttribute` steps per vertex on the WebGL2 backend.)
 */
function offsetOf(o: THREE.InstancedMesh, T: TSL): TNode {
  return columnOf(o, T, 3);
}

const columns = new WeakMap<object, { buffer: THREE.InstancedInterleavedBuffer; cols: TNode[] }>();
/** Column `k` (xyz) of each instance's matrix, as a per-instance attribute. */
function columnOf(o: THREE.InstancedMesh, T: TSL, k: number): TNode {
  let c = columns.get(o.instanceMatrix);
  if (!c) columns.set(o.instanceMatrix, (c = { buffer: new THREE.InstancedInterleavedBuffer(o.instanceMatrix.array, 16, 1), cols: [] }));
  // (Instances that move, re-uploaded when their matrices change, as three's own instancing does.)
  const buf = c.buffer;
  return (c.cols[k] ??= T.bufferAttribute(buf as never, 'vec3', 16, k * 4).onObjectUpdate(() => {
    if (buf.version !== o.instanceMatrix.version) buf.version = o.instanceMatrix.version;
  }));
}

/**
 * Column `k` of the instance's matrix (`instanceMatrix[k].xyz` in GLSL; the identity's for a plain
 * mesh): 0–2 the scaled axes, 3 the offset.
 */
export function instanceColumn(T: TSL, k: number): TNode {
  const fn = T.Fn as unknown as (f: (builder: { object: THREE.Object3D }) => TNode) => () => TNode;
  return fn((builder) => {
    const o = builder.object as THREE.InstancedMesh;
    if (!o.isInstancedMesh) return T.vec3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
    return columnOf(o, T, k);
  })();
}

/**
 * The instance's offset in its mesh's own frame (zero for a plain mesh): GLSL's
 * `instanceMatrix[3].xyz`.
 */
export function instanceOffset(T: TSL): TNode {
  const fn = T.Fn as unknown as (f: (builder: { object: THREE.Object3D }) => TNode) => () => TNode;
  return fn((builder) => {
    const o = builder.object as THREE.InstancedMesh;
    if (!o.isInstancedMesh) return T.vec3(0, 0, 0);
    return offsetOf(o, T);
  })();
}

/**
 * The world position of the instance (or, for a plain mesh, the object) a fragment belongs to: the
 * node equivalent of `modelMatrix * instanceMatrix * vec4(0, 0, 0, 1)` in a GLSL patch.
 */
export function instanceOrigin(T: TSL): TNode {
  // (A TSL function given no inputs is handed the node builder, and with it the object being built.)
  const fn = T.Fn as unknown as (f: (builder: { object: THREE.Object3D }) => TNode) => () => TNode;
  return fn((builder) => {
    const o = builder.object as THREE.InstancedMesh;
    if (!o.isInstancedMesh) return T.modelWorldMatrix.mul(T.vec4(0, 0, 0, 1)).xyz;
    return T.modelWorldMatrix.mul(T.vec4(offsetOf(o, T), 1)).xyz;
  })();
}

/**
 * The view-space normal bumped by a height (in metres) by its screen derivatives: the classic
 * `perturbNormalArb` that GLSL patches write by hand. three's `bumpMap` node re-samples a texture at
 * offset UVs, so it can't bump by a computed height; this can. Two-sided like GLSL's `normal`.
 */
export function bumpNormal(T: TSL, h: TNode): TNode {
  const pos = T.positionView, n = T.normalView.mul(T.faceDirection);
  const sx = T.dFdx(pos), sy = T.dFdy(pos);
  const r1 = T.cross(sy, n), r2 = T.cross(n, sx);
  const det = T.dot(sx, r1);
  const grad = T.sign(det).mul(T.dFdx(h).mul(r1).add(T.dFdy(h).mul(r2)));
  return T.abs(det).mul(n).sub(grad).normalize();
}

/** A whole hand-written shader material's node version (the sky, smoke, rain…). */
export type ShaderPort = (gpu: WebGPU, tsl: TSL) => InstanceType<WebGPU['NodeMaterial']>;
const ports = new WeakMap<THREE.Material, ShaderPort>();

/** Give a `ShaderMaterial` its node version: `toNodeMaterial` builds it from this. */
export function portShader<M extends THREE.Material>(material: M, port: ShaderPort): M {
  ports.set(material, port);
  return material;
}

export function hasPort(material: THREE.Material): boolean {
  return ports.has(material);
}

/**
 * The scene's linear fog for node materials that work out their own fog (a billboard's view depth
 * isn't the one three's fog node reads): set by whoever owns the scene's fog.
 */
export const SCENE_FOG: { fog: THREE.Fog | null } = { fog: null };

/** `mix(colour, fog, smoothstep(near, far, depth))` from SCENE_FOG, as GLSL's `fog_fragment` does for linear fog. */
export function linearFog(T: TSL, colour: TNode, depth: TNode): TNode {
  const none = new THREE.Color();
  const col = T.uniform(new THREE.Color()).onRenderUpdate(() => (SCENE_FOG.fog?.color ?? none) as never);
  const near = T.uniform(0).onRenderUpdate(() => SCENE_FOG.fog?.near ?? 0);
  const far = T.uniform(1e9).onRenderUpdate(() => SCENE_FOG.fog?.far ?? 1e9);
  return T.mix(colour, col, T.smoothstep(near, far, depth));
}

/**
 * The same material as a `MeshStandardNodeMaterial`: its plain settings copied, then each feature's
 * node version applied. Null if a feature it carries has no node version yet. A ported shader
 * material comes back as its own node version.
 */
export function toNodeMaterial(src: THREE.MeshStandardMaterial, gpu: WebGPU, tsl: TSL): NodeStandardMaterial | null {
  const port = ports.get(src);
  if (port) return port(gpu, tsl) as unknown as NodeStandardMaterial;
  if (!nodeReady(src)) return null;
  const m = new gpu.MeshStandardNodeMaterial();
  m.color.setHex(src.color.getHex());
  m.roughness = src.roughness;
  m.metalness = src.metalness;
  m.emissive.setHex(src.emissive.getHex());
  m.emissiveIntensity = src.emissiveIntensity;
  m.flatShading = src.flatShading;
  m.vertexColors = src.vertexColors;
  m.transparent = src.transparent;
  m.opacity = src.opacity;
  m.depthWrite = src.depthWrite;
  m.side = src.side;
  m.alphaTest = src.alphaTest;
  m.alphaHash = src.alphaHash;
  m.map = src.map as never;
  m.bumpMap = src.bumpMap as never;
  m.bumpScale = src.bumpScale;
  m.normalMap = src.normalMap as never;
  m.normalScale.copy(src.normalScale);
  m.roughnessMap = src.roughnessMap as never;
  m.emissiveMap = src.emissiveMap as never;
  m.alphaMap = src.alphaMap as never;
  m.name = src.name;
  const diffuse: ((c: TNode) => TNode)[] = [];
  const position: ((p: TNode) => TNode)[] = [];
  for (const u of featuresOf(src)) {
    const f = featureById(u.id)!;
    f.tsl?.(m, u.params, tsl);
    const d = f.tslDiffuse?.(u.params, tsl);
    if (d) diffuse.push(d);
    const p = f.tslPosition?.(u.params, tsl);
    if (p) position.push(p);
  }
  // Programs are cached by the material's node properties, which the hooks below don't touch:
  // without the features in the key, materials differing only in a hook's settings share a program.
  const baseKey = m.customProgramCacheKey.bind(m);
  const featureKey = featuresOf(src).map((u) => `${u.id}:${featureById(u.id)!.key(u.params)}`).join('|');
  m.customProgramCacheKey = () => `${baseKey()}|${featureKey}`;
  // After three's own diffuse set-up (colour, map, vertex and instance colours, alpha test).
  if (diffuse.length) {
    const setup = m.setupDiffuseColor;
    m.setupDiffuseColor = function (this: NodeStandardMaterial, ...args: Parameters<typeof setup>) {
      setup.apply(this, args);
      let c: TNode = tsl.diffuseColor;
      for (const f of diffuse) c = f(c);
      tsl.diffuseColor.assign(c);
    } as typeof setup;
  }
  // First in the vertex stack, before morphs, skinning and instancing (three.js r170 order: the
  // position stack opens with `builder.addStack()`; the parity check catches it if that changes).
  if (position.length) {
    const setup = m.setupPosition;
    m.setupPosition = function (this: NodeStandardMaterial, builder: { addStack: (...a: unknown[]) => unknown }) {
      const add = builder.addStack;
      builder.addStack = function (this: unknown, ...a: unknown[]) {
        builder.addStack = add;
        const r = add.apply(this, a);
        let p: TNode = tsl.positionLocal;
        for (const f of position) p = f(p);
        tsl.positionLocal.assign(p);
        return r;
      };
      return setup.call(this, builder as never);
    } as unknown as typeof setup;
  }
  return m;
}

import * as THREE from 'three';
import { featuresOf, hasPort, toNodeMaterial } from './MaterialFeatures.ts';

/**
 * The render backend (Kynds Engine M5b). The classic build draws with WebGLRenderer. The WebGPU
 * edition is the same code built with `three` mapped to `three/webgpu` (`npm run build:gpu`, or
 * `vite --mode gpu`; see vite.config.ts): one copy of the library, which has WebGPURenderer (with
 * its own WebGL2 fallback) and no WebGLRenderer. Everything that makes a renderer goes through
 * `createRenderer`, so game code never names either class.
 *
 * WebGPURenderer draws node materials. Plain materials it converts itself; a material carrying
 * features (MaterialFeatures) or a hand-written shader with a port gets its node version from
 * `prepareForGPU`, run over a scene before it's drawn. A GLSL shader with no port can't be drawn at
 * all, so its mesh is hidden (and named once in the console) rather than breaking the frame.
 */

/** True in the WebGPU edition. (Replaced at build time, so the classic build drops the GPU code.) */
export const GPU_EDITION: boolean = (import.meta as { env?: { MODE?: string } }).env?.MODE === 'gpu';

/**
 * Whether a renderer's viewport and scissor are measured from the canvas's top edge (WebGPURenderer,
 * either backend) rather than its bottom (WebGLRenderer). Anything that draws into a corner of the
 * canvas and then crops that corner out needs to know which.
 */
export const VIEWPORT_FROM_TOP: boolean = GPU_EDITION;

export interface RendererOptions {
  canvas?: HTMLCanvasElement;
  antialias?: boolean;
  alpha?: boolean;
  preserveDrawingBuffer?: boolean;
  powerPreference?: 'high-performance' | 'low-power' | 'default';
}

type AnyRenderer = THREE.WebGLRenderer & { init?: () => Promise<unknown>; backend?: { isWebGPUBackend?: boolean } };

let gpuLibs: { gpu: unknown; tsl: unknown } | null = null;
let gpuLoading: Promise<void> | null = null;

/** The node library (three/webgpu as `gpu`, three/tsl as `tsl`), loaded once in the WebGPU edition. */
function loadNodeLibs(): Promise<void> {
  if (gpuLoading) return gpuLoading;
  gpuLoading = (async () => {
    if (import.meta.env.MODE !== 'gpu') return;
    const [tsl] = await Promise.all([import('three/tsl')]);
    gpuLibs = { gpu: THREE, tsl };
  })();
  return gpuLoading;
}

/**
 * Make a renderer: WebGLRenderer in the classic build, WebGPURenderer in the WebGPU edition. Typed
 * as WebGLRenderer, the API both share (render, compileAsync, setSize, shadowMap, toneMapping…).
 */
export function createRenderer(o: RendererOptions = {}): THREE.WebGLRenderer {
  if (import.meta.env.MODE === 'gpu') {
    // (Looked up by name: the classic build's three has no such export, and that branch is dropped.)
    const R = (THREE as unknown as Record<string, new (o: RendererOptions) => AnyRenderer>)[['WebGPU', 'Renderer'].join('')];
    // `?webgl2` in the address runs the WebGPU edition on WebGPURenderer's WebGL2 backend (the same
    // node materials, for machines or test browsers without a working WebGPU device).
    const forceWebGL = typeof location !== 'undefined' && new URLSearchParams(location.search).has('webgl2');
    const r = new R({ ...o, ...(forceWebGL ? { forceWebGL: true } : {}) } as RendererOptions);
    void loadNodeLibs();
    void r.init?.();
    (globalThis as { kyndsGpuSourceOf?: typeof gpuSourceOf }).kyndsGpuSourceOf = gpuSourceOf;
    // `?shaderlog`: report shaders that fail to compile or link (slower; for diagnosis).
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('shaderlog') && r.debug) r.debug.checkShaderErrors = true;
    // Every scene is given its node materials as it's drawn (and nothing is drawn until the node
    // library has loaded: an unported shader would break the frame).
    const render = r.render.bind(r);
    r.render = ((scene: THREE.Object3D, camera: THREE.Camera) => {
      if (!gpuLibs) return;
      prepareForGPU(scene);
      render(scene, camera);
    }) as typeof r.render;
    // three r170's compileAsync calls _renderTransparents without its double-pass list, shifting
    // every argument along (the lights node arrives as the scene): mend the call when it comes in
    // that shape, or no scene with anything transparent in it can be compiled ahead.
    const rt = r as unknown as { _renderTransparents: (list: unknown, double: unknown, ...rest: unknown[]) => void };
    const transparents = rt._renderTransparents.bind(r);
    rt._renderTransparents = (list, double, ...rest) => (Array.isArray(double) ? transparents(list, double, ...rest) : transparents(list, [], double, ...rest));
    const compile = r.compileAsync.bind(r);
    r.compileAsync = (async (scene: THREE.Object3D, camera: THREE.Camera, target?: THREE.Scene | null) => {
      await loadNodeLibs();
      prepareForGPU(scene);
      if (target) prepareForGPU(target);
      try {
        return await compile(scene, camera, target ?? null);
      } catch (e) {
        // A material that fails to build mid-compile leaves WebGPURenderer "compiling" for good
        // (three only restores its draw function at the end): every later frame would draw nothing.
        const rr = r as unknown as { _handleObjectFunction: unknown; _renderObjectDirect: unknown; _compilationPromises: unknown };
        rr._handleObjectFunction = rr._renderObjectDirect;
        rr._compilationPromises = null;
        console.warn('[kynds] WebGPU edition: compiling a scene failed:', e);
      }
    }) as typeof r.compileAsync;
    return r;
  }
  return new THREE.WebGLRenderer(o);
}

/** Resolves once the renderer (and in the WebGPU edition, the node library) is ready to draw. */
export async function rendererReady(r: THREE.WebGLRenderer): Promise<void> {
  if (!GPU_EDITION) return;
  await Promise.all([(r as AnyRenderer).init?.(), loadNodeLibs()]);
}

/** Which backend is actually drawing: 'webgl' (classic), 'webgpu', or 'webgl2' (WebGPURenderer's fallback). */
export function backendName(r: THREE.WebGLRenderer): 'webgl' | 'webgpu' | 'webgl2' {
  if (!GPU_EDITION) return 'webgl';
  return (r as AnyRenderer).backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
}

const converted = new WeakMap<THREE.Material, THREE.Material | 'hide'>();
/** For diagnosis: the features a node material was made from. */
const madeFrom = new WeakMap<THREE.Material, string[]>();

/** A feature's settings left undefined, as ` (missing a, b)`: what a GLSL patch shrugs off breaks a node graph. */
function missingParams(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const gone = Object.entries(params as Record<string, unknown>).filter(([, v]) => v === undefined || v === null).map(([k]) => k);
  const objs = Object.entries(params as Record<string, unknown>).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => `${k}:${(v as { isTexture?: boolean }).isTexture ? 'texture' : (v as object).constructor?.name}`);
  return (gone.length ? ` (missing ${gone.join(', ')})` : '') + (objs.length ? ` [${objs.join(' ')}]` : '');
}

/** The features (and shader port) a material drawn in the WebGPU edition came from. */
export function gpuSourceOf(m: THREE.Material): string[] {
  return madeFrom.get(m) ?? [];
}
const warned = new Set<string>();

function nodeVersion(m: THREE.Material): THREE.Material | 'hide' {
  const known = converted.get(m);
  if (known) return known;
  let out: THREE.Material | 'hide' = m;
  if (hasPort(m) || featuresOf(m).length) {
    const n = gpuLibs ? toNodeMaterial(m as THREE.MeshStandardMaterial, gpuLibs.gpu as never, gpuLibs.tsl as never) : null;
    out = (n as unknown as THREE.Material | null) ?? m;
    if (out !== m) madeFrom.set(out, [...(hasPort(m) ? ['port:' + (m.name || m.type)] : []), ...featuresOf(m).map((u) => u.id + missingParams(u.params))]);
  } else if ((m as THREE.ShaderMaterial).isShaderMaterial) {
    out = 'hide';
    const name = m.name || m.type;
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[kynds] WebGPU edition: no node version of shader '${name}', hidden`);
    }
  }
  converted.set(m, out);
  return out;
}

const faceted = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
/** Materials that were flat-shaded before the WebGPU edition switched that off (see withNormals). */
const wasFlat = new WeakSet<THREE.Material>();
/**
 * A lit mesh whose flat normal comes from screen derivatives (`flatShading`, or a geometry with no
 * normal attribute) breaks on WebGPURenderer's WebGL2 backend: its node shader works the normal out
 * in the vertex stage, where derivatives don't exist, so the program fails and nothing draws. Such a
 * mesh gets a faceted copy of its geometry with real face normals (made once per geometry) and its
 * material stops asking for flat shading: it looks exactly as it did.
 */
function withNormals(mesh: THREE.Mesh): void {
  const g = mesh.geometry;
  if (!g || !g.attributes.position) return;
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
  const flat = mats.some((x) => x.flatShading || wasFlat.has(x));
  if (!flat) {
    if (g.attributes.normal) return;
    if (mats.every((x) => { const k = x as unknown as Record<string, boolean>; return k.isMeshBasicMaterial || k.isShaderMaterial || k.isPointsMaterial || k.isLineBasicMaterial; })) return;
  }
  for (const x of mats) if (x.flatShading) {
    wasFlat.add(x);
    x.flatShading = false;
    x.needsUpdate = true;
  }
  const known = faceted.get(g);
  if (known) { mesh.geometry = known; return; }
  const f = g.index ? g.toNonIndexed() : g.clone();
  f.deleteAttribute('normal');
  f.computeVertexNormals();
  faceted.set(g, f);
  faceted.set(f, f);
  g.addEventListener('dispose', () => f.dispose());
  mesh.geometry = f;
}

/**
 * Give every mesh under `root` its node material (WebGPU edition only; a no-op in the classic
 * build). Cheap to call every frame: each material is converted once and remembered.
 */
export function prepareForGPU(root: THREE.Object3D): void {
  if (!GPU_EDITION || !gpuLibs) return;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const m = mesh.material;
    if (!m) return;
    if ((mesh as { isMesh?: boolean }).isMesh) withNormals(mesh);
    if (Array.isArray(m)) {
      let hide = false;
      mesh.material = m.map((x) => {
        const n = nodeVersion(x);
        if (n === 'hide') hide = true;
        return n === 'hide' ? x : n;
      });
      if (hide) mesh.visible = false;
      return;
    }
    const n = nodeVersion(m);
    if (n === 'hide') mesh.visible = false;
    else if (n !== m) mesh.material = n;
  });
}

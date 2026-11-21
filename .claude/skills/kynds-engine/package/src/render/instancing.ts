import * as THREE from 'three';

export interface Instance {
  matrix: THREE.Matrix4;
  color?: THREE.Color;
}

export interface ChunkOpts {
  /** Chunk size in metres. */
  cell: number;
  /** Past this distance from the camera a chunk swaps to the low geometry (or vanishes, if none). */
  far?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * A chunk's own copy of a material, dissolved in and out by a screen-door dither (alpha hash: no
 * sorting, no blending) as the chunk crosses its detail distance, so detail eases in as the camera
 * nears instead of popping in a block at a time. Shader patches and their shared uniforms carry over.
 */
function fadeable<M extends THREE.Material>(m: M): M {
  const c = m.clone() as M;
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  // (clone() copies userData through JSON, which would break the features' shared uniforms.)
  if (m.userData.features) c.userData.features = m.userData.features;
  c.alphaHash = true;
  c.opacity = 1;
  return c;
}

/**
 * A level-of-detail chunk that crossfades between its two levels over a band either side of the
 * switch, rather than swapping them in one frame.
 */
class FadeLOD extends THREE.LOD {
  hiMat: THREE.Material | null = null;
  loMat: THREE.Material | null = null;
  override update(camera: THREE.Camera): void {
    if (this.levels.length < 2) return;
    const far = this.levels[1].distance;
    _v.setFromMatrixPosition(camera.matrixWorld);
    _c.setFromMatrixPosition(this.matrixWorld);
    const d = _v.distanceTo(_c) / ((camera as THREE.PerspectiveCamera).zoom ?? 1);
    const band = Math.max(10, far * 0.18);
    const x = Math.max(0, Math.min(1, (d - (far - band)) / (2 * band)));
    const t = x * x * (3 - 2 * x);
    const hi = this.levels[0].object, lo = this.levels[1].object;
    hi.visible = t < 0.999;
    lo.visible = t > 0.001;
    if (this.hiMat) this.hiMat.opacity = 1 - t;
    if (this.loMat) this.loMat.opacity = t;
  }
}

/**
 * Distance detail, set by the graphics quality (Graphics.ts): below the top level, far chunks swap
 * to their simple versions sooner. Every chunk made so far follows a change.
 */
let farScale = 1;
const lods = new Set<THREE.LOD>();

/** The same scale, for shaders that fade their own distance detail in step with the chunks. */
export const farDetail = { value: 1 };

export function setFarDetail(scale: number): void {
  if (scale === farScale) return;
  farScale = scale;
  farDetail.value = scale;
  for (const lod of lods) lod.levels[1].distance = (lod.userData.far as number) * scale;
}

/**
 * Many copies of one thing spread over a big area (trees across the kingdom), cut into square
 * chunks so each can be frustum-culled on its own, and, given a low-detail version, drawn with
 * that once the camera is far away. One huge InstancedMesh is never culled (its bounds cover the
 * whole kingdom) and draws every instance at full detail, even the ones behind the camera.
 */
export function chunkedInstances(high: THREE.BufferGeometry, low: THREE.BufferGeometry | null, material: THREE.Material, items: Instance[], opts: ChunkOpts): THREE.Group {
  const out = new THREE.Group();
  const cells = new Map<string, Instance[]>();
  for (const it of items) {
    _v.setFromMatrixPosition(it.matrix);
    const key = `${Math.floor(_v.x / opts.cell)},${Math.floor(_v.z / opts.cell)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(it);
  }
  const colored = items.some((i) => i.color);
  for (const list of cells.values()) {
    const centre = new THREE.Vector3();
    for (const it of list) centre.add(_v.setFromMatrixPosition(it.matrix));
    centre.divideScalar(list.length);
    const back = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
    const make = (geo: THREE.BufferGeometry, mat: THREE.Material = material) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => {
        im.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(back, it.matrix));
        if (colored) im.setColorAt(i, it.color ?? new THREE.Color(1, 1, 1));
      });
      im.castShadow = !!opts.castShadow;
      im.receiveShadow = !!opts.receiveShadow;
      im.computeBoundingSphere();
      return im;
    };
    if (opts.far === undefined) {
      const im = make(high);
      im.position.copy(centre);
      out.add(im);
      continue;
    }
    const lod = new FadeLOD();
    lod.position.copy(centre);
    lod.hiMat = fadeable(material);
    lod.loMat = low ? fadeable(material) : null;
    lod.addLevel(make(high, lod.hiMat), 0);
    lod.addLevel(low ? make(low, lod.loMat!) : new THREE.Object3D(), opts.far * farScale);
    lod.userData.far = opts.far;
    lods.add(lod);
    out.add(lod);
  }
  return out;
}

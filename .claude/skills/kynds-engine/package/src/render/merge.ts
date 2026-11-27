import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { carryFeatures, featureSignature } from './MaterialFeatures.ts';

/**
 * Draw-call reduction for procedurally built models. Each little box or lathe is its own draw
 * call (and another one in the shadow pass); merging meshes that share a material cuts a cottage
 * full of props from hundreds of calls to dozens without touching how anything looks.
 *
 * Meshes flagged `userData.keep = true` (toggled or animated on their own) are never merged.
 */

function normalise(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, colour = false): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  // Vertex colours are kept when the material paints with them (reeds, painted cloth): without
  // them a vertex-coloured material draws black.
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(colour && name === 'color')) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (colour) {
    const c = g.attributes.color;
    const n = g.attributes.position.count;
    // Every part merged needs the same layout: RGB floats (white where a part had none).
    const rgb = new Float32Array(n * 3).fill(1);
    if (c) for (let i = 0; i < n; i++) { rgb[i * 3] = c.getX(i); rgb[i * 3 + 1] = c.getY(i); rgb[i * 3 + 2] = c.getZ(i); }
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  }
  g.applyMatrix4(matrix);
  // A mirrored transform flips winding; fix it so faces don't turn inside out.
  if (matrix.determinant() < 0) {
    const p = g.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) [p[i + k], p[i + 6 + k]] = [p[i + 6 + k], p[i + k]];
    g.computeVertexNormals();
  }
  g = g.clone();
  return g;
}

function keyOf(m: THREE.Mesh, fold = false): string | null {
  if ((m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || m.userData.keep || !m.visible) return null;
  if (Array.isArray(m.material)) return null;
  const tail = `${m.castShadow}|${m.receiveShadow}|${m.renderOrder}`;
  const sig = fold ? foldable(m.material) : null;
  if (sig !== null) {
    const s = m.material as THREE.MeshStandardMaterial;
    const maps = MAPS.map((k) => (s as unknown as Record<string, THREE.Texture | null>)[k]?.uuid ?? '').join(',');
    return `fold|${s.roughness.toFixed(2)}|${s.metalness.toFixed(2)}|${s.side}|${s.flatShading}|${s.emissive.getHexString()}|${s.emissiveIntensity.toFixed(2)}|${s.envMapIntensity.toFixed(2)}|${maps}|${sig}|${tail}`;
  }
  return `${m.material.uuid}|${tail}`;
}

const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap'] as const;

/**
 * An opaque standard material differs from another with the same settings, textures and shader
 * features only by its colour, which can go into the vertices instead: such meshes merge into one
 * draw even though their materials differ. Returns the feature signature, or null if not foldable.
 */
function foldable(mat: THREE.Material): string | null {
  const s = mat as THREE.MeshStandardMaterial;
  if (s.type !== 'MeshStandardMaterial' || s.transparent || s.opacity < 1 || s.alphaTest > 0 || s.alphaHash) return null;
  return featureSignature(s);
}

function buildMerged(list: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[], folded = false): THREE.Mesh {
  if (folded) return buildFolded(list);
  const colour = !!(list[0].mesh.material as THREE.Material & { vertexColors?: boolean }).vertexColors;
  const geo = mergeGeometries(list.map((e) => normalise(e.mesh.geometry, e.matrix, colour)))!;
  geo.computeBoundingSphere();
  const first = list[0].mesh;
  const merged = new THREE.Mesh(geo, first.material);
  merged.castShadow = first.castShadow;
  merged.receiveShadow = first.receiveShadow;
  merged.renderOrder = first.renderOrder;
  Object.assign(merged.userData, first.userData);
  return merged;
}

/** Plain materials of different colours, merged: each part's colour baked into its vertices. */
function buildFolded(list: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[]): THREE.Mesh {
  const parts = list.map((e) => {
    const mat = e.mesh.material as THREE.MeshStandardMaterial;
    const g = normalise(e.mesh.geometry, e.matrix, true);
    const c = g.attributes.color.array as Float32Array;
    // (Without vertexColors the part's own vertex colours never showed: white, then the material's.)
    if (!mat.vertexColors) c.fill(1);
    for (let i = 0; i < c.length; i += 3) {
      c[i] *= mat.color.r;
      c[i + 1] *= mat.color.g;
      c[i + 2] *= mat.color.b;
    }
    return g;
  });
  const geo = mergeGeometries(parts)!;
  geo.computeBoundingSphere();
  const first = list[0].mesh;
  const mat = carryFeatures(first.material as THREE.Material, (first.material as THREE.MeshStandardMaterial).clone());
  mat.color.setRGB(1, 1, 1);
  mat.vertexColors = true;
  const merged = new THREE.Mesh(geo, mat);
  merged.castShadow = first.castShadow;
  merged.receiveShadow = first.receiveShadow;
  merged.renderOrder = first.renderOrder;
  merged.userData.foldedMaterial = true;
  return merged;
}

/**
 * Merge same-material Mesh children of every node, in place. The hierarchy (joints, pivots,
 * groups) is kept, so anything that animates still animates.
 */
export function mergeSiblings(root: THREE.Object3D): void {
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => nodes.push(o));
  for (const node of nodes) {
    const buckets = new Map<string, THREE.Mesh[]>();
    for (const c of node.children) {
      if (!(c as THREE.Mesh).isMesh || c.children.length > 0) continue;
      const k = keyOf(c as THREE.Mesh);
      if (!k) continue;
      const list = buckets.get(k) ?? [];
      list.push(c as THREE.Mesh);
      buckets.set(k, list);
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      for (const m of list) m.updateMatrix();
      const merged = buildMerged(list.map((m) => ({ mesh: m, matrix: m.matrix })));
      for (const m of list) node.remove(m);
      node.add(merged);
    }
  }
}

/**
 * Flatten a fully static group: every mergeable mesh underneath is baked into the group's space
 * and merged by material. Kept meshes (and their ancestors) stay in place. With `foldColours`,
 * plain untextured materials that differ only in colour merge too (the colour goes into the
 * vertices): for a stand-in seen from afar, hundreds of painted pieces become a handful of draws.
 * The merged material is new; free it with the geometry.
 */
export function flattenStatic(group: THREE.Object3D, opts: { foldColours?: boolean } = {}): void {
  const fold = !!opts.foldColours;
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const buckets = new Map<string, { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[]>();
  const taken: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m === group) return;
    // Anything under a kept node stays as authored.
    for (let p: THREE.Object3D | null = m; p && p !== group; p = p.parent) if (p.userData.keep || !p.visible) return;
    const k = keyOf(m, fold);
    if (!k) return;
    const list = buckets.get(k) ?? [];
    list.push({ mesh: m, matrix: inv.clone().multiply(m.matrixWorld) });
    buckets.set(k, list);
    taken.push(m);
  });
  for (const m of taken) m.parent?.remove(m);
  for (const [k, list] of buckets) group.add(buildMerged(list, k.startsWith('fold|')));
  // Drop groups left empty by the flattening.
  const empty: THREE.Object3D[] = [];
  group.traverse((o) => {
    if (o !== group && !(o as THREE.Mesh).isMesh && o.children.length === 0 && o.type === 'Group' && !o.userData.keep) empty.push(o);
  });
  for (const e of empty) e.parent?.remove(e);
}

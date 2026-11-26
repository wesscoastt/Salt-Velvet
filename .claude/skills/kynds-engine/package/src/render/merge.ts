import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

function keyOf(m: THREE.Mesh): string | null {
  if ((m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || m.userData.keep || !m.visible) return null;
  if (Array.isArray(m.material)) return null;
  return `${m.material.uuid}|${m.castShadow}|${m.receiveShadow}|${m.renderOrder}`;
}

function buildMerged(list: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[]): THREE.Mesh {
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
 * and merged by material. Kept meshes (and their ancestors) stay in place.
 */
export function flattenStatic(group: THREE.Object3D): void {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const buckets = new Map<string, { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[]>();
  const taken: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m === group) return;
    // Anything under a kept node stays as authored.
    for (let p: THREE.Object3D | null = m; p && p !== group; p = p.parent) if (p.userData.keep || !p.visible) return;
    const k = keyOf(m);
    if (!k) return;
    const list = buckets.get(k) ?? [];
    list.push({ mesh: m, matrix: inv.clone().multiply(m.matrixWorld) });
    buckets.set(k, list);
    taken.push(m);
  });
  for (const m of taken) m.parent?.remove(m);
  for (const list of buckets.values()) group.add(buildMerged(list));
  // Drop groups left empty by the flattening.
  const empty: THREE.Object3D[] = [];
  group.traverse((o) => {
    if (o !== group && !(o as THREE.Mesh).isMesh && o.children.length === 0 && o.type === 'Group' && !o.userData.keep) empty.push(o);
  });
  for (const e of empty) e.parent?.remove(e);
}

import * as THREE from 'three';

/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M3): freeing what a part of the world held on the GPU once it
 * is unloaded, without breaking anything still on show.
 *
 * Builders share a great deal (cached materials and textures, one geometry instanced across lots,
 * clones for the map), so counting references by hand would be fragile. Instead this works like a
 * collector: whatever `gone` reaches that none of the `kept` roots reach is released. Releasing in
 * three.js is never fatal: anything used again is simply uploaded again, so a missed share costs a
 * re-upload, not a broken frame.
 */

export interface Held {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
}

/** Every geometry, material and texture a tree of objects uses (including skinned and instanced). */
export function heldBy(roots: Iterable<THREE.Object3D>, into: Held = { geometries: new Set(), materials: new Set(), textures: new Set() }): Held {
  for (const root of roots) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) into.geometries.add(m.geometry);
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      const extra = [(m as THREE.Mesh & { customDepthMaterial?: THREE.Material }).customDepthMaterial, (m as THREE.Mesh & { customDistanceMaterial?: THREE.Material }).customDistanceMaterial];
      for (const mat of [...mats, ...extra]) {
        if (!mat || into.materials.has(mat)) continue;
        into.materials.add(mat);
        for (const v of Object.values(mat)) {
          if ((v as THREE.Texture)?.isTexture) into.textures.add(v as THREE.Texture);
        }
        const uniforms = (mat as THREE.ShaderMaterial).uniforms;
        if (uniforms) for (const u of Object.values(uniforms)) if ((u?.value as THREE.Texture)?.isTexture) into.textures.add(u.value as THREE.Texture);
      }
    });
  }
  return into;
}

/**
 * Release what `gone` holds and no `kept` root holds. `keepAlso` protects anything else that must
 * stay (resources held by code rather than by the scene graph). Returns what was released.
 */
export function releaseUnshared(gone: Iterable<THREE.Object3D>, kept: Iterable<THREE.Object3D>, keepAlso?: Held): { geometries: number; materials: number; textures: number } {
  const drop = heldBy(gone);
  const keep = heldBy(kept);
  if (keepAlso) {
    for (const g of keepAlso.geometries) keep.geometries.add(g);
    for (const m of keepAlso.materials) keep.materials.add(m);
    for (const t of keepAlso.textures) keep.textures.add(t);
  }
  const n = { geometries: 0, materials: 0, textures: 0 };
  for (const g of drop.geometries) if (!keep.geometries.has(g)) (g.dispose(), n.geometries++);
  for (const m of drop.materials) if (!keep.materials.has(m)) (m.dispose(), n.materials++);
  for (const t of drop.textures) if (!keep.textures.has(t)) (t.dispose(), n.textures++);
  return n;
}

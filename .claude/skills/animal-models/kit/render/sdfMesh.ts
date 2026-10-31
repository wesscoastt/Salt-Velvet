import * as THREE from 'three';

/*
 * A tiny signed-distance sculpting kit for organic models (pets). Shapes are smooth unions of
 * ellipsoids and tapered capsules, like clay masses on an armature. The field is polygonised with
 * surface nets, projected exactly onto the surface, and skinned automatically: each mass belongs to
 * a bone, and a vertex takes its weights from the masses it is closest to, so joints blend softly
 * and there are no seams between body, legs, neck, head and tail. Pure maths; runs in Node.
 */

export type V3 = [number, number, number];

export interface Mass {
  /** 0 ellipsoid, 1 tapered capsule (round cone), 2 subtraction sphere. */
  kind: 0 | 1 | 2;
  a: V3;
  /** Capsule end. */
  b?: V3;
  /** Ellipsoid radii, or capsule radii [ra, rb, flatten] where flatten squashes it vertically. */
  r: V3;
  /** Smooth-union radius: how softly this mass melts into the ones before it. */
  k: number;
  bone: number;
  /** Semantic tags (coat regions), as a bit mask. */
  tags: number;
  /** Ellipsoid orientation: pitch (about X), yaw (about Y), roll (about Z), radians. */
  rot?: V3;
  /** Skin weight falloff for this mass (metres). */
  soft?: number;
  /** Multiplies this mass's skin influence. */
  influence?: number;
  /** Cached inverse rotation (row-major 3x3). */
  m?: number[];
}

export const ellipsoid = (a: V3, r: V3, bone: number, tags: number, k = 0, rot?: V3, extra: Partial<Mass> = {}): Mass => ({ kind: 0, a, r, bone, tags, k, rot, ...extra });
export const capsule = (a: V3, b: V3, ra: number, rb: number, bone: number, tags: number, k = 0, flatten = 1, extra: Partial<Mass> = {}): Mass => ({ kind: 1, a, b, r: [ra, rb, flatten], bone, tags, k, ...extra });
export const carve = (a: V3, r: number, k: number, bone: number): Mass => ({ kind: 2, a, r: [r, r, r], bone, tags: 0, k });

function prepare(m: Mass): void {
  if (m.kind !== 0 || m.m) return;
  const [rx, ry, rz] = m.rot ?? [0, 0, 0];
  const e = new THREE.Euler(rx, ry, rz, 'YXZ');
  const mat = new THREE.Matrix4().makeRotationFromEuler(e).invert();
  const el = mat.elements; // column-major
  m.m = [el[0], el[4], el[8], el[1], el[5], el[9], el[2], el[6], el[10]];
}

/** Signed distance from a point to one mass. */
export function massDistance(m: Mass, x: number, y: number, z: number): number {
  if (m.kind === 0) {
    let px = x - m.a[0], py = y - m.a[1], pz = z - m.a[2];
    if (m.m) {
      const q = m.m;
      const tx = q[0] * px + q[1] * py + q[2] * pz;
      const ty = q[3] * px + q[4] * py + q[5] * pz;
      const tz = q[6] * px + q[7] * py + q[8] * pz;
      px = tx; py = ty; pz = tz;
    }
    const ax = px / m.r[0], ay = py / m.r[1], az = pz / m.r[2];
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
    const bx = ax / m.r[0], by = ay / m.r[1], bz = az / m.r[2];
    const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    return k1 < 1e-9 ? -Math.min(m.r[0], m.r[1], m.r[2]) : k0 * (k0 - 1) / k1;
  }
  if (m.kind === 2) {
    const dx = x - m.a[0], dy = y - m.a[1], dz = z - m.a[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - m.r[0];
  }
  // Round cone between a and b (Inigo Quilez), with an optional vertical squash.
  const b = m.b!;
  const fl = m.r[2];
  const cy = (m.a[1] + b[1]) / 2;
  const py0 = cy + (y - cy) / fl;
  const r1 = m.r[0], r2 = m.r[1];
  const bax = b[0] - m.a[0], bay = (b[1] - m.a[1]) / fl, baz = b[2] - m.a[2];
  const pax = x - m.a[0], pay = py0 - (cy + (m.a[1] - cy) / fl), paz = z - m.a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const yv = pax * bax + pay * bay + paz * baz;
  const zv = yv - l2;
  const qx = pax * l2 - bax * yv, qy = pay * l2 - bay * yv, qz = paz * l2 - baz * yv;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yv * yv * l2;
  const z2 = zv * zv * l2;
  const kk = Math.sign(rr) * rr * rr * x2;
  let d: number;
  if (Math.sign(zv) * a2 * z2 > kk) d = Math.sqrt(x2 + z2) * il2 - r2;
  else if (Math.sign(yv) * a2 * y2 < kk) d = Math.sqrt(x2 + y2) * il2 - r1;
  else d = (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
  return d * (fl < 1 ? Math.max(fl, 0.5) : 1);
}

const smin = (a: number, b: number, k: number) => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

/** The combined field at a point. */
export function fieldAt(masses: Mass[], x: number, y: number, z: number): number {
  let d = 10;
  masses.forEach(prepare);
  for (const m of masses) {
    const di = massDistance(m, x, y, z);
    d = m.kind === 2 ? smax(d, -di, m.k) : smin(d, di, m.k);
  }
  return d;
}

function bounds(m: Mass): [number, number, number, number, number, number] {
  if (m.kind === 1) {
    const b = m.b!, r = Math.max(m.r[0], m.r[1]) / Math.min(1, m.r[2]);
    return [Math.min(m.a[0], b[0]) - r, Math.min(m.a[1], b[1]) - r, Math.min(m.a[2], b[2]) - r, Math.max(m.a[0], b[0]) + r, Math.max(m.a[1], b[1]) + r, Math.max(m.a[2], b[2]) + r];
  }
  const r = Math.max(m.r[0], m.r[1], m.r[2]);
  return [m.a[0] - r, m.a[1] - r, m.a[2] - r, m.a[0] + r, m.a[1] + r, m.a[2] + r];
}

export interface Sculpt {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Four bone indices and weights per vertex. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** Per-vertex soft tag membership, `tagCount` floats per vertex. */
  tagWeights: Float32Array;
  tagCount: number;
}

/**
 * Polygonise the masses with surface nets at the given voxel size, then project the vertices onto
 * the exact surface and compute normals from the field gradient.
 */
export function sculpt(masses: Mass[], voxel: number, tagCount = 0, opts: { smooth?: number; weightSoft?: number; normalSmooth?: number; weightSmooth?: number } = {}): Sculpt {
  masses.forEach(prepare);
  const solids = masses.filter(m => m.kind !== 2);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const m of solids) {
    const b = bounds(m);
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); z0 = Math.min(z0, b[2]);
    x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); z1 = Math.max(z1, b[5]);
  }
  const pad = voxel * 3;
  x0 -= pad; y0 -= pad; z0 -= pad; x1 += pad; y1 += pad; z1 += pad;
  const nx = Math.ceil((x1 - x0) / voxel) + 1, ny = Math.ceil((y1 - y0) / voxel) + 1, nz = Math.ceil((z1 - z0) / voxel) + 1;
  // Field evaluation near the surface only needs the masses whose (padded) bounds contain the point.
  const reach = voxel * 4;
  const boxes = masses.map(m => {
    const b = m.kind === 2 ? [m.a[0] - m.r[0], m.a[1] - m.r[0], m.a[2] - m.r[0], m.a[0] + m.r[0], m.a[1] + m.r[0], m.a[2] + m.r[0]] : bounds(m);
    const pad = m.k + reach;
    return [b[0] - pad, b[1] - pad, b[2] - pad, b[3] + pad, b[4] + pad, b[5] + pad];
  });
  const near = (i: number, x: number, y: number, z: number) => { const b = boxes[i]; return x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]; };
  // Coarse buckets list the masses that can matter in each region.
  const cs = voxel * 6;
  const cnx = Math.ceil((x1 - x0) / cs) + 1, cny = Math.ceil((y1 - y0) / cs) + 1, cnz = Math.ceil((z1 - z0) / cs) + 1;
  const bucket = (list: number[][], b: number[][]) => {
    for (let i = 0; i < cnx * cny * cnz; i++) list.push([]);
    b.forEach((box, mi) => {
      const i0 = Math.max(0, Math.floor((box[0] - x0) / cs)), i1 = Math.min(cnx - 1, Math.floor((box[3] - x0) / cs));
      const j0 = Math.max(0, Math.floor((box[1] - y0) / cs)), j1 = Math.min(cny - 1, Math.floor((box[4] - y0) / cs));
      const k0 = Math.max(0, Math.floor((box[2] - z0) / cs)), k1 = Math.min(cnz - 1, Math.floor((box[5] - z0) / cs));
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) list[i + cnx * (j + cny * k)].push(mi);
    });
  };
  const cellOf = (x: number, y: number, z: number) => clampI(Math.floor((x - x0) / cs), cnx) + cnx * (clampI(Math.floor((y - y0) / cs), cny) + cny * clampI(Math.floor((z - z0) / cs), cnz));
  const fieldLists: number[][] = [];
  bucket(fieldLists, boxes);
  // Tight bounds give a cheap lower bound on a mass's distance: a solid mass farther than the
  // running distance plus its blend radius cannot change the smooth union, so it is skipped.
  const tight = masses.map(m => (m.kind === 2 ? [m.a[0] - m.r[0], m.a[1] - m.r[0], m.a[2] - m.r[0], m.a[0] + m.r[0], m.a[1] + m.r[0], m.a[2] + m.r[0]] : bounds(m)));
  const field = (x: number, y: number, z: number) => {
    let d = 10;
    for (const i of fieldLists[cellOf(x, y, z)]) {
      if (!near(i, x, y, z)) continue;
      const m = masses[i];
      if (m.kind !== 2) {
        const t = tight[i];
        const dx = Math.max(t[0] - x, 0, x - t[3]), dy = Math.max(t[1] - y, 0, y - t[4]), dz = Math.max(t[2] - z, 0, z - t[5]);
        const lim = d + m.k;
        if (lim < 0 || dx * dx + dy * dy + dz * dz > lim * lim) continue;
      }
      const di = massDistance(m, x, y, z);
      d = m.kind === 2 ? smax(d, -di, m.k) : smin(d, di, m.k);
    }
    return d;
  };
  // Sample the field on a coarse lattice first; blocks whose corners are all well away from the
  // surface take the sign without exact evaluation, so only the narrow band near the skin costs.
  const grid = new Float32Array(nx * ny * nz).fill(10);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const C = 3;
  const bx = Math.ceil((nx - 1) / C), by = Math.ceil((ny - 1) / C), bz = Math.ceil((nz - 1) / C);
  const coarse = new Float32Array((bx + 1) * (by + 1) * (bz + 1));
  const cAt = (i: number, j: number, k: number) => i + (bx + 1) * (j + (by + 1) * k);
  for (let k = 0; k <= bz; k++) for (let j = 0; j <= by; j++) for (let i = 0; i <= bx; i++) {
    coarse[cAt(i, j, k)] = field(x0 + Math.min(i * C, nx - 1) * voxel, y0 + Math.min(j * C, ny - 1) * voxel, z0 + Math.min(k * C, nz - 1) * voxel);
  }
  const thr = voxel * C * 1.07; // a little over the block's half-diagonal
  for (let ck = 0; ck < bz; ck++) for (let cj = 0; cj < by; cj++) for (let ci = 0; ci < bx; ci++) {
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < 8; c++) {
      const v = coarse[cAt(ci + (c & 1), cj + ((c >> 1) & 1), ck + (c >> 2))];
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    // Blocks share their faces; each takes the low faces and only the last block the high one.
    const i0 = ci * C, i1 = ci === bx - 1 ? nx - 1 : i0 + C - 1, j0 = cj * C, j1 = cj === by - 1 ? ny - 1 : j0 + C - 1, k0 = ck * C, k1 = ck === bz - 1 ? nz - 1 : k0 + C - 1;
    const far = lo > thr ? lo : hi < -thr ? hi : 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      grid[at(i, j, k)] = far !== 0 ? far : field(x0 + i * voxel, y0 + j * voxel, z0 + k * voxel);
    }
  }
  // Surface nets: one vertex per cell that straddles the surface.
  const cellIndex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cell = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  const skip = voxel * 1.9;
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const g0 = grid[at(i, j, k)];
    if (g0 > skip || g0 < -skip) continue;
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      v[c] = grid[at(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
      if (v[c] < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, count = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
      sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
      sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
      count++;
    }
    cellIndex[cell(i, j, k)] = pos.length / 3;
    pos.push(x0 + (i + sx / count) * voxel, y0 + (j + sy / count) * voxel, z0 + (k + sz / count) * voxel);
  }
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // Stored as (p0 p1 p2)(p0 p2 p3) so the diagonal can be swapped below.
    if (flip) idx.push(a, d, c, a, c, b);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const inside = grid[at(i, j, k)] < 0;
    if (inside !== grid[at(i + 1, j, k)] < 0) quad(cellIndex[cell(i, j - 1, k - 1)], cellIndex[cell(i, j, k - 1)], cellIndex[cell(i, j, k)], cellIndex[cell(i, j - 1, k)], !inside);
    if (inside !== grid[at(i, j + 1, k)] < 0) quad(cellIndex[cell(i - 1, j, k - 1)], cellIndex[cell(i - 1, j, k)], cellIndex[cell(i, j, k)], cellIndex[cell(i, j, k - 1)], !inside);
    if (inside !== grid[at(i, j, k + 1)] < 0) quad(cellIndex[cell(i - 1, j - 1, k)], cellIndex[cell(i, j - 1, k)], cellIndex[cell(i, j, k)], cellIndex[cell(i - 1, j, k)], !inside);
  }
  const count = pos.length / 3;
  const positions = new Float32Array(pos);
  // Relax the net (Taubin, keeps volume), then snap back onto the exact surface.
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = idx[t + e], b = idx[t + (e + 1) % 3];
    if (!neighbours[a].includes(b)) neighbours[a].push(b);
    if (!neighbours[b].includes(a)) neighbours[b].push(a);
  }
  const relax = (factor: number) => {
    const next = new Float32Array(positions);
    for (let i = 0; i < count; i++) {
      const nb = neighbours[i];
      if (!nb.length) continue;
      let ax = 0, ay = 0, az = 0;
      for (const n of nb) { ax += positions[n * 3]; ay += positions[n * 3 + 1]; az += positions[n * 3 + 2]; }
      const l = nb.length;
      next[i * 3] += (ax / l - positions[i * 3]) * factor;
      next[i * 3 + 1] += (ay / l - positions[i * 3 + 1]) * factor;
      next[i * 3 + 2] += (az / l - positions[i * 3 + 2]) * factor;
    }
    positions.set(next);
  };
  const e = voxel * 0.25;
  const normals = new Float32Array(count * 3);
  // Snap each vertex onto the surface along the field gradient; the gradient is also its normal.
  const project = () => {
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const d = field(x, y, z);
      const gx = (field(x + e, y, z) - d) / e;
      const gy = (field(x, y + e, z) - d) / e;
      const gz = (field(x, y, z + e) - d) / e;
      const g2 = gx * gx + gy * gy + gz * gz || 1, gl = Math.sqrt(g2);
      normals[i * 3] = gx / gl; normals[i * 3 + 1] = gy / gl; normals[i * 3 + 2] = gz / gl;
      if (Math.abs(d) > voxel * 2) continue;
      positions[i * 3] -= gx * d / g2; positions[i * 3 + 1] -= gy * d / g2; positions[i * 3 + 2] -= gz * d / g2;
    }
  };
  for (let it = 0; it < (opts.smooth ?? 2); it++) { relax(0.5); relax(-0.53); }
  project();
  relax(0.35); relax(-0.36);
  project();
  // Field gradients exaggerate the tiny bulges where smooth unions meet; a light average over
  // neighbouring vertices keeps the shading as soft as the shape.
  for (let it = 0; it < (opts.normalSmooth ?? 2); it++) {
    const next = new Float32Array(normals);
    for (let i = 0; i < count; i++) {
      const nb = neighbours[i];
      let ax = normals[i * 3], ay = normals[i * 3 + 1], az = normals[i * 3 + 2];
      for (const n of nb) { ax += normals[n * 3]; ay += normals[n * 3 + 1]; az += normals[n * 3 + 2]; }
      const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      next[i * 3] = ax / l; next[i * 3 + 1] = ay / l; next[i * 3 + 2] = az / l;
    }
    normals.set(next);
  }
  // Automatic skin weights and coat-region tags from mass proximity.
  const skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4);
  const tagWeights = new Float32Array(count * Math.max(1, tagCount));
  const soft = opts.weightSoft ?? voxel * 2.5;
  const boneW = new Float32Array(256);
  const used: number[] = [];
  const dist = new Float32Array(solids.length);
  const solidBoxes = solids.map(m => { const b = bounds(m); const pad = (m.soft ?? soft) * 6 + m.k; return [b[0] - pad, b[1] - pad, b[2] - pad, b[3] + pad, b[4] + pad, b[5] + pad]; });
  const weightLists: number[][] = [];
  bucket(weightLists, solidBoxes);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    let dmin = Infinity;
    dist.fill(Infinity);
    for (const s of weightLists[cellOf(x, y, z)]) {
      const b = solidBoxes[s];
      if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) { dist[s] = Infinity; continue; }
      dist[s] = massDistance(solids[s], x, y, z); dmin = Math.min(dmin, dist[s]);
    }
    used.length = 0;
    let tagTotal = 0;
    for (let s = 0; s < solids.length; s++) {
      if (dist[s] === Infinity) continue;
      const m = solids[s];
      const w = Math.exp(-(dist[s] - dmin) / (m.soft ?? soft)) * (m.influence ?? 1);
      if (w < 2.5e-3) continue;
      if (boneW[m.bone] === 0) used.push(m.bone);
      boneW[m.bone] += w;
      if (tagCount) {
        for (let t = 0; t < tagCount; t++) if (m.tags & (1 << t)) tagWeights[i * tagCount + t] += w;
        tagTotal += w;
      }
    }
    if (tagCount && tagTotal > 0) for (let t = 0; t < tagCount; t++) tagWeights[i * tagCount + t] /= tagTotal;
    used.sort((a, b) => boneW[b] - boneW[a]);
    let total = 0;
    for (let n = 0; n < Math.min(4, used.length); n++) total += boneW[used[n]];
    for (let n = 0; n < Math.min(4, used.length); n++) { skinIndex[i * 4 + n] = used[n]; skinWeight[i * 4 + n] = boneW[used[n]] / total; }
    if (!used.length) skinWeight[i * 4] = 1;
    for (const u of used) boneW[u] = 0;
  }
  if (opts.weightSmooth) diffuseWeights(neighbours, skinIndex, skinWeight, opts.weightSmooth);
  // Split quads along their shorter diagonal for smoother shading.
  const indices = new Uint32Array(idx);
  for (let t = 0; t < indices.length; t += 6) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2], d = indices[t + 5];
    const d1 = dist2(positions, a, c), d2 = dist2(positions, b, d);
    if (d2 < d1) {
      // a b c / a c d  →  a b d / b c d
      indices[t] = a; indices[t + 1] = b; indices[t + 2] = d;
      indices[t + 3] = b; indices[t + 4] = c; indices[t + 5] = d;
    }
  }
  return { positions, normals, indices, skinIndex, skinWeight, tagWeights, tagCount };
}

/**
 * Diffuse skin weights over the surface a few rings, so they change gradually wherever the skin is
 * connected (between the legs, at the shoulders): sharp flips tear the mesh when bones part.
 */
export function diffuseWeights(neighbours: number[][], skinIndex: Uint16Array, skinWeight: Float32Array, iterations: number): void {
  const count = neighbours.length;
  let maxBone = 0;
  for (let i = 0; i < count * 4; i++) maxBone = Math.max(maxBone, skinIndex[i]);
  const B = maxBone + 1;
  let dense = new Float32Array(count * B);
  for (let i = 0; i < count; i++) for (let n = 0; n < 4; n++) dense[i * B + skinIndex[i * 4 + n]] += skinWeight[i * 4 + n];
  let next = new Float32Array(count * B);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < count; i++) {
      const nb = neighbours[i], o = i * B;
      if (!nb.length) { for (let b = 0; b < B; b++) next[o + b] = dense[o + b]; continue; }
      const inv = 0.5 / nb.length;
      for (let b = 0; b < B; b++) next[o + b] = dense[o + b] * 0.5;
      for (const n of nb) { const q = n * B; for (let b = 0; b < B; b++) next[o + b] += dense[q + b] * inv; }
    }
    const t = dense; dense = next; next = t;
  }
  for (let i = 0; i < count; i++) {
    const o = i * B;
    const top = [-1, -1, -1, -1];
    for (let b = 0; b < B; b++) {
      const w = dense[o + b];
      if (w <= 0) continue;
      for (let n = 0; n < 4; n++) {
        if (top[n] < 0 || w > dense[o + top[n]]) { top.splice(n, 0, b); top.length = 4; break; }
      }
    }
    let total = 0;
    for (const b of top) if (b >= 0) total += dense[o + b];
    for (let n = 0; n < 4; n++) {
      skinIndex[i * 4 + n] = top[n] >= 0 ? top[n] : 0;
      skinWeight[i * 4 + n] = top[n] >= 0 && total > 0 ? dense[o + top[n]] / total : 0;
    }
    if (total <= 0) skinWeight[i * 4] = 1;
  }
}

/** Vertex adjacency of an indexed triangle mesh. */
export function meshNeighbours(indices: ArrayLike<number>, count: number): number[][] {
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = indices[t + e], b = indices[t + (e + 1) % 3];
    if (!neighbours[a].includes(b)) neighbours[a].push(b);
    if (!neighbours[b].includes(a)) neighbours[b].push(a);
  }
  return neighbours;
}

const clampI = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
const dist2 = (p: Float32Array, a: number, b: number) => (p[a * 3] - p[b * 3]) ** 2 + (p[a * 3 + 1] - p[b * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[b * 3 + 2]) ** 2;

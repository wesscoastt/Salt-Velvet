import * as THREE from 'three';

/**
 * Kynds Engine: no flicker inside a model. Procedural models are made of boxes, cylinders and
 * planes that butt and overlap, and wherever two of them share a face's plane (a board's end flush
 * with the side of the board it meets, two crates side by side) the depth buffer can't tell them
 * apart and the faces flicker (z-fighting) as the camera moves.
 *
 * `separateCoplanar` finds the pieces whose faces share a plane (a box's faces exactly, the flat
 * ends of a cylinder, the outer planes of anything else, and the real faces of merged geometry) and
 * moves one of each such pair a few millimetres, along the one axis where they meet: a solid piece
 * grows along it about its own centre (only deepening overlaps that are already there, so no gap
 * opens), a thin one (a slat, a band, a decal) slides along it instead, so it never gets visibly
 * thicker. The largest pieces stay exactly as built, and so do merged geometries (their inner
 * faces would move unpredictably), skinned, instanced and see-through pieces, and any mesh marked
 * `userData.exact`.
 */

/** Faces closer than this (metres) can fight in the depth buffer. */
export const COPLANAR_GAP = 0.0025;
/** A step of movement (metres): each clears the gap with room to spare. */
const STEP = 0.0032;
const LEVELS = 7;
/** Growing a piece by more than this share of its thickness would show: it slides instead. */
const MAX_THICKEN = 0.15;
/** The most steps a piece may slide. */
const MAX_SLIDE = 4;

interface Face {
  n: THREE.Vector3;
  d: number;
  lo: THREE.Vector3;
  hi: THREE.Vector3;
  /** The piece's own axis this face looks along (−1: a face of a merged geometry, never moved), and which way. */
  k: number;
  s: number;
}

interface Piece {
  m: THREE.Mesh;
  faces: Face[];
  bins: Face[][];
  vol: number;
  fixed: boolean;
  /** Its own axes in the root's frame (unit), and its size along each (metres). */
  dirs: THREE.Vector3[];
  size: number[];
  centre: THREE.Vector3;
  lo: THREE.Vector3;
  hi: THREE.Vector3;
  /** Along each axis: growth per side, shift, and whether that's been decided. */
  g: number[];
  t: number[];
  done: boolean[];
}

export function separateCoplanar(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const pieces: Piece[] = [];
  const M = new THREE.Matrix4(), c = new THREE.Vector3(), h = new THREE.Vector3();
  const axis = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || m.userData.exact) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.every((x) => x.transparent || !x.depthWrite || x.polygonOffset)) return;
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox!;
    if (bb.isEmpty()) return;
    bb.getCenter(c);
    bb.getSize(h).multiplyScalar(0.5);
    M.multiplyMatrices(inv, m.matrixWorld);
    M.extractBasis(axis[0], axis[1], axis[2]);
    const centre = c.clone().applyMatrix4(M);
    const half = axis.map((a, k) => a.clone().multiplyScalar(h.getComponent(k)));
    const dirs = axis.map((a) => a.clone().normalize());
    const size = half.map((v) => 2 * v.length());
    if (size.filter((v) => v < 1e-5).length > 1) return;
    const faces: Face[] = [];
    for (let k = 0; k < 3; k++) {
      for (const s of [1, -1]) {
        const p = centre.clone().addScaledVector(half[k], s);
        const fn = dirs[k].clone().multiplyScalar(s);
        // (Undersides on the ground: nobody sees them.)
        if (fn.y < -0.9 && p.y < 0.02) continue;
        const lo = p.clone(), hi = p.clone();
        for (const j of [0, 1, 2]) {
          if (j === k) continue;
          const e = new THREE.Vector3(Math.abs(half[j].x), Math.abs(half[j].y), Math.abs(half[j].z));
          lo.sub(e);
          hi.add(e);
        }
        faces.push({ n: fn, d: fn.dot(p), lo, hi, k, s });
      }
    }
    if (!faces.length) return;
    const vol = Math.max(size[0], 1e-3) * Math.max(size[1], 1e-3) * Math.max(size[2], 1e-3);
    const lo = faces[0].lo.clone(), hi = faces[0].hi.clone();
    for (const f of faces) { lo.min(f.lo); hi.max(f.hi); }
    const fixed = g.type === 'BufferGeometry';
    const own = fixed ? planesOf(g, M) : faces;
    pieces.push({ m, faces: own, bins: binned(own), vol, fixed, dirs, size, centre, lo, hi, g: [0, 0, 0], t: [0, 0, 0], done: [fixed, fixed, fixed] });
  });
  if (pieces.length < 2) return;

  // Faces that could meet in a plane once moved: the same way round, close, and overlapping.
  const reach = STEP * LEVELS + COPLANAR_GAP;
  const near: { j: number; fa: Face; fb: Face; sa: number; sb: number }[][] = pieces.map(() => []);
  const q = new THREE.Vector3();
  const pair = (a: number, b: number, fa: Face, fb: Face): void => {
    if (fa.n.dot(fb.n) < 0.9995) return;
    // Overlapping across the plane (along the normal they may lie a little apart).
    const ex = Math.min(fa.hi.x, fb.hi.x) - Math.max(fa.lo.x, fb.lo.x) + reach * Math.abs(fa.n.x);
    const ey = Math.min(fa.hi.y, fb.hi.y) - Math.max(fa.lo.y, fb.lo.y) + reach * Math.abs(fa.n.y);
    const ez = Math.min(fa.hi.z, fb.hi.z) - Math.max(fa.lo.z, fb.lo.z) + reach * Math.abs(fa.n.z);
    if (ex < -0.001 || ey < -0.001 || ez < -0.001) return;
    // (The two widest of the three: the overlap's extent in the plane.)
    if (ex + ey + ez - Math.max(ex, ey, ez) - Math.min(ex, ey, ez) < 0.002) return;
    // How far apart they lie where they overlap (timbers hewn a hair off true aren't parallel:
    // their offsets from the origin say nothing about the gap metres away).
    q.set(
      (Math.max(fa.lo.x, fb.lo.x) + Math.min(fa.hi.x, fb.hi.x)) / 2,
      (Math.max(fa.lo.y, fb.lo.y) + Math.min(fa.hi.y, fb.hi.y)) / 2,
      (Math.max(fa.lo.z, fb.lo.z) + Math.min(fa.hi.z, fb.hi.z)) / 2,
    );
    const sa = fa.d - fa.n.dot(q), sb = fb.d - fb.n.dot(q);
    if (Math.abs(sa - sb) > reach) return;
    near[a].push({ j: b, fa, fb, sa, sb });
    near[b].push({ j: a, fa: fb, fb: fa, sa: sb, sb: sa });
  };
  // (Sweeping along x: a whole house holds thousands of pieces, and only neighbours can meet.)
  const byX = pieces.map((_, i) => i).sort((x, y) => pieces[x].lo.x - pieces[y].lo.x);
  for (let ia = 0; ia < byX.length; ia++) for (let ib = ia + 1; ib < byX.length; ib++) {
    let a = byX[ia], b = byX[ib];
    if (pieces[b].lo.x > pieces[a].hi.x + reach) break;
    const P = pieces[a], Q = pieces[b];
    // (Two pieces that stay as built can't be helped here.)
    if (P.fixed && Q.fixed) continue;
    if (P.lo.y > Q.hi.y + reach || Q.lo.y > P.hi.y + reach || P.lo.z > Q.hi.z + reach || Q.lo.z > P.hi.z + reach) continue;
    if (a > b) [a, b] = [b, a];
    const A = pieces[a].bins, B = pieces[b].bins;
    // (Faces are binned by the axis they face: only like faces, or a slanted one, can meet.)
    for (let k = 0; k < 6; k++) for (const fa of A[k]) for (const fb of B[k]) pair(a, b, fa, fb);
    for (const fa of A[6]) for (const fb of pieces[b].faces) pair(a, b, fa, fb);
    for (let k = 0; k < 6; k++) for (const fa of A[k]) for (const fb of B[6]) pair(a, b, fa, fb);
  }

  // How far a face has moved out along its normal (null: its piece hasn't decided along that axis).
  const moved = (p: Piece, f: Face): number | null => (f.k < 0 ? 0 : p.done[f.k] ? p.g[f.k] + f.s * p.t[f.k] : null);
  // Largest first: it keeps its shape, the pieces against it move. One axis at a time.
  const order = pieces.map((_, i) => i).sort((x, y) => pieces[y].vol - pieces[x].vol);
  for (const i of order) {
    const P = pieces[i];
    for (let k = 0; k < 3; k++) {
      if (P.done[k]) continue;
      const here = near[i].filter((e) => e.fa.k === k);
      P.done[k] = true;
      if (!here.length) continue;
      // The moves to try, least visible first: nothing, then a step at a time, growing a solid
      // piece and sliding a thin one (or one that would thicken too much).
      const tries: [number, number][] = [[0, 0]];
      for (let L = 1; L <= LEVELS; L++) {
        const d = L * STEP;
        const thin = P.size[k] < 1e-5 || (2 * d) / P.size[k] > MAX_THICKEN;
        // (A slide of more than a centimetre or so would show: past that only growing is tried.)
        const slide: [number, number][] = L <= MAX_SLIDE ? [[0, d], [0, -d]] : [];
        if (thin) tries.push(...slide);
        else tries.push([d, 0], ...slide);
      }
      let best = tries[0], bestBad = Infinity;
      for (const [g, t] of tries) {
        let bad = 0;
        for (const e of here) {
          const other = moved(pieces[e.j], e.fb);
          if (other === null) continue;
          if (Math.abs(e.sa + g + e.fa.s * t - (e.sb + other)) < COPLANAR_GAP) bad++;
        }
        if (bad < bestBad) { best = [g, t]; bestBad = bad; }
        if (!bad) break;
      }
      [P.g[k], P.t[k]] = best;
    }
  }

  const geoSize = new THREE.Vector3(), geoCentre = new THREE.Vector3();
  const rootWorld = root.matrixWorld;
  for (const P of pieces) {
    if (P.fixed || (!P.g.some((v) => v) && !P.t.some((v) => v))) continue;
    const m = P.m;
    // Grow about the piece's own centre (its geometry may sit off its origin).
    m.geometry.boundingBox!.getSize(geoSize);
    m.geometry.boundingBox!.getCenter(geoCentre);
    const before = m.scale.clone();
    for (let k = 0; k < 3; k++) {
      if (P.g[k] && P.size[k] > 1e-4) m.scale.setComponent(k, m.scale.getComponent(k) * (1 + (2 * P.g[k]) / P.size[k]));
    }
    m.position.add(new THREE.Vector3((before.x - m.scale.x) * geoCentre.x, (before.y - m.scale.y) * geoCentre.y, (before.z - m.scale.z) * geoCentre.z).applyQuaternion(m.quaternion));
    // Slide: from the root's frame to the parent's.
    const shift = new THREE.Vector3();
    for (let k = 0; k < 3; k++) shift.addScaledVector(P.dirs[k], P.t[k]);
    if (shift.lengthSq() > 0) {
      const a = P.centre.clone().applyMatrix4(rootWorld), b = P.centre.clone().add(shift).applyMatrix4(rootWorld);
      if (m.parent) { m.parent.worldToLocal(a); m.parent.worldToLocal(b); }
      m.position.add(b.sub(a));
    }
  }
  root.updateMatrixWorld(true);
}

/** The flat faces of a geometry (in the frame M takes it to): its triangles gathered by plane. */
function planesOf(g: THREE.BufferGeometry, M: THREE.Matrix4): Face[] {
  const pos = g.getAttribute('position');
  if (!pos) return [];
  const idx = g.getIndex();
  const count = idx ? idx.count : pos.count;
  const planes = new Map<string, Face>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  for (let i = 0; i + 2 < count; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(M);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(M);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(M);
    n.subVectors(b, a).cross(e.subVectors(c, a));
    if (n.lengthSq() < 4e-8) continue;
    n.normalize();
    const d = n.dot(a);
    if (n.y < -0.9 && d > -0.02) continue;
    const key = `${Math.round(n.x * 500)},${Math.round(n.y * 500)},${Math.round(n.z * 500)},${Math.round(d / 0.001)}`;
    const f = planes.get(key);
    if (!f) planes.set(key, { n: n.clone(), d, lo: a.clone().min(b).min(c), hi: a.clone().max(b).max(c), k: -1, s: 1 });
    else { f.lo.min(a).min(b).min(c); f.hi.max(a).max(b).max(c); }
  }
  return [...planes.values()];
}

/** Faces by the axis they face (+x, −x, +y, −y, +z, −z), and the slanted ones last. */
function binned(faces: Face[]): Face[][] {
  const bins: Face[][] = [[], [], [], [], [], [], []];
  for (const f of faces) {
    const ax = Math.abs(f.n.x), ay = Math.abs(f.n.y), az = Math.abs(f.n.z);
    const k = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const c = f.n.getComponent(k);
    bins[Math.abs(c) < 0.95 ? 6 : k * 2 + (c < 0 ? 1 : 0)].push(f);
  }
  return bins;
}

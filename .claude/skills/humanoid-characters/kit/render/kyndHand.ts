import * as THREE from 'three';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { capsule, ellipsoid, sculpt, type Mass, type Sculpt, type V3 } from './sdfMesh.ts';

/*
 * A Kynd's hand, sculpted as one continuous surface: palm, knuckles, the pads of the thumb and the
 * little finger, four fingers in three joints and a two-jointed thumb, all clay masses melted into
 * each other (sdfMesh.ts), so the fingers grow out of the hand with webbing between them and the
 * thumb rises out of its mound instead of being pegs set into a palm. Skinned automatically to the
 * hand's bones (each finger at its knuckle and middle joint, the thumb at its root and middle), so
 * every joint bends softly.
 *
 * Wrist-relative, left hand (side +1), in the rest pose: arm down (fingers toward −y), palm facing
 * the thigh (palm normal −x), thumb to the front (+z). The right hand is its mirror. Sculpted once
 * and reused for every Kynd (scaled by build).
 */

/** The fingers, index to little: bone-name letter, knuckle height and depth below the wrist, length, girth, and the relaxed curl of each joint. */
export const FINGERS = [
  { k: 'i', y: -0.078, z: 0.0305, len: 0.079, r: 0.0082, curl: [0.1, 0.2, 0.13] },
  { k: 'm', y: -0.081, z: 0.0105, len: 0.088, r: 0.0085, curl: [0.13, 0.25, 0.16] },
  { k: 'r', y: -0.079, z: -0.0098, len: 0.083, r: 0.0079, curl: [0.17, 0.3, 0.18] },
  { k: 'p', y: -0.074, z: -0.0292, len: 0.067, r: 0.0068, curl: [0.22, 0.34, 0.2] },
] as const;
/** Each finger's three segments as fractions of its length. */
export const FINGER_SEGS = [0.45, 0.31, 0.24] as const;

/** A finger's joints, wrist-relative (side `s`, unit scale): knuckle, middle joint, last joint, tip. */
export function fingerJoints(i: number, s: 1 | -1): THREE.Vector3[] {
  const f = FINGERS[i];
  let p = new THREE.Vector3(0, f.y, f.z);
  const out = [p.clone()];
  let a = 0;
  for (let j = 0; j < 3; j++) {
    a += f.curl[j];
    p = p.clone().add(new THREE.Vector3(-s * Math.sin(a), -Math.cos(a), (f.z - 0.004) * 1.1).multiplyScalar(f.len * FINGER_SEGS[j]));
    out.push(p);
  }
  return out;
}

/** The thumb: root (in the palm), middle joint, last joint, tip (side `s`, unit scale). */
export function thumbJoints(s: 1 | -1): THREE.Vector3[] {
  return [
    new THREE.Vector3(-s * 0.004, -0.008, 0.017),
    new THREE.Vector3(-s * 0.01, -0.052, 0.041),
    new THREE.Vector3(-s * 0.014, -0.078, 0.047),
    new THREE.Vector3(-s * 0.018, -0.103, 0.044),
  ];
}

/** Bone slots of the sculpt (mapped to the skeleton's per side). */
export const HAND_BONES = { el: 0, wr: 1, finger: [2, 4, 6, 8], finger2: [3, 5, 7, 9], th: 10, th2: 11 } as const;

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

function masses(): Mass[] {
  const B = HAND_BONES;
  const out: Mass[] = [
    // The wrist: the forearm's own oval (a hair larger, so its end stays hidden inside), long
    // enough to reach up into the sleeve.
    ellipsoid([0, 0, 0], [0.0218, 0.075, 0.0288], B.wr, 0),
    // The palm: broad and flat, widest at the knuckles.
    ellipsoid([0, -0.046, 0.001], [0.0142, 0.05, 0.0418], B.wr, 0, 0.012),
    // The knuckle line across the back of the hand.
    ellipsoid([0.001, -0.075, 0.001], [0.0124, 0.015, 0.0442], B.wr, 0, 0.01),
    // The thumb's mound (thenar) and the pad along the little-finger edge, on the palm side.
    ellipsoid([-0.005, -0.031, 0.022], [0.0098, 0.024, 0.0128], B.wr, 0, 0.011),
    ellipsoid([-0.0052, -0.05, -0.03], [0.0095, 0.03, 0.011], B.wr, 0, 0.01),
  ];
  // Fingers: the first joint melts into the knuckles and its neighbours (the webbing), the others
  // stay crisp so the fingers read apart.
  FINGERS.forEach((f, i) => {
    const [k, j1, j2, tip] = fingerJoints(i, 1);
    const start = k.clone().add(new THREE.Vector3(0, 0.01, 0));
    const r = f.r;
    // The tip's round end lies inside the finger's length, not beyond it.
    const end = tip.clone().addScaledVector(tip.clone().sub(j2).normalize(), -r * 0.66);
    out.push(capsule(v3(start), v3(j1), r * 1.02, r * 0.93, B.finger[i], 0, 0.0055));
    out.push(capsule(v3(j1), v3(j2), r * 0.93, r * 0.84, B.finger2[i], 0, 0.0016));
    out.push(capsule(v3(j2), v3(end), r * 0.82, r * 0.68, B.finger2[i], 0, 0.0016));
  });
  // The thumb: out of its mound and along the side of the hand, a little apart from the index.
  const [t0, t1, t2, t3] = thumbJoints(1);
  const tEnd = t3.clone().addScaledVector(t3.clone().sub(t2).normalize(), -0.0078 * 0.6);
  out.push(capsule(v3(t0), v3(t1), 0.0112, 0.0098, B.th, 0, 0.009));
  out.push(capsule(v3(t1), v3(t2), 0.0098, 0.009, B.th2, 0, 0.002));
  out.push(capsule(v3(t2), v3(tEnd), 0.0089, 0.0078, B.th2, 0, 0.002));
  return out;
}

let cached: Sculpt | null = null;

/** Above this (wrist-relative) the hand is inside the forearm or the sleeve: not kept. */
const HIDDEN_ABOVE = 0.042;
/** Vertices a hand keeps after simplifying (about 4,500 triangles). */
const TARGET_VERTICES = 2300;

/**
 * The left hand's sculpt (built on first use, then shared): sculpted fine enough for round
 * fingers, the hidden part inside the forearm dropped, then simplified to a game budget (about a
 * third of the triangles; the simplifier keeps the shape where it curves). Each kept vertex takes
 * its skin weights from the nearest original vertex facing the same way, so a fingertip never
 * borrows its neighbour's bone.
 */
export function handSculpt(): Sculpt {
  if (cached) return cached;
  const full = sculpt(masses(), 0.0027, 0, { smooth: 2, normalSmooth: 2, weightSoft: 0.004, weightSmooth: 2 });
  const P = full.positions;
  const keep: number[] = [];
  for (let t = 0; t < full.indices.length; t += 3) {
    const a = full.indices[t], b = full.indices[t + 1], c = full.indices[t + 2];
    if (P[a * 3 + 1] > HIDDEN_ABOVE && P[b * 3 + 1] > HIDDEN_ABOVE && P[c * 3 + 1] > HIDDEN_ABOVE) continue;
    keep.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(full.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(full.normals, 3));
  g.setIndex(keep);
  const used = new Set(keep).size;
  const lite = new SimplifyModifier().modify(g, Math.max(0, used - TARGET_VERTICES));
  g.dispose();
  const pos = lite.getAttribute('position').array as Float32Array;
  const nrm = lite.getAttribute('normal').array as Float32Array;
  const n = pos.length / 3;
  // Weights from the nearest original vertex (a coarse grid keeps the search local).
  const cell = 0.006;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < P.length / 3; i++) {
    const k = key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  const N = full.normals;
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let best = -1, bestD = Infinity;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (N[i * 3] * nrm[v * 3] + N[i * 3 + 1] * nrm[v * 3 + 1] + N[i * 3 + 2] * nrm[v * 3 + 2] < 0.2) continue;
        const d = (P[i * 3] - x) ** 2 + (P[i * 3 + 1] - y) ** 2 + (P[i * 3 + 2] - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best < 0) best = 0;
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = full.skinIndex[best * 4 + k];
      skinWeight[v * 4 + k] = full.skinWeight[best * 4 + k];
    }
  }
  const index = lite.getIndex();
  cached = {
    positions: pos,
    normals: nrm,
    indices: index ? Uint32Array.from(index.array as ArrayLike<number>) : Uint32Array.from({ length: n }, (_, i) => i),
    skinIndex,
    skinWeight,
    tagWeights: new Float32Array(0),
    tagCount: 0,
  };
  lite.dispose();
  return cached;
}

import * as THREE from 'three';
import type { FullAppearance } from '../sim/entities/appearance.ts';
import type { LifeStage } from '../sim/family/Life.ts';
import {
  around,
  Bucket,
  capsuleR,
  col,
  ellipsoid,
  grid,
  KIND,
  clamp01,
  lerp,
  mixCol,
  Path,
  Profile,
  pushWeights,
  range,
  rowMesh,
  shade,
  smoothstep,
  tube,
  type Paint,
  type Weights,
} from './kyndGeometry.ts';
import { FINGERS, HAND_BONES, fingerJoints, handSculpt, thumbJoints } from './kyndHand.ts';
import {
  CANON,
  EYE_IN,
  EYE_OUT,
  FACE_ROW_HIGH,
  FACE_ROW_LOW,
  FaceWarp,
  eyeParam,
  faceLayout,
  faceRows,
  faceSurface,
  faceU,
  faceV,
  headShape,
  lidWeight,
  lidsFor,
  type FaceLayout,
  type HeadShape,
  type Lids,
} from './kyndFace.ts';

/*
 * The Kynd body: skeleton layout, skin weights, and the parts everyone has — head and face, hair,
 * beard, neck, hands, legs and boots. Garments live in KyndGarments.ts.
 *
 * All geometry is authored in the rest pose (arms hanging, legs straight) in the avatar's root
 * space before its height scale. Head parts are authored at head size 1; the head bone scales them.
 */

export const BONES = [
  'body', 'pelvis', 'spine', 'neck', 'head', 'jaw', 'mouthL', 'mouthR', 'browL', 'browR', 'lids', 'eyeL', 'eyeR',
  'belly', 'cloak', 'shL', 'elL', 'shR', 'elR', 'hipL', 'kneeL', 'hipR', 'kneeR',
  'skFL', 'skKL', 'skFR', 'skKR', 'skBL', 'skBR',
  'hairBack', 'hairL', 'hairR', 'lidsM', 'lidsE',
  // Hands: the wrist; each finger (index, middle, ring, little) at its knuckle and again at its
  // middle joint, so they curl in a cascade and fan apart; the thumb at its root and its middle.
  'wrL', 'fiL', 'fi2L', 'fmL', 'fm2L', 'frL', 'fr2L', 'fpL', 'fp2L', 'thL', 'th2L',
  'wrR', 'fiR', 'fi2R', 'fmR', 'fm2R', 'frR', 'fr2R', 'fpR', 'fp2R', 'thR', 'th2R',
  // Ankles, so feet stay flat on the ground, roll heel to toe, and lie back when kneeling.
  'anL', 'anR',
  // Half-joints: at the elbow and the knee, turning half as far as the joint itself. Skin round the
  // joint follows them, so a bend stays round instead of folding to a crease.
  'elMidL', 'elMidR', 'kneeMidL', 'kneeMidR',
] as const;
export type BoneName = (typeof BONES)[number];
export const BI = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<BoneName, number>;

// Rest heights (root space, before the Kynd's height scale). The pose code is tuned to these.
export const PELVIS_Y = 0.92;
export const SPINE_Y = 0.98;
export const NECK_Y = 1.51;
export const HEAD_Y = 1.568;
export const SH_Y = 1.44;
export const EL_Y = 1.16;
export const WRIST_Y = 0.915;
export const HIP_Y = 0.88;
export const KNEE_Y = 0.46;

export interface Measure {
  w: number;
  female: boolean;
  shX: number;
  hipX: number;
  /** 0 child … 1 grown: how much adult shape (bust, hips, jaw) shows. */
  mature: number;
}

export function measure(look: FullAppearance, stage: LifeStage): Measure {
  const w = 0.92 + look.build * 0.2;
  const female = look.sex === 'female';
  const mature = stage === 'child' ? 0 : stage === 'teen' ? 0.6 : 1;
  return { w, female, shX: (female ? 0.186 : 0.2) * w, hipX: 0.085 * w, mature };
}

/** The leg's radius by height (below 0.5 it doesn't scale with build). */
export const LEG = new Profile([
  [0.06, 0.036],
  [0.12, 0.04],
  [0.3, 0.056],
  [0.4, 0.053],
  [KNEE_Y, 0.052],
  [0.62, 0.064],
  [0.8, 0.074],
  [PELVIS_Y, 0.08],
  [PELVIS_Y + 0.05, 0.07],
]);

/** Height of the ankle joint above the ground. */
export const ANKLE_Y = 0.072;

/** Leg weights, with the foot (and the bottom of a boot shaft) handed over to the ankle. */
export function footWeights(p: THREE.Vector3, side: 1 | -1): Weights {
  const a = smoothstep(0.112, 0.062, p.y);
  if (a <= 0) return legWeights(p, side);
  return side === 1 ? [BI.kneeL, 1 - a, BI.anL, a] : [BI.kneeR, 1 - a, BI.anR, a];
}

/** Where the knuckles and the fingers' middle joints sit below the wrist, and the thumb's root. */

function handBones(m: Measure, s: 1 | -1) {
  // The hand is scaled with the build, like the forearm it meets (buildHands).
  const sc = m.w;
  const L = s === 1 ? 'L' : 'R';
  const el = (s === 1 ? 'elL' : 'elR') as BoneName;
  const wr = `wr${L}` as BoneName;
  const at = (v: THREE.Vector3): [number, number, number] => [v.x * sc, v.y * sc, v.z * sc];
  const out: Partial<Record<BoneName, { parent: BoneName | null; pos: [number, number, number] }>> = {
    [wr]: { parent: el, pos: [0, WRIST_Y - EL_Y, 0] },
  };
  // A bone at each finger's knuckle and another at its middle joint, exactly where the sculpted
  // finger bends; the thumb at its root and its middle joint.
  FINGERS.forEach((f, i) => {
    const [k, j1] = fingerJoints(i, s);
    const base = `f${f.k}${L}` as BoneName;
    out[base] = { parent: wr, pos: at(k) };
    out[`f${f.k}2${L}` as BoneName] = { parent: base, pos: at(j1.clone().sub(k)) };
  });
  const [t0, t1] = thumbJoints(s);
  out[`th${L}` as BoneName] = { parent: wr, pos: at(t0) };
  out[`th2${L}` as BoneName] = { parent: `th${L}` as BoneName, pos: at(t1.clone().sub(t0)) };
  return out;
}

/** Parent and local rest offset of every bone. */
export function boneLayout(m: Measure, face: FaceLayout): Record<BoneName, { parent: BoneName | null; pos: [number, number, number] }> {
  const h = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  return {
    body: { parent: null, pos: h(0, 0, 0) },
    pelvis: { parent: 'body', pos: h(0, PELVIS_Y, 0) },
    spine: { parent: 'pelvis', pos: h(0, SPINE_Y - PELVIS_Y, 0) },
    neck: { parent: 'spine', pos: h(0, NECK_Y - SPINE_Y, 0) },
    head: { parent: 'neck', pos: h(0, HEAD_Y - NECK_Y, 0) },
    jaw: { parent: 'head', pos: h(0, 0.088, 0.0) },
    mouthL: { parent: 'head', pos: h(face.mouthW, face.mouthY, face.mouthZ) },
    mouthR: { parent: 'head', pos: h(-face.mouthW, face.mouthY, face.mouthZ) },
    browL: { parent: 'head', pos: h(face.eyeX, face.eyeY + 0.034, face.eyeZ + 0.01) },
    browR: { parent: 'head', pos: h(-face.eyeX, face.eyeY + 0.034, face.eyeZ + 0.01) },
    lids: { parent: 'head', pos: h(0, face.eyeY, face.eyeZ) },
    lidsM: { parent: 'head', pos: h(0, face.eyeY, face.eyeZ) },
    lidsE: { parent: 'head', pos: h(0, face.eyeY, face.eyeZ) },
    eyeL: { parent: 'head', pos: h(face.eyeX, face.eyeY, face.eyeZ) },
    eyeR: { parent: 'head', pos: h(-face.eyeX, face.eyeY, face.eyeZ) },
    belly: { parent: 'spine', pos: h(0, 0.09, 0.02) },
    cloak: { parent: 'spine', pos: h(0, 0.5, -0.08) },
    hairBack: { parent: 'spine', pos: h(0, 0.57, -0.16) },
    hairL: { parent: 'spine', pos: h(0.12, 0.57, 0) },
    hairR: { parent: 'spine', pos: h(-0.12, 0.57, 0) },
    shL: { parent: 'spine', pos: h(m.shX, SH_Y - SPINE_Y, 0) },
    elL: { parent: 'shL', pos: h(0, EL_Y - SH_Y, 0) },
    shR: { parent: 'spine', pos: h(-m.shX, SH_Y - SPINE_Y, 0) },
    elR: { parent: 'shR', pos: h(0, EL_Y - SH_Y, 0) },
    hipL: { parent: 'pelvis', pos: h(m.hipX, HIP_Y - PELVIS_Y, 0) },
    kneeL: { parent: 'hipL', pos: h(0, KNEE_Y - HIP_Y, 0) },
    hipR: { parent: 'pelvis', pos: h(-m.hipX, HIP_Y - PELVIS_Y, 0) },
    kneeR: { parent: 'hipR', pos: h(0, KNEE_Y - HIP_Y, 0) },
    elMidL: { parent: 'shL', pos: h(0, EL_Y - SH_Y, 0) },
    elMidR: { parent: 'shR', pos: h(0, EL_Y - SH_Y, 0) },
    kneeMidL: { parent: 'hipL', pos: h(0, KNEE_Y - HIP_Y, 0) },
    kneeMidR: { parent: 'hipR', pos: h(0, KNEE_Y - HIP_Y, 0) },
    skFL: { parent: 'pelvis', pos: h(m.hipX, HIP_Y - PELVIS_Y, 0) },
    skKL: { parent: 'skFL', pos: h(0, KNEE_Y - HIP_Y, 0) },
    skFR: { parent: 'pelvis', pos: h(-m.hipX, HIP_Y - PELVIS_Y, 0) },
    skKR: { parent: 'skFR', pos: h(0, KNEE_Y - HIP_Y, 0) },
    skBL: { parent: 'pelvis', pos: h(m.hipX, HIP_Y - PELVIS_Y, 0) },
    skBR: { parent: 'pelvis', pos: h(-m.hipX, HIP_Y - PELVIS_Y, 0) },
    anL: { parent: 'kneeL', pos: h(0, ANKLE_Y - KNEE_Y, 0) },
    anR: { parent: 'kneeR', pos: h(0, ANKLE_Y - KNEE_Y, 0) },
    ...handBones(m, 1),
    ...handBones(m, -1),
  } as Record<BoneName, { parent: BoneName | null; pos: [number, number, number] }>;
}

// --- skin weights ------------------------------------------------------------------------------

/** Trunk and anything hung on it: pelvis → spine → neck, the pregnancy bump, skirts on the legs. */
export function trunkWeights(p: THREE.Vector3, m: Measure, opts: { skirt?: boolean; belly?: boolean; cloak?: number } = {}): Weights {
  const y = p.y;
  const out: number[] = [];
  const spine = smoothstep(0.95, 1.08, y);
  const neck = smoothstep(1.52, 1.6, y);
  let rest = 1;
  if (opts.belly !== false && m.female) {
    const bw = Math.exp(-Math.pow((y - 1.07) / 0.13, 2)) * smoothstep(-0.03, 0.09, p.z) * Math.exp(-Math.pow(p.x / 0.15, 2)) * 0.95;
    if (bw > 0.01) {
      out.push(BI.belly, bw);
      rest -= bw;
    }
  }
  if (opts.cloak) {
    const cw = opts.cloak;
    out.push(BI.cloak, cw * rest);
    rest *= 1 - cw;
  }
  if (opts.skirt && y < 0.9) {
    const g = smoothstep(0.9, 0.7, y);
    const r = Math.hypot(p.x, p.z) || 1;
    const f = smoothstep(-0.3, 0.35, p.z / r);
    const sL = smoothstep(-0.55, 0.55, p.x / r);
    const k = smoothstep(0.62, 0.42, y);
    out.push(BI.pelvis, rest * (1 - g));
    const legs = rest * g;
    out.push(BI.skFL, legs * f * sL * (1 - k), BI.skKL, legs * f * sL * k);
    out.push(BI.skFR, legs * f * (1 - sL) * (1 - k), BI.skKR, legs * f * (1 - sL) * k);
    out.push(BI.skBL, legs * (1 - f) * sL, BI.skBR, legs * (1 - f) * (1 - sL));
    return out;
  }
  out.push(BI.pelvis, rest * (1 - spine), BI.spine, rest * spine * (1 - neck), BI.neck, rest * spine * neck);
  return out;
}

/**
 * Round a hinge: above the joint the upper bone, below it the lower, and across a band either side
 * the half-joint (which turns half as far), so the skin over a bent elbow or knee is shared out
 * over the band instead of all folding at one line.
 */
function hinge(dy: number, band: number): [number, number, number] {
  const up = smoothstep(0, band, dy);
  const down = smoothstep(0, band, -dy);
  return [up, 1 - up - down, down];
}

export function armWeights(p: THREE.Vector3, side: 1 | -1): Weights {
  const [u, mid, d] = hinge(p.y - EL_Y, 0.065);
  return side === 1 ? [BI.shL, u, BI.elMidL, mid, BI.elL, d] : [BI.shR, u, BI.elMidR, mid, BI.elR, d];
}

export function legWeights(p: THREE.Vector3, side: 1 | -1): Weights {
  const [u, mid, d] = hinge(p.y - KNEE_Y, 0.075);
  const top = smoothstep(0.86, 0.95, p.y);
  return side === 1
    ? [BI.pelvis, top * u, BI.hipL, u * (1 - top), BI.kneeMidL, mid, BI.kneeL, d]
    : [BI.pelvis, top * u, BI.hipR, u * (1 - top), BI.kneeMidR, mid, BI.kneeR, d];
}

/** Head-space point (relative to the head bone, head size 1) to root space. */
export function hp(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, y + HEAD_Y, z);
}

// --- colours -------------------------------------------------------------------------------

export interface Palette {
  skin: THREE.Color;
  skinDark: THREE.Color;
  lip: THREE.Color;
  hair: THREE.Color;
  hairDark: THREE.Color;
  hairLight: THREE.Color;
  brow: THREE.Color;
  lash: THREE.Color;
  iris: THREE.Color;
  tunic: THREE.Color;
  trim: THREE.Color;
  legs: THREE.Color;
  accent: THREE.Color;
  linen: THREE.Color;
  leather: THREE.Color;
  leatherDark: THREE.Color;
  gold: THREE.Color;
}

export function palette(look: FullAppearance): Palette {
  const skin = col(look.skin);
  const hair = col(look.hair);
  const lum = hair.r * 0.3 + hair.g * 0.55 + hair.b * 0.15;
  return {
    skin,
    skinDark: mixCol(skin, col('#7a3a30'), 0.25),
    lip: lipColor(skin, look.sex === 'female'),
    hair,
    hairDark: shade(hair, 0.55),
    hairLight: mixCol(hair, col('#fff3dc'), 0.22),
    brow: shade(hair, lum > 0.35 ? 0.62 : 0.85),
    lash: mixCol(shade(hair, 0.3), col('#140c08'), 0.7),
    iris: col(look.eyes),
    tunic: col(look.tunic),
    trim: col(look.trim),
    legs: col(look.legs),
    accent: col(look.accent),
    linen: col('#ece3cf'),
    leather: col('#5a3a24'),
    leatherDark: col('#35231a'),
    gold: col('#d9a93e'),
  };
}

// --- the head ------------------------------------------------------------------------------

export type { FaceLayout, HeadShape };

const _d = new THREE.Vector3();
const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _s3 = new THREE.Vector3();

/**
 * The skull without the face: a slightly egg-shaped ellipsoid with a narrower lower face and a
 * nape that tucks into the neck. `theta` is the angle around from the front (+z) towards the
 * Kynd's left (+x); `phi` is from the crown (0) to under the chin (π).
 */
function skull(theta: number, phi: number, s: HeadShape, out: THREE.Vector3): THREE.Vector3 {
  const sx = Math.sin(phi) * Math.sin(theta);
  const sy = Math.cos(phi);
  const sz = Math.sin(phi) * Math.cos(theta);
  const rx = (0.077 + s.width * 0.029) + s.child * 0.007;
  const ryB = 0.112 - s.child * 0.006;
  const ry = sy > 0 ? 0.13 : ryB * (0.80 + s.length * 0.44);
  const rz = sz > 0 ? 0.103 : 0.113;
  // The lower front is boxier than an egg: the jaw carries the mouth and chin forward, then turns
  // under the chin to the throat.
  const e = 2 + 1.7 * smoothstep(0.3, 0.92, -sy) * smoothstep(0.05, 0.6, sz);
  const r = e === 2 ? 1 / Math.sqrt((sx / rx) ** 2 + (sy / ry) ** 2 + (sz / rz) ** 2)
    : Math.pow(Math.abs(sx / rx) ** e + Math.abs(sy / ry) ** e + Math.abs(sz / rz) ** e, -1 / e);
  let x = sx * r;
  let y = sy * r;
  let z = sz * r;
  const low = Math.max(0, -y / ryB); // 0 at the centre line … 1 at the chin
  // Lower face: narrower, with the jaw's corner set by `jaw`.
  const jawCorner = Math.exp(-(((low - 0.62) / 0.22) ** 2));
  const soft = 1 - Math.pow(low, 1.7) * (0.26 - s.jaw * 0.14 - s.child * 0.05);
  x *= soft * (1 + jawCorner * (s.jaw - 0.45) * 0.14);
  // A soft jaw narrows on toward the chin (an oval, not a U); a square one keeps its breadth.
  x *= 1 - smoothstep(0.45, 1, low) * Math.max(0, 0.6 - s.jaw) * 0.3 * smoothstep(-0.03, 0.05, z) * (1 - s.child * 0.5);
  // Adult temples tuck in above the cheek arch; children keep a fuller cranium.
  x *= 1 - Math.exp(-(((y - 0.03) / 0.035) ** 2)) * 0.045 * (1 - s.child);
  x *= 1 + Math.exp(-(((y + 0.025) / 0.028) ** 2)) * (s.cheeks - 0.5) * 0.3;
  x *= mandible(y + 0.125, z, s);
  if (z > 0) {
    // A flatter face front, so the features sit on a plane rather than a ball.
    const side = Math.abs(sx);
    z *= 1 - side * side * 0.12;
    // Chin forward a touch, the jaw line tucked under.
    z *= 1 + Math.exp(-(((low - 0.9) / 0.12) ** 2)) * lerp(0.025, 0.08, s.chin) * (1 - side);
  } else {
    // Back of the skull full at the top, tucking into the nape below.
    z *= 1 + Math.max(0, y / 0.13) * 0.04 - smoothstep(0.1, 0.85, low) * 0.34;
  }
  if (y < 0) y *= 1 - Math.max(0, -sz) * 0.25; // the nape sits higher than the chin
  return out.set(x, y + 0.125, z);
}

/**
 * The jaw bone's outline on the side of the face, as a factor on the skull's width at head-space
 * height `yh` and depth `z`: the side of the face is held out down to the jaw's lower border (which
 * runs from its angle, below the ear, forward and down to the chin) and tucks in sharply under it,
 * so a jawline shows instead of an egg curving smoothly under into the neck. A square jaw has a
 * fuller, more angular border; a child's is soft.
 */
export function mandible(yh: number, z: number, s: HeadShape): number {
  const J = s.jaw;
  const soft = 1 - s.child * 0.65;
  // The border's height: highest at the angle, falling forward to the chin.
  const yB = lerp(0.039 - J * 0.004, 0.026, smoothstep(0.0, 0.07, z));
  // Only along the jaw: from the angle (just in front of the ear) to the side of the chin.
  const along = smoothstep(-0.025, 0.002, z) * (1 - smoothstep(0.07, 0.1, z));
  // Held out above the border (most just above it), cut in below it.
  // The angle: rounded (the cut softer and higher up the jaw) … sharp (crisper, held out more).
  const A = s.jawAngle;
  const hold = clamp01((yB + 0.022 - yh) / 0.022) * smoothstep(yB - 0.005, yB + 0.001, yh);
  const under = smoothstep(yB + 0.001, yB - lerp(0.016, 0.005, A), yh);
  return 1 + along * soft * ((0.05 + J * 0.09) * lerp(0.55, 1.45, A) * hold - (0.05 + J * 0.03) * lerp(0.6, 1.35, A) * under);
}

/** Face relief over the skull: sockets, brow, nose, cheeks, muzzle and chin. */
export class Head {
  readonly s: HeadShape;
  readonly f: FaceLayout;
  readonly lids: Lids;
  readonly warp: FaceWarp;
  /** Front surface sample table for placing features. */
  private table: { x: number; y: number; z: number; theta: number; phi: number }[] = [];

  constructor(look: FullAppearance, stage: LifeStage) {
    this.s = headShape(look, stage);
    this.f = faceLayout(look, this.s);
    this.lids = lidsFor(this.s, this.f);
    this.warp = new FaceWarp(this.f);
    const p = new THREE.Vector3();
    for (let i = 0; i <= 70; i++) {
      for (let j = 0; j <= 70; j++) {
        const th = -1.35 + (2.7 * i) / 70;
        const ph = 0.4 + (2.5 * j) / 70;
        skull(th, ph, this.s, p);
        this.table.push({ x: p.x, y: p.y, z: p.z, theta: th, phi: ph });
      }
    }
    // The eyeball sits in its socket: its front just behind the brow and level with the cheek.
    // Seated well into the socket, so no part of the eyeball shows past the lids and temple in profile.
    this.f.eyeZ = this.skullZ(this.f.eyeX, this.f.eyeY) - this.f.eyeR * 1.06 - 0.0027;
    this.f.mouthZ = this.frontZ(0, this.f.mouthY);
  }

  private lastTheta = 0;
  private lastPhi = 1.6;

  /** Newton solve for the skull point over (x, y) from a starting angle pair; NaN if it fails. */
  private solve(x: number, y: number, theta: number, phi: number, iterations: number): number {
    const p = _s0, du = _s1, dv = _s2;
    const h = 0.0001;
    for (let i = 0; i < iterations; i++) {
      skull(theta, phi, this.s, p);
      const ex = p.x - x, ey = p.y - y;
      if (ex * ex + ey * ey < 1e-14) {
        if (p.z <= 0) return NaN;
        this.lastTheta = theta;
        this.lastPhi = phi;
        return p.z;
      }
      skull(theta + h, phi, this.s, du).sub(p).divideScalar(h);
      skull(theta, phi + h, this.s, dv).sub(p).divideScalar(h);
      const det = du.x * dv.y - dv.x * du.y;
      if (Math.abs(det) < 1e-8) return NaN;
      theta = THREE.MathUtils.clamp(theta - THREE.MathUtils.clamp((ex * dv.y - ey * dv.x) / det, -0.1, 0.1), -1.5, 1.5);
      phi = THREE.MathUtils.clamp(phi - THREE.MathUtils.clamp((du.x * ey - du.y * ex) / det, -0.1, 0.1), 0.01, Math.PI - 0.01);
    }
    skull(theta, phi, this.s, p);
    if ((p.x - x) ** 2 + (p.y - y) ** 2 >= 1e-12 || p.z <= 0) return NaN;
    this.lastTheta = theta;
    this.lastPhi = phi;
    return p.z;
  }

  /** Front z of the bare skull at (x, y). */
  skullZ(x: number, y: number): number {
    // Features are placed in runs of nearby points: start from the last solution when it's close.
    const warm = this.solve(x, y, this.lastTheta, this.lastPhi, 4);
    if (!Number.isNaN(warm)) return warm;
    let best = 1e9;
    let nearest = this.table[0];
    for (const t of this.table) {
      if (t.z <= 0) continue;
      const d = (t.x - x) ** 2 + (t.y - y) ** 2;
      if (d < best) {
        best = d;
        nearest = t;
      }
    }
    // The table seeds a continuous surface solve. Nearest-sample z alone gave lips,
    // brows and beard edges small visible steps as they crossed sample boundaries.
    const z = this.solve(x, y, nearest.theta, nearest.phi, 6);
    return Number.isNaN(z) ? nearest.z : z;
  }

  /** Front z of the finished face at (x, y). */
  frontZ(x: number, y: number): number {
    return faceSurface(x, y, this.skullZ(x, y), this.s, this.f, this.lids);
  }

  /** Head-space surface point, with the face. */
  point(theta: number, phi: number, out: THREE.Vector3): THREE.Vector3 {
    skull(theta, phi, this.s, out);
    out.z = faceSurface(out.x, out.y, out.z, this.s, this.f, this.lids);
    return out;
  }

  /** Head-space point on the skull pushed out along its normal-ish direction by `off`. */
  shell(theta: number, phi: number, off: number, out: THREE.Vector3): THREE.Vector3 {
    skull(theta, phi, this.s, out);
    _d.set(out.x, out.y - 0.12, out.z).normalize();
    return out.addScaledVector(_d, off);
  }

  /** The polar angle at which the skull reaches head-space height `y` at angle `theta`. */
  phiAt(theta: number, y: number, guess?: number): number {
    if (guess !== undefined) {
      // Newton from a nearby answer (the skull's height falls steadily with the polar angle).
      let phi = guess;
      for (let i = 0; i < 6; i++) {
        const y0 = skull(theta, phi, this.s, _s3).y;
        const dy = (skull(theta, phi + 1e-4, this.s, _s3).y - y0) / 1e-4;
        if (!(dy < -1e-4)) break;
        const step = THREE.MathUtils.clamp((y0 - y) / dy, -0.15, 0.15);
        phi -= step;
        if (Math.abs(step) < 1e-7) return phi;
      }
      if (phi > 0 && phi < Math.PI && Math.abs(skull(theta, phi, this.s, _s3).y - y) < 1e-6) return phi;
    }
    let lo = 0;
    let hi = Math.PI;
    const p = _s3;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      skull(theta, mid, this.s, p);
      if (p.y > y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

}


const BODY_UV: [number, number] = [0.02, 0.5];

/**
 * Head weights: the head, the lower lip and chin on the jaw (the switch happens inside the mouth
 * crease, so opening the jaw parts the lips cleanly), the mouth corners on their bones and the
 * upper eyelids on the lids bone.
 */
export function faceWeights(p: THREE.Vector3, f: FaceLayout, lids?: Lids): Weights {
  const x = p.x;
  const y = p.y - HEAD_Y;
  const z = p.z;
  const ax = Math.abs(x);
  const lat = smoothstep(f.mouthW * 0.8, f.mouthW * 1.7, ax);
  // Inside the mouth the switch is a narrow band right on the mouth line (whose stretch, painted as
  // the inside of the mouth, is what shows when the jaw opens); out on the cheeks it's broad.
  const hi = lerp(f.mouthY + 0.00035, f.mouthY - 0.004, lat);
  const lo = lerp(f.mouthY - 0.00035, f.mouthY - 0.02, lat);
  const jaw = smoothstep(hi, lo, y) * smoothstep(-0.04, 0.03, z) * (1 - smoothstep(0.06, 0.085, ax));
  const cl = Math.exp(-(((x - f.mouthW) / 0.012) ** 2 + ((y - f.mouthY) / 0.012) ** 2)) * 0.8 * smoothstep(0.0, 0.05, z);
  const cr = Math.exp(-(((x + f.mouthW) / 0.012) ** 2 + ((y - f.mouthY) / 0.012) ** 2)) * 0.8 * smoothstep(0.0, 0.05, z);
  // The upper lid turns by a different fraction of the blink at each point across the eye. Linear
  // skinning between a turned and an unturned bone would cut the chord inside the eyeball, so the
  // fraction is split between three lid bones turning by graded amounts (see LID_LEVELS).
  const n = lids && z > 0.03 ? lidWeight(ax, y, f, lids) : 0;
  const scale = 1 - cl - cr;
  if (n <= 0) return [BI.head, scale * (1 - jaw), BI.jaw, scale * jaw, BI.mouthL, cl, BI.mouthR, cr];
  let lv = 0;
  while (lv < 2 && n > LID_LEVELS[lv + 1]) lv++;
  const t = (n - LID_LEVELS[lv]) / (LID_LEVELS[lv + 1] - LID_LEVELS[lv]);
  const lidBones = [BI.head, BI.lidsE, BI.lidsM, BI.lids];
  const rest = lv === 0 ? scale * (1 - t) : 0;
  return [BI.head, rest * (1 - jaw), BI.jaw, rest * jaw, BI.mouthL, cl, BI.mouthR, cr,
    lidBones[lv], lv === 0 ? 0 : (1 - t) * scale, lidBones[lv + 1], t * scale];
}

/** How far each lid bone turns, as a fraction of the lids bone's blink: head, edge, middle, centre. */
export const LID_LEVELS = [0, 0.2, 0.55, 1];

export interface BodyBuckets {
  garment: Bucket;
  /** Footwear (taken off to bathe). */
  shoes: Bucket;
  /** Bare feet (shown only when the shoes are off). */
  feet: Bucket;
  /** The unclothed body (torso, arms, legs), shown only when the clothes are off. */
  bare: Bucket;
  /** Headwear, kept apart so it can stay on (a hood or veil hides cut hair) when the clothes come off. */
  hat: Bucket;
  skin: Bucket;
  hair: Bucket;
  eye: Bucket;
  metal: Bucket;
}

/** Lip colour for a skin tone: deeper and rosier than the skin, never painted-on red. */
export function lipColor(skin: THREE.Color, female: boolean): THREE.Color {
  const lum = skin.r * 0.3 + skin.g * 0.55 + skin.b * 0.15;
  const rose = col(female ? '#b45a58' : '#a4605a');
  // Darker skin keeps more of the rose (otherwise the lips vanish into the face).
  const k = (female ? 0.5 : 0.36) * lerp(0.8, 1, smoothstep(0.04, 0.4, lum));
  return mixCol(shade(skin, lerp(0.8, 0.88, smoothstep(0.04, 0.4, lum))), rose, k);
}

/** Simple deterministic random numbers from a look (so a Kynd's brows are always the same). */
function lookRandom(look: FullAppearance, salt: number): () => number {
  let h = 2166136261 ^ salt;
  for (const ch of `${look.sex}|${look.skin}|${look.jaw}|${look.nose}|${look.browShape}|${look.eyeShape}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let s = (h >>> 0) || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    s = (s ^ (s >>> 16)) >>> 0;
    return s / 4294967296;
  };
}

export function buildHead(B: BodyBuckets, head: Head, C: Palette, look: FullAppearance, stage: LifeStage): void {
  const f = head.f;
  const L = head.lids;
  const warp = head.warp;
  const female = head.s.female;
  const tmp = new THREE.Vector3();
  const blush = ((female ? 0.55 : 0.32) + (stage === 'child' ? 0.3 : 0)) * (0.35 + (look.cheekbones ?? 0.5) * 1.0);
  const lipC = lipColor(C.skin, female);
  const flush = col('#ff8a80');
  const g2 = (dx: number, dy: number, sx: number, sy: number) => Math.exp(-((dx / sx) ** 2 + (dy / sy) ** 2));
  // Skin colour per vertex: warm blush zones, rosier nose and ears, a faint shade on the lids and
  // a darker lash line, and pink mucosa inside the lids and at the tear duct. Fine detail (lip
  // border, creases, wrinkles, stubble) comes from the shared face texture.
  const skinPaint = (p: THREE.Vector3): Paint => {
    const x = p.x;
    const ax = Math.abs(x);
    const y = p.y - HEAD_Y;
    if (p.z <= 0) return { c: C.skin, c2: lipC };
    let k = 0;
    // Cheeks: a broad soft warmth with a rosier heart over the cheekbone.
    k += blush * 0.42 * g2(ax - 0.041, y - (f.eyeY - 0.04), 0.017, 0.015);
    k += blush * 0.22 * g2(ax - 0.044, y - (f.eyeY - 0.036), 0.03, 0.026);
    k += (0.16 + blush * 0.12) * g2(x, y - f.noseTipY, 0.012, 0.009);
    k += 0.1 * g2(x, y - f.chinY, 0.016, 0.012);
    k += 0.06 * g2(x, y - (f.eyeY + 0.045), 0.04, 0.02);
    const c = C.skin.clone().multiply(new THREE.Color(1, 1, 1).lerp(flush, Math.min(0.6, k) * 0.6));
    // Cooler, a shade deeper: under the eyes (more with age) and, on a grown man, the shaven jaw.
    const grown = stage === 'child' ? 0 : 1;
    let cool = (0.05 + head.s.age * 0.08) * grown * g2(ax - f.eyeX * 0.95, y - (f.eyeY - 0.017), 0.013, 0.006);
    if (!female) cool += 0.09 * grown * smoothstep(f.mouthY + 0.012, f.mouthY - 0.004, y) * smoothstep(0.075, 0.02, ax) * smoothstep(f.chinY - 0.03, f.chinY, y);
    c.lerp(mixCol(C.skinDark, col('#7b7a86'), 0.3), Math.min(0.3, cool));
    const e = eyeParam(ax, y, f, L);
    if (e) {
      const upper = e.e > (L.up(e.a) + L.lo(e.a)) / 2;
      if (upper) {
        // A touch of colour on the lid, darkest at the lash line.
        c.lerp(C.skinDark, 0.1 * smoothstep(L.crease + 0.003, 0, e.dUp));
        c.lerp(C.lash, 0.55 * smoothstep(0.0011, 0.00015, e.dUp) * smoothstep(-0.0012, -0.0001, e.dUp) * smoothstep(0.003, 0, e.dCorner));
      }
      // Wet pink tissue inside the opening and at the inner corner.
      const inside = smoothstep(0.0003, -0.0009, e.d);
      const duct = Math.exp(-(((e.a - (EYE_IN + 0.1)) / 0.13) ** 2));
      c.lerp(mixCol(lipC, col('#e8a09a'), 0.4), Math.max(inside * 0.65, duct * smoothstep(0.0012, -0.0004, e.d) * 0.8));
    }
    return { c, c2: lipC };
  };

  // Skin: the head, one continuous surface from crown to throat. Rows of constant height across
  // the face come from the canonical face layout (dense round features), warped onto this face.
  const wF = (th: number) => smoothstep(1.35, 0.85, Math.abs(th));
  const front = new Map<number, number>();
  const phiOf = (th: number, y: number) => {
    let pf = front.get(y);
    if (pf === undefined) {
      pf = head.phiAt(0, y);
      front.set(y, pf);
    }
    const w = wF(th);
    return w > 0 ? lerp(pf, head.phiAt(th, y, pf), w) : pf;
  };
  type Row = { us: number[]; v: number; kind: 0 | 1 | 2; yc: number; frac: number };
  const ring = (n: number) => range(-Math.PI, Math.PI, n);
  const nP = new THREE.Vector3(), nA = new THREE.Vector3(), nB = new THREE.Vector3();
  const rows: Row[] = [{ us: [0], v: 0, kind: 0, yc: FACE_ROW_HIGH, frac: 0 }];
  for (const [frac, n] of [[0.3, 14], [0.55, 22], [0.78, 30]]) rows.push({ us: ring(n), v: 0, kind: 0, yc: FACE_ROW_HIGH, frac });
  for (const r of faceRows()) rows.push({ us: r.us, v: 0, kind: 1, yc: r.y, frac: 0 });
  for (const [frac, n] of [[0.16, 60], [0.36, 40], [0.6, 26], [0.82, 14]]) rows.push({ us: ring(n), v: 0, kind: 2, yc: FACE_ROW_LOW, frac });
  rows.push({ us: [0], v: 0, kind: 2, yc: FACE_ROW_LOW, frac: 1 });
  rows.forEach((r, i) => (r.v = i));
  // The mouth: the two rows either side of the mouth line meet on it across the lips (so closed
  // lips show no gap), the upper going with the head and the lower with the jaw, and the strip
  // between them is left open: parting the lips opens onto the mouth inside, not a stretched skin.
  const mouthRow = rows.findIndex((r, i) => r.kind === 1 && rows[i + 1]?.kind === 1 && r.yc > CANON.mouthY && rows[i + 1].yc <= CANON.mouthY);
  const mouthLine = warp.y(CANON.mouthY);
  const closing = (x: number) => smoothstep(f.mouthW * 1.45, f.mouthW * 1.05, Math.abs(x));
  const rowY = (v: number, th: number): number => {
    const r = rows[v];
    const y = warp.y(r.yc);
    if (v !== mouthRow && v !== mouthRow + 1) return y;
    head.point(th, phiOf(th, y), tmp);
    return lerp(y, mouthLine, closing(tmp.x));
  };
  const jawSide = new THREE.Vector3();
  rowMesh(B.skin, {
    rows,
    at: (tc, v, out) => {
      const r = rows[v];
      const th = warp.theta(tc, r.yc);
      if (r.kind === 1) {
        const y = rowY(v, th);
        head.point(th, phiOf(th, y), tmp);
      } else {
        const end = phiOf(th, warp.y(r.yc));
        head.point(th, r.kind === 0 ? r.frac * end : lerp(end, Math.PI, r.frac), tmp);
      }
      hp(tmp.x, tmp.y, tmp.z, out);
    },
    paint: (_u, _v, p) => skinPaint(p),
    // The rows meeting on the mouth line are weighted as if just above and below it.
    weights: (p, _u, v) => (v === mouthRow || v === mouthRow + 1
      ? faceWeights(jawSide.copy(p).setY(p.y + (v === mouthRow ? 0.0006 : -0.0006) * closing(p.x)), f, L)
      : faceWeights(p, f, L)),
    gap: (r, x) => r === mouthRow && Math.abs(x) < f.mouthW * 1.02,
    normal: (tc, v, out) => {
      // The true surface's normal, from its two tangents at this sample.
      const r = rows[v];
      const th = warp.theta(tc, r.yc);
      const phi = r.kind === 1 ? phiOf(th, rowY(v, th)) : r.kind === 0 ? r.frac * phiOf(th, warp.y(r.yc)) : lerp(phiOf(th, warp.y(r.yc)), Math.PI, r.frac);
      if (phi < 0.02 || phi > Math.PI - 0.02) return false;
      const e = 2e-4;
      head.point(th, phi, nP);
      head.point(th + e, phi, nA).sub(nP);
      head.point(th, phi + e, nB).sub(nP);
      out.crossVectors(nA, nB);
      return out.lengthSq() > 1e-18;
    },
    uv: (tc, v) => {
      const r = rows[v];
      const yc = r.kind === 1 ? r.yc : r.kind === 0 ? r.yc + (1 - r.frac) * 0.05 : r.yc - r.frac * 0.03;
      return [faceU(tc), faceV(yc)];
    },
  });

  buildMouth(B, head, lipC);

  // Neck, from inside the collar up into the head.
  grid(B.skin, {
    us: around(18),
    vs: range(1.43, HEAD_Y + 0.07, 8),
    wrapU: true,
    flip: true,
    at: (theta, y, out) => {
      const r = neckRadius(head.s, y);
      return out.set(Math.sin(theta) * r, y, Math.cos(theta) * r * 1.02 + neckZ(y));
    },
    paint: () => ({ c: shade(C.skin, 0.97), c2: lipC }),
    weights: (p) => {
      const n = smoothstep(1.47, 1.53, p.y);
      const h = smoothstep(1.57, 1.63, p.y);
      return [BI.spine, 1 - n, BI.neck, n * (1 - h), BI.head, n * h];
    },
    uv: () => BODY_UV,
  });

  buildEars(B, head, C, stage, lipC);

  // Eyes: the eyeball carries its iris colour; the eye shader draws the pupil, the iris's fibres
  // and limbal ring, an off-white sclera shaded under the lid, and the catch-light.
  const scleraTag = stage === 'elder' ? 20 : 10;
  const IRIS = 0.53;
  for (const s of [-1, 1] as const) {
    const c = hp(s * f.eyeX, f.eyeY, f.eyeZ);
    const bone = s === 1 ? BI.eyeL : BI.eyeR;
    grid(B.eye, {
      us: around(36),
      vs: [0, 0.12, 0.24, 0.36, 0.46, 0.55, 0.62, 0.7, 0.8, 0.95, 1.12, 1.32, 1.6, 2.0, 2.5, Math.PI],
      wrapU: true,
      at: (u, a, out) => {
        // The cornea bulges a little over the iris.
        const bulge = a < IRIS ? 1 + 0.055 * Math.pow(Math.cos((a / IRIS) * Math.PI * 0.5), 1.5) : 1;
        const r = f.eyeR * bulge;
        return out.set(c.x + Math.sin(a) * Math.cos(u) * r, c.y + Math.sin(a) * Math.sin(u) * r, c.z + Math.cos(a) * r);
      },
      paint: () => ({ c: C.iris }),
      weights: () => [bone, 1],
      uv: (u, a) => [scleraTag + Math.sin(a) * Math.cos(u) * s, Math.sin(a) * Math.sin(u)],
    });
  }

  // Lashes: a fine dark line along each upper lid with curling lashes rooted on it (longer toward
  // the outer corner), and a few short lower lashes.
  const rand = lookRandom(look, 11);
  for (const s of [-1, 1] as const) {
    const c = new THREE.Vector3(s * f.eyeX, f.eyeY, f.eyeZ);
    const onLid = (a: number, e: number, r: number, out = new THREE.Vector3()) =>
      out.set(c.x + s * Math.sin(a) * r, c.y + Math.cos(a) * Math.sin(e) * r, c.z + Math.cos(a) * Math.cos(e) * r);
    const wAt = (p: THREE.Vector3) => faceWeights(hp(p.x, p.y, p.z, new THREE.Vector3()), f, L);
    // Lash line.
    const line: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = lerp(EYE_IN + 0.06, EYE_OUT - 0.02, i / 10);
      line.push(hp(...onLid(a, L.up(a) + 0.012, L.rho - 0.00005).toArray()));
    }
    tube(B.hair, new Path(line, 24), {
      radius: (t) => {
        const k = capsuleR(t, 0.08, 0.12) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15)));
        return [(female ? 0.00078 : 0.00066) * k, (female ? 0.0005 : 0.00042) * k];
      },
      paint: () => ({ c: C.lash }),
      weights: (p) => faceWeights(p, f, L),
      seg: 5,
      steps: 16,
    });
    const strand = (a: number, e: number, len: number, upDir: number, flare: number, w: number, color: THREE.Color) => {
      const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e);
      const n = new THREE.Vector3(s * sa, ca * se, ca * ce);
      const up = new THREE.Vector3(0, ce, -se).multiplyScalar(upDir);
      const lat = new THREE.Vector3(s * ca, -sa * se, -sa * ce);
      const root = onLid(a, e, L.rho - 0.0001);
      const d0 = n.clone().multiplyScalar(0.85).addScaledVector(up, 0.18).addScaledVector(lat, flare).normalize();
      const d1 = n.clone().multiplyScalar(0.08).addScaledVector(up, 1).addScaledVector(lat, flare * 1.5).normalize();
      const p1 = root.clone().addScaledVector(d0, len * 0.45);
      const p2 = p1.clone().addScaledVector(d0.clone().add(d1).normalize(), len * 0.35);
      const p3 = p2.clone().addScaledVector(d1, len * 0.3);
      const W = wAt(root);
      tube(B.hair, new Path([root, p1, p2, p3].map((p) => hp(p.x, p.y, p.z)), 8), {
        radius: (t) => [w * (1 - t * 0.85), w * (1 - t * 0.85)],
        paint: () => ({ c: color }),
        weights: () => W,
        seg: 3,
        steps: 4,
      });
    };
    // Upper lashes, in little clumps whose tips gather.
    const nUp = female ? 30 : 18;
    let clump = 0;
    for (let i = 0; i < nUp; i++) {
      if (i % 3 === 0) clump = (rand() - 0.5) * 0.25;
      const t = (i + 0.2 + rand() * 0.6) / nUp;
      const a = lerp(EYE_IN + 0.17, EYE_OUT - 0.05, t);
      const len = (female ? 0.0038 : 0.0025) * (0.42 + 0.58 * Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.94))) * (0.78 + rand() * 0.4) * (1 - head.s.age * 0.25);
      strand(a, L.up(a) + 0.018, len, 1, (t - 0.42) * 0.75 + clump, (female ? 0.00016 : 0.00013) * (0.85 + rand() * 0.3), C.lash);
    }
    // Lower lid margin: a fine rounded rim (the lid's thickness), with sparse short lashes.
    const rim: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = lerp(EYE_IN + 0.05, EYE_OUT - 0.02, i / 12);
      rim.push(hp(...onLid(a, L.lo(a) - 0.012, L.rho - 0.0002).toArray()));
    }
    const rimC = mixCol(mixCol(C.skin, lipC, 0.3), C.skinDark, 0.15);
    tube(B.skin, new Path(rim, 24), {
      radius: (t) => {
        const k = capsuleR(t, 0.1, 0.1) * (0.5 + 0.5 * Math.sin(Math.PI * t));
        return [0.00048 * k, 0.00042 * k];
      },
      paint: () => ({ c: rimC, c2: lipC }),
      weights: () => [BI.head, 1],
      uv: () => BODY_UV,
      seg: 6,
      steps: 18,
    });
    const nLo = female ? 13 : 10;
    const loC = mixCol(C.lash, C.skin, 0.3);
    for (let i = 0; i < nLo; i++) {
      const t = (i + 0.2 + rand() * 0.6) / nLo;
      const a = lerp(EYE_IN + 0.38, EYE_OUT - 0.1, t);
      strand(a, L.lo(a) - 0.04, 0.0017 * (0.6 + rand() * 0.6) * (0.6 + 0.4 * t), -1, (t - 0.35) * 0.7, 0.0001, loC);
    }
  }

  // Brows: a soft band of brow colour following the ridge, with individual hair strokes over
  // it: rising at the inner end, sweeping outward along the arch, converging on the tail.
  for (const s of [-1, 1] as const) {
    const rb = lookRandom(look, s === 1 ? 23 : 29);
    const lift = head.s.female ? 0.004 : 0;
    const curve = (t: number, out = new THREE.Vector3()) => {
      const x = lerp(f.eyeX - 0.022, f.eyeX + 0.029, t);
      const y = f.eyeY + 0.022 + look.browShape * 0.005 + lift * Math.sin(t * Math.PI * 0.9) + Math.sin(t * Math.PI) * (0.001 + look.browShape * 0.011) - t * 0.003 + head.s.age * 0.0015 * t;
      return out.set(x, y, 0);
    };
    const th = (head.s.female ? 0.0024 : 0.0034) * (1.3 - look.browShape * 0.6) * (1 - head.s.child * 0.15);
    const half = (t: number) => th * (1.15 - t * 0.6) * capsuleR(t, 0.14, 0.3);
    const bone = s === 1 ? BI.browL : BI.browR;
    const surf = (x: number, y: number, lift2: number) => hp(s * x, y, head.frontZ(x, y) + lift2);
    const tan = new THREE.Vector3();
    const nrm2 = new THREE.Vector3();
    const frame = (t: number) => {
      const a = curve(Math.max(0, t - 0.01));
      const b = curve(Math.min(1, t + 0.01));
      tan.subVectors(b, a).normalize();
      nrm2.set(-tan.y, tan.x, 0);
    };
    // The band (a ribbon whose strand texture runs along the brow).
    grid(B.hair, {
      us: range(0, 1, 18),
      vs: [-1, -0.5, 0, 0.5, 1],
      at: (t, v, out) => {
        frame(t);
        const p = curve(t);
        const x = p.x + nrm2.x * v * half(t);
        const y = p.y + nrm2.y * v * half(t);
        return out.copy(surf(x, y, 0.0004 * (1 - v * v * 0.6)));
      },
      paint: (t, v) => ({ c: mixCol(C.brow, C.skin, 0.25 + Math.abs(v) * 0.25 + smoothstep(0.75, 1, t) * 0.2) }),
      weights: () => [bone, 1],
      uv: (t, v) => [v * 0.15, t * 1.6],
      flip: s === 1,
    });
    const n = head.s.female ? 64 : 82;
    for (let i = 0; i < n; i++) {
      const t = Math.pow(rb(), 0.9);
      const v = (rb() * 2 - 1) * 0.95;
      frame(t);
      const p = curve(t);
      const hw = half(t);
      if (hw < 0.0003) continue;
      const rx = p.x + nrm2.x * v * hw;
      const ry = p.y + nrm2.y * v * hw;
      // Direction: up at the head of the brow, outward along the arch, converging to the middle.
      const ang = lerp(1.25, 0.06, smoothstep(0.02, 0.32, t)) - v * 0.32 + (rb() - 0.5) * 0.3;
      const dirX = tan.x * Math.cos(ang) - tan.y * Math.sin(ang);
      const dirY = tan.x * Math.sin(ang) + tan.y * Math.cos(ang);
      const len = (0.0034 + rb() * 0.0022) * (t < 0.15 ? 0.75 : 1);
      const w = (head.s.female ? 0.00028 : 0.00034) * (0.8 + rb() * 0.4);
      const pts = [0, 0.5, 1].map((k) => surf(rx + dirX * len * k, ry + dirY * len * k, 0.00055 + Math.sin(k * Math.PI) * 0.0003));
      const path = new Path(pts, 6);
      const side = new THREE.Vector3(-dirY * s, dirX, 0).normalize();
      grid(B.hair, {
        us: [-1, 1],
        vs: [0, 0.34, 0.67, 1],
        at: (u, k, out) => path.point(k, out).addScaledVector(side, u * w * (1 - k * 0.8)),
        paint: () => ({ c: mixCol(C.brow, C.hairDark, 0.25 + rb() * 0.15) }),
        weights: () => [bone, 1],
        uv: (u, k) => [u * 0.02 + i * 0.13, k * 0.3],
        flip: s === -1,
      });
    }
  }
}


/** Outline radius of the ear round its concha, by angle (0 toward the face, π/2 up). */
function earOutline(phi: number): number {
  return 0.0225 - 0.0065 * Math.cos(phi) + 0.0005 * Math.sin(phi) - 0.007 * Math.cos(2 * phi) - 0.002 * Math.sin(2 * phi);
}

/** Smooth window over an angle range (radians, increasing, may pass 2π). */
function arc(phi: number, a: number, b: number, soft = 0.3): number {
  let p = phi;
  while (p < a - soft * 2) p += Math.PI * 2;
  return smoothstep(a - soft, a + soft, p) * smoothstep(b + soft, b - soft, p);
}

/**
 * Ears: a shell round the concha with the helix rolling over its rim, the antihelix and its crura,
 * the scapha between them, tragus and antitragus guarding the concha, and a soft lobe. The back of
 * the ear curves round into the head, so it grows out of the skin instead of sitting on it.
 */
function buildEars(B: BodyBuckets, head: Head, C: Palette, stage: LifeStage, lipC: THREE.Color): void {
  const s0 = head.s;
  const size = (stage === 'elder' ? 1.07 : 1) * (1 - s0.child * 0.06) * 0.94;
  const yC = (head.f.eyeY + head.f.noseBaseY) / 2 - 0.004;
  const flush = C.skin.clone().multiply(col('#ffc4b4'));
  // Front surface relief (outward), by angle and normalised radius.
  const relief = (phi: number, r: number): number => {
    const front = Math.exp(-((Math.atan2(Math.sin(phi), Math.cos(phi)) / 0.75) ** 2));
    let h = (0.0011 + r * (0.0016 + 0.0034 * Math.max(0, -Math.cos(phi)))) * (1 - front * 0.6);
    h -= 0.0042 * (1 - smoothstep(0.16, 0.5, r)) * (1 - 0.35 * arc(phi, 0.6, 2.2));
    h += 0.0024 * Math.exp(-(((r - 0.6) / 0.1) ** 2)) * arc(phi, 1.0, 4.2);
    h += 0.0015 * Math.exp(-(((r - 0.56) / 0.09) ** 2)) * arc(phi, 0.45, 1.25, 0.25);
    h -= 0.0009 * Math.exp(-(((r - 0.79) / 0.065) ** 2)) * arc(phi, 0.75, 4.2);
    h += 0.0019 * Math.exp(-(((r - 0.95) / 0.06) ** 2)) * arc(phi, 0.3, 4.5);
    h += 0.0015 * Math.exp(-(((r - 0.36) / 0.1) ** 2)) * Math.exp(-(((phi - 0.55) / 0.28) ** 2));
    h += 0.003 * Math.exp(-(((r - 0.82) / 0.16) ** 2) - ((Math.atan2(Math.sin(phi), Math.cos(phi)) - 0.05) / 0.34) ** 2);
    h += 0.002 * Math.exp(-(((r - 0.62) / 0.1) ** 2) - ((phi - 4.05) / 0.25) ** 2);
    h += 0.0012 * arc(phi, 4.35, 5.35) * smoothstep(0.4, 0.85, r);
    return h;
  };
  // Ring rows: the front surface (v ≤ 1), the helix roll, then the back of the ear into the head.
  const vs = [0, 0.1, 0.2, 0.3, 0.38, 0.45, 0.51, 0.56, 0.6, 0.64, 0.69, 0.74, 0.79, 0.84, 0.88, 0.92, 0.955, 0.985, 1.0, 1.06, 1.13, 1.24, 1.42, 1.66, 2.0];
  for (const s of [-1, 1] as const) {
    const th = s * (Math.PI / 2 + 0.1);
    const base = head.shell(th, head.phiAt(th, yC), 0, new THREE.Vector3());
    // The ear's long axis leans back; its back edge stands off the head.
    const tilt = 0.26;
    // The ear plane follows the head as it narrows toward the back, so the back edge lies close
    // to the skull instead of floating off it like a petal.
    const flare = -0.12;
    const up = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
    const fwd0 = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
    const out0 = new THREE.Vector3(s, 0, 0);
    const fwd = fwd0.clone().multiplyScalar(Math.cos(flare)).addScaledVector(out0, -Math.sin(flare));
    const out = out0.clone().multiplyScalar(Math.cos(flare)).addScaledVector(fwd0, Math.sin(flare));
    const centre = base.clone().addScaledVector(out0, 0.0024).addScaledVector(fwd0, 0.001);
    const at = (phi: number, r: number, h: number, o: THREE.Vector3) => {
      const R = earOutline(phi) * size;
      o.copy(centre).addScaledVector(fwd, Math.cos(phi) * R * r).addScaledVector(up, Math.sin(phi) * R * r).addScaledVector(out, h);
      return hp(o.x, o.y, o.z, o);
    };
    grid(B.skin, {
      us: around(44),
      vs,
      wrapU: true,
      flip: s === 1,
      at: (phi, v, o) => {
        const rimH = relief(phi, 1);
        if (v <= 1) return at(phi, v, relief(phi, v), o);
        if (v <= 1.13) {
          // The helix rolls over and back.
          const k = (v - 1) / 0.13;
          return at(phi, 1 + Math.sin(k * Math.PI) * 0.035 - k * 0.02, rimH - (1 - Math.cos(k * Math.PI)) * 0.0011, o);
        }
        // The back of the ear sweeps into a broad root along its front edge (where a real ear
        // joins the head), sinking into the skin so it grows out of the head, not off a stalk.
        const k = (v - 1.13) / 0.87;
        const R = earOutline(phi) * size;
        const rootShift = 0.42 * smoothstep(0, 1, k);
        const p0 = at(phi, lerp(0.98, 0.62, k), lerp(rimH - 0.0022, -0.0085, Math.pow(k, 0.7)), o);
        // Pull the root toward the face side of the concha.
        const shift = fwd.clone().multiplyScalar(R * rootShift * (1 - 0.5 * Math.cos(phi)));
        const sh = hp(centre.x + shift.x, centre.y + shift.y, centre.z + shift.z, new THREE.Vector3()).sub(hp(centre.x, centre.y, centre.z, new THREE.Vector3()));
        return p0.add(sh);
      },
      paint: (phi, v) => {
        const rim = smoothstep(0.86, 0.96, Math.min(v, 2.1 - v));
        const lobe = arc(phi, 4.3, 5.4) * smoothstep(0.5, 0.9, Math.min(v, 1));
        const deep = v < 1 ? 1 - 0.32 * (1 - smoothstep(0.1, 0.45, v)) : 1;
        return { c: shade(mixCol(C.skin, flush, Math.max(rim * 0.75, lobe * 0.6, 0.2)), deep), c2: lipC };
      },
      weights: () => [BI.head, 1],
      uv: () => BODY_UV,
    });
  }
}


// --- hair ----------------------------------------------------------------------------------

export interface HairInfo {
  /** Hair thickness over the crown (hats sit on this). */
  crown: number;
  /** Is there a long fall of hair, braids or a bun behind (hoods and veils hide these)? */
  hasFall: boolean;
}

/** How much of each hairstyle a headwear leaves visible. */
export type HairCover = 'none' | 'hat' | 'coif' | 'hood' | 'veil' | 'band';

export function hairCrown(style: string): number {
  switch (style) {
    case 'shaved':
      return 0.002;
    case 'cropped':
      return 0.007;
    case 'curly':
      return 0.019;
    case 'short':
      return 0.012;
    case 'braid':
    case 'twin_braids':
    case 'bun':
      return 0.011;
    default:
      return 0.011;
  }
}

export function buildHair(B: BodyBuckets, head: Head, C: Palette, look: FullAppearance, cover: HairCover, m: Measure): void {
  const style = look.hairStyle;
  const female = look.sex === 'female';
  const crown = hairCrown(style);
  const tuck = cover === 'hood' || cover === 'veil';
  const pulled = style === 'braid' || style === 'twin_braids' || style === 'bun' || style === 'ponytail' || style === 'half_up';
  const longish = style === 'long' || style === 'wavy' || style === 'shoulder' || style === 'curly' || style === 'bob' || style === 'half_up';
  const coveredCrown = cover !== 'none' && cover !== 'band';
  // Hairline height around the head (head space): forehead, temples, sideburns, behind the ears, nape.
  const hairline = (theta: number): number => {
    const a = Math.abs(theta);
    const front = (female ? 0.197 : 0.195) + (pulled ? 0.004 : 0);
    const arch = female || pulled || longish;
    let y: number;
    if (a < 0.5) y = front - (a / 0.5) ** 2 * (arch ? 0.018 : 0.01) + Math.sin(theta * 22) * 0.0015;
    else if (a < 1.2) y = lerp(front - (arch ? 0.018 : 0.01), pulled || female ? 0.14 : 0.115, smoothstep(0.5, 1.2, a));
    else if (a < 1.8) {
      // Sideburn in front of the ear, then up and over it.
      const side = pulled || female ? 0.14 : 0.115;
      y = lerp(side, 0.148, smoothstep(1.25, 1.5, a)) - Math.exp(-(((a - 1.78) / 0.12) ** 2)) * 0.03;
    } else y = lerp(0.12, style === 'shaved' || style === 'cropped' ? 0.055 : pulled ? 0.018 : 0.04, smoothstep(1.8, pulled ? 3.1 : 2.7, a));
    // Longer styles cover the ears and frame the face.
    if (longish && a > 0.9 && a < 2.3) y -= 0.065 * Math.sin(((a - 0.9) / 1.4) * Math.PI);
    if (pulled && a > 1.2 && a < 2.0) y -= 0.02 * Math.sin(((a - 1.2) / 0.8) * Math.PI);
    return y;
  };
  // Where the hair parts (null: no part).
  const part = style === 'short' ? 0.42 : longish || pulled ? 0 : null;
  const thick = (theta: number, t: number): number => {
    let th = crown;
    const a = Math.abs(theta);
    const top = 1 - t; // 1 at the crown
    // Curls are a connected scalp surface. Volume converges at the crown and at the wrap seam.
    if (style === 'curly') th *= 1 + 0.18 * Math.sin(theta * 12 + t * 15) * Math.sin(t * 20) * smoothstep(0, 0.2, t);
    else if (style !== 'shaved') th *= 1 + 0.1 * Math.sin(theta * 16 + t * 3);
    // Volume on top, fuller at the back of the crown, sweeping out over the temples.
    if (style !== 'shaved' && style !== 'cropped') th *= 1 + 0.45 * Math.sin(Math.min(1, t * 1.6) * Math.PI) * (0.6 + 0.4 * Math.cos(theta)) * (pulled ? 0.4 : 1);
    if (style === 'short') th *= 1 + 0.5 * Math.exp(-(((theta - 0.1) / 0.45) ** 2)) * Math.sin(Math.min(1, t * 1.3) * Math.PI);
    if (longish && a > 0.9) th *= 1 + 0.5 * t;
    if (pulled) th *= a < 0.6 ? 1 : a < 1.9 ? 0.8 : 1 + 0.5 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.9);
    if (part !== null && style !== 'shaved') {
      const d = Math.abs(theta - part);
      th *= 1 - 0.45 * Math.exp(-((d / 0.07) ** 2)) * smoothstep(0.75, 0.2, t) * (top > 0 ? 1 : 1);
    }
    // Taper to the hairline: pulled-back hair lies flat at the forehead.
    // (At the nape short hair thins right down to the skin: no bowl's rim.)
    const edgeMin = style === 'shaved' ? 1 : pulled ? 0.08 : lerp(0.25, 0.05, smoothstep(1.7, 2.5, a));
    const edge = style === 'shaved' ? 1 : smoothstep(1.0, lerp(0.72, 0.55, smoothstep(1.7, 2.5, a) * (pulled ? 0 : 1)), t) * (1 - edgeMin) + edgeMin;
    const volume = lerp(crown, th * edge, smoothstep(0, 0.16, t));
    return coveredCrown ? Math.min(volume, 0.0035) : volume;
  };
  const thetas: number[] = [];
  for (let i = 0; i <= 40; i++) thetas.push(-Math.PI + (Math.PI * 2 * i) / 40);
  const phiEdge = new Map<number, number>();
  for (const th of thetas) phiEdge.set(th, head.phiAt(th, hairline(th)));
  const pe = (theta: number) => phiEdge.get(theta) ?? head.phiAt(theta, hairline(theta));
  const hairCol = (t: number, theta: number): THREE.Color => {
    if (style === 'shaved') return mixCol(C.hair, C.skin, 0.45);
    // Darker in the part and at the roots, a painted highlight band over the crown, and a soft
    // hairline where skin shows through.
    const band = Math.exp(-(((t - 0.36) / 0.11) ** 2)) * (0.55 + 0.45 * Math.cos(theta));
    let c = mixCol(C.hairDark, C.hair, 0.55 + Math.min(1, t * 1.3) * 0.45);
    c = mixCol(c, C.hairLight, band * 0.5);
    if (part !== null) c = mixCol(c, C.hairDark, Math.exp(-(((theta - part) / 0.05) ** 2)) * smoothstep(0.75, 0.2, t) * 0.7);
    if (falling(theta)) return c;
    c = mixCol(c, C.skin, smoothstep(0.86, 1.0, t) * 0.3);
    // Past the hairline, a fringe of fine hair thinning into the skin: the skin's own tone, shadowed
    // by the hair, so the hairline fades in instead of stopping at an edge.
    return t > 1 ? mixCol(c, mixCol(C.skin, C.hairDark, 0.18), smoothstep(1, FRINGE, t) * 0.85) : c;
  };
  const falling = (theta: number) => ['long', 'wavy', 'shoulder', 'bob', 'half_up'].includes(style) && !tuck && Math.abs(theta) > 0.94;
  // How far past the hairline the fringe runs (in hairline lengths from the crown), ragged.
  const FRINGE = 1.06;
  const reach = (theta: number, t: number) => (t <= 1 || style === 'shaved' || falling(theta) ? Math.min(t, 1) : 1 + (t - 1) * (0.6 + 0.22 * Math.sin(theta * 9 + 0.6) + 0.18 * Math.sin(theta * 5 + 2.1)));
  const tmp = new THREE.Vector3();
  grid(B.hair, {
    us: thetas,
    vs: [0, 0.04, 0.1, 0.18, 0.27, 0.36, 0.46, 0.56, 0.66, 0.75, 0.83, 0.9, 0.95, 1, 1.025, FRINGE],
    at: (theta, t, out) => {
      const tt = reach(theta, t);
      const phi = tt * pe(theta);
      // The fringe lies on the skin, thinning to nothing.
      const fringe = smoothstep(1, FRINGE, t);
      head.shell(theta, phi, t <= 1 ? thick(theta, t) + 0.0012 : lerp(thick(theta, 1) + 0.0012, 0.0006, fringe), tmp);
      return hp(tmp.x, tmp.y, tmp.z, out);
    },
    paint: (theta, t) => ({ c: hairCol(t, theta) }),
    weights: () => [BI.head, 1],
    uv: (theta, t) => [theta * 2.2, t * 1.4],
  });

  // Combed locks lying over the cap: thin tapered ribbons along the way the hair grows (back from
  // the hairline to the tie on pulled-back hair, out from the crown otherwise), each a shade of its
  // own, sunk a little into the cap so they read as relief rather than a smooth shell; at the nape
  // and round the ears their tips run on a little past the hairline, ragged.
  if (style !== 'shaved' && !coveredCrown) {
    const rnd = (k: number) => {
      const v = Math.sin(k * 127.1 + 311.7) * 43758.5453;
      return v - Math.floor(v);
    };
    const falling = ['long', 'wavy', 'shoulder', 'bob', 'half_up', 'curly'].includes(style);
    const N = style === 'cropped' ? 44 : 64;
    const p = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const row = i % 2;
      const th0 = -Math.PI + ((i + rnd(i) * 0.6) / N) * Math.PI * 2;
      const a = Math.abs(th0);
      // Locks over falling sheets would stand off them: those cover only the crown.
      // Over the forehead and temples they stop short of the hairline (which fades in on its own);
      // at the nape of short hair the tips run on past it, ragged.
      const nape = smoothstep(1.9, 2.6, a) * (pulled ? 0 : 1);
      const tEnd = falling && a > 0.9 ? 0.8 : lerp(0.93, style === 'cropped' ? 1.0 : 1.05 + rnd(i + 9) * 0.05, nape);
      const t0 = row ? 0.14 + rnd(i + 3) * 0.1 : 0.03 + rnd(i + 5) * 0.05;
      // A gentle sweep round the head (away from a parting), more on short hair.
      const sweep = (style === 'short' ? 0.35 : 0.12) * (part !== null && th0 < part ? -1 : 1) * (0.6 + rnd(i + 7) * 0.6);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 5; k++) {
        const t = lerp(t0, tEnd, k / 5);
        const th = th0 + sweep * Math.sin((k / 5) * Math.PI * 0.5) * (1 - t * 0.4);
        const tt = Math.min(t, 1.06);
        const lift = t <= 1 ? thick(th, Math.min(t, 1)) * 0.92 + 0.0012 : 0.0012;
        head.shell(th, tt * pe(th), lift, p);
        pts.push(hp(p.x, p.y, p.z));
      }
      const tone = mixCol(mixCol(C.hairDark, C.hair, 0.45 + rnd(i + 11) * 0.5), C.hairLight, rnd(i + 13) > 0.75 ? 0.3 : 0);
      const w = (style === 'cropped' ? 0.006 : 0.009) + rnd(i + 17) * 0.005;
      tube(B.hair, new Path(pts, 14), {
        // Drawn out to a fine point, and fading into the cap's own colour toward the hairline.
        radius: (t) => [0.0018 * capsuleR(t, 0.2, 0.6), w * (1 - t * 0.8) * capsuleR(t, 0.15, 0.6)],
        paint: (t) => ({ c: mixCol(mixCol(tone, C.hairLight, Math.exp(-(((t - 0.35) / 0.15) ** 2)) * 0.18), hairCol(Math.min(1, lerp(t0, tEnd, t)), th0), smoothstep(0.6, 1, t) * (1 - nape) * 0.8) }),
        weights: () => [BI.head, 1],
        seg: 5,
        steps: 9,
      });
    }
  }

  const lockPaint = (t: number): Paint => ({ c: mixCol(mixCol(C.hairDark, C.hair, 0.75), C.hairLight, Math.max(0, 0.5 - Math.abs(t - 0.4)) * 0.7) });
  // Locks that break up the silhouette: a swept fringe for short hair, loose curls, strands framing
  // the face for long hair.
  const lock = (th0: number, t0: number, th1: number, t1: number, th2: number, t2: number, width: number, depth: number, lift = 1) => {
    const a = head.shell(th0, pe(th0) * t0, thick(th0, t0) * lift + 0.001, new THREE.Vector3());
    const b = head.shell(th1, pe(th1) * t1, thick(th1, t1) * lift + depth * 0.5, new THREE.Vector3());
    const c = head.shell(th2, pe(th2) * t2, depth * 0.3 + 0.001, new THREE.Vector3());
    const path = new Path([hp(a.x, a.y, a.z), hp(b.x, b.y, b.z), hp(c.x, c.y, c.z)], 12);
    tube(B.hair, path, {
      radius: (t) => [depth * capsuleR(t, 0.25, 0.7), width * (1 - t * 0.55) * capsuleR(t, 0.2, 0.5)],
      paint: (t) => lockPaint(t),
      weights: () => [BI.head, 1],
      seg: 7,
      steps: 12,
    });
  };
  if (style === 'short' && !coveredCrown) {
    for (let i = 0; i < 4; i++) {
      const th = lerp(-0.5, 0.3, i / 3);
      lock(th + 0.35, 0.3, th + 0.05, 0.78, th - 0.25, 1.04, 0.022, crown * 0.7);
    }
  }
  if ((style === 'shoulder' || style === 'long' || style === 'wavy' || style === 'bob') && !coveredCrown) {
    // Face-framing strands falling from the part past the temples.
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        lock(s * (0.1 + i * 0.1), 0.22 + i * 0.065,
          s * (0.62 + i * 0.17), 0.77 + i * 0.035,
          s * (0.94 + i * 0.16), 1.1 + i * 0.025,
          0.012 + i * 0.0015, crown * (0.44 + i * 0.04));
      }
    }
  }
  if (style === 'curly' && !coveredCrown) {
    // Shallow swept ribbons follow the skull instead of disconnected spherical bubbles.
    for (let i = 0; i < 18; i++) {
      const th = -Math.PI + (i + 0.5) * Math.PI * 2 / 18;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 8; j++) {
        const t = 0.22 + j / 8 * 0.7;
        const angle = th + Math.sin(t * 12 + i * 0.7) * 0.09;
        const p = head.shell(angle, pe(angle) * t, thick(angle, t) + 0.001, new THREE.Vector3());
        pts.push(hp(p.x, p.y, p.z));
      }
      tube(B.hair, new Path(pts, 20), {
        radius: (t) => [0.0035 * capsuleR(t, 0.18, 0.22), 0.002 * capsuleR(t, 0.18, 0.22)],
        paint: () => ({ c: mixCol(C.hair, C.hairLight, 0.14) }), weights: () => [BI.head, 1], seg: 5, steps: 12,
      });
    }
  }

  const neckAt = (p: THREE.Vector3) => {
    const y = p.y - HEAD_Y;
    const s = smoothstep(0.0, -0.13, y);
    const bone = p.z < -0.07 ? BI.hairBack : p.x > 0 ? BI.hairL : BI.hairR;
    return [BI.head, 1 - s, bone, s];
  };

  // Loose hair falling behind: a thick sheet with clumped, uneven ends.
  if ((style === 'long' || style === 'wavy' || style === 'shoulder' || style === 'bob' || style === 'half_up') && !tuck) {
    const len = style === 'bob' ? 0.005 : style === 'shoulder' ? -0.07 : female ? -0.36 : -0.3;
    const span = style === 'shoulder' ? 2.1 : 2.2;
    const us = range(-span, span, 44);
    const clump = (u: number) => Math.pow(Math.sin(u * 7.5) * 0.5 + 0.5, 1.5);
    const wave = style === 'wavy' || style === 'half_up' ? 1 : 0;
    const endY = (u: number) => {
      const side = smoothstep(1.95, 1.2, Math.abs(u)); // sides are shorter
      const base = style === 'bob' ? 0.018 + side * 0.008 : style === 'shoulder' ? len : lerp(len, -0.06, side);
      return base - clump(u) * 0.016 - Math.sin(u * 4.3) * 0.01;
    };
    const topRadius = new Map<number, number>();
    const at = (u: number, t: number, inner: boolean, out: THREE.Vector3) => {
      const th = Math.PI - u;
      const top = 0.15;
      const y = lerp(top, endY(u), t);
      // The sheet hangs from the widest part of the skull, then flares over the back and shoulders.
      let r0 = topRadius.get(u);
      if (r0 === undefined) {
        head.shell(th, head.phiAt(th, 0.125), 0, tmp);
        r0 = Math.hypot(tmp.x, tmp.z);
        topRadius.set(u, r0);
      }
      const above = Math.max(0, y - 0.125);
      const rTop = r0 - above * above * 6;
      const flare = Math.max(0, 0.06 - y) * (0.2 + 0.28 * Math.abs(Math.sin(th))) + (wave ? (0.007 * Math.sin(y * 23 + u * 2) + 0.002 * Math.sin(y * 41 - u)) * smoothstep(0.1, -0.05, y) : 0);
      const flip = style === 'shoulder' ? smoothstep(0.7, 1, t) * (0.006 + clump(u) * 0.004) : 0;
      const vol = crown * 1.2 + 0.005 * clump(u) + flare + flip;
      let r = rTop + (inner ? vol * 0.3 : vol) * (1 - smoothstep(0.82, 1, t) * 0.6);
      // Feather the hanging sheet into the actual scalp surface. A fixed-radius
      // start left a square ledge beside the temples, especially under hats.
      const join = smoothstep(0, 0.2, t);
      if (join < 1) {
        const phi = head.phiAt(th, y);
        const cap = thick(th, phi / pe(th));
        head.shell(th, phi, cap - (inner ? 0.003 : 0.0008), tmp);
        r = lerp(Math.hypot(tmp.x, tmp.z), r, join);
      }
      // Preserve space for the ear rim even when a hat compresses crown volume.
      const earMask = smoothstep(0.055, 0.083, y) * smoothstep(0.16, 0.135, y)
        * smoothstep(0.85, 0.98, Math.abs(Math.sin(th)));
      const earClearance = 0.073 + head.s.width * 0.029 + (inner ? 0.015 : 0.019);
      r = Math.max(r, lerp(r, earClearance, earMask));
      // A padded torso/shoulder envelope keeps hanging hair outside clothes.
      // Lower strands are attached to spring bones on the torso, not the turning head.
      if (y < -0.025) {
        const shoulder = Math.exp(-(((y + 0.125) / 0.075) ** 2));
        const rx = (0.18 + shoulder * 0.065) * m.w;
        const rz = (look.outfit === 'surcoat' || look.outfit === 'gown' ? 0.185 : 0.16);
        const envelope = 1 / Math.sqrt((Math.sin(th) / rx) ** 2 + (Math.cos(th) / rz) ** 2) + (inner ? 0.008 : 0.014);
        r = Math.max(r, lerp(r, envelope, smoothstep(-0.025, -0.095, y)));
      }
      return out.set(Math.sin(th) * r, y + HEAD_Y, Math.cos(th) * r * (1 + 0.03 * join));
    };
    // Closed sheet: outer side −span→span, inner side back again.
    const loop = [...us.map((u) => ({ u, inner: false })), ...[...us].reverse().map((u) => ({ u, inner: true }))];
    grid(B.hair, {
      us: loop.map((_l, i) => i),
      vs: range(0, 1, 24),
      wrapU: true,
      flip: true,
      at: (i, t, out) => {
        const l = loop[Math.round(i)];
        return at(l.u, t, l.inner, out);
      },
      paint: (i, t) => {
        const l = loop[Math.round(i)];
        if (l.inner) return { c: shade(C.hairDark, 0.8) };
        return { c: mixCol(C.hairDark, C.hair, lerp(0.98, 0.65 + clump(l.u) * 0.35, smoothstep(0, 0.4, t))) };
      },
      weights: (p) => neckAt(p),
      uv: (i, t) => [loop[Math.round(i)].u * 3, t * 3],
    });
  }

  // Braids: interlaced lobes, tied off with a tuft.
  const braid = (pts: THREE.Vector3[], r0: number, lobes: number, weights: (p: THREE.Vector3, t: number) => Weights) => {
    const path = new Path(pts, 40);
    const endT = 0.93;
    for (let i = 0; i < lobes; i++) {
      const t0 = (i / lobes) * endT;
      const t1 = Math.min(endT + 0.01, ((i + 1.4) / lobes) * endT);
      const r = r0 * (1 - (t0 / endT) * 0.4);
      const side = i % 2 ? 1 : -1;
      const lobePath = new Path(
        [0, 0.33, 0.66, 1].map((q) => {
          const t = t0 + (t1 - t0) * q;
          // Alternate lobes lean left and right across the braid.
          return path.frame(t, 0, side * r * 0.35 * Math.sin(q * Math.PI), new THREE.Vector3());
        }),
        8,
      );
      tube(B.hair, lobePath, {
        radius: (t) => {
          const env = Math.sin(Math.max(0, Math.min(1, t)) * Math.PI);
          return [r * 0.72 * env, r * 0.95 * env];
        },
        paint: (t) => ({ c: mixCol(C.hairDark, C.hairLight, 0.3 + Math.sin(t * Math.PI) * 0.35) }),
        weights,
        seg: 7,
        steps: 6,
        uv: (t, th) => [th + side, t * 2],
      });
    }
    const tie = path.point(endT);
    ellipsoid(B.hair, tie, [r0 * 0.42, r0 * 0.32, r0 * 0.42], () => ({ c: shade(C.hairDark, 0.6) }), (p) => weights(p, endT), 8, 5);
    const end = path.point(1);
    const dir = end.clone().sub(tie).normalize();
    const tuft = new Path([tie, tie.clone().addScaledVector(dir, 0.025), tie.clone().addScaledVector(dir, 0.05)], 8);
    tube(B.hair, tuft, { radius: (t) => [r0 * 0.55 * (1 - t) + 0.001, r0 * 0.6 * Math.sin(Math.min(1, t * 2 + 0.3) * 2) * (1 - t) + 0.001], paint: () => ({ c: C.hair }), weights: (p) => weights(p, 1), seg: 7, steps: 5 });
  };
  if (style === 'braid' && !tuck) {
    const pts = [hp(0.0, 0.09, -0.1), hp(0.01, 0.02, -0.125), hp(0.015, -0.1, -0.14), hp(0.012, -0.24, -0.15), hp(0.01, -0.34, -0.15)];
    braid(pts, 0.021, 10, (p) => neckAt(p));
  }
  if (style === 'twin_braids' && !tuck) {
    for (const s of [-1, 1]) {
      const sx = m.shX * 0.72;
      const pts = [hp(s * 0.075, 0.08, -0.05), hp(s * 0.09, 0.02, -0.03), hp(s * sx, -0.06, 0.03), hp(s * (sx + 0.01), -0.16, 0.08), hp(s * (sx + 0.005), -0.27, 0.095)];
      braid(pts, 0.016, 9, (p) => {
        const y = p.y - HEAD_Y;
        const k = smoothstep(0.02, -0.08, y);
        return [BI.head, 1 - k, BI.spine, k];
      });
    }
  }
  if (style === 'ponytail' && !tuck) {
    // Derive the gathered root from this head, so facial shape and head scaling
    // cannot leave a detached tail floating behind the scalp.
    head.shell(Math.PI, head.phiAt(Math.PI, 0.105), 0.002, tmp);
    const root = hp(tmp.x, tmp.y, tmp.z + 0.014);
    const tie = root.clone().add(new THREE.Vector3(0, -0.023, -0.027));
    const path = new Path([root, tie, hp(0.008, -0.08, -0.195), hp(0.014, -0.21, -0.22), hp(-0.008, -0.33, -0.215)], 40);
    tube(B.hair, path, {
      radius: t => {
        const gather = 0.72 + 0.28 * Math.sin(Math.min(1, t * 3) * Math.PI / 2);
        const taper = Math.pow(1 - t, 0.65);
        return [(0.03 * taper + 0.002) * gather, (0.033 * taper + 0.002) * gather];
      },
      paint: (t, th) => ({ c: mixCol(C.hairDark, C.hair, 0.72 + Math.sin(th * 7 + t) * 0.16) }),
      weights: p => neckAt(p), seg: 20, steps: 28, uv: (t, th) => [th * 2, t * 3],
    });
    ellipsoid(B.hair, tie, [0.027, 0.008, 0.028], () => ({ c: C.accent }), () => [BI.head, 1], 16, 8);
  }
  if ((style === 'bun' || style === 'half_up') && !tuck && !coveredCrown) {
    const c = hp(0, 0.165, -0.115);
    ellipsoid(B.hair, c, [0.042, 0.036, 0.034], (_p, n) => ({ c: mixCol(C.hairDark, C.hairLight, 0.3 + n.y * 0.3) }), () => [BI.head, 1], 14, 9, new THREE.Euler(0.5, 0, 0));
    // A twist wrapped around it.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 2.2;
      pts.push(new THREE.Vector3(c.x + Math.cos(a) * 0.036, c.y + Math.sin(a) * 0.028 + 0.004, c.z - 0.012 - Math.sin(a) * 0.012));
    }
    tube(B.hair, new Path(pts, 30), { radius: (t) => [0.011 * capsuleR(t, 0.1, 0.1), 0.012 * capsuleR(t, 0.1, 0.1)], paint: () => ({ c: C.hair }), weights: () => [BI.head, 1], seg: 7, steps: 18 });
  }
}

/**
 * Inside the mouth, seen when the lips part: a dark cavity (built inside out, so from outside only
 * its far wall shows, through the opening), the tongue, and two rows of teeth behind the lips on the
 * dental arch, the upper fixed to the head and the lower riding on the jaw. With the lips together
 * all of it is behind them.
 */
function buildMouth(B: BodyBuckets, head: Head, lipC: THREE.Color): void {
  const f = head.f;
  if (head.s.child > 0.9) return; // a baby's gums: nothing to show
  const W = f.mouthW;
  const zc = f.mouthZ - 0.0016; // just behind where the lips meet
  const arch = (x: number) => zc - (x / (W * 1.15)) ** 2 * 0.013;
  const jawW = (y: number): Weights => {
    const k = smoothstep(f.mouthY + 0.002, f.mouthY - 0.002, y - HEAD_Y);
    return [BI.head, 1 - k, BI.jaw, k];
  };
  const dark = mixCol(lipC, col('#1a0b0a'), 0.82);
  // The cavity, mirrored in x so it faces inward.
  ellipsoid(B.skin, hp(0, f.mouthY - 0.003, zc - 0.015), [-W * 1.15, 0.013, 0.019], (p) => ({ c: mixCol(dark, lipC, smoothstep(zc - 0.01, zc, p.z) * 0.25), c2: dark }), (p) => jawW(p.y), 14, 10);
  // The tongue, lying in the floor of the mouth.
  const tongue = mixCol(lipC, col('#b8505a'), 0.35);
  ellipsoid(B.skin, hp(0, f.mouthY - 0.0062, zc - 0.012), [W * 0.72, 0.0035, 0.011], (_p, n) => ({ c: shade(tongue, 0.75 + n.y * 0.25), c2: tongue }), () => [BI.jaw, 1], 12, 8);
  const ivory = col('#ece2cc');
  const gum = mixCol(lipC, col('#d0706a'), 0.4);
  const row = (top: number, bottom: number, back: number, lower: boolean) => grid(B.skin, {
    us: range(-1, 1, 40),
    vs: range(0, 1, 4),
    at: (u, t, out) => {
      const x = u * W * 0.98;
      // Each row runs root (t 0) to biting edge (t 1); the edge notches between the teeth.
      const scallop = Math.abs(Math.cos(u * Math.PI * 4)) * 0.00035 * (t === 1 ? 1 : 0);
      const y = lerp(top, bottom, t) + (lower ? -scallop : scallop);
      return hp(x, y, arch(x) - back, out);
    },
    paint: (u, t) => {
      // Gaps between the teeth, darker toward the back, the gum line at the roots.
      const gap = Math.exp(-((Math.sin(u * Math.PI * 4) / 0.14) ** 2)) * 0.35;
      let c = shade(ivory, 1 - gap - smoothstep(0.35, 1, Math.abs(u)) * 0.45);
      c = mixCol(c, gum, smoothstep(0.82, 1, 1 - t));
      return { c, c2: c };
    },
    weights: () => (lower ? [BI.jaw, 1] : [BI.head, 1]),
    uv: () => BODY_UV,
  });
  // Upper teeth hang a little below the mouth line; the lower stand just behind them.
  row(f.mouthY + 0.0065, f.mouthY - 0.0024, 0, false);
  row(f.mouthY - 0.0062, f.mouthY + 0.0004, 0.0016, true);
}

/** The neck's radius at a height (it's a touch deeper front to back: `* 1.02` on z), for collars to fit. */
export function neckRadius(s: { female: boolean; child: number }, y: number): number {
  const t = (y - 1.43) / 0.23;
  return (s.female ? 0.047 : 0.056) * (1 - s.child * 0.1) * (1.1 - Math.sin(t * Math.PI) * 0.14 - smoothstep(0.45, 0.85, t) * 0.12);
}

/** Where the neck's axis sits front to back at a height (behind the body's centre line). */
export const neckZ = (y: number): number => -0.012 + ((y - 1.43) / 0.23) * 0.004;

/**
 * Beards and moustaches, built over the jaw so they move when the Kynd talks. A moustache is a fan
 * of tapered locks combed out from the middle (on a beard the outer ones run down into it); a
 * beard is a shell that feathers out to nothing along a ragged cheek line, over a shadow of stubble
 * (set in `KyndAvatar`), so it grows out of the skin instead of sitting on it.
 */
export function buildBeard(B: BodyBuckets, head: Head, C: Palette, style: string): void {
  if (style === 'none' || style === 'stubble') return;
  const f = head.f;
  const beardC = mixCol(C.hair, C.hairDark, 0.3);
  const tmp = new THREE.Vector3();
  const full = style === 'full' || style === 'forked';
  const joined = style !== 'moustache';
  const reach = f.mouthW + (full ? 0.009 : 0.007);
  const LOCKS = 6;
  // The moustache fills the upper lip, from under the nose to just over the lip's edge.
  const top = f.noseBaseY - 0.0016, bottom = f.mouthY + f.lipUp * 0.45;
  const mid = (top + bottom) / 2, half = Math.max(0.003, (top - bottom) / 2);
  for (const s of [-1, 1] as const) {
    for (let k = 0; k < LOCKS; k++) {
      const q = k / (LOCKS - 1);
      // Inner locks start at the middle under the nose and are short; outer ones start further out,
      // sweep to the corner and droop (into the beard, if there is one).
      const x0 = lerp(-0.0015, reach * 0.45, q), x1 = reach * lerp(0.5, 1, q);
      const y0 = mid - half * 0.1 + Math.sin(k * 2.1) * half * 0.12;
      const droop = (joined ? lerp(0.003, 0.009, q) : lerp(0.004, 0.012, q)) + (y0 - bottom) * 0.35;
      const pts = [0, 0.4, 0.75, 1].map((t) => {
        const x = s * lerp(x0, x1, t);
        const y = y0 - t * t * droop;
        // Locks lie on the lip; the inner ones a touch proud of the outer, so they overlap like combed hair.
        return hp(x, y, head.frontZ(x, y) + 0.0013 + (1 - q) * 0.0008 - t * t * 0.0012);
      });
      const tone = mixCol(beardC, k % 2 ? C.hairDark : C.hairLight, 0.1 + 0.06 * Math.sin(k * 2.3 + s));
      tube(B.hair, new Path(pts, 12, new THREE.Vector3(0, 0, 1)), {
        // Flat against the lip, full along most of its length, thinning to a soft end.
        radius: (t) => {
          const r = capsuleR(t, lerp(0.04, 0.18, q), 0.12) * (1 - t * 0.5) * lerp(1, 0.8, q);
          return [0.0026 * r, half * (full ? 1.05 : 0.9) * r];
        },
        paint: (t) => ({ c: mixCol(tone, C.hairLight, 0.1 * t) }),
        weights: (p) => faceWeights(p, f),
        seg: 7,
        steps: 9,
      });
    }
  }
  if (style === 'moustache') return;
  const depth = style === 'short' ? 0.0075 : 0.016;
  const hang = style === 'short' ? 0.006 : style === 'forked' ? 0.05 : 0.038;
  // The beard covers the jaw from the sideburns to under the chin, leaving the lips clear. Its line
  // across the cheek is ragged, as hair grows, not ruled.
  const topY = (theta: number) => {
    const a = Math.abs(theta);
    let y: number;
    if (a < 0.28) y = f.mouthY - 0.0085 - (0.28 - a) * 0.012;
    else if (a < 0.55) y = lerp(f.mouthY - 0.0085, f.mouthY + 0.002, smoothstep(0.28, 0.55, a));
    else if (a < 1.1) y = lerp(f.mouthY + 0.002, 0.08, smoothstep(0.55, 1.1, a));
    else y = lerp(0.08, 0.13, smoothstep(1.1, 1.5, a));
    return y + (Math.sin(theta * 13 + 0.4) * 0.55 + Math.sin(theta * 23 + 1.3) * 0.45) * 0.002 * smoothstep(0.42, 0.7, a);
  };
  grid(B.hair, {
    us: range(-1.62, 1.62, 48),
    // Close rows at the top, where the shell feathers out.
    vs: [0, 0.025, 0.06, 0.11, 0.17, ...range(0.25, 1, 9)],
    at: (theta, t, out) => {
      const phiTop = head.phiAt(theta, topY(theta));
      const phi = lerp(phiTop, Math.PI * 0.93, t);
      head.point(theta, phi, tmp);
      // Thickness grows from nothing at the cheek line down to the chin, and fuller beards hang
      // below it, in tufts along the bottom.
      const a = Math.abs(theta);
      const front = Math.cos(Math.min(a, Math.PI / 2));
      const th = depth * (0.04 + 0.96 * smoothstep(0, 0.4, t)) * (0.6 + 0.4 * front) * smoothstep(1.62, 1.35, a);
      const nrm = new THREE.Vector3(tmp.x, (tmp.y - 0.1) * 0.6, tmp.z).normalize();
      tmp.addScaledVector(nrm, th + lerp(0.0007, 0.0012, smoothstep(0, 0.2, t)));
      const tufts = 1 + (full ? 0.14 : 0.3) * (Math.sin(theta * 19 + 0.7) * 0.6 + Math.sin(theta * 37) * 0.4) * smoothstep(0.75, 1, t);
      const drop = hang * Math.pow(smoothstep(0.3, 1, t), 1.3) * Math.pow(front, 2) * tufts;
      tmp.y -= drop;
      tmp.z += drop * 0.35;
      if (style === 'forked') tmp.y -= drop * 0.45 * Math.abs(Math.sin(theta * 6)) * front;
      return hp(tmp.x, tmp.y, tmp.z, out);
    },
    // Sparser (so the skin shows through) at the cheek line; a lighter band where the light catches.
    paint: (theta, t) => ({ c: mixCol(mixCol(beardC, C.skin, smoothstep(0.17, 0.0, t) * 0.5), C.hairLight, Math.exp(-(((t - 0.45) / 0.2) ** 2)) * 0.25 * Math.cos(theta)) }),
    weights: (p) => faceWeights(p, f),
    uv: (theta, t) => [theta * 2, t],
  });
}

// --- hands, legs, feet ----------------------------------------------------------------------

/** The bare forearm's radius down to the wrist (shared, so the hand starts exactly where the arm ends). */
export const FOREARM = new Profile([
  [WRIST_Y, 0.027],
  [WRIST_Y + 0.08, 0.035],
  [EL_Y - 0.06, 0.042],
  [EL_Y, 0.042],
  [EL_Y + 0.06, 0.046],
]);

/** The forearm flattens toward the wrist (palm to back), so it meets the hand's own thickness. */
export const forearmFlat = (y: number) => lerp(0.76, 0.92, smoothstep(WRIST_Y, WRIST_Y + 0.07, y));

/** How much of the wrist's bend a point near the wrist takes (shared by the hand and the bare forearm, so their overlap moves as one and never opens a gap). */
export const wristShare = (y: number) => smoothstep(WRIST_Y + 0.045, WRIST_Y - 0.014, y);

/** A rounded-square cross-section: `n` 2 is an ellipse, higher is boxier (a palm, not a pipe). */
const superCos = (a: number, n: number) => Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), 2 / n);
const superSin = (a: number, n: number) => Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 2 / n);

/**
 * Hands: the sculpted hand (kyndHand.ts: one continuous surface, palm, webbing, two-jointed thumb,
 * fingers in three joints) placed at each wrist, mirrored for the right, scaled with the Kynd's
 * build like the forearm it meets, and painted: warmer knuckles, a paler palm, shaped nails with a
 * cuticle line and a paler free edge. At the wrist its skin follows the forearm exactly as the bare
 * forearm does (`wristShare`), so the two always move as one.
 */
export function buildHands(B: BodyBuckets, m: Measure, C: Palette): void {
  const skinC = C.skin;
  const knuckle = mixCol(skinC, col('#c07060'), 0.14);
  const palmC = mixCol(skinC, col('#d08a78'), 0.1);
  const nail = mixCol(skinC, col('#f4dcd2'), 0.36);
  const nailTip = mixCol(nail, col('#ffffff'), 0.14);
  const sc = m.w;
  const hand = handSculpt();
  const HB = HAND_BONES;
  const pos = hand.positions, nrm = hand.normals;
  const count = pos.length / 3;
  // Where the nails are: the back of each finger's last joint, and of the thumb's.
  const tips = FINGERS.map((_, i) => fingerJoints(i, 1));
  const thumb = thumbJoints(1);
  // Which way the nails face: fingers' to the back of the hand, the thumb's outward and forward.
  const NAIL_FINGER = new THREE.Vector3(1, 0, 0);
  const NAIL_THUMB = new THREE.Vector3(0.45, 0, 0.9).normalize();
  for (const s of [1, -1] as const) {
    const L = s === 1 ? 'L' : 'R';
    const x0 = s * m.shX;
    const W0 = WRIST_Y;
    const map: number[] = [];
    map[HB.el] = s === 1 ? BI.elL : BI.elR;
    map[HB.wr] = BI[`wr${L}` as BoneName];
    FINGERS.forEach((f, i) => {
      map[HB.finger[i]] = BI[`f${f.k}${L}` as BoneName];
      map[HB.finger2[i]] = BI[`f${f.k}2${L}` as BoneName];
    });
    map[HB.th] = BI[`th${L}` as BoneName];
    map[HB.th2] = BI[`th2${L}` as BoneName];
    const b = B.skin;
    const base = b.vertexCount;
    const p = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3();
    for (let v = 0; v < count; v++) {
      p.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      n.set(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
      // Paint (worked out on the left hand, the same on its mirror).
      let c = skinC;
      const back = n.x, palmSide = -n.x;
      // A nail: on the last joint, on the side facing away from the palm (judged by which way the
      // point lies from the finger's own axis, not by its normal, so it stays a neat shape).
      let nailK = -1;
      const nailOn = (j: THREE.Vector3, tip: THREE.Vector3, r: number, face: THREE.Vector3) => {
        const axis = d.copy(tip).sub(j);
        const len = axis.length();
        axis.divideScalar(len);
        const rel = p.clone().sub(j);
        const along = rel.dot(axis) / len;
        const radial = rel.addScaledVector(axis, -rel.dot(axis));
        const dist = radial.length();
        if (along < 0.3 || along > 1.02 || dist < r * 0.55 || dist > r * 1.6) return -1;
        return radial.divideScalar(dist).dot(face) > 0.72 ? along : -1;
      };
      for (let i = 0; i < 4 && nailK < 0; i++) nailK = nailOn(tips[i][2], tips[i][3], FINGERS[i].r * 0.8, NAIL_FINGER);
      if (nailK < 0) nailK = nailOn(thumb[2], thumb[3], 0.0085, NAIL_THUMB);
      if (nailK >= 0) c = nailK > 0.93 ? nailTip : nailK < 0.36 ? mixCol(skinC, knuckle, 0.7) : nail;
      else if (back > 0.3 && p.y < -0.06 && p.y > -0.09) c = mixCol(skinC, knuckle, smoothstep(-0.06, -0.077, p.y) * 0.6);
      else if (palmSide > 0.35 && p.y < -0.004 && p.y > -0.085) c = palmC;
      // Place: mirrored for the right hand, scaled with the build, at the wrist. Near the wrist the
      // surface is pulled onto the forearm's own oval, a hair larger, so the bare forearm (whose end
      // runs on inside the hand) never crosses it: no seam, however the wrist bends.
      let X = s * p.x * sc, Z = p.z * sc;
      const Y = W0 + p.y * sc;
      const k = smoothstep(-0.02, 0.006, p.y);
      let nx = s * n.x, ny = n.y, nz = n.z;
      if (k > 0) {
        const rz = FOREARM.at(Y) * m.w * 1.012, rx = rz * forearmFlat(Y);
        const e = Math.hypot(X / rx, Z / rz) || 1;
        X = lerp(X, X / e, k);
        Z = lerp(Z, Z / e, k);
        const ex = X / (rx * rx), ez = Z / (rz * rz), el = Math.hypot(ex, ez) || 1;
        nx = lerp(nx, ex / el, k);
        ny = lerp(ny, 0, k);
        nz = lerp(nz, ez / el, k);
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
      }
      b.pos.push(x0 + X, Y, Z);
      b.nrm.push(nx, ny, nz);
      b.col.push(c.r, c.g, c.b);
      b.col2.push(c.r, c.g, c.b);
      b.kind.push(0);
      b.uv.push(BODY_UV[0], BODY_UV[1]);
      // Skin: the sculpt's own weights, with the forearm's share at the wrist.
      const wr = wristShare(W0 + p.y * sc);
      const w: Weights = [map[HB.el], 1 - wr];
      for (let k = 0; k < 4; k++) {
        const wt = hand.skinWeight[v * 4 + k];
        if (wt > 0) w.push(map[hand.skinIndex[v * 4 + k]], wt * wr);
      }
      pushWeights(b, w);
    }
    const idx = hand.indices;
    for (let t = 0; t < idx.length; t += 3) {
      // Mirroring turns the faces inside out: wind the right hand's the other way.
      if (s === 1) b.idx.push(base + idx[t], base + idx[t + 1], base + idx[t + 2]);
      else b.idx.push(base + idx[t], base + idx[t + 2], base + idx[t + 1]);
    }
  }
}

export type Footwear = 'boots' | 'tall_boots' | 'shoes' | 'poulaines';

/** Hose and boots. `showThigh` is false under long skirts (saves triangles no one sees). */
export function buildLegs(B: BodyBuckets, m: Measure, C: Palette, foot: Footwear, hoseKind: number, showThigh: boolean, hose: THREE.Color): void {
  const w = m.w;
  for (const s of [1, -1] as const) {
    const x0 = s * m.hipX;
    const top = showThigh ? PELVIS_Y + 0.04 : KNEE_Y + 0.14;
    const leg = new Profile([
      [0.06, 0.036],
      [0.12, 0.04],
      [0.3, 0.056],
      [0.4, 0.053],
      [KNEE_Y, 0.052],
      [0.62, 0.064],
      [0.8, 0.074],
      [PELVIS_Y, 0.08],
      [PELVIS_Y + 0.05, 0.07],
    ]);
    // Rings close together round the knee, so it bends in a curve.
    const knee = range(KNEE_Y - 0.08, KNEE_Y + 0.08, 12);
    const legRows = (showThigh ? [0.06, 0.12, 0.2, 0.28, 0.36, ...knee, 0.56, 0.64, 0.72, 0.8, 0.86, top] : [0.06, 0.12, 0.2, 0.28, 0.36, ...knee.filter((y) => y < top - 0.01), top]).sort((a, b) => a - b);
    grid(B.garment, {
      us: around(12),
      vs: legRows,
      wrapU: true,
      flip: true,
      at: (th, y, out) => {
        const r = leg.at(y) * (y > 0.5 ? w : 1);
        // Hose wrinkle a little at the ankle and behind the knee.
        const wr = 1 + (y < 0.16 ? 0.05 * Math.sin(th * 5 + y * 90) : 0);
        return out.set(x0 + Math.sin(th) * r * wr - (y > 0.5 ? s * 0.004 : 0), y, Math.cos(th) * r * 1.05 * wr + (y < 0.4 && y > 0.12 ? -0.006 : 0));
      },
      paint: () => ({ c: hose, kind: hoseKind }),
      weights: (p) => footWeights(p, s),
    });
    // Seat of the hose, joining the legs under the tunic.
    if (showThigh && s === 1) {
      grid(B.garment, {
        us: around(16),
        vs: range(0.8, PELVIS_Y + 0.08, 4),
        wrapU: true,
        flip: true,
        at: (th, y, out) => {
          const k = smoothstep(0.8, 0.9, y);
          const rx = lerp(0.12, 0.165, k) * w;
          return out.set(Math.sin(th) * rx, y, Math.cos(th) * lerp(0.08, 0.12, k) * w);
        },
        paint: () => ({ c: hose, kind: hoseKind }),
        weights: () => [BI.pelvis, 1],
      });
    }
    // Footwear: a shaft around the lower leg and a foot along +z.
    const tall = foot === 'tall_boots' ? 0.42 : foot === 'boots' ? 0.3 : 0.1;
    const lc = foot === 'poulaines' ? C.leatherDark : foot === 'tall_boots' ? col('#2a1d16') : C.leather;
    const shaft = new Profile([
      [0.02, 0.046],
      [0.1, 0.044],
      [0.2, 0.058],
      [0.3, 0.064],
      [0.42, 0.06],
    ]);
    if (foot !== 'shoes' && foot !== 'poulaines') {
      grid(B.shoes, {
        us: around(12),
        vs: range(0.03, tall, 6),
        wrapU: true,
        flip: true,
        at: (th, y, out) => {
          const r = shaft.at(y) + 0.004;
          return out.set(x0 + Math.sin(th) * r, y, Math.cos(th) * r * 1.06 - 0.004);
        },
        paint: (_t, y) => ({ c: y < 0.045 ? shade(lc, 0.6) : lc, kind: KIND.leather }),
        weights: (p) => footWeights(p, s),
      });
      // Turned-down cuff.
      const cuffC = mixCol(lc, col('#a07048'), 0.35);
      grid(B.shoes, {
        us: around(12),
        vs: [tall - 0.065, tall - 0.05, tall - 0.01, tall + 0.008, tall + 0.002, tall - 0.02],
        wrapU: true,
        flip: true,
        at: (th, y, out) => {
          const k = (y - (tall - 0.065)) / 0.07;
          const r = shaft.at(tall) + 0.012 + Math.sin(Math.max(0, Math.min(1, k)) * Math.PI) * 0.004 + (Math.cos(th) > 0.6 ? 0.004 : 0);
          return out.set(x0 + Math.sin(th) * r, y, Math.cos(th) * r * 1.06 - 0.004);
        },
        paint: () => ({ c: cuffC, kind: KIND.leather }),
        weights: (p) => footWeights(p, s),
      });
    }
    // The foot: a shoe lofted heel to toe, flat-soled, high over the instep where it meets the
    // ankle, widest across the ball of the foot, the toe box lower and springing up a little at the
    // tip; then a darker sole standing just proud of the upper, and a low heel block on boots.
    const pointed = foot === 'poulaines';
    const heelZ = -0.064, toeZ = pointed ? 0.2 : 0.138;
    const half = new Profile(pointed
      ? [[0, 0.018], [0.08, 0.029], [0.3, 0.033], [0.55, 0.039], [0.68, 0.04], [0.82, 0.028], [0.93, 0.013], [1, 0.004]]
      : [[0, 0.016], [0.06, 0.028], [0.25, 0.032], [0.5, 0.037], [0.7, 0.044], [0.82, 0.041], [0.92, 0.031], [0.98, 0.016], [1, 0.006]]);
    const upper = new Profile(pointed
      ? [[0, 0.04], [0.06, 0.078], [0.22, 0.1], [0.42, 0.088], [0.6, 0.058], [0.8, 0.036], [1, 0.024]]
      : [[0, 0.04], [0.06, 0.078], [0.25, 0.104], [0.45, 0.09], [0.66, 0.062], [0.85, 0.05], [0.96, 0.038], [1, 0.03]]);
    const sole = 0.012;
    const lift = (v: number) => smoothstep(0.86, 1, v) * (pointed ? 0.022 : 0.01);
    const along = (v: number) => heelZ + (toeZ - heelZ) * v;
    // A touch of toe-out, as feet stand.
    const cxAt = (v: number) => x0 + s * 0.006 * v;
    const footVs = range(0, 1, 18);
    grid(B.shoes, {
      us: around(16),
      vs: footVs,
      wrapU: true,
      flip: true,
      at: (th, v, out) => {
        const bot = sole + lift(v);
        const tp = Math.max(bot + 0.01, upper.at(v) + lift(v) * 0.5);
        const cy = (bot + tp) / 2, hh = (tp - bot) / 2;
        // Squarish below (the sole edge), rounded above (the upper).
        const cy2 = Math.cos(th);
        const ys = cy2 < 0 ? superCos(th, 4) : superCos(th, 2);
        const xs = superSin(th, cy2 < 0 ? 4 : 2);
        // Close the heel and toe ends smoothly.
        const endK = Math.sqrt(Math.max(0, 1 - ((v - 0.5) / 0.5) ** 6));
        return out.set(cxAt(v) + xs * half.at(v) * endK, cy + ys * hh * Math.max(0.35, endK), along(v));
      },
      paint: (th, v) => ({ c: Math.cos(th) < -0.6 ? shade(lc, 0.75) : v > 0.82 && Math.cos(th) > 0.3 ? shade(lc, 1.08) : lc, kind: KIND.leather }),
      weights: (p) => footWeights(p, s),
    });
    // The sole: a slab just wider than the upper, darker, with a heel block on boots.
    const heelBlock = foot === 'boots' || foot === 'tall_boots' ? 0.012 : 0;
    grid(B.shoes, {
      us: around(16),
      vs: footVs,
      wrapU: true,
      flip: true,
      at: (th, v, out) => {
        const endK = Math.sqrt(Math.max(0, 1 - ((v - 0.5) / 0.5) ** 8));
        const hb = heelBlock * (1 - smoothstep(0.24, 0.3, v));
        const yTop = sole + 0.002 + lift(v) + hb * 0.2, yBot = lift(v) * 0.9;
        const c = Math.cos(th);
        const y = c > 0 ? yTop : yBot - (c < -0.2 ? hb : 0);
        return out.set(cxAt(v) + superSin(th, 6) * (half.at(v) + 0.004) * endK, y, along(v) + (v < 0.02 ? -0.003 : 0));
      },
      paint: () => ({ c: shade(lc, 0.45), kind: KIND.leather }),
      weights: (p) => footWeights(p, s),
    });
    // Ankle strap on shoes.
    if (foot === 'shoes' || foot === 'poulaines') {
      grid(B.shoes, {
        us: around(14),
        vs: [0.05, 0.075, 0.1],
        wrapU: true,
        flip: true,
        at: (th, y, out) => {
          const r = 0.043 + (y - 0.05) * 0.1;
          return out.set(x0 + Math.sin(th) * r, y, Math.cos(th) * r * 1.08 - 0.008);
        },
        paint: () => ({ c: lc, kind: KIND.leather }),
        weights: (p) => footWeights(p, s),
      });
    }
  }
}

/**
 * Bare feet, in their own part, shown only when the shoes come off (bathing). Rest pose, toes along
 * +z: a rounded heel, the ankle with its two bones (the inner one higher and further forward), an
 * arch lifting the inner sole, the instep falling to a broad ball, and five toes (the big toe
 * stoutest, the rest smaller and set back along a slanting line), each with a nail.
 */
export function buildBareFeet(B: BodyBuckets, m: Measure, C: Palette): void {
  const skinC = C.skin;
  const soleC = mixCol(skinC, col('#efc2b2'), 0.22);
  const knuckle = mixCol(skinC, col('#c07060'), 0.12);
  const nail = mixCol(skinC, col('#f2d4c8'), 0.32);
  const fs = Math.sqrt(m.w);
  const heelZ = -0.06, endZ = 0.094;
  const half = new Profile([[0, 0.014], [0.06, 0.027], [0.2, 0.034], [0.32, 0.034], [0.5, 0.032], [0.7, 0.038], [0.86, 0.042], [0.95, 0.04], [1, 0.03]]);
  const upper = new Profile([[0, 0.03], [0.07, 0.056], [0.2, 0.084], [0.32, 0.082], [0.55, 0.06], [0.78, 0.038], [0.92, 0.03], [1, 0.024]]);
  for (const s of [1, -1] as const) {
    const x0 = s * m.hipX;
    const w = (p: THREE.Vector3) => footWeights(p, s);
    const along = (v: number) => heelZ + (endZ - heelZ) * v;
    // The body of the foot.
    grid(B.feet, {
      us: around(20),
      vs: range(0, 1, 20),
      wrapU: true,
      flip: true,
      at: (th, v, out) => {
        const c = Math.cos(th), sn = Math.sin(th);
        // Inner side (toward the other foot) is −s in x.
        const inner = -sn * s > 0;
        const endK = Math.sqrt(Math.max(0, 1 - ((v - 0.5) / 0.5) ** 6));
        let bot = 0.004;
        // The arch: the inner edge of the sole lifts between heel and ball.
        if (inner && c < 0) bot += 0.011 * Math.abs(sn) * Math.sin(Math.PI * Math.min(1, Math.max(0, (v - 0.2) / 0.5)));
        const top = upper.at(v) * (inner ? 1.04 : 0.96);
        const cy = (bot + top) / 2, hh = (top - bot) / 2;
        const ys = c < 0 ? superCos(th, 3.6) : superCos(th, 2.1);
        const xs = superSin(th, c < 0 ? 3.6 : 2.1);
        return out.set(x0 + s * 0.004 * v + xs * half.at(v) * fs * endK, cy + ys * hh * Math.max(0.3, endK), along(v));
      },
      paint: (th, v) => ({ c: Math.cos(th) < -0.55 ? soleC : v > 0.82 && Math.cos(th) > 0.4 ? mixCol(skinC, knuckle, 0.5) : skinC }),
      weights: w,
      uv: () => BODY_UV,
    });
    // Toes: across the ball from the big toe on the inside to the little toe on the outside.
    const toes = [
      { x: -0.0235, z: 0.082, L: 0.033, r: 0.0112 },
      { x: -0.0065, z: 0.084, L: 0.027, r: 0.0078 },
      { x: 0.0075, z: 0.08, L: 0.024, r: 0.0074 },
      { x: 0.0195, z: 0.073, L: 0.021, r: 0.007 },
      { x: 0.0305, z: 0.063, L: 0.017, r: 0.0066 },
    ];
    for (const [i, t] of toes.entries()) {
      const tx = x0 + s * t.x * fs;
      const r = t.r * fs;
      const z0 = t.z, L = t.L;
      // Splay a little outward from the big toe; each toe curls down to rest on its tip.
      const splay = s * (i - 1) * 0.0012;
      const pts = [
        new THREE.Vector3(tx, 0.022, z0 - 0.02),
        new THREE.Vector3(tx, 0.019, z0),
        new THREE.Vector3(tx + splay * 0.5, 0.017, z0 + L * 0.5),
        new THREE.Vector3(tx + splay, r * 0.95 + 0.001, z0 + L),
      ];
      tube(B.feet, new Path(pts, 14, new THREE.Vector3(0, 1, 0)), {
        radius: (u) => {
          // Blunt and rounded at the end (a pad under the nail), barely tapering.
          const k = lerp(1, 0.94, u) * Math.pow(capsuleR(u, 0.02, 0.42), 0.8) * (1 + 0.05 * Math.exp(-(((u - 0.5) / 0.08) ** 2)));
          return [r * k * 0.8, r * k * (i === 0 ? 1.1 : 1)];
        },
        paint: (u, th) => ({ c: u > 0.7 && u < 0.97 && Math.cos(th) > 0.6 ? nail : u > 0.44 && u < 0.56 && Math.cos(th) > 0.5 ? mixCol(skinC, knuckle, 0.4) : skinC }),
        weights: w,
        seg: 8,
        steps: 9,
        uv: () => BODY_UV,
      });
    }
  }
}

/** Forearm skin for rolled or short sleeves (from just above the elbow to the wrist). */
export function buildForearms(B: BodyBuckets, m: Measure, C: Palette, from: number): void {
  for (const s of [1, -1] as const) {
    const x0 = s * m.shX;
    const prof = FOREARM;
    grid(B.skin, {
      us: around(14),
      // The end runs on inside the hand, narrowing, so the join is closed from every side.
      vs: [WRIST_Y - 0.02, WRIST_Y - 0.008, WRIST_Y, ...[...new Set([...range(WRIST_Y + 0.02, from, 9), ...range(EL_Y - 0.08, Math.min(from, EL_Y + 0.08), 12).filter((y) => y < from - 0.005)])].sort((a, b) => a - b)],
      wrapU: true,
      flip: true,
      at: (th, y, out) => {
        const r = prof.at(Math.max(WRIST_Y, y)) * m.w * (1 - 0.4 * smoothstep(WRIST_Y - 0.002, WRIST_Y - 0.02, y));
        return out.set(x0 + Math.sin(th) * r * forearmFlat(y), y, Math.cos(th) * r);
      },
      paint: () => ({ c: C.skin }),
      weights: (p) => {
        const wr = wristShare(p.y);
        if (wr <= 0) return armWeights(p, s);
        return [s === 1 ? BI.elL : BI.elR, 1 - wr, s === 1 ? BI.wrL : BI.wrR, wr];
      },
      uv: () => BODY_UV,
    });
  }
}

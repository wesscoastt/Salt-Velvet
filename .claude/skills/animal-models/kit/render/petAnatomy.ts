import type { AnimalGenome } from '../sim/animals/Animal.ts';
import type { AnimalStage } from '../sim/animals/Species.ts';
import { capsule, carve, ellipsoid, fieldAt, type Mass, type V3 } from './sdfMesh.ts';

/*
 * Pet anatomy: the armature and clay masses for a dog or a cat, from its genome. Proportions are
 * written in units of the withers height H (ground to the top of the shoulders), then scaled to
 * metres. Dogs vary by type through the genome (size, build, muzzle, ears, tail, coat length);
 * cats have their own skeleton: small head, slender long body, long hind legs and a long tail.
 */

export const TAG = { leg: 0, paw: 1, tail: 2, head: 3, muzzle: 4, neck: 5, torso: 6, brow: 7, ear: 8 } as const;
export const TAG_COUNT = 9;
const T = (...names: (keyof typeof TAG)[]) => names.reduce((m, n) => m | (1 << TAG[n]), 0);

export const BONE = { hips: 0, spine: 1, chest: 2, ribs: 3, neck: 4, head: 5, tail: 6 } as const;
export const TAIL_BONES = 6;
export const LEG_BASE = BONE.tail + TAIL_BONES;
export const BONE_COUNT = LEG_BASE + 16;
/** Leg order: front left, front right, hind left, hind right; segments upper, middle, lower, paw. */
export const legBone = (leg: number, seg: number) => LEG_BASE + leg * 4 + seg;

export interface LegRig {
  side: number;
  front: boolean;
  /** Rest joint positions (metres, root space): shoulder/hip, elbow/stifle, wrist/hock, paw. */
  joints: [V3, V3, V3, V3];
  lengths: [number, number, number];
}

export type EarShape = 'pricked' | 'floppy' | 'folded' | 'cat';

export interface PetRig {
  species: 'dog' | 'cat';
  H: number;
  joints: V3[];
  parents: number[];
  masses: Mass[];
  legs: LegRig[];
  /** Head-local (relative to the head joint) features. */
  jawHinge: V3;
  jawMasses: Mass[];
  noseMasses: Mass[];
  eyes: { pos: V3; r: number; yaw: number }[];
  ear: { shape: EarShape; base: V3; length: number; width: number; droop: number; fluff: number };
  mouth: { palate: V3; palateR: V3; tongue: V3; tongueR: V3 };
  whiskers: V3 | null;
  pawH: number;
  stride: { walk: number; run: number };
  /** Coat helpers for markings. */
  headPos: V3;
  headScale: number;
  tailLength: number;
  muzzleLen: number;
  beard: boolean;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const THREE_clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Withers height in metres. */
export function withersHeight(g: AnimalGenome, stage: AnimalStage, species: 'dog' | 'cat'): number {
  const young = stage === 'young';
  if (species === 'cat') return (0.225 + g.size * 0.06) * (young ? 0.62 : 1);
  return (0.2 + g.size * 0.56) * (young ? 0.58 : 1);
}

export function buildRig(g: AnimalGenome, stage: AnimalStage, species: 'dog' | 'cat'): PetRig {
  return species === 'cat' ? catRig(g, stage) : dogRig(g, stage);
}

function finish(rig: Omit<PetRig, 'joints' | 'parents'> & { bones: Record<number, [V3, number]> }): PetRig {
  const joints: V3[] = [], parents: number[] = [];
  for (let i = 0; i < BONE_COUNT; i++) { joints.push(rig.bones[i][0]); parents.push(rig.bones[i][1]); }
  const { bones: _b, ...rest } = rig;
  return { ...rest, joints, parents };
}

function dogRig(g: AnimalGenome, stage: AnimalStage): PetRig {
  const young = stage === 'young';
  const H = withersHeight(g, stage, 'dog');
  const b = g.build, c = g.coatLength, m = g.muzzle;
  const small = 1 - Math.min(1, g.size / 0.45); // 1 for the tiniest lap dogs
  const P = (x: number, y: number, z: number): V3 => [x * H, y * H, z * H];
  const masses: Mass[] = [];
  const bones: Record<number, [V3, number]> = {};
  const legLen = (young ? 0.8 : 1) * (1 - small * 0.16);
  // Body length and depth: heavy dogs are broad and deep; sight hounds lean with a tucked waist.
  const len = (lerp(1.02, 1.12, b) + small * 0.16) * (young ? 0.86 : 1);
  const wide = lerp(0.82, 1.28, b) * (young ? 1.16 : 1);
  const tuck = lerp(0.06, -0.02, b) * (young ? 0.3 : 1);
  const fluff = Math.max(0, c - 0.35);
  const yLift = (1 - legLen) * 0.52; // shorter puppy legs lower the body
  const Y = (y: number) => y - yLift;
  const Z = (z: number) => z * len;

  bones[BONE.hips] = [P(0, Y(0.8), Z(-0.36)), -1];
  bones[BONE.spine] = [P(0, Y(0.84), Z(-0.06)), BONE.hips];
  bones[BONE.chest] = [P(0, Y(0.78), Z(0.22)), BONE.spine];
  bones[BONE.ribs] = [P(0, Y(0.74), Z(0.16)), BONE.chest];
  bones[BONE.neck] = [P(0, Y(0.86), Z(0.42)), BONE.chest];
  // A touch larger than life, as pets in a life sim are: the face is where the character is.
  const headScale = 1.66 * (young ? 1.3 : 1) * lerp(1, 1.08, small) * lerp(0.95, 1.12, b) * (g.type === 'sighthound' ? 0.88 : 1);
  const headPos = P(0, Y(1.15), Z(0.42) + 0.15);
  bones[BONE.head] = [headPos, BONE.neck];

  // Torso masses.
  const wx = (x: number) => x * wide;
  masses.push(ellipsoid(P(0, Y(0.75), Z(0.17)), P(wx(0.155), 0.24, 0.265 * len), BONE.ribs, T('torso')));
  masses.push(ellipsoid(P(0, Y(0.63), Z(0.33)), P(wx(0.105), 0.135, 0.13), BONE.chest, T('torso'), 0.07 * H));
  masses.push(ellipsoid(P(0, Y(0.87), Z(0.3)), P(wx(0.1), 0.095, 0.17), BONE.chest, T('torso'), 0.08 * H));
  for (const s of [-1, 1]) masses.push(ellipsoid(P(s * wx(0.085), Y(0.8), Z(0.34)), P(0.055 * wide, 0.14, 0.085), BONE.chest, T('torso'), 0.06 * H, [-0.45, 0, 0]));
  masses.push(ellipsoid(P(0, Y(0.82 + tuck * 0.5), Z(-0.14)), P(wx(0.12), 0.135 - tuck, 0.24 * len), BONE.spine, T('torso'), 0.12 * H));
  masses.push(ellipsoid(P(0, Y(0.82), Z(-0.37)), P(wx(0.13), 0.13, 0.17), BONE.hips, T('torso'), 0.08 * H));
  masses.push(ellipsoid(P(0, Y(0.77), Z(-0.49)), P(wx(0.1), 0.11, 0.08), BONE.hips, T('torso'), 0.06 * H));
  if (fluff > 0) {
    // A long coat: ruff at the chest, fuller flanks.
    masses.push(ellipsoid(P(0, Y(0.78), Z(0.36)), P(wx(0.14 + fluff * 0.05), 0.2 + fluff * 0.05, 0.14 + fluff * 0.04), BONE.chest, T('torso'), 0.08 * H));
    masses.push(ellipsoid(P(0, Y(0.76), Z(-0.05)), P(wx(0.15 + fluff * 0.03), 0.18, 0.3), BONE.spine, T('torso'), 0.1 * H, undefined, { influence: 0.5 }));
  }
  // Neck: thick, set at a slope into the withers and chest.
  const neckTop = add(headPos, P(0, -0.02, -0.05));
  masses.push(capsule(P(0, Y(0.8), Z(0.36)), neckTop, (0.135 + b * 0.03 + fluff * 0.04) * H, (0.098 + b * 0.014 + fluff * 0.02) * H, BONE.neck, T('neck'), 0.08 * H));
  masses.push(capsule(P(0, Y(0.72), Z(0.44)), add(headPos, P(0, -0.09, 0.0)), (0.095 + fluff * 0.05) * H, (0.07 + fluff * 0.02) * H, BONE.neck, T('neck'), 0.06 * H));

  // Legs.
  const legs: LegRig[] = [];
  const LY = (y: number) => y * legLen;
  const fx = 0.088 * wide, hx = 0.085 * wide;
  const legR = 1.42 * lerp(0.85, 1.2, b) * (young ? 1.15 : 1) * lerp(1, 1.12, small);
  for (const [leg, s, front] of [[0, 1, true], [1, -1, true], [2, 1, false], [3, -1, false]] as [number, number, boolean][]) {
    const j: [V3, V3, V3, V3] = front
      ? [P(s * fx, Y(0.66), Z(0.4)), P(s * (fx + 0.01), Y(0.47) + 0.0, Z(0.3)), P(s * (fx - 0.005), LY(0.125), Z(0.31)), P(s * (fx - 0.005), 0.035, Z(0.31) + 0.04)]
      : [P(s * hx, Y(0.78), Z(-0.42)), P(s * (hx + 0.015), Y(0.55), Z(-0.28)), P(s * (hx + 0.005), LY(0.25), Z(-0.5)), P(s * hx, 0.035, Z(-0.46))];
    const L = (a: V3, c2: V3) => Math.hypot(a[0] - c2[0], a[1] - c2[1], a[2] - c2[2]);
    legs.push({ side: s, front, joints: j, lengths: [L(j[0], j[1]), L(j[1], j[2]), L(j[2], j[3])] });
    const [u, mid, low, paw] = [legBone(leg, 0), legBone(leg, 1), legBone(leg, 2), legBone(leg, 3)];
    bones[u] = [j[0], front ? BONE.chest : BONE.hips];
    bones[mid] = [j[1], u];
    bones[low] = [j[2], mid];
    bones[paw] = [j[3], low];
    const r = legR * H;
    if (front) {
      // Upper arm (triceps) blending into the chest, forearm, carpus, pastern, paw.
      masses.push(ellipsoid(add(j[0], P(-s * 0.006, -0.075, -0.06)), [0.05 * r, 0.12 * H, 0.066 * r], u, T('leg'), 0.09 * H, [0.55, 0, 0]));
      masses.push(capsule(add(j[1], P(0, 0.02, -0.005)), add(j[2], P(0, 0.025, 0)), 0.043 * r, 0.026 * r, mid, T('leg'), 0.035 * H));
      masses.push(ellipsoid(add(j[1], P(0, 0.005, -0.028)), [0.028 * r, 0.035 * r, 0.026 * r], mid, T('leg'), 0.03 * H));
      masses.push(capsule(j[2], add(j[3], P(0, 0.012, -0.012)), 0.026 * r, 0.026 * r, low, T('leg', 'paw'), 0.02 * H));
      if (fluff > 0.15) masses.push(capsule(add(j[1], P(0, -0.02, -0.04)), add(j[2], P(0, 0.08, -0.03)), (0.02 + fluff * 0.03) * H, 0.012 * H, mid, T('leg'), 0.035 * H, 0.9, { influence: 0.3 }));
    } else {
      // Broad haunch from the croup to the stifle, and the hamstring line down to the hock.
      // (A generous blend so the thigh flows into the loin and croup rather than sitting on it.)
      masses.push(ellipsoid(add(j[0], P(-s * 0.004, -0.085, 0.015)), [0.05 * r, 0.165 * H, 0.112 * H * lerp(0.9, 1.1, b)], u, T('leg'), 0.14 * H, [-0.4, 0, 0]));
      hamstring(masses, add(j[0], P(s * 0.01, -0.12, -0.08)), add(j[2], P(0, 0.06, -0.015)), 0.07 * r, 0.03 * r, u, mid, 0.05 * H, j[1][1]);
      masses.push(capsule(add(j[1], P(0, 0.01, -0.02)), add(j[2], P(0, 0.02, 0.005)), 0.047 * r, 0.028 * r, mid, T('leg'), 0.04 * H));
      // The flank fold: skin from the belly to the stifle, so the thigh is part of the body.
      masses.push(capsule(P(s * hx * 0.75, Y(0.68), Z(-0.2)), add(j[1], P(-s * 0.005, 0.04, 0.012)), 0.06 * H * lerp(0.9, 1.2, b), 0.04 * H, u, T('leg', 'torso'), 0.07 * H, 1, { influence: 0.6 }));
      masses.push(ellipsoid(add(j[2], P(0, 0.012, -0.022)), [0.024 * r, 0.035 * r, 0.026 * r], mid, T('leg'), 0.02 * H));
      masses.push(capsule(j[2], add(j[3], P(0, 0.012, -0.01)), 0.026 * r, 0.026 * r, low, T('leg', 'paw'), 0.02 * H));
      if (fluff > 0.15) masses.push(ellipsoid(add(j[0], P(s * 0.01, -0.16, -0.07)), [0.06 * r, 0.12 * H, (0.05 + fluff * 0.05) * H], u, T('leg'), 0.05 * H, [0.2, 0, 0], { influence: 0.4 }));
    }
    pawMasses(masses, j[3], r, paw, H, front ? 1 : 0.92);
  }

  // Tail: a chain hanging from the croup. Shapes come from the genome.
  const tailLen = g.tail === 'short' ? 0.16 : g.tail === 'curled' ? 0.42 : g.tail === 'plumed' ? 0.62 : 0.6;
  const tailBase = P(0, Y(0.87), Z(-0.53));
  const tr0 = (g.tail === 'plumed' ? 0.05 + c * 0.05 : g.tail === 'short' ? 0.042 : 0.045 + b * 0.012) * (young ? 1.15 : 1);
  tailChain(masses, bones, tailBase, tailLen * H, tr0 * H, (g.tail === 'plumed' ? 0.04 + c * 0.04 : 0.014) * H, H, g.tail === 'plumed' ? 1.3 : 1);

  // Head.
  const ML = (lerp(0.06, 0.175, m) - small * 0.025) * (young ? 0.55 : 1);
  const hs = headScale;
  const HP = (x: number, y: number, z: number): V3 => add(headPos, [x * H * hs, y * H * hs, z * H * hs]);
  const dome = small * 0.02 + (young ? 0.022 : 0);
  const bw = lerp(0.96, 1.12, b);
  const Hh = H * hs;
  masses.push(ellipsoid(HP(0, 0.04 + dome * 0.5, 0.06), [0.088 * Hh * bw, (0.08 + dome) * Hh, 0.105 * Hh], BONE.head, T('head')));
  masses.push(ellipsoid(HP(0, 0.055, -0.01), [0.055 * Hh, 0.055 * Hh, 0.055 * Hh], BONE.head, T('head'), 0.04 * H));
  for (const s of [-1, 1]) {
    masses.push(ellipsoid(HP(s * 0.06, -0.015, 0.085), [0.048 * Hh * bw, 0.052 * Hh, 0.065 * Hh], BONE.head, T('head'), 0.04 * H));
    // Brows over the eyes, standing out at the stop.
    masses.push(ellipsoid(HP(s * 0.042, 0.07 + dome * 0.5, 0.135), [0.032 * Hh, 0.018 * Hh, 0.03 * Hh], BONE.head, T('head', 'brow'), 0.03 * H));
  }
  // Muzzle: two side masses make it broad and flat-topped rather than a tube.
  const mw = lerp(1.22, 0.92, m) * lerp(0.95, 1.12, b);
  const mz0 = 0.145, mz1 = 0.145 + ML;
  for (const s of [-1, 1]) {
    // Tapering toward the nose (a straight-sided muzzle reads as a duck bill from the front).
    masses.push(capsule(HP(s * 0.022 * mw, -0.01, mz0), HP(s * 0.013 * mw, -0.018, mz1), 0.046 * mw * Hh, 0.03 * mw * Hh, BONE.head, T('head', 'muzzle'), 0.045 * H, 0.95));
    // Upper lips hang over the lower jaw; heavy dogs carry loose flews.
    const flew = lerp(0.0, 0.014, b) * (1 - small);
    masses.push(capsule(HP(s * 0.028 * mw, -0.046 - flew, mz0 + 0.01), HP(s * 0.017 * mw, -0.047 - flew * 0.6, mz1 - 0.015), 0.027 * mw * Hh, 0.019 * mw * Hh, BONE.head, T('head', 'muzzle'), 0.03 * H));
  }
  // The bridge of the nose: from between the eyes, nearly level to the nose, so the forehead rises
  // above it in a stop (a bridge sloping down from the brow reads as a bull terrier's egg face).
  masses.push(capsule(HP(0, 0.02, 0.15), HP(0, 0.009, mz1 - 0.008), 0.03 * Hh, 0.027 * mw * Hh, BONE.head, T('head', 'muzzle'), 0.025 * H));
  // Carve the stop: the step from forehead down to the bridge, between the eyes (the masses melt
  // together so softly that it would otherwise fill in). Short-nosed and young dogs have less of one.
  masses.push(carve(HP(0, 0.088 + dome * 0.4, 0.178), 0.03 * Hh * lerp(0.7, 1, m), 0.012 * H, BONE.head));
  // Wiry-coated dogs (terriers, wolfhounds) carry a beard and brows.
  const beard = g.type === 'terrier' || g.type === 'wolfhound' || (c > 0.5 && c < 0.72 && g.size < 0.55 && m > 0.35);
  if (beard) {
    // Wiry furnishings: brows and a beard.
    for (const s of [-1, 1]) masses.push(ellipsoid(HP(s * 0.04, 0.07, 0.165), [0.022 * H * hs, 0.012 * H * hs, 0.022 * H * hs], BONE.head, T('head', 'brow'), 0.03 * H));
    masses.push(ellipsoid(HP(0, -0.055, mz1 - 0.04), [0.045 * H * hs, 0.04 * H * hs, 0.05 * H * hs], BONE.head, T('head', 'muzzle'), 0.03 * H));
  }
  const eyeR = (0.025 + small * 0.003 + (young ? 0.003 : 0)) * H * hs;
  const eyes = [-1, 1].map(s => ({ pos: [s * 0.05 * H * hs, 0.036 * H * hs, 0.157 * H * hs] as V3, r: eyeR, yaw: s * 0.26 }));
  embedEyes(masses, headPos, eyes, 0.56, 0.008 * H * hs);
  const jawHinge: V3 = [0, -0.045 * H * hs, 0.06 * H * hs];
  const J = (x: number, y: number, z: number): V3 => [x * H * hs, y * H * hs, z * H * hs];
  const jawMasses: Mass[] = [
    capsule(J(0, 0.0, 0.0), J(0, -0.006, ML + 0.03), 0.034 * mw * H * hs, 0.018 * mw * H * hs, 0, T('head', 'muzzle'), 0, 0.6),
    ellipsoid(J(0, -0.018, ML * 0.5 + 0.03), [0.026 * mw * H * hs, 0.017 * H * hs, 0.04 * H * hs], 0, T('head', 'muzzle'), 0.02 * H),
  ];
  const noseZ = mz1 + 0.032;
  const nr = (0.018 + b * 0.003) * lerp(1.1, 0.95, m) * H * hs;
  const noseMasses: Mass[] = [
    ellipsoid([0, 0, 0], [nr * 1.18, nr * 0.82, nr * 0.72], 0, 0),
    ellipsoid([0, -nr * 0.35, -nr * 0.2], [nr * 0.75, nr * 0.6, nr * 0.75], 0, 0, nr * 0.5),
    carve([nr * 0.48, -nr * 0.18, nr * 0.75], nr * 0.26, nr * 0.25, 0),
    carve([-nr * 0.48, -nr * 0.18, nr * 0.75], nr * 0.26, nr * 0.25, 0),
  ];
  noseMasses.forEach(n => { n.a = add(n.a, J(0, -0.006, noseZ)); });
  const earShape: EarShape = g.ears;
  return finish({
    species: 'dog', H, bones, masses, legs, jawHinge, jawMasses, noseMasses, eyes,
    ear: {
      shape: earShape,
      base: earShape === 'floppy' ? [0.07 * H * hs, 0.076 * H * hs, 0.004 * H * hs] : [0.062 * H * hs, 0.088 * H * hs, 0.035 * H * hs],
      // Long, low-set leathers on scenthounds and spaniels; bigger ears all round for expression.
      length: (earShape === 'floppy' ? 0.24 + c * 0.05 : earShape === 'pricked' ? 0.155 : 0.12) * H * hs * (young ? 0.95 : 1) * (g.type === 'bloodhound' ? 1.45 : g.type === 'spaniel' ? 1.25 : 1),
      width: (earShape === 'floppy' ? 0.105 : earShape === 'pricked' ? 0.115 : 0.092) * H * hs * (g.type === 'bloodhound' || g.type === 'spaniel' ? 1.12 : 1),
      droop: 0, fluff: c,
    },
    mouth: {
      palate: [0, -0.04 * H * hs, (mz0 + mz1) / 2 * H * hs], palateR: [0.035 * mw * H * hs, 0.012 * H * hs, ML / 2 * H * hs + 0.02 * H * hs],
      tongue: [0, -0.004 * H * hs, (ML * 0.42 + 0.015) * H * hs], tongueR: [0.024 * mw * H * hs, 0.008 * H * hs, (ML * 0.4 + 0.01) * H * hs],
    },
    whiskers: null,
    pawH: 0.035 * H,
    stride: { walk: 1.45 * H, run: 2.9 * H },
    headPos, headScale: hs, tailLength: tailLen * H, muzzleLen: ML * H * hs, beard,
  });
}

function catRig(g: AnimalGenome, stage: AnimalStage): PetRig {
  const young = stage === 'young';
  const H = withersHeight(g, stage, 'cat');
  const b = g.build, c = g.coatLength;
  const P = (x: number, y: number, z: number): V3 => [x * H, y * H, z * H];
  const masses: Mass[] = [];
  const bones: Record<number, [V3, number]> = {};
  const len = (young ? 0.92 : 1.12) * lerp(0.97, 1.04, b);
  const wide = lerp(0.85, 1.22, b) * (young ? 1.14 : 1);
  const fluff = Math.max(0, c - 0.4);
  const legLen = young ? 0.82 : 1;
  const yLift = (1 - legLen) * 0.5;
  const Y = (y: number) => y - yLift;
  const Z = (z: number) => z * len;
  const wx = (x: number) => x * wide;

  bones[BONE.hips] = [P(0, Y(0.83), Z(-0.44)), -1];
  bones[BONE.spine] = [P(0, Y(0.84), Z(-0.06)), BONE.hips];
  bones[BONE.chest] = [P(0, Y(0.76), Z(0.3)), BONE.spine];
  bones[BONE.ribs] = [P(0, Y(0.72), Z(0.26)), BONE.chest];
  bones[BONE.neck] = [P(0, Y(0.84), Z(0.52)), BONE.chest];
  const hs = 1.55 * (young ? 1.32 : 1);
  const headPos = P(0, Y(1.02), Z(0.5) + 0.15);
  bones[BONE.head] = [headPos, BONE.neck];

  masses.push(ellipsoid(P(0, Y(0.7), Z(0.25)), P(wx(0.175), 0.25, 0.3 * len), BONE.ribs, T('torso')));
  for (const s of [-1, 1]) masses.push(ellipsoid(P(s * wx(0.072), Y(0.85), Z(0.42)), P(0.05 * wide, 0.11, 0.075), BONE.chest, T('torso'), 0.05 * H, [-0.55, 0, 0]));
  masses.push(ellipsoid(P(0, Y(0.62), Z(0.42)), P(wx(0.1), 0.12, 0.11), BONE.chest, T('torso'), 0.07 * H));
  masses.push(ellipsoid(P(0, Y(0.73), Z(-0.1)), P(wx(0.165), 0.215, 0.3), BONE.spine, T('torso'), 0.12 * H));
  // The loose belly fold cats carry between the hind legs.
  masses.push(ellipsoid(P(0, Y(0.6), Z(-0.27)), P(wx(0.12), 0.11 + b * 0.04, 0.18), BONE.spine, T('torso'), 0.08 * H, undefined, { influence: 1.6 }));
  masses.push(ellipsoid(P(0, Y(0.82), Z(-0.43)), P(wx(0.155), 0.155, 0.2), BONE.hips, T('torso'), 0.09 * H));
  if (fluff > 0) {
    masses.push(ellipsoid(P(0, Y(0.78), Z(0.48)), P(wx(0.15 + fluff * 0.05), 0.2 + fluff * 0.04, 0.12 + fluff * 0.05), BONE.chest, T('torso'), 0.08 * H));
    masses.push(ellipsoid(P(0, Y(0.74), Z(-0.12)), P(wx(0.16 + fluff * 0.04), 0.19, 0.32), BONE.spine, T('torso'), 0.1 * H, undefined, { influence: 0.4 }));
  }
  masses.push(capsule(P(0, Y(0.8), Z(0.46)), add(headPos, P(0, -0.03, -0.06)), (0.14 + fluff * 0.05) * H, (0.12 + fluff * 0.03) * H, BONE.neck, T('neck'), 0.07 * H));
  masses.push(capsule(P(0, Y(0.68), Z(0.5)), add(headPos, P(0, -0.1, 0.0)), (0.075 + fluff * 0.05) * H, (0.06 + fluff * 0.03) * H, BONE.neck, T('neck'), 0.06 * H));

  const legs: LegRig[] = [];
  const LY = (y: number) => y * legLen;
  const fx = 0.082 * wide, hx = 0.092 * wide;
  const r = 1.52 * lerp(0.88, 1.15, b) * (young ? 1.12 : 1) * H;
  for (const [leg, s, front] of [[0, 1, true], [1, -1, true], [2, 1, false], [3, -1, false]] as [number, number, boolean][]) {
    const j: [V3, V3, V3, V3] = front
      ? [P(s * fx, Y(0.63), Z(0.48)), P(s * (fx + 0.008), Y(0.43), Z(0.39)), P(s * (fx - 0.006), LY(0.1), Z(0.42)), P(s * (fx - 0.006), 0.033, Z(0.42) + 0.035)]
      : [P(s * hx, Y(0.8), Z(-0.49)), P(s * (hx + 0.012), Y(0.52), Z(-0.36)), P(s * (hx + 0.004), LY(0.27), Z(-0.62)), P(s * hx, 0.033, Z(-0.56))];
    const L = (a: V3, c2: V3) => Math.hypot(a[0] - c2[0], a[1] - c2[1], a[2] - c2[2]);
    legs.push({ side: s, front, joints: j, lengths: [L(j[0], j[1]), L(j[1], j[2]), L(j[2], j[3])] });
    const [u, mid, low, paw] = [legBone(leg, 0), legBone(leg, 1), legBone(leg, 2), legBone(leg, 3)];
    bones[u] = [j[0], front ? BONE.chest : BONE.hips];
    bones[mid] = [j[1], u];
    bones[low] = [j[2], mid];
    bones[paw] = [j[3], low];
    if (front) {
      masses.push(ellipsoid(add(j[0], P(s * 0.006, -0.085, -0.05)), [0.046 * r, 0.11 * H, 0.06 * r], u, T('leg'), 0.05 * H, [0.5, 0, 0]));
      masses.push(capsule(add(j[1], P(0, 0.015, -0.005)), add(j[2], P(0, 0.02, 0)), 0.045 * r, 0.031 * r, mid, T('leg'), 0.03 * H));
      masses.push(capsule(j[2], add(j[3], P(0, 0.01, -0.01)), 0.031 * r, 0.029 * r, low, T('leg', 'paw'), 0.018 * H));
    } else {
      masses.push(ellipsoid(add(j[0], P(s * 0.012, -0.11, 0.035)), [0.075 * r, 0.18 * H, 0.13 * H], u, T('leg'), 0.065 * H, [-0.4, 0, 0]));
      hamstring(masses, add(j[0], P(s * 0.01, -0.12, -0.08)), add(j[2], P(0, 0.06, -0.012)), 0.06 * r, 0.026 * r, u, mid, 0.05 * H, j[1][1]);
      masses.push(capsule(add(j[1], P(0, 0.01, -0.02)), add(j[2], P(0, 0.02, 0.005)), 0.05 * r, 0.026 * r, mid, T('leg'), 0.035 * H));
      masses.push(capsule(j[2], add(j[3], P(0, 0.01, -0.01)), 0.03 * r, 0.028 * r, low, T('leg', 'paw'), 0.018 * H));
    }
    pawMasses(masses, j[3], r * 0.95, paw, H, 0.92, true);
  }

  const tailLen = (g.tail === 'short' ? 0.25 : 1.15 + b * 0.05) * (young ? 0.72 : 1);
  const tailBase = P(0, Y(0.86), Z(-0.6));
  tailChain(masses, bones, tailBase, tailLen * H, (0.066 + fluff * 0.05) * H, (0.04 + fluff * 0.035) * H, H, 1);

  // Head: round skull, wide cheeks, short muzzle with whisker pads.
  const HP = (x: number, y: number, z: number): V3 => add(headPos, [x * H * hs, y * H * hs, z * H * hs]);
  const S = (x: number) => x * H * hs;
  masses.push(ellipsoid(HP(0, 0.035, 0.015), [S(0.13), S(0.12), S(0.13)], BONE.head, T('head')));
  for (const s of [-1, 1]) {
    masses.push(ellipsoid(HP(s * 0.07, -0.03, 0.06), [S(0.068 + fluff * 0.03), S(0.066), S(0.07)], BONE.head, T('head'), S(0.05)));
    masses.push(ellipsoid(HP(s * 0.03, -0.056, 0.146), [S(0.038), S(0.032), S(0.033)], BONE.head, T('head', 'muzzle'), S(0.035)));
    masses.push(ellipsoid(HP(s * 0.05, 0.078, 0.098), [S(0.04), S(0.02), S(0.03)], BONE.head, T('head', 'brow'), S(0.03)));
  }
  masses.push(capsule(HP(0, 0.05, 0.095), HP(0, -0.008, 0.162), S(0.04), S(0.024), BONE.head, T('head', 'muzzle'), S(0.04)));
  const eyes = [-1, 1].map(s => ({ pos: [s * S(0.056), S(0.028), S(0.122)] as V3, r: S(0.032 + (young ? 0.005 : 0)), yaw: s * 0.24 }));
  embedEyes(masses, headPos, eyes, 0.62, S(0.008));
  const jawHinge: V3 = [0, S(-0.06), S(0.07)];
  const jawMasses: Mass[] = [
    capsule([0, S(-0.008), 0], [0, S(-0.016), S(0.085)], S(0.04), S(0.024), 0, T('head', 'muzzle'), 0, 0.6),
  ];
  // The nose leather: a rounded triangle, broad at the top, sitting proud of the muzzle.
  const nr = S(0.023);
  const noseMasses: Mass[] = [
    ellipsoid([0, nr * 0.15, 0], [nr * 1.3, nr * 0.6, nr * 0.75], 0, 0, 0, [0.45, 0, 0]),
    ellipsoid([0, -nr * 0.35, nr * 0.05], [nr * 0.55, nr * 0.5, nr * 0.6], 0, 0, nr * 0.6, [0.3, 0, 0]),
    carve([nr * 0.52, -nr * 0.15, nr * 0.7], nr * 0.24, nr * 0.2, 0),
    carve([-nr * 0.52, -nr * 0.15, nr * 0.7], nr * 0.24, nr * 0.2, 0),
  ];
  noseMasses.forEach(n => { n.a = add(n.a, [0, S(0.0), S(0.181)]); });
  return finish({
    species: 'cat', H, bones, masses, legs, jawHinge, jawMasses, noseMasses, eyes,
    ear: { shape: 'cat', base: [S(0.072), S(0.11), S(0.0)], length: S(0.17), width: S(0.14), droop: 0, fluff: c },
    mouth: { palate: [0, S(-0.055), S(0.11)], palateR: [S(0.03), S(0.01), S(0.04)], tongue: [0, S(-0.01), S(0.05)], tongueR: [S(0.022), S(0.007), S(0.035)] },
    whiskers: [0, S(-0.05), S(0.155)],
    pawH: 0.033 * H,
    stride: { walk: 1.7 * H, run: 3.1 * H },
    headPos, headScale: hs, tailLength: tailLen * H, muzzleLen: S(0.04), beard: false,
  });
}

/**
 * The back of the thigh down to the hock, in two halves: the upper half moves with the thigh bone
 * and the lower with the shin, so the crotch never follows the swinging lower leg.
 */
function hamstring(masses: Mass[], a: V3, b: V3, ra: number, rb: number, thigh: number, shin: number, k: number, stifleY: number): void {
  // Split where the line passes the stifle's height: above it is thigh, below it is shin.
  const t = THREE_clamp((a[1] - stifleY) / (a[1] - b[1] || 1), 0.2, 0.8);
  const m: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rm = ra + (rb - ra) * t;
  masses.push(capsule(a, m, ra, rm, thigh, T('leg'), k, 1, { influence: 0.7 }));
  masses.push(capsule(m, b, rm, rb, shin, T('leg'), k * 0.5, 1, { influence: 0.7 }));
}

function pawMasses(masses: Mass[], at: V3, r: number, bone: number, H: number, size: number, cat = false): void {
  const p = (x: number, y: number, z: number): V3 => [at[0] + x * H, at[1] + y * H, at[2] + z * H];
  const s = size * r / H;
  masses.push(ellipsoid(p(0, -0.004, 0.012 * s / 1), [0.044 * s * H, 0.026 * s * H, 0.055 * s * H], bone, T('leg', 'paw'), 0.02 * H));
  const toes = cat ? [-0.024, -0.008, 0.008, 0.024] : [-0.026, -0.009, 0.009, 0.026];
  for (const x of toes) masses.push(ellipsoid(p(x * s, -0.008 * s, (0.05 - Math.abs(x) * 0.6) * s), [0.016 * s * H, 0.02 * s * H, 0.02 * s * H], bone, T('leg', 'paw'), 0.012 * H * s));
}

function tailChain(masses: Mass[], bones: Record<number, [V3, number]>, base: V3, length: number, r0: number, r1: number, H: number, plume: number): void {
  // Rest shape: out from the croup, then hanging in a gentle curve.
  let p = base;
  let angle = 0.35; // radians below horizontal, increasing toward the tip
  const seg = length / TAIL_BONES;
  for (let i = 0; i < TAIL_BONES; i++) {
    bones[BONE.tail + i] = [p, i === 0 ? BONE.hips : BONE.tail + i - 1];
    const next: V3 = [0, p[1] - Math.sin(angle) * seg, p[2] - Math.cos(angle) * seg];
    const t0 = i / TAIL_BONES, t1 = (i + 1) / TAIL_BONES;
    const rad = (t: number) => lerp(r0, r1, Math.pow(t, 0.9)) * (plume > 1 ? 1 + Math.sin(t * Math.PI) * 0.35 : 1);
    masses.push(capsule(p, next, rad(t0), rad(t1), BONE.tail + i, T('tail'), i === 0 ? 0.06 * H : 0, 1, { soft: seg * 0.35 }));
    p = next;
    angle += 0.1;
  }
}

/**
 * Seat each eyeball in the face: march from inside the skull along the gaze until the surface,
 * then sink the eye so only its front shows, and carve a socket for it.
 */
function embedEyes(masses: Mass[], headPos: V3, eyes: { pos: V3; r: number; yaw: number }[], depth: number, k: number): void {
  const solid = masses.filter(m => m.kind !== 2);
  for (const e of eyes) {
    const dir: V3 = [Math.sin(e.yaw), 0, Math.cos(e.yaw)];
    const start = add(headPos, [e.pos[0] - dir[0] * e.r * 3, e.pos[1], e.pos[2] - dir[2] * e.r * 3]);
    let t = 0;
    const step = e.r * 0.05;
    while (t < e.r * 12 && fieldAt(solid, start[0] + dir[0] * t, start[1], start[2] + dir[2] * t) < 0) t += step;
    const surface: V3 = [start[0] + dir[0] * t, start[1], start[2] + dir[2] * t];
    const centre: V3 = [surface[0] - dir[0] * e.r * depth, surface[1], surface[2] - dir[2] * e.r * depth];
    e.pos = [centre[0] - headPos[0], centre[1] - headPos[1], centre[2] - headPos[2]];
    // Lid pads above and below bring the face forward round the eye, so it sits in the face
    // instead of bulging out of it.
    const r = e.r, at = (u: number, v: number, w: number): V3 => [centre[0] + dir[0] * w + dir[2] * u, centre[1] + v, centre[2] + dir[2] * w - dir[0] * u];
    masses.push(ellipsoid(at(0, r * 0.74, r * 0.0), [r * 0.95, r * 0.3, r * 0.6], BONE.head, 1 << 3, r * 0.4, [0, e.yaw, 0]));
    masses.push(ellipsoid(at(0, -r * 0.76, r * 0.0), [r * 0.95, r * 0.32, r * 0.6], BONE.head, 1 << 3, r * 0.4, [0, e.yaw, 0]));
    masses.push(carve(centre, r * 1.03, k, BONE.head));
  }
}

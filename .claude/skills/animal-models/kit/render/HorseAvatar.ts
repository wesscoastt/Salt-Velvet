import * as THREE from 'three';
import type { AnimalActivity, AnimalGenome } from '../sim/animals/Animal.ts';
import type { AnimalStage } from '../sim/animals/Species.ts';
import { doses } from '../sim/animals/horseLooks.ts';
import { mixColor } from '../sim/family/genetics.ts';
import { horseBodyIndices, horseBodyPositions } from './horseBodyMesh.ts';

/**
 * A horse, built on the original connected sculpt from scripts/build-horse-body.py (authored at
 * 1.52 m at the withers, ground at y = 0, forward +Z) and skinned at runtime to its own rig:
 *
 *   body → neck (base) → neck (mid) → head (→ ears, eyes, forelock)
 *        → per leg: upper (shoulder / hip) → lower (knee / hock) → pastern + hoof
 *        → tail chain (dock, then the long hair)
 *
 * Legs are placed by two-bone IK on hoof targets, so hooves stay planted through a four-beat walk
 * (left hind, left fore, right hind, right fore) and a two-beat diagonal trot, with the body
 * settling over the supporting legs, the head nodding at the walk, and knees and hocks folding in
 * the swing. Idle horses shift their weight and rest a hind hoof, flick their ears and swish their
 * tails; grazing lowers the head to the grass with a foreleg forward; a dozing horse sleeps on its
 * feet. Coats (bay, chestnut, black, grey and dapple grey, palomino, buckskin, cremello, white,
 * appaloosa) are painted procedurally in the shader from the rest-pose position, so dapples,
 * spots, socks and facial white sit on the skin wherever it bends; mane and tail are darker or
 * flaxen hair strips. Forward is local +Z, like every other model in the game.
 */

const REF_WITHERS = 1.52;
/** Height of the body bone (model units) for a horse lying down or rolling: the belly on the grass. */
const LIE_BONE = 0.36;
/** Fold of fore and hind legs lying down (upper, lower, pastern): forearms reaching forward with the cannons folded back under the chest; hocks out behind with the cannons forward under the belly. */
const LIE_FORE: [number, number, number] = [-1, 2.8, 0.6];
/**
 * Lying, each hind leg (left, right) folded as a horse's is: the thigh forward along the belly (the
 * stifle up by the flank), the gaskin back down to the hock on the grass below the hip, and the
 * cannon forward under the belly. Angles found by search on the rig, measured (tests).
 */
const LIE_HIND: [number, number, number][] = [[-2.1, -2.3, 0.3], [-1.95, -2.3, 0.3]];
const LIE_STIFLE = [2.7, 2.7];
type Habit = 'paw' | 'shake' | 'toss' | 'scratch' | 'stamp';
/** How often each habit comes up while a horse stands about, and how long it lasts (seconds). */
const HABITS: { kind: Habit; weight: number; len: [number, number] }[] = [
  { kind: 'paw', weight: 2, len: [2.2, 3.5] },
  { kind: 'shake', weight: 1, len: [1.1, 1.4] },
  { kind: 'toss', weight: 2, len: [0.9, 1.3] },
  { kind: 'scratch', weight: 2, len: [2.5, 4] },
  { kind: 'stamp', weight: 1.5, len: [0.7, 0.9] },
];
/** What a horse may watch someone during, and how far round its neck and head bring its eyes. */
const HORSE_LOOKING = new Set<AnimalActivity>(['idle', 'wag', 'play', 'groom', 'shy', 'lie']);
const HORSE_LOOK_YAW = 1.1;
/** Squaring up after a halt: seconds for each step, and how far off its mark a hoof may be left (model units). */
const HALT_STEP = 0.42, HALT_SLACK = 0.05;
/** Seconds between a grazing horse's steps to the next mouthful, and the step itself. */
const GRAZE_STEP = 9, GRAZE_STEP_LEN = 0.7;
/** Seconds to lie down or get up. */
const LIE_TIME = 2.6;
/** Lying down the tail is swept back to trail over the grass rather than hang through the ground. */
const LIE_TAIL = 0.72;

/** Height at the withers in metres. */
export function horseWithers(g: AnimalGenome, stage: AnimalStage): number {
  const adult = 1.36 + g.size * 0.26;
  return stage === 'young' ? adult * 0.68 : adult;
}

/** Height of the saddle (the back just behind the withers) in metres: where a rider sits. */
export function horseSaddleHeight(g: AnimalGenome, stage: AnimalStage): number {
  return horseWithers(g, stage) * (1.42 / REF_WITHERS);
}

type V3 = [number, number, number];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Grazing, how far the head is up (0…1): about four seconds in every fifteen, chewing and looking about. */
const grazeLookUp = (t: number) => {
  const p = ((t % 15) + 15) % 15;
  return p < 11 ? 0 : Math.min(1, (p - 11) / 0.8, (15 - p) / 0.8);
};
/** Hermite smoothstep that also runs downhill when e0 > e1. */
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const ang = (y: number, z: number) => Math.atan2(z, y);

// --- Rig (authored coordinates) ---------------------------------------------------------------
const BODY: V3 = [0, 1.1, 0];
const NECK1: V3 = [0, 1.3, 0.66];
const NECK2: V3 = [0, 1.58, 0.94];
const HEAD: V3 = [0, 1.9, 1.17];
const TAIL_ROOT: V3 = [0, 1.39, -0.86];

interface LegDef {
  x: number;
  front: boolean;
  upper: V3;
  lower: V3;
  pastern: V3;
}

/** Front left, front right, hind left, hind right (+X is the horse's left). */
const LEGS: LegDef[] = [
  { x: 0.15, front: true, upper: [0.15, 1.2, 0.56], lower: [0.15, 0.48, 0.575], pastern: [0.15, 0.165, 0.573] },
  { x: -0.15, front: true, upper: [-0.15, 1.2, 0.56], lower: [-0.15, 0.48, 0.575], pastern: [-0.15, 0.165, 0.573] },
  { x: 0.16, front: false, upper: [0.16, 1.15, -0.55], lower: [0.16, 0.555, -0.712], pastern: [0.16, 0.165, -0.694] },
  { x: -0.16, front: false, upper: [-0.16, 1.15, -0.55], lower: [-0.16, 0.555, -0.712], pastern: [-0.16, 0.165, -0.694] },
];

/**
 * The hind legs' stifles (the horse's knee, at the front of the thigh below the barrel): a joint
 * between the hip and the hock, so lying down the thigh can come forward along the belly while the
 * gaskin folds back. Standing and moving it stays straight.
 */
const STIFLE_Y = 0.95;
/** Bone indices of the two stifles (after the body, neck, head and the four legs' three bones). */
const STIFLE_BONE = [16, 17];

/** Where the hind leg's axis runs at height y (gaskin slopes back to the hock, cannon is upright). */
function hindAxisZ(y: number): number {
  if (y >= 0.93) return -0.53;
  if (y >= 0.555) return -0.712 + ((y - 0.555) / (0.93 - 0.555)) * (0.712 - 0.55);
  return -0.7;
}

/**
 * Skin weights for a rest-pose point: bone indices into
 * [body, neck1, neck2, head, FL upper, FL lower, FL pastern, FR…, HL…, HR…].
 */
export function horseSkinWeights(x: number, y: number, z: number): { i: V3 | [number, number, number, number]; w: [number, number, number, number] } {
  if (z > 0.4 && y > 0.9) {
    // Along the neck, measured from the plane through the withers and the point of the shoulder.
    const s1 = (y - 1.48 + (z - 0.42)) * Math.SQRT1_2;
    const n = smooth(0.02, 0.18, s1);
    if (n > 0) {
      const m = smooth(0.3, 0.55, s1);
      // Beyond the throatlatch line through the poll: the head.
      const s2 = (y - 1.92) * -0.316 + (z - 1.17) * 0.949;
      const h = smooth(-0.04, 0.06, s2) * smooth(0.55, 0.7, s1);
      return { i: [0, 1, 2, 3], w: [1 - n, n * (1 - m), n * m * (1 - h), n * m * h] };
    }
  }
  const ax = Math.abs(x);
  let leg = 0;
  let idx = 0;
  let wB = 0;
  let wC = 0;
  if (z > 0.2) {
    const r = Math.hypot(ax - 0.15, z - 0.578);
    leg = smooth(0.98, 0.8, y) * smooth(0.04, 0.1, ax) * smooth(0.2, 0.12, r);
    idx = x > 0 ? 0 : 1;
    wB = smooth(0.53, 0.43, y);
    wC = smooth(0.21, 0.13, y);
  } else if (z < -0.25) {
    const r = Math.hypot(ax - 0.16, z - hindAxisZ(y));
    leg = smooth(1.02, 0.8, y) * smooth(0.05, 0.11, ax) * smooth(0.25, 0.15, r);
    idx = x > 0 ? 2 : 3;
    wB = smooth(0.61, 0.5, y);
    wC = smooth(0.21, 0.13, y);
  }
  // The lower legs are all leg, however the radial falloff reads near the hoof.
  if (y < 0.75 && ax > 0.06 && (z > 0.35 || z < -0.4)) leg = Math.max(leg, smooth(0.75, 0.6, y));
  if (leg <= 0) return { i: [0, 0, 0, 0], w: [1, 0, 0, 0] };
  const b = 4 + idx * 3;
  if (idx >= 2) {
    // A hind leg: hip, stifle, hock, pastern. Four influences at most, so above the hock the
    // pastern is dropped (it has no weight there) and below the stifle the hip is.
    const S = STIFLE_BONE[idx - 2];
    const wS = smooth(STIFLE_Y + 0.05, STIFLE_Y - 0.06, y);
    if (wC <= 0) return { i: [0, b, S, b + 1], w: [1 - leg, leg * (1 - wS), leg * wS * (1 - wB), leg * wS * wB] };
    return { i: [0, S, b + 1, b + 2], w: [1 - leg, leg * (1 - wB), leg * wB * (1 - wC), leg * wB * wC] };
  }
  return { i: [0, b, b + 1, b + 2], w: [1 - leg, leg * (1 - wB), leg * wB * (1 - wC), leg * wB * wC] };
}

/**
 * How far the neck's surface stands out to one side (|x|, rest units) at a height and depth: the
 * widest body vertex in a small window there. For laying the mane's fall over the neck, not in it.
 */
const neckWidthCache = new Map<string, number>();
function neckSide(y: number, z: number): number {
  const key = `${Math.round(y * 100)}|${Math.round(z * 100)}`;
  const known = neckWidthCache.get(key);
  if (known !== undefined) return known;
  const P = horseBodyPositions;
  let w = 0;
  for (let i = 0; i < P.length; i += 3) {
    if (Math.abs(P[i + 1] - y) < 0.025 && Math.abs(P[i + 2] - z) < 0.035) w = Math.max(w, Math.abs(P[i]));
  }
  neckWidthCache.set(key, w);
  return w;
}

/** Crest line of the neck (withers → poll), found once from the sculpt for the mane. */
let crestCache: { p: V3; s: number }[] | null = null;
function crest(): { p: V3; s: number }[] {
  if (crestCache) return crestCache;
  const bins: ({ p: V3; score: number; s: number } | null)[] = new Array(26).fill(null);
  const P = horseBodyPositions;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (Math.abs(x) > 0.025 || z < 0.3 || y < 1.3) continue;
    const s = (y - 1.48 + (z - 0.42)) * Math.SQRT1_2;
    if (s < 0.06 || s > 0.84) continue;
    // Up and back of the neck's centre line.
    const score = (y - 1.48) * 0.65 - (z - 0.42) * 0.76;
    const b = Math.min(25, Math.floor(((s - 0.06) / 0.78) * 26));
    if (!bins[b] || score > bins[b]!.score) bins[b] = { p: [0, y, z], score, s };
  }
  crestCache = bins.filter((b): b is { p: V3; score: number; s: number } => !!b).map((b) => ({ p: b.p, s: b.s }));
  return crestCache;
}

/**
 * Character for the head, sculpted over the base mesh (rest coordinates in, rest coordinates out).
 * The base head was a smooth cone running into the neck; a horse's head is a wedge: a deep, round
 * jowl with a notch behind it where the throat meets the neck, a broad flat forehead with the eyes
 * set out at its corners under a brow, a long straight bridge to the nose, and a full, soft muzzle
 * with flared nostrils and a chin. Measured down the face from the poll (t, 0 → 1 at the muzzle),
 * across it (u, forehead → jaw) and out to the side (x).
 */
const POLL_Y = 1.985, POLL_Z = 1.12, HEAD_LEN = 0.725;
const DOWN: [number, number] = [-0.7104, 0.7038];
const ACROSS: [number, number] = [-0.7038, -0.7104];
const bell = (v: number, at: number, w: number) => Math.exp(-(((v - at) / w) ** 2));
export function sculptHead(x: number, y: number, z: number): V3 {
  if (z < 0.9 || y < 1.25) return [x, y, z];
  const dy = y - POLL_Y, dz = z - POLL_Z;
  const t = (dy * DOWN[0] + dz * DOWN[1]) / HEAD_LEN;
  if (t < -0.25) return [x, y, z];
  const u = dy * ACROSS[0] + dz * ACROSS[1];
  const ax = Math.abs(x), sx = Math.sign(x) || 1;
  const side = smooth(0.015, 0.07, ax);
  let X = x, du = 0, dt = 0;
  // Jowl: the round cheek bulges out to the sides, and its lower edge drops into a deep curve.
  X += sx * 0.02 * side * bell(t, 0.3, 0.14) * bell(u, 0.13, 0.1);
  du += 0.02 * bell(t, 0.3, 0.1) * smooth(0.08, 0.2, u);
  // A broad, flat forehead between the eyes, and a brow over each eye.
  X *= 1 + 0.24 * bell(t, 0.27, 0.14) * smooth(0.09, -0.05, u);
  X += sx * 0.015 * side * bell(t, 0.33, 0.06) * bell(u, -0.03, 0.035);
  // The bridge of the nose slims; the muzzle fills out again, soft and round.
  X *= 1 - 0.1 * bell(t, 0.64, 0.12) + 0.11 * bell(t, 0.94, 0.08);
  // Flared nostrils on the front of the muzzle; the chin and lower lip beneath.
  const nostril = bell(t, 0.98, 0.05) * bell(u, -0.01, 0.035) * bell(ax, 0.045, 0.025);
  X += sx * 0.012 * nostril;
  du -= 0.01 * nostril;
  du += 0.016 * bell(t, 0.95, 0.05) * smooth(0.06, 0.11, u);
  // Never pull at the neck: everything fades out above the poll and down the throat.
  const k = smooth(-0.22, -0.02, t);
  X = x + (X - x) * k;
  du *= k;
  dt *= k;
  return [X, y + du * ACROSS[0] + dt * DOWN[0], z + du * ACROSS[1] + dt * DOWN[1]];
}

/** Eye position on the sculpt (the widest point of the head at eye level). */
let eyeCache: V3 | null = null;
function eyeSpot(): V3 {
  if (eyeCache) return eyeCache;
  const P = horseBodyPositions;
  let best: V3 = [0.1, 1.8, 1.3];
  for (let i = 0; i < P.length; i += 3) {
    if (Math.abs(P[i + 1] - 1.795) < 0.03 && Math.abs(P[i + 2] - 1.31) < 0.035 && P[i] > best[0]) best = [P[i], P[i + 1], P[i + 2]];
  }
  eyeCache = best;
  return best;
}

// --- Coat shader -------------------------------------------------------------------------------
const COAT_VERTEX_HEAD = /* glsl */ `
attribute vec3 aRest;
varying vec3 vRest;
uniform float uBreath;
`;
/** Breathing: the ribs and flank swell along the surface, most behind the shoulder, none at the spine or legs. */
const COAT_BREATH = /* glsl */ `
  {
    float ribs = smoothstep(0.72, 0.92, aRest.y) * (1.0 - smoothstep(1.22, 1.38, aRest.y))
      * (1.0 - smoothstep(0.22, 0.5, abs(aRest.z + 0.02))) * smoothstep(0.04, 0.14, abs(aRest.x) + (1.0 - smoothstep(0.75, 0.86, aRest.y)) * 0.2);
    transformed += objectNormal * uBreath * ribs;
  }
`;
const COAT_FRAGMENT_HEAD = /* glsl */ `
varying vec3 vRest;
uniform vec3 uCoat;
uniform vec3 uPoints;
uniform vec3 uPale;
uniform vec3 uWhite;
uniform vec3 uSkin;
uniform vec3 uPink;
uniform vec3 uHoof;
uniform vec3 uPaleHoof;
uniform vec4 uSocks;
uniform float uFace;
uniform float uPattern;
uniform float uPointsAmt;
uniform float uAge;
float hFurH;
float hRough = 0.52;
float hBare = 0.0;
vec3 hHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float hWorley(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d = 8.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 r = g + hHash(i + g) - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
float hNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hHash(i).x, b = hHash(i + vec3(1, 0, 0)).x, c = hHash(i + vec3(0, 1, 0)).x, d = hHash(i + vec3(1, 1, 0)).x;
  float e = hHash(i + vec3(0, 0, 1)).x, g = hHash(i + vec3(1, 0, 1)).x, h = hHash(i + vec3(0, 1, 1)).x, k = hHash(i + vec3(1, 1, 1)).x;
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
vec3 horseCoat() {
  vec3 p = vRest;
  float ax = abs(p.x);
  vec3 c = uCoat;
  // Darker along the top line, lighter on the belly and flank (countershading).
  c *= 1.0 - 0.13 * smoothstep(1.22, 1.5, p.y) * (1.0 - smoothstep(0.6, 0.95, p.z));
  c *= 1.0 + 0.1 * smoothstep(0.98, 0.76, p.y) * smoothstep(-0.4, 0.0, p.z) * (1.0 - smoothstep(0.35, 0.55, p.z));
  // A living coat is never one flat colour: broad, soft shifts of tone, a bloom of sheen over the
  // shoulder and the quarters where the muscle rounds, and a shadowed hollow at the flank.
  c *= 0.92 + 0.16 * hNoise(p * 2.3 + 7.0);
  float shoulder = 1.0 - smoothstep(0.0, 0.3, length((p - vec3(sign(p.x) * 0.22, 1.22, 0.5)) * vec3(1.6, 1.0, 1.3)));
  float quarter = 1.0 - smoothstep(0.0, 0.34, length((p - vec3(sign(p.x) * 0.24, 1.28, -0.55)) * vec3(1.6, 1.0, 1.1)));
  float hollow = 1.0 - smoothstep(0.0, 0.2, length((p - vec3(sign(p.x) * 0.26, 1.12, -0.18)) * vec3(1.8, 1.0, 1.0)));
  c *= 1.0 + 0.14 * max(shoulder, quarter) - 0.11 * hollow;
  // The head: beyond the throatlatch line through the poll.
  vec2 hp = p.yz - vec2(1.93, 1.15);
  float s1 = (p.y - 1.48 + (p.z - 0.42)) * 0.7071;
  float s2 = (p.y - 1.92) * -0.316 + (p.z - 1.17) * 0.949;
  float head = smoothstep(-0.02, 0.04, s2) * smoothstep(0.55, 0.7, s1) * step(0.9, p.z);
  float t = dot(hp, vec2(-0.734, 0.679)) / 0.70;
  float front = dot(hp, vec2(0.679, 0.734));
  // Lower legs (below the knees and hocks).
  bool fore = p.z > 0.0;
  float legs = step(0.05, ax) * (fore ? smoothstep(0.62, 0.46, p.y) : smoothstep(0.68, 0.52, p.y)) * step(p.y, 0.8);
  c = mix(c, uPoints, legs * uPointsAmt);
  float body = smoothstep(0.62, 0.9, p.y) * (1.0 - head);
  if (uPattern > 0.5 && uPattern < 1.5) {
    // Dapples: pale rounds with darker rims over the body, fading on the legs and face.
    float w = hWorley(p * 10.0);
    c = mix(c, uPale, smoothstep(0.5, 0.26, w) * body * 0.85);
    c *= 1.0 - 0.12 * smoothstep(0.62, 0.5, w) * smoothstep(0.3, 0.48, w) * body;
    c = mix(c, uPale, head * 0.35);
  }
  if (uPattern > 1.5) {
    // Appaloosa: a white blanket over the loin and hindquarters with spots of the base colour
    // (a leopard is white all over).
    float edge = (hNoise(p * 6.0) - 0.5) * 0.12;
    float blanket = uPattern > 2.5 ? body : smoothstep(-0.02, -0.28, p.z + (1.25 - p.y) * 0.5 + edge) * smoothstep(0.92, 1.12, p.y);
    float spot = smoothstep(0.26, 0.18, hWorley(p * 11.0 + 3.1));
    c = mix(c, mix(uWhite, uCoat, spot), blanket);
  }
  // White on the face.
  float onFace = head * smoothstep(0.015, 0.04, front);
  float white = 0.0;
  float wob = (hNoise(p * 40.0) - 0.5) * 0.008;
  if (uFace > 0.5 && uFace < 1.5) white = smoothstep(0.03, 0.02, ax + abs(t - 0.24) * 0.3 + wob) * step(0.12, t) * step(t, 0.36);
  if (uFace > 1.5 && uFace < 2.5) white = smoothstep(0.026, 0.016, ax + wob) * smoothstep(0.84, 0.88, t);
  if (uFace > 2.5 && uFace < 3.5) white = max(smoothstep(0.03, 0.02, ax + abs(t - 0.24) * 0.3 + wob) * step(0.12, t) * step(t, 0.36), smoothstep(0.018, 0.011, ax + wob) * step(0.3, t) * step(t, 0.86));
  if (uFace > 3.5) white = smoothstep(0.046 + t * 0.012, 0.034 + t * 0.012, ax + wob) * step(0.1, t);
  white *= onFace;
  // Socks and stockings.
  int leg = fore ? (p.x > 0.0 ? 0 : 1) : (p.x > 0.0 ? 2 : 3);
  float sh = leg == 0 ? uSocks.x : leg == 1 ? uSocks.y : leg == 2 ? uSocks.z : uSocks.w;
  float sock = sh > 0.0 ? step(0.05, ax) * smoothstep(sh + 0.012, sh - 0.012, p.y + (hNoise(p * 30.0) - 0.5) * 0.04) : 0.0;
  white = max(white, sock);
  c = mix(c, uWhite, white);
  // Elders grey around the eyes and muzzle.
  c = mix(c, uWhite * 0.85, uAge * head * smoothstep(0.3, 0.0, abs(t - 0.2)) * 0.5);
  // The soft, dark skin of the muzzle (pink under white), and the nostrils.
  float muzzle = head * smoothstep(0.8, 0.93, t);
  c = mix(c, mix(uSkin, uPink, white), muzzle * 0.8);
  // Nostrils: big commas on the front of the muzzle, running down the face and curling out at the top.
  vec2 hd = vec2(p.y - 1.985, p.z - 1.12);
  float ht = dot(hd, vec2(-0.7104, 0.7038)) / 0.725;
  float hu = dot(hd, vec2(-0.7038, -0.7104));
  vec2 nq = vec2((ax - 0.04 - max(0.0, 0.985 - ht) * 0.35) / 0.014, (ht - 0.99) / 0.04);
  float nost = smoothstep(1.0, 0.6, length(nq)) * smoothstep(0.045, 0.0, hu);
  c = mix(c, uSkin * 0.45, nost * head);
  // Hooves: dark horn, pale under a white leg.
  float hoof = smoothstep(0.092, 0.078, p.y) * step(0.05, ax);
  c = mix(c, mix(uHoof, uPaleHoof, sock), hoof);
  // The coat's hair lies toward the tail over the body and down the legs: a sleek grain and soft
  // sweeps along it, so the coat catches the light like hair rather than plastic.
  float legW = smoothstep(0.92, 0.74, p.y) * (1.0 - head);
  vec3 fl = normalize(mix(vec3(0.0, -0.25, -1.0), vec3(0.0, -1.0, 0.05), legW));
  vec3 ax2 = normalize(cross(fl, vec3(1.0, 0.0, 0.0)));
  vec3 q = vec3(dot(p, fl), dot(p, ax2), dot(p, cross(fl, ax2)));
  float px = length(fwidth(p));
  float sweep = hNoise(q * vec3(5.0, 26.0, 26.0) + 3.0);
  float grain = hNoise(q * vec3(22.0, 150.0, 150.0) + 9.0) * (1.0 - smoothstep(0.004, 0.012, px));
  float bare = max(hoof, muzzle);
  c *= 1.0 + ((sweep - 0.5) * 0.13 + (grain - 0.5) * 0.12) * (1.0 - bare);
  // The hollows round the eyes and under the cheekbone sit in shadow.
  float eyeRing = head * (1.0 - smoothstep(0.0, 0.07, length(vec2(ax - 0.075, (t - 0.2) * 0.6))));
  c *= 1.0 - 0.12 * eyeRing * (1.0 - white);
  hFurH = (sweep * 0.7 + grain * 0.2) * (1.0 - bare);
  // A groomed short coat is glossy; the hair is a little duller down the legs, the muzzle and hooves
  // matte.
  hRough = mix(0.36, 0.5, legW) + (sweep - 0.5) * 0.1;
  hRough = mix(hRough, 0.75, bare);
  hBare = bare;
  return c;
}
`;

/** Light bump from the coat's hair sweeps (screen-space, like the pets' fur). */
const COAT_BUMP = /* glsl */ `
{
  vec3 dpx = dFdx(-vViewPosition);
  vec3 dpy = dFdy(-vViewPosition);
  float hx = dFdx(hFurH);
  float hy = dFdy(hFurH);
  vec3 r1 = cross(dpy, normal);
  vec3 r2 = cross(normal, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  normal = normalize(abs(det) * normal - grad * 0.0022);
}
`;

/** The satin sheen of a short coat: the hair catches the light where the body turns away from the eye. */
const COAT_SHEEN = /* glsl */ `
{
  float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  diffuseColor.rgb *= mix(1.0, mix(1.28, 0.96, pow(ndv, 0.6)), 1.0 - hBare);
}
`;

function coatMaterial(g: AnimalGenome, stage: AnimalStage): THREE.MeshStandardMaterial {
  const genes = g.genes ?? '';
  const leopard = doses(genes, 'L') === 2;
  const pattern = g.pattern === 'dappled' ? 1 : g.pattern === 'spotted' ? (leopard ? 3 : 2) : 0;
  const coat = new THREE.Color(g.coat);
  const points = new THREE.Color(g.secondary);
  // Dark points (bay, buckskin, dapple grey) show; a chestnut's "points" are its own colour.
  const pointsAmt = coat.getHSL({ h: 0, s: 0, l: 0 }).l - points.getHSL({ h: 0, s: 0, l: 0 }).l > 0.06 ? 1 : 0.4;
  const socks = (g.socks ?? '0000').split('').map((v) => (v === '2' ? 0.44 : v === '1' ? 0.2 : 0));
  const face = ['none', 'star', 'snip', 'stripe', 'blaze'].indexOf(g.face ?? 'none');
  const greyCoat = g.pattern === 'dappled' || (genes && doses(genes, 'G') > 0 && stage !== 'young');
  const uniforms = {
    uCoat: { value: coat },
    uPoints: { value: points },
    uPale: { value: new THREE.Color(mixColor(g.coat, '#efede8', 0.62)) },
    uWhite: { value: new THREE.Color('#f1eee8') },
    uSkin: { value: new THREE.Color(greyCoat || g.coat === '#eeece6' ? '#3a3433' : '#2a2321') },
    uPink: { value: new THREE.Color('#c9998c') },
    uHoof: { value: new THREE.Color('#2e2925') },
    uPaleHoof: { value: new THREE.Color('#a8977a') },
    uSocks: { value: new THREE.Vector4(socks[0], socks[1], socks[2], socks[3]) },
    uFace: { value: Math.max(0, face) },
    uPattern: { value: pattern },
    uPointsAmt: { value: pointsAmt },
    uAge: { value: stage === 'elder' ? 1 : 0 },
    uBreath: { value: 0 },
  };
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.52, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = COAT_VERTEX_HEAD + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRest = aRest;' + COAT_BREATH);
    shader.fragmentShader = COAT_FRAGMENT_HEAD + shader.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = horseCoat();')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = hRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + COAT_BUMP + COAT_SHEEN);
  };
  m.customProgramCacheKey = () => 'kynds-horse-coat-5';
  m.userData.coatUniforms = uniforms;
  return m;
}

/** Hair for the mane and tail: fine strands of the mane colour, with lighter and darker locks. */
function hairMaterial(color: string): THREE.MeshStandardMaterial {
  const w = 64, h = 128;
  const px = new Uint8Array(w * h * 4);
  const base = new THREE.Color(color).convertLinearToSRGB();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const strand = 0.82 + 0.18 * Math.sin(x * 1.9 + Math.sin(x * 0.7) * 2) * Math.sin(x * 0.37 + 1.3);
    const lock = 0.92 + 0.08 * Math.sin(x * 0.23 + y * 0.01);
    const n = (y * w + x) * 4;
    const k = strand * lock;
    px[n] = Math.min(255, base.r * 255 * k);
    px[n + 1] = Math.min(255, base.g * 255 * k);
    px[n + 2] = Math.min(255, base.b * 255 * k);
    // Ragged tips: strands end at different lengths near the bottom of the texture.
    const end = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(x * 2.7 + Math.cos(x * 1.3) * 3));
    px[n + 3] = y / h < end ? 255 : 0;
  }
  const map = new THREE.DataTexture(px, w, h);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ map, roughness: 0.7, side: THREE.DoubleSide, alphaTest: 0.5 });
}

interface Look {
  neck1: number;
  neck2: number;
  head: number;
  turn: number;
  earPitch: number;
  earSpread: number;
  tailUp: number;
  tailSwish: number;
  eyes: number;
  roll: number;
  pitch: number;
  bodyY: number;
}

export class HorseAvatar {
  readonly root = new THREE.Group();
  readonly headAnchor = new THREE.Object3D();
  /** The tip of the muzzle (for checks and for where a hand holds out an apple). */
  readonly muzzle = new THREE.Object3D();
  /** Where a rider sits (top of the back behind the withers). */
  readonly saddle = new THREE.Object3D();
  readonly withers: number;
  private model = new THREE.Group();
  private body = new THREE.Bone();
  private neck1 = new THREE.Bone();
  private neck2 = new THREE.Bone();
  private head = new THREE.Bone();
  private legBones: THREE.Bone[][] = [];
  /** The hind legs' stifles (left, right): straight but when lying down. */
  private stifles: THREE.Bone[] = [];
  private tail: THREE.Bone[] = [];
  private ears: THREE.Group[] = [];
  private lids: THREE.Mesh[] = [];
  /** Rest geometry of each leg after shaping: pivot, knee/hock, fetlock (side plane y, z). */
  private legRest: { a: [number, number]; b: [number, number]; c: [number, number]; l1: number; l2: number; a1: number; a2: number; front: boolean }[] = [];
  private cur: Look;
  private legCur: [number, number, number][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  private walkPhase = 0;
  private trotPhase = 0;
  private lastDistance = -1;
  private gaitBlend = 0;
  private bodyBase: number;
  private blinkAt = 2;
  private restLeg = -1;
  private restUntil = 0;
  /** How far down it is (0 standing … 1 lying), and whether it's going down or getting up. */
  private lieT = 0;
  private lieGoingDown = true;
  /** A passing bit of business while standing about (see habits). */
  private habit: { kind: Habit; at: number; len: number; side: number } | null = null;
  private habitNext = 5 + Math.random() * 8;
  /** Where each hoof was last put down (side plane, model units), and a hoof stepping to its mark. */
  private planted = [0, 0, 0, 0];
  private plantedYet = false;
  /** Something to watch (world space) or null, how much the head is on it, and the turn toward it. */
  private lookTarget: THREE.Vector3 | null = null;
  private lookW = 0;
  private lookYaw = 0;
  /** How far turning on the spot has twisted each hoof out of place (model units), and the yaw last frame. */
  private twist = [0, 0, 0, 0];
  private lastYaw: number | null = null;
  private stepLeg = -1;
  private stepT = 0;
  private stepFrom = 0;
  private stepTo = 0;
  /** Breathing: the phase, how blown it is after a trot (0…1), and the coat's breath uniform. */
  private breathPhase = Math.random();
  private blown = 0;
  private coatUniforms: { uBreath: { value: number } } | null = null;
  /** How far the hindquarters are down (0…1), for the tail. */
  private hindDown = 0;
  private earFlick: [number, number] = [0, 0];
  private earFlickAt = 1.5;
  private swatAt = 3;
  private swatUntil = 0;
  private swatLength = 1;
  readonly scale: number;
  private foal: boolean;

  constructor(g: AnimalGenome, stage: AnimalStage) {
    const foal = stage === 'young';
    const elder = stage === 'elder';
    this.foal = foal;
    this.withers = horseWithers(g, stage);
    // Foals are leggy (legs nearly full length, a small body and a big head), not little horses.
    const legK = foal ? 1.28 : 1 - (g.build - 0.5) * 0.1;
    const kx = (0.92 + g.build * 0.16) * (foal ? 0.86 : 1);
    const headK = foal ? 1.16 : 0.96 + g.muzzle * 0.08;
    const restWithers = REF_WITHERS + 0.9 * (legK - 1);
    this.scale = this.withers / restWithers;
    const shape = (x: number, y: number, z: number, headW = 0): V3 => {
      let X = x * kx, Y = y, Z = z;
      if (headW > 0 && headK !== 1) {
        const k = 1 + (headK - 1) * headW;
        X = HEAD[0] + (X - HEAD[0]) * k;
        Y = HEAD[1] + (Y - HEAD[1]) * k;
        Z = HEAD[2] + (Z - HEAD[2]) * k;
      }
      // An old horse's back dips a little.
      if (elder) Y -= 0.035 * smooth(1.15, 1.38, y) * Math.max(0, 1 - (z / 0.42) ** 2);
      Y += (legK - 1) * Math.min(y, 0.9);
      return [X, Y, Z];
    };
    const J = (p: V3): V3 => shape(p[0], p[1], p[2]);

    this.root.add(this.model);
    this.model.scale.setScalar(this.scale);
    this.model.add(this.body);
    const bodyP = J(BODY);
    this.bodyBase = bodyP[1];
    this.body.position.set(bodyP[0], bodyP[1], bodyP[2]);
    const local = (p: V3, parent: V3): [number, number, number] => [p[0] - parent[0], p[1] - parent[1], p[2] - parent[2]];
    const n1 = J(NECK1), n2 = J(NECK2), hd = J(HEAD);
    this.neck1.position.set(...local(n1, bodyP));
    this.neck2.position.set(...local(n2, n1));
    this.head.position.set(...local(hd, n2));
    this.body.add(this.neck1);
    this.neck1.add(this.neck2);
    this.neck2.add(this.head);
    for (const leg of LEGS) {
      const u = J(leg.upper), l = J(leg.lower), p = J(leg.pastern);
      const bu = new THREE.Bone(), bl = new THREE.Bone(), bp = new THREE.Bone();
      bu.position.set(...local(u, bodyP));
      bp.position.set(...local(p, l));
      this.body.add(bu);
      if (leg.front) {
        bl.position.set(...local(l, u));
        bu.add(bl);
      } else {
        // The stifle, on the leg's line between the hip and the hock (straight, it changes nothing).
        const k = (leg.upper[1] - STIFLE_Y) / (leg.upper[1] - leg.lower[1]);
        const st = J([leg.x, STIFLE_Y, leg.upper[2] + (leg.lower[2] - leg.upper[2]) * k]);
        const bs = new THREE.Bone();
        bs.position.set(...local(st, u));
        bl.position.set(...local(l, st));
        bu.add(bs);
        bs.add(bl);
        this.stifles.push(bs);
      }
      bl.add(bp);
      this.legBones.push([bu, bl, bp]);
      const a: [number, number] = [u[1], u[2]], b: [number, number] = [l[1], l[2]], c: [number, number] = [p[1], p[2]];
      this.legRest.push({ a, b, c, l1: Math.hypot(b[0] - a[0], b[1] - a[1]), l2: Math.hypot(c[0] - b[0], c[1] - b[1]), a1: ang(b[0] - a[0], b[1] - a[1]), a2: ang(c[0] - b[0], c[1] - b[1]), front: leg.front });
    }
    const bones = [this.body, this.neck1, this.neck2, this.head, ...this.legBones.flat(), ...this.stifles];

    // --- The connected body ---------------------------------------------------------------------
    const P = horseBodyPositions;
    const count = P.length / 3;
    const pos = new Float32Array(P.length);
    const rest = new Float32Array(P.length);
    const si = new Uint16Array(count * 4);
    const sw = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      const wgt = horseSkinWeights(x, y, z);
      const sc = sculptHead(x, y, z);
      const s = shape(sc[0], sc[1], sc[2], wgt.i[3] === 3 ? wgt.w[3] : 0);
      pos.set(s, v * 3);
      rest.set([x, y, z], v * 3);
      si.set(wgt.i, v * 4);
      sw.set(wgt.w, v * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geo.setIndex(horseBodyIndices);
    geo.computeVertexNormals();
    const coat = coatMaterial(g, stage);
    this.coatUniforms = coat.userData.coatUniforms;
    const skin = new THREE.SkinnedMesh(geo, coat);
    skin.name = 'connected-horse-body';
    skin.frustumCulled = false;
    this.model.add(skin);

    // --- Mane and forelock: hair strips along the crest, skinned with the neck ----------------------
    const maneColor = g.mane || mixColor(g.coat, '#1a1512', 0.6);
    const hair = hairMaterial(maneColor);
    const strands: number[] = [], suv: number[] = [], sIdx: number[] = [], sSi: number[] = [], sSw: number[] = [];
    const addStrip = (pts: V3[], across: V3, width: number[], bone: { i: number[]; w: number[] }, u0: number) => {
      const base = strands.length / 3;
      pts.forEach((p, j) => {
        for (const side of [-1, 1]) {
          strands.push(p[0] + across[0] * width[j] * side, p[1] + across[1] * width[j] * side, p[2] + across[2] * width[j] * side);
          suv.push(u0 + (side + 1) * 0.12, j / (pts.length - 1));
          sSi.push(...bone.i);
          sSw.push(...bone.w);
        }
        if (j > 0) {
          const a = base + (j - 1) * 2;
          sIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
    };
    const rng = mulberry(Math.floor((g.size * 9973 + g.build * 7919 + g.muzzle * 104729) * 1000) + 7);
    const line = crest();
    const maneLen = (foal ? 0.08 : 0.17) + g.coatLength * 0.16;
    const side = -1; // Manes fall on the off (right) side.
    for (let k = 0; k < line.length; k++) {
      const c0 = line[Math.max(0, k - 1)].p, c1 = line[Math.min(line.length - 1, k + 1)].p;
      const ty = c1[1] - c0[1], tz = c1[2] - c0[2];
      const tl = Math.hypot(ty, tz) || 1;
      const across: V3 = [0, ty / tl, tz / tl];
      const root = line[k].p;
      const wgt = horseSkinWeights(root[0], root[1] - 0.04, root[2]);
      // Short at the withers and poll, longest along the middle of the neck.
      const along = line[k].s;
      const len = maneLen * (0.55 + 0.45 * Math.sin(Math.PI * clamp01((along - 0.05) / 0.8))) * (0.85 + rng() * 0.3);
      const pts: V3[] = [];
      for (let j = 0; j <= 5; j++) {
        const t = j / 5;
        // Over the crest and down the side of the neck, lying on it a little proud (the hair has
        // body), never inside it.
        const y = root[1] + 0.012 - len * t * t * 0.95 - t * 0.02, z = root[2] - 0.01 * t;
        const out = Math.max(0.012 + 0.07 * Math.sin(Math.min(1, t * 1.6) * Math.PI / 2) * (foal ? 0.7 : 1), neckSide(y, z) + 0.012 + 0.008 * t);
        const p = shape(root[0] + side * out, y, z, 0);
        pts.push(p);
      }
      const half = (tl / 2) * 1.5 + 0.012;
      addStrip(pts, across, [half, half, half * 0.95, half * 0.85, half * 0.7, half * 0.5], { i: [...wgt.i], w: [...wgt.w] }, rng() * 0.75);
      // The crest's own body of hair: it stands up off the ridge and tips over the near side, so
      // the mane has volume from both sides instead of reading as a line.
      const short: V3[] = [];
      const sl = len * (0.32 + rng() * 0.12);
      for (let j = 0; j <= 4; j++) {
        const t = j / 4;
        const out = 0.008 + 0.045 * Math.sin(Math.min(1, t * 1.4) * Math.PI / 2);
        short.push(shape(root[0] - side * out, root[1] + 0.03 * Math.sin(t * Math.PI * 0.6) + 0.006 - sl * t * t * 0.9, root[2] - 0.006 * t, 0));
      }
      addStrip(short, across, [half, half, half * 0.9, half * 0.7, half * 0.45], { i: [...wgt.i], w: [...wgt.w] }, rng() * 0.75);
    }
    // Forelock: falls from the poll over the forehead, between the ears.
    const poll = line[line.length - 1]?.p ?? [0, 1.98, 1.13];
    for (let f = -1; f <= 1; f++) {
      const pts: V3[] = [];
      const len = maneLen * 1.1;
      for (let j = 0; j <= 4; j++) {
        const t = j / 4;
        // Down the face (head axis −0.734, 0.679), lying on the forehead (normal 0.679, 0.734).
        const y = poll[1] + 0.01 - t * len * 0.734 + 0.03 * Math.sin(t * Math.PI) + 0.01;
        const z = poll[2] + 0.04 + t * len * 0.679 + 0.012;
        pts.push(shape(f * 0.018, y, z, 1));
      }
      addStrip(pts, [1, 0, 0], [0.03, 0.032, 0.03, 0.024, 0.014], { i: [0, 1, 2, 3], w: [0, 0, 0, 1] }, 0.3 + f * 0.2);
    }
    const maneGeo = new THREE.BufferGeometry();
    maneGeo.setAttribute('position', new THREE.Float32BufferAttribute(strands, 3));
    maneGeo.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2));
    maneGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sSi, 4));
    maneGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sSw, 4));
    maneGeo.setIndex(sIdx);
    maneGeo.computeVertexNormals();
    const mane = new THREE.SkinnedMesh(maneGeo, hair);
    mane.name = 'horse-mane';
    mane.frustumCulled = false;
    this.model.add(mane);

    // --- Tail: the dock, then a long fall of hair, on a chain of bones -----------------------------
    const tailLen = (foal ? 0.5 : 0.92) + g.coatLength * 0.16;
    const segs = 6;
    const tr = J(TAIL_ROOT);
    let parent: THREE.Object3D = this.body;
    let prev: V3 = bodyP;
    const chain: V3[] = [];
    for (let i = 0; i < segs; i++) {
      // The dock angles back and down; the hair hangs.
      const p: V3 = i === 0 ? tr : [chain[i - 1][0], chain[i - 1][1] - (i === 1 ? 0.09 : tailLen / (segs - 1)), chain[i - 1][2] - (i === 1 ? 0.07 : 0.012)];
      chain.push(p);
      const bone = new THREE.Bone();
      bone.position.set(...local(p, prev));
      parent.add(bone);
      this.tail.push(bone);
      parent = bone;
      prev = p;
    }
    const tailPts: number[] = [], tailUv: number[] = [], tailIdx: number[] = [], tSi: number[] = [], tSw: number[] = [];
    const rings = 28, sides = 10;
    const along = (t: number): V3 => {
      const f = t * (segs - 1);
      const k = Math.min(segs - 2, Math.floor(f));
      const u = f - k;
      return [0, chain[k][1] + (chain[k + 1][1] - chain[k][1]) * u, chain[k][2] + (chain[k + 1][2] - chain[k][2]) * u];
    };
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const c = along(t);
      // Thick dock, a full fall of hair, a tapering switch.
      // The hair fans out below the dock, fullest around the hocks, then thins to the ends.
      const fall = t < 0.15 ? 0 : smooth(0.15, 0.45, t) * (1 - smooth(0.7, 1, t) * 0.7);
      const wide = (t < 0.15 ? 0.045 + t * 0.3 : 0.09 + 0.045 * fall) * (1 - smooth(0.85, 1, t) * 0.35) * (foal ? 0.7 : 1);
      const deep = (t < 0.15 ? 0.045 : 0.06 + 0.03 * fall) * (1 - smooth(0.8, 1, t) * 0.4) * (foal ? 0.7 : 1);
      const f = t * (segs - 1);
      const k = Math.min(segs - 2, Math.floor(f));
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        // Ragged locks round the fall (none on the dock).
        const lock = t < 0.15 ? 1 : 1 + 0.16 * Math.sin(a * 5 + t * 9) * smooth(0.15, 0.5, t) + 0.08 * Math.sin(a * 11 - t * 17);
        tailPts.push(Math.sin(a) * wide * lock, c[1] + (t < 0.15 ? Math.cos(a) * deep * 0.6 : 0), c[2] + Math.cos(a) * deep * lock);
        tailUv.push(j / sides, t);
        tSi.push(k, k + 1, 0, 0);
        tSw.push(1 - (f - k), f - k, 0, 0);
        if (r < rings && j < sides) {
          const i0 = r * (sides + 1) + j, i1 = i0 + sides + 1;
          tailIdx.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
        }
      }
    }
    const tailGeo = new THREE.BufferGeometry();
    tailGeo.setAttribute('position', new THREE.Float32BufferAttribute(tailPts, 3));
    tailGeo.setAttribute('uv', new THREE.Float32BufferAttribute(tailUv, 2));
    tailGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(tSi, 4));
    tailGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(tSw, 4));
    tailGeo.setIndex(tailIdx);
    tailGeo.computeVertexNormals();
    const tailHair = hairMaterial(maneColor);
    tailHair.alphaTest = 0;
    const tail = new THREE.SkinnedMesh(tailGeo, tailHair);
    tail.name = 'horse-tail';
    tail.frustumCulled = false;
    this.model.add(tail);
    // Locks of hair over the fall, each its own length with a ragged end, fanning with it toward
    // the hocks: the tail reads as hair, not a stuffed sleeve.
    const lockPts: number[] = [], lockUv: number[] = [], lockIdx: number[] = [], lSi: number[] = [], lSw: number[] = [];
    const LOCKS = foal ? 10 : 18, STEPS = 10;
    for (let i = 0; i < LOCKS; i++) {
      const a = (i / LOCKS) * Math.PI * 2 + rng() * 0.3;
      const t0 = 0.1 + rng() * 0.08, t1 = 0.8 + rng() * 0.2;
      const half = (foal ? 0.022 : 0.034) * (0.8 + rng() * 0.4);
      const base = lockPts.length / 3;
      for (let r = 0; r <= STEPS; r++) {
        const t = t0 + (t1 - t0) * (r / STEPS);
        const c = along(Math.min(1, t));
        const fall = smooth(0.15, 0.45, t) * (1 - smooth(0.7, 1, t) * 0.7);
        const rad = ((0.09 + 0.045 * fall) * (1 - smooth(0.85, 1, t) * 0.35) + 0.006) * (foal ? 0.7 : 1);
        // On the tube's surface (its own depth), and across it (the tangent to the ring).
        const dp = ((0.06 + 0.03 * fall) * (1 - smooth(0.8, 1, t) * 0.4) + 0.006) * (foal ? 0.7 : 1) / rad;
        const x = Math.sin(a) * rad, z = c[2] + Math.cos(a) * rad * dp;
        const tx = Math.cos(a), tz = -Math.sin(a) * dp;
        const w = half * (1 - (r / STEPS) * 0.55);
        const f = Math.min(1, t) * (segs - 1);
        const k = Math.min(segs - 2, Math.floor(f));
        for (const e of [-1, 1]) {
          lockPts.push(x + tx * w * e, c[1], z + tz * w * e);
          lockUv.push(e < 0 ? 0 : 0.5, r / STEPS);
          lSi.push(k, k + 1, 0, 0);
          lSw.push(1 - (f - k), f - k, 0, 0);
        }
        if (r < STEPS) {
          const i0 = base + r * 2;
          lockIdx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
        }
      }
    }
    const lockGeo = new THREE.BufferGeometry();
    lockGeo.setAttribute('position', new THREE.Float32BufferAttribute(lockPts, 3));
    lockGeo.setAttribute('uv', new THREE.Float32BufferAttribute(lockUv, 2));
    lockGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(lSi, 4));
    lockGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(lSw, 4));
    lockGeo.setIndex(lockIdx);
    lockGeo.computeVertexNormals();
    const tailLocks = new THREE.SkinnedMesh(lockGeo, hair);
    tailLocks.name = 'horse-tail-locks';
    tailLocks.frustumCulled = false;
    this.model.add(tailLocks);

    // --- Ears, eyes ----------------------------------------------------------------------------
    const coatC = g.coat;
    const earMat = new THREE.MeshStandardMaterial({ color: mixColor(coatC, g.secondary, 0.35), roughness: 0.7 });
    const innerMat = new THREE.MeshStandardMaterial({ color: mixColor(coatC, '#2a2220', 0.55), roughness: 0.9, side: THREE.DoubleSide });
    const earLen = foal ? 0.12 : 0.14;
    // A broad root sunk into the poll (not balanced on a point), so no gap shows on any head shape.
    const earProfile = [new THREE.Vector2(0.001, -0.045), new THREE.Vector2(0.036, -0.04), new THREE.Vector2(0.036, 0), new THREE.Vector2(0.032, 0.015), new THREE.Vector2(0.034, 0.05), new THREE.Vector2(0.026, 0.095), new THREE.Vector2(0.012, earLen - 0.01), new THREE.Vector2(0.001, earLen)];
    const eye = eyeSpot();
    for (const s of [1, -1]) {
      const ear = new THREE.Group();
      const base = shape(...sculptHead(s * 0.056, 1.985, 1.12), 1);
      ear.position.set(base[0] - hd[0], base[1] - hd[1], base[2] - hd[2]);
      this.head.add(ear);
      const outer = new THREE.Mesh(new THREE.LatheGeometry(earProfile, 12), earMat);
      outer.scale.set(1, 1, 0.55);
      const inner = new THREE.Mesh(new THREE.LatheGeometry(earProfile.map((v) => new THREE.Vector2(v.x * 0.72, v.y * 0.9 + 0.006)), 12, -Math.PI / 2, Math.PI), innerMat);
      inner.scale.set(1, 1, 0.5);
      inner.position.z = 0.012;
      // The ear's hollow faces forward and out.
      const cup = new THREE.Group();
      cup.add(outer, inner);
      cup.rotation.y = s * 0.35;
      ear.add(cup);
      ear.userData.side = s;
      this.ears.push(ear);
      const eyePos = shape(...sculptHead(s * (eye[0] - 0.008), eye[1], eye[2]), 1);
      // A big, dark, almond eye, set along the line of the face.
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03, 18, 14), new THREE.MeshStandardMaterial({ color: g.eye || '#22180f', roughness: 0.08 }));
      ball.scale.set(0.55, 0.78, 1.3);
      ball.rotation.x = -0.55;
      ball.position.set(eyePos[0] - hd[0], eyePos[1] - hd[1], eyePos[2] - hd[2]);
      this.head.add(ball);
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.033, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: mixColor(coatC, '#000000', 0.15), roughness: 0.8 }));
      lid.position.copy(ball.position);
      lid.rotation.set(-0.55, 0, s * 0.25);
      lid.scale.set(0.62, 0.05, 1.32);
      this.head.add(lid);
      this.lids.push(lid);
    }
    const tip = shape(0, 1.47, 1.63, 1);
    this.muzzle.position.set(tip[0] - hd[0], tip[1] - hd[1], tip[2] - hd[2]);
    this.head.add(this.muzzle);
    const top = shape(0, 2.02, 1.16, 1);
    this.headAnchor.position.set(top[0] - hd[0], top[1] - hd[1] + 0.08, top[2] - hd[2]);
    this.head.add(this.headAnchor);
    const seat = shape(0, 1.42, 0.22);
    this.saddle.position.set(seat[0] - bodyP[0], seat[1] - bodyP[1], seat[2] - bodyP[2]);
    this.body.add(this.saddle);

    this.model.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    skin.bind(skeleton);
    mane.bind(skeleton);
    const tailSkeleton = new THREE.Skeleton(this.tail);
    tail.bind(tailSkeleton);
    tailLocks.bind(tailSkeleton);

    this.cur = { neck1: 0, neck2: 0, head: 0, turn: 0, earPitch: 0, earSpread: 0, tailUp: 0, tailSwish: 0, eyes: 1, roll: 0, pitch: 0, bodyY: 0 };
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    // A soft contact shadow under the barrel.
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2;
    blob.scale.set(0.75 * this.scale, 2.0 * this.scale, 1);
    blob.position.y = 0.01;
    blob.castShadow = false;
    this.root.add(blob);
    this.root.addEventListener('removed', () => {
      const textures = new Set<THREE.Texture>();
      this.root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          const sm = m as THREE.MeshStandardMaterial;
          if (sm.map) textures.add(sm.map);
          m.dispose();
        }
        if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
      });
      textures.forEach((t) => t.dispose());
    });
  }

  /** Head, ears, tail and body for an activity (legs are placed separately). */
  private look(activity: AnimalActivity, t: number, moving: boolean, running: boolean, nod: number, traits: readonly string[]): Look {
    const s = Math.sin;
    const has = (id: string) => traits.includes(id);
    const L: Look = { neck1: 0, neck2: 0, head: 0, turn: 0, earPitch: 0.1, earSpread: 0.15, tailUp: 0, tailSwish: s(t * 0.7) * 0.05, eyes: 1, roll: 0, pitch: 0, bodyY: 0 };
    if (moving) {
      if (running) {
        L.neck1 = -0.08 + nod * 0.03;
        L.head = 0.05;
        L.tailUp = 0.35;
        L.earPitch = 0.25;
      } else {
        // The head nods with each stride of the forelegs.
        L.neck1 = 0.12 + nod * 0.07;
        L.head = 0.06 - nod * 0.03;
        L.turn = s(t * 0.3) * 0.08;
        L.earPitch = 0.15;
      }
      if (has('spirited') || has('energetic')) {
        L.neck1 -= 0.06;
        L.tailUp += 0.12;
      }
      return L;
    }
    switch (activity) {
      case 'graze': {
        // Head down in the grass, tearing and chewing, swinging a little to the next mouthful; now
        // and then the head comes up to chew a mouthful over and look about, ears going.
        const chew = Math.max(0, s(t * 5.5));
        const up = grazeLookUp(t);
        L.neck1 = 0.98 + (0.12 - 0.98) * up;
        L.neck2 = 0.5 * (1 - up);
        L.head = -0.62 + chew * 0.05 + (0.62 + 0.08 + s(t * 6.5) * 0.03) * up;
        L.turn = s(t * 0.4) * 0.22 * (1 - up) + s(t * 0.5) * 0.35 * up;
        L.earSpread = 0.35 - 0.2 * up;
        L.earPitch = -0.05 + 0.35 * up * (0.6 + 0.4 * s(t * 1.7));
        L.tailSwish = s(t * 0.9) * 0.08;
        L.pitch = 0.03 * (1 - up);
        break;
      }
      case 'eat':
      case 'drink': {
        const chew = Math.max(0, s(t * (activity === 'drink' ? 3 : 5)));
        L.neck1 = activity === 'drink' ? 0.8 : 0.45;
        L.neck2 = activity === 'drink' ? 0.35 : 0.2;
        L.head = (activity === 'drink' ? -0.45 : -0.2) + chew * 0.04;
        L.earPitch = 0.2;
        break;
      }
      case 'sleep':
      case 'lie':
        if (activity === 'lie' && !moving) {
          // Lying down in the grass: neck up off the ground, head nodding, ears soft, eyes half shut.
          L.neck1 = 0.05 + s(t * 0.25) * 0.03;
          L.neck2 = 0.1;
          L.head = 0.35;
          L.earSpread = 0.55;
          L.earPitch = -0.2;
          L.eyes = 0.35;
        } else {
          // Dozing on its feet: neck level, head hanging, ears out to the sides, lower lip slack.
          L.neck1 = 0.5 + s(t * 0.25) * 0.02;
          L.neck2 = 0.12;
          L.head = 0.18;
          L.earSpread = 0.75;
          L.earPitch = -0.35;
          L.eyes = 0;
        }
        L.tailSwish = s(t * 0.3) * 0.03;
        break;
      case 'groom':
        // Being brushed: relaxed, eyes half shut, ears soft.
        L.neck1 = 0.28 + s(t * 0.5) * 0.03;
        L.head = 0.1;
        L.turn = 0.12 + s(t * 0.35) * 0.08;
        L.earSpread = 0.5;
        L.earPitch = -0.15;
        L.eyes = 0.45;
        break;
      case 'wag':
      case 'play':
        // Being patted: nose forward to the hand, ears pricked, a nuzzle now and then.
        L.neck1 = 0.22 + Math.max(0, s(t * 1.7)) * 0.08;
        L.head = 0.22;
        L.turn = s(t * 0.6) * 0.15;
        L.earPitch = 0.4;
        L.earSpread = 0.05;
        break;
      case 'shy':
        // Startled: head high, ears pinned, weight back.
        L.neck1 = -0.35;
        L.head = -0.25;
        L.earPitch = -1.1;
        L.earSpread = 0.2;
        L.tailUp = -0.2;
        L.pitch = -0.04;
        L.bodyY = -0.02;
        break;
      case 'roll':
        L.neck1 = 0.15;
        L.neck2 = 0.2;
        L.head = -0.3 + s(t * 2) * 0.1;
        L.earSpread = 0.6;
        L.earPitch = -0.6;
        break;
      default: {
        // Standing about: looking round, now and then dropping the nose to sniff.
        const look = s(t * 0.21) * s(t * 0.13);
        L.neck1 = 0.05 + s(t * 0.17) * 0.06 + Math.max(0, s(t * 0.09) - 0.92) * 4;
        L.turn = look * 0.4;
        L.head = 0.05;
        L.earPitch = 0.2 + s(t * 0.4) * 0.1;
        if (has('nervous') || has('temperamental')) {
          L.neck1 -= 0.12;
          L.earPitch += 0.25 * s(t * 1.3);
        }
        if (has('lazy') || has('gentle')) {
          L.neck1 += 0.12;
          L.earSpread += 0.15;
          L.eyes = 0.8;
        }
        if (has('spirited') || has('energetic') || has('brave')) {
          L.neck1 -= 0.08;
          L.earPitch += 0.15;
        }
        this.habitLook(L, t);
      }
    }
    return L;
  }

  /** Watch someone or something (a point in the world), or stop watching (null). */
  lookAt(p: THREE.Vector3 | null): void {
    if (!p) this.lookTarget = null;
    else (this.lookTarget ??= new THREE.Vector3()).copy(p);
  }

  /** How far into the current habit (0…1) and how fully it's in play (eased in and out). */
  private habitPhase(t: number): { u: number; env: number } {
    const h = this.habit!;
    const u = clamp01((t - h.at) / h.len);
    return { u, env: clamp01(Math.min(u * 5, (1 - u) * 5)) };
  }

  /** Head, neck and ears for the habit in hand. */
  private habitLook(L: Look, t: number): void {
    const h = this.habit;
    if (!h) return;
    const { u, env } = this.habitPhase(t);
    const s = Math.sin;
    switch (h.kind) {
      case 'paw':
        // Impatient: head lowered toward the hoof scraping at the ground, ears forward.
        L.neck1 += 0.3 * env;
        L.head += 0.15 * env;
        L.turn += h.side * 0.12 * env;
        L.earPitch += 0.25 * env;
        break;
      case 'toss':
        // A flick of the head up and round, ears back, then settling.
        L.neck1 -= 0.45 * env * s(Math.PI * u) ** 2;
        L.head -= 0.3 * env * s(Math.PI * u);
        L.turn += h.side * 0.25 * s(Math.PI * u * 2) * env;
        L.earPitch -= 0.5 * env;
        break;
      case 'scratch':
        // Head round to the flank, nibbling at an itch.
        L.turn = L.turn * (1 - env) + h.side * 1.25 * env;
        L.neck1 += (0.42 - L.neck1) * env;
        L.neck2 += 0.15 * env;
        L.head += (-0.15 + s(t * 13) * 0.06) * env;
        L.eyes = 1 - 0.4 * env;
        L.earSpread += 0.3 * env;
        break;
      case 'shake':
        // Shaking off from the head back: neck and body shudder.
        L.turn += s(t * 19) * 0.22 * env;
        L.neck1 += 0.12 * env;
        L.earSpread += 0.4 * env * Math.abs(s(t * 19));
        L.eyes = 1 - 0.7 * env;
        break;
      case 'stamp':
        // At a fly: the tail swats and a hind hoof comes down hard.
        L.tailSwish += s(t * 11) * 0.5 * env;
        L.earPitch -= 0.3 * env;
        break;
    }
  }

  /** Solve a leg for a fetlock target (side plane, model units) and set its three angles. */
  private solveLeg(i: number, ty: number, tz: number, bodyY: number, hoofExtra: number): [number, number, number] {
    const r = this.legRest[i];
    const ay = r.a[0] + bodyY, az = r.a[1];
    let dy = ty - ay, dz = tz - az;
    let d = Math.hypot(dy, dz);
    const max = (r.l1 + r.l2) * 0.9995, min = Math.abs(r.l1 - r.l2) + 1e-3;
    if (d > max) {
      dy *= max / d;
      dz *= max / d;
      d = max;
    } else if (d < min) {
      dy *= min / d;
      dz *= min / d;
      d = min;
    }
    const base = ang(dy, dz);
    const alpha = Math.acos(Math.max(-1, Math.min(1, (r.l1 * r.l1 + d * d - r.l2 * r.l2) / (2 * r.l1 * d))));
    // Knees bend forward, hocks point back.
    const a1 = r.front ? base - alpha : base + alpha;
    const upper = wrap(a1 - r.a1);
    const by = ay + r.l1 * Math.cos(a1), bz = az + r.l1 * Math.sin(a1);
    const a2 = ang(ay + dy - by, az + dz - bz);
    const lower = wrap(a2 - r.a2 - upper);
    return [upper, lower, wrap(hoofExtra - upper - lower)];
  }

  animate(activity: AnimalActivity, moving: boolean, running: boolean, time: number, dt: number, distanceWalked = 0, traits: readonly string[] = []): void {
    // --- gait phases, driven by distance so hooves plant ------------------------------------
    const walkStride = 1.16, trotStride = 2.0;
    const dd = this.lastDistance < 0 ? 0 : Math.max(0, Math.min(2, distanceWalked - this.lastDistance)) / this.scale;
    this.lastDistance = distanceWalked;
    this.walkPhase = (this.walkPhase + dd / walkStride) % 1;
    this.trotPhase = (this.trotPhase + dd / trotStride) % 1;
    this.gaitBlend += ((moving && running ? 1 : 0) - this.gaitBlend) * Math.min(1, dt * 6);
    // Walk and trot are cross-faded (smoothstepped) rather than switched, so the hooves never
    // jump from one gait's footfalls to the other's.
    const tw = this.gaitBlend * this.gaitBlend * (3 - 2 * this.gaitBlend);
    const trot = tw > 0.5;
    const phase = trot ? this.trotPhase : this.walkPhase;
    const nod = Math.sin(this.walkPhase * Math.PI * 4) * (1 - tw) + Math.sin(this.trotPhase * Math.PI * 4) * tw;
    // Standing about, a horse is never quite still: now and then it paws, shakes, tosses its head,
    // turns to nibble an itch or stamps at a fly.
    const idling = activity === 'idle' && !moving && this.lieT === 0;
    if (this.habit && (!idling || time > this.habit.at + this.habit.len || time < this.habit.at)) this.habit = null;
    if (!idling) this.habitNext = Math.max(this.habitNext, time + 4);
    else if (!this.habit && time > this.habitNext) {
      let r = Math.random() * HABITS.reduce((a, b) => a + b.weight, 0);
      const pick = HABITS.find((hb) => (r -= hb.weight) < 0) ?? HABITS[0];
      const len = pick.len[0] + Math.random() * (pick.len[1] - pick.len[0]);
      this.habit = { kind: pick.kind, at: time, len, side: Math.random() < 0.5 ? -1 : 1 };
      this.habitNext = time + len + 7 + Math.random() * 14;
    }
    const target = this.look(activity, time, moving, running, nod, traits);

    // --- feet ---------------------------------------------------------------------------------
    // Weight shifts: now and then a hind hoof rests on its toe.
    // (Not while lying down, rolling or getting up.)
    const still = !moving && activity !== 'roll' && activity !== 'lie' && this.lieT === 0;
    if (still && time > this.restUntil) {
      this.restLeg = Math.random() < 0.6 ? (Math.random() < 0.5 ? 2 : 3) : -1;
      this.restUntil = time + 6 + Math.random() * 10;
    }
    if (!still) this.restLeg = -1;
    if (activity === 'sleep' && this.restLeg < 0) this.restLeg = 3;
    /** Where hoof i goes in one gait. */
    const foot = (i: number, asTrot: boolean): { y: number; z: number; extra: number; stance: boolean } => {
      const r = this.legRest[i];
      let y = r.c[0], z = r.c[1], extra = 0, stance = true;
      if (moving) {
        const S = asTrot ? 0.42 : 0.64;
        const offsets = asTrot ? [0, 0.5, 0.5, 0] : [0.25, 0.75, 0, 0.5];
        const strideR = asTrot ? trotStride * S / 2 : walkStride * S / 2;
        const f = ((asTrot ? this.trotPhase : this.walkPhase) + offsets[i]) % 1;
        if (f < S) {
          z += strideR * (1 - 2 * (f / S));
        } else {
          const u = (f - S) / (1 - S);
          const e = u * u * (3 - 2 * u);
          z += strideR * (-1 + 2 * e);
          const lift = (r.front ? (asTrot ? 0.22 : 0.12) : (asTrot ? 0.17 : 0.09)) * Math.sin(Math.PI * u);
          y += lift;
          // Knees fold the hoof back under; hind fetlocks flip as the hock lifts.
          extra = (r.front ? 1.1 : 0.8) * Math.sin(Math.PI * Math.min(1, u * 1.15)) * (asTrot ? 1.2 : 1);
          if (!r.front) z -= 0.05 * Math.sin(Math.PI * u);
          stance = false;
        }
      } else {
        if (activity === 'graze' && r.front) {
          // One foreleg ahead, and every so often a step to the next mouthful, the other leg leading.
          const n = Math.floor(time / GRAZE_STEP), into = time - n * GRAZE_STEP;
          const lead = n % 2, k = clamp01(into / GRAZE_STEP_LEN);
          const step = k < 1 && into < GRAZE_STEP_LEN;
          z += 0.16 * (i === lead ? (step ? k : 1) : step ? 1 - k : 0);
          if (step && i === lead) {
            y += 0.09 * Math.sin(Math.PI * k);
            extra = 0.9 * Math.sin(Math.PI * k);
            stance = false;
          }
        }
        const hb = this.habit;
        if (hb && idling) {
          const { u, env } = this.habitPhase(time);
          if (hb.kind === 'paw' && i === (hb.side < 0 ? 0 : 1)) {
            // Lift, reach forward, drag the toe back through the dirt; again.
            const c2 = (u * 3) % 1;
            y += (0.05 + 0.08 * Math.max(0, Math.sin(Math.PI * 2 * c2))) * env;
            z += 0.13 * Math.cos(Math.PI * 2 * c2) * env;
            extra = 1.0 * env;
            stance = false;
          } else if (hb.kind === 'stamp' && i === (hb.side < 0 ? 2 : 3)) {
            y += 0.1 * Math.sin(Math.PI * Math.min(1, u * 1.6)) * env;
            extra = 0.7 * Math.sin(Math.PI * Math.min(1, u * 1.6));
            stance = false;
          }
        }
        if (i === this.restLeg) {
          // Resting a hind leg: hock flexed, toe tipped on the ground, hip dropped.
          y += 0.05;
          z += 0.07;
          extra = 0.75;
          stance = false;
        }
      }
      return { y, z, extra, stance };
    };
    const feet: { y: number; z: number; extra: number; stance: boolean }[] = [];
    for (let i = 0; i < 4; i++) {
      const a = foot(i, false);
      if (!moving || tw <= 0.001) feet.push(a);
      else if (tw >= 0.999) feet.push(foot(i, true));
      else {
        const b = foot(i, true);
        feet.push({ y: a.y + (b.y - a.y) * tw, z: a.z + (b.z - a.z) * tw, extra: a.extra + (b.extra - a.extra) * tw, stance: trot ? b.stance : a.stance });
      }
    }
    // Coming to a halt, a hoof stays where it was put down; any left off its mark then steps there,
    // lifted, one at a time (the horse squaring up), rather than sliding over the ground.
    const yaw = this.root.rotation.y;
    const yawStep = this.lastYaw === null ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw));
    this.lastYaw = yaw;
    if (moving || !this.plantedYet) {
      this.plantedYet = true;
      this.twist.fill(0);
      for (let i = 0; i < 4; i++) this.planted[i] = feet[i].z;
      this.stepLeg = -1;
    } else {
      if (this.stepLeg >= 0) {
        this.stepT += dt / HALT_STEP;
        if (this.stepT >= 1) {
          this.planted[this.stepLeg] = this.stepTo;
          this.stepLeg = -1;
        }
      }
      // Turning on the spot, each hoof is twisted out of place by the turn (more the further it
      // stands from the middle) until it steps round.
      for (let i = 0; i < 4; i++) this.twist[i] += Math.abs(yawStep) * Math.abs(this.planted[i]);
      if (this.stepLeg < 0) {
        let worst = HALT_SLACK;
        for (let i = 0; i < 4; i++) {
          const off = Math.abs(feet[i].z - this.planted[i]) + this.twist[i];
          if (feet[i].stance && off > worst) {
            worst = off;
            this.stepLeg = i;
          }
        }
        if (this.stepLeg >= 0) {
          this.stepFrom = this.planted[this.stepLeg];
          this.stepTo = feet[this.stepLeg].z;
          this.stepT = 0;
          this.twist[this.stepLeg] = 0;
        }
      }
      for (let i = 0; i < 4; i++) {
        const f = feet[i];
        if (!f.stance) this.planted[i] = f.z;
        else if (i === this.stepLeg) {
          const k = smooth(0, 1, this.stepT);
          f.z = this.stepFrom + (this.stepTo - this.stepFrom) * k;
          f.y += (this.legRest[i].front ? 0.09 : 0.07) * Math.sin(Math.PI * k);
          f.extra = (this.legRest[i].front ? 1 : 0.7) * Math.sin(Math.PI * k);
          f.stance = false;
        } else f.z = this.planted[i];
      }
    }
    // Settle the body over the stance legs (an inverted-pendulum dip as the legs angle).
    let drop = 0;
    for (let i = 0; i < 4; i++) {
      if (!feet[i].stance) continue;
      const r = this.legRest[i];
      const h = r.a[0] - feet[i].y;
      const dz = feet[i].z - r.a[1];
      const reach = Math.sqrt(Math.max(0, ((r.l1 + r.l2) * 0.999) ** 2 - dz * dz));
      drop = Math.max(drop, h - reach);
    }
    let bodyY = -drop * 0.55 + target.bodyY;
    if (moving) bodyY += (Math.abs(Math.sin(this.trotPhase * Math.PI * 2)) * 0.035 - 0.02) * tw;
    if (this.restLeg >= 0 && still) bodyY -= 0.012;

    const k = Math.min(1, dt * (moving ? 16 : 5));
    const c = this.cur;
    const lerp = (a: number, b: number, kk = k) => a + (b - a) * kk;
    for (const key of Object.keys(target) as (keyof Look)[]) if (key !== 'bodyY') c[key] = lerp(c[key], target[key]);
    const lying = activity === 'roll' || (activity === 'lie' && !moving);
    c.bodyY = lerp(c.bodyY, bodyY, Math.min(1, dt * (moving ? 20 : 4)));
    let roll = this.restLeg === 2 ? 0.025 : this.restLeg === 3 ? -0.025 : 0;
    if (moving) roll += Math.sin(this.walkPhase * Math.PI * 2) * 0.015 * (1 - tw);

    // --- lying down and getting up, the way a horse does it -----------------------------------------
    // Down: the knees buckle and it kneels in front, then the hindquarters sink. Up: forelegs out
    // first (sitting up in front like a dog), then a heave of the hindquarters.
    const wasT = this.lieT;
    this.lieT = clamp01(this.lieT + (lying ? dt : -dt) / LIE_TIME);
    if (this.lieT !== wasT) this.lieGoingDown = this.lieT > wasT;
    const lt = this.lieT;
    const pf = this.lieGoingDown ? smooth(0, 0.55, lt) : smooth(0.45, 1, lt);
    const ph = this.lieGoingDown ? smooth(0.3, 1, lt) : smooth(0, 0.6, lt);
    this.hindDown = ph;
    const sink = LIE_BONE - this.bodyBase - c.bodyY;
    let bodyShown = c.bodyY;
    let pitch = c.pitch;
    let legAngles: [number, number, number][] = feet.map((f, i) => this.solveLeg(i, f.y, f.z, c.bodyY, f.extra));
    if (lt > 0) {
      bodyShown += sink * (pf + ph) / 2;
      const half = (this.legRest[0].a[1] - this.legRest[2].a[1]) / 2;
      pitch += Math.atan2((pf - ph) / 2 * -sink, half);
      const tilt = pitch - c.pitch;
      legAngles = legAngles.map((a, i) => {
        // Legs fold a little ahead of the body sinking (so no hoof is driven into the ground), and
        // they keep their line to the ground under a tilted body (braced, or folded flat).
        const fold = i < 2 ? LIE_FORE : LIE_HIND[i - 2], p = Math.min(1, i < 2 ? pf * 1.8 : ph * 1.9);
        return [a[0] + (fold[0] - a[0]) * p - tilt, a[1] + (fold[1] - a[1]) * p, a[2] + (fold[2] - a[2]) * p];
      });
      // Settled on one hip; rolling right over once fully down.
      const settled = smooth(0.85, 1, lt);
      roll = roll * (1 - settled) + (activity === 'roll' ? Math.sin(time * 1.6) * 1.1 : 0.15) * settled;
    }
    const lk = Math.min(1, dt * (moving ? 30 : 6));
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) this.legCur[i][j] = lerp(this.legCur[i][j], legAngles[i][j], lk);
      const [bu, bl, bp] = this.legBones[i];
      bu.rotation.x = this.legCur[i][0];
      bl.rotation.x = this.legCur[i][1];
      bp.rotation.x = this.legCur[i][2];
      // Lying down, the stifle folds the gaskin back under the thigh as it comes forward.
      // (It folds first, lifting the hoof clear behind, before the thigh swings forward under the body.)
      // Rolling over, the hind legs draw up tighter (they'd otherwise dig into the ground).
      if (i >= 2) this.stifles[i - 2].rotation.x = LIE_STIFLE[i - 2] * Math.min(1, this.hindDown * 3.2) * (1 + 0.08 * smooth(0.12, 0.45, Math.abs(c.roll)));
    }
    c.roll = lerp(c.roll, roll, Math.min(1, dt * 4));
    if (this.habit?.kind === 'shake') c.roll += Math.sin(time * 19) * 0.05 * this.habitPhase(time).env;
    // Rolled over onto its side, the body rides on the round of its barrel, a touch higher than
    // lying on its folded legs (so the legs tucked under it don't dig into the ground).
    this.body.position.y = this.bodyBase + bodyShown + (lt > 0 ? 0.04 * Math.max(smooth(0.25, 0.4, c.roll), smooth(-0.06, -0.2, c.roll)) : 0);
    this.body.rotation.set(pitch, 0, c.roll);
    // Watching someone: the neck brings the head round toward them.
    const canLook = !moving && HORSE_LOOKING.has(activity) && (!this.habit || this.habit.kind === 'stamp');
    if (canLook && this.lookTarget) {
      // (Measured from the withers, where the neck turns.)
      const local = this.root.worldToLocal(this.lookTarget.clone());
      const yaw = Math.atan2(local.x, local.z - 0.45 * this.scale);
      const reachable = Math.abs(yaw) < HORSE_LOOK_YAW + 0.5;
      if (reachable) this.lookYaw += (Math.max(-HORSE_LOOK_YAW, Math.min(HORSE_LOOK_YAW, yaw)) - this.lookYaw) * Math.min(1, dt * 4);
      this.lookW += ((reachable ? 1 : 0) - this.lookW) * Math.min(1, dt * 2.5);
    } else this.lookW += (0 - this.lookW) * Math.min(1, dt * 2.5);
    c.turn += (this.lookYaw / 1.1 - c.turn) * this.lookW;
    this.neck1.rotation.set(c.neck1, c.turn * 0.4, 0);
    this.neck2.rotation.set(c.neck2, c.turn * 0.4, 0);
    this.head.rotation.set(c.head, c.turn * 0.3, -c.turn * 0.15);

    // --- ears: posture plus quick independent flicks ----------------------------------------------
    this.earFlickAt -= dt;
    if (this.earFlickAt < 0) {
      this.earFlick[Math.random() < 0.5 ? 0 : 1] = 1;
      this.earFlickAt = 1 + Math.random() * 4;
    }
    this.ears.forEach((ear, i) => {
      this.earFlick[i] = Math.max(0, this.earFlick[i] - dt * 3.5);
      const s = ear.userData.side as number;
      const flick = Math.sin(this.earFlick[i] * Math.PI);
      ear.rotation.set(-c.earPitch + flick * 0.9, s * (0.1 + flick * 0.5), s * -(c.earSpread + flick * 0.2));
    });

    // --- tail: hangs, lifts at the trot, swishes at flies ------------------------------------------
    this.swatAt -= dt;
    if (this.swatAt < 0) {
      this.swatLength = 0.8 + Math.random() * 0.8;
      this.swatUntil = time + this.swatLength;
      this.swatAt = 3 + Math.random() * 7;
    }
    // A swat at the flies swells in and dies away rather than starting at full swing.
    const left = this.swatUntil - time;
    const swat = left > 0 ? Math.sin(time * 11) * 0.55 * Math.min(1, left * 4, (this.swatLength - left) * 4) : 0;
    // Swept back over the grass as the hindquarters go down, and kept level as the body tilts.
    // (Sitting up in front, the rump is down on the ground: the tail lifts clear of it.)
    const tailUp = c.tailUp + (LIE_TAIL - c.tailUp) * this.hindDown + Math.max(0, c.pitch - this.body.rotation.x) * 0.8;
    this.tail.forEach((b, i) => {
      if (i === 0) b.rotation.x = -tailUp * 0.9 - (this.body.rotation.x - c.pitch);
      else b.rotation.x = -tailUp * 0.25 + (i === 1 ? 0.05 : 0.02) + (moving ? Math.sin(phase * Math.PI * 4 - i * 0.6) * 0.03 : 0);
      b.rotation.z = (c.tailSwish + swat) * (i === 0 ? 0.25 : 0.32) * Math.min(1, i * 0.6 + 0.3) + Math.sin(time * 2.1 - i * 0.7) * 0.012 * i;
    });

    // --- breathing: about twelve breaths a minute, quicker and deeper after a trot, slow asleep -------
    const blown = Math.min(1, this.blown + (moving && running ? dt * 0.25 : -dt * 0.03));
    this.blown = Math.max(0, blown);
    const rate = (activity === 'sleep' || this.lieT > 0.9 ? 0.15 : 0.2) + this.blown * 0.45;
    this.breathPhase += dt * rate;
    const inhale = Math.sin(this.breathPhase * Math.PI * 2);
    if (this.coatUniforms) this.coatUniforms.uBreath.value = (0.006 + this.blown * 0.01) * (inhale * 0.5 + 0.5);

    // --- blink --------------------------------------------------------------------------------------
    this.blinkAt -= dt;
    let open = c.eyes;
    if (this.blinkAt < 0) {
      open = 0;
      if (this.blinkAt < -0.14) this.blinkAt = 2.5 + Math.random() * 5;
    }
    for (const lid of this.lids) lid.scale.y = 0.05 + (1 - open) * 0.95;
    void this.foal;
  }
}

/** A tiny deterministic generator for per-horse variation in the mane. */
function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

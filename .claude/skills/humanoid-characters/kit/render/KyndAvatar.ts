import * as THREE from 'three';
import type { Activity, CarryItem, KyndAppearance } from '../sim/entities/Kynd.ts';
import type { Posture } from '../sim/world/types.ts';
import type { EmotionId } from '../sim/emotion/Emotion.ts';
import { COLORS, mat } from './kit.ts';
import type { LifeStage } from '../sim/family/Life.ts';
import { greyed } from '../sim/family/genetics.ts';
import { normalizeAppearance, type FullAppearance } from '../sim/entities/appearance.ts';
import { Bucket, capsuleR, col, ellipsoid, grid, KIND, mixCol, Path, range, around, shade, tube } from './kyndGeometry.ts';
import { kyndMaterials, skinMaterial, type FaceDetail } from './kyndMaterials.ts';
import { ANKLE_Y, BI, BONES, EL_Y, HIP_Y, KNEE_Y, PELVIS_Y, SH_Y, SPINE_Y, LID_LEVELS, WRIST_Y, boneLayout, buildBareFeet, buildBeard, buildHair, buildHands, buildHead, Head, hairCrown, measure, palette, type BodyBuckets, type FaceLayout, type Measure } from './kyndBody.ts';
import { buildBareBody, buildHeadwear, buildOutfit, hairCoverFor } from './KyndGarments.ts';
import { buildLance } from './LanceMesh.ts';

/** Overall size by life stage (on top of the Kynd's own height). */
const STAGE_SCALE: Record<LifeStage, number> = { infant: 1, child: 0.6, teen: 0.9, adult: 1, elder: 0.97 };
/** Children's heads are big for their bodies. */
const HEAD_SCALE: Record<LifeStage, number> = { infant: 1, child: 1.3, teen: 1.06, adult: 1, elder: 1 };
/** Adult head size relative to the authored head. */
const HEAD_BASE = 1.06;

/**
 * A Kynd's body: a skinned character with a joint hierarchy and a layered pose system:
 *   posture (stand / sit / lie / kneel …)  +  activity layer (arms/head)  +  walk cycle  +  emotion.
 * All layers write target joint angles; the rig eases toward them, so every transition blends.
 * The same rig and pose code serve every Kynd — a reusable animation system rather than clips.
 *
 * The body, face, hair and clothes are generated procedurally (see kyndBody.ts and
 * KyndGarments.ts) as smooth skinned surfaces sharing one skeleton, grouped into five materials,
 * so each Kynd is only a handful of draw calls. The face has its own small rig: blinking lids,
 * glancing eyes, brows, mouth corners and a jaw, driven by emotion and activity.
 */

export const JOINTS = [
  'pelvisY', 'spine', 'spineTwist', 'neck', 'neckTurn',
  'shLx', 'shLy', 'shLz', 'elL', 'shRx', 'shRy', 'shRz', 'elR',
  'hipL', 'kneeL', 'hipR', 'kneeR', 'hipLz', 'hipRz', 'lie',
  // Hands: 0 is the relaxed hand as modelled, 1 a closed grip, below 0 opening out (the fingers
  // fan apart); wrists bend toward the palm; twist turns the hand over along the forearm
  // (negative: palm up), the same sense on both sides.
  'gripL', 'gripR', 'wristL', 'wristR', 'twistL', 'twistR',
  // Ankles: extra on top of keeping the foot level (+ points the toes down).
  'ankleL', 'ankleR',
] as const;
export type Joint = (typeof JOINTS)[number];
export type Pose = Record<Joint, number>;

const STAND_HIP = 0.92;
/** How far the pillow lifts a lying head (the neck pose: + is chin toward the chest). */
export const LIE_NECK = 0.95;
/** In a seated pose, the seat is this fraction of the pelvis bone's height above the root. */
const SEAT_UNDER_HIP = 0.86;

function basePose(): Pose {
  return {
    pelvisY: STAND_HIP, spine: 0, spineTwist: 0, neck: 0, neckTurn: 0,
    shLx: 0, shLy: 0, shLz: 0.08, elL: -0.12, shRx: 0, shRy: 0, shRz: 0.08, elR: -0.12,
    hipL: 0, kneeL: 0, hipR: 0, kneeR: 0, hipLz: 0, hipRz: 0, lie: 0,
    gripL: 0.1, gripR: 0.1, wristL: 0.05, wristR: 0.05, twistL: 0, twistR: 0, ankleL: 0, ankleR: 0,
  };
}

/** How the hands hold for what a Kynd is doing (after the arms are posed). */
const HAND_FOR: Partial<Record<Activity, [number, number]>> = {
  eat: [0.2, 0.6], read: [0.3, 0.3], talk: [-0.3, -0.3], joke: [-0.35, -0.35], laugh: [-0.2, -0.2],
  flirt: [-0.15, -0.25], kiss: [-0.1, -0.1], argue: [0.75, 0.75], sulk: [0.55, 0.55], cook: [0.35, 0.65],
  wash: [0.15, 0.15], warm: [-0.4, -0.4], sleep: [0.3, 0.3], garden: [0.5, 0.55], hug: [-0.25, -0.25],
  think: [0.2, 0.55], reach: [-0.45, -0.45], watch: [0.15, 0.15], relax: [0.25, 0.25], play: [0.35, 0.35],
  tend: [0.45, 0.5], dance: [-0.15, -0.15], confused: [-0.1, -0.2], dress: [0.4, 0.4], fish: [0.85, 1],
};
/**
 * How the hands turn over for what a Kynd is doing [left, right] (negative: palm up). Explaining,
 * the palm opens up and out; a shrug shows both palms; at rest they face the thighs.
 */
const TWIST_FOR: Partial<Record<Activity, [number, number]>> = {
  talk: [-0.35, -0.85], joke: [-0.7, -0.7], flirt: [-0.3, -0.45], confused: [-1.15, -1.15], dance: [-0.5, -0.5],
  argue: [0.3, 0.3], laugh: [-0.2, -0.2], hug: [0.15, 0.15], play: [-0.3, -0.3],
};

/** How much each finger (index to little) takes of a hand's curl: a real hand closes little finger first. */
const CASCADE = [0.82, 0.95, 1.06, 1.18];
/** What the right hand does for what it carries: closed round a pole, cupped under a bowl. */
/** The cup's height, and where it sits in the right fist (hand space: +x the palm, +y toward the wrist). */
const CUP_H = 0.1;
const CUP_AT = new THREE.Vector3(0.045, -0.02, 0.015);

/** An open book's page size (metres) and how far each half tips back from flat (radians). */
const BOOK_W = 0.13;
const BOOK_H = 0.2;
const BOOK_V = 0.2;
/** A page is turned every so often (seconds), taking this long. */
const PAGE_EVERY = 9;
const PAGE_TURN = 1.4;

/** How a body holds an open book in one posture (see `KyndAvatar.bookGrip`). */
interface BookGrip {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: number;
  /** Shoulder x, y, z, elbow, twist, wrist for each arm, and the right arm turning a page. */
  L: number[];
  R: number[];
  turn: number[];
  miss: number;
}

/** Where a page turn is, 0 (not turning) … 1, and how far over the leaf has swung (0 right … 1 left). */
export function pageTurn(t: number): { reach: number; leaf: number } {
  const f = (t % PAGE_EVERY) / PAGE_TURN;
  if (f >= 1) return { reach: 0, leaf: 0 };
  const reach = Math.sin(Math.PI * Math.min(1, f * 1.15));
  const k = Math.max(0, Math.min(1, (f - 0.3) / 0.45));
  return { reach, leaf: k * k * (3 - 2 * k) };
}

/**
 * Hand to mouth: what of each held thing meets the lips (in the prop's own space), and where on
 * the face it meets them (offset from the mouth, in the head's space). The bowl's middle comes up
 * under the chin to be supped from; the cup's rim to the lower lip; bread to the teeth.
 */
const TO_MOUTH: Partial<Record<NonNullable<CarryItem>, { at: THREE.Vector3; offset: THREE.Vector3; spine: number; neck: number; axis?: THREE.Vector3 }>> = {
  bowl: { at: new THREE.Vector3(0, 0.02, 0), offset: new THREE.Vector3(0, -0.05, 0.07), spine: 0.07, neck: 0.23 },
  // The cup tipped to the lips: its foot raised out in front, its mouth turned to the face.
  cup: { at: new THREE.Vector3(0, CUP_H / 2, 0.03), offset: new THREE.Vector3(0, -0.006, 0.028), spine: 0.0, neck: -0.22, axis: new THREE.Vector3(0, -0.35, -1).normalize() },
  bread: { at: new THREE.Vector3(0, 0, 0.05), offset: new THREE.Vector3(0, -0.01, 0.04), spine: 0.07, neck: 0.23 },
};

/** An arm's angles for hand to mouth, and how far from the lips the held thing still is. */
export interface Reach {
  shRx: number;
  shRy: number;
  shRz: number;
  elR: number;
  twistR: number;
  wristR: number;
  miss: number;
}

const CARRY_GRIP: Record<NonNullable<CarryItem>, number> = { bowl: 0.5, bread: 0.6, book: 0.35, pot: 0.55, lute: 0.4, rod: 1, lance: 0.9, cup: 0.8 };

function handLayer(p: Pose, activity: Activity, carrying: CarryItem, t: number, seed: number): void {
  const h = HAND_FOR[activity];
  if (h) {
    // Talking hands move: open and close a little with the words.
    const talky = activity === 'talk' || activity === 'joke' || activity === 'flirt' ? 0.18 * Math.sin(t * 3.1 + seed) : 0;
    p.gripL = h[0] + talky;
    p.gripR = h[1] - talky;
    // The hands turn with the words, the palm opening on the stress.
    const tw = TWIST_FOR[activity];
    if (tw) {
      p.twistL = tw[0] + 0.12 * Math.sin(t * 1.3 + seed);
      p.twistR = tw[1] - talky * 1.4 + 0.1 * Math.sin(t * 1.7 + seed * 2);
    }
  } else {
    // At rest the fingers settle and stir a little, never quite still.
    p.gripL += 0.04 * Math.sin(t * 0.7 + seed);
    p.gripR += 0.04 * Math.sin(t * 0.6 + seed * 1.7);
  }
  if (carrying) {
    p.gripR = CARRY_GRIP[carrying];
    p.wristR = carrying === 'pot' ? -0.15 : 0.1;
    // A bowl sits in an upturned palm, the fingers cupped round it.
    if (carrying === 'bowl') p.twistR = -Math.PI / 2;
  }
}

const THIGH = HIP_Y - KNEE_Y;

/**
 * Standing, the feet stay on the ground: a bounce or slouch that moves the hips is made with the
 * knees (a little flex), never by lifting the whole body off the floor.
 */
function plantFeet(p: Pose): void {
  const drop = Math.abs(STAND_HIP - p.pelvisY);
  p.pelvisY = STAND_HIP - drop;
  if (drop < 1e-4) return;
  const a = Math.acos(Math.max(-1, 1 - drop / (2 * THIGH)));
  p.hipL -= a;
  p.hipR -= a;
  p.kneeL += 2 * a;
  p.kneeR += 2 * a;
}

/** Astride a horse: thighs forward and apart around its barrel, heels down, hands low on the reins. */
function rideLayer(p: Pose, moving: boolean, t: number): void {
  const sway = moving ? Math.sin(t * 9) * 0.03 : 0;
  Object.assign(p, {
    pelvisY: 0.52, spine: -0.03 + sway, hipL: -0.95, kneeL: 1.2, hipR: -0.95, kneeR: 1.2,
    hipLz: 0.42, hipRz: 0.42,
    shLx: -0.22, shLz: 0.02, elL: -0.95, shRx: -0.22, shRz: 0.02, elR: -0.95,
  });
}

/**
 * Swinging up into the saddle (m 0 → 1; getting down plays it backwards): hands to the pommel and
 * a foot in the stirrup, a spring up with the far leg swept over the horse's back, then settling
 * into the seat.
 */
function mountLayer(p: Pose, m: number): void {
  const k = (a: number, b: number) => Math.max(0, Math.min(1, (m - a) / (b - a)));
  const reach = k(0, 0.3), spring = k(0.3, 0.7), settle = k(0.7, 1);
  // Reach: both hands up to the saddle, the near foot lifted into the stirrup.
  Object.assign(p, {
    shLx: -1.5 * reach, elL: -0.5 * reach, shRx: -1.3 * reach, elR: -0.7 * reach,
    hipL: -1.25 * reach, kneeL: 1.5 * reach, pelvisY: p.pelvisY - 0.05 * reach, spine: 0.15 * reach,
  });
  if (spring > 0) {
    // Spring: weight onto the stirrup, the far leg swept up and out over the back, body leaning in.
    p.hipR = -0.5 * spring;
    p.hipRz = 1.1 * Math.sin(Math.PI * Math.min(1, spring * 1.2));
    p.kneeR = 0.3 * spring;
    p.spine = 0.15 + 0.25 * spring;
    p.kneeL = 1.5 - 0.6 * spring;
  }
  if (settle > 0) {
    // Settle: down into the riding seat, hands to the reins.
    const ride = basePose();
    rideLayer(ride, false, 0);
    for (const j of JOINTS) p[j] = p[j] + (ride[j] - p[j]) * settle;
  }
}

function postureLayer(p: Pose, posture: Posture): void {
  switch (posture) {
    case 'sit':
      Object.assign(p, { pelvisY: 0.52, hipL: -1.5, kneeL: 1.5, hipR: -1.5, kneeR: 1.5, spine: -0.04 });
      break;
    case 'kneel':
      // On both knees (gardening, foraging, at prayer), a little apart: one knee raised pushed up
      // through a long skirt's front, which can't follow both legs at once.
      Object.assign(p, { pelvisY: 0.5, hipL: -0.06, kneeL: 1.55, hipR: -0.06, kneeR: 1.55, hipLz: 0.07, hipRz: 0.07, spine: 0.3 });
      break;
    case 'squat':
      Object.assign(p, { pelvisY: 0.36, hipL: -1.85, kneeL: 2.2, hipR: -1.85, kneeR: 2.2, spine: 0.25 });
      break;
    case 'bathe':
      Object.assign(p, { pelvisY: 0.32, hipL: -1.35, kneeL: 0.7, hipR: -1.35, kneeR: 0.7, spine: -0.15 });
      break;
    case 'lie':
      // The pillow props the head up: chin a little toward the chest, so the back of the skull
      // (which stands out behind the neck) rests on the pillow instead of sinking through it.
      Object.assign(p, { lie: 1, neck: LIE_NECK, shLz: 0.12, shRz: 0.12, hipL: -0.05, hipR: -0.05, kneeL: 0.1, kneeR: 0.1 });
      break;
    default:
      break;
  }
}

/** A repeatable pseudo-random number in [0, 1) for an integer step and a stream. */
function hash01(n: number, k: number): number {
  const v = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/** Slow, smooth wandering in −1…1 (three incommensurate sines): never quite repeats. */
export function wander(t: number, k = 0): number {
  return (Math.sin(t * 0.37 + k) * 0.5 + Math.sin(t * 0.71 + k * 2.3) * 0.3 + Math.sin(t * 1.33 + k * 4.1) * 0.2);
}

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Eating as people eat, not a metronome: bites in a cycle whose timing changes bite to bite. A
 * scoop at the bowl (`reach`), the spoon lifted to the mouth (`lift`, held there a moment), the hand
 * back down while they chew (`chew`), a rest; now and then a bite is skipped for a look round the
 * table (`look`, −1 left … 1 right). `t` already carries the Kynd's own offset.
 */
export function eatCycle(t: number): { reach: number; lift: number; chew: number; look: number } {
  const P = 4.4;
  const k = Math.floor(t / P), u = t / P - k;
  const r = hash01(k, 1), skip = hash01(k, 2) < 0.16;
  // How much of the cycle the bite itself takes (the rest is chewing and resting).
  const a = 0.42 + 0.22 * r;
  const at = (x0: number, x1: number) => ease((u - x0 * a) / ((x1 - x0) * a));
  const look = skip ? Math.sin(Math.PI * Math.min(1, u / 0.8)) * (hash01(k, 3) < 0.5 ? -1 : 1) : 0;
  if (skip) return { reach: 0, lift: 0, chew: Math.max(0, 1 - u * 3) * 0.6, look };
  const reach = at(0, 0.14) * (1 - at(0.16, 0.34));
  const lift = at(0.18, 0.46) * (1 - at(0.62, 0.95));
  // Chewing from the moment the spoon reaches the mouth, easing off toward the next bite.
  const chew = u > 0.46 * a ? Math.max(0, 1 - (u - 0.46 * a) / (1.05 - 0.46 * a)) : 0;
  return { reach, lift, chew, look: 0 };
}

/**
 * Drinking, a sip at a time: the cup comes up to the lips (`lift`), tips (`tilt`) while they
 * swallow, and goes down again to rest a while; every sip its own length, now and then a longer
 * pull, and sometimes a pause to just hold it and look about.
 */
export function drinkCycle(t: number): { lift: number; tilt: number; swallow: number } {
  const P = 6.2;
  const k = Math.floor(t / P), u = t / P - k;
  if (hash01(k, 5) < 0.18) return { lift: 0, tilt: 0, swallow: 0 };
  const long = hash01(k, 6) < 0.3 ? 1.5 : 1;
  const at = (x0: number, x1: number) => ease((u - x0) / (x1 - x0));
  const up = 0.14, hold = 0.14 + 0.2 * long;
  const lift = at(0.02, up) * (1 - at(hold + 0.04, hold + 0.18));
  const tilt = at(up, up + 0.06) * (1 - at(hold, hold + 0.06));
  const swallow = tilt > 0.5 ? Math.max(0, Math.sin(u * P * 5.5)) : 0;
  return { lift, tilt, swallow };
}

/**
 * The life in any pose that isn't walking or lying down: breathing (the chest and shoulders rise
 * and fall), the head never quite still, and on their feet a slow shift of weight. Small, so it adds
 * to an action without changing it.
 */
function lifeLayer(p: Pose, t: number, standing: boolean): void {
  const breath = Math.sin(t * 1.5);
  p.spine += breath * 0.008;
  p.shLz += breath * 0.01;
  p.shRz += breath * 0.01;
  p.neck += wander(t, 1) * 0.03;
  p.neckTurn += wander(t * 0.8, 2) * 0.07;
  if (standing) {
    p.spineTwist += wander(t * 0.5, 3) * 0.035;
    const shift = wander(t * 0.35, 4) * 0.06;
    p.hipLz += shift;
    p.hipRz -= shift;
  }
}

function activityLayer(p: Pose, activity: Activity, t: number, posture: Posture): void {
  const s = Math.sin;
  switch (activity) {
    case 'idle':
      p.neckTurn += s(t * 0.35) * 0.3 * s(t * 0.13);
      break;
    case 'eat': {
      // The spoon hand: down to the bowl for a scoop, up to the mouth, back down to chew; the other
      // hand steadies the bowl; the head dips to meet the spoon; leaning in over the table.
      const c = eatCycle(t);
      Object.assign(p, {
        shLx: -0.52 + 0.04 * c.reach, elL: -1.3, shLz: -0.06,
        shRx: -0.5 - 0.62 * c.lift + 0.14 * c.reach, elR: -1.15 - 0.95 * c.lift + 0.25 * c.reach, shRz: -0.06 - 0.12 * c.lift,
      });
      p.spine += 0.05 + 0.05 * c.reach + 0.02 * c.lift;
      p.neck += 0.16 + 0.12 * c.reach + 0.07 * c.lift;
      p.neckTurn += c.look * 0.35;
      // Standing (no table to steady the bowl on): the free hand hangs at the side.
      if (posture === 'stand') Object.assign(p, { shLx: -0.06, elL: -0.32, shLz: 0.1 });
      break;
    }
    case 'drink': {
      // The cup held at the chest between sips, the other hand on the knee or the table; at the
      // lips the head tips back with the cup (the arm itself is brought to the mouth by the
      // avatar's own reach, KyndAvatar.reachFor).
      const c = drinkCycle(t);
      Object.assign(p, { shLx: -0.3, elL: -0.95, shLz: -0.04, shRx: -0.42, elR: -1.35, shRz: -0.04 });
      if (posture === 'stand') Object.assign(p, { shLx: -0.06, elL: -0.32, shLz: 0.1, shRx: -0.22, elR: -1.5 });
      p.neck += 0.08 - 0.3 * c.tilt;
      p.spine += 0.02 - 0.03 * c.tilt;
      break;
    }
    case 'read':
      Object.assign(p, { shLx: -0.75, elL: -1.15, shLz: -0.22, shRx: -0.75, elR: -1.15, shRz: -0.22 });
      p.neck += 0.38;
      p.neckTurn += s(t * 0.25) * 0.08;
      break;
    case 'talk': {
      // A nod on each stressed word, the hand rising with the phrase.
      const ph = speechPhrase(t, 0);
      p.neck += ph.stress * 0.12;
      p.shRx = -0.35 - 0.3 * Math.max(0, s(t * 2.7)) * (0.4 + 0.6 * ph.on);
      p.elR = -0.9 - 0.35 * s(t * 2.1);
      p.shLx = -0.1 - 0.15 * Math.max(0, s(t * 1.7 + 2));
      p.elL = -0.5;
      p.neck += s(t * 2.3) * 0.04;
      p.spine += s(t * 1.1) * 0.03;
      break;
    }
    case 'joke':
      Object.assign(p, { shLx: -0.6 + 0.45 * s(t * 4.5), shLz: 0.45, elL: -1.1, shRx: -0.6 - 0.45 * s(t * 4.5), shRz: 0.45, elR: -1.1 });
      p.spine += s(t * 3) * 0.08;
      break;
    case 'laugh':
      Object.assign(p, { shLx: -0.35, elL: -1.45, shLz: -0.1, shRx: -0.35, elR: -1.45, shRz: -0.1 });
      p.spine += -0.14 + s(t * 11) * 0.06;
      p.neck += -0.25;
      break;
    case 'cook':
      {
        // Stirring in bursts: round and round, a pause to look in the pot, round again.
        const busy = ease(0.5 + wander(t * 0.6, 5) * 1.4);
        const st = t * 3.5 + wander(t, 6) * 0.8;
        Object.assign(p, { shRx: -0.85 + 0.12 * s(st) * busy, shRz: 0.1 + 0.15 * Math.cos(st) * busy, elR: -0.7 - 0.1 * (1 - busy), shLx: -0.35 - 0.2 * (1 - busy), elL: -0.7 - 0.4 * (1 - busy) });
        p.neck += 0.12 + 0.12 * (1 - busy);
        p.spine += 0.04;
      }
      p.spine += 0.15;
      p.neck += 0.3;
      break;
    case 'wash':
      {
        const scrub = 0.6 + 0.4 * ease(0.5 + wander(t * 0.7, 7));
        Object.assign(p, { shLx: -1.25, elL: -2.1, shLz: -0.28 + 0.08 * scrub * s(t * 7), shRx: -1.25, elR: -2.1, shRz: -0.28 + 0.08 * scrub * s(t * 7 + 1 + wander(t, 8)) });
      }
      p.spine += 0.28;
      p.neck += 0.35;
      break;
    case 'warm':
      Object.assign(p, { shLx: -1.0, elL: -0.35, shLz: -0.12 + 0.04 * s(t * 5), shRx: -1.0, elR: -0.35, shRz: -0.12 + 0.04 * s(t * 5 + 2) });
      p.spine += 0.06;
      break;
    case 'sleep':
      p.spine += s(t * 1.2) * 0.02;
      // Asleep, the head sinks back a touch and rolls to one side on the pillow.
      p.neck += -0.08;
      p.neckTurn += 0.25;
      break;
    case 'garden':
      {
        // Strokes of uneven pace, the back bending into them, and a straightening now and then.
        const rest = ease((wander(t * 0.3, 9) - 0.55) * 5);
        const st = t * 3 + wander(t, 10) * 1.2;
        const k = 1 - rest;
        Object.assign(p, { shLx: -0.95 * k - 0.2 * rest + 0.3 * s(st) * k, elL: -0.4 - 0.5 * rest, shRx: -0.95 * k - 0.2 * rest + 0.3 * s(st + 1.6) * k, elR: -0.4 - 0.5 * rest });
        p.spine += 0.06 * k * (1 + s(st));
        p.neck += 0.15 * k;
      }
      p.neck += 0.45;
      break;
    case 'hug':
      Object.assign(p, { shLx: -1.35, shLz: 0.3, elL: -1.0, shRx: -1.35, shRz: 0.3, elR: -1.0 });
      p.neck += 0.1;
      p.neckTurn += 0.35;
      break;
    case 'think': {
      const move = s(t * 0.9) > 0.85;
      Object.assign(p, { shRx: -0.95, elR: -2.25, shRz: -0.2, shLx: move ? -1.1 : -0.55, elL: move ? -0.5 : -1.2 });
      p.neck += 0.32;
      break;
    }
    case 'reach':
      Object.assign(p, { shRx: -1.05 + 0.15 * s(t * 3 + wander(t, 11)), elR: -0.35 - 0.15 * ease(0.5 + wander(t * 0.5, 12)), shLx: -0.25 + 0.1 * wander(t * 0.4, 13), elL: -0.4 });
      p.neckTurn += wander(t * 0.6, 14) * 0.12;
      p.spine += 0.22;
      p.neck += 0.2;
      break;
    case 'fish': {
      // Rod held out over the water in both hands, the tip bobbing; now and then a fresh cast.
      const cycle = (t % 14) / 14;
      const cast = cycle < 0.08 ? Math.sin((cycle / 0.08) * Math.PI) : 0;
      Object.assign(p, { shRx: -0.85 - cast * 1.2 + 0.04 * s(t * 0.8), elR: -0.55 + cast * 0.3, shRz: 0.05, shLx: -0.75 - cast * 0.6, elL: -1.05, shLz: 0.25 });
      p.neck += 0.18;
      p.spine += 0.04;
      break;
    }
    case 'watch':
      p.neckTurn += s(t * 0.4) * 0.55;
      p.neck += -0.05;
      if (posture === 'sit') Object.assign(p, { shLx: -0.45, elL: -0.9, shRx: -0.45, elR: -0.9 });
      break;
    case 'bathe':
      // Forearms resting along the tub rim.
      Object.assign(p, { shLz: 0.55, shLx: -0.35, elL: -1.1, shRz: 0.55, shRx: -0.35, elR: -1.1 });
      p.neck += -0.12;
      break;
    case 'relax':
      Object.assign(p, { shLx: -2.7, elL: -1.9, shLz: 0.3, shRx: -2.7, elR: -1.9, shRz: 0.3 });
      break;
    case 'dress': {
      // Pulling a garment over the head, then tugging it straight: arms up, down, a shimmy.
      const up = 0.5 + 0.5 * s(t * 2.2);
      Object.assign(p, { shLx: -0.6 - 2.1 * up, elL: -0.4 - 1.2 * up, shRx: -0.6 - 2.1 * up, elR: -0.4 - 1.2 * up, shLz: 0.25, shRz: 0.25 });
      p.spine += s(t * 4.4) * 0.05;
      p.neck += 0.1 * up;
      break;
    }
    case 'flirt':
      // Lean in, a hand to the hair, a bashful sway.
      Object.assign(p, { shRx: -2.3 + 0.15 * s(t * 2), elR: -2.0, shRz: 0.15, shLx: -0.2, elL: -0.4 });
      p.spine += 0.1 + s(t * 1.3) * 0.04;
      p.neckTurn += s(t * 1.1) * 0.15;
      p.neck += -0.05;
      break;
    case 'kiss':
      Object.assign(p, { shLx: -1.2, shLz: 0.15, elL: -1.3, shRx: -1.2, shRz: 0.15, elR: -1.3 });
      p.spine += 0.18;
      p.neck += 0.05;
      p.neckTurn += 0.25;
      break;
    case 'argue':
      // Jabbing finger, the other fist on the hip.
      Object.assign(p, { shRx: -1.1 - 0.35 * Math.max(0, s(t * 5)), elR: -0.3, shRz: -0.05, shLx: -0.2, shLz: 0.55, elL: -1.9 });
      p.spine += 0.12 + s(t * 5) * 0.04;
      p.neck += -0.08 + s(t * 5) * 0.05;
      break;
    case 'sulk':
      Object.assign(p, { shLx: -0.55, elL: -1.5, shLz: -0.25, shRx: -0.55, elR: -1.5, shRz: -0.25 });
      p.neck += 0.35;
      p.spine += 0.1;
      break;
    case 'play':
      // Lute across the body: left hand up on the neck, right hand strumming over the rose.
      Object.assign(p, { shLx: -0.95, shLy: 0.1, shLz: -0.28, elL: -1.45, shRx: -0.38 + 0.06 * s(t * 8), shRy: 0, shRz: -0.22, elR: -1.35 });
      p.neck += 0.15;
      p.neckTurn += s(t * 0.8) * 0.2;
      p.spine += s(t * 2) * 0.03;
      break;
    case 'tend':
      // Leaning over a cradle: both hands down and in, rocking gently.
      Object.assign(p, { shLx: -0.95, elL: -0.55, shLz: -0.1 + 0.06 * s(t * 1.8), shRx: -0.95, elR: -0.55, shRz: -0.1 - 0.06 * s(t * 1.8) });
      p.spine += 0.38 + s(t * 1.8) * 0.03;
      p.neck += 0.35;
      break;
    case 'dance': {
      // A country dance: a bounce on the beat, arms up and swinging, a sway from the hips.
      const beat = s(t * 4.4);
      p.pelvisY = STAND_HIP - 0.045 * Math.abs(beat);
      Object.assign(p, { shLx: -1.9 + 0.45 * beat, shLz: 0.5, elL: -0.7, shRx: -1.9 - 0.45 * beat, shRz: 0.5, elR: -0.7 });
      p.spineTwist += s(t * 2.2) * 0.28;
      p.neckTurn += s(t * 2.2) * 0.22;
      p.hipL = 0.3 * Math.max(0, s(t * 2.2));
      p.hipR = 0.3 * Math.max(0, -s(t * 2.2));
      break;
    }
    case 'confused':
      Object.assign(p, { shLz: 0.45, shLx: -0.35, elL: -1.2, shRz: 0.45, shRx: -0.35, elR: -1.2 });
      p.neckTurn += s(t * 1.5) * 0.35;
      break;
  }
}

export function walkLayer(p: Pose, phase: number, running: boolean, carrying: CarryItem, limp = false): void {
  // A hobble (a sprained right ankle): the bad step is hurried through, so the rhythm goes uneven.
  if (limp) phase += 0.45 * Math.sin(phase);
  const amp = running ? 0.75 : 0.48;
  const s = Math.sin(phase);
  p.hipL = -amp * s;
  p.hipR = amp * s;
  p.kneeL = 0.12 + (running ? 1.1 : 0.7) * Math.max(0, Math.sin(phase + 1.9));
  p.kneeR = 0.12 + (running ? 1.1 : 0.7) * Math.max(0, Math.sin(phase + 1.9 + Math.PI));
  // A planted, readable life-sim gait: the hips settle over the weight-bearing foot while the
  // chest counters the stride. Driving this from distanceWalked keeps the feet from skating.
  p.pelvisY = STAND_HIP - (running ? 0.05 : 0.035) + (running ? 0.055 : 0.035) * Math.abs(Math.cos(phase));
  p.spine = (running ? 0.18 : 0.03) + Math.cos(phase * 2) * (running ? 0.025 : 0.012);
  p.spineTwist = -s * (running ? 0.12 : 0.075);
  // Heel strike with the toes up as the leg reaches forward, a push off the toes as it trails.
  const push = running ? 0.55 : 0.38;
  p.ankleL = push * Math.max(0, Math.sin(phase + 1.9 + 0.55)) - 0.14 * Math.max(0, s);
  p.ankleR = push * Math.max(0, Math.sin(phase + 1.9 + 0.55 + Math.PI)) - 0.14 * Math.max(0, -s);
  p.neckTurn = s * (running ? 0.045 : 0.025);
  if (limp) {
    // The bad leg barely bends and swings out round, not through; its forward step is short.
    p.hipR = p.hipR < 0 ? p.hipR * 0.45 : p.hipR * 0.8;
    p.kneeR = 0.08 + 0.18 * Math.max(0, Math.sin(phase + 1.9 + Math.PI));
    p.hipRz = 0.1 * Math.max(0, -Math.sin(phase));
    // Weight snatched back onto the good leg: a dip and a lean forward over it.
    p.pelvisY -= 0.03 * Math.max(0, Math.sin(phase));
    p.spine += 0.09 + 0.05 * Math.max(0, Math.sin(phase));
    p.spineTwist *= 1.6;
  }
  if (carrying) {
    Object.assign(p, { shLx: -0.5, elL: -1.15, shLz: -0.08, shRx: -0.5, elR: -1.15, shRz: -0.08 });
  } else {
    // Arms swing against the legs, the elbow bending as the arm comes forward and easing
    // straighter as it swings back, so the swing reads from any side.
    p.shLx = amp * 0.95 * s;
    p.shRx = -amp * 0.95 * s;
    p.shLz = 0.09 - s * 0.04;
    p.shRz = 0.09 + s * 0.04;
    const bend = running ? 1.25 : 0.22;
    p.elL = -(bend + (running ? 0.2 : 0.38) * Math.max(0, -s));
    p.elR = -(bend + (running ? 0.2 : 0.38) * Math.max(0, s));
  }
}

/** Personality is visible before the player opens a panel: each idle silhouette has a point of view. */
function traitLayer(p: Pose, traits: readonly string[], t: number): void {
  const has = (id: string) => traits.includes(id);
  const s = Math.sin;
  if (has('hotheaded')) {
    // Wide elbows, forward chest, impatient weight shift.
    Object.assign(p, { shLz: 0.42, shRz: 0.42, elL: -1.65, elR: -1.65 });
    p.spine -= 0.045;
    p.neckTurn += s(t * 1.7) * 0.12;
  } else if (has('lazy')) {
    // Uneven, comfortable slouch rather than the same mannequin stance as everyone else.
    p.spine += 0.11;
    p.neck += 0.12;
    p.shLz -= 0.08;
    p.shRz += 0.03;
    p.pelvisY -= 0.025;
  } else if (has('gloomy')) {
    p.spine += 0.08;
    p.neck += 0.22;
    p.shLz -= 0.05;
    p.shRz -= 0.05;
  } else if (has('hardworking')) {
    // Upright, ready posture with one hand resting at the belt.
    Object.assign(p, { shLx: -0.05, shLz: 0.13, elL: -0.42, shRx: -0.05, elR: -0.3 });
    p.spine -= 0.025;
  } else if (has('bookish') || has('solitary')) {
    Object.assign(p, { shLx: -0.32, elL: -1.15, shLz: -0.08, shRx: -0.18, elR: -0.65 });
    p.neck += 0.09;
    p.neckTurn += s(t * 0.23) * 0.16;
  } else if (has('social') || has('family')) {
    // Open hands and a small conversational fidget invite other Kynds in.
    p.shLz += 0.13;
    p.shRz += 0.13;
    p.shRx -= Math.max(0, s(t * 0.8)) * 0.18;
    p.elR -= 0.25;
  } else if (has('romantic')) {
    p.shRx = -0.28;
    p.elR = -1.05;
    p.spine += s(t * 0.65) * 0.025;
    p.neckTurn += s(t * 0.5) * 0.12;
  }
  if (has('cheerful') || has('mischievous')) {
    p.pelvisY += Math.max(0, s(t * (has('mischievous') ? 3.4 : 2.1))) * 0.012;
    p.neckTurn += s(t * 0.9) * 0.09;
    p.spineTwist += s(t * 0.7) * 0.035;
  }
}

/** The little things people do while standing or sitting about, now and then. */
export const HABITS = ['neck', 'stretch', 'shoulders', 'scratch', 'glance', 'rubHands', 'brushDown', 'hips'] as const;
export type Habit = (typeof HABITS)[number];
const HABIT_SLOT = 11;
const HABIT_LEN = 3.2;

/**
 * Which habit (if any) is under way at time `t` (each Kynd's own clock): time is cut into slots of
 * about 11 s; in most a habit starts somewhere along it and runs about 3 s. `k` eases it in and out,
 * `u` is how far through it is. Seated, only those that suit a chair.
 */
export function idleHabit(t: number, seated = false): { habit: Habit; k: number; u: number } | null {
  const n = Math.floor(t / HABIT_SLOT);
  const r = (j: number) => {
    const v = Math.sin(n * 78.233 + j * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  };
  if (r(1) < 0.3) return null;
  const pool: readonly Habit[] = seated ? ['neck', 'stretch', 'shoulders', 'scratch', 'glance', 'rubHands'] : HABITS;
  const habit = pool[Math.floor(r(2) * pool.length)];
  const start = r(3) * (HABIT_SLOT - HABIT_LEN);
  const u = (t - n * HABIT_SLOT - start) / HABIT_LEN;
  if (u < 0 || u >= 1) return null;
  const k = Math.min(1, u / 0.22, (1 - u) / 0.22);
  return { habit, k: k * k * (3 - 2 * k), u };
}

function habitLayer(p: Pose, t: number, seated: boolean): void {
  const h = idleHabit(t, seated);
  if (!h) return;
  const { k, u } = h;
  const set = (o: Partial<Pose>) => {
    for (const [j, v] of Object.entries(o) as [Joint, number][]) p[j] += (v - p[j]) * k;
  };
  const s = Math.sin;
  switch (h.habit) {
    case 'neck':
      // A hand round to the back of the neck, rubbing; the head tips forward into it.
      // (Angles solved on the skeleton to put the palm on the nape.)
      set({ shRx: -2.67, shRy: 0.8, shRz: -0.15, elR: -2.2, wristR: 0.3, gripR: 0.25 });
      p.neck += 0.22 * k;
      p.neckTurn += s(u * 18) * 0.05 * k;
      break;
    case 'stretch': {
      // Arms up and back, the chest out, then down again.
      const up = Math.sin(Math.PI * Math.min(1, u * 1.25));
      set({ shLx: -2.7 * up, shRx: -2.7 * up, shLz: 0.25, shRz: 0.25, elL: -0.5 * up, elR: -0.5 * up, gripL: -0.4, gripR: -0.4 });
      p.spine -= 0.12 * up * k;
      p.neck -= 0.25 * up * k;
      break;
    }
    case 'shoulders':
      // Shoulders rolled, head tipped side to side.
      p.shLz += s(u * Math.PI * 4) * 0.12 * k;
      p.shRz += s(u * Math.PI * 4 + 1.5) * 0.12 * k;
      p.neckTurn += s(u * Math.PI * 2) * 0.3 * k;
      p.neck -= 0.08 * k;
      break;
    case 'scratch':
      // A scratch behind the ear, the head cocked toward the hand.
      // (Solved to put the fingertips behind the ear.)
      set({ shLx: -2.15, shLy: -0.4, shLz: 0.05, elL: -2.0, wristL: 0.35, gripL: 0.55 });
      p.neckTurn -= 0.18 * k;
      p.shLz += s(u * 30) * 0.03 * k;
      break;
    case 'glance':
      // A look back over the shoulder, as if someone called.
      p.neckTurn += 1.0 * k;
      p.spineTwist += 0.28 * k;
      break;
    case 'rubHands':
      // Hands together in front, rubbed against the cold or at the prospect of something.
      set({ shLx: -0.55, shRx: -0.55, shLy: -0.55, shRy: 0.55, shLz: -0.05, shRz: -0.05, elL: -1.35, elR: -1.35, twistL: -0.8, twistR: -0.8, gripL: 0.15, gripR: 0.15 });
      p.elL += s(u * 40) * 0.08 * k;
      p.elR -= s(u * 40) * 0.08 * k;
      break;
    case 'brushDown':
      // Brushing down the front of their clothes, looking down at them.
      set({ shLx: -0.45 + s(u * 22) * 0.25, shRx: -0.45 - s(u * 22) * 0.25, elL: -0.9, elR: -0.9, shLy: -0.3, shRy: 0.3, gripL: -0.2, gripR: -0.2, twistL: 0.6, twistR: 0.6 });
      p.neck += 0.35 * k;
      p.spine += 0.06 * k;
      break;
    case 'hips':
      // Hands on hips, weight on one leg.
      // (Solved to rest each palm on the hip.)
      set({ shLx: 0.75, shRx: 0.75, shLy: -0.12, shRy: 0.12, shLz: 0.2, shRz: 0.2, elL: -1.4, elR: -1.4, twistL: 1.2, twistR: 1.2, gripL: 0.35, gripR: 0.35 });
      p.hipLz += 0.06 * k;
      p.hipRz -= 0.06 * k;
      break;
  }
}

/** Idle body language that tells the player how a Kynd feels without opening any panel. */
function emotionLayer(p: Pose, emotion: EmotionId, intensity: number, t: number): void {
  const k = Math.min(1, intensity / 2);
  const s = Math.sin;
  switch (emotion) {
    case 'happy':
    case 'confident':
      p.spine -= 0.03 * k;
      p.neck -= 0.08 * k;
      p.pelvisY += Math.abs(s(t * 2.2)) * 0.012 * k;
      break;
    case 'playful':
      p.pelvisY += Math.abs(s(t * 4)) * 0.02 * k;
      p.neckTurn += s(t * 2) * 0.2 * k;
      break;
    case 'romantic':
      p.neckTurn += s(t * 0.8) * 0.25 * k;
      p.spine += s(t * 1.2) * 0.03;
      break;
    case 'sad':
      p.neck += 0.4 * k;
      p.spine += 0.14 * k;
      p.shLz -= 0.05 * k;
      p.shRz -= 0.05 * k;
      break;
    case 'angry':
      // Arms folded tight across the chest: forearms level, turned inward.
      Object.assign(p, { shLx: -0.35 * k, shLy: -1.05 * k, shLz: 0.18 * k, elL: -1.75 * k, shRx: -0.35 * k, shRy: 1.05 * k, shRz: 0.18 * k, elR: -1.75 * k });
      p.neck -= 0.05 * k;
      break;
    case 'embarrassed':
      Object.assign(p, { shRx: -2.5 * k, elR: -2.3 * k, shRz: 0.05 });
      p.neck += 0.3 * k;
      break;
    case 'tense':
    case 'afraid':
      p.neckTurn += s(t * 3.1) * 0.25 * k;
      p.shLz -= 0.1 * k;
      p.shRz -= 0.1 * k;
      break;
    case 'bored':
      p.neck += 0.15 * k;
      p.spine += 0.06 * k;
      p.neckTurn += s(t * 0.2) * 0.4 * k;
      break;
    default:
      break;
  }
}

export interface AvatarState {
  /** Fishing: how far below the angler's feet the water lies (a pond's edge, a quay, a rock). */
  waterBelow?: number;
  posture: Posture;
  activity: Activity;
  carrying: CarryItem;
  moving: boolean;
  running: boolean;
  distanceWalked: number;
  /** Height of the surface the Kynd lies on (bed ≈ 0.5, floor 0). */
  lieHeight: number;
  emotion?: EmotionId;
  emotionIntensity?: number;
  /** Personality traits shape idle body language, so NPCs read differently at a glance. */
  traits?: readonly string[];
  /** Looking at a social or work target suppresses random eye wandering. */
  engaged?: boolean;
  /** Astride a horse (drawn in its saddle). */
  riding?: boolean;
  /** Getting up into the saddle or down from it: 0 on the ground beside the horse, 1 seated. */
  mounting?: number;
  /** 0 … 1 through a pregnancy (the bump shows from about a third of the way). */
  pregnancy?: number;
  /** Hobbling on a sprained ankle. */
  limp?: boolean;
  /** Asleep under a bed's quilt (bedCovers.ts): what lies under it isn't drawn. */
  tucked?: boolean;
  /** Seated on something with a back (a chair, a settle, a throne): a cloak is thrown back over it. */
  seatBack?: boolean;
  /** Who they're attending to, as an angle from where the body faces (radians, + turns the head left as the body turns). */
  lookTurn?: number;
}


/**
 * How far back (radians) a cloak hanging from the shoulders must swing to clear what reaches back
 * under it in this pose: each knee, mid-shin and ankle (from the hip and knee angles, in the
 * authored body's metres), and the tunic's back skirts that swing with a trailing leg.
 */
export function cloakClearance(p: { hipL: number; kneeL: number; hipR: number; kneeR: number; shLx: number; shRx: number }): number {
  const PIVOT_Y = SPINE_Y + 0.5 - PELVIS_Y, THIGH = PELVIS_Y - KNEE_Y, SHIN = KNEE_Y - ANKLE_Y;
  // The back of the cloak at a height above the hip (its depth grows toward the hem at 0.38 m).
  const capeBack = (yRel: number) => {
    const y = yRel + PELVIS_Y;
    return 0.16 + 0.11 * Math.min(1, Math.max(0, (1.44 - y) / (1.44 - 0.38))) + 0.01;
  };
  let need = 0;
  // `side`: how far round toward the side the part is (0 the middle of the back), where the
  // cloak's fall curves in and lies shallower.
  const clear = (yRel: number, back: number, margin: number, side = 0) => {
    const y = yRel + PELVIS_Y;
    if (y < 0.33 || y > 1.3) return;
    const lever = PIVOT_Y - yRel;
    const s = (back + margin - capeBack(yRel) * (1 - 0.35 * side)) / lever;
    if (s > 0) need = Math.max(need, Math.asin(Math.min(1, s)));
  };
  for (const [hip, knee] of [[p.hipL, p.kneeL], [p.hipR, p.kneeR]]) {
    const kz = THIGH * Math.sin(hip), ky = -THIGH * Math.cos(hip);
    const az = kz + SHIN * Math.sin(hip + knee), ay = ky - SHIN * Math.cos(hip + knee);
    clear(ky, kz, 0.07);
    clear((ky + ay) / 2, (kz + az) / 2, 0.06);
    clear(ay, az, 0.055);
    // A tunic's or gown's back skirts swing back with a trailing leg.
    if (hip > 0) {
      clear(-0.2, 0.17 + 0.3 * Math.sin(hip), 0.04, 0.7);
      clear(-0.3, 0.17 + 0.36 * Math.sin(hip), 0.04, 0.7);
      clear(-0.42, 0.17 + 0.48 * Math.sin(hip), 0.03, 0.8);
    }
  }
  // Hands swinging back at the sides, where the cloak's fall is shallower (its sides curve in).
  for (const sh of [p.shLx, p.shRx]) {
    if (sh <= 0) continue;
    const ARM = SH_Y - WRIST_Y;
    clear(SH_Y - PELVIS_Y - ARM * Math.cos(sh), ARM * Math.sin(sh) + 0.05, 0.02, 1);
  }
  return need;
}

/** Soft round contact shadow texture, shared by every Kynd. */
let blobTexture: THREE.Texture | null = null;
function blobShadowTexture(): THREE.Texture {
  if (blobTexture) return blobTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  blobTexture = new THREE.CanvasTexture(c);
  return blobTexture;
}

/** Invisible stand-ins for picking: raycasting a skinned body would be slow and needless. */
const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
const pickSphere = new THREE.SphereGeometry(1, 8, 6);
const pickCapsule = new THREE.CapsuleGeometry(1, 1, 2, 8);

interface Expression {
  smile: number;
  jaw: number;
  brow: number;
  inner: number;
  asym: number;
  lid: number;
  pucker: number;
  lookX: number;
  lookY: number;
}

const neutralFace = (): Expression => ({ smile: 0.25, jaw: 0, brow: 0, inner: 0, asym: 0, lid: 1, pucker: 0, lookX: 0, lookY: 0 });

/**
 * Where a talker is in their speech: phrases of 1–2.5 s with short breaths between (`on` eases in
 * and out), and `stress` pulsing on a word or two in each phrase. Seeded per Kynd so two talkers
 * never move in step.
 */
export function speechPhrase(t: number, seed: number): { on: number; stress: number } {
  const len = 2.4;
  const n = Math.floor((t + seed * 3.7) / len);
  const r = (k: number) => { const v = Math.sin(n * 91.7 + seed * 13.1 + k) * 43758.5453; return v - Math.floor(v); };
  const local = (t + seed * 3.7) - n * len;
  const speak = 1.1 + r(1) * 1.0;
  const on = smoothstepA(0, 0.12, local) * (1 - smoothstepA(speak - 0.15, speak, local));
  const w1 = 0.25 + r(2) * (speak - 0.5);
  const stress = on * Math.exp(-(((local - w1) / 0.13) ** 2));
  return { on, stress };
}

function smoothstepA(a: number, b: number, x: number): number {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

/** What the face does, from the Kynd's emotion and what they are doing. */
function expressionFor(state: AvatarState, t: number, seed: number): Expression {
  const e = neutralFace();
  const k = 0.45 + 0.55 * Math.min(1, (state.emotionIntensity ?? 0) / 2);
  switch (state.emotion) {
    case 'happy':
    case 'confident':
    case 'inspired':
      e.smile = 0.75 * k;
      e.brow = 0.25 * k;
      break;
    case 'playful':
      e.smile = 0.85 * k;
      e.asym = 0.4 * k;
      e.lid = 0.88;
      break;
    case 'romantic':
      e.smile = 0.55 * k;
      e.lid = 0.78;
      e.brow = 0.15;
      break;
    case 'sad':
      e.smile = -0.7 * k;
      e.inner = 0.9 * k;
      e.lid = 0.8;
      e.lookY = 0.12;
      break;
    case 'angry':
      e.smile = -0.6 * k;
      e.inner = -1 * k;
      e.brow = -0.35 * k;
      e.lid = 0.84;
      break;
    case 'embarrassed':
      e.smile = 0.3;
      e.inner = 0.45 * k;
      e.lid = 0.72;
      e.lookY = 0.2;
      e.lookX = 0.25;
      break;
    case 'afraid':
    case 'tense':
      e.smile = -0.35 * k;
      e.brow = 0.8 * k;
      e.inner = 0.6 * k;
      e.lid = 1.18;
      // The mouth falls a little open.
      e.jaw = Math.max(e.jaw, 0.14 * k);
      break;
    case 'uncomfortable':
      e.smile = -0.35 * k;
      e.inner = 0.35 * k;
      break;
    case 'bored':
      e.smile = -0.1;
      e.lid = 0.66;
      e.brow = -0.1;
      break;
    default:
      break;
  }
  const s = Math.sin;
  // Speech comes in phrases: a run of syllables, a breath, the next phrase (as Sims talk in Simlish).
  const phrase = speechPhrase(t, seed);
  const talk = () => phrase.on * Math.max(0, s(t * 13.1 + seed) * 0.55 + s(t * 8.3 + seed * 2) * 0.45) * 0.62;
  switch (state.activity) {
    case 'talk':
    case 'flirt':
      e.jaw = talk();
      // Brows lift on the stressed words; between phrases the face settles, listening for the reply.
      e.brow += phrase.stress * 0.55;
      e.smile += phrase.on * 0.1;
      if (state.activity === 'flirt') {
        e.smile = Math.max(e.smile, 0.6);
        e.lid = 0.85;
        e.lookX = 0.15 * s(t * 0.9);
      }
      break;
    case 'argue':
      e.jaw = talk() * 1.2;
      e.inner -= phrase.stress * 0.3;
      e.smile = Math.min(e.smile, -0.5);
      e.inner = -0.9;
      break;
    case 'joke':
    case 'laugh':
      e.smile = 1;
      e.jaw = 0.45 + Math.abs(s(t * (state.activity === 'laugh' ? 11 : 6))) * 0.4;
      e.lid = 0.55;
      e.brow = 0.3;
      break;
    case 'eat': {
      // The mouth opens for the spoon, then chews (a chew a little faster than once a second, uneven).
      const c = eatCycle(t + seed);
      e.jaw = Math.max(c.lift > 0.85 ? 0.3 * c.lift : 0, c.chew * Math.max(0, s((t + seed) * 7.4)) * 0.3);
      e.smile = Math.max(e.smile, 0.15);
      break;
    }
    case 'drink': {
      // Lips to the rim, eyes half down over the cup; a swallow now and then.
      const c = drinkCycle(t + seed);
      e.jaw = c.lift > 0.8 ? 0.12 + c.swallow * 0.05 : 0;
      e.pucker = c.lift * 0.35;
      e.lid = Math.min(e.lid, 1 - 0.35 * c.tilt);
      break;
    }
    case 'kiss':
      e.pucker = 1;
      e.smile = 0;
      e.lid = 0.1;
      break;
    case 'sleep':
      e.lid = 0;
      e.smile = 0.05;
      e.jaw = 0.04;
      e.inner = 0;
      e.brow = 0;
      break;
    case 'think':
      e.inner = -0.35;
      e.lookX = 0.35;
      e.lookY = -0.2;
      e.smile = Math.min(e.smile, 0);
      e.pucker = 0.25;
      break;
    case 'confused':
      e.asym = 0.9;
      e.smile = -0.25;
      break;
    case 'sulk':
      e.smile = -0.75;
      e.inner = 0.5;
      e.lookY = 0.25;
      break;
    case 'read':
      e.lookY = 0.35;
      e.lookX = 0.12 * s(t * 1.7);
      break;
    case 'relax':
    case 'bathe':
      e.smile = Math.max(e.smile, 0.45);
      e.lid = 0.62;
      break;
    case 'dance':
      e.smile = Math.max(e.smile, 0.85);
      break;
    case 'tend':
    case 'play':
      e.smile = Math.max(e.smile, 0.6);
      e.lookY = state.activity === 'tend' ? 0.3 : 0.1;
      break;
    case 'watch':
      e.lookX = 0.3 * s(t * 0.4);
      break;
    case 'cook':
    case 'wash':
    case 'garden':
      e.lookY = 0.3;
      break;
    default:
      break;
  }
  return e;
}

type PartName = 'skin' | 'garment' | 'shoes' | 'feet' | 'bare' | 'hat' | 'hair' | 'eye' | 'metal';
const PARTS: PartName[] = ['skin', 'garment', 'shoes', 'feet', 'bare', 'hat', 'hair', 'eye', 'metal'];

interface BuiltBody {
  key: string;
  geos: Partial<Record<PartName, THREE.BufferGeometry>>;
  m: Measure;
  face: FaceLayout;
  skin: FaceDetail;
  refs: number;
}

/**
 * Built bodies by look and stage. A Kynd's portrait and their avatar in the world (or several
 * identical NPC Kynds) share one set of buffers; unused entries are freed when the cache is full.
 */
const bodyCache = new Map<string, BuiltBody>();
const CACHE_LIMIT = 48;

function acquireBody(L: FullAppearance, stage: LifeStage): BuiltBody {
  const key = `${stage}|${JSON.stringify(L)}`;
  let b = bodyCache.get(key);
  if (b) {
    // Most recently used goes to the end.
    bodyCache.delete(key);
    bodyCache.set(key, b);
    b.refs++;
    return b;
  }
  const grown = stage === 'adult' || stage === 'elder';
  const m = measure(L, stage);
  const head = new Head(L, stage);
  const C = palette(L);
  const B: BodyBuckets = { garment: new Bucket(), shoes: new Bucket(), feet: new Bucket(), bare: new Bucket(), hat: new Bucket(), skin: new Bucket(), hair: new Bucket(), eye: new Bucket(), metal: new Bucket() };
  buildHead(B, head, C, L, stage);
  buildHair(B, head, C, L, hairCoverFor(L.headwear), m);
  buildBeard(B, head, C, L.beardStyle);
  buildHands(B, m, C);
  buildBareFeet(B, m, C);
  const noble = L.outfit === 'surcoat' || L.outfit === 'gown' || L.headwear === 'crown' || L.headwear === 'circlet';
  const fine = noble || L.outfit === 'doublet' || L.outfit === 'cotehardie';
  const dress = { B, m, C, look: L, head, crown: hairCrown(L.hairStyle), noble, fine };
  buildOutfit(dress);
  buildBareBody(dress);
  // Headwear in its own part: a hood or veil stays on in the bath (the hair under it isn't built).
  buildHeadwear({ ...dress, B: { ...B, garment: B.hat } });
  const geos: Partial<Record<PartName, THREE.BufferGeometry>> = {};
  for (const name of PARTS) if (B[name].vertexCount > 0) geos[name] = B[name].toGeometry(name === 'garment' || name === 'shoes' || name === 'hat', name === 'skin' || name === 'feet' || name === 'bare');
  const lum = C.hair.r * 0.3 + C.hair.g * 0.55 + C.hair.b * 0.15;
  const skin: FaceDetail = {
    age: stage === 'elder' ? 1 : grown ? 0.3 : 0,
    stubble: stubbleFor(L.beardStyle, lum, L.sex, grown),
    freckles: L.freckles,
    scar: L.scar,
  };
  b = { key, geos, m, face: head.f, skin, refs: 1 };
  bodyCache.set(key, b);
  if (bodyCache.size > CACHE_LIMIT) {
    for (const [k, e] of bodyCache) {
      if (bodyCache.size <= CACHE_LIMIT) break;
      if (e.refs > 0) continue;
      for (const g of Object.values(e.geos)) g?.dispose();
      bodyCache.delete(k);
    }
  }
  return b;
}

function releaseBody(key: string): void {
  const b = bodyCache.get(key);
  if (b) b.refs = Math.max(0, b.refs - 1);
}

/**
 * How dark a shadow of stubble a Kynd's face has (0 none, 1 dark), from their beard and hair colour
 * (`lum`, its luminance). A beard grows out of a shadow of stubble, which softens its edge on the
 * cheek; dark-haired clean-shaven men show a five o'clock shadow.
 */
export function stubbleFor(beard: string, lum: number, sex: string, grown: boolean): number {
  if (beard === 'stubble') return lum < 0.3 ? 1 : 0.6;
  if (beard === 'short' || beard === 'full' || beard === 'forked') return lum < 0.3 ? 0.85 : 0.5;
  if ((beard === 'none' || beard === 'moustache') && grown && sex === 'male' && lum < 0.3) return lum < 0.12 ? 0.5 : 0.32;
  return 0;
}

export class KyndAvatar {
  readonly root = new THREE.Group();
  private body!: THREE.Bone;
  private pelvis!: THREE.Bone;
  private spine!: THREE.Bone;
  private neck!: THREE.Bone;
  private head!: THREE.Bone;
  private shL!: THREE.Bone;
  private shR!: THREE.Bone;
  private elL!: THREE.Bone;
  private elR!: THREE.Bone;
  private hipL!: THREE.Bone;
  private hipR!: THREE.Bone;
  private kneeL!: THREE.Bone;
  private kneeR!: THREE.Bone;
  private bones: THREE.Bone[] = [];
  /** How far the eyes look past where the head turns (toward whoever they're attending to). */
  private eyeTurn = 0;
  private lastBeat = -1;
  private doubleBlink = false;
  private rest: THREE.Vector3[] = [];
  private handR = new THREE.Group();
  private handL = new THREE.Group();
  /** The book held open in both hands to read (on the chest, posed per posture); its turning leaf. */
  private openBook = new THREE.Group();
  private leaf = new THREE.Group();
  /** Each posture's grip on the open book: where it sits, and both arms' angles (solved once). */
  private bookGrips = new Map<string, BookGrip>();
  /** Reading this frame: the grip in use and the turning leaf's swing. */
  private reading: { grip: BookGrip; leaf: number } | null = null;
  private shadow: THREE.Mesh;
  private props = new Map<Exclude<CarryItem, null>, THREE.Object3D>();
  /** The fishing rod's tip, and the line with its float that hangs from it while fishing. */
  private rodTip = new THREE.Object3D();
  private fishLine: THREE.Group | null = null;
  private static readonly _v = new THREE.Vector3();
  private pose: Pose = basePose();
  private face: Expression = neutralFace();
  private seed = Math.random() * 100;
  /** Seconds, for the fingers' own small movements. */
  private handClock = 0;
  private nextBlink = 1 + Math.random() * 3;
  private blinkT = -1;
  private meshes: THREE.SkinnedMesh[] = [];
  /** Bathing or changing: skin where the clothes were, behind a modesty blur (as in the Sims). */
  private bare = false;
  private bareMat: THREE.MeshStandardMaterial | null = null;
  private censor: THREE.Mesh | null = null;
  private chestCensor: THREE.Mesh | null = null;
  private female = false;
  private cacheKey = '';
  readonly headAnchor = new THREE.Object3D();
  readonly stage: LifeStage;
  /** Babies are a swaddled bundle, not a rig. */
  private infant: { group: THREE.Group; body: THREE.Object3D; open: THREE.Object3D; closed: THREE.Object3D; hands: THREE.Object3D[] } | null = null;

  /** The mouth's corners at rest (Face detail: turned down … up), in metres up. */
  private cornersUp = 0;

  constructor(look: KyndAppearance, stage: LifeStage = 'adult') {
    this.stage = stage;
    const full = normalizeAppearance(look);
    this.cornersUp = (full.mouthCorners - 0.5) * 0.0042;
    const grown = stage === 'adult' || stage === 'elder';
    const L: FullAppearance = {
      ...full,
      hair: stage === 'elder' ? greyed(full.hair, 0.8) : full.hair,
      beardStyle: grown ? full.beardStyle : 'none',
    };
    if (stage === 'infant') {
      this.shadow = new THREE.Mesh();
      this.buildInfant(L);
      return;
    }
    // Contact shadow: grounds the Kynd even where the sun's shadow falls elsewhere.
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.8 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.shadow.renderOrder = 1;
    this.root.add(this.shadow);

    const built = acquireBody(L, stage);
    this.cacheKey = built.key;

    // Skeleton, in the rest pose.
    const layout = boneLayout(built.m, built.face);
    for (const name of BONES) {
      const b = new THREE.Bone();
      b.name = name;
      const l = layout[name];
      b.position.set(...l.pos);
      this.bones.push(b);
      this.rest.push(b.position.clone());
    }
    for (const name of BONES) {
      const l = layout[name];
      const b = this.bones[BI[name]];
      if (l.parent) this.bones[BI[l.parent]].add(b);
      else this.root.add(b);
    }
    const bone = (n: keyof typeof BI) => this.bones[BI[n]];
    this.body = bone('body');
    this.body.rotation.order = 'YXZ';
    this.pelvis = bone('pelvis');
    this.spine = bone('spine');
    this.neck = bone('neck');
    this.head = bone('head');
    this.shL = bone('shL');
    this.shR = bone('shR');
    this.elL = bone('elL');
    this.elR = bone('elR');
    this.hipL = bone('hipL');
    this.hipR = bone('hipR');
    this.kneeL = bone('kneeL');
    this.kneeR = bone('kneeR');
    this.root.updateMatrixWorld(true);

    const skeleton = new THREE.Skeleton(this.bones);
    const mats = kyndMaterials();
    const skinMat = skinMaterial(built.skin);
    const materials: Record<PartName, THREE.Material> = { skin: skinMat, garment: mats.garment, shoes: mats.garment, feet: skinMat, bare: skinMat, hat: mats.garment, hair: mats.hair, eye: mats.eye, metal: mats.metal };
    const cull = new THREE.Sphere(new THREE.Vector3(0, 0.9, -0.3), 2.1);
    for (const name of PARTS) {
      const geo = built.geos[name];
      if (!geo) continue;
      const mesh = new THREE.SkinnedMesh(geo, materials[name]);
      mesh.name = name;
      // Eyes and buttons are too small to throw a shadow anyone would see: a shadow draw saved
      // per Kynd for each.
      mesh.castShadow = name !== 'eye' && name !== 'metal';
      mesh.receiveShadow = true;
      mesh.boundingSphere = cull.clone();
      mesh.raycast = () => {};
      // Bare feet only show with the shoes off.
      if (name === 'feet' || name === 'bare') mesh.visible = false;
      this.root.add(mesh);
      mesh.bind(skeleton);
      this.meshes.push(mesh);
    }

    this.bareMat = new THREE.MeshStandardMaterial({ color: look.skin, roughness: 0.6, side: THREE.DoubleSide });
    this.censor = censorMesh(look.skin);
    this.censor.position.set(0, 0.02, 0.05);
    this.censor.visible = false;
    this.censor.raycast = () => {};
    this.spine.add(this.censor);
    this.female = look.sex === 'female' && stage !== 'child';
    this.chestCensor = censorMesh(look.skin);
    this.chestCensor.scale.set(0.78, 0.36, 1);
    this.chestCensor.position.set(0, 0.29, 0.09);
    this.chestCensor.visible = false;
    this.chestCensor.raycast = () => {};
    this.spine.add(this.chestCensor);

    // Picking proxies.
    const proxy = (parent: THREE.Object3D, geo: THREE.BufferGeometry, r: number, len: number, y: number) => {
      const p = new THREE.Mesh(geo, pickMaterial);
      // The unit capsule is 3 tall (radius 1, length 1); stretch it to about len + 2r.
      p.scale.set(r, len > 0 ? (len + 2 * r) / 3 : r, r);
      p.position.y = y;
      parent.add(p);
    };
    proxy(this.head, pickSphere, 0.14, 0, 0.13);
    proxy(this.spine, pickCapsule, 0.19, 0.36, 0.26);
    proxy(this.hipL, pickCapsule, 0.09, 0.4, -0.22);
    proxy(this.hipR, pickCapsule, 0.09, 0.4, -0.22);
    proxy(this.kneeL, pickCapsule, 0.07, 0.4, -0.22);
    proxy(this.kneeR, pickCapsule, 0.07, 0.4, -0.22);

    this.head.add(this.headAnchor);
    this.headAnchor.position.y = 0.4;
    // What's held rides on the wrist, so it follows the hand as it bends.
    this.bones[BI.wrR].add(this.handR);
    this.handR.position.set(0, -0.3 - (WRIST_Y - EL_Y), 0.04);
    this.bones[BI.wrL].add(this.handL);
    this.handL.position.copy(this.handR.position);
    this.root.scale.setScalar(L.height * STAGE_SCALE[stage]);
    this.head.scale.setScalar(HEAD_BASE * HEAD_SCALE[stage]);
    this.buildProps();
    // Views drop avatars by removing them from the scene (a Kynd grew up, left or died): let go of
    // the shared body then. Safe even if the avatar is shown again later.
    this.root.addEventListener('removed', () => this.dispose());
  }

  /** Where the face is, in world space (portraits frame on this). */
  faceWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.infant) {
      this.root.updateMatrixWorld(true);
      return this.infant.group.localToWorld(out.set(0, 0.13, 0.17));
    }
    this.root.updateMatrixWorld(true);
    return this.head.localToWorld(out.set(0, 0.12, 0.04));
  }

  /** Let go of this avatar's body geometry (shared with any other avatar of the same look). */
  /** Clothes off (bathing) or coming off and on (changing): skin, and the blur over the middle. */
  private setBare(bare: boolean, changing: boolean, time: number, covered = false): void {
    if (!this.censor || !this.bareMat) return;
    if (bare !== this.bare) {
      this.bare = bare;
      const mats = kyndMaterials();
      for (const m of this.meshes) {
        // Clothes off: the body underneath instead (and the blur over it).
        if (m.name === 'metal' || m.name === 'shoes' || m.name === 'garment') m.visible = !bare;
        if (m.name === 'feet' || m.name === 'bare') m.visible = bare;
      }
    }
    // In the tub the blur sits over the chest; changing, a big churning cloud hides them from
    // shoulders to knees while the old clothes come off and the new go on.
    // As in the Sims: bare, a small churning blur over the groin (and a woman's chest); changing,
    // one big cloud hides them from shoulders to knees while the clothes come off and go on.
    // Under the bedcovers there's nothing to blur (and a blur would show through them).
    this.censor.visible = (bare && !covered) || changing;
    if (bare || changing) {
      this.censor.scale.set(changing ? 1.75 : 0.62, changing ? 2.6 : 0.48, 1);
      this.censor.position.set(0, changing ? -0.32 : -0.17, changing ? 0.05 : 0.07);
      (this.censor.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    }
    if (this.chestCensor) {
      this.chestCensor.visible = bare && !covered && this.female;
      if (this.chestCensor.visible) (this.chestCensor.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    }
  }

  dispose(): void {
    this.bareMat?.dispose();
    if (this.chestCensor) {
      this.chestCensor.geometry.dispose();
      (this.chestCensor.material as THREE.Material).dispose();
    }
    if (this.censor) {
      this.censor.geometry.dispose();
      (this.censor.material as THREE.Material).dispose();
    }
    for (const m of this.meshes) m.skeleton.dispose();
    if (this.cacheKey) releaseBody(this.cacheKey);
    this.cacheKey = '';
    if (this.infant) {
      this.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
      });
    }
  }

  /** The fishing line: from the rod's tip straight down to its float, bobbing on the water. */
  private hangLine(on: boolean, time: number, waterBelow: number): void {
    if (!on) {
      if (this.fishLine) this.fishLine.visible = false;
      return;
    }
    if (!this.fishLine) {
      const g = new THREE.Group();
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 4).translate(0, -0.5, 0), mat('#d8d0bc', { rough: 0.6 }));
      line.name = 'line';
      const float = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mat('#c0442c', { rough: 0.5 }));
      float.name = 'float';
      g.add(line, float);
      g.traverse((o) => (o.userData.keep = true));
      this.root.add(g);
      this.fishLine = g;
    }
    this.root.updateMatrixWorld(true);
    const tip = this.rodTip.getWorldPosition(KyndAvatar._v);
    this.root.worldToLocal(tip);
    // Down to the water: a little below the bank (the quay's and the pond's water lie lower still).
    const bottom = -waterBelow + Math.sin(time * 1.7) * 0.015;
    const len = Math.max(0.05, tip.y - bottom);
    const g = this.fishLine;
    g.visible = true;
    g.position.copy(tip);
    g.getObjectByName('line')!.scale.y = len;
    g.getObjectByName('float')!.position.y = -len;
  }

  private buildProps(): void {
    const bowl = new THREE.Group();
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.08, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(COLORS.lightOak, { detail: 'wood' }));
    b.rotation.x = Math.PI;
    bowl.add(b);
    const stew = new THREE.Mesh(new THREE.CircleGeometry(0.072, 20), mat('#8a5b2a'));
    stew.rotation.x = -Math.PI / 2;
    stew.position.y = -0.005;
    bowl.add(stew);
    // In the upturned right palm (the wrist turns palm-up for it): the palm faces +x of the hand.
    bowl.position.set(0.1, 0.012, -0.04);
    bowl.rotation.z = Math.PI / 2;
    // A turned wooden cup: gripped in the fist, its rim up toward the thumb (the hand's +y while
    // the arm hangs), the ale or nectar dark inside.
    const cup = new THREE.Group();
    const cupBody = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.032, CUP_H, 16, 1, true), mat(COLORS.lightOak, { detail: 'wood' }));
    cupBody.material.side = THREE.DoubleSide;
    cup.add(cupBody);
    const cupFoot = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.036, 0.012, 16), mat(COLORS.lightOak, { detail: 'wood' }));
    cupFoot.position.y = -CUP_H / 2;
    cup.add(cupFoot);
    const drink = new THREE.Mesh(new THREE.CircleGeometry(0.034, 16), mat('#5a3517', { rough: 0.3 }));
    drink.rotation.x = -Math.PI / 2;
    drink.position.y = CUP_H / 2 - 0.018;
    cup.add(drink);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.0375, 0.003, 4, 20), mat('#3a3a3a', { metal: 0.5 }));
    band.rotation.x = Math.PI / 2;
    band.position.y = CUP_H / 2 - 0.01;
    cup.add(band);
    cup.position.copy(CUP_AT);
    const bread = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), mat(COLORS.bread, { rough: 0.8 }));
    bread.scale.set(1.3, 0.8, 1);
    const book = new THREE.Group();
    book.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.22), mat('#6a2a2a', { detail: 'leather' })));
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.028, 0.2), mat('#e8dcc0'));
    pages.position.set(0.004, 0, 0);
    book.add(pages);
    book.position.set(-0.1, 0, 0.05);
    book.rotation.set(-0.9, 0, 0.1);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.11, 0.18, 20), mat(COLORS.ceramic, { detail: 'ceramic' }));
    pot.position.set(-0.12, -0.05, 0.1);
    // Lute: a ribbed pear-shaped bowl, a flat soundboard with a carved rose, the neck and a
    // pegbox bent back.
    const lute = new THREE.Group();
    const outline: [number, number][] = [
      [0.0, -0.17], [0.07, -0.155], [0.115, -0.11], [0.13, -0.05], [0.122, 0.02], [0.095, 0.08], [0.055, 0.125], [0.03, 0.15],
    ];
    const bowlGeo = new THREE.LatheGeometry(outline.map(([r, y]) => new THREE.Vector2(r, y)), 18, Math.PI / 2, Math.PI);
    const body = new THREE.Mesh(bowlGeo, mat('#9a6230', { rough: 0.45, detail: 'wood' }));
    body.scale.set(1, 1, 0.5);
    lute.add(body);
    const shape = new THREE.Shape();
    shape.moveTo(0, outline[0][1]);
    for (const [r, y] of outline) shape.lineTo(r, y);
    for (const [r, y] of [...outline].reverse()) shape.lineTo(-r, y);
    const board = new THREE.Mesh(new THREE.ShapeGeometry(shape, 6), mat('#d8b27a', { rough: 0.55, detail: 'wood' }));
    board.position.z = 0.001;
    lute.add(board);
    const rose = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.03, 20), mat('#3a2414', { rough: 0.8 }));
    rose.position.set(0, 0.02, 0.003);
    lute.add(rose);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.008, 0.008), mat(COLORS.darkOak));
    bridge.position.set(0, -0.09, 0.005);
    lute.add(bridge);
    const neckMesh = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.24, 0.02), mat(COLORS.darkOak, { detail: 'wood' }));
    neckMesh.position.set(0, 0.26, 0.004);
    lute.add(neckMesh);
    const pegbox = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.018), mat(COLORS.darkOak, { detail: 'wood' }));
    pegbox.position.set(0, 0.41, -0.02);
    pegbox.rotation.x = -1.1;
    lute.add(pegbox);
    // Held across the body from the chest (see below), neck up toward the left hand.
    lute.position.set(-0.05, 0.13, 0.19);
    lute.rotation.set(-0.25, 0.1, -0.9);
    // A fishing rod: a long tapered ash pole with a leather grip and a wooden winder; the line and
    // its cork float hang from the tip (placed each frame, straight down to the water).
    const rod = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.016, 2.0, 8), mat('#8a6a42', { rough: 0.7, detail: 'wood' }));
    pole.position.y = 0.8;
    rod.add(pole);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.3, 10), mat('#4a3020', { rough: 0.9, detail: 'leather' }));
    grip.position.y = -0.05;
    rod.add(grip);
    const winder = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.012, 6, 14), mat(COLORS.darkOak, { detail: 'wood' }));
    winder.position.set(0.03, 0.12, 0);
    winder.rotation.y = Math.PI / 2;
    rod.add(winder);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.008, 0.002, 4, 8), mat('#3a3a3a', { metal: 0.6 }));
    ring.position.y = 1.78;
    rod.add(ring);
    this.rodTip.position.y = 1.8;
    rod.add(this.rodTip);
    // Held in the right fist, the pole out over the water.
    rod.position.set(0, -0.03, 0.03);
    rod.rotation.set(2.25, 0, 0);
    // A tournament lance, couched under the right arm and angled across the horse's neck.
    const lance = buildLance();
    lance.position.set(-0.19, 0.3, 0.06);
    lance.rotation.set(-0.04, 0.2, 0);
    this.buildOpenBook(mat);
    for (const [k, o] of [['bowl', bowl], ['bread', bread], ['book', book], ['pot', pot], ['lute', lute], ['rod', rod], ['lance', lance], ['cup', cup]] as const) {
      o.visible = false;
      o.traverse((c) => {
        c.castShadow = true;
        c.userData.keep = true;
      });
      // The lute and the lance ride against the body; everything else is held in the right hand.
      (k === 'lute' || k === 'lance' ? this.spine : this.handR).add(o);
      this.props.set(k, o);
    }
  }

  /**
   * A book lying open: two leather boards in a shallow V either side of the spine, a block of pages
   * on each with faint lines of writing, and a single leaf that turns over. In its own space the
   * spine runs up y from the origin (the bottom of the spine), x is across (+x the right-hand page)
   * and +z comes off the pages toward the reader.
   */
  private buildOpenBook(mat: (c: string, o?: Record<string, unknown>) => THREE.Material): void {
    const g = this.openBook;
    const leather = mat('#6a2a2a', { detail: 'leather' }), paper = mat('#ece0c4'), ink = mat('#5b4a3a');
    for (const s of [-1, 1]) {
      const half = new THREE.Group();
      half.rotation.y = -s * BOOK_V;
      const board = new THREE.Mesh(new THREE.BoxGeometry(BOOK_W, BOOK_H, 0.005), leather);
      board.position.set(s * BOOK_W / 2, BOOK_H / 2, -0.004);
      const block = new THREE.Mesh(new THREE.BoxGeometry(BOOK_W - 0.008, BOOK_H - 0.01, 0.012), paper);
      block.position.set(s * (BOOK_W / 2 - 0.002), BOOK_H / 2, 0.005);
      half.add(board, block);
      // Lines of writing, a hair proud of the page.
      for (let i = 0; i < 9; i++) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(BOOK_W * (i % 4 === 3 ? 0.42 : 0.68), 0.0035, 0.0006), ink);
        line.position.set(s * (BOOK_W / 2) - (i % 4 === 3 ? s * BOOK_W * 0.13 : 0), BOOK_H * (0.84 - i * 0.085), 0.0115);
        half.add(line);
      }
      g.add(half);
    }
    // The leaf being turned: hinged on the spine, swung from the right-hand page to the left.
    const page = new THREE.Mesh(new THREE.BoxGeometry(BOOK_W - 0.012, BOOK_H - 0.012, 0.0012), paper);
    page.position.set((BOOK_W - 0.012) / 2, BOOK_H / 2, 0.012);
    this.leaf.add(page);
    this.leaf.visible = false;
    g.add(this.leaf);
    g.visible = false;
    g.traverse((c) => {
      c.castShadow = true;
      c.userData.keep = true;
    });
    this.spine.add(g);
  }

  /**
   * Where this body holds an open book in this posture, and the arm angles that put each hand on
   * its outer edge (a thumb over the page, the fingers under the board): solved once on the Kynd's
   * own skeleton, like `reachFor`, so a child's short arms and a tall man's long ones each fit it.
   */
  private bookGrip(posture: string, base: Pose): BookGrip {
    const known = this.bookGrips.get(posture);
    if (known) return known;
    const saved = { ...this.pose };
    const p = this.pose;
    Object.assign(p, base);
    const state = { posture, tucked: false, lieHeight: 0 } as AvatarState;
    this.apply(state);
    this.root.updateMatrixWorld(true);
    // The book: a forearm's length out in front, well below the eyes, its pages turned up to the face.
    const eye = this.head.localToWorld(new THREE.Vector3(0, 0.12, 0.06));
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const eyeR = eye.clone().applyMatrix4(inv);
    // (In the body's own units: a child holds it nearer, in proportion to their shorter arms.)
    const at = new THREE.Vector3(0, eyeR.y - 0.37, eyeR.z + 0.28);
    const n = new THREE.Vector3(0, 0.78, -0.62).normalize(), up = new THREE.Vector3(0, 0.62, 0.78).normalize();
    const x = new THREE.Vector3().crossVectors(up, n);
    const qRoot = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, n));
    // Into the chest's own space, so it rides with the breathing and the lean.
    const spineW = new THREE.Matrix4().copy(this.spine.matrixWorld);
    const toSpine = new THREE.Matrix4().copy(spineW).invert().multiply(this.root.matrixWorld);
    const bookM = new THREE.Matrix4().compose(at.clone().sub(new THREE.Vector3(0, BOOK_H / 2, 0).applyQuaternion(qRoot)), qRoot, new THREE.Vector3(1, 1, 1));
    const local = new THREE.Matrix4().multiplyMatrices(toSpine, bookM);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    local.decompose(pos, quat, scl);
    this.openBook.position.copy(pos);
    this.openBook.quaternion.copy(quat);
    this.openBook.scale.setScalar(1 / scl.x);
    this.openBook.updateWorldMatrix(true, true);
    // Each hand to the lower outer edge of its page, a little up from the corner.
    const corner = (s: number) => new THREE.Vector3(s * Math.cos(BOOK_V) * (BOOK_W - 0.012), BOOK_H * 0.32, Math.sin(BOOK_V) * BOOK_W - 0.004);
    const tip = new THREE.Vector3(), goal = new THREE.Vector3();
    const LIMITS: [number, number][] = [[-2.6, 0.2], [-0.8, 0.8], [-0.9, 0.5], [-2.6, -0.1], [-1.7, 1.7], [-0.7, 0.7]];
    const solve = (side: 'L' | 'R', to: THREE.Vector3, start: number[]) => {
      const hand = side === 'L' ? this.handL : this.handR;
      const grip = side === 'L' ? CUP_AT.clone().setX(-CUP_AT.x) : CUP_AT;
      const keys = side === 'L' ? (['shLx', 'shLy', 'shLz', 'elL', 'twistL', 'wristL'] as const) : (['shRx', 'shRy', 'shRz', 'elR', 'twistR', 'wristR'] as const);
      const err = (v: number[]) => {
        keys.forEach((k, i) => (p[k] = v[i]));
        this.apply(state);
        hand.updateWorldMatrix(true, false);
        this.openBook.updateWorldMatrix(true, false);
        // (Elbows kept in to the sides: a little cost on swinging the arm out.)
        return hand.localToWorld(tip.copy(grip)).distanceTo(this.openBook.localToWorld(goal.copy(to))) + Math.abs(v[1]) * 0.004 + Math.abs(v[2]) * 0.004;
      };
      let best = start.slice(), e0 = err(best);
      for (const step of [0.4, 0.2, 0.1, 0.05, 0.025, 0.012, 0.006]) {
        for (let improved = true, guard = 0; improved && guard < 40; guard++) {
          improved = false;
          for (let i = 0; i < 6; i++) for (const d of [-1, 1]) {
            const c = best.slice();
            c[i] = Math.max(LIMITS[i][0], Math.min(LIMITS[i][1], c[i] + d * step));
            const e = err(c);
            if (e < e0 - 1e-6) {
              e0 = e;
              best = c;
              improved = true;
            }
          }
        }
      }
      err(best);
      return { angles: best, miss: e0 };
    };
    const L = solve('L', corner(-1), [-0.8, 0, -0.2, -1.4, 0, 0.1]);
    const R = solve('R', corner(1), [-0.8, 0, -0.2, -1.4, 0, 0.1]);
    // Turning a page: the right hand up to the top of the right-hand leaf, near the spine.
    const T = solve('R', new THREE.Vector3(Math.cos(BOOK_V) * BOOK_W * 0.45, BOOK_H * 0.82, 0.03), R.angles);
    const grip: BookGrip = { pos: pos.clone(), quat: quat.clone(), scale: 1 / scl.x, L: L.angles, R: R.angles, turn: T.angles, miss: Math.max(L.miss, R.miss) };
    Object.assign(this.pose, saved);
    this.apply(state);
    this.bookGrips.set(posture, grip);
    return grip;
  }

  private buildInfant(look: FullAppearance): void {
    const g = new THREE.Group();
    const C = palette(look);
    const skinC = C.skin;
    const wrapC = mixCol(C.tunic, col('#f2e6cc'), 0.55);
    const bonnetC = mixCol(C.trim, col('#fbf4e4'), 0.55);
    const B = { garment: new Bucket(), skin: new Bucket() };
    const none = () => [0, 1];
    // Swaddled body lying along +Z (head end): a soft bundle with folds.
    grid(B.garment, {
      us: around(28),
      vs: range(0, 1, 16),
      wrapU: true,
      at: (th, t, out) => {
        const r = 0.1 * capsuleR(t, 0.28, 0.2) * (1 + 0.04 * Math.sin(th * 7 + t * 9)) * (1 - t * 0.12);
        return out.set(Math.sin(th) * r * 1.05, 0.1 + Math.cos(th) * r * 0.85, -0.2 + t * 0.34);
      },
      paint: (th, t) => ({ c: shade(wrapC, 0.92 + 0.08 * Math.sin(th * 7 + t * 9)), kind: KIND.linen }),
      weights: none,
    });
    // A blanket band across the bundle.
    grid(B.garment, {
      us: around(28),
      vs: range(0, 1, 4),
      wrapU: true,
      at: (th, t, out) => {
        const r = 0.107 * (1 + 0.03 * Math.sin(th * 5));
        return out.set(Math.sin(th) * r * 1.05, 0.1 + Math.cos(th) * r * 0.86, -0.07 + t * 0.1 + Math.sin(th) * 0.02);
      },
      paint: () => ({ c: C.tunic, kind: KIND.wool }),
      weights: none,
    });
    // The head, lying back: the face looks up, the crown points along +Z.
    const hc = new THREE.Vector3(0, 0.13, 0.17);
    const F = new THREE.Vector3(0, 0.87, 0.5).normalize();
    const U = new THREE.Vector3(0, -0.5, 0.87).normalize();
    const X = new THREE.Vector3(1, 0, 0);
    const at = (f: number, u: number, x: number) => hc.clone().addScaledVector(F, f).addScaledVector(U, u).addScaledVector(X, x);
    ellipsoid(B.skin, hc, [0.074, 0.074, 0.074], (_p, n) => {
      const front = n.dot(F);
      const cheek = Math.max(0, front) * Math.exp(-(((Math.abs(n.x) - 0.55) / 0.22) ** 2) - ((n.dot(U) + 0.25) / 0.3) ** 2);
      return { c: mixCol(skinC, col('#e8806e'), cheek * 0.45) };
    }, none, 22, 16);
    ellipsoid(B.skin, at(0.073, -0.012, 0), [0.011, 0.009, 0.009], () => ({ c: mixCol(skinC, col('#e8806e'), 0.15) }), none, 10, 8);
    // Bonnet over the back of the head, with a frill round the face.
    const Rb = 0.082;
    grid(B.garment, {
      us: around(28),
      vs: range(0, 1.95, 10),
      wrapU: true,
      at: (th, a, out) => {
        const ring = X.clone().multiplyScalar(Math.cos(th)).addScaledVector(U, Math.sin(th));
        return out.copy(hc).addScaledVector(F, -Math.cos(a) * Rb).addScaledVector(ring, Math.sin(a) * Rb);
      },
      paint: () => ({ c: bonnetC, kind: KIND.linen }),
      weights: none,
    });
    grid(B.garment, {
      us: around(28),
      vs: range(0, Math.PI * 2, 6),
      wrapU: true,
      at: (th, a, out) => {
        const ring = X.clone().multiplyScalar(Math.cos(th)).addScaledVector(U, Math.sin(th));
        const r = Rb * Math.sin(1.95) + 0.01 + Math.cos(a) * 0.008 + Math.sin(th * 10) * 0.002;
        return out.copy(hc).addScaledVector(F, -Math.cos(1.95) * Rb + Math.sin(a) * 0.008).addScaledVector(ring, r);
      },
      paint: () => ({ c: shade(bonnetC, 1.05), kind: KIND.linen }),
      weights: none,
    });
    const open = new THREE.Group();
    const closed = new THREE.Group();
    const eyeB = new Bucket();
    const lidB = new Bucket();
    for (const s of [-1, 1]) {
      ellipsoid(eyeB, at(0.066, 0.014, s * 0.027), [0.0105, 0.0105, 0.0105], () => ({ c: col('#1c120c') }), none, 12, 8);
      ellipsoid(eyeB, at(0.075, 0.019, s * 0.027 - 0.004), [0.0028, 0.0028, 0.0028], () => ({ c: new THREE.Color(2, 2, 2) }), none, 6, 4);
      const pts = [at(0.068, 0.016, s * 0.04), at(0.074, 0.01, s * 0.027), at(0.068, 0.016, s * 0.014)];
      tube(lidB, new Path(pts, 10), { radius: () => [0.0024, 0.0024], paint: () => ({ c: col('#4a2a20') }), weights: none, seg: 6, steps: 8 });
    }
    const plain = (b: Bucket, m: THREE.Material, parent: THREE.Object3D, extras = false) => {
      const geo = b.toGeometry(extras);
      geo.deleteAttribute('skinIndex');
      geo.deleteAttribute('skinWeight');
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const mats = kyndMaterials();
    const skinM = skinMaterial({ age: 0, stubble: 0, freckles: false, scar: false });
    const bodyMesh = plain(B.garment, mats.garment, g, true);
    plain(B.skin, skinM, g);
    plain(eyeB, mats.eye, open);
    plain(lidB, mats.hair, closed);
    g.add(open, closed);
    const hands = [-1, 1].map((sx) => {
      const hb = new Bucket();
      ellipsoid(hb, new THREE.Vector3(sx * 0.05, 0.2, 0.07), [0.022, 0.02, 0.022], () => ({ c: skinC }), none, 12, 8);
      return plain(hb, skinM, g);
    });
    g.scale.setScalar(0.82);
    g.add(this.headAnchor);
    this.headAnchor.position.set(0, 0.3, 0.16);
    this.root.add(g);
    this.infant = { group: g, body: bodyMesh, open, closed, hands };
  }

  private animateInfant(state: AvatarState, time: number): void {
    const inf = this.infant!;
    const asleep = state.activity === 'sleep';
    inf.group.position.y = state.lieHeight;
    // Breathing, and a wriggle when awake.
    inf.body.scale.y = 1 + Math.sin(time * (asleep ? 1.6 : 2.6)) * 0.03;
    inf.group.rotation.z = asleep ? 0 : Math.sin(time * 1.3) * 0.06;
    const blink = !asleep && (time + this.seed) % 4.2 < 0.15;
    inf.open.visible = !asleep && !blink;
    inf.closed.visible = asleep || blink;
    inf.hands.forEach((h, i) => {
      h.visible = !asleep;
      h.position.y = asleep ? 0 : Math.max(0, Math.sin(time * 3 + i * 2)) * 0.04;
    });
    this.root.visible = state.posture !== 'hidden';
  }

  /** Wear or carry something that moves with the head or the trunk (a great helm, a shield). */
  attach(part: 'head' | 'spine', obj: THREE.Object3D): void {
    (part === 'head' ? this.head : this.spine).add(obj);
  }

  /** Swap in a lance in other colours (a visiting knight's), held the same way. */
  setLance(lance: THREE.Group): void {
    const old = this.props.get('lance');
    if (!old) return;
    lance.position.copy(old.position);
    lance.rotation.copy(old.rotation);
    lance.visible = false;
    lance.traverse((c) => {
      c.castShadow = true;
      c.userData.keep = true;
    });
    old.parent?.add(lance);
    old.removeFromParent();
    this.props.set('lance', lance);
  }

  /** Advance the pose toward the target defined by the Kynd's current state. */
  /** The posture last drawn, and how long a change of posture still eases slowly (seconds). */
  private lastPosture: AvatarState['posture'] | undefined;
  private postureEase = 0;
  /** The cloak's swing, as a spring (radians a second). */
  private cloakVel = 0;
  private cloakNeed = 0;

  animate(state: AvatarState, time: number, dt: number): void {
    this.handClock = time;
    if (this.infant) return this.animateInfant(state, time);
    const target = basePose();
    const walking = state.moving && state.posture === 'stand' && !state.riding;
    if (state.mounting !== undefined && state.mounting < 1) {
      mountLayer(target, Math.max(0, state.mounting));
    } else if (state.riding) {
      rideLayer(target, state.moving, time);
    } else if (walking) {
      walkLayer(target, state.distanceWalked * (state.running ? 3.1 : 4.4), state.running, state.carrying, state.limp);
    } else {
      postureLayer(target, state.posture);
      // Each Kynd on their own clock: two at a table don't lift their spoons together (a dance keeps the music's).
      activityLayer(target, state.activity, state.activity === 'dance' ? time : time + this.seed, state.posture);
      if (state.posture !== 'lie' && state.activity !== 'sleep') lifeLayer(target, time + this.seed, state.posture === 'stand');
      if (state.activity === 'idle' && state.posture === 'stand') {
        traitLayer(target, state.traits ?? [], time + this.seed);
        if (state.emotion) emotionLayer(target, state.emotion, state.emotionIntensity ?? 0, time);
      }
      // Now and then, a habit: a rub of the neck, a stretch, a look over the shoulder (hands free).
      if (state.activity === 'idle' && !state.carrying && (state.posture === 'stand' || state.posture === 'sit')) habitLayer(target, time + this.seed * 7, state.posture === 'sit');
      // Holding something, standing about: the upper arm hangs, the forearm forward, the thing at
      // the waist (not held out as if offering it to someone).
      if (state.carrying && state.activity === 'idle') Object.assign(target, { shRx: -0.14, elR: -1.22, shRz: 0.14, twistR: state.carrying === 'pot' || state.carrying === 'bowl' ? -0.6 : 0 });
      if (state.posture === 'stand') plantFeet(target);
    }
    // Attending to someone: the head turns toward them as far as is comfortable (the eyes do the rest),
    // and a listener nods now and then.
    if (state.lookTurn !== undefined && !walking && state.posture !== 'lie') {
      const turn = Math.max(-1.1, Math.min(1.1, state.lookTurn));
      target.neckTurn += turn * 0.8;
      this.eyeTurn = (state.lookTurn - turn * 0.8) * 0.9;
      if (state.activity === 'idle' || state.activity === 'watch') {
        const nod = Math.sin(time * 1.9 + this.seed);
        target.neck += Math.max(0, nod - 0.75) * 0.5;
      }
    } else this.eyeTurn = 0;
    if (state.riding || (state.mounting !== undefined && state.mounting < 1)) Object.assign(target, { gripL: 0.85, gripR: 0.85 });
    else {
      handLayer(target, walking ? 'idle' : state.activity, state.carrying, time, this.seed);
      // Hand to mouth: at the top of each bite or sip the arm takes this body's own reach, so the
      // bowl, the bread or the cup's rim meets the lips (not a hand's breadth off, on a child or a
      // tall man alike).
      const m = state.carrying ? TO_MOUTH[state.carrying] : undefined;
      if (m && !walking && (state.activity === 'eat' || state.activity === 'drink')) {
        const lift = state.activity === 'eat' ? eatCycle(time + this.seed).lift : drinkCycle(time + this.seed).lift;
        if (lift > 0) {
          // Up through a point in front of the chest (so the hand never sweeps across the face),
          // then to the lips.
          const way = this.reachFor(state.carrying!, true), top = this.reachFor(state.carrying!);
          const a = Math.min(1, lift * 2), b = Math.max(0, lift * 2 - 1);
          for (const j of ['shRx', 'shRy', 'shRz', 'elR', 'twistR', 'wristR'] as const) {
            const mid = target[j] + (way[j] - target[j]) * a;
            target[j] = mid + (top[j] - mid) * b;
          }
        }
      }
      // Reading: the book held open in both hands, a page turned every so often.
      if (!walking && state.activity === 'read' && state.carrying === 'book' && state.posture !== 'lie') {
        const g = this.bookGrip(state.posture, target);
        const turn = pageTurn(time + this.seed * 3);
        const KL = ['shLx', 'shLy', 'shLz', 'elL', 'twistL', 'wristL'] as const, KR = ['shRx', 'shRy', 'shRz', 'elR', 'twistR', 'wristR'] as const;
        KL.forEach((j, i) => (target[j] = g.L[i]));
        KR.forEach((j, i) => (target[j] = g.R[i] + (g.turn[i] - g.R[i]) * turn.reach));
        target.gripL = 0.62;
        target.gripR = 0.62 - 0.3 * turn.reach;
        this.reading = { grip: g, leaf: turn.leaf };
      } else this.reading = null;
      // Walking, the hands hang loosely half-curled, the wrists trailing a touch behind the swing.
      if (walking) {
        target.gripL = 0.38;
        if (!state.carrying) target.gripR = 0.38;
        target.wristL = target.wristR = 0.14;
      }
    }
    if (this.stage === 'elder') {
      // A little stoop with the years.
      target.spine += 0.1;
      target.neck += 0.06;
    }
    // Walking needs snappy legs; everything else eases more slowly; sitting down, standing up and
    // lying back slowest of all, so the weight shows (a body lowers itself, it doesn't snap).
    if (state.posture !== this.lastPosture) {
      this.postureEase = this.lastPosture === undefined ? 0 : 0.8;
      this.lastPosture = state.posture;
    }
    this.postureEase = Math.max(0, this.postureEase - dt);
    const k = 1 - Math.exp(-dt * (walking ? 22 : this.postureEase > 0 ? 5 : 9));
    for (const j of JOINTS) this.pose[j] += (target[j] - this.pose[j]) * k;
    this.apply(state);
    this.animateFace(state, time, dt);
    // Bathing, and under the covers together: their clothes are off (the covers hide the rest).
    this.setBare(state.activity === 'bathe' || state.activity === 'woohoo', state.activity === 'dress', time, !!state.tucked);
    for (const [key, obj] of this.props) obj.visible = state.carrying === key && !(key === 'book' && this.reading);
    // The open book, in this posture's place on the chest; the leaf swung over as the page turns.
    const r = this.reading;
    this.openBook.visible = !!r;
    if (r) {
      this.openBook.position.copy(r.grip.pos);
      this.openBook.quaternion.copy(r.grip.quat);
      this.openBook.scale.setScalar(r.grip.scale);
      this.leaf.visible = r.leaf > 0 && r.leaf < 1;
      this.leaf.rotation.y = -BOOK_V - (Math.PI - 2 * BOOK_V) * r.leaf;
    }
    this.hangLine(state.carrying === 'rod', time, state.waterBelow ?? 0.3);
    this.root.visible = state.posture !== 'hidden';
    this.shadow.visible = state.posture !== 'lie' && !state.riding;
    const p = state.pregnancy ?? 0;
    const bump = p > 0.3 ? Math.min(1, (p - 0.3) / 0.7) : 0;
    const belly = this.bones[BI.belly];
    belly.scale.set(1 + bump * 0.45, 1 + bump * 0.3, 1 + bump * 1.25);
    belly.position.z = this.rest[BI.belly].z + bump * 0.02;
    // A cloak swings back as the Kynd walks and hangs straight when they lean; it always clears
    // whatever swings back under it (a trailing leg, the shin of a bent knee, a tunic's back
    // skirts), and it moves on a soft spring, so it billows out and settles rather than turning
    // like a board. Seated, it's draped back over the chair.
    const cloak = this.bones[BI.cloak];
    const swing = walking ? (state.running ? 0.32 : 0.12) + Math.sin(state.distanceWalked * 8.8) * 0.03 : Math.sin(time * 1.1 + this.seed) * 0.012;
    // Seated against a chair's back, it's thrown back over it; on a bench or stool it falls behind.
    const seated = state.posture === 'sit' && !state.riding;
    const overBack = seated && !!state.seatBack;
    // What it must clear is held through the stride and let go slowly: a cloak can't follow every
    // step, and chasing them it lagged into the trailing leg.
    this.cloakNeed = Math.max(cloakClearance(this.pose), this.cloakNeed - dt * 0.5);
    const want = -(Math.max(swing, this.cloakNeed, overBack ? 0.4 : seated ? 0.12 : 0) + this.pose.spine * 0.8);
    if (dt > 0) {
      const h = Math.min(dt, 0.05);
      this.cloakVel += ((want - cloak.rotation.x) * 70 - this.cloakVel * 11) * h;
      cloak.rotation.x += this.cloakVel * h;
    }
    cloak.position.z += (this.rest[BI.cloak].z + (overBack ? -0.08 : 0) - cloak.position.z) * Math.min(1, dt * 6);
    cloak.scale.y = this.squash();
    // Damped secondary hair motion on torso-anchored strands. The rest meshes
    // clear the shoulder envelope; bounded springs preserve that clearance.
    for (const [i, name] of (['hairBack', 'hairL', 'hairR'] as const).entries()) {
      const bone = this.bones[BI[name]];
      const velocity = (bone.userData.hairVelocity ??= new THREE.Vector2()) as THREE.Vector2;
      const targetX = walking ? Math.sin(state.distanceWalked * 7 + i) * 0.025 - (state.running ? 0.045 : 0.01) : 0;
      const targetZ = walking ? Math.sin(state.distanceWalked * 5 + i * 1.4) * 0.025 : Math.sin(time * 0.8 + i) * 0.004;
      let remaining = Math.min(dt, 0.1);
      while (remaining > 0) {
        const h = Math.min(remaining, 1 / 60);
        velocity.x += ((targetX - bone.rotation.x) * 48 - velocity.x * 13) * h;
        velocity.y += ((targetZ - bone.rotation.z) * 48 - velocity.y * 13) * h;
        bone.rotation.x = THREE.MathUtils.clamp(bone.rotation.x + velocity.x * h, -0.065, 0.04);
        bone.rotation.z = THREE.MathUtils.clamp(bone.rotation.z + velocity.y * h, -0.04, 0.04);
        remaining -= h;
      }
    }
  }

  /** How much hanging cloth behind has to shorten so it doesn't sink into the floor when seated. */
  private squash(): number {
    const drop = STAND_HIP - this.pose.pelvisY;
    return Math.max(0.4, Math.min(1, 1 - drop * 1.12));
  }

  private animateFace(state: AvatarState, time: number, dt: number): void {
    const target = expressionFor(state, time, this.seed);
    // Idle glances.
    const beat = Math.floor((time + this.seed) / 2.3);
    const r1 = Math.sin(beat * 12.9898 + this.seed) * 43758.5453;
    const r2 = Math.sin(beat * 78.233 + this.seed) * 12345.678;
    const wander = state.engaged || state.activity !== 'idle' ? 0.18 : 1;
    target.lookX += ((r1 - Math.floor(r1)) - 0.5) * 0.35 * wander + Math.max(-0.5, Math.min(0.5, this.eyeTurn));
    target.lookY += ((r2 - Math.floor(r2)) - 0.5) * 0.12 * wander;
    // A glance often comes with a blink, and now and then a quick double blink.
    if (beat !== this.lastBeat) {
      this.lastBeat = beat;
      const r3 = Math.sin(beat * 39.3 + this.seed * 7) * 9631.17;
      const roll = r3 - Math.floor(r3);
      if (roll < 0.35 && this.blinkT < 0) this.nextBlink = 0.04;
      if (roll < 0.08) this.doubleBlink = true;
    }
    const kf = 1 - Math.exp(-dt * 10);
    const f = this.face;
    for (const key of Object.keys(f) as (keyof Expression)[]) f[key] += (target[key] - f[key]) * kf;
    // Blinking.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blinkT = 0;
      this.nextBlink = 2.2 + Math.random() * 4;
    }
    // A real smile reaches the eyes: the cheeks lift and the lids narrow a little.
    let lid = f.lid * (1 - Math.max(0, f.smile - 0.25) * 0.14);
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const b = this.blinkT / 0.16;
      if (b >= 1) {
        this.blinkT = -1;
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.nextBlink = 0.09;
        }
      }
      else lid = Math.min(lid, Math.abs(b - 0.5) * 2);
    }
    const bone = (n: keyof typeof BI) => this.bones[BI[n]];
    const rest = (n: keyof typeof BI) => this.rest[BI[n]];
    const lidTurn = Math.max(-0.14, Math.min(1.02, (1 - lid) * 0.98));
    bone('lids').rotation.x = lidTurn * LID_LEVELS[3];
    bone('lidsM').rotation.x = lidTurn * LID_LEVELS[2];
    bone('lidsE').rotation.x = lidTurn * LID_LEVELS[1];
    bone('jaw').rotation.x = f.jaw * 0.17;
    const sm = f.smile;
    // Smiling, the corners go up, out and back into the cheeks; a frown pulls them down and in.
    const out = Math.max(0, sm) * 0.0042 - Math.max(0, -sm) * 0.0012 - f.pucker * 0.006;
    const up = sm > 0 ? sm * 0.0078 : sm * 0.0085;
    for (const [n, s] of [['mouthL', 1], ['mouthR', -1]] as const) {
      const r = rest(n);
      bone(n).position.set(r.x + s * out, r.y + this.cornersUp + up - f.jaw * 0.002, r.z - Math.abs(sm) * 0.003 + f.pucker * 0.004);
    }
    for (const [n, s] of [['browL', 1], ['browR', -1]] as const) {
      const r = rest(n);
      const asym = s === 1 ? f.asym : -f.asym * 0.3;
      // Raised in surprise or fear; knit down and in, in anger or concentration.
      bone(n).position.set(r.x, r.y + f.brow * 0.006 + f.inner * 0.0018 + asym * 0.005, r.z);
      bone(n).rotation.z = -s * f.inner * 0.3;
    }
    for (const n of ['eyeL', 'eyeR'] as const) {
      bone(n).rotation.set(f.lookY * 0.5, f.lookX * 0.6 + this.pose.neckTurn * -0.15, 0);
    }
  }

  /** This body's arm angles that bring each held thing to the lips (solved once, cached). */
  private reach = new Map<string, Reach>();

  /** On the way up: held out in front, below the chin, upright (where the arm passes through). */
  private static readonly WAY = new THREE.Vector3(0, -0.13, 0.17);

  /**
   * Solve, on this Kynd's own skeleton, the right arm's angles that put the held thing's lip point
   * (TO_MOUTH) at the mouth, with the head and back as they are at the top of a bite or a sip. A
   * few dozen forward passes down the arm, once per thing held: a child's short arm and a tall
   * man's long one each get their own.
   */
  reachFor(item: NonNullable<CarryItem>, onTheWay = false): Reach {
    const key = onTheWay ? `${item}:way` : item;
    const known = this.reach.get(key);
    if (known) return known;
    const to = TO_MOUTH[item]!;
    const m = onTheWay ? { ...to, offset: to.offset.clone().add(KyndAvatar.WAY), axis: to.axis ? new THREE.Vector3(0, 1, -0.25).normalize() : undefined } : to;
    const prop = this.props.get(item)!;
    const saved = { ...this.pose };
    const p = this.pose;
    Object.assign(p, basePose(), { spine: m.spine, neck: m.neck });
    handLayer(p, 'eat', item, 0, 0);
    const mouth = this.rest[BI.mouthL].clone().add(this.rest[BI.mouthR]).multiplyScalar(0.5).add(m.offset);
    const state = { posture: 'sit', tucked: false, lieHeight: 0 } as AvatarState;
    const tip = new THREE.Vector3(), goal = new THREE.Vector3(), up = new THREE.Vector3(), want = new THREE.Vector3(), q = new THREE.Quaternion();
    const LIMITS: [number, number][] = [[-2.6, 0.2], [-0.8, 0.8], [-0.9, 0.5], [-2.6, -0.1], [-1.7, 1.7], [-0.7, 0.7]];
    // Where it must be, and (a cup) which way it must face: a miss of a centimetre weighs as much as
    // ten degrees of wrong tilt.
    const angle = (v: number[]) => {
      if (!m.axis) return 0;
      up.set(0, 1, 0).applyQuaternion(prop.getWorldQuaternion(q));
      want.copy(m.axis).applyQuaternion(this.head.getWorldQuaternion(q));
      return (1 - up.dot(want)) * 0.06 + (v.length ? 0 : 0);
    };
    const miss = () => prop.localToWorld(tip.copy(m.at)).distanceTo(this.head.localToWorld(goal.copy(mouth)));
    const err = (v: number[]) => {
      [p.shRx, p.shRy, p.shRz, p.elR, p.twistR, p.wristR] = v;
      this.apply(state);
      prop.updateWorldMatrix(true, false);
      this.head.updateWorldMatrix(true, false);
      return miss() + angle(v);
    };
    let best = [-1.25, 0, -0.15, -2.0, p.twistR, p.wristR];
    let e0 = err(best);
    for (const step of [0.4, 0.2, 0.1, 0.05, 0.025, 0.012, 0.006]) {
      for (let improved = true, guard = 0; improved && guard < 40; guard++) {
        improved = false;
        for (let i = 0; i < (m.axis ? 6 : 4); i++) {
          for (const d of [-1, 1]) {
            const c = best.slice();
            c[i] = Math.max(LIMITS[i][0], Math.min(LIMITS[i][1], c[i] + d * step));
            const e = err(c);
            if (e < e0 - 1e-6) {
              e0 = e;
              best = c;
              improved = true;
            }
          }
        }
      }
    }
    err(best);
    const off = miss();
    Object.assign(this.pose, saved);
    this.apply(state);
    const r = { shRx: best[0], shRy: best[1], shRz: best[2], elR: best[3], twistR: best[4], wristR: best[5], miss: off };
    this.reach.set(key, r);
    return r;
  }

  /**
   * How far above the root the Kynd's seat is in the current pose (the underside of the hips), in
   * scene units: a rider's root goes this far below the saddle.
   */
  seatDrop(): number {
    this.root.updateMatrixWorld(true);
    const hip = this.pelvis.getWorldPosition(new THREE.Vector3()).y - this.root.getWorldPosition(new THREE.Vector3()).y;
    return hip * SEAT_UNDER_HIP;
  }

  private apply(state: AvatarState): void {
    const p = this.pose;
    this.pelvis.position.y = p.pelvisY;
    this.spine.rotation.set(p.spine, p.spineTwist, 0);
    this.neck.rotation.set(p.neck * 0.6, p.neckTurn * 0.5, 0);
    this.head.rotation.set(p.neck * 0.4, p.neckTurn * 0.5, 0);
    this.shL.rotation.set(p.shLx, p.shLy, p.shLz);
    this.shR.rotation.set(p.shRx, p.shRy, -p.shRz);
    // Turning the hand over happens mostly along the forearm (round, so it doesn't show), the rest
    // at the wrist: spread like that, the wrist never wrings like a sweet wrapper.
    this.elL.rotation.set(p.elL, -p.twistL * 0.7, 0);
    this.elR.rotation.set(p.elR, p.twistR * 0.7, 0);
    this.hipL.rotation.set(p.hipL, 0, p.hipLz);
    this.hipR.rotation.set(p.hipR, 0, -p.hipRz);
    this.kneeL.rotation.x = p.kneeL;
    // Half-joints: half the bend (and half the forearm's turn), carrying the skin round each hinge.
    const b0 = this.bones;
    b0[BI.elMidL].rotation.set(p.elL * 0.5, -p.twistL * 0.35, 0);
    b0[BI.elMidR].rotation.set(p.elR * 0.5, p.twistR * 0.35, 0);
    b0[BI.kneeMidL].rotation.x = p.kneeL * 0.5;
    b0[BI.kneeMidR].rotation.x = p.kneeR * 0.5;
    this.kneeR.rotation.x = p.kneeR;
    // Ankles: the foot kept level with the ground (whatever the hip and knee do), plus the pose's
    // own extra; kneeling, the feet lie back along the floor; lying, they fall relaxed.
    for (const [an, hip, knee, extra] of [[BI.anL, p.hipL, p.kneeL, p.ankleL], [BI.anR, p.hipR, p.kneeR, p.ankleR]] as const) {
      const level = -(hip + knee);
      const kneelK = state.posture === 'kneel' ? 1 : 0;
      const lieK = p.lie;
      const a = (level + extra) * (1 - kneelK) + 1.35 * kneelK;
      this.bones[an].rotation.x = a * (1 - lieK) + 0.5 * lieK;
    }
    // Hands: each finger curls about its knuckle toward the palm (palms face the thighs in the rest
    // pose) and again at its middle joint, the little finger most and the index least, as a real
    // hand closes; opening, they fan apart. Each finger keeps its own slow stir, so no two hands,
    // and no two moments, look alike. The thumb folds across under the fingers.
    const t = this.handClock;
    for (const [s, g, wr, tw] of [[1, p.gripL, p.wristL, -p.twistL], [-1, p.gripR, p.wristR, p.twistR]] as const) {
      const L = s === 1 ? 'L' : 'R';
      const bn = (n: string) => this.bones[BI[`${n}${L}` as keyof typeof BI]];
      bn('wr').rotation.set(0, tw * 0.3, -s * wr);
      const open = Math.max(0, -g);
      for (let i = 0; i < 4; i++) {
        const k = 'imrp'[i];
        const stir = 0.035 * Math.sin(t * (0.5 + i * 0.13) + this.seed * (i + 1.7) + s);
        const gi = g * CASCADE[i] + stir + (g > 0 ? 0.04 * i : 0);
        const base = bn(`f${k}`), mid = bn(`f${k}2`);
        // Fanning: the index leans toward the thumb, the little finger away.
        base.rotation.set(-(1.5 - i) * open * 0.16, 0, -s * gi * 0.95);
        mid.rotation.z = -s * Math.max(-0.12, gi) * 1.2;
      }
      bn('th').rotation.set(Math.max(0, g) * 0.5 - open * 0.25, 0, -s * g * 0.3);
      bn('th2').rotation.z = -s * Math.max(0, g) * 0.55;
    }
    // Skirts drape with the legs: the front follows the thighs and falls from the knees, the back
    // follows a leg swinging back but not one lifting forward, and shortens when seated.
    const b = this.bones;
    const sq = this.squash();
    b[BI.skFL].rotation.set(p.hipL, 0, p.hipLz);
    b[BI.skFR].rotation.set(p.hipR, 0, -p.hipRz);
    b[BI.skKL].rotation.x = p.kneeL;
    b[BI.skKR].rotation.x = p.kneeR;
    b[BI.skBL].rotation.x = p.hipL > 0 ? p.hipL : p.hipL * 0.25;
    b[BI.skBR].rotation.x = p.hipR > 0 ? p.hipR : p.hipR * 0.25;
    b[BI.skBL].scale.y = sq;
    b[BI.skBR].scale.y = sq;
    // Loose cloth in front of the hips would swing up into a shelf over a seated lap; let it
    // settle onto the thighs instead.
    const flexL = Math.max(0, Math.min(1, (-p.hipL - 0.5) / 1.0));
    const flexR = Math.max(0, Math.min(1, (-p.hipR - 0.5) / 1.0));
    // Lying down, a full skirt would stand up round the legs like a stiff bell; it falls flat instead.
    const L = p.lie;
    const flat = 1 - 0.45 * L, narrow = 1 - 0.3 * L;
    b[BI.skFL].scale.z = (1 - 0.55 * flexL) * flat;
    b[BI.skFR].scale.z = (1 - 0.55 * flexR) * flat;
    b[BI.skBL].scale.z = flat;
    b[BI.skBR].scale.z = flat;
    // Seated, the cloth gathers in round the thighs and hangs down off the seat's edge, instead of
    // fanning out sideways with them like a stiff plate.
    const seated = Math.max(flexL, flexR) * (1 - L);
    for (const i of [BI.skFL, BI.skFR, BI.skBL, BI.skBR]) b[i].scale.x = narrow * (1 - 0.32 * seated);
    b[BI.skKL].rotation.x = p.kneeL * (1 - 0.15 * seated);
    b[BI.skKR].rotation.x = p.kneeR * (1 - 0.15 * seated);
    b[BI.skFL].scale.y = 1;
    b[BI.skFR].scale.y = 1;
    // Tucked in under a quilt, the legs and skirts fold away out of sight: whatever their dress or
    // height, nothing pokes up through the covers or out through the footboard.
    const gone = state.tucked ? 0.001 : 1;
    this.hipL.scale.setScalar(gone);
    this.hipR.scale.setScalar(gone);
    if (state.tucked) for (const i of [BI.skFL, BI.skFR, BI.skBL, BI.skBR]) b[i].scale.setScalar(gone);
    // Lying: the whole body lies back onto its back, feet toward the facing direction (from sitting
    // on a bed's edge that's just lying back, with no turn).
    this.body.rotation.set(-Math.PI / 2 * L, 0, 0);
    // The bed's height is in metres, but the body hangs under the root's size scale: undo it, or a
    // child (drawn at about 0.6) sinks through the mattress and a tall adult floats over it.
    this.body.position.set(0, (state.lieHeight / this.root.scale.y + 0.1) * L, 0.88 * L);
  }
}

/**
 * The modesty blur: a soft-edged cloud of big skin-toned pixels that always faces the camera,
 * nudged toward it so the body never cuts through it, churning gently like the Sims' censor.
 */
function censorMesh(skin: string): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSkin: { value: new THREE.Color(skin) }, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 size = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        centre.xy += position.xy * size;
        centre.z += 0.32;
        gl_Position = projectionMatrix * centre;
      }`,
    fragmentShader: `
      uniform vec3 uSkin;
      uniform float uTime;
      varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 cell = floor(vUv * vec2(7.0, 9.0));
        float t = floor(uTime * 6.0);
        float n = h(cell + t * 0.37);
        vec2 d = (vUv - 0.5) * vec2(1.0, 1.15);
        float edge = 1.0 - smoothstep(0.36, 0.5, length(d) + (h(cell + 3.0) - 0.5) * 0.08);
        vec3 c = uSkin * (0.78 + 0.34 * n);
        c = mix(c, vec3(0.92, 0.9, 0.86), 0.12 * h(cell * 1.7 + t));
        gl_FragColor = vec4(c, edge * 0.97);
      }`,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.5), mat);
}

import * as THREE from 'three';
import type { AnimalGenome } from '../sim/animals/Animal.ts';
import { mixColor } from '../sim/family/genetics.ts';
import { TAG, TAG_COUNT, type PetRig } from './petAnatomy.ts';

/*
 * Coats. Each vertex carries smooth marking fields computed from where it sits on the animal
 * (a tuxedo bib, socks, a blaze, a hound's saddle, a colourpoint's dark extremities, calico or
 * piebald patches, tabby stripe coordinates). The fur shader thresholds those fields per pixel with
 * fine noise, so markings have soft, ragged, hair-like edges instead of geometry or texture seams,
 * and adds fur grain, a little bump and a soft sheen. One shader program serves every pet.
 */

export interface CoatPlan {
  base: string;
  second: string;
  third: string;
  white: string;
  stripe: string;
  /** Softness of the second-colour edge (0.05 crisp patches … 0.6 colourpoint gradient). */
  secondSoft: number;
  stripeFreq: number;
  ticking: number;
  fluff: number;
}

const lum = (hex: string) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11; };
const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Deterministic value noise in JS, for broad patch layouts. */
function vnoise(x: number, y: number, z: number, seed: number): number {
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647) ^ Math.imul(seed | 0, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (t: number) => t * t * (3 - 2 * t);
  const xf = f(x - xi), yf = f(y - yi), zf = f(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), xf), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf),
    zf,
  );
}

export function coatPlan(g: AnimalGenome, species: 'dog' | 'cat', elder: boolean): CoatPlan {
  const cream = species === 'cat' ? '#f1ebe0' : '#f3ede2';
  const plan: CoatPlan = {
    base: g.coat, second: g.secondary, third: mixColor(g.secondary, '#1c1714', 0.6), white: cream, stripe: g.secondary,
    secondSoft: 0.06, stripeFreq: 0, ticking: 0, fluff: g.coatLength,
  };
  if (species === 'cat') {
    if (g.pattern === 'ticked') { plan.stripeFreq = 1; plan.white = mixColor(g.coat, '#f4ecdc', 0.55); plan.second = mixColor(g.secondary, g.coat, 0.15); }
    if (g.pattern === 'saddle') plan.white = lum(g.secondary) > lum(g.coat) ? g.secondary : cream;
    if (g.pattern === 'patched') { plan.base = cream; plan.white = cream; plan.second = g.secondary; plan.third = '#2b2521'; }
    if (g.pattern === 'masked') { plan.secondSoft = 0.45; plan.white = mixColor(g.coat, '#fbf6ec', 0.4); }
  } else {
    if (g.pattern === 'patched' && lum(g.coat) < lum(g.secondary)) plan.white = g.secondary;
    if (g.pattern === 'ticked') plan.ticking = 0.55;
    if (g.pattern === 'masked') plan.secondSoft = 0.12;
  }
  if (elder) plan.white = mixColor(plan.white, '#d9d6d0', 0.3);
  return plan;
}

export interface CoatSample { white: number; second: number; third: number; shade: number; stripe: number; stripeW: number }

/**
 * Marking fields for a rest-pose point. `p` is in metres (root space); `tags` are the soft region
 * memberships from the sculpt.
 */
export function coatFields(rig: PetRig, g: AnimalGenome, elder: boolean, p: [number, number, number], tags: ArrayLike<number>, out: CoatSample): CoatSample {
  const H = rig.H;
  const x = p[0] / H, y = p[1] / H, z = p[2] / H;
  const hh = H * rig.headScale;
  const hx = (p[0] - rig.headPos[0]) / hh, hy = (p[1] - rig.headPos[1]) / hh, hz = (p[2] - rig.headPos[2]) / hh;
  const leg = tags[TAG.leg], paw = tags[TAG.paw], tail = tags[TAG.tail], head = tags[TAG.head], muzzle = tags[TAG.muzzle];
  const neck = tags[TAG.neck], torso = tags[TAG.torso], brow = tags[TAG.brow], ear = tags[TAG.ear] ?? 0;
  const cat = rig.species === 'cat';
  const seed = Math.floor(hashString(g.coat + g.secondary + g.pattern + (g.type ?? '')) * 1e6);
  const flags = hashString(g.secondary + g.coat);
  // Distance along the tail from its root.
  const tb = rig.joints[6];
  const along = tail > 0.3 ? Math.hypot(p[1] - tb[1], p[2] - tb[2]) / rig.tailLength : 0;
  // Underside of the body and throat.
  const under = (torso + neck) * smooth(cat ? 0.66 : 0.64, cat ? 0.52 : 0.52, y + Math.abs(x) * 0.25);
  const throat = neck * smooth(-0.02, -0.07, hy + (hz - 0.0) * 0.4) + head * smooth(-0.045, -0.08, hy) * smooth(0.02, 0.1, hz);
  const chestFront = torso * smooth(cat ? 0.4 : 0.3, cat ? 0.52 : 0.44, z) * smooth(0.82, 0.68, y);
  const dorsal = (torso + neck * 0.5) * smooth(0.8, 0.95, y) * smooth(0.16, 0.0, Math.abs(x));
  const lowerLeg = (h: number) => (leg + paw) * smooth(h + 0.04, h - 0.04, y);
  const blaze = head * smooth(0.03, 0.012, Math.abs(hx)) * smooth(0.06, 0.12, hz) * smooth(-0.03, 0.02, hy);
  const muzzleAll = muzzle + head * smooth(0.13, 0.18, hz) * smooth(0.02, -0.02, hy);
  let white = -1, second = -1, third = -1, stripe = 0, stripeW = 0;
  let shade = under * 0.9 - dorsal * 0.6;
  // Distance to the nearest eye (head-local units), for spectacles and eye patches.
  const eyeRing = (r: number) => {
    let best = 9;
    for (const e of rig.eyes) best = Math.min(best, Math.hypot(hx - e.pos[0] / hh, hy - e.pos[1] / hh, hz - e.pos[2] / hh));
    return head * smooth(r, r * 0.55, best);
  };
  const patches1 = (freq: number, s: number, thr: number) => (vnoise(x * freq + 13.1, y * freq * 0.9, z * freq, seed + s) - thr) * 6;
  const patches = (freq: number, s: number, thr: number) => {
    const n = vnoise(x * freq + 13.1, y * freq * 0.9, z * freq, seed + s) * 0.65 + vnoise(x * freq * 2.1, y * freq * 2.1 + 7, z * freq * 2.1, seed + s + 9) * 0.35;
    return (n - thr) * 6;
  };
  if (!cat) {
    if (g.pattern === 'saddle') {
      // A dark saddle over the back and the top of the tail; tricolour hounds add white.
      // The boundary wanders (low-frequency noise) and rises toward the withers and the thigh,
      // so the saddle reads as a natural marking rather than a blanket.
      const wobble = (vnoise(x * 3.2, y * 3.2, z * 3.2, seed + 21) - 0.5) * 0.16 + (vnoise(x * 7, y * 7, z * 7, seed + 22) - 0.5) * 0.06;
      const rise = Math.max(0, z - 0.05) * 0.5 + Math.max(0, -z - 0.38) * 0.35;
      const saddle = (torso + neck * 0.4) * smooth(0.6, 0.68, y + wobble - rise) * smooth(0.42, 0.22, z + wobble * 0.5) + tail * smooth(0.0, 0.08, along) * smooth(0.85, 0.7, along);
      second = saddle * 2 - 1;
      if (flags > 0.35 || g.type === 'hound') white = Math.max(under * 1.6, chestFront * 1.4, lowerLeg(0.3) * 1.5, blaze * 1.6, muzzleAll * 1.2, tail * smooth(0.8, 0.9, along) * 2) - 0.5;
    } else if (g.pattern === 'patched') {
      if (lum(g.coat) < lum(g.secondary)) {
        // Collie-style: white collar, chest, blaze, muzzle, socks and tail tip on a dark coat.
        const collar = neck * smooth(0.25, 0.6, neck) * (0.6 + flags * 0.8);
        // On the face the white is a blaze that narrows up the forehead and widens down the bridge,
        // over the nose end of the muzzle, the lips and chin; the sides of the muzzle by the eyes stay
        // dark (all-white, the muzzle reads as a pale tube).
        const blazeW = 0.014 + 0.036 * smooth(0.1, 0.22, hz);
        const faceBlaze = head * smooth(blazeW + 0.012, blazeW, Math.abs(hx)) * smooth(0.06, 0.12, hz) * smooth(-0.03, 0.02, hy);
        const muzzleWhite = muzzleAll * Math.max(smooth(0.19, 0.25, hz), smooth(-0.005, -0.03, hy), smooth(blazeW + 0.012, blazeW, Math.abs(hx)));
        white = Math.max(under * 1.5, chestFront * 1.8, throat * 1.6, lowerLeg(0.22 + flags * 0.15) * 1.6, faceBlaze * 1.8, muzzleWhite * 1.4, tail * smooth(0.82, 0.92, along) * 2, collar) - 0.5;
        // Tan points above the eyes and on the cheeks.
        third = -1;
      } else {
        // Piebald: coloured ears and eye patches, a few soft-edged islands on the body.
        const side = hx > 0 ? 1 : -1;
        const eyePatch = (flags > 0.5 ? side : -side) > 0 ? eyeRing(0.09) : 0;
        second = Math.max(ear * 2 - 1, eyePatch * 2 - 0.9, (torso + tail * 0.3) * patches1(1.4, 1, 0.6) - 0.15 * (1 - torso), -1);
      }
    } else if (g.pattern === 'masked') {
      // A dark muzzle and spectacles; dark ears.
      second = Math.max(muzzle * 2.2 - 1.1, eyeRing(0.07) * 1.6 - 0.6, ear * 2 - 1);
      shade -= dorsal * 0.4;
    } else if (g.pattern === 'ticked') {
      // Roan / ticked: a solid-coloured head and ears, big patches, fine flecks everywhere.
      second = Math.max(head * 1.2 - 0.6 - muzzleAll * 0.1, (torso + tail) * patches(1.8, 3, 0.62) * 0.8);
      third = 1;
    } else {
      shade -= dorsal * 0.2;
    }
    if (rig.beard) white = Math.max(white, -1);
  } else {
    const chin = head * smooth(-0.04, -0.075, hy) + muzzle * smooth(-0.03, -0.06, hy);
    if (g.pattern === 'ticked') {
      // Mackerel tabby: dorsal line, vertical side stripes, leg bars, tail rings, forehead M.
      second = (torso + neck * 0.5) * smooth(0.9, 0.97, y) * smooth(0.05, 0.02, Math.abs(x)) * 2 - 1 + tail * smooth(0.9, 0.96, along) * 2;
      white = Math.max(chin * 1.6, muzzle * 0.9 * smooth(-0.04, -0.06, hy), under * 1.1) - 0.55;
      const torsoS = torso + neck * 0.4;
      // Each region has its own stripe direction; where regions meet, the stripes fade instead of
      // breaking into a seam. Low-frequency warps keep them from reading as zebra bands.
      const warp = (vnoise(x * 3.5, y * 3.5, z * 3.5, seed + 31) - 0.5) * 3.2;
      const regions: [number, number][] = [
        [torsoS * (1 - head), z * 42 + Math.sin(y * 9) * 1.2 + Math.abs(x) * 5 + warp],
        [(leg + paw) * smooth(0.12, 0.3, y), y * 36 + warp * 0.5],
        [tail, along * 46],
        // Lines running back over the crown from the forehead "M" …
        [head * smooth(0.035, 0.075, hy) * (1 - muzzle), hx * 140 + warp * 0.3],
        // … and two lines sweeping back from the outer corner of each eye.
        [head * smooth(0.06, 0.09, Math.abs(hx)) * smooth(0.04, 0.0, hy) * smooth(-0.07, -0.03, hy), (hy + Math.abs(hz) * 0.25) * 130],
        [neck * (1 - head), y * 40 + warp * 0.5],
      ];
      let best = 0, total = 0.12;
      for (const [w, c] of regions) { total += w; if (w > best) { best = w; stripe = c; } }
      stripeW = Math.pow(best / total, 4);
      stripeW *= 1 - under * 0.75;
      stripeW *= 1 - paw * 0.85;
      stripeW *= 1 - muzzle * 0.9;
      stripeW *= 1 - smooth(0.9, 0.98, along) * 0.6;
    } else if (g.pattern === 'saddle') {
      // Tuxedo: white bib, belly, chin, muzzle and paws.
      white = Math.max(under * 1.7, chestFront * 1.6, throat * 1.6, chin * 1.8, muzzle * 1.5 * smooth(0.01, -0.03, hy), lowerLeg(0.16 + flags * 0.12) * 1.7, blaze * (flags > 0.5 ? 1.6 : 0)) - 0.5;
    } else if (g.pattern === 'patched') {
      // Calico: white base with ginger and black islands, mostly over the back and head.
      const top = smooth(0.62, 0.85, y) + head * 0.6 + tail * 0.8;
      second = (patches(3, 4, 0.5) * 0.8 + top * 0.8 - 0.55) - under * 1.5;
      third = (patches(3.2, 8, 0.6) * 0.8 + top * 0.6 - 0.45) - under * 1.5;
      white = -1;
    } else if (g.pattern === 'masked') {
      // Colourpoint: extremities darken by distance from the warm body core.
      const nd = Math.hypot(hx, (hy + 0.02) * 1.15, hz - 0.17);
      const face = (head + muzzle) * smooth(0.16, 0.05, nd);
      const legs = (leg + paw) * smooth(0.55, 0.1, y);
      second = Math.min(1, Math.max(face, legs * 1.1, tail * (0.4 + along), ear, 0)) * 2 - 1.05;
      shade = under * 0.5 - dorsal * 0.3;
    } else {
      shade = under * 0.4 - dorsal * 0.3;
    }
  }
  if (elder) {
    // Grizzled muzzle: a field near the threshold so the noise reads as scattered grey hairs.
    white = Math.max(white, Math.min(1, muzzleAll) * 0.2 + brow * 0.05 + eyeRing(0.08) * 0.07 - 0.19);
  }
  out.white = white; out.second = second; out.third = third; out.shade = shade; out.stripe = stripe; out.stripeW = stripeW;
  return out;
}

/** Writes aRest/aCoat/aStripe attributes for a geometry whose vertices are in rest root space. */
export function applyCoatAttributes(geometry: THREE.BufferGeometry, rig: PetRig, g: AnimalGenome, elder: boolean, tagsFor: (i: number, out: Float32Array) => void, restOf?: (i: number, out: [number, number, number]) => void): void {
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  const rest = new Float32Array(n * 3), coat = new Float32Array(n * 4), stripe = new Float32Array(n * 2), flow = new Float32Array(n * 3);
  const tags = new Float32Array(TAG_COUNT);
  // Normals only line up with the rest pose when the vertices are already in it.
  const nor = restOf ? null : geometry.getAttribute('normal');
  const s: CoatSample = { white: 0, second: 0, third: 0, shade: 0, stripe: 0, stripeW: 0 };
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (restOf) restOf(i, p); else { p[0] = pos.getX(i); p[1] = pos.getY(i); p[2] = pos.getZ(i); }
    tags.fill(0);
    tagsFor(i, tags);
    coatFields(rig, g, elder, p, tags, s);
    rest[i * 3] = p[0] / rig.H; rest[i * 3 + 1] = p[1] / rig.H; rest[i * 3 + 2] = p[2] / rig.H;
    coat[i * 4] = s.white; coat[i * 4 + 1] = s.second; coat[i * 4 + 2] = s.third; coat[i * 4 + 3] = s.shade;
    stripe[i * 2] = s.stripe; stripe[i * 2 + 1] = s.stripeW;
    // Which way the hair lies: from the nose back toward the tail over head, neck, body and tail;
    // straight down the legs, paws and ears; down and back over the belly and flanks.
    const down = Math.min(1, tags[TAG.leg] + tags[TAG.paw] + tags[TAG.ear]);
    let fx = 0, fy = -0.3 - 0.7 * down, fz = -1 + 0.95 * down;
    if (nor) {
      // Hair lies flat on the skin: drop the part of the direction that points into the surface.
      // Where the coat faces the way the hair runs (the chest, the rump), it falls downward.
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      const d = fx * nx + fy * ny + fz * nz;
      fx -= nx * d; fy -= ny * d; fz -= nz * d;
      const t = Math.min(1, Math.hypot(fx, fy, fz) / 0.45);
      const gx = -nx * -ny, gy = -1 + ny * ny, gz = -nz * -ny;
      fx = fx * t + gx * (1 - t); fy = fy * t + gy * (1 - t); fz = fz * t + gz * (1 - t);
    }
    // The vector's length is how long the hair is there: short on the muzzle, face and paws.
    const hair = 1 - 0.65 * Math.min(1, tags[TAG.muzzle] + tags[TAG.paw]) - 0.35 * tags[TAG.head] * (1 - tags[TAG.muzzle]);
    const fl = (Math.hypot(fx, fy, fz) || 1) / Math.max(0.2, hair);
    flow[i * 3] = fx / fl; flow[i * 3 + 1] = fy / fl; flow[i * 3 + 2] = fz / fl;
  }
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
  geometry.setAttribute('aCoat', new THREE.BufferAttribute(coat, 4));
  geometry.setAttribute('aStripe', new THREE.BufferAttribute(stripe, 2));
  geometry.setAttribute('aFlow', new THREE.BufferAttribute(flow, 3));
}

/** CPU version of the shader's colour choice (no noise), for lids and other small solid parts. */
export function coatColorAt(plan: CoatPlan, s: CoatSample): THREE.Color {
  const c = new THREE.Color(plan.base);
  c.lerp(new THREE.Color(plan.second), smooth(-plan.secondSoft, plan.secondSoft, s.second));
  c.lerp(new THREE.Color(plan.third), smooth(-0.06, 0.06, s.third) * (plan.ticking > 0 ? 0 : 1));
  c.lerp(new THREE.Color(plan.white), smooth(-0.06, 0.06, s.white));
  return c.multiplyScalar(1 + s.shade * 0.1);
}

const VERT_PARS = /* glsl */`
attribute vec3 aRest;
attribute vec4 aCoat;
attribute vec2 aStripe;
attribute vec3 aFlow;
varying vec3 vRest;
varying vec4 vCoat;
varying vec2 vStripe;
varying vec3 vFlow;
`;

const FRAG_PARS = /* glsl */`
varying vec3 vRest;
varying vec4 vCoat;
varying vec2 vStripe;
varying vec3 vFlow;
uniform vec3 uBase;
uniform vec3 uSecond;
uniform vec3 uThird;
uniform vec3 uWhite;
uniform vec3 uStripeCol;
uniform vec4 uCoatOpts; // secondSoft, stripeFreq, ticking, fluff
float petHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float petNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(petHash(i), petHash(i + vec3(1, 0, 0)), f.x), mix(petHash(i + vec3(0, 1, 0)), petHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(petHash(i + vec3(0, 0, 1)), petHash(i + vec3(1, 0, 1)), f.x), mix(petHash(i + vec3(0, 1, 1)), petHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float petFade(float freq) {
  // Fade detail that would be smaller than a pixel, so distant pets don't shimmer.
  float w = length(fwidth(vRest)) * freq;
  return 1.0 - smoothstep(0.35, 1.1, w);
}
float petFurHeight;
`;

const FRAG_COLOR = /* glsl */`
{
  float nLo = petNoise(vRest * 7.0);
  float nMid = petNoise(vRest * 26.0 + 3.1);
  float fineFade = petFade(150.0);
  float nFine = petNoise(vRest * vec3(150.0, 150.0, 70.0) + 11.0);
  float edge = (nLo - 0.5) * 0.22 + (nMid - 0.5) * 0.16 + (nFine - 0.5) * 0.16 * fineFade;
  vec3 col = uBase;
  float soft = uCoatOpts.x;
  col = mix(col, uSecond, smoothstep(-soft, soft, vCoat.y + edge * mix(1.0, 0.4, step(0.3, soft))));
  // Ticking / roan flecks, or a third colour's patches.
  float fleck = smoothstep(0.62, 0.7, petNoise(vRest * 95.0 + 5.0)) * uCoatOpts.z * petFade(95.0);
  col = mix(col, uThird, smoothstep(-0.05, 0.05, vCoat.z + edge) * (1.0 - step(0.01, uCoatOpts.z)));
  col = mix(col, uSecond, fleck);
  // Tabby stripes.
  if (uCoatOpts.y > 0.0) {
    float s = sin(vStripe.x + (nLo - 0.5) * 1.6 + (nMid - 0.5) * 0.7);
    float band = smoothstep(0.34, 0.74, s * 0.5 + 0.5 + (nFine - 0.5) * 0.25 * fineFade);
    col = mix(col, uStripeCol, band * clamp(vStripe.y, 0.0, 1.0) * 0.92);
  }
  col = mix(col, uWhite, smoothstep(-0.05, 0.05, vCoat.x + edge));
  // Countershading, clumps and strands.
  col *= 1.0 + vCoat.w * 0.09;
  col *= 0.96 + nMid * 0.05 + (nFine - 0.5) * 0.04 * fineFade;
  // Directional fur: locks and strands laid along the way the hair grows (vFlow), longer in a
  // fluffy coat. Locks show from a middle distance; single strands only close up.
  vec3 fl = normalize(vFlow);
  vec3 ax = normalize(cross(fl, abs(fl.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  vec3 q = vec3(dot(vRest, fl), dot(vRest, ax), dot(vRest, cross(fl, ax)));
  float hairLen = clamp(length(vFlow), 0.0, 1.0);
  float len = mix(1.0, 0.55, uCoatOpts.w);
  float lockFade = petFade(60.0);
  float strandFade = petFade(260.0);
  float lockLo = petNoise(q * vec3(9.0 * len, 40.0, 40.0) + 17.0);
  float lock = lockLo * 0.7 + petNoise(q * vec3(18.0 * len, 80.0, 80.0) + 41.0) * 0.3;
  float strand = petNoise(q * vec3(55.0 * len, 260.0, 260.0) + 29.0);
  col *= 1.0 + ((lock - 0.5) * 0.22 * lockFade + (strand - 0.5) * 0.06 * strandFade) * hairLen;
  diffuseColor.rgb = col;
  petFurHeight = nMid * 0.08 + (lockLo * lockFade * 0.9 + strand * strandFade * 0.05) * hairLen;
}
`;

const FRAG_BUMP = /* glsl */`
{
  vec3 dpx = dFdx(-vViewPosition);
  vec3 dpy = dFdy(-vViewPosition);
  float hx = dFdx(petFurHeight);
  float hy = dFdy(petFurHeight);
  vec3 r1 = cross(dpy, normal);
  vec3 r2 = cross(normal, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  normal = normalize(abs(det) * normal - grad * 0.0013);
}
`;

const FRAG_RIM = /* glsl */`
{
  float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
  totalEmissiveRadiance += diffuseColor.rgb * rim * 0.16;
}
`;

/** One fur material per pet; the program is shared by every pet. */
export function furMaterial(plan: CoatPlan): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.86, metalness: 0 });
  const uniforms = {
    uBase: { value: new THREE.Color(plan.base) },
    uSecond: { value: new THREE.Color(plan.second) },
    uThird: { value: new THREE.Color(plan.third) },
    uWhite: { value: new THREE.Color(plan.white) },
    uStripeCol: { value: new THREE.Color(plan.stripe) },
    uCoatOpts: { value: new THREE.Vector4(plan.secondSoft, plan.stripeFreq, plan.ticking, plan.fluff) },
  };
  m.userData.coatUniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = aRest; vCoat = aCoat; vStripe = aStripe; vFlow = aFlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', FRAG_COLOR)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_BUMP)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_RIM);
  };
  m.customProgramCacheKey = () => 'kynds-pet-fur-2';
  return m;
}

/**
 * One shell of fur: the body pushed out along its normals (and combed back along the way the hair
 * lies), with only the strands left standing. A stack of these round a long coat breaks the smooth
 * silhouette into real fluff; a couple round a short coat give it a soft, fuzzy edge.
 */
export function furShellMaterial(plan: CoatPlan, layer: number, length: number, density: number): THREE.MeshStandardMaterial {
  const m = furMaterial(plan);
  const base = m.onBeforeCompile;
  const shell = { uLayer: { value: layer }, uShellLen: { value: length }, uDensity: { value: density } };
  m.onBeforeCompile = (shader, r) => {
    base.call(m, shader, r);
    Object.assign(shader.uniforms, shell);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uLayer;\nuniform float uShellLen;\nattribute float aFur;\nvarying float vFur;')
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
        // A little out along the (skinned) normal, then combed the way the hair lies and weighed
        // down toward the tips, so a long coat drapes instead of bristling like a hedgehog.
        vFur = aFur;
        float fl = uShellLen * aFur;
        transformed += normalize(objectNormal) * fl * uLayer * 0.55 + normalize(aFlow + vec3(0.0, -0.7, 0.0)) * fl * pow(uLayer, 1.6) * 1.5;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLayer;\nuniform float uDensity;\nvarying float vFur;')
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        {
          // Strands: each cell of a fine grid holds one hair that thins toward its tip.
          vec3 cell = vRest * uDensity;
          vec3 f = fract(cell) - 0.5;
          float h = petHash(floor(cell));
          // Soft locks: thick at the root, tapering, and a few longer guard hairs among them.
          float r = (0.72 - 0.42 * uLayer) * (0.7 + 0.6 * h);
          if (vFur * 1.15 < uLayer || length(f.xy) + length(f.yz) * 0.4 > r || h < uLayer * 0.4) discard;
          // Shadowed near the skin, bright at the tips.
          diffuseColor.rgb *= mix(0.72, 1.06, uLayer);
        }`);
  };
  m.customProgramCacheKey = () => 'kynds-pet-fur-shell-2';
  return m;
}

/* ------------------------------------------------------------------------------------------ */

const eyeCache = new Map<string, THREE.DataTexture>();

/**
 * An eye texture in planar projection (the eyeball faces +Z): a fibrous iris with a darker limbal
 * ring, a round (dog) or slit (cat) pupil, and a baked catch-light so eyes read alive at a distance.
 */
export function eyeTexture(color: string, cat: boolean): THREE.DataTexture {
  const key = color + (cat ? 'c' : 'd');
  const hit = eyeCache.get(key);
  if (hit) return hit;
  const size = 128, data = new Uint8Array(size * size * 4);
  const iris = new THREE.Color(color);
  // Dogs show almost no white: a big iris and a dark brown rim. Cats' irises fill the eye.
  const irisR = cat ? 0.86 : 0.88;
  const sclera = cat ? iris.clone().lerp(new THREE.Color('#d8d2a0'), 0.4) : iris.clone().lerp(new THREE.Color('#3a2a22'), 0.7);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i + 0.5) / size * 2 - 1, y = (j + 0.5) / size * 2 - 1;
    const r = Math.hypot(x, y), a = Math.atan2(y, x);
    let c: THREE.Color;
    if (r > irisR) c = sclera.clone().multiplyScalar(1 - smooth(irisR, 1, r) * 0.25);
    else {
      const t = r / irisR;
      const fibres = 0.85 + 0.15 * Math.sin(a * 37 + Math.sin(a * 11) * 2) * Math.sin(a * 23 + t * 6);
      c = iris.clone().multiplyScalar((0.75 + 0.55 * (1 - t) * (cat ? 1.0 : 0.8)) * fibres);
      if (cat) c.lerp(new THREE.Color('#e8e070'), (1 - t) * 0.18);
      // Limbal ring.
      c.multiplyScalar(1 - smooth(0.78, 0.98, t) * 0.6);
      // Pupil.
      const px = cat ? x / (irisR * 0.34) : x / (irisR * 0.44), py = cat ? y / (irisR * 0.8) : y / (irisR * 0.44);
      const pr = Math.hypot(px, py);
      c.lerp(new THREE.Color('#060504'), 1 - smooth(0.9, 1.05, pr));
    }
    // Catch-lights (upper outer, plus a small lower one).
    const hl = Math.exp(-(((x + 0.28) / 0.13) ** 2 + ((y - 0.32) / 0.11) ** 2) * 2.2);
    const hl2 = Math.exp(-(((x - 0.25) / 0.06) ** 2 + ((y + 0.3) / 0.05) ** 2) * 2.2) * 0.5;
    c.lerp(new THREE.Color('#ffffff'), Math.min(1, hl + hl2));
    const n = (j * size + i) * 4;
    c.convertLinearToSRGB();
    data[n] = Math.min(255, c.r * 255); data[n + 1] = Math.min(255, c.g * 255); data[n + 2] = Math.min(255, c.b * 255); data[n + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.userData.shared = true;
  eyeCache.set(key, tex);
  return tex;
}

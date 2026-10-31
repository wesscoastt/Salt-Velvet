import type { FullAppearance } from '../sim/entities/appearance.ts';
import type { LifeStage } from '../sim/family/Life.ts';
import { clamp01, lerp, smoothstep } from './kyndGeometry.ts';

/*
 * Kynd face anatomy. The face is one continuous skin surface: a skull (see kyndBody.ts) with this
 * module's relief laid over its front: brow, eye sockets and lids, cheekbones, the nose with its
 * bridge, tip, alar wings and nostrils, the philtrum, lips with a cupid's bow and a mouth crease, the
 * chin and jaw. The eyelids are part of the same skin: round each eye the surface follows a sphere
 * just outside the eyeball and dives behind it inside the eye opening, so the lid margin is wherever
 * skin and eyeball meet (crisp at any resolution) and a blink is the upper lid's skin turning on
 * the lids bone. Nothing is glued on, so nothing can float off the face or leave a seam.
 *
 * Everything is in head space (head size 1, metres for an adult): y up from the chin, z forward.
 *
 * The head mesh is laid out in a *canonical* face space shared by every Kynd: rows of constant
 * canonical height and per-row samples that are dense round the eyes, nose and lips. A per-Kynd
 * warp moves those samples onto that Kynd's own features, so one face texture (shading, lip
 * border, wrinkles, stubble) fits every face exactly.
 */

export interface HeadShape {
  jaw: number;
  nose: number;
  female: boolean;
  /** 1 child, 0.4 teen, 0 grown. */
  child: number;
  width: number;
  length: number;
  cheeks: number;
  /** 0 young … 1 elder. */
  age: number;
  lips: number;
  eyeShape: number;
  brow: number;
  /** Fine detail (appearance DETAIL_FIELDS), 0…1 with 0.5 neutral. */
  jawAngle: number;
  chin: number;
  chinWidth: number;
  noseWidth: number;
  noseBridge: number;
  noseTip: number;
  cheekFullness: number;
}

export interface FaceLayout {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  eyeR: number;
  mouthY: number;
  mouthZ: number;
  mouthW: number;
  /** Nose tip and base (subnasale) heights; half-width at the alar wings; projection scale. */
  noseTipY: number;
  noseBaseY: number;
  alaX: number;
  noseProj: number;
  /** Upper and lower vermilion heights at the middle of the mouth. */
  lipUp: number;
  lipLo: number;
  chinY: number;
  browY: number;
}

export function headShape(look: FullAppearance, stage: LifeStage): HeadShape {
  const child = stage === 'child' ? 1 : stage === 'teen' ? 0.4 : 0;
  return {
    jaw: look.jaw * (1 - child * 0.5),
    nose: look.nose,
    female: look.sex === 'female',
    child,
    width: look.faceWidth,
    length: look.faceLength,
    cheeks: look.cheekbones,
    age: stage === 'elder' ? 1 : 0,
    lips: look.lipFullness,
    eyeShape: look.eyeShape,
    brow: look.browShape,
    jawAngle: look.jawAngle,
    chin: look.chin,
    chinWidth: look.chinWidth,
    noseWidth: look.noseWidth,
    noseBridge: look.noseBridge,
    noseTip: look.noseTip,
    cheekFullness: look.cheekFullness,
  };
}

/** Feature positions for a face (eyeZ and mouthZ are filled in once the skull is known). */
export function faceLayout(look: Pick<FullAppearance, 'eyeSize' | 'eyeSpacing' | 'faceWidth' | 'faceLength' | 'mouthWidth' | 'lipFullness' | 'nose' | 'upperLip' | 'mouthHeight' | 'noseWidth' | 'noseTip' | 'chin'>, s: HeadShape): FaceLayout {
  const child = s.child;
  const eyeR = 0.0121 + look.eyeSize * 0.0048 + child * 0.0022;
  const eyeY = 0.118 - child * 0.006;
  const noseProj = 0.55 + look.nose * 0.9 - child * 0.12;
  // An upturned tip sits a little higher (and shows the nostrils); a drooping one lower.
  const noseTipY = eyeY - (0.033 + look.nose * 0.011 - child * 0.006) + (look.noseTip - 0.5) * 0.004;
  const noseBaseY = noseTipY - (0.0105 + look.nose * 0.003 - child * 0.002) - (look.noseTip - 0.5) * 0.002;
  const mouthY = Math.min(noseBaseY - 0.012, 0.062 - look.faceLength * 0.02 - child * 0.004 - (look.mouthHeight - 0.5) * 0.008);
  const fem = s.female ? 1 : 0;
  // The upper lip against the lower: thin over full, or a full, pouting upper lip.
  const up = lerp(0.65, 1.4, look.upperLip), lo = lerp(1.12, 0.92, look.upperLip);
  const lipUp = (0.0034 + look.lipFullness * 0.0046 + fem * 0.0006) * (1 - child * 0.15) * (1 - s.age * 0.25) * up;
  const lipLo = (0.005 + look.lipFullness * 0.0052 + fem * 0.0006) * (1 - child * 0.15) * (1 - s.age * 0.2) * lo;
  return {
    eyeX: 0.0262 + look.eyeSpacing * 0.0085 + look.faceWidth * 0.005 + child * 0.001,
    eyeY,
    eyeZ: 0,
    eyeR,
    mouthY,
    mouthZ: 0,
    mouthW: 0.015 + look.mouthWidth * 0.017 - child * 0.002,
    noseTipY,
    noseBaseY,
    alaX: (0.0098 + noseProj * 0.0022 + look.faceWidth * 0.0014) * (1 - child * 0.12) * lerp(0.8, 1.25, look.noseWidth),
    noseProj,
    lipUp,
    lipLo,
    // A strong chin is a longer one.
    chinY: mouthY - lipLo - 0.016 - look.faceLength * 0.004 - (look.chin - 0.5) * 0.004,
    browY: eyeY + 0.03,
  };
}

const MID = { eyeSize: 0.5, eyeSpacing: 0.5, faceWidth: 0.5, faceLength: 0.5, mouthWidth: 0.5, lipFullness: 0.5, nose: 0.5, upperLip: 0.5, mouthHeight: 0.5, noseWidth: 0.5, noseTip: 0.5, chin: 0.5 };
const MID_SHAPE: HeadShape = {
  jaw: 0.5, nose: 0.5, female: true, child: 0, width: 0.5, length: 0.5, cheeks: 0.5, age: 0, lips: 0.5, eyeShape: 0.5, brow: 0.5,
  jawAngle: 0.5, chin: 0.5, chinWidth: 0.5, noseWidth: 0.5, noseBridge: 0.5, noseTip: 0.5, cheekFullness: 0.5,
};
/** The canonical face every Kynd's face is warped from (and the face texture is painted on). */
export const CANON: FaceLayout = faceLayout(MID, MID_SHAPE);

// --- small maths -------------------------------------------------------------------------------

function g(dx: number, dy: number, sx: number, sy: number): number {
  return Math.exp(-((dx / sx) ** 2 + (dy / sy) ** 2));
}

/** Polynomial smooth maximum. */
function smax(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(a, b, h) + k * h * (1 - h);
}

/** Piecewise-linear map through sorted (x, y) keys, clamped at the ends. */
export class Linear {
  private xs: number[];
  private ys: number[];
  constructor(xs: number[], ys: number[]) {
    this.xs = xs;
    this.ys = ys;
  }
  at(x: number): number {
    const { xs, ys } = this;
    if (x <= xs[0]) return ys[0] + (x - xs[0]);
    const n = xs.length;
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]);
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    return lerp(ys[i], ys[i + 1], (x - xs[i]) / (xs[i + 1] - xs[i]));
  }
}

// --- eyes and lids -----------------------------------------------------------------------------

/** Corners of the eye opening, as angles across the eyeball (negative toward the nose). */
export const EYE_IN = -1.06;
export const EYE_OUT = 1.1;

export interface Lids {
  /** Radius of the lid sphere round the eye centre. */
  rho: number;
  /** Upper and lower lid margins: angle above the eye centre at angle `a` across. */
  up(a: number): number;
  lo(a: number): number;
  /** Height of the upper lid crease above the margin (metres along the lid). */
  crease: number;
}

export function lidsFor(s: HeadShape, f: FaceLayout): Lids {
  const mid = (EYE_IN + EYE_OUT) / 2;
  const half = (EYE_OUT - EYE_IN) / 2;
  const tilt = -0.025 + s.eyeShape * 0.1;
  // The upper lid rests on the top of the iris (more white showing above reads as a stare).
  const openU = (0.41 + s.eyeShape * 0.1 + s.child * 0.05) * (1 - s.age * 0.14);
  const openL = 0.25 + s.child * 0.05 - s.eyeShape * 0.04;
  const shape = (a: number, skew: number, pow: number) => {
    const A = (a - mid) / half;
    if (Math.abs(A) >= 1) return 0;
    return Math.pow(1 - A * A, pow) * (1 + skew * A);
  };
  return {
    rho: f.eyeR + 0.0013 + s.age * 0.0003,
    up: (a) => tilt * (a - mid) + openU * shape(a, -0.16, 0.62),
    lo: (a) => tilt * (a - mid) - openL * shape(a, 0.22, 0.85),
    crease: (0.0058 + s.eyeShape * 0.0012 - s.child * 0.0012) * (1 - s.age * 0.3),
  };
}

export interface EyeParam {
  /** Across the eyeball (positive outward), and up (angle about the x axis). */
  a: number;
  e: number;
  /** Distance from the eye axis, in the face plane. */
  r: number;
  /** Signed distance outside the eye opening (metres; negative inside). */
  d: number;
  dUp: number;
  dLo: number;
  dCorner: number;
}

/** Where (|x|, y) sits relative to an eye's lids, or null if it's off the eye entirely. */
export function eyeParam(ax: number, y: number, f: FaceLayout, L: Lids): EyeParam | null {
  const dx = ax - f.eyeX;
  const dy = y - f.eyeY;
  const R = L.rho;
  const r = Math.hypot(dx, dy);
  if (r >= R * 0.995) return null;
  const a = Math.asin(dx / R);
  const ca = Math.cos(a);
  const e = Math.asin(Math.max(-1, Math.min(1, dy / (R * ca))));
  const u = L.up(a);
  const l = L.lo(a);
  const dUp = R * (e - u);
  const dLo = R * (l - e);
  const dCorner = R * (a > 0 ? a - EYE_OUT : EYE_IN - a);
  const d = smax(Math.max(dUp, dLo), dCorner, 0.0012);
  return { a, e, r, d, dUp, dLo, dCorner };
}

/** How much of the skin at (|x|, y) belongs to the eyelid surface (vs the face round it). */
function lidBlend(p: EyeParam, L: Lids): number {
  const upper = p.e > (L.up(p.a) + L.lo(p.a)) / 2;
  const w = upper ? smoothstep(L.crease + 0.0062, L.crease + 0.0004, p.dUp) : smoothstep(0.0094, 0.0034, p.dLo);
  return w * smoothstep(0.0048, 0.0004, p.dCorner) * smoothstep(L.rho * 0.99, L.rho * 0.86, p.r);
}

/**
 * Skinning weight of the blinking upper lid at (|x|, y): enough turn at each point across the eye
 * for the margin to just meet the lower lid when the lids bone turns fully (0.98 rad).
 */
export function lidWeight(ax: number, y: number, f: FaceLayout, L: Lids): number {
  const p = eyeParam(ax, y, f, L);
  if (!p) return 0;
  const u = L.up(p.a);
  const l = L.lo(p.a);
  if (p.e <= (u + l) / 2) return 0;
  const need = clamp01((u - l + 0.07) / 0.98);
  return need * smoothstep(L.crease + 0.0028, L.crease - 0.0012, p.dUp) * smoothstep(0.0032, -0.0006, p.dCorner)
    * smoothstep(L.rho * 0.99, L.rho * 0.9, p.r);
}

/** The finished skin depth round an eye, given the face depth there without the eye. */
function eyeZone(ax: number, y: number, z: number, s: HeadShape, f: FaceLayout, L: Lids): number {
  const p = eyeParam(ax, y, f, L);
  if (!p) return z;
  const w = lidBlend(p, L);
  // The upper lid sits a hair proud of the lower, so a closed lid covers the lower cleanly.
  const upper = smoothstep(-0.03, 0.03, p.e - (L.up(p.a) + L.lo(p.a)) / 2);
  const rho = L.rho + (upper - 0.5) * 0.0005;
  const dx = ax - f.eyeX;
  const dy = y - f.eyeY;
  let zl = f.eyeZ + Math.sqrt(Math.max(0, rho * rho - dx * dx - dy * dy));
  // Upper lid: a soft tarsal fullness, then the crease fold under the brow.
  const tarsal = Math.max(0, Math.sin(Math.PI * clamp01(p.dUp / L.crease)));
  zl += upper * (0.00035 * tarsal - (0.00055 + s.age * 0.0004) * Math.exp(-(((p.dUp - L.crease) / 0.0009) ** 2)));
  // Lower lid: a little roll below the margin, then the lid-cheek junction.
  zl += (1 - upper) * (0.0001 * Math.exp(-(((p.dLo - 0.0016) / 0.0012) ** 2)) - (0.00025 + s.age * 0.0006) * Math.exp(-(((p.dLo - 0.0062) / 0.0018) ** 2)));
  let out = lerp(z, zl, w);
  // Inside the opening the skin dives behind the eyeball; the lid margin is where they meet. A
  // little tissue stays forward at the inner corner (the tear duct).
  const duct = Math.exp(-(((p.a - (EYE_IN + 0.1)) / 0.1) ** 2));
  out -= 0.0055 * smoothstep(0.00028, -0.0014, p.d) * (1 - 0.82 * duct) * w;
  return out;
}

// --- nose --------------------------------------------------------------------------------------

function nose(x: number, y: number, s: HeadShape, f: FaceLayout): number {
  const ax = Math.abs(x);
  const ns = f.noseProj;
  const yN = f.eyeY + 0.003;
  const yT = f.noseTipY;
  const yS = f.noseBaseY;
  if (y > yN + 0.03 || y < yS - 0.01 || ax > 0.03) return 0;
  const hT = (0.0094 + ns * 0.0064) * (1 - s.child * 0.2);
  const wide = lerp(0.82, 1.25, s.noseWidth);
  // Dorsum: a narrow bridge from the nasion widening to the tip, with a slight hump on big noses
  // (and on a high, aquiline bridge; a low one is flatter between the eyes).
  const t = clamp01((yN - y) / (yN - yT));
  const hump = (0.0014 * Math.max(0, s.nose - 0.45) + 0.0018 * Math.max(0, s.noseBridge - 0.5)) * Math.exp(-(((t - 0.45) / 0.18) ** 2)) * (1 - s.child);
  // The bridge runs up into the tip in one line (a low bridge meeting a big tip makes a ski-jump point).
  const hD = lerp((0.0028 - s.child * 0.0012) * lerp(0.45, 1.6, s.noseBridge), hT * 0.92, Math.pow(t, 0.8)) + hump;
  const wD = lerp(0.0044, 0.0062, t) * (0.88 + 0.22 * ns) * lerp(0.9, 1.15, s.noseWidth);
  const above = y > yN ? Math.exp(-(((y - yN) / 0.0085) ** 2)) : 1;
  const below = y < yT + 0.003 ? Math.exp(-(((yT + 0.003 - y) / 0.0045) ** 2)) : 1;
  const dors = hD * Math.exp(-((x / wD) ** 2)) * above * below;
  // Tip: a rounded lobule, faintly two-domed; the alar wings either side and a little lower,
  // joined to the tip by the lobule's fill so the lower nose reads as one form.
  // The lobule is a rounded dome (a flattened bell, not a cone), so the tip reads soft in profile.
  const wT = (0.0058 + 0.0014 * ns) * wide;
  const rT = (x / wT) ** 2 + ((y - (yT + 0.0004)) / 0.0084) ** 2;
  const tip = hT * 0.94 * Math.exp(-Math.pow(rT, 1.45));
  const tip2 = hT * 0.8 * g(ax - 0.0023, y - (yT - 0.0004), wT * 0.72, 0.0066);
  const aY = lerp(yT, yS, 0.5);
  const aX = f.alaX * 0.88;
  const ala = hT * 0.36 * g(ax - aX, y - aY, 0.0048, 0.0044);
  // A full underside from the tip back to the lip, so the profile rounds under instead of ending in a point.
  const fill = hT * (0.7 + s.child * 0.12) * g(x, y - lerp(yT, yS, 0.45), f.alaX * 0.84, 0.0064);
  // A soft maximum (p-norm) blends the parts without bulging where they meet.
  let n = Math.pow(dors ** 3 + tip ** 3 + tip2 ** 3 + ala ** 3 + fill ** 3, 1 / 3);
  // The alar groove curves round the outer and upper edge of each wing.
  const ex = (ax - aX) / 0.0055;
  const ey = (y - aY) / 0.005;
  const rr = Math.hypot(ex, ey);
  n -= 0.0008 * Math.exp(-(((rr - 1.12) / 0.24) ** 2)) * smoothstep(-0.55, 0.35, ex * 0.75 + ey * 0.66);
  // Columella down the middle of the underside; the nostrils either side of it.
  n += 0.0014 * g(x, y - (yS + 0.004), 0.0022, 0.0035);
  // (A child's short nose shows its nostrils from the front if they sit as high as an adult's.)
  n -= 0.0016 * (1 - s.child * 0.45) * g(ax - f.alaX * 0.5, y - (yT - 0.0068 - s.child * 0.0016), 0.0022, 0.0013);
  return n;
}

// --- lips --------------------------------------------------------------------------------------

/** Upper vermilion border, in units of the lip's height: the cupid's bow. */
export function upperBorder(u: number): number {
  const au = Math.abs(u);
  if (au >= 1) return 0;
  const base = Math.pow(1 - Math.pow(au, 2.2), 0.55);
  return base * (1 - 0.17 * Math.exp(-((au / 0.085) ** 2))) + 0.07 * Math.exp(-(((au - 0.22) / 0.075) ** 2)) * base;
}

/** Lower vermilion border, in units of the lip's height. */
export function lowerBorder(u: number): number {
  const au = Math.abs(u);
  if (au >= 1) return 0;
  return Math.pow(1 - au * au, 0.62) * (1 + 0.05 * Math.exp(-((au / 0.3) ** 2)));
}

/** A lip's cross-section from the mouth line (t = 0) to its border (t = 1). */
function lipRoll(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 1.35);
}

function lips(x: number, y: number, s: HeadShape, f: FaceLayout): number {
  const mW = f.mouthW;
  const dy = y - f.mouthY;
  if (Math.abs(x) > mW * 1.9 || dy > 0.03 || dy < -0.03) return 0;
  const u = x / mW;
  const au = Math.abs(u);
  const taper = Math.max(0, 1 - au * au);
  let dz = 0;
  // The mound the lips sit on.
  dz += 0.0026 * g(x, dy + 0.0008, mW * 0.95, 0.011);
  // Vermilion volume: the upper lip pouts at its middle, the lower lip is fuller and rounder.
  const top = f.lipUp * upperBorder(u);
  const bot = f.lipLo * lowerBorder(u);
  const fullness = 0.75 + s.lips * 0.6;
  if (dy > 0 && top > 1e-5) dz += (0.0024 * fullness) * Math.pow(taper, 0.55) * lipRoll(dy / top) * (1 + 0.3 * Math.exp(-((au / 0.25) ** 2)));
  if (dy < 0 && bot > 1e-5) dz += (0.003 * fullness) * Math.pow(taper, 0.45) * lipRoll(-dy / bot);
  // A crisp little roll of skin just outside each border.
  dz += 0.00028 * Math.exp(-(((dy - top) / 0.0006) ** 2)) * Math.pow(taper, 0.4);
  // The mouth line folds in; at rest the lips meet over it, opening the jaw stretches it.
  dz -= 0.0034 * smoothstep(1.06, 0.62, au) * Math.exp(-((dy / 0.0009) ** 2));
  // Corners tuck in, with the modiolus bulge just outside them.
  dz -= 0.0011 * g(au - 1.02, dy / mW, 0.09, 0.08);
  dz += 0.0007 * g(Math.abs(x) - (mW + 0.0068), dy + 0.001, 0.004, 0.0065);
  // Philtrum: two soft columns from the nose down to the peaks of the bow, a groove between.
  const yTop = f.mouthY + f.lipUp * 0.9;
  const span = Math.max(0.004, f.noseBaseY - yTop);
  const tp = clamp01((y - yTop) / span);
  const win = smoothstep(yTop - 0.0012, yTop + 0.0018, y) * smoothstep(f.noseBaseY + 0.0016, f.noseBaseY - 0.0022, y);
  const colX = lerp(0.22 * mW, 0.0027, tp);
  dz += win * (0.0008 * Math.exp(-(((Math.abs(x) - colX) / 0.0015) ** 2)) - 0.0005 * Math.exp(-((x / 0.0017) ** 2)));
  // The groove under the lower lip, above the chin (deeper over a strong chin).
  dz -= (0.0016 + s.age * 0.0006 + Math.max(0, s.chin - 0.5) * 0.001) * g(x, y - (f.mouthY - f.lipLo - 0.0036), mW * 0.85, 0.0028);
  return dz;
}

// --- the whole face ----------------------------------------------------------------------------

/** Relief over the bare skull's front, everything except the eyelid surface. */
function relief(x: number, y: number, s: HeadShape, f: FaceLayout): number {
  const ax = Math.abs(x);
  const grown = 1 - s.child;
  let dz = 0;
  // Brow ridge and glabella (stronger on grown men), the forehead's gentle frontal bossing.
  dz += (0.0018 + (s.female ? 0 : 0.0018)) * grown * g(ax - f.eyeX * 0.92, y - (f.eyeY + 0.029), 0.024, 0.0085);
  dz += 0.0014 * g(x, y - (f.eyeY + 0.022), 0.013, 0.011);
  // Eye sockets round the lids.
  dz -= 0.0048 * g(ax - f.eyeX * 1.02, y - (f.eyeY + 0.001), 0.021, 0.0155);
  // Cheekbones, the soft cheek below (fuller on children), and the hollow under the cheekbone.
  dz += (0.0012 + s.cheeks * 0.0078) * g(ax - (0.045 + s.width * 0.014), y - (f.eyeY - 0.027), 0.019, 0.0145);
  dz += (0.0024 + s.child * 0.0045) * lerp(0.35, 2.1, s.cheekFullness) * g(ax - 0.037, y - (f.eyeY - 0.044), 0.017, 0.016);
  dz -= grown * (0.0006 + s.cheeks * 0.0018 + s.age * 0.001) * lerp(1.8, 0.2, s.cheekFullness) * g(ax - 0.05, y - (f.mouthY + 0.008), 0.013, 0.014);
  // Muzzle (the tooth arch) and chin.
  dz += 0.0062 * g(x, y - (f.mouthY + 0.005), 0.032, 0.024);
  // The chin: a rounded pad, standing forward (receding … strong), pointed or broad; a broad one
  // shows the two mental tubercles either side.
  const chinK = lerp(0.35, 1.9, s.chin) * (1 - s.child * 0.35);
  const chinW = (0.0125 + s.jaw * 0.007) * lerp(0.7, 1.45, s.chinWidth);
  dz += (0.0042 + s.jaw * 0.005) * chinK * g(x, y - f.chinY, chinW, 0.0115);
  dz += 0.0011 * chinK * smoothstep(0.45, 1, s.chinWidth) * g(ax - chinW * 0.75, y - (f.chinY - 0.003), chinW * 0.45, 0.008);
  // Nasolabial fold: from beside the nose down past the mouth corner, deeper with age.
  {
    const ax0 = f.alaX + 0.004;
    const ay0 = f.noseBaseY + 0.004;
    const ax1 = f.mouthW + 0.0065;
    const ay1 = f.mouthY - 0.007;
    const vx = ax1 - ax0;
    const vy = ay1 - ay0;
    const t = clamp01(((ax - ax0) * vx + (y - ay0) * vy) / (vx * vx + vy * vy));
    const dist = Math.hypot(ax - (ax0 + vx * t), y - (ay0 + vy * t));
    const along = Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
    dz -= (0.0005 + s.age * 0.0014) * grown * Math.exp(-((dist / 0.0022) ** 2)) * along;
    // The cheek bulges a little on the outer side of the fold.
    const side = (ax - (ax0 + vx * t)) * 0.8 - (y - (ay0 + vy * t)) * 0.6;
    dz += (0.0006 + s.age * 0.0006) * grown * Math.exp(-(((dist - 0.004) / 0.003) ** 2)) * along * smoothstep(0, 0.002, side);
  }
  dz += nose(x, y, s, f);
  dz += lips(x, y, s, f);
  return dz;
}

/** Finished front depth of the face at (x, y), given the bare skull's depth there. */
export function faceSurface(x: number, y: number, zSkull: number, s: HeadShape, f: FaceLayout, L: Lids): number {
  if (zSkull <= 0) return zSkull;
  // Fade the relief out round the sides of the head.
  const z = zSkull + relief(x, y, s, f) * smoothstep(0, 0.035, zSkull);
  return eyeZone(Math.abs(x), y, z, s, f, L);
}

// --- canonical face space ----------------------------------------------------------------------

/** Canonical (θ, y) → this Kynd's (θ, y), and the texture coordinates of canonical points. */
export class FaceWarp {
  private yMap: Linear;
  private kMap: Linear;

  constructor(f: FaceLayout) {
    const c = CANON;
    // Landmark heights, canonical and this Kynd's. The canonical mouth crease is drawn wider than
    // it is on any face, so the stretch of lip that shows when the mouth opens has texture to show.
    const keys: [number, number][] = [
      [c.chinY - 0.03, f.chinY - 0.03],
      [c.chinY, f.chinY],
      [c.mouthY - c.lipLo - 0.0036, f.mouthY - f.lipLo - 0.0036],
      [c.mouthY - c.lipLo, f.mouthY - f.lipLo],
      [c.mouthY - 0.0016, f.mouthY - 0.0007],
      [c.mouthY + 0.0016, f.mouthY + 0.0007],
      [c.mouthY + c.lipUp, f.mouthY + f.lipUp],
      [c.noseBaseY, f.noseBaseY],
      [c.noseTipY, f.noseTipY],
      [c.eyeY - c.eyeR, f.eyeY - f.eyeR],
      [c.eyeY, f.eyeY],
      [c.eyeY + c.eyeR, f.eyeY + f.eyeR],
      [c.browY, f.browY],
      [0.215, 0.215],
    ];
    this.yMap = new Linear(keys.map((k) => k[0]), keys.map((k) => k[1]));
    const eye = f.eyeX / c.eyeX;
    const mouth = f.mouthW / c.mouthW;
    const ala = f.alaX / c.alaX;
    const kk: [number, number][] = [
      [c.chinY - 0.03, 1],
      [c.chinY, lerp(1, mouth, 0.4)],
      [c.mouthY - c.lipLo - 0.0036, mouth],
      [c.mouthY + c.lipUp + 0.002, mouth],
      [c.noseBaseY, ala],
      [c.noseTipY, lerp(ala, eye, 0.3)],
      [c.eyeY - c.eyeR * 1.4, eye],
      [c.eyeY + c.eyeR * 1.3, eye],
      [c.browY + 0.01, lerp(eye, 1, 0.5)],
      [0.215, 1],
    ];
    this.kMap = new Linear(kk.map((k) => k[0]), kk.map((k) => Math.min(1.42, k[1])));
  }

  y(yc: number): number {
    return this.yMap.at(yc);
  }

  theta(tc: number, yc: number): number {
    const k = this.kMap.at(Math.max(CANON.chinY - 0.03, Math.min(0.215, yc)));
    return tc * lerp(k, 1, smoothstep(0.75, 1.3, Math.abs(tc)));
  }
}

/** Face texture coordinates of a canonical point (front of the face gets most of the texture). */
export function faceU(tc: number): number {
  const a = Math.abs(tc);
  const u = a <= 1 ? a * 0.32 : 0.32 + ((a - 1) / (Math.PI - 1)) * 0.18;
  return 0.5 + Math.sign(tc) * u;
}
export function faceV(yc: number): number {
  return (yc + 0.03) / 0.3;
}
/** Inverse of faceU / faceV, for painting the texture. */
export function faceTheta(u: number): number {
  const a = Math.abs(u - 0.5);
  const t = a <= 0.32 ? a / 0.32 : 1 + ((a - 0.32) / 0.18) * (Math.PI - 1);
  return Math.sign(u - 0.5) * t;
}
export function faceY(v: number): number {
  return v * 0.3 - 0.03;
}

/** Height of the lowest canonical face row (below it the mesh rings go by polar angle). */
export const FACE_ROW_LOW = CANON.chinY - 0.022;
export const FACE_ROW_HIGH = 0.215;

let canonRows: { y: number; us: number[] }[] | null = null;

/** Canonical face rows and their samples: dense where faces have detail, sparse elsewhere. */
export function faceRows(): { y: number; us: number[] }[] {
  if (canonRows) return canonRows;
  const c = CANON;
  const band = (v: number, lo: number, hi: number, ramp: number) => smoothstep(lo - ramp, lo, v) * smoothstep(hi + ramp, hi, v);
  const rowStep = (y: number) => {
    let st = 0.0036;
    const fine = (step: number, lo: number, hi: number, ramp: number) => {
      st = Math.min(st, lerp(st, step, band(y, lo, hi, ramp)));
    };
    fine(0.0022, c.eyeY + 0.014, c.browY + 0.012, 0.006);
    fine(0.00105, c.eyeY - 0.0125, c.eyeY + 0.0145, 0.004);
    fine(0.0013, c.noseBaseY - 0.002, c.noseTipY + 0.005, 0.003);
    fine(0.001, c.mouthY - c.lipLo - 0.004, c.mouthY + c.lipUp + 0.002, 0.003);
    fine(0.00065, c.mouthY - 0.0022, c.mouthY + 0.0022, 0.0015);
    fine(0.0026, c.chinY - 0.012, c.mouthY, 0.004);
    return st;
  };
  // Column spacing (radians of canonical angle) for a row at height y.
  const eyeTh = Math.atan2(c.eyeX, 0.09);
  const eyeHalf = Math.atan2(c.eyeR * 1.75, 0.09);
  const colStep = (t: number, y: number) => {
    const a = Math.abs(t);
    let st = a < 0.85 ? lerp(0.042, 0.075, smoothstep(0.5, 0.85, a)) : a < 1.6 ? 0.14 : 0.34;
    const fine = (step: number, w: number) => {
      st = Math.min(st, lerp(st, step, w));
    };
    // Round the eyes.
    fine(0.0118, band(y, c.eyeY - 0.0125, c.eyeY + 0.016, 0.006) * band(a, eyeTh - eyeHalf, eyeTh + eyeHalf, 0.06));
    // The nose, from the bridge to the wings, and the philtrum below it.
    fine(0.0105, band(y, c.noseBaseY - 0.003, c.noseTipY + 0.008, 0.004) * band(a, 0, Math.atan2(c.alaX + 0.008, 0.11), 0.05));
    fine(0.016, band(y, c.noseTipY + 0.006, c.eyeY + 0.006, 0.006) * band(a, 0, 0.09, 0.04));
    // The lips and their corners.
    fine(0.0098, band(y, c.mouthY - c.lipLo - 0.005, c.noseBaseY - 0.001, 0.003) * band(a, 0, Math.atan2(c.mouthW * 1.25, 0.1), 0.06));
    // Brow and chin, moderately.
    fine(0.026, band(y, c.chinY - 0.015, c.browY + 0.015, 0.01) * band(a, 0, 0.62, 0.1));
    return st;
  };
  const rows: { y: number; us: number[] }[] = [];
  // Past the features, every row has the same columns (the step widening smoothly toward the back
  // of the head), so the rows' samples line up down the cheeks, jaw and sides. Rows whose columns
  // fell at different angles there made faint lines across the face where they met.
  const OUTER = 0.75;
  const outer: number[] = [];
  for (let t = OUTER; ; ) {
    const st = lerp(lerp(0.03, 0.075, smoothstep(OUTER, 1.05, t)), 0.3, smoothstep(1.2, 2.4, t));
    if (t + st * 1.5 >= Math.PI) break;
    t += st;
    outer.push(t);
  }
  outer.push(Math.PI);
  const columns = (y: number) => {
    const half: number[] = [0];
    let t = 0;
    for (;;) {
      const st = colStep(t, y);
      // (Never a sliver of a column just short of the shared ones.)
      if (t + st > OUTER - Math.max(0.022, st * 0.6)) break;
      t += st;
      half.push(t);
    }
    half.push(OUTER, ...outer);
    return [...half.slice(1).reverse().map((v) => -v), ...half];
  };
  let y = FACE_ROW_HIGH;
  while (y > FACE_ROW_LOW) {
    rows.push({ y, us: columns(y) });
    y -= rowStep(y);
  }
  rows.push({ y: FACE_ROW_LOW, us: columns(FACE_ROW_LOW) });
  canonRows = rows;
  return rows;
}

import * as THREE from 'three';
import { ridingCoatPositions, ridingCoatIndices, courtDressPositions, courtDressIndices } from './courtClothesMeshes.ts';
import { anatomyRelief, anatomyShade, deltoid } from './kyndAnatomy.ts';
import type { FullAppearance, OutfitStyle } from '../sim/entities/appearance.ts';
import {
  around,
  appendAuthoredMesh,
  capsuleR,
  col,
  ellipsoid,
  grid,
  KIND,
  lerp,
  mixCol,
  Path,
  Profile,
  range,
  shade,
  smoothstep,
  superR,
  tube,
  withSeams,
  type Paint,
  type Weights,
} from './kyndGeometry.ts';
import {
  armWeights,
  BI,
  FOREARM,
  forearmFlat,
  footWeights,
  KNEE_Y,
  LEG,
  PELVIS_Y,
  wristShare,
  buildForearms,
  buildLegs,
  EL_Y,
  HEAD_Y,
  hp,
  SH_Y,
  trunkWeights,
  neckRadius,
  neckZ,
  WRIST_Y,
  type BodyBuckets,
  type Footwear,
  type Head,
  type Measure,
  type Palette,
} from './kyndBody.ts';

/*
 * Period costume, built as layered shells over the body: a torso shell and a skirt shell per
 * garment, sleeves on the arms, then everything that sits on top — chemise collars, laced bodices,
 * aprons, tabards with a heraldic charge, belts with pouches and scabbards, embroidered bands,
 * necklaces and cloaks. Colours follow the appearance contract:
 *   tunic  = main garment · trim = edging, embroidery, laces · legs = hose (or the under-layer)
 *   accent = the third colour (apron, girdle, sash, hood, heraldic charge, cloak lining)
 */

// --- shells ------------------------------------------------------------------------------------

interface Key {
  y: number;
  rx: number;
  zf: number;
  zb: number;
  e?: number;
}

/** A garment surface around the body: radii by height, with folds that deepen toward the hem. */
export class Shell {
  private rx: Profile;
  private zf: Profile;
  private zb: Profile;
  private e: Profile;
  readonly top: number;
  readonly bottom: number;
  readonly keyHeights: number[];
  private folds: { n: number; amp: Profile; phase: number } | null;
  private train: number;
  /** Keep the centre front smooth (for a front panel or embroidered band). */
  flatFront = false;

  constructor(keys: Key[], folds: { n: number; amp: Profile; phase: number } | null = null, train = 0) {
    this.folds = folds;
    this.train = train;
    this.rx = new Profile(keys.map((k) => [k.y, k.rx]));
    this.zf = new Profile(keys.map((k) => [k.y, k.zf]));
    this.zb = new Profile(keys.map((k) => [k.y, k.zb]));
    this.e = new Profile(keys.map((k) => [k.y, k.e ?? 2.1]));
    this.top = Math.max(...keys.map((k) => k.y));
    this.bottom = Math.min(...keys.map((k) => k.y));
    this.keyHeights = keys.map(k => k.y);
  }

  foldAt(theta: number, y: number): number {
    if (!this.folds) return 0;
    let a = this.folds.amp.at(y);
    if (a <= 0) return 0;
    if (this.flatFront) a *= smoothstep(0.1, 0.4, Math.abs(Math.atan2(Math.sin(theta), Math.cos(theta))));
    const phase = theta * this.folds.n + this.folds.phase + y * 1.3;
    // Broad hanging folds with smaller compression creases. Uneven spacing avoids the
    // corrugated-tube silhouette while keeping cloth attached to the existing skinning.
    const gathered = phase + Math.sin(theta * 3 + this.folds.phase) * 0.22;
    return a * (Math.sin(gathered) * 0.82 + Math.sin(gathered * 2 + y * 2.4) * 0.14
      + Math.sin(gathered * 3 - y * 1.7) * 0.04);
  }

  at(theta: number, y: number, off: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(theta);
    const rz = lerp(this.zb.at(y), this.zf.at(y), smoothstep(-0.35, 0.35, c));
    const rx = this.rx.at(y);
    const [x, z] = superR(theta, rx, rz, this.e.at(y));
    const f = 1 + this.foldAt(theta, y);
    // Outward direction: the ellipse normal, flattened to the horizontal.
    let nx = x / (rx * rx);
    let nz = z / (rz * rz);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    let zz = z * f + nz * off;
    let yy = y;
    if (this.train > 0 && c < 0) {
      const k = Math.pow(-c, 2) * smoothstep(0.45, 0.02, y);
      zz -= this.train * k;
      yy -= 0.015 * k;
    }
    return out.set(x * f + nx * off, yy, zz);
  }
}

/** Torso measurements (neck to hips) for a body, with `ease` extra room for the garment. */
function torsoKeys(m: Measure, ease: number, loose = 0): Key[] {
  const w = m.w;
  const e = ease + loose;
  if (m.female) {
    const b = m.mature;
    return [
      { y: 0.82, rx: (0.17 + 0.02 * b) * w + e, zf: 0.125 * w + e, zb: (0.13 + 0.02 * b) * w + e },
      { y: 0.94, rx: (0.16 + 0.016 * b) * w + e, zf: 0.118 * w + e, zb: (0.125 + 0.018 * b) * w + e },
      { y: 1.06, rx: (0.142 - 0.012 * b) * w + e, zf: 0.1 * w + e, zb: 0.098 * w + e },
      { y: 1.16, rx: 0.144 * w + e, zf: (0.108 + 0.004 * b) * w + e, zb: 0.1 * w + e },
      { y: 1.27, rx: (0.15 + 0.008 * b) * w + e, zf: (0.11 + 0.032 * b) * w + e, zb: 0.102 * w + e, e: 2.2 },
      { y: 1.36, rx: 0.168 * w + e, zf: (0.108 + 0.016 * b) * w + e, zb: 0.1 * w + e, e: 2.3 },
      { y: 1.43, rx: 0.19 * w + e, zf: 0.094 * w + e, zb: 0.094 * w + e, e: 2.7 },
      { y: 1.47, rx: 0.175 * w + e, zf: 0.086 * w + e, zb: 0.088 * w + e, e: 2.7 },
      { y: 1.5, rx: 0.128 + e, zf: 0.074 + e, zb: 0.076 + e, e: 2.3 },
      { y: 1.525, rx: 0.088 + e, zf: 0.062 + e, zb: 0.066 + e },
      { y: 1.548, rx: 0.058 + e * 0.5, zf: 0.054 + e * 0.5, zb: 0.058 + e * 0.5 },
    ];
  }
  return [
    { y: 0.82, rx: 0.172 * w + e, zf: 0.128 * w + e, zb: 0.132 * w + e },
    { y: 0.94, rx: 0.166 * w + e, zf: 0.12 * w + e, zb: 0.126 * w + e },
    { y: 1.05, rx: 0.158 * w + e, zf: 0.118 * w + e + loose, zb: 0.114 * w + e },
    { y: 1.18, rx: 0.166 * w + e, zf: 0.128 * w + e, zb: 0.116 * w + e },
    { y: 1.3, rx: 0.176 * w + e, zf: 0.134 * w + e, zb: 0.118 * w + e, e: 2.3 },
    { y: 1.38, rx: 0.19 * w + e, zf: 0.126 * w + e, zb: 0.116 * w + e, e: 2.5 },
    { y: 1.44, rx: 0.205 * w + e, zf: 0.11 * w + e, zb: 0.106 * w + e, e: 2.9 },
    { y: 1.48, rx: 0.188 * w + e, zf: 0.097 * w + e, zb: 0.097 * w + e, e: 2.9 },
    { y: 1.51, rx: 0.14 + e, zf: 0.082 + e, zb: 0.084 + e, e: 2.4 },
    { y: 1.535, rx: 0.096 + e, zf: 0.07 + e, zb: 0.074 + e },
    { y: 1.56, rx: 0.064 + e * 0.5, zf: 0.06 + e * 0.5, zb: 0.064 + e * 0.5 },
  ];
}

// --- context -----------------------------------------------------------------------------

export interface Dress {
  B: BodyBuckets;
  m: Measure;
  C: Palette;
  look: FullAppearance;
  head: Head;
  /** Hair thickness over the crown. */
  crown: number;
  noble: boolean;
  fine: boolean;
}

const V = new THREE.Vector3();

/** Horizontal rows from `a` down to `b`, with extra rows at the given seams. */
function rows(top: number, bottom: number, step: number, seams: number[] = []): number[] {
  const n = Math.max(2, Math.round((top - bottom) / step));
  return withSeams(range(bottom, top, n), seams.filter((s) => s > bottom && s < top));
}

/** Angles around the body with the given crisp seams. */
function cols(n: number, seams: number[] = []): number[] {
  return withSeams(around(n, -Math.PI), seams);
}

/** Row value nudged to its side of a seam (rows listed top to bottom: the first copy is above). */
function sided(list: { y: number; inner?: boolean }[], k: number): number {
  const y = list[k].y;
  if (k + 1 < list.length && list[k + 1].y === y && !list[k + 1].inner === !list[k].inner) return y + 1e-4;
  if (k > 0 && list[k - 1].y === y && !list[k - 1].inner === !list[k].inner) return y - 1e-4;
  return y;
}

interface ShellPaint {
  (theta: number, y: number): Paint;
}

/** Build a garment shell as a closed surface from `top` down to `hem`, with a turned-up hem inside. */
function shellMesh(d: Dress, shell: Shell, top: number, hem: number, o: { n: number; step: number; paint: ShellPaint; lining: THREE.Color; skirt?: boolean; seams?: number[]; colSeams?: number[]; hemDepth?: number; off?: number; bellyOff?: boolean }): void {
  const hemDepth = o.hemDepth ?? 0.05;
  // Preserve the shoulder/neck profile knots. A coarse chord through this tight
  // curve can protrude through the separately sampled linen collar and trim.
  const profileRows = shell.keyHeights.filter(y => y > hem && y < top);
  const neckRows = top > 1.48 ? range(Math.max(hem, 1.48), top, Math.max(2, Math.ceil((top - Math.max(hem, 1.48)) / 0.006))) : [];
  const ys = withSeams([...new Set([...rows(top, hem, o.step), ...profileRows, ...neckRows])].sort((a, b) => a - b), (o.seams ?? []).filter(y => y > hem && y < top));
  // Rows are listed bottom→top by `rows`; walk top→bottom, then back up inside the hem.
  const outer = [...ys].reverse();
  const vs = [...outer.map((y) => ({ y, inner: false })), { y: hem - 0.0001, inner: true }, { y: hem + hemDepth, inner: true }];
  const off = o.off ?? 0;
  grid(d.B.garment, {
    us: cols(o.n, o.colSeams),
    vs: vs.map((_v, i) => i),
    wrapU: true,
    at: (theta, i, out) => {
      const r = vs[Math.round(i)];
      if (!r.inner) return shell.at(theta, r.y, off, out);
      return shell.at(theta, r.y, off - 0.007, out);
    },
    vKey: (i) => {
      const r = vs[Math.round(i)];
      return r.inner ? -1000 - Math.round(i) : r.y;
    },
    paint: (theta, i) => {
      const r = vs[Math.round(i)];
      if (r.inner) return { c: o.lining, kind: KIND.linen };
      const p = o.paint(theta, sided(vs, Math.round(i)));
      // Shade the valleys of the folds (cheap ambient occlusion).
      const f = shell.foldAt(theta, r.y);
      if (f !== 0) p.c = shade(p.c, 1 + f * 1.6);
      return p;
    },
    weights: (p) => trunkWeights(p, d.m, { skirt: o.skirt, belly: o.bellyOff ? false : true }),
    uv: (theta, i) => [(theta / (Math.PI * 2)) * 8, vs[Math.round(i)].y * 4],
  });
}

/**
 * A raised strip lying on a shell (embroidered bands, plackets, apron-strings): `u` in [-1, 1]
 * across, `y` from y0 to y1, `halfW` its half width in metres at the front (θ = 0) or at `theta0`.
 */
function strip(d: Dress, shell: Shell, o: { theta0: number; halfW: number | ((y: number) => number); y0: number; y1: number; lift: number; paint: Paint; step?: number; weights?: (p: THREE.Vector3) => Weights; uvScale?: number }): void {
  const ys = rows(o.y1, o.y0, o.step ?? 0.04);
  const hw = typeof o.halfW === 'number' ? () => o.halfW as number : o.halfW;
  // Across: the edges drop to the surface so the strip reads as a raised band with a clean edge.
  const us = [-1, -1, -0.5, 0, 0.5, 1, 1];
  grid(d.B.garment, {
    us: us.map((_u, i) => i),
    vs: ys,
    flip: true,
    at: (i, y, out) => {
      const u = us[Math.round(i)];
      const edge = Math.round(i) === 0 || Math.round(i) === us.length - 1;
      // Angle for the strip's width at this height (on the shell at radius r).
      shell.at(o.theta0, y, 0, V);
      const r = Math.hypot(V.x, V.z) || 0.1;
      const theta = o.theta0 + (u * hw(y)) / r;
      return shell.at(theta, y, edge ? 0.0005 : o.lift, out);
    },
    paint: () => o.paint,
    weights: (p) => (o.weights ? o.weights(p) : trunkWeights(p, d.m, { skirt: p.y < 0.9 })),
    uv: (i, y) => [((y - o.y0) / (o.uvScale ?? 0.06)), (us[Math.round(i)] + 1) / 2],
  });
}

/** A band around a shell at heights y0..y1 (hem bands, girdles), raised by `lift`. */
function ring(d: Dress, shell: Shell, o: { y0: number; y1: number; lift: number; paint: Paint; n?: number; weights?: (p: THREE.Vector3) => Weights; bulge?: number; uvRepeat?: number; followFolds?: boolean }): void {
  const n = o.n ?? 40;
  const vs = [o.y0, o.y0, ...range(o.y0, o.y1, Math.max(2, Math.ceil((o.y1 - o.y0) / 0.006))).slice(1, -1), o.y1, o.y1];
  grid(d.B.garment, {
    us: around(n, -Math.PI),
    vs: vs.map((_v, i) => i),
    wrapU: true,
    flip: true,
    at: (theta, i, out) => {
      const k = Math.round(i);
      const y = vs[k];
      const edge = k === 0 || k === vs.length - 1;
      const t = (y - o.y0) / (o.y1 - o.y0);
      const lift = edge ? Math.min(o.lift, 0.0015) : o.lift + (o.bulge ?? 0) * Math.sin(t * Math.PI);
      return shell.at(theta, y, lift, out);
    },
    paint: () => o.paint,
    weights: (p) => (o.weights ? o.weights(p) : trunkWeights(p, d.m, { skirt: p.y < 0.9 })),
    uv: (theta, i) => [((theta + Math.PI) / (Math.PI * 2)) * (o.uvRepeat ?? 10), (vs[Math.round(i)] - o.y0) / (o.y1 - o.y0)],
  });
}

// --- sleeves ------------------------------------------------------------------------------

type SleeveType = 'fitted' | 'rolled' | 'puff' | 'slashed' | 'bell' | 'wide';

interface SleeveSpec {
  type: SleeveType;
  c: THREE.Color;
  kind: number;
  /** Cuff band colour (null for none). */
  cuff: THREE.Color | null;
  cuffKind?: number;
  /** Slash inserts (slashed) or lining (bell, wide). */
  c2?: THREE.Color;
  /** Upper-arm colour when it differs (slashed puffs over a fitted forearm). */
  upper?: THREE.Color;
  upperKind?: number;
}

const ARM = new Profile([
  [WRIST_Y - 0.01, 0.03],
  [0.95, 0.034],
  [1.05, 0.042],
  [EL_Y, 0.045],
  [1.25, 0.05],
  [1.35, 0.056],
  [SH_Y, 0.062],
]);

function sleeve(d: Dress, s: 1 | -1, sp: SleeveSpec): void {
  const w = d.m.w;
  const x0 = s * d.m.shX;
  const top = SH_Y + 0.036;
  const ease = 0.007;
  let end = WRIST_Y + 0.012;
  if (sp.type === 'rolled') end = EL_Y - 0.06;
  if (sp.type === 'puff') end = EL_Y - 0.03;
  if (sp.type === 'bell') end = 0.88;
  if (sp.type === 'wide') end = 0.9;
  const slashes = 7;
  const radius = (theta: number, y: number): number => {
    if (y > SH_Y) {
      // Dome over the shoulder.
      const k = Math.min(1, (y - SH_Y) / (top - SH_Y));
      return (ARM.at(SH_Y) * w + ease + (sp.type === 'slashed' || sp.type === 'puff' ? 0.012 : 0)) * Math.sqrt(Math.max(0, 1 - k * k));
    }
    let r = ARM.at(y) * w + ease;
    if (sp.type === 'puff') {
      const k = smoothstep(SH_Y, EL_Y - 0.03, y);
      r += 0.022 * Math.sin(Math.min(1, k * 1.08) * Math.PI * 0.95 + 0.15) + 0.004 * Math.sin(theta * 9);
    }
    if (sp.type === 'slashed' && y > EL_Y + 0.02) {
      const k = smoothstep(SH_Y + 0.01, EL_Y + 0.03, y);
      const puff = Math.sin(k * Math.PI) * 0.02 + 0.01;
      const slash = Math.cos(theta * slashes) > 0.45 ? -0.012 : 0.004 * Math.cos(theta * slashes * 2);
      r += puff + (k > 0.08 && k < 0.92 ? slash * Math.sin(k * Math.PI) : 0);
    }
    if (sp.type === 'rolled' && y < EL_Y + 0.02) r += 0.008;
    if (sp.type === 'bell' && y < EL_Y) r += Math.pow(smoothstep(EL_Y, end, y), 1.6) * 0.07;
    if (sp.type === 'wide') r += Math.pow(smoothstep(SH_Y, end, y), 1.4) * 0.05;
    return r;
  };
  // The arm hangs a little away from the body below the shoulder.
  const cx = (y: number) => x0 + s * smoothstep(SH_Y, EL_Y, y) * 0.008;
  const seams: number[] = [];
  const cuffH = 0.035;
  if (sp.cuff && (sp.type === 'fitted' || sp.type === 'slashed')) seams.push(end + cuffH);
  if (sp.type === 'slashed') seams.push(EL_Y + 0.02);
  const base = [...range(SH_Y - 0.02, top, 4), ...range(EL_Y + 0.05, SH_Y - 0.02, 4), ...range(EL_Y - 0.05, EL_Y + 0.05, 4), ...range(end, EL_Y - 0.05, Math.max(2, Math.round((EL_Y - 0.05 - end) / 0.05)))];
  const uniq = [...new Set(base.map((y) => Math.round(y * 1e5) / 1e5))].filter((y) => y >= end && y <= top).sort((a, b) => a - b);
  const ys = withSeams(uniq, seams.filter((y) => y > end && y < top));
  const outer = [...ys].reverse();
  const hasLining = sp.type === 'bell' || sp.type === 'wide';
  const vs = [...outer.map((y) => ({ y, inner: false })), { y: end - 0.0001, inner: true }, { y: end + (hasLining ? 0.12 : 0.02), inner: true }];
  const ang = withSeams(around(sp.type === 'slashed' ? 21 : sp.type === 'puff' ? 16 : 14, -Math.PI), []);
  grid(d.B.garment, {
    us: ang,
    vs: vs.map((_v, i) => i),
    wrapU: true,
    at: (theta, i, out) => {
      const r = vs[Math.round(i)];
      const rr = r.inner ? radius(theta, Math.max(r.y, end + 0.005)) - 0.006 : radius(theta, r.y);
      // Bell and wide sleeves hang: the opening swings back a little.
      const back = hasLining && r.y < EL_Y ? -Math.pow(smoothstep(EL_Y, end, r.y), 2) * 0.03 : 0;
      return out.set(cx(r.y) + Math.sin(theta) * rr, r.y, Math.cos(theta) * rr * 1.04 + back);
    },
    vKey: (i) => {
      const r = vs[Math.round(i)];
      return r.inner ? -1000 - Math.round(i) : r.y;
    },
    paint: (theta, i) => {
      const k0 = Math.round(i);
      const r = { ...vs[k0], y: sided(vs, k0) };
      if (r.inner) return { c: sp.c2 ?? shade(sp.c, 0.7), kind: KIND.linen };
      if (sp.cuff && (sp.type === 'fitted' || sp.type === 'slashed') && r.y < end + cuffH) {
        return sp.cuffKind === KIND.embroidery ? { c: sp.cuff, kind: KIND.embroidery, c2: col('#f0d27a') } : { c: sp.cuff, kind: sp.cuffKind ?? sp.kind };
      }
      if (sp.type === 'slashed' && r.y > EL_Y + 0.02 && r.y < SH_Y + 0.02) {
        const inSlash = Math.cos(theta * slashes) > 0.45;
        if (inSlash) return { c: sp.c2 ?? d.C.linen, kind: KIND.linen };
        return { c: sp.upper ?? sp.c, kind: sp.upperKind ?? sp.kind };
      }
      if (sp.type === 'puff') return { c: shade(sp.c, 0.94 + 0.06 * Math.sin(theta * 9)), kind: sp.kind };
      return { c: sp.upper && r.y > EL_Y + 0.02 ? sp.upper : sp.c, kind: sp.kind };
    },
    weights: (p) => {
      // Stitch the inner sleeve cap to the torso; the outer cap follows the arm.
      const anchor = smoothstep(SH_Y - 0.035, SH_Y + 0.025, p.y)
        * (1 - smoothstep(d.m.shX - 0.025, d.m.shX + 0.025, Math.abs(p.x)));
      const arm = armWeights(p, s);
      return [BI.spine, anchor, ...arm.map((value, i) => i % 2 ? value * (1 - anchor) : value)];
    },
    uv: (theta, i) => [((theta + Math.PI) / (Math.PI * 2)) * 3, vs[Math.round(i)].y * 6],
  });
  if (sp.type === 'rolled' || sp.type === 'puff') {
    // A rolled cuff or a gathered band where the sleeve ends.
    const y0 = end;
    const band = sp.type === 'rolled' ? 0.028 : 0.014;
    grid(d.B.garment, {
      us: around(16),
      vs: range(0, Math.PI * 2, 8),
      wrapU: true,
      flip: true,
      at: (theta, a, out) => {
        const rr = radius(theta, y0 + 0.02) + (sp.type === 'rolled' ? 0.002 : -0.012) + Math.cos(a) * (band * 0.35);
        const y = y0 + band * 0.5 + Math.sin(a) * band * 0.5;
        return out.set(cx(y) + Math.sin(theta) * rr, y, Math.cos(theta) * rr * 1.04);
      },
      paint: () => ({ c: shade(sp.c, 0.92), kind: sp.kind }),
      weights: (p) => armWeights(p, s),
    });
  }
}

// --- accessories ----------------------------------------------------------------------------

function belt(d: Dress, shell: Shell, y: number, o: { h: number; c: THREE.Color; kind: number; buckle: 'frame' | 'round' | 'plaques' | 'knot'; pouch: boolean; hang?: number; scabbard?: boolean; lift?: number }): void {
  const lift = o.lift ?? 0.004;
  const beltW = (p: THREE.Vector3) => trunkWeights(p, d.m);
  ring(d, shell, { y0: y - o.h / 2, y1: y + o.h / 2, lift, paint: { c: o.c, kind: o.kind }, n: 30, bulge: 0.003, weights: beltW });
  const front = shell.at(0, y, lift + 0.006, new THREE.Vector3());
  const gold = d.C.gold;
  const metal = (c: THREE.Vector3, r: [number, number, number], cc = gold, rot?: THREE.Euler, seg = 10, rings = 6) => ellipsoid(d.B.metal, c, r, () => ({ c: cc }), beltW, seg, rings, rot);
  if (o.buckle === 'frame') {
    const pts: THREE.Vector3[] = [];
    const bw = 0.022;
    const bh = o.h * 0.75;
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      pts.push(new THREE.Vector3(front.x + Math.cos(a) * bw, y + Math.sin(a) * bh, front.z + 0.002));
    }
    tube(d.B.metal, new Path(pts, 32), { radius: () => [0.004, 0.004], paint: () => ({ c: col('#c8b07a') }), weights: beltW, seg: 6, steps: 24 });
  } else if (o.buckle === 'round') {
    // A round jewelled clasp.
    metal(new THREE.Vector3(front.x, y, front.z + 0.002), [0.03, 0.03, 0.009]);
    ellipsoid(d.B.metal, new THREE.Vector3(front.x, y, front.z + 0.01), [0.012, 0.012, 0.007], () => ({ c: col('#1f7a4a') }), beltW, 10, 8);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      metal(new THREE.Vector3(front.x + Math.cos(a) * 0.021, y + Math.sin(a) * 0.021, front.z + 0.009), [0.004, 0.004, 0.003], col('#f3e6b0'), undefined, 6, 4);
    }
  } else if (o.buckle === 'plaques') {
    for (let i = -4; i <= 4; i++) {
      const th = i * 0.3;
      const p = shell.at(th, y, lift + 0.004, new THREE.Vector3());
      ellipsoid(d.B.metal, p, [0.012, o.h * 0.42, 0.004], () => ({ c: gold }), beltW, 8, 5, new THREE.Euler(0, th, 0));
    }
  } else {
    // A knot with hanging ends (rope or sash).
    const k = shell.at(0.35, y, lift + 0.01, new THREE.Vector3());
    ellipsoid(d.B.garment, k, [0.016, 0.014, 0.012], () => ({ c: o.c, kind: o.kind }), beltW, 10, 7);
    for (const dx of [-0.008, 0.01]) {
      const pts = [k.clone(), new THREE.Vector3(k.x + dx, k.y - 0.1, k.z + 0.012), new THREE.Vector3(k.x + dx * 1.4, k.y - o.hang!, k.z + 0.016)];
      tube(d.B.garment, new Path(pts, 12), { radius: (t) => [0.007 * capsuleR(t, 0, 0.1), 0.007 * capsuleR(t, 0, 0.1)], paint: () => ({ c: o.c, kind: o.kind }), weights: (p) => trunkWeights(p, d.m, { skirt: true }), seg: 7, steps: 8 });
    }
  }
  if (o.hang && o.buckle !== 'knot') {
    // The long belt end hanging from the buckle.
    const p0 = shell.at(0.08, y, lift + 0.004, new THREE.Vector3());
    const pts = [p0, shell.at(0.1, y - 0.1, lift + 0.01, new THREE.Vector3()), shell.at(0.11, y - o.hang, lift + 0.012, new THREE.Vector3())];
    tube(d.B.garment, new Path(pts, 16, new THREE.Vector3(0, 0, 1)), { radius: (t) => [0.0025, 0.012 * (t > 0.95 ? 0.8 : 1)], paint: () => ({ c: o.c, kind: o.kind }), weights: (p) => trunkWeights(p, d.m, { skirt: true }), seg: 6, steps: 10 });
    metal(pts[2].clone().add(new THREE.Vector3(0, -0.006, 0.003)), [0.009, 0.012, 0.004]);
  }
  if (o.pouch) {
    // A leather purse with a flap, hanging at the right hip.
    const th = -0.95;
    const p = shell.at(th, y - 0.06, lift + 0.02, new THREE.Vector3());
    const pw = (q: THREE.Vector3) => trunkWeights(q, d.m, { skirt: true });
    ellipsoid(d.B.garment, p, [0.042, 0.05, 0.022], (_q, n) => ({ c: shade(d.C.leather, 0.9 + n.y * 0.1), kind: KIND.leather }), pw, 12, 8, new THREE.Euler(0, th, 0));
    ellipsoid(d.B.garment, p.clone().add(new THREE.Vector3(0, 0.03, 0)).addScaledVector(new THREE.Vector3(Math.sin(th), 0, Math.cos(th)), 0.006), [0.045, 0.022, 0.022], () => ({ c: shade(d.C.leather, 0.75), kind: KIND.leather }), pw, 10, 6, new THREE.Euler(0, th, 0));
    metal(p.clone().add(new THREE.Vector3(0, 0.012, 0)).addScaledVector(new THREE.Vector3(Math.sin(th), 0, Math.cos(th)), 0.025), [0.006, 0.006, 0.004]);
  }
  if (o.scabbard) {
    // A sword at the left hip: hilt forward, scabbard angled back.
    const th = 1.35;
    const top = shell.at(th, y - 0.01, lift + 0.025, new THREE.Vector3());
    const dir = new THREE.Vector3(0.06, -1, -0.45).normalize();
    const tip = top.clone().addScaledVector(dir, 0.78);
    const sw = (p: THREE.Vector3) => {
      const t = Math.min(1, Math.max(0, (top.y - p.y) / 0.7));
      return [BI.pelvis, 1 - t * 0.7, BI.skBL, t * 0.7];
    };
    tube(d.B.garment, new Path([top, top.clone().lerp(tip, 0.5), tip], 20, new THREE.Vector3(1, 0, 0)), {
      radius: (t) => [0.009 * (1 - t * 0.3), 0.026 * (1 - t * 0.45) * capsuleR(t, 0.02, 0.06)],
      paint: () => ({ c: col('#2a1c14'), kind: KIND.leather }),
      weights: sw,
      seg: 10,
      steps: 12,
    });
    for (const t of [0.04, 0.3]) {
      const q = top.clone().lerp(tip, t);
      ellipsoid(d.B.metal, q, [0.013, 0.006, 0.03], () => ({ c: gold }), sw, 8, 5, new THREE.Euler(-0.42, 0, 0));
    }
    ellipsoid(d.B.metal, tip.clone().addScaledVector(dir, -0.03), [0.011, 0.035, 0.018], () => ({ c: gold }), sw, 10, 6, new THREE.Euler(-0.42, 0, 0));
    // Hilt: crossguard, grip, pommel.
    const up = dir.clone().negate();
    const guard = top.clone().addScaledVector(up, 0.012);
    ellipsoid(d.B.metal, guard, [0.012, 0.009, 0.075], () => ({ c: col('#b8b4a8') }), sw, 10, 6, new THREE.Euler(-0.42, 0, 0));
    const gripEnd = guard.clone().addScaledVector(up, 0.1);
    tube(d.B.garment, new Path([guard, gripEnd], 6), { radius: () => [0.011, 0.011], paint: () => ({ c: col('#3a2418'), kind: KIND.leather }), weights: sw, seg: 8, steps: 4 });
    ellipsoid(d.B.metal, gripEnd.clone().addScaledVector(up, 0.014), [0.017, 0.017, 0.017], () => ({ c: gold }), sw, 10, 8);
  }
}

function lacing(d: Dress, shell: Shell, y0: number, y1: number, gap: number, c: THREE.Color, lift: number, eyelets: boolean): void {
  const n = Math.max(3, Math.round((y1 - y0) / 0.035));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const y = lerp(y1, y0, i / n);
    shell.at(0, y, 0, V);
    const r = Math.hypot(V.x, V.z);
    const side = i % 2 ? 1 : -1;
    pts.push(shell.at((side * gap) / r, y, lift + 0.003, new THREE.Vector3()));
    if (eyelets) {
      for (const s of [-1, 1]) ellipsoid(d.B.metal, shell.at((s * gap) / r, y, lift + 0.002, new THREE.Vector3()), [0.004, 0.004, 0.002], () => ({ c: col('#c9b27a') }), (p) => trunkWeights(p, d.m), 6, 4);
    }
  }
  tube(d.B.garment, new Path(pts, n * 6), { radius: () => [0.0022, 0.0022], paint: () => ({ c: c, kind: KIND.linen }), weights: (p) => trunkWeights(p, d.m), seg: 5, steps: n * 5 });
  // A little bow at the top.
  const t = pts[0];
  for (const s of [-1, 1]) {
    const lp = [t, new THREE.Vector3(t.x + s * 0.018, t.y + 0.01, t.z + 0.004), new THREE.Vector3(t.x + s * 0.01, t.y - 0.004, t.z + 0.006), t.clone()];
    tube(d.B.garment, new Path(lp, 12), { radius: () => [0.0025, 0.0025], paint: () => ({ c: c, kind: KIND.linen }), weights: (p) => trunkWeights(p, d.m), seg: 5, steps: 8 });
  }
}

function buttons(d: Dress, shell: Shell, y0: number, y1: number, n: number, lift: number): void {
  for (let i = 0; i < n; i++) {
    const y = lerp(y1, y0, i / Math.max(1, n - 1));
    const p = shell.at(0, y, lift + 0.003, new THREE.Vector3());
    ellipsoid(d.B.metal, p, [0.0065, 0.0065, 0.004], () => ({ c: d.C.gold }), (q) => trunkWeights(q, d.m), 8, 6);
  }
}

/** Gold chain with a medallion or a gem pendant. */
function necklace(d: Dress, shell: Shell, pendant: 'medallion' | 'gem'): void {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const th = -Math.PI * 0.95 + (i / 16) * Math.PI * 1.9;
    const front = Math.cos(th);
    const y = lerp(1.515, 1.37, Math.pow(Math.max(0, front), 1.5)) - (front < 0 ? 0 : 0);
    pts.push(shell.at(th, Math.max(y, 1.36), 0.006, new THREE.Vector3()));
  }
  const w = (p: THREE.Vector3) => trunkWeights(p, d.m, { belly: false });
  tube(d.B.metal, new Path(pts, 48), { radius: (t) => {
    const bead = 0.0024 + 0.0012 * Math.abs(Math.sin(t * 160));
    return [bead, bead];
  }, paint: () => ({ c: d.C.gold }), weights: w, seg: 5, steps: 44 });
  const c = shell.at(0, 1.35, 0.012, new THREE.Vector3());
  if (pendant === 'medallion') {
    ellipsoid(d.B.metal, c, [0.026, 0.026, 0.006], (_p, n) => ({ c: shade(d.C.gold, 0.9 + n.z * 0.2) }), w, 14, 6);
    ellipsoid(d.B.metal, c.clone().add(new THREE.Vector3(0, 0, 0.005)), [0.015, 0.015, 0.004], () => ({ c: shade(d.C.gold, 0.75) }), w, 12, 6);
  } else {
    ellipsoid(d.B.metal, c, [0.016, 0.02, 0.006], () => ({ c: d.C.gold }), w, 12, 8);
    ellipsoid(d.B.metal, c.clone().add(new THREE.Vector3(0, 0, 0.005)), [0.011, 0.014, 0.007], () => ({ c: col('#1f8a52') }), w, 12, 8);
  }
}

/** Cloak hanging from the shoulders behind the arms, with a lining and optionally a fur mantle. */
function cloak(d: Dress, c: THREE.Color, lining: THREE.Color, fur: 'none' | 'ermine' | 'brown', kind: number): void {
  const w = d.m.w;
  const sh = d.m.shX + 0.075 * w;
  const hemY = 0.38;
  // Cut full below the waist: it falls clear of a tunic's or gown's flared skirts and of the
  // elbows as the arms swing.
  const keys = new Profile([
    [hemY, sh + 0.16],
    [0.8, sh + 0.1],
    [1.2, sh + 0.05],
    [SH_Y, sh + 0.012],
    [1.5, sh - 0.06],
    [1.545, 0.09],
  ]);
  const depth = new Profile([
    [hemY, 0.33 * w],
    [0.8, 0.26 * w],
    [1.2, 0.18 * w],
    [SH_Y, 0.15 * w],
    [1.5, 0.12],
    [1.545, 0.085],
  ]);
  // Half-width of the opening (angle from the front) by height: closed at the throat, open below.
  const open = (y: number) => lerp(1.7, 0.25, smoothstep(1.36, 1.54, y));
  const ys = rows(1.545, hemY, 0.065);
  const outer = [...ys].reverse();
  const us = range(-1, 1, 16);
  const loop = [...us.map((u) => ({ u, inner: false })), ...[...us].reverse().map((u) => ({ u, inner: true }))];
  const at = (u: number, y: number, inner: boolean, out: THREE.Vector3) => {
    const o = open(y);
    const theta = Math.PI + u * (Math.PI - o);
    const rx = keys.at(y);
    const rz = depth.at(y);
    const k = smoothstep(1.3, hemY, y);
    const fold = 1 + 0.05 * k * Math.sin(u * 14);
    // The lining lies a few millimetres inside the cloth everywhere (a fraction of the radius is
    // too little round the narrow yoke: the two flickered through each other at the shoulders).
    const inset = inner ? 0.007 : 0;
    // The collar dips at the back of the neck, so the hair at the nape lies over it, not through it.
    const nape = Math.max(0, -Math.cos(theta)) ** 2 * smoothstep(1.47, 1.545, y) * 0.045;
    return out.set(Math.sin(theta) * (rx * fold - inset), y - nape, Math.cos(theta) * (rz * fold - inset) - 0.01 - k * 0.04);
  };
  grid(d.B.garment, {
    us: loop.map((_l, i) => i),
    vs: outer,
    wrapU: true,
    at: (i, y, out) => {
      const l = loop[Math.round(i)];
      return at(l.u, y, l.inner, out);
    },
    paint: (i, y) => {
      const l = loop[Math.round(i)];
      if (l.inner) return { c: lining, kind: KIND.linen };
      const k = smoothstep(1.3, hemY, y);
      return { c: shade(c, 1 + 0.12 * k * Math.sin(l.u * 14)), kind };
    },
    // Only the yoke round the neck and over the shoulders stays with the body: the whole fall of
    // the cloak below goes with the cloak's own bone, so it can swing clear of the legs and be
    // thrown back over a chair. The change is spread over a hand's breadth: a sharp one creases the
    // cloth so tightly that its lining shows through.
    weights: (p) => {
      const k = smoothstep(1.53, 1.28, p.y);
      return [BI.spine, 1 - k, BI.cloak, k];
    },
  });
  // Clasps at the throat.
  for (const s of [-1, 1]) ellipsoid(d.B.metal, new THREE.Vector3(s * 0.035, 1.505, 0.075), [0.012, 0.012, 0.005], () => ({ c: d.C.gold }), () => [BI.spine, 1], 10, 6);
  if (fur !== 'none') {
    // A fur mantle over the shoulders: from the throat, down the slope of the shoulders and over
    // the tops of the sleeves, finished with a thick rolled edge.
    const furC = fur === 'ermine' ? col('#f2eee6') : col('#6a4a30');
    const spot = fur === 'ermine' ? col('#141210') : col('#4a3220');
    const reach = d.m.shX + 0.06 * w;
    const mantle = (theta: number, t: number, out: THREE.Vector3) => {
      const side = Math.abs(Math.sin(theta));
      const front = Math.cos(theta);
      const k = Math.pow(Math.min(1, t / 0.62), 0.6);
      const rx = lerp(0.08, reach, k);
      const rz = lerp(0.075, 0.14 * w + 0.025, k) + (front > 0 ? 0.008 : 0);
      const y = 1.558 - t * lerp(0.22, 0.17, side) - Math.max(0, front) * t * 0.04;
      const [x, z] = superR(theta, rx, rz, 2.4);
      return out.set(x, y, z);
    };
    grid(d.B.garment, {
      us: around(30, -Math.PI),
      vs: range(0, 1, 5),
      wrapU: true,
      at: (theta, t, out) => mantle(theta, t, out),
      paint: () => ({ c: furC, kind: KIND.fur, c2: spot }),
      weights: (p) => trunkWeights(p, d.m, { belly: false }),
      uv: (theta, t) => [(theta + Math.PI) * 2.2, t * 1.2],
    });
    const hem: THREE.Vector3[] = [];
    for (let i = 0; i <= 36; i++) hem.push(mantle(-Math.PI + (i / 36) * Math.PI * 2, 1, new THREE.Vector3()));
    hem[36] = hem[0].clone();
    tube(d.B.garment, new Path(hem, 72), {
      radius: () => [0.018, 0.018],
      paint: () => ({ c: furC, kind: KIND.fur, c2: spot }),
      weights: (p) => trunkWeights(p, d.m, { belly: false }),
      seg: 7,
      steps: 36,
      uv: (t, th) => [t * 30, th],
    });
  }
}

/** A standing collar that rises from the neckline and closes round the neck, trimmed at the top. */
function collar(d: Dress, shell: Shell, y0: number, y1: number, body: Paint, edge: Paint): void {
  const trimY = y1 - 0.014;
  const vs = [...range(y0, trimY, 3), trimY, ...range(trimY, y1, 2).slice(1), y1, y1 - 0.02];
  grid(d.B.garment, {
    us: around(28, -Math.PI),
    vs: vs.map((_v, i) => i),
    wrapU: true,
    flip: true,
    at: (theta, i, out) => {
      const k = Math.round(i);
      const y = vs[k];
      const inner = k === vs.length - 1;
      shell.at(theta, y0, 0.004, V);
      const t = smoothstep(y0, y0 + 0.035, y);
      const r0 = Math.hypot(V.x, V.z);
      // Closes round the neck (its own radius, a little room, standing a touch off at the top).
      const r = lerp(r0, neckRadius(d.head.s, y) + 0.003 + (y - y0) * 0.015, t) - (inner ? 0.004 : 0);
      return out.set(Math.sin(theta) * r, y, lerp(Math.cos(theta) * r, Math.cos(theta) * r * 1.02 + neckZ(y), t));
    },
    paint: (_theta, i) => {
      const k = Math.round(i);
      return vs[k] >= trimY && k > 3 ? edge : body;
    },
    weights: (p) => neckWeights(p, y0, y1),
    uv: (theta, i) => [((theta + Math.PI) / (Math.PI * 2)) * 10, Math.min(1, Math.max(0, (vs[Math.round(i)] - trimY) / (y1 - trimY)))],
  });
}

// --- the outfits ----------------------------------------------------------------------------

const EMB = (base: THREE.Color): Paint => ({ c: base, kind: KIND.embroidery, c2: mixCol(base, col('#ffe9a8'), 0.6) });

function skirtShell(d: Dress, joinY: number, hem: number, flare: number, o: { folds: number; amp: number; train?: number; hipsEase?: number; fit?: number; zf?: number }): Shell {
  const t = torsoKeys(d.m, 0.012 + (o.hipsEase ?? 0));
  const tp = new Profile(t.map((k) => [k.y, k.rx]));
  const tzf = new Profile(t.map((k) => [k.y, k.zf]));
  const tzb = new Profile(t.map((k) => [k.y, k.zb]));
  const w = d.m.w;
  const fit = o.fit ?? 0.9; // where the skirt stops following the hips and starts to flare
  const keys: Key[] = [];
  const add = (y: number, rx: number, zf: number, zb: number) => keys.push({ y, rx, zf, zb });
  add(joinY, tp.at(joinY) + 0.004, tzf.at(joinY) + 0.004, tzb.at(joinY) + 0.004);
  if (fit < joinY - 0.05) add(fit, tp.at(fit) + 0.006, tzf.at(fit) + 0.006, tzb.at(fit) + 0.006);
  const hipR = tp.at(Math.min(fit, 0.9)) + 0.006;
  const span = Math.min(fit, joinY) - hem;
  for (const k of [0.3, 0.62, 1]) {
    const y = Math.min(fit, joinY) - span * k;
    const r = lerp(hipR, flare * w, Math.pow(k, 0.85));
    add(y, r, r * (o.zf ?? 0.86), r * 0.9);
  }
  const amp = new Profile([
    [hem - 0.1, o.amp],
    [hem, o.amp],
    [lerp(hem, Math.min(fit, joinY), 0.6), o.amp * 0.4],
    [Math.min(fit, joinY) - 0.02, 0],
    [joinY + 0.1, 0],
  ]);
  return new Shell(keys, { n: o.folds, amp, phase: 0.4 }, o.train ?? 0);
}

function footwearFor(outfit: OutfitStyle, noble: boolean): Footwear {
  switch (outfit) {
    case 'surcoat':
    case 'riding_coat':
      return 'tall_boots';
    case 'doublet':
      return noble ? 'tall_boots' : 'poulaines';
    case 'tunic':
    case 'smock':
      return 'boots';
    case 'gown':
    case 'court_dress':
    case 'cotehardie':
      return 'poulaines';
    default:
      return 'shoes';
  }
}

/**
 * The body under the clothes, for bathing: a smooth skin torso on the same measurements the
 * clothes are cut to (a closed seat between the legs), arms from shoulder cap to wrist, and legs to
 * the ankle. Its own part, hidden until the clothes come off; the blur then covers what it should.
 */
export function buildBareBody(d: Dress): void {
  const { m, C, B } = d;
  const w = m.w;
  // A man's body narrows from the chest to the waist (the clothes' measurements hang straight).
  const keys = torsoKeys(m, 0).map((k) => {
    if (m.female) return k;
    const waist = k.y >= 1.2 ? 1 : k.y >= 1.0 ? 0.9 + 0.1 * smoothstep(1.0, 1.2, k.y) : 0.9 + 0.04 * smoothstep(1.0, 0.82, k.y);
    return { ...k, rx: k.rx * waist, zf: k.zf * (k.y < 1.15 && k.y > 0.9 ? 0.93 : 1) };
  });
  const torso = new Shell([
    { y: 0.73, rx: 0.05 * w, zf: 0.04 * w, zb: 0.05 * w },
    { y: 0.77, rx: 0.12 * w, zf: 0.085 * w, zb: 0.11 * w },
    ...keys,
  ]);
  const skinC = C.skin;
  // Fine enough for the anatomy (kyndAnatomy.ts) carved over the shell: rings about 9 mm apart,
  // closer still over the chest, collarbones and navel; 72 round.
  const ys = [...new Set([...range(0.73, 1.548, 92), ...range(1.0, 1.07, 10), ...range(1.44, 1.52, 10), ...keys.map((k) => k.y)])]
    .sort((a, b) => a - b)
    .filter((y, i, all) => i === 0 || y - all[i - 1] > 0.0025);
  const anat = { w, female: m.female, mature: m.mature };
  const base = new THREE.Vector3();
  const nippleC = mixCol(skinC, col('#8a4a3c'), 0.32);
  grid(B.bare, {
    us: around(96, -Math.PI),
    vs: [...ys].reverse(),
    wrapU: true,
    at: (theta, y, out) => {
      torso.at(theta, y, 0, base);
      // The shoulder's cap swells out over the top of the arm (the arm's own top tucks in under it).
      const dl = deltoid(base, Math.sin(theta), m.shX) * Math.exp(-(((y - 1.4) / 0.058) ** 2)) * 0.034 * w;
      return torso.at(theta, y, anatomyRelief(base, Math.cos(theta), anat) + dl, out);
    },
    // The creases a shade darker, the navel's hollow, a man's nipples.
    paint: (theta, y) => {
      torso.at(theta, y, 0, base);
      const { k, nipple } = anatomyShade(base, Math.cos(theta), anat);
      return { c: shade(mixCol(skinC, nippleC, nipple), k), kind: KIND.linen };
    },
    // The deltoid goes with the arm: lift an arm and the shoulder's cap lifts with it.
    weights: (p) => {
      const tw = trunkWeights(p, m, {});
      // Only the skin right over the top of the arm goes with it (what lies behind the joint, over
      // the shoulder blade, stays with the back, or a raised arm would lift it into a wing).
      // And only from the joint up: lower, by the armpit, it stays with the ribs (the arm's ball end
      // turns in place inside it), or it folds under a raised arm.
      const overArm = smoothstep(0.075 * w, 0.035 * w, Math.hypot(Math.abs(p.x) - m.shX, p.z)) * smoothstep(SH_Y - 0.06, SH_Y - 0.01, p.y);
      const dl = deltoid(p, Math.sign(p.x) * Math.min(1, Math.abs(p.x) / (Math.hypot(p.x, p.z) || 1)), m.shX) * overArm * 0.75;
      // Below the waist the skin over each hip goes partly with that thigh (more in front, less over
      // the seat), so a leg swung forward, sitting or kneeling, stays joined to the body instead of
      // its top edge showing through.
      const front = p.z / (Math.hypot(p.x, p.z) || 1);
      const hp = smoothstep(0.95, 0.8, p.y) * smoothstep(0.005, 0.05, Math.abs(p.x)) * lerp(0.35, 0.75, smoothstep(-0.6, 0.6, front));
      if (dl <= 0.01 && hp <= 0.01) return tw;
      const keep = 1 - dl - hp;
      const out = tw.map((v, i) => (i % 2 ? v * keep : v));
      if (dl > 0.01) out.push(p.x > 0 ? BI.shL : BI.shR, dl);
      if (hp > 0.01) out.push(p.x > 0 ? BI.hipL : BI.hipR, hp);
      return out;
    },
    uv: () => [0.02, 0.5],
  });
  for (const s of [1, -1] as const) {
    // The arm: shoulder cap to wrist (its end tucked inside the hand).
    const x0 = s * m.shX;
    // A ball joint: the arm narrows into a small dome centred on the shoulder's pivot, so however the
    // arm turns, its end turns in place inside the torso's shoulder cap and never swings out.
    const R0 = 0.03 * w;
    const top = SH_Y + R0 * 0.98;
    const tuck = (y: number) => smoothstep(SH_Y - 0.07, SH_Y, y);
    const radius = (y: number) => {
      if (y > SH_Y) return Math.sqrt(Math.max(0, R0 * R0 - (y - SH_Y) ** 2));
      // The deltoid rounds the top of the arm into the shoulder.
      const upper = ARM.at(y) * w * lerp(0.95, 0.9, smoothstep(SH_Y - 0.1, SH_Y, y)) + 0.005 * w * Math.exp(-(((y - (SH_Y - 0.06)) / 0.05) ** 2));
      const lower = FOREARM.at(Math.max(WRIST_Y, y)) * m.w * 0.99 * (1 - 0.4 * smoothstep(WRIST_Y - 0.002, WRIST_Y - 0.02, y));
      return lerp(lerp(lower, upper, smoothstep(EL_Y - 0.04, EL_Y + 0.06, y)), R0, tuck(y));
    };
    // Hanging a little out from the body, but centred over the hand again at the wrist.
    const cx = (y: number) => x0 + s * smoothstep(SH_Y, EL_Y, y) * smoothstep(WRIST_Y + 0.07, EL_Y - 0.04, y) * 0.008;
    // Rings close together round the elbow (a centimetre apart), so it bends in a curve.
    const armYs = [...new Set([WRIST_Y - 0.02, WRIST_Y - 0.008, WRIST_Y, ...range(WRIST_Y + 0.02, SH_Y - 0.02, 12), ...range(EL_Y - 0.08, EL_Y + 0.08, 16), ...range(SH_Y - 0.06, SH_Y, 5), ...range(SH_Y, top, 4)])]
      .sort((a, b) => b - a)
      .filter((y, i, all) => i === 0 || all[i - 1] - y > 0.004);
    grid(B.bare, {
      us: around(18, -Math.PI),
      vs: armYs,
      wrapU: true,
      at: (theta, y, out) => {
        const r = radius(y);
        return out.set(cx(y) + Math.sin(theta) * r * (y < EL_Y ? forearmFlat(y) : lerp(0.92, 1, smoothstep(EL_Y, EL_Y + 0.06, y))), y, Math.cos(theta) * r);
      },
      paint: () => ({ c: skinC, kind: KIND.linen }),
      weights: (p) => {
        const wr = wristShare(p.y);
        if (wr > 0) return [s === 1 ? BI.elL : BI.elR, 1 - wr, s === 1 ? BI.wrL : BI.wrR, wr];
        return armWeights(p, s);
      },
      uv: () => [0.02, 0.5],
    });
    // The leg, ankle to hip.
    const lx = s * m.hipX;
    grid(B.bare, {
      us: around(18, -Math.PI),
      // Down into the foot, so the ankle meets it with no rim; rings close together round the knee.
      vs: [PELVIS_Y + 0.05, PELVIS_Y, 0.86, 0.8, 0.72, 0.64, 0.58, ...range(KNEE_Y + 0.09, KNEE_Y - 0.09, 18), 0.36, 0.28, 0.2, 0.12, 0.09, 0.075, 0.06, 0.04, 0.02],
      wrapU: true,
      at: (theta, y, out) => {
        // Above the hip joint the thigh's end narrows inside the body, so none of it shows when the
        // leg swings.
        let r = LEG.at(Math.max(0.06, y)) * (y > 0.5 ? w : 1) * lerp(1, 0.7, smoothstep(0.86, PELVIS_Y + 0.05, y));
        // The two ankle bones: the inner one higher and further forward.
        const sn = Math.sin(theta) * s;
        if (sn < 0) r += 0.005 * Math.exp(-(((y - 0.078) / 0.012) ** 2)) * Math.exp(-(((theta * s + Math.PI / 2 - 0.3) / 0.55) ** 2));
        else r += 0.0045 * Math.exp(-(((y - 0.066) / 0.012) ** 2)) * Math.exp(-(((theta * s - Math.PI / 2 + 0.3) / 0.55) ** 2));
        // The kneecap.
        r += 0.006 * Math.exp(-(((y - (KNEE_Y + 0.012)) / 0.026) ** 2)) * Math.max(0, Math.cos(theta)) ** 2;
        // Calves fuller behind, shins flatter in front.
        const back = Math.cos(theta) < 0 && y > 0.15 && y < 0.45 ? 1 + 0.08 * -Math.cos(theta) * Math.sin(((y - 0.15) / 0.3) * Math.PI) : 1;
        return out.set(lx + Math.sin(theta) * r - (y > 0.5 ? s * 0.004 : 0), y, Math.cos(theta) * r * 1.05 * back);
      },
      paint: () => ({ c: skinC, kind: KIND.linen }),
      weights: (p) => footWeights(p, s),
      uv: () => [0.02, 0.5],
    });
  }
}

export function buildOutfit(d: Dress): void {
  const { look, C, m } = d;
  const outfit = look.outfit;
  const noble = d.noble;
  const mainKind = noble || outfit === 'gown' || outfit === 'surcoat' ? KIND.velvet : outfit === 'smock' ? KIND.linen : KIND.wool;
  // Kirtle & Apron on a man's frame is cut as a work tunic with an apron (bakers, smiths, cooks).
  const workApron = outfit === 'apron_dress' && !m.female;
  const long = ['robe', 'kirtle', 'apron_dress', 'cotehardie', 'gown', 'court_dress'].includes(outfit) && !workApron;
  const footwear = workApron ? 'boots' : footwearFor(outfit, noble);
  const hoseKind = KIND.wool;
  let hoseColour = C.legs;
  if (outfit === 'surcoat') hoseColour = shade(C.legs, 0.7);
  buildLegs(d.B, m, C, footwear, hoseKind, !long, hoseColour);

  switch (outfit) {
    case 'tunic':
      return tunicOutfit(d, mainKind);
    case 'smock':
      return smockOutfit(d);
    case 'doublet':
      return doubletOutfit(d, mainKind);
    case 'robe':
      return robeOutfit(d, mainKind);
    case 'surcoat':
      return surcoatOutfit(d);
    case 'kirtle':
      return kirtleOutfit(d, mainKind);
    case 'apron_dress':
      return workApron ? workApronOutfit(d) : apronOutfit(d);
    case 'cotehardie':
      return cotehardieOutfit(d, mainKind);
    case 'gown':
      return gownOutfit(d);
    case 'riding_coat':
      return authoredCourtOutfit(d, false);
    case 'court_dress':
      return authoredCourtOutfit(d, true);
  }
}

/** Blender-authored draped body with articulated sleeves and fitted period accessories. */
function authoredCourtOutfit(d: Dress, dress: boolean): void {
  const { C, m } = d;
  const kind = dress ? KIND.velvet : KIND.wool;
  const torso = new Shell(torsoKeys(m, 0.007));
  if (!dress) {
    // Only the visible shirt placket belongs behind the opening. A full procedural
    // torso has a different bust profile and can break through the authored coat.
    const shirt = new Shell([
      { y: 0.94, rx: 0.168 * m.w, zf: 0.124 * m.w, zb: 0.124 * m.w, e: 2 },
      { y: 1.02, rx: 0.143 * m.w, zf: 0.111 * m.w, zb: 0.111 * m.w, e: 2 },
      { y: 1.17, rx: 0.156 * m.w, zf: 0.122 * m.w, zb: 0.122 * m.w, e: 2 },
      { y: 1.32, rx: 0.178 * m.w, zf: 0.142 * m.w, zb: 0.142 * m.w, e: 2 },
      { y: 1.43, rx: 0.209 * m.w, zf: 0.115 * m.w, zb: 0.115 * m.w, e: 2 },
      { y: 1.48, rx: 0.184 * m.w, zf: 0.098 * m.w, zb: 0.098 * m.w, e: 2 },
      { y: 1.525, rx: 0.092 * m.w, zf: 0.074 * m.w, zb: 0.074 * m.w, e: 2 },
      { y: 1.555, rx: 0.059 * m.w, zf: 0.059 * m.w, zb: 0.059 * m.w, e: 2 },
    ]);
    grid(d.B.garment, { us: range(-0.18, 0.18, 8), vs: range(1.555, 0.94, 40),
      at: (theta, y, out) => shirt.at(theta, y, 0, out),
      paint: () => ({ c: C.accent, kind: KIND.linen }),
      weights: p => trunkWeights(p, m), uv: (theta, y) => [theta * 2, y * 4] });
  }
  appendAuthoredMesh(d.B.garment, dress ? courtDressPositions : ridingCoatPositions,
    dress ? courtDressIndices : ridingCoatIndices,
    (p) => { p.x *= m.w; p.z *= m.w; return p; },
    (p) => {
      const angle = Math.abs(Math.atan2(p.x, p.z));
      const edging = p.y < (dress ? 0.11 : 0.52) || p.y > 1.535
        || (dress ? angle < 0.095 : angle < 0.21);
      return { c: edging ? C.trim : C.tunic, kind: edging ? KIND.embroidery : kind, c2: C.accent };
    }, (p) => trunkWeights(p, m, { skirt: p.y < 0.95 }));
  for (const side of [1, -1] as const) sleeve(d, side, {
    type: dress ? 'bell' : 'fitted', c: C.tunic, kind, cuff: C.trim,
    cuffKind: KIND.embroidery, c2: C.accent,
  });
  // Belt conforms to the authored waist rather than the smaller underlying body shell.
  const waist = new Shell([
    { y: 0.97, rx: 0.158 * m.w, zf: 0.125 * m.w, zb: 0.125 * m.w, e: 2 },
    { y: 1.065, rx: 0.155 * m.w, zf: 0.122 * m.w, zb: 0.122 * m.w, e: 2 },
  ]);
  belt(d, waist, 1.015, { h: dress ? 0.03 : 0.038, c: dress ? C.trim : shade(C.legs, 0.55),
    kind: dress ? KIND.embroidery : KIND.leather, buckle: dress ? 'plaques' : 'frame',
    pouch: !dress, lift: 0.005 });
  shirtCollar(d, torso, 1.548);
  if (dress) necklace(d, new Shell(torsoKeys(m, 0.026)), 'gem');
  addCloak(d);
}

/** Linen shirt collar showing above a round or keyhole neckline. */
function shirtCollar(d: Dress, shell: Shell, y: number): void {
  neckFacing(d, shell, y, { c: d.C.linen, kind: KIND.linen });
}

/**
 * A neck facing: a band that rises from a garment's top edge (at `y`, a hair above it) and closes
 * round the neck, with a turned-in inner face, so looking down on a Kynd from the camera there's
 * no dark gap between the neck and their clothes. Its foot moves with the garment, its top with
 * the neck, so a Kynd can look down without the neck pushing through it.
 */
function neckFacing(d: Dress, shell: Shell, y: number, paint: Paint): void {
  const y0 = y - 0.004, y1 = y + 0.02;
  const vs = [y0, ...range(y0, y1, 6).slice(1), y1 - 0.016];
  grid(d.B.garment, {
    us: around(48, -Math.PI),
    vs: vs.map((_v, i) => i),
    wrapU: true,
    flip: true,
    at: (theta, i, out) => {
      const k = Math.round(i);
      const inner = k === vs.length - 1;
      const yy = inner ? y1 - 0.016 : vs[k];
      shell.at(theta, y0, k === 0 ? 0.0015 : 0.0035, V);
      const r0 = Math.hypot(V.x, V.z);
      // Out from the garment's edge, then round in to the neck; the inner face folds down inside.
      const t = inner ? 1 : smoothstep(y0, y0 + 0.016, yy);
      const r = lerp(r0, neckRadius(d.head.s, yy) + 0.0028 + (yy - y0) * 0.04, t) - (inner ? 0.003 : 0) + Math.sin(t * Math.PI) * 0.002;
      return out.set(Math.sin(theta) * r, yy, lerp(Math.cos(theta) * r, Math.cos(theta) * r * 1.02 + neckZ(yy), t));
    },
    paint: () => paint,
    weights: (p) => neckWeights(p, y0, y1),
    uv: (theta, i) => [((theta + Math.PI) / (Math.PI * 2)) * 10, Math.min(1, Math.round(i) / (vs.length - 2))],
  });
}

/** Weights for cloth round the neck: the garment's own at `y0`, all the neck's by `y1`. */
function neckWeights(p: THREE.Vector3, y0: number, y1: number): Weights {
  const n = lerp(smoothstep(1.52, 1.6, p.y), 1, smoothstep(y0 + 0.004, y1, p.y));
  return [BI.spine, 1 - n, BI.neck, n];
}

/** Paint a scoop neckline: chemise inside the curve, garment outside. */
function scoop(depth: number, width: number, top: number): (theta: number, y: number) => boolean {
  return (theta, y) => {
    const a = Math.abs(Math.atan2(Math.sin(theta), Math.cos(theta)));
    const front = Math.max(0, Math.cos(Math.min(a, Math.PI / 2)));
    const edge = top - depth * Math.pow(front, 1.4) * (a < width ? 1 : Math.max(0, 1 - (a - width) * 2)) - (a > Math.PI * 0.7 ? 0.02 : 0);
    return y > edge;
  };
}

function neckTrim(d: Dress, shell: Shell, inside: (theta: number, y: number) => boolean, top: number, lowest: number, c: Paint): void {
  // Trace the neckline curve: for each angle, find the height where `inside` flips.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 32; i++) {
    const th = -Math.PI + (i / 32) * Math.PI * 2;
    let lo = lowest;
    let hi = top;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (inside(th, mid)) hi = mid;
      else lo = mid;
    }
    pts.push(shell.at(th, (lo + hi) / 2, 0.003, new THREE.Vector3()));
  }
  pts[pts.length - 1] = pts[0].clone();
  const path = new Path(pts, 64);
  tube(d.B.garment, path, { radius: () => [0.005, 0.005], paint: () => c, weights: (p) => trunkWeights(p, d.m, { belly: false }), seg: 6, steps: 60, uv: (t, th) => [t * 18, th / (Math.PI * 2)] });
}

function tunicOutfit(d: Dress, kind: number): void {
  const { C, m } = d;
  const torso = new Shell(torsoKeys(m, 0.012));
  const skirt = skirtShell(d, 1.0, 0.5, 0.25, { folds: 9, amp: 0.06, fit: 0.93 });
  const hemBand = 0.035;
  shellMesh(d, torso, 1.55, 0.93, { n: 32, step: 0.04, paint: () => ({ c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  shellMesh(d, skirt, 1.0, 0.5, { n: 44, step: 0.05, skirt: true, seams: [0.5 + hemBand], paint: (_t, y) => (y < 0.5 + hemBand ? { c: C.trim, kind } : { c: C.tunic, kind }), lining: shade(C.tunic, 0.55) });
  // Keyhole neck with a laced slit and the shirt collar above.
  shirtCollar(d, torso, 1.554);
  ring(d, torso, { y0: 1.515, y1: 1.535, lift: 0.004, paint: { c: C.trim, kind }, n: 32, weights: (p) => trunkWeights(p, m, { belly: false }) });
  strip(d, torso, { theta0: 0, halfW: 0.009, y0: 1.42, y1: 1.52, lift: 0.002, paint: { c: C.linen, kind: KIND.linen }, step: 0.03 });
  lacing(d, torso, 1.43, 1.51, 0.012, C.leather, 0.003, false);
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'fitted', c: C.tunic, kind, cuff: C.trim, cuffKind: kind });
  belt(d, torso, 0.985, { h: 0.034, c: C.leather, kind: KIND.leather, buckle: 'frame', pouch: true, hang: 0.16 });
  addCloak(d);
}

function smockOutfit(d: Dress): void {
  const { C, m } = d;
  const kind = KIND.linen;
  const torso = new Shell(torsoKeys(m, 0.018, 0.012));
  const skirt = skirtShell(d, 1.0, 0.53, 0.26, { folds: 11, amp: 0.075, fit: 0.95, hipsEase: 0.01 });
  // A V-neck opening showing the chest, loosely laced.
  const vIn = (theta: number, y: number) => Math.abs(theta) < 0.3 * smoothstep(1.4, 1.54, y) + 0.001 && y > 1.4;
  shellMesh(d, torso, 1.55, 0.93, { n: 32, step: 0.04, paint: (th, y) => (vIn(th, y) ? { c: shade(C.skin, 0.95), kind } : { c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  shellMesh(d, skirt, 1.0, 0.53, { n: 44, step: 0.05, skirt: true, paint: () => ({ c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  lacing(d, torso, 1.42, 1.5, 0.014, C.trim, 0.003, false);
  ring(d, torso, { y0: 1.525, y1: 1.545, lift: 0.004, paint: { c: shade(C.tunic, 0.85), kind }, n: 32, weights: (p) => trunkWeights(p, m, { belly: false }) });
  neckFacing(d, torso, 1.554, { c: shade(C.tunic, 0.85), kind });
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'rolled', c: C.tunic, kind, cuff: null });
  buildForearms(d.B, m, C, EL_Y - 0.03);
  belt(d, torso, 0.99, { h: 0.02, c: C.trim, kind: KIND.straw, buckle: 'knot', pouch: false, hang: 0.2, lift: 0.006 });
  addCloak(d);
}

function doubletOutfit(d: Dress, kind: number): void {
  const { C, m } = d;
  const torso = new Shell(torsoKeys(m, 0.016, 0.004));
  const skirt = skirtShell(d, 1.0, 0.76, 0.22, { folds: 12, amp: 0.05, fit: 0.97 });
  shellMesh(d, torso, 1.555, 0.93, { n: 32, step: 0.04, paint: () => ({ c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  shellMesh(d, skirt, 1.0, 0.76, { n: 44, step: 0.05, skirt: true, seams: [0.785], paint: (_t, y) => (y < 0.785 ? { c: C.trim, kind } : { c: C.tunic, kind }), lining: shade(C.tunic, 0.5) });
  // Standing collar, front placket, buttons.
  collar(d, torso, 1.535, 1.6, { c: C.tunic, kind }, d.fine ? EMB(C.trim) : { c: C.trim, kind });
  strip(d, torso, { theta0: 0, halfW: 0.016, y0: 0.95, y1: 1.54, lift: 0.006, paint: d.fine ? EMB(C.trim) : { c: C.trim, kind }, step: 0.04 });
  buttons(d, torso, 1.02, 1.5, 7, 0.007);
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'slashed', c: C.tunic, kind, cuff: C.trim, cuffKind: d.fine ? KIND.embroidery : kind, c2: C.accent, upper: C.tunic });
  belt(d, torso, 0.99, { h: 0.03, c: col('#241812'), kind: KIND.leather, buckle: 'frame', pouch: true, hang: 0.1 });
  if (d.noble) necklace(d, torso, 'medallion');
  addCloak(d);
}

function robeOutfit(d: Dress, kind: number): void {
  const { C, m } = d;
  const torso = new Shell(torsoKeys(m, 0.016, 0.006));
  const skirt = skirtShell(d, 1.04, 0.022, 0.3, { folds: 12, amp: 0.06, fit: 0.95, hipsEase: 0.006 });
  shellMesh(d, torso, 1.55, 0.95, { n: 32, step: 0.04, paint: () => ({ c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  shellMesh(d, skirt, 1.04, 0.05, { n: 44, step: 0.06, skirt: true, paint: () => ({ c: C.tunic, kind }), lining: shade(C.legs, 0.8) });
  neckFacing(d, torso, 1.554, { c: C.tunic, kind });
  // A broad collar-stole in the accent colour down the front.
  for (const s of [-1, 1]) strip(d, torso, { theta0: s * 0.3, halfW: 0.028, y0: 1.08, y1: 1.54, lift: 0.004, paint: { c: C.accent, kind }, step: 0.05 });
  for (const s of [-1, 1]) strip(d, skirt, { theta0: s * 0.22, halfW: 0.03, y0: 0.4, y1: 1.02, lift: 0.004, paint: { c: C.accent, kind }, step: 0.08, weights: (p) => trunkWeights(p, m, { skirt: true }) });
  ring(d, skirt, { y0: 0.05, y1: 0.09, lift: 0.003, paint: EMB(C.trim), n: 54 });
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'wide', c: C.tunic, kind, cuff: null, c2: C.legs });
  belt(d, torso, 1.03, { h: 0.05, c: C.accent, kind, buckle: 'knot', pouch: false, hang: 0.34, lift: 0.006 });
  addCloak(d);
}

function kirtleOutfit(d: Dress, kind: number): void {
  const { C, m } = d;
  const torso = new Shell(torsoKeys(m, 0.009));
  const skirt = skirtShell(d, 1.07, 0.018, 0.36, { folds: 12, amp: 0.075, fit: 0.93 });
  const chem = scoop(0.1, 0.9, 1.54);
  // Front lacing over a strip of chemise.
  const slit = (theta: number, y: number) => Math.abs(theta) < 0.07 && y > 1.1 && y < 1.46;
  shellMesh(d, torso, 1.545, 1.03, {
    n: 44,
    step: 0.028,
    colSeams: [-0.07, 0.07],
    paint: (th, y) => (chem(th, y) || slit(th, y) ? { c: C.linen, kind: KIND.linen } : { c: C.tunic, kind }),
    lining: shade(C.tunic, 0.6),
  });
  shellMesh(d, skirt, 1.07, 0.03, { n: 48, step: 0.06, skirt: true, seams: [0.075], paint: (_t, y) => (y < 0.075 ? EMB(C.trim) : { c: C.tunic, kind }), lining: shade(C.legs, 0.9) });
  neckTrim(d, torso, chem, 1.545, 1.3, { c: C.trim, kind });
  shirtCollar(d, torso, 1.549);
  lacing(d, torso, 1.12, 1.44, 0.013, C.trim, 0.002, true);
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'fitted', c: C.tunic, kind, cuff: C.trim, cuffKind: KIND.embroidery });
  belt(d, torso, 1.06, { h: 0.026, c: C.accent, kind: KIND.leather, buckle: 'frame', pouch: true, hang: 0.4 });
  addCloak(d);
}

function apronOutfit(d: Dress): void {
  const { C, m } = d;
  const kind = KIND.wool;
  // Chemise underneath: the blouse shows at the neck and in the puffed sleeves.
  const chemise = new Shell(torsoKeys(m, 0.006));
  shellMesh(d, chemise, 1.54, 1.06, { n: 32, step: 0.04, paint: () => ({ c: C.linen, kind: KIND.linen }), lining: shade(C.linen, 0.7) });
  shirtCollar(d, chemise, 1.544);
  // A laced bodice over it, open at the front and square-necked, in a darker shade.
  const bodiceC = mixCol(C.tunic, col('#1c1410'), 0.45);
  const bod = new Shell(torsoKeys(m, 0.016));
  const bodTop = (theta: number) => {
    const a = Math.abs(Math.atan2(Math.sin(theta), Math.cos(theta)));
    return a < 0.9 ? 1.33 + a * 0.02 : lerp(1.35, 1.43, smoothstep(0.9, 1.6, a));
  };
  const gap = 0.16;
  const us = range(gap, Math.PI * 2 - gap, 36);
  const loop = [...us.map((u) => ({ u, inner: false })), ...[...us].reverse().map((u) => ({ u, inner: true }))];
  grid(d.B.garment, {
    us: loop.map((_l, i) => i),
    vs: range(0, 1, 9),
    wrapU: true,
    flip: true,
    at: (i, t, out) => {
      const l = loop[Math.round(i)];
      const y = lerp(1.03, bodTop(l.u), t);
      return bod.at(l.u, y, l.inner ? -0.004 : 0, out);
    },
    paint: (i) => (loop[Math.round(i)].inner ? { c: shade(bodiceC, 0.6), kind: KIND.linen } : { c: bodiceC, kind: KIND.leather }),
    weights: (p) => trunkWeights(p, m),
  });
  // Shoulder straps.
  for (const s of [-1, 1]) {
    // Flat ribbons lying on the chemise, from the bodice front over the shoulder to the back.
    const pts = [bod.at(s * 0.5, 1.33, 0.0, new THREE.Vector3()), chemise.at(s * 0.62, 1.42, 0.006, new THREE.Vector3()), chemise.at(s * 0.9, 1.5, 0.006, new THREE.Vector3()), chemise.at(s * 2.2, 1.5, 0.006, new THREE.Vector3()), chemise.at(s * 2.5, 1.41, 0.006, new THREE.Vector3()), bod.at(s * 2.6, 1.37, 0.0, new THREE.Vector3())];
    tube(d.B.garment, new Path(pts, 24, new THREE.Vector3(0, 0, 1)), { radius: () => [0.0028, 0.013], paint: () => ({ c: bodiceC, kind: KIND.leather }), weights: (p) => trunkWeights(p, m, { belly: false }), seg: 8, steps: 14 });
  }
  lacing(d, bod, 1.06, 1.32, 0.02, C.trim, 0.002, true);
  // The skirt, full and gathered.
  const skirt = skirtShell(d, 1.07, 0.025, 0.35, { folds: 13, amp: 0.08, fit: 0.97, hipsEase: 0.012 });
  shellMesh(d, skirt, 1.07, 0.06, { n: 48, step: 0.06, skirt: true, seams: [0.1], paint: (_t, y) => (y < 0.1 ? { c: shade(C.tunic, 0.8), kind } : { c: C.tunic, kind }), lining: shade(C.tunic, 0.55) });
  // Apron over the skirt front.
  const apronShell = skirtShell(d, 1.07, 0.25, 0.37, { folds: 7, amp: 0.035, fit: 0.97, hipsEase: 0.03 });
  const aus = range(-1.05, 1.05, 20);
  const aloop = [...aus.map((u) => ({ u, inner: false })), ...[...aus].reverse().map((u) => ({ u, inner: true }))];
  grid(d.B.garment, {
    us: aloop.map((_l, i) => i),
    vs: rows(1.05, 0.25, 0.06).reverse(),
    wrapU: true,
    at: (i, y, out) => {
      const l = aloop[Math.round(i)];
      return apronShell.at(l.u, y, l.inner ? 0.004 : 0.01, out);
    },
    paint: (i) => ({ c: aloop[Math.round(i)].inner ? shade(C.accent, 0.7) : C.accent, kind: KIND.linen }),
    weights: (p) => trunkWeights(p, m, { skirt: true }),
  });
  // Apron band and ties.
  ring(d, apronShell, { y0: 1.035, y1: 1.07, lift: 0.012, paint: { c: shade(C.accent, 0.92), kind: KIND.linen }, n: 40, weights: (p) => trunkWeights(p, m) });
  for (const s of [-1, 1]) {
    const k = apronShell.at(Math.PI, 1.05, 0.02, new THREE.Vector3());
    const pts = [k, new THREE.Vector3(k.x + s * 0.03, k.y - 0.08, k.z - 0.02), new THREE.Vector3(k.x + s * 0.02, k.y - 0.2, k.z - 0.03)];
    tube(d.B.garment, new Path(pts, 12), { radius: () => [0.003, 0.012], paint: () => ({ c: C.accent, kind: KIND.linen }), weights: (p) => trunkWeights(p, m, { skirt: true }), seg: 6, steps: 8 });
  }
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'puff', c: C.linen, kind: KIND.linen, cuff: null });
  buildForearms(d.B, m, C, EL_Y - 0.01);
  belt(d, bod, 1.03, { h: 0.022, c: C.leather, kind: KIND.leather, buckle: 'frame', pouch: true, lift: 0.004 });
  addCloak(d);
}

/** A work tunic with rolled linen sleeves and a long apron: the tradesman's cut of Kirtle & Apron. */
function workApronOutfit(d: Dress): void {
  const { C, m } = d;
  const kind = KIND.wool;
  const torso = new Shell(torsoKeys(m, 0.014, 0.008));
  const skirt = skirtShell(d, 1.0, 0.5, 0.25, { folds: 9, amp: 0.055, fit: 0.94 });
  shellMesh(d, torso, 1.56, 0.93, { n: 32, step: 0.04, paint: () => ({ c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  shellMesh(d, skirt, 1.0, 0.5, { n: 44, step: 0.05, skirt: true, paint: () => ({ c: C.tunic, kind }), lining: shade(C.tunic, 0.55) });
  shirtCollar(d, torso, 1.564);
  lacing(d, torso, 1.44, 1.52, 0.012, C.trim, 0.003, false);
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'rolled', c: C.linen, kind: KIND.linen, cuff: null });
  buildForearms(d.B, m, C, EL_Y - 0.03);
  // The apron: a bib over the chest and a long skirt to the shins, tied round the waist.
  const apronShell = skirtShell(d, 1.02, 0.3, 0.3, { folds: 5, amp: 0.025, fit: 0.96, hipsEase: 0.03 });
  const aus = range(-1.0, 1.0, 16);
  const aloop = [...aus.map((u) => ({ u, inner: false })), ...[...aus].reverse().map((u) => ({ u, inner: true }))];
  grid(d.B.garment, {
    us: aloop.map((_l, i) => i),
    vs: rows(1.02, 0.3, 0.07).reverse(),
    wrapU: true,
    at: (i, y, out) => {
      const l = aloop[Math.round(i)];
      return apronShell.at(l.u, y, l.inner ? 0.004 : 0.01, out);
    },
    paint: (i) => ({ c: aloop[Math.round(i)].inner ? shade(C.accent, 0.7) : C.accent, kind: C.accent.r < 0.25 ? KIND.leather : KIND.linen }),
    weights: (p) => trunkWeights(p, m, { skirt: true }),
  });
  const bib = new Shell(torsoKeys(m, 0.03, 0.008));
  const bus = range(-0.62, 0.62, 10);
  const bloop = [...bus.map((u) => ({ u, inner: false })), ...[...bus].reverse().map((u) => ({ u, inner: true }))];
  grid(d.B.garment, {
    us: bloop.map((_l, i) => i),
    vs: [1.36, 1.28, 1.18, 1.08, 1.0],
    wrapU: true,
    at: (i, y, out) => {
      const l = bloop[Math.round(i)];
      return bib.at(l.u * (1 - (y - 1.0) * 0.8), y, l.inner ? -0.004 : 0, out);
    },
    paint: (i) => ({ c: bloop[Math.round(i)].inner ? shade(C.accent, 0.7) : C.accent, kind: C.accent.r < 0.25 ? KIND.leather : KIND.linen }),
    weights: (p) => trunkWeights(p, m),
  });
  // Neck strap.
  const pts = [bib.at(-0.3, 1.36, 0.002, new THREE.Vector3()), bib.at(-0.55, 1.5, 0.004, new THREE.Vector3()), bib.at(Math.PI, 1.535, 0.004, new THREE.Vector3()), bib.at(0.55, 1.5, 0.004, new THREE.Vector3()), bib.at(0.3, 1.36, 0.002, new THREE.Vector3())];
  tube(d.B.garment, new Path(pts, 28), { radius: () => [0.003, 0.009], paint: () => ({ c: shade(C.accent, 0.85), kind: KIND.linen }), weights: (p) => trunkWeights(p, m, { belly: false }), seg: 6, steps: 20 });
  ring(d, apronShell, { y0: 0.985, y1: 1.015, lift: 0.012, paint: { c: shade(C.accent, 0.9), kind: KIND.linen }, n: 32, weights: (p) => trunkWeights(p, m) });
  belt(d, torso, 1.03, { h: 0.024, c: C.leather, kind: KIND.leather, buckle: 'frame', pouch: true, hang: 0.08, lift: 0.02 });
  addCloak(d);
}

function cotehardieOutfit(d: Dress, kind: number): void {
  const { C, m } = d;
  const torso = new Shell(torsoKeys(m, 0.009));
  const skirt = skirtShell(d, 0.9, 0.02, 0.39, { folds: 13, amp: 0.07, fit: 0.9, train: 0.05 });
  const chem = scoop(0.07, 1.1, 1.54);
  shellMesh(d, torso, 1.545, 0.86, { n: 36, step: 0.036, paint: (th, y) => (chem(th, y) ? { c: C.linen, kind: KIND.linen } : { c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  shellMesh(d, skirt, 0.9, 0.02, { n: 48, step: 0.06, skirt: true, seams: [0.07], paint: (_t, y) => (y < 0.07 ? EMB(C.trim) : { c: C.tunic, kind }), lining: shade(C.legs, 0.9) });
  neckTrim(d, torso, chem, 1.545, 1.35, EMB(C.trim));
  shirtCollar(d, torso, 1.549);
  buttons(d, torso, 0.94, 1.44, 10, 0.003);
  for (const s of [1, -1] as const) {
    sleeve(d, s, { type: 'fitted', c: C.tunic, kind, cuff: C.trim, cuffKind: KIND.embroidery });
    // Tippet: a long streamer hanging from the elbow.
    const x0 = s * (m.shX + 0.012);
    const pts = [new THREE.Vector3(x0 + s * 0.02, EL_Y + 0.03, -0.02), new THREE.Vector3(x0 + s * 0.035, EL_Y - 0.1, -0.035), new THREE.Vector3(x0 + s * 0.03, EL_Y - 0.4, -0.05)];
    tube(d.B.garment, new Path(pts, 16, new THREE.Vector3(s, 0, 0)), {
      radius: (t) => [0.004, 0.022 * (1 - t * 0.3) * capsuleR(t, 0, 0.05)],
      paint: () => ({ c: C.trim, kind }),
      weights: () => (s === 1 ? [BI.shL, 1] : [BI.shR, 1]),
      seg: 8,
      steps: 10,
    });
  }
  belt(d, torso, 0.9, { h: 0.04, c: shade(C.accent, 0.8), kind: KIND.leather, buckle: 'plaques', pouch: true, lift: 0.004 });
  necklace(d, torso, 'gem');
  addCloak(d);
}

function gownOutfit(d: Dress): void {
  const { C, m } = d;
  const kind = KIND.velvet;
  const torso = new Shell(torsoKeys(m, 0.01));
  const skirt = skirtShell(d, 1.1, 0.0, 0.43, { folds: 14, amp: 0.085, fit: 1.0, train: 0.12, hipsEase: 0.01 });
  skirt.flatFront = true;
  shellMesh(d, torso, 1.56, 1.06, { n: 36, step: 0.036, paint: () => ({ c: C.tunic, kind }), lining: shade(C.tunic, 0.6) });
  shellMesh(d, skirt, 1.1, 0.0, { n: 52, step: 0.06, skirt: true, paint: () => ({ c: C.tunic, kind }), lining: C.accent });
  // High collar, and a wide embroidered band down the front and round the hem.
  collar(d, torso, 1.525, 1.605, { c: C.tunic, kind }, EMB(C.trim));
  strip(d, torso, { theta0: 0, halfW: 0.026, y0: 1.08, y1: 1.56, lift: 0.007, paint: EMB(C.trim), step: 0.03 });
  strip(d, skirt, { theta0: 0, halfW: (y) => lerp(0.05, 0.03, (y - 0.0) / 1.1), y0: 0.08, y1: 1.1, lift: 0.005, paint: EMB(C.trim), step: 0.06, weights: (p) => trunkWeights(p, m, { skirt: true }) });
  ring(d, skirt, { y0: 0.0, y1: 0.075, lift: 0.004, paint: EMB(C.trim), n: 64, uvRepeat: 16 });
  // Side lacing on the bodice.
  for (const s of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const y = lerp(1.12, 1.34, i / 6);
      pts.push(torso.at(s * (Math.PI / 2 + (i % 2 ? 0.07 : -0.07)), y, 0.005, new THREE.Vector3()));
    }
    tube(d.B.garment, new Path(pts, 30), { radius: () => [0.002, 0.002], paint: () => ({ c: C.trim, kind: KIND.linen }), weights: (p) => trunkWeights(p, m), seg: 5, steps: 24 });
  }
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'slashed', c: C.tunic, kind, cuff: C.trim, cuffKind: KIND.embroidery, c2: mixCol(C.accent, col('#f1e3bf'), 0.5), upper: C.tunic });
  belt(d, torso, 1.1, { h: 0.048, c: shade(C.trim, 0.85), kind: KIND.embroidery, buckle: 'round', pouch: false, lift: 0.006 });
  necklace(d, torso, 'gem');
  addCloak(d);
}

function surcoatOutfit(d: Dress): void {
  const { C, m } = d;
  const kind = KIND.velvet;
  // A dark padded doublet underneath (quilted: horizontal ribs), puffed and slashed at the sleeves.
  const under = shade(C.legs, 0.9);
  const torso = new Shell(torsoKeys(m, 0.012, 0.006));
  shellMesh(d, torso, 1.56, 0.93, { n: 32, step: 0.04, paint: () => ({ c: under, kind: KIND.wool }), lining: shade(under, 0.6) });
  const skirtU = skirtShell(d, 1.0, 0.62, 0.21, { folds: 10, amp: 0.03, fit: 0.95 });
  shellMesh(d, skirtU, 1.0, 0.62, { n: 36, step: 0.06, skirt: true, paint: () => ({ c: under, kind: KIND.wool }), lining: shade(under, 0.6) });
  collar(d, torso, 1.535, 1.595, { c: under, kind: KIND.wool }, EMB(C.trim));
  for (const s of [1, -1] as const) sleeve(d, s, { type: 'slashed', c: under, kind: KIND.wool, cuff: C.trim, cuffKind: KIND.embroidery, c2: mixCol(C.trim, col('#f1e3bf'), 0.4), upper: under });
  // The tabard: front and back panels, open at the sides, with the charge on the chest.
  const tab = new Shell(torsoKeys(m, 0.026, 0.01).filter((k) => k.y > 0.9).concat([
    { y: 0.87, rx: 0.2 * m.w + 0.03, zf: 0.16 * m.w + 0.03, zb: 0.16 * m.w + 0.03 },
    { y: 0.7, rx: 0.25 * m.w, zf: 0.2 * m.w, zb: 0.2 * m.w },
    { y: 0.42, rx: 0.27 * m.w, zf: 0.22 * m.w, zb: 0.22 * m.w },
  ]), { n: 6, amp: new Profile([[0.4, 0.035], [0.8, 0.01], [0.95, 0]]), phase: 0 });
  const panel = (center: number, half: number, chargeOn: boolean) => {
    const us = range(-1, 1, 12);
    const hem = 0.44;
    const ys = rows(1.52, hem, 0.07, [hem + 0.04]).reverse();
    const loop = [...us.map((u) => ({ u, inner: false })), ...[...us].reverse().map((u) => ({ u, inner: true }))];
    grid(d.B.garment, {
      us: loop.map((_l, i) => i),
      vs: ys,
      wrapU: true,
      at: (i, y, out) => {
        const l = loop[Math.round(i)];
        // Narrower over the shoulders so the sleeves show.
        const h = y > 1.36 ? lerp(half, 0.42, smoothstep(1.36, 1.52, y)) : half;
        return tab.at(center + l.u * h, y, l.inner ? -0.004 : 0, out);
      },
      paint: (i, y) => {
        const l = loop[Math.round(i)];
        if (l.inner) return { c: shade(C.tunic, 0.55), kind: KIND.linen };
        if (y < hem + 0.04 || Math.abs(l.u) > 0.9) return EMB(C.trim);
        return { c: C.tunic, kind };
      },
      weights: (p) => trunkWeights(p, m, { skirt: p.y < 0.9 }),
    });
    if (chargeOn) {
      // The heraldic charge, as a patch on the chest.
      grid(d.B.garment, {
        us: range(-1, 1, 10),
        vs: range(1.08, 1.4, 10),
        flip: true,
        at: (u, y, out) => tab.at(center + u * 0.62, y, 0.0025, out),
        paint: () => ({ c: C.tunic, kind: KIND.charge, c2: C.accent }),
        weights: (p) => trunkWeights(p, m),
        uv: (u, y) => [(u + 1) / 2, (y - 1.08) / 0.32],
      });
    }
  };
  panel(0, 1.05, true);
  panel(Math.PI, 1.05, false);
  belt(d, tab, 1.0, { h: 0.036, c: col('#161110'), kind: KIND.leather, buckle: 'round', pouch: true, scabbard: true, lift: 0.003 });
  necklace(d, tab, 'medallion');
  addCloak(d);
}

function addCloak(d: Dress): void {
  if (!d.look.cloak) return;
  const noble = d.noble || d.look.outfit === 'surcoat' || d.look.outfit === 'gown';
  cloak(d, col(d.look.cloak), d.C.accent, noble ? 'ermine' : 'none', noble ? KIND.velvet : KIND.wool);
}

// --- headwear -------------------------------------------------------------------------------

export function hairCoverFor(h: string): 'none' | 'hat' | 'coif' | 'hood' | 'veil' | 'band' {
  switch (h) {
    case 'hood':
      return 'hood';
    case 'veil':
    case 'wimple':
      return 'veil';
    case 'coif':
      return 'coif';
    case 'straw_hat':
    case 'felt_cap':
      return 'hat';
    case 'circlet':
    case 'crown':
      return 'band';
    default:
      return 'none';
  }
}

const headW = (): Weights => [BI.head, 1];

export function buildHeadwear(d: Dress): void {
  const { look, C, head } = d;
  const hw = look.headwear;
  if (hw === 'none') return;
  const crown = d.crown * (hw === 'circlet' || hw === 'crown' ? 2.2 : 1.15);
  const tmp = new THREE.Vector3();
  const band = (y: number) => {
    // Radius of the head plus hair at head-space height y (for seating hats).
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const th = (i / 24) * Math.PI * 2 - Math.PI;
      head.shell(th, head.phiAt(th, y), crown + 0.004, tmp);
      pts.push(tmp.clone());
    }
    return pts;
  };
  const at = (th: number, phi: number, off: number, out: THREE.Vector3) => {
    head.shell(th, phi, off, out);
    return hp(out.x, out.y, out.z, out);
  };
  if (hw === 'circlet' || hw === 'crown') {
    const tall = hw === 'crown' ? 0.03 : 0.009;
    const base = (th: number) => 0.2 - Math.cos(th) * 0.012;
    grid(d.B.metal, {
      us: around(40, -Math.PI),
      vs: [0, 0.2, 0.8, 1],
      wrapU: true,
      flip: true,
      at: (th, t, out) => {
        const y = base(th) + t * tall;
        head.shell(th, head.phiAt(th, y), crown + 0.004 + (t > 0.1 && t < 0.9 ? 0.002 : 0) + t * (hw === 'crown' ? 0.008 : 0), out);
        return hp(out.x, out.y, out.z, out);
      },
      paint: () => ({ c: C.gold }),
      weights: headW,
    });
    const gems = hw === 'crown' ? 8 : 1;
    for (let i = 0; i < gems; i++) {
      const th = (i / gems) * Math.PI * 2;
      const y = base(th) + tall * 0.5;
      head.shell(th, head.phiAt(th, y), crown + 0.009 + (hw === 'crown' ? 0.004 : 0), tmp);
      const gc = [col('#a0182a'), col('#1c4aa0'), col('#1f8a52')][i % 3];
      ellipsoid(d.B.metal, hp(tmp.x, tmp.y, tmp.z), [0.006, 0.008, 0.004], () => ({ c: gc }), headW, 10, 6, new THREE.Euler(0, th, 0));
      if (hw === 'crown') {
        // Fleurons: points with a ball at the tip.
        const yTop = base(th) + tall;
        head.shell(th, head.phiAt(th, yTop), crown + 0.012, tmp);
        const b0 = hp(tmp.x, tmp.y, tmp.z);
        const tip = b0.clone().add(new THREE.Vector3(Math.sin(th) * 0.006, 0.034, Math.cos(th) * 0.006));
        tube(d.B.metal, new Path([b0, b0.clone().lerp(tip, 0.5), tip], 8, new THREE.Vector3(Math.sin(th), 0, Math.cos(th))), { radius: (t) => [0.003, 0.011 * (1 - t * 0.85)], paint: () => ({ c: C.gold }), weights: headW, seg: 6, steps: 6 });
        ellipsoid(d.B.metal, tip, [0.005, 0.005, 0.005], () => ({ c: col('#f5e7b5') }), headW, 8, 6);
      }
    }
    return;
  }
  if (hw === 'straw_hat') {
    const straw = col('#d6b56a');
    const seat = 0.215;
    const pts = band(seat);
    const rAvg = pts.reduce((s, p) => s + Math.hypot(p.x, p.z), 0) / pts.length;
    // Crown of the hat.
    grid(d.B.garment, {
      us: around(28, -Math.PI),
      vs: [0, 0.3, 0.6, 0.85, 1],
      wrapU: true,
      flip: true,
      at: (th, t, out) => {
        const r = (rAvg + 0.006) * (t < 0.85 ? 1 - t * 0.08 : Math.sqrt(Math.max(0, 1 - ((t - 0.85) / 0.15) ** 2)) * 0.92);
        const y = seat + (t < 0.85 ? t * 0.085 : 0.072 + (t - 0.85) * 0.12);
        return hp(Math.sin(th) * r, y, Math.cos(th) * r * 1.08 - 0.006, out);
      },
      paint: (_th, t) => (t > 0.05 && t < 0.25 ? { c: C.accent, kind: KIND.linen } : { c: straw, kind: KIND.straw }),
      weights: headW,
    });
    // Brim, drooping at the edge.
    grid(d.B.garment, {
      us: around(36, -Math.PI),
      vs: [0, 0.5, 1, 1.02, 1.04],
      wrapU: true,
      at: (th, t, out) => {
        const k = Math.min(1, t);
        const r = lerp(rAvg + 0.004, rAvg + 0.1, k);
        const y = seat + 0.004 - k * k * 0.03 - (t > 1 ? 0.006 : 0) + Math.sin(th * 3) * 0.004 * k;
        const rr = t > 1.03 ? r - 0.004 : r;
        return hp(Math.sin(th) * rr, y, Math.cos(th) * rr * 1.08 - 0.006, out);
      },
      paint: () => ({ c: straw, kind: KIND.straw }),
      weights: headW,
    });
    grid(d.B.garment, {
      us: around(36, -Math.PI),
      vs: [0, 1],
      wrapU: true,
      flip: true,
      at: (th, t, out) => {
        const r = lerp(rAvg + 0.004, rAvg + 0.1, t);
        const y = seat - 0.002 - t * t * 0.03 + Math.sin(th * 3) * 0.004 * t;
        return hp(Math.sin(th) * r, y, Math.cos(th) * r * 1.08 - 0.006, out);
      },
      paint: () => ({ c: shade(straw, 0.75), kind: KIND.straw }),
      weights: headW,
    });
    return;
  }
  if (hw === 'felt_cap') {
    // A soft beret with a rolled brim; the well-to-do add a gold braid and a feather.
    const fancy = d.fine || d.noble;
    const seat = 0.172;
    const pts = band(seat);
    const rAvg = pts.reduce((s, p) => s + Math.hypot(p.x, p.z), 0) / pts.length;
    const capC = fancy ? C.accent : shade(C.accent, 0.9);
    const brimC = fancy ? mixCol(C.linen, C.trim, 0.3) : shade(C.accent, 0.8);
    // Rolled brim.
    grid(d.B.garment, {
      us: around(32, -Math.PI),
      vs: range(0, Math.PI * 2, 8),
      wrapU: true,
      flip: true,
      at: (th, a, out) => {
        const r = rAvg + 0.009 + Math.cos(a) * 0.009;
        const y = seat + 0.011 + Math.sin(a) * 0.011 - Math.cos(th) * 0.008;
        return hp(Math.sin(th) * r, y, Math.cos(th) * r * 1.08 - 0.004, out);
      },
      paint: () => ({ c: brimC, kind: fancy ? KIND.velvet : KIND.wool }),
      weights: headW,
    });
    // Soft crown: a pillowy top, slouching toward the Kynd's right.
    grid(d.B.garment, {
      us: around(32, -Math.PI),
      vs: range(0, 1, 9),
      wrapU: true,
      flip: true,
      at: (th, t, out) => {
        const wide = fancy ? 0.3 : 0.1;
        const bulge = t < 0.7 ? 1 + wide * Math.sin((t / 0.7) * Math.PI * 0.5) : (1 + wide) * Math.sqrt(Math.max(0, 1 - ((t - 0.7) / 0.3) ** 2));
        const r = (rAvg + 0.006) * bulge;
        const tall = fancy ? 1 : 1.25;
        const y = seat + 0.012 + (t < 0.7 ? t * 0.085 * tall : 0.06 * tall + (t - 0.7) * 0.1 * tall) - Math.cos(th) * 0.006 * (1 - t);
        const lean = Math.pow(t, 1.5) * 0.035;
        return hp(Math.sin(th) * r - lean, y - lean * 0.5, Math.cos(th) * r * 1.05 - 0.01, out);
      },
      paint: (_th, t) => ({ c: shade(capC, 0.85 + t * 0.2), kind: fancy ? KIND.velvet : KIND.wool }),
      weights: headW,
    });
    if (fancy) {
      const bp: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const th = (i / 24) * Math.PI * 2 - Math.PI;
        bp.push(hp(Math.sin(th) * (rAvg + 0.026), seat + 0.028 - Math.cos(th) * 0.008, Math.cos(th) * (rAvg + 0.026) * 1.08 - 0.004));
      }
      tube(d.B.metal, new Path(bp, 48), { radius: () => [0.0028, 0.0028], paint: () => ({ c: C.gold }), weights: headW, seg: 6, steps: 40 });
      // Feather sweeping back from a jewel on the left side.
      const j = hp(0.075, seat + 0.035, 0.05);
      ellipsoid(d.B.metal, j, [0.008, 0.008, 0.006], () => ({ c: col('#a0182a') }), headW, 10, 6);
      const fp = [j, hp(0.1, seat + 0.1, 0.0), hp(0.11, seat + 0.16, -0.08), hp(0.09, seat + 0.18, -0.16)];
      tube(d.B.garment, new Path(fp, 20, new THREE.Vector3(1, 0, 0)), {
        radius: (t) => [0.002, 0.022 * Math.sin(Math.min(1, t * 1.1) * Math.PI) + 0.002],
        paint: (t) => ({ c: mixCol(col('#f4f0e6'), C.trim, t * 0.3), kind: KIND.fur }),
        weights: headW,
        seg: 8,
        steps: 14,
      });
    }
    return;
  }
  const white = col('#f1ece0');
  if (hw === 'coif') {
    // Linen cap covering the hair and ears, tied under the chin.
    const edge = (th: number) => {
      const a = Math.abs(th);
      const y = a < 0.6 ? 0.19 - a * 0.02 : a < 1.5 ? lerp(0.178, 0.06, smoothstep(0.6, 1.4, a)) : lerp(0.06, 0.05, smoothstep(1.5, 3.1, a));
      return head.phiAt(th, y);
    };
    grid(d.B.garment, {
      us: range(-Math.PI, Math.PI, 40),
      vs: range(0, 1, 12),
      at: (th, t, out) => at(th, Math.max(0.001, t) * edge(th), crown + 0.006 + (1 - t) * 0.004 + Math.max(0, Math.abs(th) - 1.2) * 0.008, out),
      paint: (_th, t) => ({ c: t > 0.93 ? shade(white, 0.92) : white, kind: KIND.linen }),
      weights: headW,
    });
    // Strings tied under the chin.
    const pts: THREE.Vector3[] = [];
    for (const [th, y] of [[1.45, 0.07], [1.1, 0.03], [0.4, -0.005], [0, -0.01], [-0.4, -0.005], [-1.1, 0.03], [-1.45, 0.07]] as const) {
      head.shell(th, head.phiAt(th, y), 0.004, tmp);
      pts.push(hp(tmp.x, tmp.y, tmp.z));
    }
    tube(d.B.garment, new Path(pts, 32), { radius: () => [0.0035, 0.0035], paint: () => ({ c: white, kind: KIND.linen }), weights: headW, seg: 6, steps: 24 });
    return;
  }
  if (hw === 'hood') {
    hood(d);
    return;
  }
  if (hw === 'veil' || hw === 'wimple') {
    veil(d, hw === 'wimple');
  }
}

function hood(d: Dress): void {
  const { C, head, m } = d;
  const c = C.accent;
  const kind = KIND.wool;
  const crown = d.crown;
  const tmp = new THREE.Vector3();
  // Rows from the crown to the shoulder cape; each row is a ring around the head/neck/shoulders.
  // The face opening: an arc left open at the front between the forehead and the chin.
  const openAngle = (y: number) => {
    if (y > 0.215) return 0;
    if (y < -0.005) return 0;
    const k = Math.sin(((y + 0.005) / 0.22) * Math.PI);
    return Math.pow(k, 0.55) * 1.02;
  };
  const vs = [...range(0.28, 0.0, 12), ...range(-0.03, -0.2, 4)];
  const pos = (th: number, y: number, inner: boolean, out: THREE.Vector3) => {
    const off = inner ? -0.006 : 0;
    if (y >= 0.02) {
      // Around the head: a loose shell over the hair, peaked at the back.
      const yy = Math.min(y, 0.262);
      const phi = y > 0.262 ? 0.0001 : head.phiAt(th, yy);
      head.shell(th, phi, crown + 0.018 + off + Math.max(0, -Math.cos(th)) * 0.012, out);
      if (y > 0.262) out.y = 0.262 + crown + 0.02 + off;
      if (y < 0.11) {
        // Below the ears the hood hangs loosely around the jaw, not tight to it.
        const k = smoothstep(0.11, 0.02, y);
        const r = Math.hypot(out.x, out.z);
        const tr = lerp(r, 0.105, k);
        out.x *= tr / r;
        out.z *= tr / r;
      }
      return hp(out.x, out.y, out.z, out);
    }
    // Shoulder cape: from round the neck, down the slope of the shoulders and over the sleeves,
    // dipping to a point at the front and back.
    const k = smoothstep(0.02, -0.2, y);
    const reach = m.shX + 0.05 * m.w;
    const kk = Math.pow(Math.min(1, k / 0.6), 0.65);
    const ripple = 1 + 0.045 * k * Math.sin(th * 11);
    const rx = (lerp(0.095, reach, kk) + off) * ripple;
    const rz = (lerp(0.095, 0.14 * m.w + 0.03, kk) + off) * ripple;
    const [x, z] = superR(th, rx, rz, 2.3);
    const side = Math.abs(Math.sin(th));
    const point = Math.pow(Math.abs(Math.cos(th)), 4) * k * 0.05;
    return out.set(x, HEAD_Y + 0.01 - k * lerp(0.21, 0.17, side) - point, z);
  };
  const us = range(-1, 1, 24);
  const loop = [...us.map((u) => ({ u, inner: false })), ...[...us].reverse().map((u) => ({ u, inner: true }))];
  grid(d.B.garment, {
    us: loop.map((_l, i) => i),
    vs: vs.map((_v, i) => i),
    wrapU: true,
    at: (i, j, out) => {
      const l = loop[Math.round(i)];
      const y = vs[Math.round(j)];
      const oa = openAngle(y);
      const th = Math.PI + l.u * (Math.PI - oa);
      return pos(th, y, l.inner, out);
    },
    paint: (i, j) => {
      const l = loop[Math.round(i)];
      const y = vs[Math.round(j)];
      if (l.inner) return { c: shade(c, 0.55), kind: KIND.linen };
      const edge = Math.abs(l.u) > 0.93 && openAngle(y) > 0.05;
      return { c: edge ? shade(c, 0.85) : c, kind };
    },
    weights: (p) => {
      const y = p.y - HEAD_Y;
      const k = smoothstep(0.04, -0.06, y);
      return [BI.head, 1 - k, BI.spine, k];
    },
  });
  // Liripipe: the long tail hanging down the back.
  head.shell(Math.PI, 0.35, crown + 0.02, tmp);
  const a = hp(tmp.x, tmp.y, tmp.z);
  const pts = [a, a.clone().add(new THREE.Vector3(0, -0.06, -0.05)), a.clone().add(new THREE.Vector3(0.01, -0.22, -0.1)), a.clone().add(new THREE.Vector3(0.02, -0.45, -0.1))];
  tube(d.B.garment, new Path(pts, 24), {
    radius: (t) => {
      const r = lerp(0.03, 0.009, Math.pow(t, 0.6)) * capsuleR(t, 0, 0.05);
      return [r, r];
    },
    paint: () => ({ c: shade(c, 0.95), kind }),
    weights: (p) => {
      const y = p.y - HEAD_Y;
      const k = smoothstep(0.1, -0.12, y);
      return [BI.head, 1 - k, BI.spine, k];
    },
    seg: 10,
    steps: 14,
  });
}

function veil(d: Dress, wimple: boolean): void {
  const { C, head, m } = d;
  const white = col('#f1ece0');
  const c = wimple ? white : mixCol(C.accent, white, 0.35);
  const crown = d.crown;
  // Rows from the crown downward; the front edge frames the face at the forehead and falls
  // beside the cheeks to the shoulders.
  const us = range(-1, 1, 30);
  const loop = [...us.map((u) => ({ u, inner: false })), ...[...us].reverse().map((u) => ({ u, inner: true }))];
  const vs = range(0, 1, 16);
  const frontEdge = (t: number) => lerp(0, 1.35, smoothstep(0.18, 0.5, t));
  const pos = (u: number, t: number, inner: boolean, out: THREE.Vector3) => {
    const fe = frontEdge(t);
    const th = Math.PI + u * (Math.PI - fe);
    const off = (inner ? -0.004 : 0) + crown + 0.01;
    if (t < 0.5) {
      const y = lerp(0.258, 0.1, t / 0.5);
      const phi = t < 0.02 ? 0.001 : head.phiAt(th, Math.min(y, 0.255));
      head.shell(th, phi, off + Math.max(0, -Math.cos(th)) * 0.01, out);
      if (y > 0.255) out.y = Math.max(out.y, y + off);
      return hp(out.x, out.y, out.z, out);
    }
    // Falling part: from ear height down past the shoulders, flaring behind.
    const k = (t - 0.5) / 0.5;
    const y0 = 0.1;
    head.shell(th, head.phiAt(th, y0), off + 0.01, out);
    const r0 = Math.hypot(out.x, out.z);
    const y = lerp(y0, -0.2 - Math.max(0, -Math.cos(th)) * 0.08, k);
    const r = r0 + Math.pow(k, 1.4) * (m.shX * 0.55) + k * 0.02 * Math.sin(u * 12);
    return out.set(Math.sin(th) * r, HEAD_Y + y, Math.cos(th) * r - k * 0.03);
  };
  grid(d.B.garment, {
    us: loop.map((_l, i) => i),
    vs,
    wrapU: true,
    at: (i, t, out) => {
      const l = loop[Math.round(i)];
      return pos(l.u, t, l.inner, out);
    },
    paint: (i) => ({ c: loop[Math.round(i)].inner ? shade(c, 0.7) : c, kind: KIND.linen }),
    weights: (p) => {
      const y = p.y - HEAD_Y;
      const k = smoothstep(0.03, -0.12, y);
      return [BI.head, 1 - k, BI.spine, k];
    },
  });
  if (wimple) {
    // Wimple: linen wrapped under the chin and around the neck, framing the face.
    grid(d.B.garment, {
      us: around(28, -Math.PI),
      vs: range(0, 1, 8),
      wrapU: true,
      at: (th, t, out) => {
        const front = Math.max(0, Math.cos(th));
        // The top edge runs under the chin at the front and up the cheeks at the sides.
        const top = lerp(0.1, 0.012, Math.pow(front, 1.5));
        const y = lerp(top, -0.13, t);
        const rx = lerp(0.09, 0.13, smoothstep(0.0, -0.13, y));
        // At the front it cups the chin, tucks in at the throat and flares onto the chest.
        const rzFront = lerp(0.098, 0.068, smoothstep(0.012, -0.035, y)) + smoothstep(-0.035, -0.13, y) * 0.05;
        const rzSide = lerp(0.078, 0.12, smoothstep(0.0, -0.13, y)) + 0.012;
        const rz = lerp(rzSide, rzFront, Math.pow(front, 2));
        return out.set(Math.sin(th) * rx, HEAD_Y + y - front * 0.02 * t, Math.cos(th) * rz);
      },
      paint: () => ({ c: white, kind: KIND.linen }),
      weights: (p) => {
        const y = p.y - HEAD_Y;
        const k = smoothstep(0.04, -0.1, y);
        return [BI.head, 1 - k, BI.spine, k];
      },
    });
  }
}


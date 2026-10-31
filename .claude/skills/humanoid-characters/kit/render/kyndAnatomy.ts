import type * as THREE from 'three';
import { smoothstep } from './kyndGeometry.ts';

/*
 * The bare torso's anatomy, as relief over the body's smooth shell: how far the skin stands out
 * from (or sinks into) the shell at a point, and how much the crease there is shaded. Collarbones
 * and the notch between them, the breastbone, a man's chest and its lower edge, the arch of the
 * ribs, the abdomen with its centre line, the navel, the hip lines, and at the back the shoulder
 * blades, the muscles either side of the spine and its groove, and the two dimples low on the back.
 * Women's forms are softer: no chest muscle or abdominal lines, the waist and the curve of the
 * lower back carrying the shape. Children have only the shared landmarks, faintly.
 *
 * Points are root-space, at head size 1, for a body of build `w`: x across (± either side),
 * y up, front = the side facing +z.
 */

export interface AnatomyOpts {
  w: number;
  female: boolean;
  /** 0 child … 1 grown. */
  mature: number;
}

/** A soft round bump (or dip): 1 at the centre, falling off over the radii. */
const blob = (dx: number, dy: number, rx: number, ry: number) => Math.exp(-((dx / rx) ** 2) - ((dy / ry) ** 2));
/** A ridge (or groove) along a line, `d` the distance across it. */
const line = (d: number, r: number) => Math.exp(-((d / r) ** 2));

/** Where a man's nipples sit (x either side, y), for a build `w`. */
export const nippleAt = (w: number): [number, number] => [0.086 * w, 1.322];

/**
 * Relief at a point on the torso shell: outward (+) or inward (−), metres. `front` is how much the
 * point faces forward (−1 straight back … 1 straight ahead).
 */
export function anatomyRelief(p: THREE.Vector3, front: number, o: AnatomyOpts): number {
  const { w, female, mature } = o;
  const x = Math.abs(p.x), y = p.y;
  const fr = smoothstep(0.15, 0.6, front);
  const bk = smoothstep(0.15, 0.6, -front);
  const man = female ? 0 : mature;
  let r = 0;
  // --- front ---
  // Collarbones: a ridge from the notch at the base of the throat out toward each shoulder,
  // rising a little as it goes; the hollow just above them.
  const clavY = 1.478 + 0.03 * smoothstep(0.02, 0.15 * w, x);
  const clavOn = smoothstep(0.012, 0.03, x) * smoothstep(0.17 * w, 0.12 * w, x);
  r += fr * clavOn * (0.0042 * line(y - clavY, 0.009) - 0.003 * line(y - clavY - 0.022, 0.012)) * (0.5 + 0.5 * mature);
  // The notch between them.
  r -= fr * 0.006 * blob(x, y - 1.505, 0.018, 0.016);
  // The breastbone, a shallow groove between the chest muscles.
  r -= fr * 0.0035 * line(x, 0.012) * smoothstep(1.2, 1.26, y) * smoothstep(1.47, 1.42, y) * (0.4 + 0.6 * man);
  // A man's chest: two broad plates, full toward the armpit, with a firmer lower edge.
  if (man > 0) {
    const pdx = x - 0.078 * w, pdy = y - 1.335;
    const plate = Math.exp(-((pdx / (0.075 * w)) ** 2)) * (pdy > 0 ? Math.exp(-((pdy / 0.07) ** 2)) : Math.exp(-((pdy / 0.042) ** 4)));
    r += fr * man * 0.011 * plate;
    // The crease under it, curving up toward the armpit.
    const edgeY = 1.29 + 0.25 * Math.max(0, x - 0.09 * w);
    r -= fr * man * 0.0016 * line(y - edgeY, 0.013) * smoothstep(0.02, 0.05, x) * smoothstep(0.17 * w, 0.12 * w, x);
    // The nipple: a small raised point.
    const [nx, ny] = nippleAt(w);
    r += fr * man * 0.0018 * blob(x - nx, y - ny, 0.006, 0.006);
  }
  // A woman's chest is in the shell's own shape; the soft fold beneath it.
  if (female && mature > 0) {
    const foldY = 1.215 + 0.12 * Math.max(0, x - 0.06 * w);
    r -= fr * mature * 0.003 * line(y - foldY, 0.012) * smoothstep(0.015, 0.04, x) * smoothstep(0.15 * w, 0.11 * w, x);
  }
  // The arch of the ribs: a gentle groove from the bottom of the breastbone out and down the sides.
  const archY = 1.215 - 0.85 * Math.max(0, x - 0.015) ** 1.4;
  r -= fr * 0.0024 * line(y - archY, 0.014) * smoothstep(0.01, 0.03, x) * smoothstep(0.15 * w, 0.11 * w, x) * (0.4 + 0.6 * mature);
  // The abdomen: a soft fullness, its centre line, and (for a man) two faint cross-lines.
  r += fr * 0.004 * blob(x, y - 1.06, 0.07 * w, 0.09) * mature;
  r -= fr * 0.0022 * line(x, 0.012) * smoothstep(1.06, 1.1, y) * smoothstep(1.21, 1.17, y) * (0.3 + 0.7 * man);
  if (man > 0) {
    const band = smoothstep(0.012, 0.02, x) * smoothstep(0.07 * w, 0.05 * w, x);
    r -= fr * man * band * 0.0012 * (line(y - 1.165, 0.011) + line(y - 1.115, 0.011));
  }
  // The navel: a small deep dip with a soft rim.
  const nav = blob(x, y - (female ? 1.025 : 1.035), 0.0075, 0.009);
  r += fr * (-0.0075 * nav + 0.0012 * blob(x, y - (female ? 1.025 : 1.035), 0.016, 0.018));
  // The hip lines, running in from the hip bones toward the groin.
  const hipLine = Math.abs(y - (0.885 + 0.9 * (x - 0.035)));
  r -= fr * 0.0024 * line(hipLine, 0.009) * smoothstep(0.03, 0.05, x) * smoothstep(0.13 * w, 0.1 * w, x) * smoothstep(0.83, 0.88, y) * (0.3 + 0.7 * mature);
  // --- back ---
  // Shoulder blades: flat plates, sharper at their inner edges.
  const sbx = x - 0.072 * w, sby = y - 1.36;
  const blade = Math.exp(-((sbx / (0.055 * w)) ** 2) - ((sby / 0.075) ** 2));
  r += bk * 0.0065 * blade * (0.5 + 0.5 * mature);
  r -= bk * 0.0018 * line(x - 0.03 * w, 0.008) * smoothstep(1.28, 1.32, y) * smoothstep(1.44, 1.4, y);
  // The long muscles either side of the spine, and the groove between them.
  const back = smoothstep(0.88, 0.95, y) * smoothstep(1.46, 1.38, y);
  r += bk * back * 0.004 * line(x - 0.03 * w, 0.02);
  r -= bk * back * 0.005 * line(x, 0.009);
  // Two dimples low on the back.
  r -= bk * 0.003 * blob(x - 0.035 * w, y - 0.905, 0.011, 0.012);
  // A woman's lower back curves in a little more.
  if (female) r -= bk * mature * 0.004 * blob(x, y - 0.98, 0.1 * w, 0.06);
  return r;
}

/**
 * How dark the skin is drawn at a point (1 = as is): the creases a little shaded, the navel's
 * hollow and a man's nipples darker. (The lighting gives the rest.)
 */
export function anatomyShade(p: THREE.Vector3, front: number, o: AnatomyOpts): { k: number; nipple: number } {
  const { w, female, mature } = o;
  const x = Math.abs(p.x), y = p.y;
  const fr = smoothstep(0.15, 0.6, front);
  const r = anatomyRelief(p, front, o);
  // Only the deeper creases shade (the lighting draws the gentle ones), and only so much.
  let k = 1 + Math.min(0, r + 0.0018) * 4;
  k -= fr * 0.35 * blob(x, y - (female ? 1.025 : 1.035), 0.005, 0.006);
  let nipple = 0;
  if (!female && mature > 0) {
    const [nx, ny] = nippleAt(w);
    nipple = fr * mature * smoothstep(0.0105, 0.0072, Math.hypot(x - nx, (y - ny) * 1.05));
  }
  return { k: Math.max(0.72, k), nipple };
}

/**
 * The deltoid: how much a point on the torso's side is the rounded cap of the shoulder (0…1), which
 * covers the top of the arm and lifts with it. `side` is how much the point faces sideways.
 */
export function deltoid(p: THREE.Vector3, side: number, shX: number): number {
  const out = smoothstep(0.55, 0.9, Math.abs(side)) * smoothstep(shX * 0.55, shX * 0.85, Math.abs(p.x));
  return out * smoothstep(1.28, 1.38, p.y) * smoothstep(1.52, 1.47, p.y);
}

/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M6): two-bone inverse kinematics. A limb of two segments
 * (thigh and shin, upper arm and forearm, a horse's forearm and cannon) reaching from its root
 * joint toward a target: where the middle joint goes, and the angles that put it there. Plain
 * numbers in and out, so it runs anywhere (no three.js).
 */

export type V3 = [number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The angle at the root between the line to the target and the upper segment (law of cosines),
 * for a target `d` away. `d` should already be within reach (see `reach`).
 */
export function rootAngle(l1: number, l2: number, d: number): number {
  return Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
}

/** A distance kept within what the limb can reach: between |l1 − l2| and l1 + l2, short of either by `eps`. */
export function reach(d: number, l1: number, l2: number, eps = 1e-4): number {
  return clamp(d, Math.abs(l1 - l2) + eps, l1 + l2 - eps);
}

export interface Planar {
  /** Angle of the upper segment and of the lower one, in the plane's own convention (see below). */
  upper: number;
  lower: number;
  /** The middle joint (knee, elbow, hock). */
  mid: [number, number];
}

/**
 * Two-bone IK in a plane (a leg seen from the side). Points are (u, v); an angle θ points the
 * segment along (cos θ, sin θ). `bend` +1 or −1 picks which side of the line from root to target
 * the middle joint goes (a knee forward, a hock back). Returns the absolute angles of both
 * segments and the middle joint. The lower segment points at the end as reached, or (with
 * `lowerToTarget`) at the target itself even when it's out of reach.
 */
export function twoBonePlanar(root: [number, number], target: [number, number], l1: number, l2: number, bend: number, eps = 1e-4, lowerToTarget = false): Planar {
  const du = target[0] - root[0], dv = target[1] - root[1];
  const d0 = Math.hypot(du, dv);
  const d = reach(d0, l1, l2, eps);
  const base = Math.atan2(dv, du);
  const upper = base + bend * rootAngle(l1, l2, d);
  const mid: [number, number] = [root[0] + l1 * Math.cos(upper), root[1] + l1 * Math.sin(upper)];
  // The end as reached (on the line toward the target, at the clamped distance).
  const k = lowerToTarget ? 1 : d0 > 0 ? d / d0 : 0;
  const end = [root[0] + du * k, root[1] + dv * k];
  return { upper, lower: Math.atan2(end[1] - mid[1], end[0] - mid[0]), mid };
}

export interface Spatial {
  /** The middle joint and the end as reached (at the target, or as near as the limb allows). */
  mid: V3;
  end: V3;
}

/**
 * Two-bone IK in space: the middle joint lies in the plane of the root, the target and the `pole`
 * direction (which way the knee or elbow points).
 */
export function twoBone(root: V3, target: V3, l1: number, l2: number, pole: V3, eps = 1e-4): Spatial {
  const to: V3 = [target[0] - root[0], target[1] - root[1], target[2] - root[2]];
  const d0 = Math.hypot(...to);
  const dir: V3 = d0 > 0 ? [to[0] / d0, to[1] / d0, to[2] / d0] : [0, -1, 0];
  const d = reach(d0, l1, l2, eps);
  const a = rootAngle(l1, l2, d);
  // The pole with its component along the limb removed.
  const along = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
  let perp: V3 = [pole[0] - dir[0] * along, pole[1] - dir[1] * along, pole[2] - dir[2] * along];
  const pl = Math.hypot(...perp) || 1;
  perp = [perp[0] / pl, perp[1] / pl, perp[2] / pl];
  const c = Math.cos(a) * l1, s = Math.sin(a) * l1;
  return {
    mid: [root[0] + dir[0] * c + perp[0] * s, root[1] + dir[1] * c + perp[1] * s, root[2] + dir[2] * c + perp[2] * s],
    end: [root[0] + dir[0] * d, root[1] + dir[1] * d, root[2] + dir[2] * d],
  };
}

/**
 * Bending a straight leg of two equal segments (`len` each) to lower its root by `drop` with the
 * foot where it was: how far each segment turns (the hip back by it, the knee forward by twice it).
 */
export function crouchAngle(drop: number, len: number): number {
  return Math.acos(Math.max(-1, 1 - drop / (2 * len)));
}

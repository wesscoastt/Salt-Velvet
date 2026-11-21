/**
 * Ground-plane math. The simulation works in metres on the X/Z plane (Y is up, render-side only).
 *
 * Facing convention (shared with the renderer's `rotation.y`):
 *   facing angle θ  →  forward direction (sin θ, cos θ).
 * Object rotation is stored in quarter turns; local +Z is an object's "front".
 */
export interface Vec2 {
  x: number;
  z: number;
}

export const v2 = (x: number, z: number): Vec2 => ({ x, z });

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) };
}

/** Facing angle that looks from `from` toward `to`. */
export function angleTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/**
 * Rotate a local offset by an object's rotation in quarter turns (matches three.js rotation.y).
 * Whole quarter turns are exact; fractions (0.5 = 45°, or any free angle) rotate smoothly.
 */
export function rotateLocal(local: Vec2, quarterTurns: number): Vec2 {
  const t = (quarterTurns * Math.PI) / 2;
  const whole = Number.isInteger(quarterTurns);
  const c = whole ? Math.round(Math.cos(t)) : Math.cos(t);
  const s = whole ? Math.round(Math.sin(t)) : Math.sin(t);
  return { x: local.x * c + local.z * s, z: -local.x * s + local.z * c };
}

/** Keep a rotation in [0, 4) quarter turns, without float dust from repeated free steps. */
export function normalizeRot(rot: number): number {
  const r = ((rot % 4) + 4) % 4;
  const tidy = Math.round(r * 1e6) / 1e6;
  return tidy >= 4 ? 0 : tidy;
}

/** An oriented rectangle on the ground: centre, half extents along its own axes, rotation. */
export interface Box {
  x: number;
  z: number;
  hw: number;
  hd: number;
  /** Quarter turns, as objects use. */
  rot: number;
}

/** The box's corners in world space. */
export function boxCorners(b: Box): Vec2[] {
  return [
    [-b.hw, -b.hd],
    [b.hw, -b.hd],
    [b.hw, b.hd],
    [-b.hw, b.hd],
  ].map(([x, z]) => {
    const r = rotateLocal({ x, z }, b.rot);
    return { x: b.x + r.x, z: b.z + r.z };
  });
}

/** Axis-aligned bounds of a box. */
export function boxBounds(b: Box): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const cs = boxCorners(b);
  return {
    minX: Math.min(...cs.map((c) => c.x)),
    minZ: Math.min(...cs.map((c) => c.z)),
    maxX: Math.max(...cs.map((c) => c.x)),
    maxZ: Math.max(...cs.map((c) => c.z)),
  };
}

/** A world point in the box's own frame (x along its width, z along its depth). */
export function toBoxLocal(b: Box, p: Vec2): Vec2 {
  return rotateLocal({ x: p.x - b.x, z: p.z - b.z }, -b.rot);
}

/** True if a point lies strictly inside the box grown by `pad` on every side. */
export function boxContains(b: Box, p: Vec2, pad = 0): boolean {
  const l = toBoxLocal(b, p);
  return Math.abs(l.x) < b.hw + pad && Math.abs(l.z) < b.hd + pad;
}

/** Separating-axis test: do two boxes overlap by more than `slack` metres? */
export function boxesOverlap(a: Box, b: Box, slack = 0): boolean {
  const ca = boxCorners(a);
  const cb = boxCorners(b);
  for (const box of [a, b]) {
    const ax = rotateLocal({ x: 1, z: 0 }, box.rot);
    const az = rotateLocal({ x: 0, z: 1 }, box.rot);
    for (const n of [ax, az]) {
      const pa = ca.map((c) => c.x * n.x + c.z * n.z);
      const pb = cb.map((c) => c.x * n.x + c.z * n.z);
      if (Math.max(...pa) - slack <= Math.min(...pb) || Math.max(...pb) - slack <= Math.min(...pa)) return false;
    }
  }
  return true;
}

export function quarterToAngle(quarterTurns: number): number {
  return (quarterTurns * Math.PI) / 2;
}

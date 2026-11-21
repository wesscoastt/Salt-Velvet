/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M6): what every animal model offers the game, whatever its
 * build (a dog, a horse, a cow, a hen), and the clock its gait runs on.
 */

/** A point to look toward (three's Vector3 fits). */
export interface LookPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * An animal's model: a root to place in the scene, a frame's animation for what it's doing, and a
 * point to turn its head toward. `A` is the game's list of activities, `R` the scene object.
 */
export interface RiggedAnimal<A extends string, R = unknown> {
  readonly root: R;
  /**
   * One frame: what it's doing, whether it's moving (and running), the clock and the frame's
   * length in seconds, how far it has walked in all (so feet plant rather than slide), and its
   * traits (a lazy dog ambles).
   */
  animate(activity: A, moving: boolean, running: boolean, time: number, dt: number, distanceWalked?: number, traits?: readonly string[]): void;
  lookAt(p: LookPoint | null): void;
}

/**
 * Gait phases driven by distance walked, not by time, so each foot comes down where the last stride
 * put it: one phase (0…1) per gait, each with its own stride length. A jump in distance (a teleport,
 * the first frame) is clamped so the legs never spin.
 */
export class GaitClock<G extends string> {
  readonly phase: Record<G, number>;
  private strides: Record<G, number>;
  private last = -1;
  private maxStep: number;

  constructor(strides: Record<G, number>, maxStep = 2) {
    this.strides = strides;
    this.maxStep = maxStep;
    this.phase = Object.fromEntries(Object.keys(strides).map((g) => [g, 0])) as Record<G, number>;
  }

  /** Advance to `distance` walked in all, measured in the model's units (`scale` divides it). */
  advance(distance: number, scale = 1): void {
    const d = this.last < 0 ? 0 : Math.max(0, Math.min(this.maxStep, distance - this.last)) / scale;
    this.last = distance;
    for (const g of Object.keys(this.strides) as G[]) this.phase[g] = (this.phase[g] + d / this.strides[g]) % 1;
  }
}

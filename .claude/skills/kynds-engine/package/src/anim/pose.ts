/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M6): poses as named joint values, the layers that build a
 * target pose each frame, easing toward it, and authored clips. A pose is any record of numbers
 * (joint angles, a pelvis height, how far a hand grips), so people and animals share it.
 */

export type Pose<J extends string = string> = Record<J, number>;

/**
 * One layer of the pose graph: it writes over (or adds to) the target the layers before it made.
 * `when` says whether it applies this frame.
 */
export interface PoseLayer<J extends string, C> {
  name: string;
  when?: (ctx: C) => boolean;
  apply: (target: Pose<J>, ctx: C) => void;
}

/**
 * An ordered stack of layers (posture, activity, life, emotion, habit…): each frame they build the
 * target pose from a base, in order. Which ran is recorded, for debugging and tests.
 */
export class PoseGraph<J extends string, C> {
  private layers: PoseLayer<J, C>[] = [];
  /** The layers that applied in the last `evaluate`. */
  readonly ran: string[] = [];
  private base: () => Pose<J>;

  constructor(base: () => Pose<J>) {
    this.base = base;
  }

  add(layer: PoseLayer<J, C>): this {
    if (this.layers.some((l) => l.name === layer.name)) throw new Error(`pose graph: layer '${layer.name}' added twice`);
    this.layers.push(layer);
    return this;
  }

  evaluate(ctx: C): Pose<J> {
    const target = this.base();
    this.ran.length = 0;
    for (const l of this.layers) {
      if (l.when && !l.when(ctx)) continue;
      l.apply(target, ctx);
      this.ran.push(l.name);
    }
    return target;
  }
}

/** Ease `pose` toward `target` by `k` (0…1) on the given joints. */
export function easePose<J extends string>(pose: Pose<J>, target: Pose<J>, joints: readonly J[], k: number): void {
  for (const j of joints) pose[j] += (target[j] - pose[j]) * k;
}

/** The easing factor for a rate (per second) over `dt` seconds: frame-rate independent. */
export function easeFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-dt * rate);
}

/** Blend `b` over `a` by `w` (0 all a … 1 all b) on the given joints, into `out`. */
export function blendPose<J extends string>(out: Pose<J>, a: Pose<J>, b: Partial<Pose<J>>, w: number, joints: readonly J[]): Pose<J> {
  for (const j of joints) {
    const bj = b[j];
    out[j] = bj === undefined ? a[j] : a[j] + (bj - a[j]) * w;
  }
  return out;
}

export interface ClipKey<J extends string> {
  /** Seconds from the clip's start. */
  t: number;
  pose: Partial<Pose<J>>;
}

/**
 * An authored clip: key poses at times, eased between (smoothstep), held at either end or looped.
 * Only the joints a clip names are touched: it can ride over other layers (a wave over a walk).
 */
export class PoseClip<J extends string> {
  readonly length: number;
  readonly name: string;
  readonly keys: ClipKey<J>[];
  readonly loop: boolean;
  constructor(name: string, keys: ClipKey<J>[], loop = false) {
    this.name = name;
    this.keys = keys;
    this.loop = loop;
    if (!keys.length) throw new Error(`pose clip '${name}': no keys`);
    for (let i = 1; i < keys.length; i++) if (keys[i].t <= keys[i - 1].t) throw new Error(`pose clip '${name}': keys out of order`);
    this.length = keys[keys.length - 1].t;
  }

  /** The joints the clip moves. */
  joints(): J[] {
    const s = new Set<J>();
    for (const k of this.keys) for (const j of Object.keys(k.pose) as J[]) s.add(j);
    return [...s];
  }

  /** The clip's pose at time `t` (only its joints), applied over `target` with weight `w`. */
  sample(t: number, target: Pose<J>, w = 1): Pose<J> {
    const keys = this.keys;
    let time = t;
    if (this.loop && this.length > 0) time = ((t % this.length) + this.length) % this.length;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= time) i++;
    const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
    const span = b.t - a.t;
    const x = span > 0 ? Math.min(1, Math.max(0, (time - a.t) / span)) : 0;
    const s = x * x * (3 - 2 * x);
    for (const j of this.joints()) {
      const va = a.pose[j] ?? target[j], vb = b.pose[j] ?? va;
      const v = time <= keys[0].t ? (keys[0].pose[j] ?? target[j]) : va + (vb - va) * s;
      target[j] += (v - target[j]) * w;
    }
    return target;
  }
}

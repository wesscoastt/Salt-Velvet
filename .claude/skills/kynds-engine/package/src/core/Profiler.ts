/*
 * The Kynds Engine profiler (ENGINE_PLAN.md, Milestone 0). Named timing spans and per-frame
 * counters, with rolling averages and peaks, so every later change to the engine is judged by
 * measurement. Headless: no DOM, no three.js, runs in Node (the clock is injectable).
 *
 * Usage, once per frame:
 *   profiler.beginFrame();
 *   profiler.time('sim', () => world.step(dt));       // or begin('sim') … end('sim')
 *   profiler.count('drawCalls', info.render.calls);
 *   profiler.endFrame();
 *   profiler.snapshot()  → { frame, spans: { sim: { avg, peak, last } }, counters: {…} }
 * When disabled every call returns at once and nothing is recorded.
 */

export interface Stat {
  /** Rolling mean over the window (ms for spans). */
  avg: number;
  /** Largest value seen in the window. */
  peak: number;
  /** This frame's (or the last frame's) value. */
  last: number;
}

export interface ProfileSnapshot {
  frames: number;
  /** Whole frames, begin to end (ms). */
  frame: Stat;
  spans: Record<string, Stat>;
  counters: Record<string, Stat>;
}

/** A fixed-size ring of recent values with a running sum. */
class Ring {
  private values: Float64Array;
  private n = 0;
  private i = 0;
  private sum = 0;
  constructor(size: number) {
    this.values = new Float64Array(size);
  }
  push(v: number): void {
    if (this.n === this.values.length) this.sum -= this.values[this.i];
    else this.n++;
    this.values[this.i] = v;
    this.sum += v;
    this.i = (this.i + 1) % this.values.length;
  }
  stat(last: number): Stat {
    let peak = 0;
    for (let k = 0; k < this.n; k++) peak = Math.max(peak, this.values[k]);
    return { avg: this.n ? this.sum / this.n : 0, peak, last };
  }
}

export class Profiler {
  enabled: boolean;
  private readonly window: number;
  private readonly now: () => number;
  private frameStart = -1;
  private frames = 0;
  private frameRing: Ring;
  private lastFrame = 0;
  private open = new Map<string, number>();
  /** This frame's totals (a span entered twice in a frame adds up). */
  private spanFrame = new Map<string, number>();
  private counterFrame = new Map<string, number>();
  private spanRings = new Map<string, Ring>();
  private counterRings = new Map<string, Ring>();
  private spanLast = new Map<string, number>();
  private counterLast = new Map<string, number>();

  constructor(o: { enabled?: boolean; window?: number; now?: () => number } = {}) {
    this.enabled = o.enabled ?? true;
    this.window = Math.max(1, o.window ?? 120);
    this.now = o.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.frameRing = new Ring(this.window);
  }

  beginFrame(): void {
    if (!this.enabled) return;
    this.frameStart = this.now();
    this.spanFrame.clear();
    this.counterFrame.clear();
    this.open.clear();
  }

  begin(name: string): void {
    if (!this.enabled) return;
    this.open.set(name, this.now());
  }

  end(name: string): void {
    if (!this.enabled) return;
    const t0 = this.open.get(name);
    if (t0 === undefined) return;
    this.open.delete(name);
    this.spanFrame.set(name, (this.spanFrame.get(name) ?? 0) + (this.now() - t0));
  }

  /** Time `fn` as span `name` and return its result. */
  time<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();
    this.begin(name);
    try {
      return fn();
    } finally {
      this.end(name);
    }
  }

  /** Set a counter for this frame (draw calls, triangles, jobs run…); repeated calls add up. */
  count(name: string, value: number, add = false): void {
    if (!this.enabled) return;
    this.counterFrame.set(name, (add ? this.counterFrame.get(name) ?? 0 : 0) + value);
  }

  endFrame(): void {
    if (!this.enabled || this.frameStart < 0) return;
    this.lastFrame = this.now() - this.frameStart;
    this.frameRing.push(this.lastFrame);
    this.frames++;
    const fold = (frame: Map<string, number>, rings: Map<string, Ring>, last: Map<string, number>) => {
      // Every known name gets a value each frame (0 when it didn't run), so averages are per frame.
      for (const name of frame.keys()) if (!rings.has(name)) rings.set(name, new Ring(this.window));
      for (const [name, ring] of rings) {
        const v = frame.get(name) ?? 0;
        ring.push(v);
        last.set(name, v);
      }
    };
    fold(this.spanFrame, this.spanRings, this.spanLast);
    fold(this.counterFrame, this.counterRings, this.counterLast);
    this.frameStart = -1;
  }

  snapshot(): ProfileSnapshot {
    const out = (rings: Map<string, Ring>, last: Map<string, number>) => Object.fromEntries([...rings].map(([k, r]) => [k, r.stat(last.get(k) ?? 0)]));
    return { frames: this.frames, frame: this.frameRing.stat(this.lastFrame), spans: out(this.spanRings, this.spanLast), counters: out(this.counterRings, this.counterLast) };
  }

  reset(): void {
    this.frames = 0;
    this.frameRing = new Ring(this.window);
    this.spanRings.clear();
    this.counterRings.clear();
    this.spanLast.clear();
    this.counterLast.clear();
  }
}

/** The game's profiler. Off until something (the dev overlay, the perf report) switches it on. */
export const profiler = new Profiler({ enabled: false });

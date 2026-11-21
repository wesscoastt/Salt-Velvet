/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M2): time-sliced building. A big piece of generation (a lot's
 * scenery and furniture, a cottage, a stretch of kingdom) is written as a generator that `yield`s
 * between steps; the scheduler runs steps from the queue each frame until its time budget is spent,
 * so nothing builds in one long stall (the "pop-in" hitch). Anything that needs a result at once can
 * `finish` its job there and then: the same steps, run back to back.
 *
 * Headless: no three.js, no DOM. The clock is injectable for tests.
 */

export interface JobOptions {
  /** Higher runs first (ties: first queued first). */
  priority?: number;
  /** Called once, when the job's last step has run. */
  onDone?: () => void;
}

interface Job {
  key: string;
  priority: number;
  order: number;
  steps: Iterator<unknown>;
  done: (() => void)[];
}

export class BuildJobs {
  private jobs: Job[] = [];
  private order = 0;
  private readonly now: () => number;
  /** Steps run and time spent since the last `stats()` read (for the profiler overlay). */
  private ran = 0;
  private spent = 0;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /**
   * Queue a job under a key. If one is already queued under that key, the callback joins it (the
   * work is never done twice).
   */
  add(key: string, steps: Iterable<unknown>, opts: JobOptions = {}): void {
    const existing = this.jobs.find((j) => j.key === key);
    if (existing) {
      if (opts.onDone) existing.done.push(opts.onDone);
      if ((opts.priority ?? 0) > existing.priority) existing.priority = opts.priority!;
      return;
    }
    this.jobs.push({ key, priority: opts.priority ?? 0, order: this.order++, steps: steps[Symbol.iterator](), done: opts.onDone ? [opts.onDone] : [] });
  }

  has(key: string): boolean {
    return this.jobs.some((j) => j.key === key);
  }

  get pending(): number {
    return this.jobs.length;
  }

  /** Run a job to the end now (something needs its result this frame). False if there was none. */
  finish(key: string): boolean {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i < 0) return false;
    const job = this.jobs[i];
    this.jobs.splice(i, 1);
    while (!job.steps.next().done);
    for (const cb of job.done) cb();
    return true;
  }

  /** Drop a job that's no longer wanted (its callbacks never run). */
  cancel(key: string): void {
    this.jobs = this.jobs.filter((j) => j.key !== key);
  }

  /**
   * Run steps, most urgent job first, until `budgetMs` has passed (always at least one step, so
   * the queue moves even on a slow frame). Returns the number of steps run.
   */
  tick(budgetMs: number): number {
    if (!this.jobs.length) return 0;
    const start = this.now();
    let steps = 0;
    while (this.jobs.length) {
      let best = 0;
      for (let i = 1; i < this.jobs.length; i++) {
        const a = this.jobs[i], b = this.jobs[best];
        if (a.priority > b.priority || (a.priority === b.priority && a.order < b.order)) best = i;
      }
      const job = this.jobs[best];
      const r = job.steps.next();
      steps++;
      if (r.done) {
        this.jobs.splice(best, 1);
        for (const cb of job.done) cb();
      }
      if (this.now() - start >= budgetMs) break;
    }
    this.ran += steps;
    this.spent += this.now() - start;
    return steps;
  }

  /** Steps run and milliseconds spent since the last call. */
  stats(): { steps: number; ms: number; pending: number } {
    const s = { steps: this.ran, ms: this.spent, pending: this.jobs.length };
    this.ran = 0;
    this.spent = 0;
    return s;
  }
}

/** Run every step of a staged build at once (for code that needs the whole thing now); its result. */
export function runAll<R>(steps: Generator<unknown, R>): R {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

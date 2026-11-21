import { dist, type Vec2 } from '../../core/math.ts';
import type { Cell, NavGrid, StairWay } from './NavGrid.ts';

/** A waypoint reached by climbing (or going down) a staircase: walk `stair` to get there. */
export interface StairPoint extends Vec2 {
  stair?: StairWay;
}

export interface PathOptions {
  /**
   * If true the goal point itself must be walkable; otherwise the path ends at the nearest
   * walkable cell. Use exact goals for object slots so a Kynd never "uses" a chair from across a wall.
   */
  exactGoal?: boolean;
  maxExpanded?: number;
  /** Keep to one floor (animals don't take the stairs). */
  noStairs?: boolean;
  /** (Internal) already retrying from the start cell's centre. */
  fromCentre?: boolean;
}

const SQRT2 = Math.SQRT2;
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/** Binary min-heap keyed on f-score. */
class Heap {
  private items: number[] = [];
  private scores: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, score: number): void {
    this.items.push(item);
    this.scores.push(score);
    let n = this.items.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.scores[p] <= this.scores[n]) break;
      this.swap(n, p);
      n = p;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastScore = this.scores.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.scores[0] = lastScore;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let m = n;
        if (l < this.items.length && this.scores[l] < this.scores[m]) m = l;
        if (r < this.items.length && this.scores[r] < this.scores[m]) m = r;
        if (m === n) break;
        this.swap(n, m);
        n = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.scores[a], this.scores[b]] = [this.scores[b], this.scores[a]];
  }
}

/**
 * The search's working arrays, one set per grid, reset for each search rather than allocated: a
 * busy afternoon is thousands of searches, and the garbage they left was a tenth of the sim's time.
 * (The search never runs inside another, so one set is enough.)
 */
const scratch = new WeakMap<NavGrid, { gScore: Float32Array; cameFrom: Int32Array; closed: Uint8Array }>();

function scratchFor(grid: NavGrid, n: number): { gScore: Float32Array; cameFrom: Int32Array; closed: Uint8Array } {
  let s = scratch.get(grid);
  if (!s || s.closed.length !== n) scratch.set(grid, (s = { gScore: new Float32Array(n), cameFrom: new Int32Array(n), closed: new Uint8Array(n) }));
  s.gScore.fill(Infinity);
  s.cameFrom.fill(-1);
  s.closed.fill(0);
  return s;
}

function octile(a: Cell, b: Cell): number {
  const dx = Math.abs(a.i - b.i);
  const dz = Math.abs(a.j - b.j);
  return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
}

/**
 * A* over the nav grid (8-way, no corner cutting) followed by line-of-sight smoothing.
 * Returns waypoints to walk (excluding the start position), or null if unreachable.
 * Blocked start cells are recovered by stepping to the nearest walkable cell, so a Kynd that
 * ends up inside furniture (e.g. after Build mode) can always walk out.
 */
export function findPath(grid: NavGrid, start: Vec2, goal: Vec2, opts: PathOptions = {}): Vec2[] | null {
  // A walk already found impossible on this grid (same ends, same options) is impossible still:
  // most failed searches are repeats, and a failed search floods everything it can reach.
  const key = `${start.x},${start.z}>${goal.x},${goal.z}|${opts.exactGoal ? 1 : 0}${opts.noStairs ? 1 : 0}${opts.fromCentre ? 1 : 0}|${opts.maxExpanded ?? ''}`;
  if (grid.failedWalks.has(key)) return null;
  const path = search(grid, start, goal, opts);
  if (!path) {
    if (grid.failedWalks.size >= 4096) grid.failedWalks.clear();
    grid.failedWalks.add(key);
  }
  return path;
}

function search(grid: NavGrid, start: Vec2, goal: Vec2, opts: PathOptions): Vec2[] | null {
  const rawStart = grid.cellOf(start);
  const startCell = grid.nearestWalkable(rawStart);
  if (!startCell) return null;

  const rawGoal = grid.cellOf(goal);
  let goalCell: Cell | null;
  let goalPoint: Vec2;
  if (grid.isPointWalkable(goal)) {
    goalCell = rawGoal;
    goalPoint = goal;
  } else {
    if (opts.exactGoal) return null;
    goalCell = grid.nearestWalkable(rawGoal);
    if (!goalCell) return null;
    goalPoint = grid.center(goalCell.i, goalCell.j);
  }

  const prefix: Vec2[] = [];
  if (rawStart.i !== startCell.i || rawStart.j !== startCell.j) {
    prefix.push(grid.center(startCell.i, startCell.j));
  }

  if (startCell.i === goalCell.i && startCell.j === goalCell.j) {
    const from = prefix.length ? prefix[prefix.length - 1] : start;
    return grid.segmentWalkable(from, goalPoint) ? [...prefix, goalPoint] : null;
  }

  // Between floors the straight-line estimate means nothing (the way runs by the stairs): search evenly.
  const cross = (startCell.i >= grid.splitI) !== (goalCell.i >= grid.splitI);
  if (cross && (opts.noStairs || !grid.links.size)) return null;
  const h = (c: Cell) => (cross ? 0 : octile(c, goalCell!));
  const via = new Map<number, StairWay>();
  const w = grid.width;
  const n = grid.width * grid.height;
  const { gScore, cameFrom, closed } = scratchFor(grid, n);
  const open = new Heap();
  const sIdx = grid.index(startCell.i, startCell.j);
  const gIdx = grid.index(goalCell.i, goalCell.j);
  gScore[sIdx] = 0;
  open.push(sIdx, h(startCell));

  const maxExpanded = opts.maxExpanded ?? (cross ? 80000 : 40000);
  let expanded = 0;
  let found = false;

  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    if (cur === gIdx) {
      found = true;
      break;
    }
    closed[cur] = 1;
    if (++expanded > maxExpanded) break;
    const ci = cur % w;
    const cj = (cur - ci) / w;
    for (let dir = 0; dir < 8; dir++) {
      const [di, dj, cost] = NEIGHBOURS[dir];
      const ni = ci + di;
      const nj = cj + dj;
      if (!grid.isWalkable(ni, nj)) continue;
      // No squeezing diagonally between two blocked cells.
      if (di !== 0 && dj !== 0 && (!grid.isWalkable(ci + di, cj) || !grid.isWalkable(ci, cj + dj))) continue;
      const nIdx = grid.index(ni, nj);
      if (closed[nIdx]) continue;
      // Centre to centre (almost every step) is asked once per grid; the ends use the exact points.
      if (cur !== sIdx && nIdx !== gIdx) {
        if (!grid.stepWalkable(ci, cj, dir, di, dj)) continue;
      } else {
        const from = cur === sIdx ? (prefix.length ? prefix[prefix.length - 1] : start) : grid.center(ci, cj);
        const to = nIdx === gIdx ? goalPoint : grid.center(ni, nj);
        if (!grid.segmentWalkable(from, to)) continue;
      }
      const g = gScore[cur] + cost;
      if (g < gScore[nIdx]) {
        gScore[nIdx] = g;
        cameFrom[nIdx] = cur;
        via.delete(nIdx);
        open.push(nIdx, g + h({ i: ni, j: nj }));
      }
    }
    // Up or down a staircase.
    const links = opts.noStairs ? undefined : grid.links.get(cur);
    if (links) {
      for (const l of links) {
        if (closed[l.to] || grid.blocked[l.to]) continue;
        const g = gScore[cur] + l.cost;
        if (g < gScore[l.to]) {
          gScore[l.to] = g;
          cameFrom[l.to] = cur;
          via.set(l.to, l.stair);
          const li = l.to % w;
          open.push(l.to, g + h({ i: li, j: (l.to - li) / w }));
        }
      }
    }
  }

  if (!found) {
    // Hemmed in at the exact spot (left by a chat at a chair's very edge, every first step clipping
    // it): shuffle to the nearest spot clear all round, and set off from there.
    if (prefix.length || opts.fromCentre) return null;
    const clear = grid.nearestClear(start);
    if (!clear || dist(clear, start) < 0.01 || dist(clear, start) > 1.5) return null;
    const rest = findPath(grid, clear, goal, { ...opts, fromCentre: true });
    return rest ? [clear, ...rest] : null;
  }

  const cells: StairPoint[] = [];
  for (let c = gIdx; c !== -1 && c !== sIdx; c = cameFrom[c]) {
    const ci = c % w;
    const p: StairPoint = grid.center(ci, (c - ci) / w);
    const stair = via.get(c);
    // A cell reached up (or down) a flight: the cell before it is the flight's other end.
    if (stair) p.stair = stair;
    cells.push(p);
  }
  cells.reverse();
  const last = cells[cells.length - 1];
  cells[cells.length - 1] = last.stair ? { ...goalPoint, stair: last.stair } : goalPoint;

  const origin = prefix.length ? prefix[prefix.length - 1] : start;
  // Smooth each floor's stretch on its own; a stair waypoint is always kept.
  const out: StairPoint[] = [...prefix];
  let anchor = origin;
  let run: StairPoint[] = [];
  for (const p of cells) {
    if (p.stair) {
      if (run.length) out.push(...smooth(grid, anchor, run));
      out.push(p);
      anchor = p;
      run = [];
    } else run.push(p);
  }
  if (run.length) out.push(...smooth(grid, anchor, run));
  return out;
}

/** Greedy string-pulling: skip every waypoint that has a clear straight line past it. */
function smooth(grid: NavGrid, origin: Vec2, points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  let anchor = origin;
  let i = 0;
  while (i < points.length) {
    let far = i;
    for (let k = points.length - 1; k > i; k--) {
      if (grid.segmentWalkable(anchor, points[k])) {
        far = k;
        break;
      }
    }
    out.push(points[far]);
    anchor = points[far];
    i = far + 1;
  }
  return out;
}

export function pathLength(start: Vec2, path: readonly Vec2[]): number {
  let total = 0;
  let prev = start;
  for (const p of path) {
    total += dist(prev, p);
    prev = p;
  }
  return total;
}

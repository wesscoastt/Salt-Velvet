import { boxBounds, boxContains, type Box, type Vec2 } from '../../core/math.ts';

/** Side of a footprint bucket, metres. */
const BUCKET = 2;

export interface Cell {
  i: number;
  j: number;
}

/** A flight of stairs, in ground-plan metres: walked from `from` to `to` (storeys.ts). */
export interface StairWay {
  from: { x: number; z: number };
  to: { x: number; z: number };
  /** Length of the climb in metres. */
  len: number;
  up: boolean;
}

/** A way between two cells that aren't neighbours: a staircase between floors. */
export interface NavLink {
  to: number;
  cost: number;
  stair: StairWay;
}

/**
 * Walkability grid over one lot. Rebuilt whenever walls or blocking objects change
 * (Build/Buy will call `rebuild` through the world). Cells are `cellSize` metres square.
 */
export class NavGrid {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly blocked: Uint8Array;
  /** Furniture footprints, kept exactly (oriented) for swept-body tests finer than the grid. */
  private rectangles: { box: Box; c: number; s: number }[] = [];
  /** Staircases: cell index → the cells its flights lead to. */
  readonly links = new Map<number, NavLink[]>();
  /** Columns from here east are the upper floor (storeys.ts); Infinity when there is none. */
  splitI = Infinity;
  /**
   * Footprints by 2 m square bucket (built on first use after a change), so a test near one
   * corner of a busy market looks at the furniture there, not at every stall on the lot.
   */
  private buckets: number[][] | null = null;
  private bucketCols = 0;
  private bucketRows = 0;
  /**
   * Whether the straight step from a cell's centre to each of its 8 neighbours' centres is walkable
   * (0 not yet asked, 1 yes, 2 no), kept until the grid changes: A* asks the same steps again and
   * again, and the swept-body test is most of a path's cost.
   */
  private steps: Uint8Array | null = null;
  /** Scratch for a query: which footprints it has already looked at. */
  private seen = new Uint32Array(0);
  private query = 0;

  constructor(worldWidth: number, worldDepth: number, cellSize = 0.5) {
    this.cellSize = cellSize;
    this.width = Math.ceil(worldWidth / cellSize);
    this.height = Math.ceil(worldDepth / cellSize);
    this.blocked = new Uint8Array(this.width * this.height);
  }

  clear(): void {
    this.blocked.fill(0);
    this.rectangles = [];
    this.buckets = null;
    this.changed();
    this.links.clear();
  }

  private bucketIndex(): number[][] {
    if (this.buckets) return this.buckets;
    const cols = (this.bucketCols = Math.ceil((this.width * this.cellSize) / BUCKET) + 1);
    const rows = (this.bucketRows = Math.ceil((this.height * this.cellSize) / BUCKET) + 1);
    const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
    this.rectangles.forEach(({ box }, n) => {
      const b = boxBounds(box);
      const i0 = this.bucketCol(b.minX), i1 = this.bucketCol(b.maxX), j0 = this.bucketRow(b.minZ), j1 = this.bucketRow(b.maxZ);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * cols + i].push(n);
    });
    if (this.seen.length < this.rectangles.length) this.seen = new Uint32Array(this.rectangles.length * 2);
    return (this.buckets = buckets);
  }

  private bucketCol(x: number): number {
    return Math.min(this.bucketCols - 1, Math.max(0, Math.floor(x / BUCKET)));
  }

  private bucketRow(z: number): number {
    return Math.min(this.bucketRows - 1, Math.max(0, Math.floor(z / BUCKET)));
  }

  /** Is this point's cell open (walls, water and the like; furniture is tested exactly elsewhere)? */
  private cellClear(x: number, z: number): boolean {
    const i = Math.floor(x / this.cellSize), j = Math.floor(z / this.cellSize);
    return i >= 0 && j >= 0 && i < this.width && j < this.height && this.blocked[j * this.width + i] === 0;
  }

  /** Join two points with a flight of stairs, both ways. */
  link(a: Vec2, b: Vec2, stair: StairWay): void {
    this.failedWalks.clear();
    const ca = this.cellOf(a), cb = this.cellOf(b);
    if (!this.inBounds(ca.i, ca.j) || !this.inBounds(cb.i, cb.j)) return;
    const ia = this.index(ca.i, ca.j), ib = this.index(cb.i, cb.j);
    const cost = stair.len / this.cellSize;
    (this.links.get(ia) ?? this.links.set(ia, []).get(ia)!).push({ to: ib, cost, stair });
    (this.links.get(ib) ?? this.links.set(ib, []).get(ib)!).push({ to: ia, cost, stair: { from: stair.to, to: stair.from, len: stair.len, up: !stair.up } });
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.width && j < this.height;
  }

  index(i: number, j: number): number {
    return j * this.width + i;
  }

  isWalkable(i: number, j: number): boolean {
    return this.inBounds(i, j) && this.blocked[this.index(i, j)] === 0;
  }

  isPointWalkable(p: Vec2): boolean {
    if (!this.cellClear(p.x, p.z)) return false;
    const buckets = this.bucketIndex();
    for (const n of buckets[this.bucketRow(p.z) * this.bucketCols + this.bucketCol(p.x)]) {
      const r = this.rectangles[n];
      const dx = p.x - r.box.x;
      const dz = p.z - r.box.z;
      if (Math.abs(dx * r.c - dz * r.s) < r.box.hw && Math.abs(dx * r.s + dz * r.c) < r.box.hd) return false;
    }
    return true;
  }

  setBlocked(i: number, j: number, value: boolean): void {
    if (this.inBounds(i, j)) this.blocked[this.index(i, j)] = value ? 1 : 0;
    this.changed();
  }

  /**
   * Walks asked for and found impossible, by their exact ends and options (see `findPath`), kept
   * until the grid changes: Kynd Autonomy asks after the same unreachable spot again and again.
   */
  readonly failedWalks = new Set<string>();

  /** The grid changed: forget everything worked out from it. */
  private changed(): void {
    this.steps = null;
    this.failedWalks.clear();
  }

  /**
   * `segmentWalkable` (at the default body radius) from the centre of cell (i, j) to the centre of
   * its neighbour in direction `dir` (0–7, any fixed numbering of the 8 offsets (di, dj)), answered
   * once per grid state.
   */
  stepWalkable(i: number, j: number, dir: number, di: number, dj: number): boolean {
    const k = this.index(i, j) * 8 + dir;
    const steps = (this.steps ??= new Uint8Array(this.width * this.height * 8));
    let v = steps[k];
    if (v === 0) {
      v = this.segmentWalkable(this.center(i, j), this.center(i + di, j + dj)) ? 1 : 2;
      steps[k] = v;
    }
    return v === 1;
  }

  cellOf(p: Vec2): Cell {
    return { i: Math.floor(p.x / this.cellSize), j: Math.floor(p.z / this.cellSize) };
  }

  center(i: number, j: number): Vec2 {
    return { x: (i + 0.5) * this.cellSize, z: (j + 0.5) * this.cellSize };
  }

  /** Block every cell whose centre lies inside the axis-aligned rectangle (and at least the centre cell). */
  blockRect(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.blockBox({ x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, hw: (maxX - minX) / 2, hd: (maxZ - minZ) / 2, rot: 0 });
  }

  /** Block every cell whose centre lies inside an oriented footprint (and at least its centre cell). */
  blockBox(box: Box): void {
    const t = (box.rot * Math.PI) / 2;
    const whole = Number.isInteger(box.rot);
    this.rectangles.push({ box, c: whole ? Math.round(Math.cos(t)) : Math.cos(t), s: whole ? Math.round(Math.sin(t)) : Math.sin(t) });
    this.buckets = null;
    this.changed();
    const b = boxBounds(box);
    const cs = this.cellSize;
    let any = false;
    for (let j = Math.floor(b.minZ / cs); j <= Math.floor(b.maxZ / cs); j++) {
      for (let i = Math.floor(b.minX / cs); i <= Math.floor(b.maxX / cs); i++) {
        if (boxContains(box, this.center(i, j))) {
          this.setBlocked(i, j, true);
          any = true;
        }
      }
    }
    if (!any) {
      const c = this.cellOf(box);
      this.setBlocked(c.i, c.j, true);
    }
  }

  /**
   * Cells that some footprint comes within `pad` metres of. A straight step between two cells
   * that are both clear of every footprint can't be blocked by one (used to skip sweep tests).
   */
  nearFootprints(pad = 0.25): Uint8Array {
    const near = new Uint8Array(this.width * this.height);
    const cs = this.cellSize;
    for (const { box } of this.rectangles) {
      const b = boxBounds(box);
      for (let j = Math.max(0, Math.floor((b.minZ - pad) / cs)); j <= Math.min(this.height - 1, Math.floor((b.maxZ + pad) / cs)); j++) {
        for (let i = Math.max(0, Math.floor((b.minX - pad) / cs)); i <= Math.min(this.width - 1, Math.floor((b.maxX + pad) / cs)); i++) near[this.index(i, j)] = 1;
      }
    }
    return near;
  }

  /** Breadth-first search outward for the nearest walkable cell. */
  nearestWalkable(start: Cell, maxRadius = 12): Cell | null {
    if (this.isWalkable(start.i, start.j)) return start;
    for (let r = 1; r <= maxRadius; r++) {
      let best: Cell | null = null;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = start.i + di;
          const j = start.j + dj;
          if (!this.isWalkable(i, j)) continue;
          const d = di * di + dj * dj;
          if (d < bestD) {
            bestD = d;
            best = { i, j };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** True if a Kynd's body (`radius`) standing at `p` overlaps no furniture or wall. */
  isClear(p: Vec2, radius = 0.18): boolean {
    return this.segmentWalkable(p, p, radius);
  }

  /** The nearest spot to `p` where a Kynd can stand clear of everything (cell centres, nearest first). */
  nearestClear(p: Vec2, radius = 0.18, maxRadius = 12): Vec2 | null {
    const start = this.cellOf(p);
    for (let r = 0; r <= maxRadius; r++) {
      let best: Vec2 | null = null;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !this.isWalkable(start.i + di, start.j + dj)) continue;
          const c = this.center(start.i + di, start.j + dj);
          const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
          if (d < bestD && this.isClear(c, radius)) {
            bestD = d;
            best = c;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * True if a Kynd (≈0.2 m radius) can walk the straight segment a→b.
   * Samples the centre line and two offset lines so paths don't clip wall corners.
   */
  segmentWalkable(a: Vec2, b: Vec2, radius = 0.18): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    // Continuous swept-body test: sub-cell furniture edges cannot disappear
    // between sample points or be rounded away by the navigation raster. Only footprints near
    // the segment can touch it (a turned one reaches at most radius·√2 past its bounds).
    const buckets = this.bucketIndex();
    const pad = radius * 1.5 + 0.01;
    const i0 = this.bucketCol(Math.min(a.x, b.x) - pad), i1 = this.bucketCol(Math.max(a.x, b.x) + pad);
    const j0 = this.bucketRow(Math.min(a.z, b.z) - pad), j1 = this.bucketRow(Math.max(a.z, b.z) + pad);
    const q = ++this.query;
    for (let bj = j0; bj <= j1; bj++) for (let bi = i0; bi <= i1; bi++) for (const n of buckets[bj * this.bucketCols + bi]) {
      if (this.seen[n] === q) continue;
      this.seen[n] = q;
      const { box: r, c: rc, s: rs } = this.rectangles[n];
      // Slab test in the footprint's own frame, so rotated furniture is swept exactly too.
      const ax = a.x - r.x;
      const az = a.z - r.z;
      const lax = ax * rc - az * rs;
      const laz = ax * rs + az * rc;
      const ldx = dx * rc - dz * rs;
      const ldz = dx * rs + dz * rc;
      const hx = r.hw + radius;
      const hz = r.hd + radius;
      let enter = 0, exit = 1;
      if (Math.abs(ldx) < 1e-10) {
        if (lax <= -hx || lax >= hx) continue;
      } else {
        const t0 = (-hx - lax) / ldx, t1 = (hx - lax) / ldx;
        enter = Math.max(enter, Math.min(t0, t1));
        exit = Math.min(exit, Math.max(t0, t1));
      }
      if (Math.abs(ldz) < 1e-10) {
        if (laz <= -hz || laz >= hz) continue;
      } else {
        const t0 = (-hz - laz) / ldz, t1 = (hz - laz) / ldz;
        enter = Math.max(enter, Math.min(t0, t1));
        exit = Math.min(exit, Math.max(t0, t1));
      }
      if (enter < exit) return false;
    }
    if (len < 1e-6) return this.isPointWalkable(a);
    const nx = (-dz / len) * radius;
    const nz = (dx / len) * radius;
    const steps = Math.ceil(len / (this.cellSize * 0.25));
    // The sweep above has ruled out every footprint within the body's radius, so the samples
    // only need the raster (walls and other blocked cells).
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      if (!this.cellClear(x, z) || !this.cellClear(x + nx, z + nz) || !this.cellClear(x - nx, z - nz)) return false;
    }
    return true;
  }
}

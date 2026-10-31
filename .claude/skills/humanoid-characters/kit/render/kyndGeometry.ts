import * as THREE from 'three';

/*
 * Geometry toolkit for Kynd avatars. Every visible part of a Kynd (skin, cloth, hair, eyes, metal)
 * is generated procedurally as a smooth parametric surface and written, already skinned, into one
 * "bucket" per material. Each bucket becomes a single SkinnedMesh driven by the avatar's bones, so a
 * whole Kynd costs a handful of draw calls however many layers of clothing they wear.
 *
 * Surfaces are grids over two parameters (u around, v along). Repeating a parameter value makes a
 * crisp seam: the two copies share a position but are painted on either side of it, which is how
 * trim bands, hems and cuffs get sharp edges without extra materials. Normals are smoothed across
 * those seams and across poles, so nothing looks faceted.
 */

/** Flat list of [boneIndex, weight, boneIndex, weight, ...]. */
export type Weights = number[];

export interface Paint {
  /** Linear RGB. */
  c: THREE.Color;
  /** Material kind inside the bucket (see KIND). */
  kind?: number;
  /** Secondary colour (embroidery thread, heraldic charge). */
  c2?: THREE.Color;
}

/** Surface kinds understood by the garment shader. */
export const KIND = {
  wool: 0,
  linen: 1,
  velvet: 2,
  leather: 3,
  fur: 4,
  straw: 5,
  embroidery: 6,
  charge: 7,
} as const;

export class Bucket {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  col2: number[] = [];
  uv: number[] = [];
  kind: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** `withExtras` adds the garment shader's kind and secondary colour; `withCol2` the colour alone. */
  toGeometry(withExtras: boolean, withCol2 = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (withExtras) g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    if (withExtras || withCol2) g.setAttribute('aCol2', new THREE.Float32BufferAttribute(this.col2, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    return g;
  }
}

const _wb = new Int32Array(16);
const _ww = new Float64Array(16);

/** Add an authored triangle mesh to the same coloured, skinned batching as procedural surfaces. */
export function appendAuthoredMesh(b: Bucket, positions: readonly number[], indices: readonly number[],
  transform: (p: THREE.Vector3) => THREE.Vector3, paint: (p: THREE.Vector3) => Paint,
  weights: (p: THREE.Vector3) => Weights): void {
  const base = b.vertexCount;
  const points: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    transform(p.set(positions[i], positions[i + 1], positions[i + 2]));
    points.push(p.x, p.y, p.z);
    b.pos.push(p.x, p.y, p.z);
    const color = paint(p), secondary = color.c2 ?? color.c;
    b.col.push(color.c.r, color.c.g, color.c.b);
    b.col2.push(secondary.r, secondary.g, secondary.b);
    b.kind.push(color.kind ?? KIND.wool);
    b.uv.push(Math.atan2(p.x, p.z) / (Math.PI * 2) * 4, p.y * 4);
    pushWeights(b, weights(p));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  g.setIndex([...indices]);
  g.computeVertexNormals();
  const normal = g.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) b.nrm.push(normal.getX(i), normal.getY(i), normal.getZ(i));
  for (const i of indices) b.idx.push(base + i);
  g.dispose();
}

/** Keep the four strongest influences and normalise them. */
export function pushWeights(b: Bucket, w: Weights): void {
  let n = 0;
  for (let i = 0; i < w.length; i += 2) {
    const wt = w[i + 1];
    if (!(wt > 1e-4)) continue;
    let k = 0;
    while (k < n && _wb[k] !== w[i]) k++;
    if (k < n) _ww[k] += wt;
    else if (n < 16) {
      _wb[n] = w[i];
      _ww[n] = wt;
      n++;
    }
  }
  // Partial selection sort for the top four.
  const m = Math.min(4, n);
  for (let a = 0; a < m; a++) {
    let best = a;
    for (let c = a + 1; c < n; c++) if (_ww[c] > _ww[best]) best = c;
    if (best !== a) {
      const tb = _wb[a];
      _wb[a] = _wb[best];
      _wb[best] = tb;
      const tw = _ww[a];
      _ww[a] = _ww[best];
      _ww[best] = tw;
    }
  }
  let sum = 0;
  for (let a = 0; a < m; a++) sum += _ww[a];
  if (sum <= 0) sum = 1;
  for (let k = 0; k < 4; k++) {
    b.si.push(k < m ? _wb[k] : 0);
    b.sw.push(k < m ? _ww[k] / sum : k === 0 ? 1 : 0);
  }
}

export interface GridSpec {
  /** Samples of the first parameter (around). Repeat a value for a crisp seam. */
  us: number[];
  /** Samples of the second parameter (along). Repeat a value for a crisp seam. */
  vs: number[];
  /** Connect the last `u` column back to the first (closed tube). */
  wrapU?: boolean;
  /** Position in root space. */
  at(u: number, v: number, out: THREE.Vector3): void;
  paint(u: number, v: number, p: THREE.Vector3): Paint;
  weights(p: THREE.Vector3, u: number, v: number): Weights;
  uv?(u: number, v: number, p: THREE.Vector3): [number, number];
  /** Reverse the winding (inside surfaces). */
  flip?: boolean;
  /** For grids whose `vs` are row indices: the value each row stands for (repeats are seams). */
  vKey?: (v: number) => number;
}

const EPS = 1e-4;

/** Nudge repeated samples to either side of their seam. */
function nudged(values: number[]): number[] {
  return values.map((x, i) => {
    if (i + 1 < values.length && values[i + 1] === x) return x - EPS;
    if (i > 0 && values[i - 1] === x) return x + EPS;
    return x;
  });
}

const _p = new THREE.Vector3();

/** Append a parametric grid surface to a bucket. */
export function grid(b: Bucket, s: GridSpec): void {
  const us = nudged(s.us);
  const vs = nudged(s.vs);
  const nu = us.length;
  const nv = vs.length;
  const base = b.vertexCount;
  const P: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      s.at(us[i], vs[j], _p);
      P.push(_p.x, _p.y, _p.z);
      const paint = s.paint(us[i], vs[j], _p);
      b.pos.push(_p.x, _p.y, _p.z);
      b.col.push(paint.c.r, paint.c.g, paint.c.b);
      const c2 = paint.c2 ?? paint.c;
      b.col2.push(c2.r, c2.g, c2.b);
      b.kind.push(paint.kind ?? 0);
      const uv = s.uv ? s.uv(us[i], vs[j], _p) : [0, 0];
      b.uv.push(uv[0], uv[1]);
      pushWeights(b, s.weights(_p, us[i], vs[j]));
    }
  }
  const cols = s.wrapU ? nu : nu - 1;
  const local: number[] = [];
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < cols; i++) {
      const i2 = (i + 1) % nu;
      const a = j * nu + i;
      const bb = j * nu + i2;
      const c = (j + 1) * nu + i;
      const d = (j + 1) * nu + i2;
      if (s.flip) local.push(a, bb, c, bb, d, c);
      else local.push(a, c, bb, bb, c, d);
    }
  }
  const N = faceNormals(P, local);
  // Smooth across repeated seams and poles: average normals of coincident vertices in a row/column.
  const weld = (ia: number, ib: number) => {
    const dx = P[ia * 3] - P[ib * 3];
    const dy = P[ia * 3 + 1] - P[ib * 3 + 1];
    const dz = P[ia * 3 + 2] - P[ib * 3 + 2];
    if (dx * dx + dy * dy + dz * dz > 1e-6) return;
    for (let k = 0; k < 3; k++) {
      const m = N[ia * 3 + k] + N[ib * 3 + k];
      N[ia * 3 + k] = m;
      N[ib * 3 + k] = m;
    }
  };
  for (let i = 0; i + 1 < nu; i++) if (s.us[i] === s.us[i + 1]) for (let j = 0; j < nv; j++) weld(j * nu + i, j * nu + i + 1);
  if (!s.wrapU) {
    // An open surface whose ends meet (a seam at the back) still shades smoothly.
    for (let j = 0; j < nv; j++) weld(j * nu, j * nu + nu - 1);
  }
  const vk = s.vKey ? s.vs.map(s.vKey) : s.vs;
  for (let j = 0; j + 1 < nv; j++) if (vk[j] === vk[j + 1]) for (let i = 0; i < nu; i++) weld(j * nu + i, (j + 1) * nu + i);
  for (let j = 0; j < nv; j++) {
    // Pole rows (all points coincide): one shared normal.
    let pole = true;
    for (let i = 1; i < nu && pole; i++) {
      const dx = P[(j * nu + i) * 3] - P[j * nu * 3];
      const dy = P[(j * nu + i) * 3 + 1] - P[j * nu * 3 + 1];
      const dz = P[(j * nu + i) * 3 + 2] - P[j * nu * 3 + 2];
      if (dx * dx + dy * dy + dz * dz > 1e-9) pole = false;
    }
    if (!pole) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < nu; i++) {
      x += N[(j * nu + i) * 3];
      y += N[(j * nu + i) * 3 + 1];
      z += N[(j * nu + i) * 3 + 2];
    }
    for (let i = 0; i < nu; i++) {
      N[(j * nu + i) * 3] = x;
      N[(j * nu + i) * 3 + 1] = y;
      N[(j * nu + i) * 3 + 2] = z;
    }
  }
  for (let k = 0; k < N.length; k += 3) {
    const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1;
    b.nrm.push(N[k] / l, N[k + 1] / l, N[k + 2] / l);
  }
  for (const k of local) b.idx.push(base + k);
}

export interface RowMeshSpec {
  /**
   * Rows of samples, in order along the second parameter. Each row has its own sorted first-
   * parameter samples, so detail can be dense where it is needed (round the eyes, nose and lips)
   * and sparse elsewhere; neighbouring rows are zipped together whatever their sample counts. A
   * row with one sample is a pole.
   */
  rows: { us: number[]; v: number }[];
  at(u: number, v: number, out: THREE.Vector3): void;
  paint(u: number, v: number, p: THREE.Vector3): Paint;
  weights(p: THREE.Vector3, u: number, v: number): Weights;
  uv?(u: number, v: number, p: THREE.Vector3): [number, number];
  /**
   * The surface's own normal at a sample, if known (into `out`; return false where it isn't, such
   * as at a pole). Shading from the true surface rather than the triangles keeps changes in row
   * density from showing as lines across the surface.
   */
  normal?(u: number, v: number, out: THREE.Vector3): boolean;
  /** Leave out the triangles between rows `r` and `r + 1` whose centre is at `x` (an opening). */
  gap?(r: number, x: number): boolean;
}

/** Append a surface built from rows of varying density (see RowMeshSpec). */
export function rowMesh(b: Bucket, s: RowMeshSpec): void {
  const base = b.vertexCount;
  const P: number[] = [];
  const start: number[] = [];
  for (const row of s.rows) {
    start.push(P.length / 3);
    for (const u of row.us) {
      s.at(u, row.v, _p);
      P.push(_p.x, _p.y, _p.z);
      const paint = s.paint(u, row.v, _p);
      b.pos.push(_p.x, _p.y, _p.z);
      b.col.push(paint.c.r, paint.c.g, paint.c.b);
      const c2 = paint.c2 ?? paint.c;
      b.col2.push(c2.r, c2.g, c2.b);
      b.kind.push(paint.kind ?? 0);
      const uv = s.uv ? s.uv(u, row.v, _p) : [0, 0];
      b.uv.push(uv[0], uv[1]);
      pushWeights(b, s.weights(_p, u, row.v));
    }
  }
  const local: number[] = [];
  for (let r = 0; r + 1 < s.rows.length; r++) {
    const A = s.rows[r].us;
    const B = s.rows[r + 1].us;
    const a0 = start[r];
    const b0 = start[r + 1];
    let i = 0;
    let j = 0;
    // Zip the two rows: always advance along whichever row's next sample comes first.
    while (i < A.length - 1 || j < B.length - 1) {
      const advanceA = j >= B.length - 1 || (i < A.length - 1 && A[i + 1] < B[j + 1]);
      const tri = advanceA ? [a0 + i, b0 + j, a0 + i + 1] : [a0 + i, b0 + j, b0 + j + 1];
      if (!s.gap || !s.gap(r, (P[tri[0] * 3] + P[tri[1] * 3] + P[tri[2] * 3]) / 3)) local.push(...tri);
      if (advanceA) i++;
      else j++;
    }
  }
  const N = faceNormals(P, local);
  // Rows that close on themselves (first and last sample coincide) shade smoothly across the join.
  for (let r = 0; r < s.rows.length; r++) {
    const ia = start[r];
    const ib = start[r] + s.rows[r].us.length - 1;
    if (ib === ia) continue;
    const dx = P[ia * 3] - P[ib * 3];
    const dy = P[ia * 3 + 1] - P[ib * 3 + 1];
    const dz = P[ia * 3 + 2] - P[ib * 3 + 2];
    if (dx * dx + dy * dy + dz * dz > 1e-10) continue;
    for (let k = 0; k < 3; k++) {
      const m = N[ia * 3 + k] + N[ib * 3 + k];
      N[ia * 3 + k] = m;
      N[ib * 3 + k] = m;
    }
  }
  if (s.normal) {
    const n = new THREE.Vector3();
    s.rows.forEach((row, r) => row.us.forEach((u, i) => {
      const k = (start[r] + i) * 3;
      if (!s.normal!(u, row.v, n)) return;
      // (Facing the same way as the mesh's own, whichever way the surface was parametrised.)
      const flip = n.x * N[k] + n.y * N[k + 1] + n.z * N[k + 2] < 0 ? -1 : 1;
      N[k] = n.x * flip;
      N[k + 1] = n.y * flip;
      N[k + 2] = n.z * flip;
    }));
  }
  for (let k = 0; k < N.length; k += 3) {
    const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1;
    b.nrm.push(N[k] / l, N[k + 1] / l, N[k + 2] / l);
  }
  for (const k of local) b.idx.push(base + k);
}

function faceNormals(P: number[], idx: number[]): number[] {
  const N = new Array<number>(P.length).fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const e1x = P[b] - P[a];
    const e1y = P[b + 1] - P[a + 1];
    const e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a];
    const e2y = P[c + 1] - P[a + 1];
    const e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      N[v] += nx;
      N[v + 1] += ny;
      N[v + 2] += nz;
    }
  }
  return N;
}

// --- helpers --------------------------------------------------------------------------------

export function range(a: number, b: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

/** `n` evenly spaced angles around a full turn (for wrapped surfaces: no repeat of 2π). */
export function around(n: number, start = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(start + (Math.PI * 2 * i) / n);
  return out;
}

/** Merge sorted sample lists and insert seam values (each seam value appears twice). */
export function withSeams(samples: number[], seams: number[]): number[] {
  const out = samples.filter((x) => !seams.some((s) => Math.abs(s - x) < 1e-6));
  for (const s of seams) out.push(s, s);
  return out.sort((a, b) => a - b);
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x <= -Math.PI) x += Math.PI * 2;
  return x;
}

/**
 * A smooth profile through (y, value) keys: monotone cubic interpolation, so silhouettes built
 * from a handful of measurements have no creases at the keys.
 */
export class Profile {
  private ys: number[];
  private vs: number[];
  private ms: number[];

  constructor(keys: [number, number][]) {
    const k = [...keys].sort((a, b) => a[0] - b[0]);
    this.ys = k.map((p) => p[0]);
    this.vs = k.map((p) => p[1]);
    const n = k.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) d.push((this.vs[i + 1] - this.vs[i]) / (this.ys[i + 1] - this.ys[i]));
    const m: number[] = new Array(n).fill(0);
    if (n > 1) {
      m[0] = d[0];
      m[n - 1] = d[n - 2];
      for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
      for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) {
          m[i] = 0;
          m[i + 1] = 0;
          continue;
        }
        const a = m[i] / d[i];
        const b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
          const t = 3 / Math.sqrt(s);
          m[i] = t * a * d[i];
          m[i + 1] = t * b * d[i];
        }
      }
    }
    this.ms = m;
  }

  at(y: number): number {
    const { ys, vs, ms } = this;
    const n = ys.length;
    if (y <= ys[0]) return vs[0];
    if (y >= ys[n - 1]) return vs[n - 1];
    let i = 0;
    while (i < n - 2 && y > ys[i + 1]) i++;
    const h = ys[i + 1] - ys[i];
    const t = (y - ys[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * vs[i] + (t3 - 2 * t2 + t) * h * ms[i] + (-2 * t3 + 3 * t2) * vs[i + 1] + (t3 - t2) * h * ms[i + 1];
  }
}

/** Superellipse radius multiplier for an angle: exponent 2 is an ellipse, higher is boxier. */
export function superR(theta: number, rx: number, rz: number, e: number): [number, number] {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const k = Math.pow(Math.pow(Math.abs(s), e) + Math.pow(Math.abs(c), e), -1 / e);
  return [s * k * rx, c * k * rz];
}

/**
 * A path for tubes (hair locks, braids, straps, laces, feet): Catmull-Rom through the points with
 * rotation-minimising frames, sampled at `t` in [0, 1].
 */
export class Path {
  private pts: THREE.Vector3[] = [];
  private tan: THREE.Vector3[] = [];
  private nor: THREE.Vector3[] = [];
  private bin: THREE.Vector3[] = [];
  private n: number;

  constructor(points: THREE.Vector3[], samples = 32, up = new THREE.Vector3(0, 0, 1)) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    this.n = samples;
    // Parametric (not arc-length) sampling: plenty even for these short curves, and much cheaper.
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      this.pts.push(curve.getPoint(t));
      this.tan.push(curve.getTangent(t).normalize());
    }
    // Initial normal: the `up` hint made perpendicular to the first tangent.
    let nrm = up.clone().sub(this.tan[0].clone().multiplyScalar(up.dot(this.tan[0])));
    if (nrm.lengthSq() < 1e-6) nrm = new THREE.Vector3(1, 0, 0).cross(this.tan[0]);
    nrm.normalize();
    for (let i = 0; i <= samples; i++) {
      if (i > 0) {
        const axis = this.tan[i - 1].clone().cross(this.tan[i]);
        const len = axis.length();
        if (len > 1e-6) {
          const ang = Math.asin(Math.min(1, len));
          nrm.applyAxisAngle(axis.normalize(), ang);
        }
        nrm.sub(this.tan[i].clone().multiplyScalar(nrm.dot(this.tan[i]))).normalize();
      }
      this.nor.push(nrm.clone());
      this.bin.push(this.tan[i].clone().cross(nrm).normalize());
    }
  }

  /** Point on a tube around the path: `a` across (along the normal), `b` along the binormal. */
  frame(t: number, a: number, b: number, out: THREE.Vector3): THREE.Vector3 {
    const f = Math.max(0, Math.min(1, t)) * this.n;
    const i = Math.min(this.n - 1, Math.floor(f));
    const k = f - i;
    const p0 = this.pts[i];
    const p1 = this.pts[i + 1];
    const n0 = this.nor[i];
    const n1 = this.nor[i + 1];
    const b0 = this.bin[i];
    const b1 = this.bin[i + 1];
    out.set(
      lerp(p0.x, p1.x, k) + lerp(n0.x, n1.x, k) * a + lerp(b0.x, b1.x, k) * b,
      lerp(p0.y, p1.y, k) + lerp(n0.y, n1.y, k) * a + lerp(b0.y, b1.y, k) * b,
      lerp(p0.z, p1.z, k) + lerp(n0.z, n1.z, k) * a + lerp(b0.z, b1.z, k) * b,
    );
    return out;
  }

  point(t: number, out = new THREE.Vector3()): THREE.Vector3 {
    return this.frame(t, 0, 0, out);
  }
}

export interface TubeOptions {
  /** Cross-section radii at `t` (along the normal, along the binormal). */
  radius: (t: number, theta: number) => [number, number];
  paint: (t: number, theta: number, p: THREE.Vector3) => Paint;
  weights: (p: THREE.Vector3, t: number) => Weights;
  seg?: number;
  steps?: number;
  /** Extra seams along the tube (crisp colour bands). */
  seams?: number[];
  /** UV per vertex (default: around × along). */
  uv?: (t: number, theta: number) => [number, number];
  /** Only build this part of the path (t from, t to). */
  span?: [number, number];
}

/** A closed, capped tube along a path. Radius 0 at either end makes a rounded or pointed tip. */
export function tube(b: Bucket, path: Path, o: TubeOptions): void {
  const seg = o.seg ?? 10;
  const steps = o.steps ?? 16;
  grid(b, {
    us: range(0, Math.PI * 2, seg).slice(0, seg),
    vs: withSeams(range(o.span ? o.span[0] : 0, o.span ? o.span[1] : 1, steps), o.seams ?? []),
    wrapU: true,
    flip: true,
    at: (theta, t, out) => {
      const [ra, rb] = o.radius(t, theta);
      path.frame(t, Math.cos(theta) * ra, Math.sin(theta) * rb, out);
    },
    paint: (theta, t, p) => o.paint(t, theta, p),
    weights: (p, _theta, t) => o.weights(p, t),
    uv: o.uv ? (theta, t) => o.uv!(t, theta) : (theta, t) => [theta / (Math.PI * 2), t],
  });
}

/** Rounded capsule radius profile for tubes: full radius in the middle, closed at both ends. */
export function capsuleR(t: number, capA = 0.12, capB = 0.12): number {
  if (t < capA) return Math.sqrt(Math.max(0, 1 - Math.pow(1 - t / capA, 2)));
  if (t > 1 - capB) return Math.sqrt(Math.max(0, 1 - Math.pow((t - (1 - capB)) / capB, 2)));
  return 1;
}

/** An ellipsoid (rx, ry, rz) as a grid, centred at `c`, with optional axis rotation. */
export function ellipsoid(
  b: Bucket,
  c: THREE.Vector3,
  r: [number, number, number],
  paint: (p: THREE.Vector3, n: THREE.Vector3) => Paint,
  weights: (p: THREE.Vector3) => Weights,
  seg = 14,
  rings = 10,
  rot?: THREE.Euler,
): void {
  const q = rot ? new THREE.Quaternion().setFromEuler(rot) : null;
  const n = new THREE.Vector3();
  grid(b, {
    us: around(seg),
    vs: range(0, Math.PI, rings),
    wrapU: true,
    at: (u, v, out) => {
      n.set(Math.sin(v) * Math.sin(u), Math.cos(v), Math.sin(v) * Math.cos(u));
      out.set(n.x * r[0], n.y * r[1], n.z * r[2]);
      if (q) out.applyQuaternion(q);
      out.add(c);
    },
    paint: (u, v, p) => {
      n.set(Math.sin(v) * Math.sin(u), Math.cos(v), Math.sin(v) * Math.cos(u));
      if (q) n.applyQuaternion(q);
      return paint(p, n);
    },
    weights: (p) => weights(p),
  });
}

export function col(hex: string | THREE.Color): THREE.Color {
  return hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex);
}

/** Multiply a colour's brightness (in linear space). */
export function shade(c: THREE.Color, k: number): THREE.Color {
  return c.clone().multiplyScalar(k);
}

export function mixCol(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return a.clone().lerp(b, t);
}

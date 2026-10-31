import { CANON, EYE_IN, EYE_OUT, eyeParam, faceTheta, faceY, lidsFor, lowerBorder, upperBorder, type HeadShape } from './kyndFace.ts';
import { clamp01, smoothstep } from './kyndGeometry.ts';

/*
 * The shared face texture, painted once in canonical face space (see kyndFace.ts) and fitted to
 * every Kynd by the head mesh's warped texture coordinates. Channels:
 *   R  shading (1 = none … 0 = deep warm shadow): nostrils, the mouth's inside, creases, sockets
 *   G  lip mask: where the skin turns to the Kynd's lip colour (with a crisp vermilion border)
 *   B  age lines: crow's feet, forehead, frown and smile lines (scaled by the Kynd's age)
 *   A  stubble: hair dots over the beard area (scaled by how much stubble the Kynd has)
 * Pure arithmetic, so it runs (and is tested) in Node too.
 */

/** Head-space x at canonical skull angle θ and height y (the face mesh's parameterisation). */
export type XLookup = (theta: number, y: number) => number;

const SHAPE: HeadShape = { jaw: 0.5, nose: 0.5, female: true, child: 0, width: 0.5, length: 0.5, cheeks: 0.5, age: 0, lips: 0.5, eyeShape: 0.5, brow: 0.5, jawAngle: 0.5, chin: 0.5, chinWidth: 0.5, noseWidth: 0.5, noseBridge: 0.5, noseTip: 0.5, cheekFullness: 0.5 };

function hash(i: number, j: number, k: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A polyline with its bounds and segment lengths, for fast soft-line tests. */
class Stroke {
  readonly pts: [number, number][];
  readonly w: number;
  readonly k: number;
  private lens: number[] = [];
  private total = 0;
  private box: [number, number, number, number];
  constructor(pts: [number, number][], w: number, k: number) {
    this.pts = pts;
    this.w = w;
    this.k = k;
    for (let i = 0; i + 1 < pts.length; i++) {
      const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      this.lens.push(l);
      this.total += l;
    }
    const m = w * 3;
    this.box = [Math.min(...pts.map((p) => p[0])) - m, Math.max(...pts.map((p) => p[0])) + m, Math.min(...pts.map((p) => p[1])) - m, Math.max(...pts.map((p) => p[1])) + m];
  }

  /** 1 on the line, falling off over its width, tapering at both ends. */
  at(px: number, py: number, taper = 0.25): number {
    const b = this.box;
    if (px < b[0] || px > b[1] || py < b[2] || py > b[3]) return 0;
    let best = 1e9;
    let along = 0;
    let acc = 0;
    const pts = this.pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0];
      const ay = pts[i][1];
      const vx = pts[i + 1][0] - ax;
      const vy = pts[i + 1][1] - ay;
      const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1));
      const d = Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
      if (d < best) {
        best = d;
        along = (acc + t * this.lens[i]) / (this.total || 1);
      }
      acc += this.lens[i];
    }
    if (best > this.w * 3) return 0;
    return Math.exp(-((best / this.w) ** 2)) * smoothstep(0, taper, along) * smoothstep(1, 1 - taper, along) * this.k;
  }
}

export function paintFaceTexture(size: number, xAt: XLookup): Uint8Array<ArrayBuffer> {
  const c = CANON;
  const L = lidsFor(SHAPE, c);
  const data = new Uint8Array(size * size * 4);
  const mW = c.mouthW;
  // Age lines, in canonical head space (x is the Kynd's left; everything is mirrored).
  const outerX = c.eyeX + L.rho * Math.sin(EYE_OUT);
  const ageLines: Stroke[] = [];
  for (let i = 0; i < 4; i++) {
    const ang = 0.55 - i * 0.36;
    const len = 0.0105 - Math.abs(i - 1.3) * 0.0016;
    const x0 = outerX + 0.0018;
    const y0 = c.eyeY + 0.0012 - i * 0.0012;
    ageLines.push(new Stroke([[x0, y0], [x0 + Math.cos(ang) * len * 0.5, y0 + Math.sin(ang) * len * 0.5 + 0.0006], [x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len]], 0.00036, 0.6));
  }
  for (let i = 0; i < 3; i++) {
    const y = c.browY + 0.021 + i * 0.0105;
    const pts: [number, number][] = [];
    for (let k = 0; k <= 8; k++) {
      const x = -0.042 + (0.084 * k) / 8;
      pts.push([x, y + Math.cos(x * 60) * 0.0012 - (x * x) * 0.9 + Math.sin(x * 140 + i) * 0.0004]);
    }
    ageLines.push(new Stroke(pts, 0.00055, 0.65 - i * 0.1));
  }
  ageLines.push(new Stroke([[0.0042, c.eyeY + 0.011], [0.0047, c.eyeY + 0.02], [0.0058, c.eyeY + 0.029]], 0.00034, 0.38));
  ageLines.push(new Stroke([[c.alaX + 0.0035, c.noseBaseY + 0.0055], [c.alaX + 0.0068, c.noseBaseY - 0.002], [mW + 0.0045, c.mouthY - 0.002], [mW + 0.0068, c.mouthY - 0.008]], 0.00085, 0.45));
  ageLines.push(new Stroke([[mW + 0.0012, c.mouthY - 0.0016], [mW + 0.0026, c.mouthY - 0.008], [mW + 0.004, c.mouthY - 0.0145]], 0.00055, 0.38));
  // Under-eye: the lid-cheek junction and a fainter line below it.
  for (const [off, k] of [[0.0062, 0.7], [0.0092, 0.4]] as const) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const a = EYE_IN + 0.15 + ((EYE_OUT - EYE_IN - 0.35) * i) / 8;
      const e = L.lo(a) - off / L.rho;
      pts.push([c.eyeX + Math.sin(a) * L.rho, c.eyeY + Math.cos(a) * Math.sin(e) * L.rho]);
    }
    ageLines.push(new Stroke(pts, 0.00045, k));
  }
  // Fine lines above the upper lip: a faint few (heavy ones read as a moustache of wrinkles).
  for (const x of [0.0036, 0.0074, 0.0112]) {
    const y0 = c.mouthY + c.lipUp * upperBorder(x / mW) + 0.0004;
    ageLines.push(new Stroke([[x, y0], [x + 0.0003, y0 + 0.0022 + x * 0.1]], 0.00022, 0.12));
  }
  // The upper lid crease, as a line through the fold.
  const creasePts: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const a = EYE_IN + 0.18 + ((EYE_OUT - EYE_IN - 0.3) * i) / 12;
    const e = L.up(a) + L.crease / L.rho;
    creasePts.push([c.eyeX + Math.sin(a) * L.rho, c.eyeY + Math.cos(a) * Math.sin(e) * L.rho]);
  }
  const crease = new Stroke(creasePts, 0.00055, 0.32);

  const thetas = new Float64Array(size);
  for (let i = 0; i < size; i++) thetas[i] = faceTheta((i + 0.5) / size);
  data.fill(0);
  for (let o = 0; o < data.length; o += 4) data[o] = 255;
  for (let j = 0; j < size; j++) {
    const y = faceY((j + 0.5) / size);
    if (y <= -0.03 || y >= 0.25) continue;
    for (let i = 0; i < size; i++) {
      const theta = thetas[i];
      if (Math.abs(theta) >= 1.3) continue;
      const o = (j * size + i) * 4;
      let R = 1;
      let G = 0;
      let B = 0;
      let A = 0;
      const at = Math.abs(theta);
      {
        const x = xAt(theta, y);
        const ax = Math.abs(x);
        // Lips: the vermilion, its crisp border, and the inside of the mouth (the crease band).
        const u = x / mW;
        const nearMouth = Math.abs(y - c.mouthY) < 0.022 && ax < mW * 1.7;
        const top = nearMouth ? c.mouthY + c.lipUp * upperBorder(u) : 0;
        const bot = nearMouth ? c.mouthY - c.lipLo * lowerBorder(u) : 0;
        if (nearMouth) {
          if (Math.abs(u) < 1.05) {
            const inLip = Math.min(smoothstep(top + 0.00022, top - 0.00018, y), smoothstep(bot - 0.00025, bot + 0.0002, y));
            G = inLip * smoothstep(1.02, 0.94, Math.abs(u));
            // Faint vertical lip texture, and the lip slightly darker toward the mouth line.
            if (G > 0) {
              R *= 1 - G * (0.05 * Math.pow(Math.abs(Math.sin(x * 2100 + Math.sin(x * 600) * 1.5)), 6) + 0.12 * Math.exp(-(((y - c.mouthY) / 0.0018) ** 2)));
            }
            // The inside of the mouth: drawn wide here, squeezed into the crease on the face.
            const inner = smoothstep(0.0017, 0.0011, Math.abs(y - c.mouthY)) * smoothstep(1.0, 0.8, Math.abs(u));
            R *= 1 - inner * 0.94;
            // The upper teeth, just under the upper lip (B inside the lips is a teeth mask, not age).
            B = Math.max(B, smoothstep(-0.0001, 0.0004, y - c.mouthY) * smoothstep(0.0014, 0.001, y - c.mouthY) * smoothstep(0.78, 0.55, Math.abs(u)));
          }
          // Mouth corners and the shadow under the lower lip.
          R *= 1 - 0.38 * Math.exp(-(((ax - mW * 1.0) / 0.0017) ** 2 + ((y - c.mouthY) / 0.0014) ** 2));
          R *= 1 - 0.1 * Math.exp(-((x / (mW * 0.7)) ** 2 + ((y - (bot - 0.0022)) / 0.0018) ** 2));
          // Philtrum groove.
          R *= 1 - 0.07 * Math.exp(-((x / 0.0016) ** 2)) * smoothstep(top, top + 0.003, y) * smoothstep(c.noseBaseY, c.noseBaseY - 0.003, y);
        }
        if (y > c.noseBaseY - 0.008 && y < c.noseTipY + 0.01 && ax < 0.026) {
          // Nostrils and the alar crease.
          // Each nostril a slanted teardrop: broad at the inner end by the columella, narrowing as it
          // rises toward the wing, with a soft edge (not a round hole).
          const px = ax - c.alaX * 0.52;
          const py = y - (c.noseTipY - 0.0068);
          const qx = px * 0.94 + py * 0.34;
          const qy = -px * 0.34 + py * 0.94;
          const taper = 1 - 0.45 * clamp01(qx / 0.0026 + 0.5);
          const nr = Math.hypot(qx / 0.0027, qy / (0.00115 * taper));
          R *= 1 - 0.6 * smoothstep(1.15, 0.3, nr);
          const aY = (c.noseTipY + c.noseBaseY) / 2;
          const ex = (ax - c.alaX * 0.88) / 0.0055;
          const ey = (y - aY) / 0.005;
          R *= 1 - 0.2 * Math.exp(-(((Math.hypot(ex, ey) - 1.1) / 0.13) ** 2)) * smoothstep(-0.5, 0.4, ex * 0.75 + ey * 0.66);
        }
        if (y > c.eyeY - 0.07 && y < c.eyeY + 0.04 && ax < 0.075) {
          // Sides of the nose, the inner eye corners, sockets, the lid crease and under the lower lid.
          R *= 1 - 0.07 * Math.exp(-(((ax - 0.0085) / 0.004) ** 2 + ((y - (c.eyeY - 0.012)) / 0.016) ** 2));
          R *= 1 - 0.12 * Math.exp(-(((ax - (c.eyeX - 0.016)) / 0.0045) ** 2 + ((y - (c.eyeY + 0.002)) / 0.006) ** 2));
          R *= 1 - 0.065 * Math.exp(-(((ax - (c.eyeX + 0.008)) / 0.016) ** 2 + ((y - (c.eyeY + 0.016)) / 0.007) ** 2));
          R *= 1 - crease.at(ax, y, 0.2);
          const e = Math.abs(y - c.eyeY) < 0.02 ? eyeParam(ax, y, c, L) : null;
          if (e && e.e < (L.up(e.a) + L.lo(e.a)) / 2) R *= 1 - 0.1 * Math.exp(-(((e.dLo - 0.0007) / 0.0011) ** 2)) * smoothstep(0.004, 0, e.dCorner);
        }
        // Age lines.
        if (G < 0.5) for (const l of ageLines) B = Math.max(B, l.at(ax, y));
        // Stubble over the beard area: cheeks below the cheekbone line, upper lip, chin, jaw.
        if (y < c.mouthY + 0.04) {
        const cheekLine = c.mouthY + 0.026 - Math.max(0, at - 0.35) * 0.02 + Math.max(0, at - 0.95) * 0.06;
        let region = smoothstep(cheekLine + 0.003, cheekLine - 0.004, y) * smoothstep(1.5, 1.32, at);
        // Not on the lips, thinning under the nose.
        if (nearMouth) region *= 1 - smoothstep(1.14, 1.0, Math.abs(u)) * smoothstep(bot - 0.0013, bot - 0.0004, y) * smoothstep(top + 0.0013, top + 0.0004, y);
        region *= Math.min(1, smoothstep(c.noseBaseY + 0.001, c.noseBaseY - 0.0025, y) + smoothstep(0.42, 0.6, at));
        if (region > 0.01) {
          const h = hash(i, j, 7);
          const dotv = h > 0.5 ? 0.55 + 0.45 * hash(i, j, 3) : 0.12 + 0.1 * h;
          A = clamp01(region) * dotv;
        }
        }
      }
      data[o] = Math.round(clamp01(R) * 255);
      data[o + 1] = Math.round(clamp01(G) * 255);
      data[o + 2] = Math.round(clamp01(B) * 255);
      data[o + 3] = Math.round(clamp01(A) * 255);
    }
  }
  return data;
}


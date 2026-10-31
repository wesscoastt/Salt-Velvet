import * as THREE from 'three';

/**
 * Procedural texture library. Everything is generated at start-up from seeded noise, so the
 * project needs no binary art yet and every surface still gets grain, wear and variation.
 *
 * "Detail" textures are greyscale around mid-grey: they modulate an object's base colour
 * (see detailMaterial.ts) instead of replacing it, so one wood texture serves oak, walnut and pine.
 */

// --- noise ---------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise with period `p` cells. */
function vnoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (a: number) => ((a % p) + p) % p;
  const a = hash2(w(xi), w(yi), seed);
  const b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed);
  const d = hash2(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable fractal noise in [0,1]. `x,y` in [0,1). */
export function fbm(x: number, y: number, baseFreq: number, octaves: number, seed = 1): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, f, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// --- canvas helpers ---------------------------------------------------------------

type Pixel = (u: number, v: number) => [number, number, number];

function fromPixels(size: number, fn: Pixel, srgb = true): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn(x / size, y / size);
      const i = (y * size + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(canvas, srgb);
}

function finish(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

const grey = (v: number): [number, number, number] => {
  const c = Math.max(0, Math.min(255, Math.round(v * 255)));
  return [c, c, c];
};

const cache = new Map<string, THREE.Texture>();
function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

// --- detail (greyscale) textures ------------------------------------------------------

export type DetailKind = 'wood' | 'plank' | 'plaster' | 'stone' | 'fieldstone' | 'fabric' | 'soil' | 'metal' | 'thatch' | 'straw' | 'skin' | 'hair' | 'leather' | 'ceramic';

/** Greyscale detail texture: mean ≈ 0.5. */
export function detailTexture(kind: DetailKind): THREE.Texture {
  return cached(`detail:${kind}`, () => {
    switch (kind) {
      case 'wood':
        // Long grain along V with occasional knots.
        return fromPixels(256, (u, v) => {
          const warp = fbm(u, v, 4, 3, 3) * 0.6;
          const grain = Math.sin((u * 34 + warp * 6) * Math.PI) * 0.5 + 0.5;
          const fine = fbm(u * 1, v, 64, 2, 5);
          const streak = fbm(u, v * 0.25, 16, 3, 9);
          return grey(0.36 + grain * 0.16 + fine * 0.14 + streak * 0.22);
        });
      case 'plank':
        return fromPixels(256, (u, v) => {
          const boards = 4;
          const b = Math.floor(u * boards);
          const bu = u * boards - b;
          const seam = bu < 0.035 || bu > 0.965 ? 0.12 : 1;
          const offset = hash2(b, 0, 7);
          const joint = Math.abs(((v + offset) % 1) - 0.5) < 0.006 ? 0.3 : 1;
          const grain = Math.sin((bu * 18 + fbm(u, v, 4, 3, b + 1) * 5) * Math.PI) * 0.5 + 0.5;
          const tone = 0.8 + hash2(b, 1, 3) * 0.35;
          return grey((0.3 + grain * 0.12 + fbm(u, v, 32, 3, 11) * 0.2) * tone * seam * joint + 0.08);
        });
      case 'plaster':
        return fromPixels(256, (u, v) => {
          const blotch = fbm(u, v, 3, 4, 21);
          const fine = fbm(u, v, 48, 2, 22);
          return grey(0.42 + blotch * 0.18 + fine * 0.08);
        });
      case 'stone':
        // Dressed stone courses with mortar joints.
        return fromPixels(256, (u, v) => {
          const rows = 5;
          const r = Math.floor(v * rows);
          const rv = v * rows - r;
          const off = (r % 2) * 0.5 + hash2(r, 2, 4) * 0.2;
          const cols = 3;
          const cu = ((u + off / cols) * cols) % 1;
          const c = Math.floor((u + off / cols) * cols);
          const edge = Math.min(rv, 1 - rv, cu * 1.6, (1 - cu) * 1.6);
          const mortar = edge < 0.06 ? 0.25 : 1;
          const face = 0.75 + hash2(c, r, 8) * 0.3;
          const pits = fbm(u, v, 24, 3, 31);
          const shade = edge < 0.14 ? 0.85 + edge : 1;
          return grey((0.28 + pits * 0.3) * face * mortar * shade + 0.1);
        });
      case 'fieldstone':
        // Irregular rounded stones in dark mortar (tileable Voronoi): each stone a little domed.
        return fieldstone();
      case 'fabric':
        return fromPixels(128, (u, v) => {
          const warp = Math.sin(u * 128 * Math.PI) * 0.5 + 0.5;
          const weft = Math.sin(v * 128 * Math.PI) * 0.5 + 0.5;
          const slub = fbm(u, v, 8, 3, 41);
          return grey(0.4 + (warp * weft) * 0.12 + slub * 0.2);
        });
      case 'soil':
        return fromPixels(256, (u, v) => grey(0.3 + fbm(u, v, 8, 5, 51) * 0.35 + (hash2(Math.floor(u * 256), Math.floor(v * 256), 52) > 0.97 ? 0.15 : 0)));
      case 'metal':
        return fromPixels(128, (u, v) => grey(0.4 + fbm(u, v, 6, 4, 61) * 0.2 + fbm(u, v, 64, 2, 62) * 0.1));
      case 'thatch':
        return fromPixels(256, (u, v) => {
          const strands = Math.sin((u * 90 + fbm(u, v, 6, 2, 71) * 12) * Math.PI) * 0.5 + 0.5;
          const bands = Math.sin(v * 12 * Math.PI) * 0.5 + 0.5;
          return grey(0.28 + strands * 0.22 + bands * 0.1 + fbm(u, v, 16, 3, 72) * 0.2);
        });
      case 'straw':
        return fromPixels(128, (u, v) => grey(0.35 + (Math.sin((u * 60 + v * 8) * Math.PI) * 0.5 + 0.5) * 0.2 + fbm(u, v, 16, 3, 81) * 0.2));
      case 'skin':
        return fromPixels(128, (u, v) => grey(0.46 + fbm(u, v, 16, 3, 91) * 0.08));
      case 'hair':
        return fromPixels(128, (u, v) => grey(0.3 + (Math.sin((u * 70 + fbm(u, v, 4, 2, 95) * 6) * Math.PI) * 0.5 + 0.5) * 0.3 + fbm(u, v, 32, 2, 96) * 0.15));
      case 'leather':
        return fromPixels(128, (u, v) => grey(0.36 + fbm(u, v, 12, 4, 101) * 0.26));
      case 'ceramic':
        return fromPixels(128, (u, v) => grey(0.44 + fbm(u, v, 5, 3, 111) * 0.12));
    }
  });
}

/** Tileable Voronoi fieldstone: cells of varied tone with shaded, rounded edges. */
function fieldstone(): THREE.CanvasTexture {
  const N = 7;
  const pts: [number, number][] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pts.push([(i + 0.15 + hash2(i, j, 141) * 0.7) / N, (j + 0.15 + hash2(i, j, 142) * 0.7) / N]);
  return fromPixels(256, (u, v) => {
    let d1 = 9;
    let d2 = 9;
    let cell = 0;
    const ci = Math.floor(u * N);
    const cj = Math.floor(v * N);
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const i = ci + di;
        const j = cj + dj;
        const wi = ((i % N) + N) % N;
        const wj = ((j % N) + N) % N;
        const p = pts[wj * N + wi];
        const px = p[0] + Math.floor(i / N);
        const py = p[1] + Math.floor(j / N);
        // Stretch stones sideways a little: courses read as laid, not random.
        const d = Math.hypot((u - px) * 0.85, v - py);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          cell = wj * N + wi;
        } else if (d < d2) d2 = d;
      }
    }
    const edge = (d2 - d1) * N;
    if (edge < 0.09) return grey(0.16 + fbm(u, v, 32, 2, 143) * 0.1);
    const dome = Math.min(1, (edge - 0.09) / 0.35);
    const tone = 0.42 + hash2(cell, 3, 144) * 0.2;
    return grey((tone + fbm(u, v, 24, 3, 145) * 0.18) * (0.72 + 0.28 * Math.sqrt(dome)));
  });
}

// --- colour textures ----------------------------------------------------------------------

/** Diamond leaded-glass pane with a warm cast. */
export function leadedGlassTexture(): THREE.Texture {
  return cached('glass', () => {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#9fb7b4';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(${200 + hash2(i, 1, 1) * 55},${210 + hash2(i, 2, 1) * 45},${190},${0.08 + hash2(i, 3, 1) * 0.12})`;
      ctx.fillRect(hash2(i, 4, 1) * size, hash2(i, 5, 1) * size, 18, 18);
    }
    ctx.strokeStyle = '#3a3530';
    ctx.lineWidth = 3;
    const step = size / 4;
    for (let k = -4; k <= 8; k++) {
      ctx.beginPath();
      ctx.moveTo(k * step, 0);
      ctx.lineTo(k * step + size, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(k * step, size);
      ctx.lineTo(k * step + size, 0);
      ctx.stroke();
    }
    return finish(c, true);
  });
}

/** Alpha card for grass tufts: a fan of tapered blades. */
export function grassBladeTexture(): THREE.Texture {
  return cached('blades', () => {
    const w = 128;
    const h = 128;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    for (let i = 0; i < 26; i++) {
      const x = 10 + hash2(i, 0, 5) * (w - 20);
      const lean = (hash2(i, 1, 5) - 0.5) * 40;
      const top = 10 + hash2(i, 2, 5) * 60;
      const l = 0.75 + hash2(i, 3, 5) * 0.4;
      const grad = ctx.createLinearGradient(0, h, 0, top);
      grad.addColorStop(0, `rgb(${Math.round(92 * l)},${Math.round(102 * l)},${Math.round(50 * l)})`);
      grad.addColorStop(1, `rgb(${Math.round(176 * l)},${Math.round(172 * l)},${Math.round(104 * l)})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x - 3, h);
      ctx.quadraticCurveTo(x + lean * 0.3, (h + top) / 2, x + lean, top);
      ctx.quadraticCurveTo(x + lean * 0.3 + 2, (h + top) / 2, x + 3, h);
      ctx.fill();
    }
    const t = finish(c, true);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Alpha card for leaf clusters on trees and bushes. */
export function leafClusterTexture(): THREE.Texture {
  return cached('leaves', () => {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    // Twigs first, so leaves overlap them.
    ctx.strokeStyle = 'rgb(70,58,40)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const a = hash2(i, 7, 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(size / 2, size / 2);
      ctx.lineTo(size / 2 + Math.cos(a) * size * 0.4, size / 2 + Math.sin(a) * size * 0.4);
      ctx.stroke();
    }
    // Leaves: dense in the middle, thinning raggedly toward the edge (no hard circular rim).
    for (let i = 0; i < 520; i++) {
      const a = hash2(i, 0, 9) * Math.PI * 2;
      const r = Math.pow(hash2(i, 1, 9), 0.75) * size * 0.46;
      const x = size / 2 + Math.cos(a) * r;
      const y = size / 2 + Math.sin(a) * r;
      const l = 0.62 + hash2(i, 2, 9) * 0.55;
      const warm = hash2(i, 4, 9);
      const rot = hash2(i, 3, 9) * Math.PI;
      const len = 7 + hash2(i, 5, 9) * 5;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      // Leaf body: pointed ellipse, lit half and shaded half.
      ctx.fillStyle = `rgb(${Math.round((82 + warm * 30) * l)},${Math.round((104 + warm * 12) * l)},${Math.round(46 * l)})`;
      ctx.beginPath();
      ctx.moveTo(-len, 0);
      ctx.quadraticCurveTo(0, -len * 0.55, len, 0);
      ctx.quadraticCurveTo(0, len * 0.55, -len, 0);
      ctx.fill();
      ctx.fillStyle = `rgba(20,30,10,0.28)`;
      ctx.beginPath();
      ctx.moveTo(-len, 0);
      ctx.quadraticCurveTo(0, len * 0.55, len, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    const t = finish(c, true);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Woven rug with border and medallion, in the given palette. */
let rugWeave: Float32Array | null = null;

export function rugTexture(bg: string, border: string, accent: string): THREE.Texture {
  return cached(`rug:${bg}${border}${accent}`, () => {
    const W = 256;
    const H = 170;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = border;
    ctx.lineWidth = 14;
    ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(22, 22, W - 44, H - 44);
    // Repeating lozenges along the border.
    ctx.fillStyle = accent;
    for (let x = 18; x < W - 10; x += 14) {
      for (const y of [10, H - 10]) {
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x, y + 4);
        ctx.lineTo(x - 4, y);
        ctx.fill();
      }
    }
    // Central medallion.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    for (let r = 44; r > 6; r -= 10) {
      ctx.fillStyle = r % 20 === 4 ? border : accent;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.7);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r * 0.7);
      ctx.lineTo(-r, 0);
      ctx.fill();
    }
    ctx.restore();
    // Wear and fibre noise (the same weave for every rug: worked out once).
    const img = ctx.getImageData(0, 0, W, H);
    rugWeave ??= Float32Array.from({ length: W * H }, (_, k) => 0.82 + fbm((k % W) / W, Math.floor(k / W) / H, 8, 3, 121) * 0.3 + Math.sin((k % W) * 1.7) * 0.03);
    for (let k = 0; k < W * H; k++) {
      const n = rugWeave[k];
      img.data[k * 4] *= n;
      img.data[k * 4 + 1] *= n;
      img.data[k * 4 + 2] *= n;
    }
    ctx.putImageData(img, 0, 0);
    return finish(c, true);
  });
}


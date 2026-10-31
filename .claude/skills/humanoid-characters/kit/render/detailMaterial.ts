import * as THREE from 'three';
import { detailTexture, type DetailKind } from './textures.ts';

export interface DetailOptions {
  kind: DetailKind | 'plasterBrick';
  /** Texture repeats per metre. */
  scale?: number;
  /** 0 = no effect, 1 = full ±50% colour modulation. */
  strength?: number;
  /** Surface relief from the same texture (0 = flat). */
  bump?: number;
  /** 'world' for static props/architecture; 'object' for anything that moves (characters). */
  space?: 'world' | 'object';
}

const DEFAULTS: Record<DetailOptions['kind'], { scale: number; strength: number; bump: number }> = {
  wood: { scale: 1.1, strength: 0.55, bump: 0.012 },
  plank: { scale: 0.55, strength: 0.7, bump: 0.02 },
  plaster: { scale: 0.45, strength: 0.4, bump: 0.01 },
  plasterBrick: { scale: 0.11, strength: 0.9, bump: 0.02 },
  stone: { scale: 0.7, strength: 0.75, bump: 0.035 },
  fieldstone: { scale: 0.55, strength: 0.9, bump: 0.05 },
  fabric: { scale: 7, strength: 0.35, bump: 0.004 },
  soil: { scale: 0.6, strength: 0.6, bump: 0.02 },
  metal: { scale: 2, strength: 0.45, bump: 0.006 },
  thatch: { scale: 0.7, strength: 0.75, bump: 0.05 },
  straw: { scale: 2.5, strength: 0.55, bump: 0.01 },
  skin: { scale: 5, strength: 0.18, bump: 0 },
  hair: { scale: 10, strength: 0.6, bump: 0.004 },
  leather: { scale: 4, strength: 0.45, bump: 0.005 },
  ceramic: { scale: 3, strength: 0.3, bump: 0.003 },
};

/**
 * Cream plaster with blotchy weathering and a few patches where it has fallen away to show brick —
 * a colour texture (not greyscale) so the brick reads red against the plaster.
 */
let plasterBrickTex: THREE.Texture | null = null;
function plasterBrick(): THREE.Texture {
  if (plasterBrickTex) return plasterBrickTex;
  // Nine metres of wall before the pattern comes round again (the plaster grain and the bricks
  // keep their size): long enough that no two walls in a row show the same breaks.
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  // Drawn with canvas operations (native, quick) rather than pixel by pixel.
  const plaster = detailTexture('plaster').image as HTMLCanvasElement;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) ctx.drawImage(plaster, (x * size) / 2, (y * size) / 2, size / 2, size / 2);
  // A touch warmer than the grey plaster detail.
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgb(255,255,247)';
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  const rnd = (x: number, y: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  // Where plaster really fails: a couple of big breaks, some middling, and small chips, each its
  // own ragged shape (centre x, y, radius in tile units; all clear of the tile's edge).
  const patches = [
    [0.2, 0.68, 0.075],
    [0.71, 0.27, 0.06],
    [0.58, 0.8, 0.045],
    [0.33, 0.22, 0.035],
    [0.86, 0.58, 0.03],
    [0.1, 0.36, 0.018],
    [0.47, 0.5, 0.014],
    [0.79, 0.88, 0.02],
  ];
  const blob = (cx: number, cy: number, rad: number, k: number) => {
    const path = new Path2D();
    // No two alike: phases and a squash of their own, and several lumpy frequencies so the
    // outline is ragged rather than a regular star.
    const ph = [rnd(cx, cy), rnd(cy, cx), rnd(cx + 1, cy), rnd(cx, cy + 1)].map((v) => v * Math.PI * 2);
    const squash = 1.2 + rnd(cx * 3, cy) * 0.5;
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const wob = 1 + Math.sin(a * 2 + ph[0]) * 0.17 + Math.sin(a * 3 + ph[1]) * 0.12 + Math.sin(a * 7 + ph[2]) * 0.06 + Math.sin(a * 13 + ph[3]) * 0.035;
      const r = rad * k * wob;
      const px = (cx + Math.cos(a) * r) * size, py = (cy + (Math.sin(a) * r) / squash) * size;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    path.closePath();
    return path;
  };
  const ROWS = 128, COLS = 56;
  const rowH = size / ROWS, colW = size / COLS;
  for (const [cx, cy, rad] of patches) {
    const outer = blob(cx, cy, rad, 1);
    ctx.save();
    ctx.clip(outer);
    ctx.fillStyle = 'rgb(117,107,97)'; // mortar
    ctx.fillRect(0, 0, size, size);
    const y0 = Math.floor((cy - rad) * ROWS) - 2, y1 = Math.ceil((cy + rad) * ROWS) + 2;
    for (let row = Math.max(0, y0); row < Math.min(ROWS, y1); row++) {
      const off = (row % 2) * 0.5;
      for (let col = Math.floor((cx - rad * 1.5) * COLS) - 1; col < (cx + rad * 1.5) * COLS + 1; col++) {
        const tone = 0.8 + rnd(col, row) * 0.35;
        ctx.fillStyle = `rgb(${Math.round(143 * tone)},${Math.round(97 * tone)},${Math.round(77 * tone)})`;
        ctx.fillRect((col - off + 0.07) * colW, (row + 0.16) * rowH, colW * 0.93, rowH * 0.84);
      }
    }
    // Broken plaster edge: a darker lip round the inside of the break.
    const lip = new Path2D();
    lip.addPath(outer);
    lip.addPath(blob(cx, cy, rad, 0.82));
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fill(lip, 'evenodd');
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  plasterBrickTex = t;
  return t;
}

/**
 * Patch a standard material with tri-planar detail: the texture is projected along the three axes
 * using position (world or object space) and blended by the surface normal, so boxes, cylinders
 * and lathes all get correctly scaled grain without UV work. It modulates base colour (keeping the
 * palette), roughness, and a small bump.
 */
export function applyDetail(material: THREE.MeshStandardMaterial, opts: DetailOptions): THREE.MeshStandardMaterial {
  const d = DEFAULTS[opts.kind];
  const tex = opts.kind === 'plasterBrick' ? plasterBrick() : detailTexture(opts.kind);
  const world = (opts.space ?? 'world') === 'world';
  const uniforms = {
    tDetail: { value: tex },
    uDScale: { value: opts.scale ?? d.scale },
    uDStrength: { value: opts.strength ?? d.strength },
    uDBump: { value: opts.bump ?? d.bump },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDPos;\nvarying vec3 vDNrm;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 dPos = vec4(transformed, 1.0);
        vec3 dNrm = objectNormal;
        ${world ? `#ifdef USE_INSTANCING
          dPos = instanceMatrix * dPos;
          dNrm = mat3(instanceMatrix) * dNrm;
        #endif
        dPos = modelMatrix * dPos;
        dNrm = mat3(modelMatrix) * dNrm;` : ''}
        vDPos = dPos.xyz;
        vDNrm = normalize(dNrm);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D tDetail;
        uniform float uDScale;
        uniform float uDStrength;
        uniform float uDBump;
        varying vec3 vDPos;
        varying vec3 vDNrm;
        vec3 detailSample() {
          vec3 w = pow(abs(normalize(vDNrm)), vec3(4.0));
          w /= (w.x + w.y + w.z + 1e-5);
          vec3 p = vDPos * uDScale;
          return texture2D(tDetail, p.zy).rgb * w.x + texture2D(tDetail, p.xz).rgb * w.y + texture2D(tDetail, p.xy).rgb * w.z;
        }
        vec3 detailBump(vec3 pos, vec3 n, float h) {
          vec3 sx = dFdx(pos);
          vec3 sy = dFdy(pos);
          vec3 r1 = cross(sy, n);
          vec3 r2 = cross(n, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
          return normalize(abs(det) * n - grad);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 dTex = detailSample();
        float dLum = dot(dTex, vec3(0.333));
        diffuseColor.rgb *= mix(vec3(1.0), dTex * 2.0, uDStrength);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (0.5 - dLum) * uDStrength * 0.5, 0.05, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (uDBump > 0.0) normal = detailBump(-vViewPosition, normal, dLum * uDBump);`,
      );
  };
  material.customProgramCacheKey = () => `detail-${world ? 'w' : 'o'}`;
  material.needsUpdate = true;
  return material;
}

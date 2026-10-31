import * as THREE from 'three';
import { fbm } from './textures.ts';
import { Head } from './kyndBody.ts';
import { paintFaceTexture } from './kyndFaceTexture.ts';
import { smoothstep } from './kyndGeometry.ts';
import { DETAIL_FIELDS, type FullAppearance } from '../sim/entities/appearance.ts';

/*
 * Materials shared by every Kynd avatar. There are only five, so a whole crowd shares five shader
 * programs and each Kynd is a handful of draw calls:
 *
 *   garment : all cloth, leather, fur and straw. A per-vertex "kind" picks the weave, grain or fur
 *             detail, the roughness, a velvet or fur sheen, and embroidery or a heraldic charge.
 *   skin    : vertex-coloured skin with a face-detail overlay (blush, freckles, stubble, scar, lines).
 *   hair    : vertex-coloured hair, brows and lashes over a strand texture.
 *   eye     : glossy eyeballs, teeth and mouth, with an emissive catch-light.
 *   metal   : buckles, buttons, chains, crowns and gems.
 *
 * Surface detail is projected tri-planar in the mesh's *rest pose* (the bind-space position), so
 * the weave stays glued to the cloth as the Kynd moves instead of swimming through it.
 */

function dataTexture(size: number, fill: (u: number, v: number, out: number[]) => void, srgb = false): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const px = [0, 0, 0, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      px[3] = 255;
      fill(x / size, y / size, px);
      const i = (y * size + x) * 4;
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      data[i + 3] = px[3];
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const g = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** R: twill wool, G: fine linen, B: leather grain, A: fur. Each channel averages about 0.5. */
let garmentTex: THREE.DataTexture | null = null;
function garmentDetail(): THREE.DataTexture {
  if (garmentTex) return garmentTex;
  garmentTex = dataTexture(256, (u, v, o) => {
    // Twill: diagonal ribs with slubby yarn.
    const twill = Math.sin((u * 64 + v * 64) * Math.PI * 2) * 0.5 + 0.5;
    const warp = Math.sin(u * 128 * Math.PI * 2) * 0.5 + 0.5;
    const slub = fbm(u, v, 16, 3, 41);
    o[0] = g(0.3 + twill * 0.22 + warp * 0.08 + slub * 0.3);
    // Linen: fine plain weave with irregular threads.
    const lw = Math.sin(u * 96 * Math.PI * 2) * Math.sin(v * 96 * Math.PI * 2);
    const irregular = fbm(u, v, 32, 2, 43);
    o[1] = g(0.38 + lw * 0.1 + irregular * 0.26 + fbm(u * 0.2, v, 8, 2, 44) * 0.1);
    // Leather: pebbled grain and creases.
    const grain = fbm(u, v, 24, 3, 101);
    const crease = Math.abs(fbm(u, v, 6, 3, 103) - 0.5) < 0.03 ? 0.75 : 1;
    o[2] = g((0.3 + grain * 0.4) * crease + 0.05);
    // Fur: soft tufts with fine hairs.
    const tuft = fbm(u, v, 8, 4, 111);
    const hairs = Math.sin((u * 90 + fbm(u, v, 6, 2, 112) * 10) * Math.PI * 2) * 0.5 + 0.5;
    o[3] = g(0.22 + tuft * 0.45 + hairs * 0.15);
  });
  return garmentTex;
}

/**
 * Pattern atlas, sampled with the mesh UVs:
 *   R: embroidered trim (repeats along u, spans the band across v),
 *   G: the heraldic charge (a rampant beast, drawn once over the square),
 *   B: ermine spots (repeats in both directions).
 */
let patternTex: THREE.DataTexture | null = null;
export function patternAtlas(): THREE.DataTexture {
  if (patternTex) return patternTex;
  const size = 512;
  const charge = drawCharge(size);
  patternTex = dataTexture(size, (u, v, o) => {
    // Embroidery: a border line top and bottom, a running vine of lozenges and dots between.
    const bu = (u * 4) % 1;
    const edge = v < 0.1 || v > 0.9 ? 1 : v < 0.14 || v > 0.86 ? 0 : -1;
    let e = 0;
    if (edge === 1) e = 1;
    else if (edge === -1) {
      const cy = v - 0.5;
      const lozenge = Math.abs(bu - 0.5) * 1.3 + Math.abs(cy) * 1.6 < 0.42 && Math.abs(bu - 0.5) * 1.3 + Math.abs(cy) * 1.6 > 0.28;
      const core = Math.hypot(bu - 0.5, cy * 1.2) < 0.08;
      const dots = Math.hypot(bu - 0.0, cy) < 0.07 || Math.hypot(bu - 1, cy) < 0.07;
      const vine = Math.abs(cy - Math.sin(bu * Math.PI * 2) * 0.18) < 0.035 && Math.abs(bu - 0.5) > 0.3;
      e = lozenge || core || dots || vine ? 1 : 0;
    }
    o[0] = g(e * (0.85 + fbm(u, v, 64, 2, 7) * 0.15));
    o[1] = charge[Math.floor(v * size) * size + Math.floor(u * size)];
    // Ermine: little black tails on a staggered grid.
    const eu = u * 6;
    const ev = v * 6;
    const row = Math.floor(ev);
    const cu = (eu + (row % 2) * 0.5) % 1;
    const cv = ev % 1;
    const tail = Math.abs(cu - 0.5) < 0.06 * (1 - cv) + 0.02 && cv > 0.25 && cv < 0.75;
    const tips = Math.hypot(cu - 0.5, cv - 0.28) < 0.07;
    o[2] = tail || tips ? 255 : 0;
  });
  return patternTex;
}

/** An original heraldic charge: a rampant beast, crowned, in silhouette. Returns 0..255 coverage. */
function drawCharge(size: number): Uint8Array {
  const out = new Uint8Array(size * size);
  if (typeof document === 'undefined') return out;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Body: rearing on the hind legs, facing left (dexter).
  ctx.beginPath();
  ctx.moveTo(38, 30);
  ctx.bezierCurveTo(46, 28, 56, 34, 58, 46);
  ctx.bezierCurveTo(60, 56, 58, 64, 54, 70);
  ctx.bezierCurveTo(50, 74, 44, 74, 40, 70);
  ctx.bezierCurveTo(36, 62, 34, 50, 34, 42);
  ctx.closePath();
  ctx.fill();
  // Head with open jaws and a mane.
  ctx.beginPath();
  ctx.ellipse(34, 26, 9, 8, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(27, 24);
  ctx.lineTo(18, 21);
  ctx.lineTo(22, 26);
  ctx.lineTo(17, 30);
  ctx.lineTo(28, 31);
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    const a = -0.6 + i * 0.45;
    ctx.moveTo(38 + Math.cos(a) * 6, 27 + Math.sin(a) * 6);
    ctx.lineTo(44 + Math.cos(a) * 9, 28 + Math.sin(a) * 10);
    ctx.lineTo(38 + Math.cos(a + 0.3) * 6, 27 + Math.sin(a + 0.3) * 6);
    ctx.fill();
  }
  // Crown.
  ctx.beginPath();
  ctx.moveTo(29, 18);
  ctx.lineTo(30, 11);
  ctx.lineTo(33, 15);
  ctx.lineTo(35, 9);
  ctx.lineTo(37, 15);
  ctx.lineTo(40, 11);
  ctx.lineTo(40, 19);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 5;
  // Forelegs raised, claws out.
  ctx.beginPath();
  ctx.moveTo(40, 40);
  ctx.quadraticCurveTo(30, 40, 24, 36);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(42, 50);
  ctx.quadraticCurveTo(30, 52, 26, 46);
  ctx.stroke();
  // Hind legs.
  ctx.beginPath();
  ctx.moveTo(48, 68);
  ctx.quadraticCurveTo(40, 78, 36, 90);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(54, 66);
  ctx.quadraticCurveTo(62, 78, 58, 90);
  ctx.stroke();
  ctx.lineWidth = 3;
  // Claws.
  for (const [x, y] of [
    [24, 36],
    [26, 46],
    [36, 90],
    [58, 90],
  ]) {
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 5, y + k * 3);
      ctx.stroke();
    }
  }
  // Tail curling up behind, with a tuft.
  ctx.beginPath();
  ctx.moveTo(56, 64);
  ctx.bezierCurveTo(74, 60, 64, 40, 76, 30);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(78, 27, 5, 7, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const img = ctx.getImageData(0, 0, size, size).data;
  // Canvas rows run top-down; texture v runs bottom-up.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[(size - 1 - y) * size + x] = img[(y * size + x) * 4];
  return out;
}

/** Hair strands: streaks running along v, with clumps and a few stray lighter hairs. */
let strandTex: THREE.DataTexture | null = null;
function strandTexture(): THREE.DataTexture {
  if (strandTex) return strandTex;
  strandTex = dataTexture(256, (u, v, o) => {
    // Streaks run along v: noise varies fast across u and only gently (still tileable) along v.
    const clump = fbm(u, 0, 12, 3, 201) * 0.7 + fbm(u, v, 4, 2, 202) * 0.3;
    const fine = fbm(u, 0.5, 96, 2, 203) * 0.8 + fbm(u, v, 32, 2, 204) * 0.2;
    const streak = Math.sin((u * 40 + fbm(u, v, 2, 2, 205) * 2) * Math.PI * 2) * 0.5 + 0.5;
    const val = 0.66 + clump * 0.22 + fine * 0.16 + streak * 0.06 - 0.1;
    const x = g(Math.min(1, val));
    o[0] = o[1] = o[2] = x;
  }, true);
  return strandTex;
}

// --- shader patches ------------------------------------------------------------------------

const TRIPLANAR = /* glsl */ `
  vec4 kyndTri(sampler2D t, vec3 p, vec3 n) {
    vec3 w = pow(abs(n), vec3(4.0));
    w /= (w.x + w.y + w.z + 1e-5);
    return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
  }
  float kyndHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float kyndNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(kyndHash(i), kyndHash(i + vec2(1.0, 0.0)), f.x), mix(kyndHash(i + vec2(0.0, 1.0)), kyndHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  vec3 kyndBump(vec3 pos, vec3 n, float h) {
    vec3 sx = dFdx(pos);
    vec3 sy = dFdy(pos);
    vec3 r1 = cross(sy, n);
    vec3 r2 = cross(n, sx);
    float det = dot(sx, r1);
    vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    return normalize(abs(det) * n - grad);
  }
`;

function patchGarment(m: THREE.MeshStandardMaterial): void {
  const uniforms = { tGarment: { value: garmentDetail() }, tPattern: { value: patternAtlas() } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aKind;
        attribute vec3 aCol2;
        varying float vKind;
        varying vec3 vCol2;
        varying vec3 vRestPos;
        varying vec3 vRestNrm;
        varying vec2 vUv0;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vKind = aKind;
        vCol2 = aCol2;
        vRestPos = position;
        vRestNrm = normal;
        vUv0 = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D tGarment;
        uniform sampler2D tPattern;
        varying float vKind;
        varying vec3 vCol2;
        varying vec3 vRestPos;
        varying vec3 vRestNrm;
        varying vec2 vUv0;
        ${TRIPLANAR}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float gK = floor(vKind + 0.5);
        vec3 gN = normalize(vRestNrm);
        float gScale = gK == 1.0 ? 9.0 : gK == 3.0 ? 5.0 : gK == 4.0 ? 7.0 : gK == 5.0 ? 5.0 : 6.0;
        vec4 gD = kyndTri(tGarment, vRestPos * gScale, gN);
        float gDet = gD.r;
        float gStr = 0.24;
        float gRough = 0.92;
        float gSheen = 0.0;
        if (gK == 1.0) { gDet = gD.g; gStr = 0.22; gRough = 0.88; }
        else if (gK == 2.0) { gDet = gD.r; gStr = 0.18; gRough = 0.78; gSheen = 1.0; }
        else if (gK == 3.0) { gDet = gD.b; gStr = 0.34; gRough = 0.64; }
        else if (gK == 4.0) {
          gDet = gD.a; gStr = 0.75; gRough = 1.0; gSheen = -1.0;
          float spot = texture2D(tPattern, vUv0).b;
          diffuseColor.rgb = mix(diffuseColor.rgb, vCol2, spot);
        }
        else if (gK == 5.0) { gDet = gD.g; gStr = 0.8; gRough = 0.85; }
        else if (gK == 6.0) {
          float e = texture2D(tPattern, vUv0).r;
          diffuseColor.rgb = mix(diffuseColor.rgb, vCol2, e);
          gDet = gD.g; gStr = 0.3; gRough = mix(0.8, 0.45, e);
        }
        else if (gK == 7.0) {
          float ch = texture2D(tPattern, vUv0).g;
          diffuseColor.rgb = mix(diffuseColor.rgb, vCol2, ch);
          gDet = gD.r; gStr = mix(0.18, 0.3, ch); gRough = mix(0.78, 0.55, ch); gSheen = 1.0 - ch;
        }
        diffuseColor.rgb *= mix(1.0, gDet * 2.0, gStr);
        // Woven cloth (not leather, fur or straw) hangs: soft drape folds running down it, a
        // little uneven dye, and the hem grubbier than the shoulders from brushing the floor.
        float gCloth = (gK == 3.0 || gK == 4.0 || gK == 5.0) ? 0.0 : 1.0;
        // (Round the body, a few folds a side, long down it; two octaves.)
        vec2 gAround = vec2(atan(vRestPos.x, vRestPos.z) * 3.2, vRestPos.y * 2.2);
        float gFold = kyndNoise(gAround) * 0.7 + kyndNoise(gAround * 2.3 + 5.1) * 0.3;
        float gDye = kyndNoise(vRestPos.xy * 6.0 + vRestPos.z * 4.0 + 3.7);
        diffuseColor.rgb *= 1.0 + gCloth * ((gFold - 0.5) * 0.22 + (gDye - 0.5) * 0.08);
        float gHem = gCloth * smoothstep(0.75, 0.05, vRestPos.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.8, 0.74, 0.66), gHem * 0.32);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(gRough + (0.5 - gDet) * 0.25, 0.08, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = kyndBump(-vViewPosition, normal, gDet * (gK == 4.0 ? 0.004 : gK == 3.0 ? 0.0012 : 0.0008) + gCloth * gFold * 0.014);
        float gNdv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        if (gSheen > 0.5) diffuseColor.rgb *= mix(1.45, 0.72, pow(gNdv, 0.7));
        else if (gSheen < -0.5) diffuseColor.rgb *= mix(1.3, 0.92, gNdv);
        else diffuseColor.rgb *= mix(1.12, 1.0, gNdv);`,
      );
  };
  m.customProgramCacheKey = () => 'kynd-garment';
}

export interface SkinUniforms {
  uAge: { value: number };
  uStubble: { value: number };
  uFreckles: { value: number };
  uScar: { value: number };
}

/**
 * Skin: the vertex colour (skin tone with blush zones baked in) mixed toward the Kynd's lip colour
 * by the face texture's lip mask, then the texture's warm shading, age lines and stubble; freckles
 * and a scar are drawn procedurally. Light scattered through the skin warms its shadows, lips are
 * glossier than skin, and a faint pore grain breaks up highlights up close.
 */
function patchSkin(m: THREE.MeshStandardMaterial, u: SkinUniforms): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { tFace: { value: faceTexture() } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCol2;
        varying vec3 vLip;
        varying vec2 vFaceUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLip = aCol2;
        vFaceUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tFace;
        uniform float uAge;
        uniform float uStubble;
        uniform float uFreckles;
        uniform float uScar;
        varying vec3 vLip;
        varying vec2 vFaceUv;
        float kHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float kSeg(vec2 p, vec2 a, vec2 b) {
          vec2 pa = p - a, ba = b - a;
          float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
          return length(pa - ba * h);
        }`)
      .replace('#include <map_fragment>', `
        vec4 fT = texture2D(tFace, vFaceUv);`)
      .replace('#include <color_fragment>', `
        vec3 skinC = mix(vColor, vLip, fT.g);
        skinC *= mix(vec3(0.12, 0.045, 0.04), vec3(1.0), fT.r);
        float inLips = step(0.5, fT.g);
        skinC *= mix(vec3(1.0), vec3(0.66, 0.5, 0.46), fT.b * uAge * (1.0 - inLips));
        // Closed lips meet in a dark crease (the teeth are real geometry, seen when the mouth opens).
        skinC = mix(skinC, skinC * vec3(0.42, 0.3, 0.3), fT.b * inLips * 0.7);
        skinC *= mix(vec3(1.0), vec3(0.38, 0.35, 0.33), fT.a * uStubble);
        if (uFreckles > 0.5) {
          vec2 q = vFaceUv * 240.0;
          vec2 id = floor(q);
          float h = kHash(id);
          vec2 off = vec2(kHash(id + 7.1), kHash(id + 3.3)) - 0.5;
          float dotm = smoothstep(0.36, 0.12, length(fract(q) - 0.5 - off * 0.45)) * step(0.55, h);
          vec2 du = (vFaceUv - vec2(0.5, 0.41)) / vec2(0.24, 0.085);
          float region = exp(-dot(du, du)) * (1.0 - fT.g);
          skinC *= mix(vec3(1.0), vec3(0.74, 0.54, 0.42), dotm * region * (0.6 + 0.4 * h));
        }
        if (uScar > 0.5) {
          vec2 sp = vec2(abs(vFaceUv.x - 0.5), vFaceUv.y);
          float d = kSeg(sp * vec2(1.0, 1.04), vec2(0.135, 0.43), vec2(0.2, 0.31));
          float scar = smoothstep(0.0035, 0.001, d) * step(0.5, vFaceUv.x);
          skinC = mix(skinC, skinC * vec3(1.12, 0.86, 0.84), scar);
        }
        diffuseColor.rgb *= skinC;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.42, fT.g * 0.85) + (1.0 - fT.r) * 0.5;
        float pore = kHash(floor(vFaceUv * 900.0));
        roughnessFactor += (pore - 0.5) * 0.08;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // A little light scattered through the skin: warm, soft shadows instead of grey ones.
        totalEmissiveRadiance += diffuseColor.rgb * vec3(0.10, 0.045, 0.03);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float sNdv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        diffuseColor.rgb *= mix(vec3(1.08, 0.94, 0.9), vec3(1.0), sNdv);`);
  };
  m.customProgramCacheKey = () => 'kynd-skin2';
}

/**
 * Eyes, teeth and the infant's eyes. Eyeball vertices carry their position on the eyeball in uv
 * (offset by 10, or 20 for an elder's slightly yellower whites) and their iris colour; the pupil,
 * fibrous iris, limbal ring, collarette, sclera and a catch-light are drawn here, crisp at any size.
 */
function patchEye(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec2 vEyeUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vEyeUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vEyeUv;
        float eHash(float n) { return fract(sin(n) * 43758.5453); }
        float eNoise(float x) { float i = floor(x); float f = fract(x); return mix(eHash(i), eHash(i + 1.0), f * f * (3.0 - 2.0 * f)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float eyeBall = step(5.0, vEyeUv.x);
        vec2 ep = vec2(vEyeUv.x - (vEyeUv.x > 15.0 ? 20.0 : 10.0), vEyeUv.y);
        float er = length(ep);
        if (eyeBall > 0.5) {
          float irisR = 0.56;
          float pupilR = 0.18;
          float ang = atan(ep.y, ep.x);
          vec3 irisC = vColor;
          // Radial fibres, a lighter collarette round the pupil, darker crypts, a limbal ring.
          float t = clamp((er - pupilR) / (irisR - pupilR), 0.0, 1.0);
          float fib = eNoise(ang * 22.0) * 0.6 + eNoise(ang * 57.0 + t * 3.0) * 0.4;
          vec3 iris = irisC * (0.78 + fib * 0.42);
          iris = mix(iris, irisC * 1.45 + vec3(0.025), smoothstep(0.32, 0.0, t) * 0.55);
          iris *= 1.0 - 0.25 * smoothstep(0.55, 0.8, t) * eNoise(ang * 9.0);
          iris *= mix(1.0, 0.32, smoothstep(0.7, 1.0, t));
          vec3 white = vEyeUv.x > 15.0 ? vec3(0.78, 0.72, 0.6) : vec3(0.86, 0.82, 0.76);
          // Whites: rosier toward the corners, shaded under the upper lid.
          white = mix(white, vec3(0.8, 0.6, 0.56), smoothstep(0.62, 0.98, abs(ep.x)) * 0.45);
          white *= mix(0.62, 1.0, smoothstep(0.62, 0.05, ep.y));
          float inIris = smoothstep(irisR + 0.02, irisR - 0.012, er);
          vec3 eyeC = mix(white, iris, inIris);
          eyeC = mix(eyeC, vec3(0.012, 0.01, 0.01), smoothstep(pupilR + 0.018, pupilR - 0.012, er));
          diffuseColor.rgb = eyeC;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vColor.r > 1.5) totalEmissiveRadiance += vec3(0.9);
        if (eyeBall > 0.5) {
          // Catch-light: the reflection of a soft light above and beside the viewer, on the cornea.
          vec3 vdir = normalize(vViewPosition);
          vec3 hl = normalize(normalize(vec3(-0.45, 0.6, 1.0)) + vdir);
          float spec = smoothstep(0.9965, 0.9988, dot(normal, hl)) * step(er, 0.62);
          totalEmissiveRadiance += vec3(1.1) * spec;
        }`);
  };
  m.customProgramCacheKey = () => 'kynd-eye2';
}

function patchHair(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      float hNdv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
      diffuseColor.rgb *= mix(1.22, 0.96, hNdv);`,
    );
  };
  m.customProgramCacheKey = () => 'kynd-hair';
}

export interface KyndMaterials {
  garment: THREE.MeshStandardMaterial;
  hair: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
}

let shared: KyndMaterials | null = null;

export function kyndMaterials(): KyndMaterials {
  if (shared) return shared;
  // Double-sided: from below (a Kynd lying down) the inside of a shirt or skirt must not vanish.
  const garment = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  patchGarment(garment);
  const hair = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.76,
    map: strandTexture(), bumpMap: strandTexture(), bumpScale: 0.0012 });
  patchHair(hair);
  const eye = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12 });
  patchEye(eye);
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.85 });
  shared = { garment, hair, eye, metal };
  return shared;
}

// --- skin & face detail ------------------------------------------------------------------

export interface FaceDetail {
  /** Strength of age lines: 0 child or teen, a hint on adults, full on elders. */
  age: number;
  /** 0 none, 0.55 light, 1 dark shadow of stubble. */
  stubble: number;
  freckles: boolean;
  scar: boolean;
}

/** Head-space x of the canonical face at canonical angle θ and height y (as the mesh is laid out). */
function canonicalX(): (theta: number, y: number) => number {
  const look = {
    sex: 'female', jaw: 0.5, nose: 0.5, faceWidth: 0.5, faceLength: 0.5, cheekbones: 0.5, eyeSpacing: 0.5, eyeSize: 0.5, eyeShape: 0.5, mouthWidth: 0.5, lipFullness: 0.5, browShape: 0.5,
    ...Object.fromEntries(DETAIL_FIELDS.map((f) => [f, 0.5])),
  } as FullAppearance;
  const head = new Head(look, 'adult');
  const T = 1.32;
  const NT = 132;
  const Y0 = -0.032;
  const Y1 = 0.252;
  const NY = 142;
  const tab = new Float32Array((NT + 1) * (NY + 1));
  const p = new THREE.Vector3();
  for (let j = 0; j <= NY; j++) {
    const y = Y0 + ((Y1 - Y0) * j) / NY;
    const front = head.phiAt(0, y);
    for (let i = 0; i <= NT; i++) {
      const th = (T * i) / NT;
      const w = smoothstep(1.35, 0.85, th);
      head.point(th, w > 0 ? front + (head.phiAt(th, y) - front) * w : front, p);
      tab[j * (NT + 1) + i] = p.x;
    }
  }
  return (theta, y) => {
    const fi = Math.min(NT - 1e-6, (Math.abs(theta) / T) * NT);
    const fj = Math.max(0, Math.min(NY - 1e-6, ((y - Y0) / (Y1 - Y0)) * NY));
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const a = fi - i;
    const b = fj - j;
    const r0 = tab[j * (NT + 1) + i] * (1 - a) + tab[j * (NT + 1) + i + 1] * a;
    const r1 = tab[(j + 1) * (NT + 1) + i] * (1 - a) + tab[(j + 1) * (NT + 1) + i + 1] * a;
    return Math.sign(theta) * (r0 * (1 - b) + r1 * b);
  };
}

let faceTex: THREE.DataTexture | null = null;

/** The one face texture every Kynd shares (see kyndFaceTexture.ts). */
function faceTexture(): THREE.DataTexture {
  if (faceTex) return faceTex;
  const size = 1024;
  faceTex = new THREE.DataTexture(paintFaceTexture(size, canonicalX()), size, size, THREE.RGBAFormat);
  faceTex.wrapS = faceTex.wrapT = THREE.ClampToEdgeWrapping;
  faceTex.magFilter = THREE.LinearFilter;
  faceTex.minFilter = THREE.LinearMipmapLinearFilter;
  faceTex.generateMipmaps = true;
  faceTex.anisotropy = 8;
  faceTex.colorSpace = THREE.NoColorSpace;
  faceTex.needsUpdate = true;
  return faceTex;
}

const skinCache = new Map<string, THREE.MeshStandardMaterial>();

/** Skin materials share one shader and one texture; they differ only in a few uniforms. */
export function skinMaterial(d: FaceDetail): THREE.MeshStandardMaterial {
  const key = `${d.age.toFixed(2)}|${d.stubble.toFixed(2)}|${d.freckles}|${d.scar}`;
  let m = skinCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.58 });
    patchSkin(m, { uAge: { value: d.age }, uStubble: { value: d.stubble }, uFreckles: { value: d.freckles ? 1 : 0 }, uScar: { value: d.scar ? 1 : 0 } });
    skinCache.set(key, m);
  }
  return m;
}

import * as THREE from 'three';
import { applyDetail, type DetailOptions } from './detailMaterial.ts';

/** Shared colour palette and small mesh helpers for the stylised look. */
export const COLORS = {
  oak: '#8a5a34',
  lightOak: '#b07c4c',
  darkOak: '#4a2f1f',
  timber: '#3d2718',
  plaster: '#eadfc4',
  stone: '#a39a8d',
  darkStone: '#6f675d',
  iron: '#39373a',
  straw: '#d9bb6c',
  thatch: '#a8844a',
  linen: '#efe6d2',
  wool: '#6f4a8a',
  soil: '#5b3d27',
  leaf: '#5d8a3a',
  ember: '#ff8a2a',
  water: '#6f9fb0',
  ceramic: '#b6734a',
  cheese: '#e8c35a',
  bread: '#c58b45',
} as const;

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

export interface MatOptions {
  rough?: number;
  metal?: number;
  emissive?: string;
  emissiveIntensity?: number;
  transparent?: number;
  flat?: boolean;
  /** Tri-planar surface detail (grain, weave, stone…). A kind name uses that kind's defaults. */
  detail?: DetailOptions['kind'] | DetailOptions;
}

/** Cached standard material. Don't mutate the result; clone it if a per-mesh variant is needed. */
export function mat(color: string, o: MatOptions = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${o.rough ?? 0.85}|${o.metal ?? 0}|${o.emissive ?? ''}|${o.emissiveIntensity ?? 1}|${o.transparent ?? 1}|${o.flat ?? false}|${JSON.stringify(o.detail ?? '')}`;
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: o.rough ?? 0.85,
      metalness: o.metal ?? 0,
      flatShading: o.flat ?? false,
    });
    if (o.emissive) {
      m.emissive = new THREE.Color(o.emissive);
      m.emissiveIntensity = o.emissiveIntensity ?? 1;
    }
    if (o.transparent !== undefined && o.transparent < 1) {
      m.transparent = true;
      m.opacity = o.transparent;
      m.depthWrite = false;
    }
    if (o.detail) applyDetail(m, typeof o.detail === 'string' ? { kind: o.detail } : o.detail);
    materialCache.set(key, m);
  }
  return m;
}

function finish(mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh {
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Box whose base sits at `y` (not centred), which is how furniture is easiest to lay out. */
export function box(w: number, h: number, d: number, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  return finish(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material), x, y + h / 2, z);
}

export function cyl(rTop: number, rBottom: number, h: number, material: THREE.Material, x = 0, y = 0, z = 0, seg = 12): THREE.Mesh {
  return finish(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), material), x, y + h / 2, z);
}

export function sphere(r: number, material: THREE.Material, x = 0, y = 0, z = 0, seg = 12): THREE.Mesh {
  return finish(new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg * 0.75)), material), x, y, z);
}

/** Procedural canvas texture, so the project ships without binary art assets for now. */
export function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void, repeat = 1): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d', { willReadFrequently: true })!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

/** Deterministic hash noise in [0,1). */
export function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Tag every mesh under `root` with picking data. */
export function tagPickable(root: THREE.Object3D, data: Record<string, unknown>): void {
  root.traverse((o) => Object.assign(o.userData, data));
}

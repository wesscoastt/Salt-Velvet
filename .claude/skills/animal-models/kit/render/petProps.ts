import * as THREE from 'three';
import { mat, sphere, cyl } from './kit.ts';

/**
 * The little things pets deal in (sim/animals/Foraging.ts): the mouse by the larder, a sparrow
 * hopping in the yard, a butterfly, and what's carried home in a mouth (a bone, a coin, a ring).
 * Real sizes in metres; origin on the ground (or at the grip point, for things carried).
 */

function body(r: [number, number, number], m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const s = sphere(1, m, x, y, z, 10);
  s.scale.set(...r);
  return s;
}

function rodent(big: boolean): THREE.Group {
  const g = new THREE.Group();
  const k = big ? 1.55 : 1;
  const fur = mat(big ? '#5a4f45' : '#8a7c6c', { rough: 0.9 });
  const pink = mat('#d9a3a0', { rough: 0.7 });
  const black = mat('#141110', { rough: 0.3 });
  g.add(body([0.03 * k, 0.026 * k, 0.05 * k], fur, 0, 0.026 * k, 0));
  g.add(body([0.019 * k, 0.017 * k, 0.026 * k], fur, 0, 0.032 * k, 0.05 * k));
  for (const sx of [-1, 1]) {
    g.add(body([0.011 * k, 0.012 * k, 0.003 * k], pink, sx * 0.013 * k, 0.05 * k, 0.042 * k));
    g.add(sphere(0.0035 * k, black, sx * 0.01 * k, 0.038 * k, 0.068 * k, 6));
  }
  g.add(sphere(0.004 * k, pink, 0, 0.03 * k, 0.076 * k, 6));
  // The tail: a thin curve trailing behind.
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.02 * k, -0.045 * k), new THREE.Vector3(0.02 * k, 0.008 * k, -0.08 * k), new THREE.Vector3(-0.01 * k, 0.004 * k, -0.12 * k), new THREE.Vector3(0.015 * k, 0.004 * k, -0.15 * k)]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.003 * k, 5), pink));
  return g;
}

function sparrow(): THREE.Group {
  const g = new THREE.Group();
  const brown = mat('#8a6440', { rough: 0.85 });
  const buff = mat('#d8c3a0', { rough: 0.85 });
  const dark = mat('#4a3626', { rough: 0.85 });
  g.add(body([0.032, 0.03, 0.05], brown, 0, 0.05, 0));
  g.add(body([0.026, 0.024, 0.036], buff, 0, 0.042, 0.012));
  const head = new THREE.Group();
  head.position.set(0, 0.078, 0.038);
  head.add(sphere(0.022, brown, 0, 0, 0, 10));
  head.add(body([0.019, 0.008, 0.02], dark, 0, 0.012, -0.002));
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.016, 6), mat('#b89a5a', { rough: 0.5 }));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, -0.003, 0.025);
  head.add(beak);
  for (const sx of [-1, 1]) head.add(sphere(0.003, mat('#111111', { rough: 0.3 }), sx * 0.014, 0.004, 0.012, 6));
  g.add(head);
  for (const sx of [-1, 1]) {
    const wing = body([0.008, 0.022, 0.042], dark, sx * 0.028, 0.055, -0.006);
    wing.rotation.z = sx * 0.2;
    g.add(wing);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.05), dark);
  tail.position.set(0, 0.052, -0.06);
  tail.rotation.x = -0.35;
  g.add(tail);
  for (const sx of [-1, 1]) g.add(cyl(0.002, 0.002, 0.026, mat('#7a5a3a'), sx * 0.01, 0, 0.004, 4));
  g.userData.head = head;
  return g;
}

let wingTex: THREE.CanvasTexture | null = null;
function butterfly(): THREE.Group {
  if (!wingTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.fillStyle = '#e8a33a';
    x.beginPath();
    x.ellipse(32, 32, 30, 28, 0, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#2a1a10';
    x.lineWidth = 5;
    x.stroke();
    x.fillStyle = '#2a1a10';
    for (const [px, py] of [[20, 18], [44, 22], [30, 44]]) {
      x.beginPath();
      x.arc(px, py, 4, 0, Math.PI * 2);
      x.fill();
    }
    wingTex = new THREE.CanvasTexture(c);
    wingTex.colorSpace = THREE.SRGBColorSpace;
  }
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ map: wingTex, side: THREE.DoubleSide, transparent: true, alphaTest: 0.4, roughness: 0.8 });
  const wings: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.045), m);
    w.rotation.x = -Math.PI / 2;
    w.position.x = sx * 0.021;
    pivot.add(w);
    pivot.userData.side = sx;
    wings.push(pivot);
    g.add(pivot);
  }
  g.add(cyl(0.003, 0.003, 0.03, mat('#2a1a10'), 0, -0.0015, 0, 5)).rotation.x = Math.PI / 2;
  g.userData.wings = wings;
  return g;
}

function bone(): THREE.Group {
  const g = new THREE.Group();
  const m = mat('#e8dfc8', { rough: 0.7 });
  const shaft = cyl(0.009, 0.009, 0.11, m, 0, -0.055, 0, 8);
  const holder = new THREE.Group();
  holder.add(shaft);
  for (const y of [-0.055, 0.055]) for (const sx of [-1, 1]) holder.add(sphere(0.013, m, sx * 0.008, y, 0, 8));
  holder.rotation.z = Math.PI / 2;
  g.add(holder);
  return g;
}

function coin(gold: boolean): THREE.Group {
  const g = new THREE.Group();
  const c = cyl(0.016, 0.016, 0.003, mat(gold ? '#c99a3a' : '#b06a3a', { metal: 0.7, rough: 0.35 }), 0, -0.0015, 0, 14);
  c.rotation.x = Math.PI / 2;
  g.add(c);
  return g;
}

function ring(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0035, 6, 16), mat('#a8743a', { metal: 0.75, rough: 0.35 })));
  return g;
}

/** A pet prop by name: prey (mouse, rat, sparrow, butterfly) or a find (bone, coin, trinket). */
export function petProp(kind: string): THREE.Group | null {
  let g: THREE.Group;
  switch (kind) {
    case 'mouse':
      g = rodent(false);
      break;
    case 'rat':
      g = rodent(true);
      break;
    case 'sparrow':
      g = sparrow();
      break;
    case 'butterfly':
      g = butterfly();
      break;
    case 'bone':
      g = bone();
      break;
    case 'coin':
      g = coin(true);
      break;
    case 'trinket':
      g = ring();
      break;
    default:
      return null;
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return g;
}

/** Bring a prop to life: a mouse nibbles and twitches, a sparrow hops and pecks, a butterfly flits. */
export function animateProp(g: THREE.Group, kind: string, t: number): void {
  if (kind === 'butterfly') {
    for (const w of g.userData.wings as THREE.Object3D[]) w.rotation.z = (w.userData.side as number) * (0.2 + Math.abs(Math.sin(t * 22)) * 1.1);
    g.position.y += 0.3 + Math.sin(t * 2.1) * 0.08;
    g.position.x += Math.sin(t * 1.3) * 0.12;
    g.position.z += Math.cos(t * 1.7) * 0.1;
    g.rotation.y = t * 0.8;
  } else if (kind === 'sparrow') {
    const hop = (t * 1.6) % 1;
    g.position.y += hop < 0.25 ? Math.sin((hop / 0.25) * Math.PI) * 0.035 : 0;
    const head = g.userData.head as THREE.Object3D;
    head.rotation.x = Math.sin(t * 5) > 0.7 ? 0.7 : 0;
    g.rotation.y = Math.floor(t * 0.7) * 1.3;
  } else if (kind === 'mouse' || kind === 'rat') {
    g.rotation.y = Math.sin(t * 0.9) * 0.6;
    g.position.x += Math.sin(t * 0.5) * 0.03;
    g.scale.y = 1 + Math.sin(t * 17) * 0.04;
  }
}

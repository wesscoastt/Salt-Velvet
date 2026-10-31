import * as THREE from 'three';
import { mat } from './kit.ts';

const LANCE_LEN = 3.3;

/**
 * A tournament lance: a long painted ash shaft swelling to the grip, a steel vamplate (the cone
 * that guards the hand) and a blunted three-pronged coronel at the tip. Points along local +Z,
 * the grip at the origin.
 */
export function buildLance(paint = '#8a2430', band = '#e8e2c8'): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.Group();
  const a = mat(paint, { rough: 0.6 }), b = mat(band, { rough: 0.6 });
  // Painted in bands, tapering from the grip to the tip.
  const segs = 6;
  const len = LANCE_LEN - 0.55;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const r = (t: number) => 0.034 - t * 0.02;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r(t1), r(t0), len / segs, 10), i % 2 ? b : a);
    m.position.y = 0.25 + (t0 + t1) / 2 * len;
    shaft.add(m);
  }
  // The butt behind the hand, and the grip itself bound in leather.
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.026, 0.55, 10), a);
  butt.position.y = -0.03;
  shaft.add(butt);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 10), mat('#3a2418', { rough: 0.9, detail: 'leather' }));
  grip.position.y = 0;
  shaft.add(grip);
  const steel = mat('#b8bcc4', { rough: 0.35, metal: 0.8 });
  const vamplate = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.24, 16, 1, true), steel);
  vamplate.material = steel.clone();
  (vamplate.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  vamplate.position.y = 0.2;
  shaft.add(vamplate);
  const coronel = new THREE.Group();
  coronel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.07, 8), steel));
  for (let i = 0; i < 3; i++) {
    const prong = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.06, 5), steel);
    const th = (i / 3) * Math.PI * 2;
    prong.position.set(Math.cos(th) * 0.025, 0.06, Math.sin(th) * 0.025);
    coronel.add(prong);
  }
  coronel.position.y = 0.25 + len + 0.02;
  shaft.add(coronel);
  shaft.rotation.x = Math.PI / 2;
  g.add(shaft);
  g.traverse((o) => {
    o.castShadow = true;
  });
  return g;
}

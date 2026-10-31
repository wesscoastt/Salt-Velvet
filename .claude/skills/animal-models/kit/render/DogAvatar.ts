import * as THREE from 'three';
import { petProp } from './petProps.ts';
import type { AnimalActivity, AnimalGenome } from '../sim/animals/Animal.ts';
import type { AnimalStage } from '../sim/animals/Species.ts';
import { mixColor } from '../sim/family/genetics.ts';
import { diffuseWeights, meshNeighbours, sculpt, type Mass, type V3 } from './sdfMesh.ts';
import { BONE, BONE_COUNT, LEG_BASE, TAG, TAG_COUNT, TAIL_BONES, buildRig, legBone, type PetRig } from './petAnatomy.ts';
import { applyCoatAttributes, coatColorAt, coatFields, coatPlan, eyeTexture, furMaterial, furShellMaterial, type CoatSample } from './petCoat.ts';

/**
 * A dog or a cat, built from its genome (see petAnatomy.ts for the proportions and petCoat.ts for
 * the coat). The body, legs, neck, head and tail are one seamless skinned surface sculpted from
 * smooth masses; the jaw, nose, eyes, lids and ears are small separate parts on the head.
 *
 * Animation is procedural. Each activity is a pose: where the pelvis sits, how the spine bends,
 * where the head looks, and a target for each paw. Legs reach their paws with two-bone IK plus a
 * pastern/hock angle, so paws stay on the ground in every pose. Walking and running are driven by
 * the distance actually travelled, so planted paws never slide: dogs trot on diagonal pairs, cats
 * walk in a four-beat sequence, both gallop when running. Poses blend with critically damped
 * springs (no snapping), and the tail, ears and breathing add secondary motion on top.
 * Forward is local +Z, like every other model in the game.
 */

interface Pose {
  hipsY: number; hipsZ: number; pitch: number; roll: number; bend: number;
  flex: number; chest: number;
  neck: number; neckYaw: number; head: number; headYaw: number; headRoll: number;
  jaw: number; tongue: number; ears: number; earsOut: number;
  tailUp: number; tailCurl: number; tailWag: number; tailHz: number; tailSide: number;
  eyes: number; gazeX: number; gazeY: number;
  /** 1 when the body rests on the ground (sitting, lying): the lowest point of the body is brought to it. */
  ground: number;
  /** Per leg: x, y, z (H units, root space), lower segment angle, paw pitch. */
  feet: number[];
}

const POSE_KEYS = ['hipsY', 'hipsZ', 'pitch', 'roll', 'bend', 'flex', 'chest', 'neck', 'neckYaw', 'head', 'headYaw', 'headRoll', 'jaw', 'tongue', 'ears', 'earsOut', 'tailUp', 'tailCurl', 'tailWag', 'tailHz', 'tailSide', 'eyes', 'gazeX', 'gazeY', 'ground'] as const;

const clamp = THREE.MathUtils.clamp;
const smoothstep = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const ease = (t: number) => t * t * (3 - 2 * t);
/** Smooth wandering signal in −1…1 from a sum of incommensurate sines. */
type PetHabit = 'scratch' | 'shake' | 'yawn' | 'stretch' | 'nose' | 'wash' | 'flick' | 'chin' | 'twitch' | 'dream';
/**
 * Habits, by what the animal is doing and whether it's a dog or a cat: [kind, weight, shortest,
 * longest (seconds)]. One at a time, now and then.
 */
const PET_HABITS: Record<'stand' | 'lie' | 'sleep', Record<'dog' | 'cat', [PetHabit, number, number, number][]>> = {
  stand: {
    dog: [['scratch', 2, 1.8, 2.8], ['shake', 1.5, 1, 1.3], ['yawn', 1.5, 1.6, 2.2], ['stretch', 1.5, 2.2, 3], ['nose', 2, 2, 3.5]],
    cat: [['wash', 2.5, 3, 5], ['yawn', 1.5, 1.4, 2], ['stretch', 1.5, 2.2, 3.2], ['flick', 2, 1.2, 2]],
  },
  lie: {
    dog: [['chin', 2, 5, 9], ['yawn', 1, 1.6, 2.2], ['twitch', 1.5, 0.6, 1]],
    cat: [['chin', 1.5, 4, 8], ['yawn', 1, 1.4, 2], ['flick', 2, 1.2, 2], ['wash', 1, 3, 4.5]],
  },
  sleep: {
    dog: [['dream', 2, 2.5, 4.5], ['twitch', 1, 0.6, 1]],
    cat: [['twitch', 2, 0.6, 1]],
  },
};
/** Scratching: the raised hind foot (height, reach forward; H units) and the neck brought down and round to it. */
const SCRATCH_FOOT: [number, number] = [0.72, 0.15];
const SCRATCH_NECK = -0.55, SCRATCH_YAW = 0.75;
/** What it may watch someone during (not asleep, not busy with its nose or paws), and how far round the head and neck turn. */
const LOOKING = new Set<AnimalActivity>(['idle', 'sit', 'lie', 'wag', 'beg', 'bark', 'shy']);
const LOOK_YAW = 1.25;
/** Squaring up after a halt: seconds for each paw's step, and how far off its mark a paw may be left (H units). */
const PAW_STEP = 0.24, PAW_SLACK = 0.035;
/** Poses stood on all four paws, and the habits that leave the paws where they are. */
const STANDING = new Set<AnimalActivity>(['idle', 'wag', 'bark', 'sniff', 'eat', 'drink', 'shy']);
const STILL_HABITS = new Set<PetHabit>(['shake', 'yawn', 'nose', 'flick', 'twitch']);
/** Seconds of sitting on the way down to lying, and on the way back up. */
const VIA_SIT_DOWN = 0.7, VIA_SIT_UP = 0.45;
const wander = (t: number, seed: number) => (Math.sin(t * 0.71 + seed) * 0.5 + Math.sin(t * 1.37 + seed * 2.3) * 0.3 + Math.sin(t * 2.93 + seed * 0.7) * 0.2);

const geometryCache = new Map<string, THREE.BufferGeometry>();
/** A copy of a cached geometry, building it the first time (a small LRU). */
function cachedGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geometryCache.get(key);
  if (g) geometryCache.delete(key);
  else g = build();
  geometryCache.set(key, g);
  if (geometryCache.size > 48) geometryCache.delete(geometryCache.keys().next().value!);
  return g.clone();
}

const sharedMats = new Map<string, THREE.Material>();
function shared<T extends THREE.Material>(key: string, make: () => T): T {
  let m = sharedMats.get(key) as T | undefined;
  if (!m) { m = make(); m.userData.shared = true; sharedMats.set(key, m); }
  return m;
}

export class DogAvatar {
  readonly root = new THREE.Group();
  readonly headAnchor = new THREE.Object3D();
  private rig: PetRig;
  private cat: boolean;
  private bones: THREE.Bone[] = [];
  private jaw = new THREE.Object3D();
  /** Whatever is carried in the mouth (prey, a find): see `hold`. */
  private held = new THREE.Group();
  private heldKind: string | null = null;
  private ears: { pivot: THREE.Object3D; side: number; vel: number; ang: number; velOut: number; out: number }[] = [];
  private lids: { upper: THREE.Object3D; lower: THREE.Object3D; side: number }[] = [];
  private eyeballs: THREE.Object3D[] = [];
  private tongue!: THREE.Mesh;
  private cur: Pose;
  private vel: Record<string, number> = {};
  private feetVel: number[] = new Array(20).fill(0);
  private moveW = 0;
  private runW = 0;
  private clock = 0;
  private seed: number;
  private blinkAt = 1.5;
  private blinkT = -1;
  private glanceAt = 0;
  private glance = { yaw: 0, pitch: 0 };
  private tailState: { ang: number; vel: number; side: number; sideVel: number }[] = [];
  private lastYaw: number | null = null;
  /** Something to watch (world space) or null, how much the head is on it (0…1), and the turn and lift toward it. */
  private lookTarget: THREE.Vector3 | null = null;
  private lookW = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private canLook = false;
  /** How far the body turned since the last frame (radians). */
  private yawStep = 0;
  private turn = 0;
  private lastDistance = 0;
  private speed = 0;
  private restTheta: number[] = [];
  private restQuat = new THREE.Quaternion();
  private breathe = 0;
  /** Rest-pose points on the body (bone, local offset) used to keep it on, not in, the ground. */
  private probes: { bone: number; p: THREE.Vector3 }[] = [];
  private groundFix = 0;
  /** A passing bit of business (see PET_HABITS), and when the next may come. */
  private habit: { kind: PetHabit; at: number; len: number; side: number } | null = null;
  private habitNext = 4 + Math.random() * 8;
  private lastHabit: string | null = null;
  /** Where each paw was last put down (x, z; H units), and a paw stepping to its mark (see apply). */
  private planted = [0, 0, 0, 0, 0, 0, 0, 0];
  private plantedYet = false;
  /** Each paw's progress through a step (0…1), or −1 planted; where from and to (x, z pairs). */
  private stepT = [-1, -1, -1, -1];
  private stepFrom = [0, 0, 0, 0, 0, 0, 0, 0];
  private stepTo = [0, 0, 0, 0, 0, 0, 0, 0];
  /** The first paw stepping, or −1 (for tests and tools). */
  get stepLeg(): number { return this.stepT.findIndex((x) => x >= 0); }
  /** Stood square on all four (a pose whose paws stay put), so a halt is stepped, not slid. */
  private standing = false;
  /** Lying down or getting up goes by way of sitting until this (clock) time. */
  private viaSitUntil = 0;
  private low = false;

  constructor(g: AnimalGenome, stage: AnimalStage, species: 'dog' | 'cat' = 'dog') {
    const cat = species === 'cat';
    this.cat = cat;
    const elder = stage === 'elder';
    const rig = buildRig(g, stage, cat ? 'cat' : 'dog');
    this.rig = rig;
    const H = rig.H;
    this.seed = (parseInt(g.coat.slice(1), 16) % 997) * 0.37 + g.size * 13 + g.build * 7;

    // Skeleton: identity rest rotations, so rest directions are simple joint differences.
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new THREE.Bone();
      b.name = `pet-bone-${i}`;
      this.bones.push(b);
    }
    rig.parents.forEach((p, i) => {
      const j = rig.joints[i];
      const pj = p >= 0 ? rig.joints[p] : [0, 0, 0];
      this.bones[i].position.set(j[0] - pj[0], j[1] - pj[1], j[2] - pj[2]);
      (p >= 0 ? this.bones[p] : this.root).add(this.bones[i]);
    });
    for (let l = 0; l < 4; l++) {
      const j = rig.legs[l].joints;
      this.restTheta.push(Math.atan2(-(j[2][2] - j[3][2]), j[2][1] - j[3][1]));
    }

    // The coat.
    const plan = coatPlan(g, cat ? 'cat' : 'dog', elder);
    const fur = furMaterial(plan);

    // Body: one connected sculpt, automatically skinned.
    const voxel = H / (cat ? 40 : 42);
    // Sculpting is the expensive part, so geometry is cached per genome: a pet that ages back into
    // view or reappears on a lot is rebuilt from a copy.
    const key = JSON.stringify([g, stage, species]);
    const geometry = cachedGeometry(key + 'body', () => {
      const body = sculpt(rig.masses, voxel, TAG_COUNT, { weightSoft: voxel * 2.2 });
      const geometry = new THREE.BufferGeometry();
      if (g.coatLength > 0.45) {
        // A long coat breaks the silhouette into soft clumps.
        const amt = (g.coatLength - 0.45) * H * 0.035;
        for (let i = 0; i < body.positions.length / 3; i++) {
          const x = body.positions[i * 3], y = body.positions[i * 3 + 1], z = body.positions[i * 3 + 2];
          // Two octaves of value noise: soft locks, with no banding along the body or tail.
          const n = (valueNoise(x / H * 7, y / H * 7, z / H * 7) * 0.75 + valueNoise(x / H * 15 + 5, y / H * 15, z / H * 15) * 0.25) * 2 - 1;
          const tags = body.tagWeights.subarray(i * TAG_COUNT, i * TAG_COUNT + TAG_COUNT);
          const k = amt * (n * 0.5 + 0.5) * (1 - tags[TAG.paw]) * (1 - tags[TAG.muzzle] * 0.8) * (1 - tags[TAG.head] * 0.6);
          body.positions[i * 3] += body.normals[i * 3] * k;
          body.positions[i * 3 + 1] += body.normals[i * 3 + 1] * k;
          body.positions[i * 3 + 2] += body.normals[i * 3 + 2] * k;
        }
      }
      smoothChainWeights(body.positions, body.skinIndex, body.skinWeight, rig, BONE.tail, TAIL_BONES, rig.joints.slice(BONE.tail, BONE.tail + TAIL_BONES).concat([tailTip(rig)]));
      groundMidline(body.positions, body.skinIndex, body.skinWeight, rig);
      diffuseWeights(meshNeighbours(body.indices, body.positions.length / 3), body.skinIndex, body.skinWeight, 4);
      geometry.setAttribute('position', new THREE.BufferAttribute(body.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(body.normals, 3));
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(body.skinIndex, 4));
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(body.skinWeight, 4));
      geometry.setIndex(new THREE.BufferAttribute(body.indices, 1));
      applyCoatAttributes(geometry, rig, g, elder, (i, out) => { for (let t = 0; t < TAG_COUNT; t++) out[t] = body.tagWeights[i * TAG_COUNT + t]; });
      // How long the fur grows here: none on the pads and nose, short on the face and lower legs.
      const furLen = new Float32Array(body.positions.length / 3);
      for (let i = 0; i < furLen.length; i++) {
        const t = body.tagWeights.subarray(i * TAG_COUNT, i * TAG_COUNT + TAG_COUNT);
        furLen[i] = Math.max(0, 1 - t[TAG.paw] - t[TAG.muzzle] * 0.95 - t[TAG.head] * 0.6 - t[TAG.brow] * 0.4 - t[TAG.leg] * 0.35);
      }
      geometry.setAttribute('aFur', new THREE.BufferAttribute(furLen, 1));
      geometry.computeBoundingSphere();
      return geometry;
    });
    // Ground probes: a spread of body vertices that move rigidly enough with one bone (torso,
    // shoulder, thigh, forearm, shin). Paws are excluded: the leg IK already plants them.
    {
      const pos = geometry.getAttribute('position'), si = geometry.getAttribute('skinIndex'), sw = geometry.getAttribute('skinWeight');
      const allowed = (bone: number) => bone <= BONE.ribs || (bone >= LEG_BASE && (bone - LEG_BASE) % 4 < 2);
      const candidates: number[] = [];
      for (let i = 0; i < pos.count; i++) if (sw.getX(i) > 0.55 && allowed(si.getX(i)) && pos.getY(i) < rig.joints[BONE.hips][1]) candidates.push(i);
      const stride = Math.max(1, Math.ceil(candidates.length / 140));
      for (let n = 0; n < candidates.length; n += stride) {
        const i = candidates[n], bone = si.getX(i), j = rig.joints[bone];
        this.probes.push({ bone, p: new THREE.Vector3(pos.getX(i) - j[0], pos.getY(i) - j[1], pos.getZ(i) - j[2]) });
      }
    }
    const skin = new THREE.SkinnedMesh(geometry, fur);
    skin.name = 'pet-body';
    skin.frustumCulled = false;
    skin.castShadow = true;
    this.root.add(skin);
    this.root.updateMatrixWorld(true);
    skin.bind(new THREE.Skeleton(this.bones));
    // Fur shells over the body: many and long for a shaggy coat, a couple of short ones for a sleek one.
    {
      const long = Math.max(0, g.coatLength - 0.3);
      const layers = long > 0 ? Math.round(5 + long * 12) : 2;
      const len = H * (long > 0 ? 0.014 + long * 0.06 : 0.008);
      const density = long > 0 ? 76 : 100;
      for (let i = 1; i <= layers; i++) {
        const shell = new THREE.SkinnedMesh(geometry, furShellMaterial(plan, i / layers, len, density));
        shell.name = 'pet-fur';
        shell.frustumCulled = false;
        shell.raycast = () => {};
        this.root.add(shell);
        shell.bind(skin.skeleton, skin.bindMatrix);
      }
    }

    const head = this.bones[BONE.head];
    const headRest = rig.headPos;
    const restAt = (local: V3, offset: V3): [number, number, number] => [headRest[0] + offset[0] + local[0], headRest[1] + offset[1] + local[1], headRest[2] + offset[2] + local[2]];

    // Jaw, mouth and tongue.
    this.jaw.position.set(...rig.jawHinge);
    head.add(this.jaw);
    const jawGeo = cachedGeometry(key + 'jaw', () => {
      const jawGeo = this.rigidSculpt(rig.jawMasses, voxel * 0.7);
      applyCoatAttributes(jawGeo, rig, g, elder, (_i, out) => { out[TAG.head] = 1; out[TAG.muzzle] = 1; }, (i, out) => {
        const p = jawGeo.getAttribute('position');
        const r = restAt([p.getX(i), p.getY(i), p.getZ(i)], rig.jawHinge);
        out[0] = r[0]; out[1] = r[1]; out[2] = r[2];
      });
      return jawGeo;
    });
    const jawMesh = new THREE.Mesh(jawGeo, fur);
    jawMesh.name = 'pet-jaw';
    this.jaw.add(jawMesh);
    const mouthMat = shared('mouth', () => new THREE.MeshStandardMaterial({ color: '#4a1f22', roughness: 0.6 }));
    const palate = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), mouthMat);
    palate.position.set(...rig.mouth.palate);
    palate.scale.set(...rig.mouth.palateR);
    head.add(palate);
    const tongueMat = shared('tongue', () => new THREE.MeshStandardMaterial({ color: '#c8656a', roughness: 0.5 }));
    this.tongue = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), tongueMat);
    this.tongue.position.set(...rig.mouth.tongue);
    this.tongue.scale.set(...rig.mouth.tongueR);
    this.jaw.add(this.tongue);
    // Held between the front teeth, crosswise.
    this.held.position.set(rig.mouth.tongue[0], rig.mouth.tongue[1] + H * 0.015, rig.mouth.tongue[2] + H * 0.05);
    this.jaw.add(this.held);

    // Nose: dark and moist for dogs; pink, slate or dark for cats depending on the coat.
    const noseGeo = cachedGeometry(key + 'nose', () => this.rigidSculpt(rig.noseMasses, voxel * 0.35));
    const noseColor = cat
      ? (g.pattern === 'masked' ? '#4a3a36' : new THREE.Color(g.coat).getHSL({ h: 0, s: 0, l: 0 }).l < 0.12 ? '#2a2322' : new THREE.Color(g.coat).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6 || g.pattern === 'patched' ? '#d48e86' : g.coat.toLowerCase() === '#d0823a' ? '#c97a6c' : '#6e5c5e')
      : (g.pattern === 'patched' && new THREE.Color(g.coat).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5 && g.secondary.toLowerCase().startsWith('#b') ? '#5a3a2c' : '#1d1817');
    const nose = new THREE.Mesh(noseGeo, shared('nose' + noseColor, () => new THREE.MeshStandardMaterial({ color: noseColor, roughness: cat ? 0.55 : 0.32 })));
    nose.name = 'pet-nose';
    head.add(nose);

    // Eyes: textured eyeballs in sockets, with lids that blink and shape the aperture.
    const eyeMat = shared('eye' + g.eye + species, () => {
      const map = eyeTexture(g.eye, cat);
      return new THREE.MeshStandardMaterial({ map, roughness: 0.12, metalness: 0, emissive: '#ffffff', emissiveMap: map, emissiveIntensity: 0.12 });
    });
    const sample: CoatSample = { white: 0, second: 0, third: 0, shade: 0, stripe: 0, stripeW: 0 };
    const tags = new Float32Array(TAG_COUNT);
    for (const e of rig.eyes) {
      const side = Math.sign(e.pos[0]);
      const group = new THREE.Group();
      group.position.set(...e.pos);
      group.rotation.y = e.yaw;
      head.add(group);
      const ballGeo = new THREE.SphereGeometry(e.r, 24, 16);
      const bp = ballGeo.getAttribute('position'), buv = ballGeo.getAttribute('uv');
      for (let i = 0; i < bp.count; i++) buv.setXY(i, 0.5 + bp.getX(i) / (2 * e.r), 0.5 + bp.getY(i) / (2 * e.r));
      const ball = new THREE.Mesh(ballGeo, eyeMat);
      group.add(ball);
      this.eyeballs.push(ball);
      // Lid colour from the coat around the eye; the margin is dark like real lids.
      tags.fill(0); tags[TAG.head] = 1; tags[TAG.brow] = 0.3;
      coatFields(rig, g, elder, restAt([side * e.r * 0.6, e.r * 1.1, 0], e.pos), tags, sample);
      const lidCol = coatColorAt(plan, sample);
      const rimCol = new THREE.Color(cat ? '#1c1512' : '#1a1411');
      const lidGeo = (upper: boolean) => {
        const geo = new THREE.SphereGeometry(e.r * 1.045, 22, 7, 0, Math.PI * 2, upper ? 0 : Math.PI / 2, Math.PI / 2);
        const p = geo.getAttribute('position');
        const colors = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) {
          const yy = Math.abs(p.getY(i)) / (e.r * 1.045);
          const c = lidCol.clone().lerp(rimCol, 1 - smoothstep(0.0, 0.16, yy));
          colors.set([c.r, c.g, c.b], i * 3);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return geo;
      };
      const lidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
      const upperPivot = new THREE.Object3D(), lowerPivot = new THREE.Object3D();
      // Cats' almond eyes lift at the outer corner; dogs' are round and open.
      upperPivot.rotation.z = cat ? side * 0.1 : side * 0.04;
      lowerPivot.rotation.z = cat ? side * 0.22 : 0;
      group.add(upperPivot, lowerPivot);
      const upper = new THREE.Mesh(lidGeo(true), lidMat), lower = new THREE.Mesh(lidGeo(false), lidMat);
      const upperHinge = new THREE.Object3D(), lowerHinge = new THREE.Object3D();
      upperHinge.add(upper); lowerHinge.add(lower);
      upperPivot.add(upperHinge); lowerPivot.add(lowerHinge);
      this.lids.push({ upper: upperHinge, lower: lowerHinge, side });
    }

    // Ears.
    const innerMat = shared('ear-inner' + (cat ? plan.base : 'd'), () => new THREE.MeshStandardMaterial({ color: cat ? mixColor('#d9a19a', plan.base, 0.3) : mixColor('#a07a72', plan.base, 0.3), roughness: 0.8, side: THREE.DoubleSide }));
    for (const side of [1, -1]) {
      const base = new THREE.Object3D();
      base.position.set(side * rig.ear.base[0], rig.ear.base[1], rig.ear.base[2]);
      this.orientEar(base, side);
      head.add(base);
      const pivot = new THREE.Object3D();
      base.add(pivot);
      const earGeo = earGeometry(rig.ear.shape, rig.ear.length, rig.ear.width, H, rig.ear.fluff);
      // Coat fields from the ear's rest position on the head.
      head.updateMatrixWorld(true);
      const m = new THREE.Matrix4().makeTranslation(headRest[0], headRest[1], headRest[2]).multiply(new THREE.Matrix4().compose(base.position, base.quaternion, base.scale));
      const v = new THREE.Vector3();
      applyCoatAttributes(earGeo, rig, g, elder, (_i, out) => { out[TAG.head] = 1; out[TAG.ear] = 1; }, (i, out) => {
        v.fromBufferAttribute(earGeo.getAttribute('position'), i).applyMatrix4(m);
        out[0] = v.x; out[1] = v.y; out[2] = v.z;
      });
      const ear = new THREE.Mesh(earGeo, [fur, innerMat]);
      ear.name = 'pet-ear';
      pivot.add(ear);
      this.ears.push({ pivot, side, vel: 0, ang: 0, velOut: 0, out: 0 });
    }

    if (rig.whiskers) {
      const wGeo: THREE.BufferGeometry[] = [];
      for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
        const len = H * (0.28 - i * 0.02);
        const w = new THREE.CylinderGeometry(H * 0.0012, H * 0.0028, len, 3, 1, true);
        w.translate(0, len / 2, 0);
        w.rotateZ(-side * (Math.PI / 2 - 0.25 + i * 0.13));
        w.rotateY(side * 0.35);
        w.translate(side * H * 0.045, rig.whiskers[1] + (i - 1.5) * H * 0.008, rig.whiskers[2] - H * 0.005);
        wGeo.push(w);
      }
      const merged = mergeGeometries(wGeo);
      const whiskers = new THREE.Mesh(merged, shared('whisker', () => new THREE.MeshBasicMaterial({ color: '#f6f1e6', transparent: true, opacity: 0.65, depthWrite: false })));
      whiskers.name = 'pet-whiskers';
      head.add(whiskers);
    }

    this.headAnchor.position.set(0, H * (cat ? 0.2 : 0.16), H * 0.04);
    head.add(this.headAnchor);

    // Soft contact shadow.
    const blobMat = shared('blob', () => new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.2, depthWrite: false }));
    const blob = new THREE.Mesh(new THREE.CircleGeometry(H * 0.42, 20), blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.scale.set(cat ? 0.8 : 0.9, cat ? 2.0 : 1.7, 1);
    blob.position.set(0, 0.008, -H * 0.04);
    blob.renderOrder = 1;
    this.root.add(blob);

    for (let i = 0; i < TAIL_BONES; i++) this.tailState.push({ ang: 0, vel: 0, side: 0, sideVel: 0 });
    this.cur = this.pose('idle', 0, false, false, []);
    for (const k of POSE_KEYS) this.vel[k] = 0;
    this.apply(0, 0, false);

    this.root.addEventListener('removed', () => this.dispose());
  }

  private rigidSculpt(masses: Mass[], voxel: number): THREE.BufferGeometry {
    const s = sculpt(masses.map(m => ({ ...m, a: [...m.a] as V3, b: m.b ? [...m.b] as V3 : undefined })), voxel, 0, { smooth: 1 });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
    return geo;
  }

  private orientEar(base: THREE.Object3D, side: number): void {
    const shape = this.rig.ear.shape;
    // Leaf space: grows along +Y (up), width along X, inner face +Z. Each shape names where the
    // leaf points (up) and where its opening faces (normal), in head space.
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
    let up: THREE.Vector3, normal: THREE.Vector3;
    if (shape === 'cat') { up = v(side * 0.42, 1, 0.02); normal = v(side * 0.5, 0.05, 1); }
    else if (shape === 'pricked') { up = v(side * 0.36, 1, -0.12); normal = v(side * 0.45, 0.05, 1); }
    else if (shape === 'folded') { up = v(side * 0.75, 1, 0.05); normal = v(side * 0.55, -0.1, 1); }
    else { up = v(side * 0.22, 1, -0.1); normal = v(side, -0.22, 0.05); }
    normal.sub(up.clone().multiplyScalar(normal.dot(up))).normalize();
    const across = new THREE.Vector3().crossVectors(up, normal);
    base.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, up, normal));
  }

  private dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!m.userData.shared) materials.add(m);
      if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
    });
    geometries.forEach(g => g.dispose());
    materials.forEach(m => m.dispose());
  }

  /* --------------------------------------------------------------------------------------- */

  /** Standing paw targets from the rest skeleton. */
  private standFeet(): number[] {
    const H = this.rig.H, out: number[] = [];
    this.rig.legs.forEach((leg, i) => {
      const p = leg.joints[3];
      out.push(p[0] / H, p[1] / H, p[2] / H, this.restTheta[i], 0);
    });
    return out;
  }

  /** Target pose for an activity at time t (H units). */
  private pose(activity: AnimalActivity, t: number, moving: boolean, running: boolean, traits: readonly string[]): Pose {
    const H = this.rig.H;
    const s = Math.sin;
    const cat = this.cat;
    const has = (id: string) => traits.includes(id);
    const hips = this.rig.joints[BONE.hips];
    const feet = this.standFeet();
    const p: Pose = {
      hipsY: hips[1] / H, hipsZ: hips[2] / H, pitch: 0, roll: 0, bend: 0, flex: 0, chest: 0,
      // A relaxed dog carries its head a little low and forward, not held high like a deer.
      neck: cat ? 0 : -0.16, neckYaw: 0, head: cat ? -0.05 : 0.02, headYaw: 0, headRoll: 0,
      jaw: 0, tongue: 0, ears: 0, earsOut: 0,
      tailUp: cat ? 0.5 : 0.35, tailCurl: cat ? 0.08 : 0, tailWag: 0.08, tailHz: 1.2, tailSide: 0,
      eyes: 1, gazeX: 0, gazeY: 0, ground: 0, feet,
    };
    const foot = (leg: number, x: number | null, y: number | null, z: number | null, theta?: number, paw?: number) => {
      const o = leg * 5;
      if (x !== null) feet[o] = x; if (y !== null) feet[o + 1] = y; if (z !== null) feet[o + 2] = z;
      if (theta !== undefined) feet[o + 3] = theta; if (paw !== undefined) feet[o + 4] = paw;
    };
    const fz = (leg: number) => feet[leg * 5 + 2];
    const fx = (leg: number) => feet[leg * 5];
    const ph = this.rig.pawH / H;
    if (moving) {
      // Base carriage while travelling (the gait itself is layered on in apply()).
      p.neck = running ? -0.1 : 0.02;
      p.head = running ? -0.12 : cat ? -0.1 : -0.12;
      p.tailUp = cat ? (running ? 0.15 : 0.75) : running ? 0.1 : 0.45;
      p.tailCurl = cat ? (running ? 0 : 0.14) : 0;
      p.tailWag = cat ? 0.06 : 0.22;
      p.tailHz = cat ? 0.8 : 2.2;
      p.ears = running ? -0.4 : 0.15;
      if (has('friendly') || has('affectionate')) { p.tailUp += 0.15; p.tailWag += 0.1; }
      if (!cat && !running) { p.jaw = 0.12; p.tongue = 0.5; }
      return p;
    }
    const sitLike = (upright: number) => {
      // Haunches down, chest up, front legs straight under the shoulders, hind legs folded.
      p.hipsY = (cat ? 0.27 : 0.25) + upright * 0.05;
      p.hipsZ += cat ? 0.05 : 0.04;
      p.pitch = cat ? 0.7 + upright * 0.4 : 0.58 + upright * 0.55;
      p.flex = cat ? -0.05 : -0.08;
      p.neck = cat ? 0.05 : 0.0;
      p.head = cat ? -0.08 : -0.06;
      const front = cat ? 0.5 : 0.36;
      foot(0, null, ph, front, 0.18, 0); foot(1, null, ph, front, 0.18, 0);
      const hz = cat ? -0.16 : -0.1;
      foot(2, fx(2) * 1.25, ph, hz, Math.PI / 2 - 0.08, 0); foot(3, fx(3) * 1.25, ph, hz, Math.PI / 2 - 0.08, 0);
      if (cat) {
        p.tailUp = -0.45; p.tailCurl = 0.05; p.tailSide = 0.9;
      } else {
        // The hips are tipped back, so the tail is aimed against that: out behind the rump and
        // down to the ground, then along it (the ground pass lays it flat), never under the dog
        // through its own haunches. Only a slight sweep to one side.
        p.tailUp = (p.pitch - 0.5 + 0.75) / 1.7;
        p.tailCurl = -0.14;
        p.tailSide = 0.12;
      }
      p.ground = 1;
    };
    const groom = () => {
      // Sitting, licking a raised forepaw, then wiping the face with it.
      sitLike(0);
      const wipe = s(t * 0.5) > 0.4 ? 1 : 0;
      const lick = Math.max(0, s(t * 8));
      foot(0, fx(0) * 0.5, cat ? 0.58 : 0.55, 0.42 + wipe * 0.06, -1.2, 1.4);
      p.head = -0.55 + wipe * 0.5; p.headYaw = 0.25 - wipe * 0.1; p.headRoll = 0.25 + wipe * 0.2;
      p.neck = -0.1;
      p.jaw = lick * 0.18; p.tongue = lick;
      p.eyes = 0.35;
      p.tailWag = 0.05; p.tailHz = 0.8;
    };
    // On the way down to lying, or back up from it: sitting.
    if (this.clock < this.viaSitUntil) activity = 'sit';
    switch (activity) {
      case 'sit':
        sitLike(0);
        p.tailWag = cat ? 0.04 : 0.15; p.tailHz = cat ? 0.6 : 2;
        p.headYaw = wander(t * 0.4, this.seed) * 0.35;
        p.ears = 0.1;
        break;
      case 'beg': {
        sitLike(1);
        const lift = cat ? 0.42 : 0.5;
        foot(0, fx(0) * 0.9, lift + s(t * 3) * 0.02, 0.35, -0.7, 1.3); foot(1, fx(1) * 0.9, lift + s(t * 3 + 1) * 0.02, 0.35, -0.7, 1.3);
        p.head = 0.25; p.headRoll = s(t * 0.8) * 0.18;
        p.tailWag = 0.35; p.tailHz = 3; p.ears = 0.4; p.jaw = 0.12; p.tongue = cat ? 0 : 0.4;
        break;
      }
      case 'lie':
      case 'sleep': {
        const sleep = activity === 'sleep';
        p.ground = 1;
        p.hipsY = cat ? 0.36 : 0.33;
        p.pitch = 0.04;
        p.flex = 0.05;
        if (cat && sleep) {
          // A loaf: paws tucked under, tail wrapped round.
          p.hipsY = 0.34;
          foot(0, fx(0), 0.1, fz(0) - 0.12, -Math.PI / 2 + 0.25, 1.9); foot(1, fx(1), 0.1, fz(1) - 0.12, -Math.PI / 2 + 0.25, 1.9);
          // Chin tucked down onto the paws.
          p.neck = -1.25; p.head = -0.12;
          // The tail leaves the rump about level, lies on the ground and sweeps round the body.
          p.tailUp = 0.35; p.tailCurl = -0.5; p.tailSide = 1.8;
        } else {
          const reach = cat ? 0.3 : 0.34;
          foot(0, fx(0) * 1.05, ph, fz(0) + reach, Math.PI / 2 - 0.05, 0); foot(1, fx(1) * 1.05, ph, fz(1) + reach - (sleep ? 0.06 : 0), Math.PI / 2 - 0.05, 0);
          // Asleep, the chin drops onto the forepaws.
          // (The neck rises from the withers, so it has to go well past level to get there.)
          p.neck = sleep ? -1.5 : -0.05;
          p.head = sleep ? 0.02 : -0.1;
          p.tailUp = -0.55; p.tailSide = 1.0;
        }
        const splay = sleep && !cat ? 1.9 : 1.45;
        foot(2, fx(2) * splay, ph, (cat ? -0.2 : -0.12), Math.PI / 2 - 0.05, 0);
        foot(3, fx(3) * (sleep && !cat ? 0.9 : splay), ph, (cat ? -0.2 : -0.12) - (sleep && !cat ? 0.05 : 0), Math.PI / 2 - 0.05, 0);
        if (sleep && !cat) { p.roll = 0.22; p.headRoll = 0.25; p.headYaw = 0.35; p.neckYaw = 0.2; p.bend = 0.15; }
        p.headYaw += sleep ? 0 : wander(t * 0.3, this.seed) * 0.4;
        p.eyes = sleep ? 0 : 1;
        p.ears = sleep ? -0.35 : 0;
        p.tailWag = sleep ? 0 : 0.06; p.tailHz = 0.8;
        break;
      }
      case 'eat':
      case 'drink':
        p.hipsZ -= 0.02;
        p.pitch = -0.06;
        p.neck = -0.75; p.head = -0.85;
        foot(0, null, null, fz(0) + 0.05, undefined, 0); foot(1, null, null, fz(1) + 0.02, undefined, 0);
        p.jaw = Math.max(0, s(t * (activity === 'drink' ? 11 : 6.5))) * (activity === 'drink' ? 0.18 : 0.26);
        p.tongue = activity === 'drink' ? 0.6 : 0;
        p.tailWag = 0.2; p.tailHz = 2; p.ears = 0.1;
        break;
      case 'sniff':
        p.pitch = -0.05;
        p.neck = -0.6; p.head = -0.6 + s(t * 0.9) * 0.1;
        p.headYaw = s(t * 1.3) * 0.45; p.neckYaw = s(t * 1.3 - 0.4) * 0.25;
        p.ears = 0.35;
        p.tailUp = 0.5; p.tailWag = 0.18; p.tailHz = 2.5;
        p.hipsZ += s(t * 0.5) * 0.02;
        break;
      case 'play': {
        // Play bow, then a bounce now and then.
        const cycle = (t * 0.6) % 1;
        const hop = cycle > 0.7 ? s((cycle - 0.7) / 0.3 * Math.PI) : 0;
        p.hipsY = hips[1] / H + 0.02 + hop * 0.12;
        p.pitch = -0.38 * (1 - hop * 0.9);
        p.neck = 0.25; p.head = 0.05;
        const bowZ = cat ? 0.28 : 0.3;
        foot(0, fx(0) * 1.2, ph + hop * 0.15, fz(0) + bowZ, Math.PI / 2 - 0.2 - hop, 0); foot(1, fx(1) * 1.2, ph + hop * 0.15, fz(1) + bowZ, Math.PI / 2 - 0.2 - hop, 0);
        p.jaw = cat ? 0.05 : 0.3; p.tongue = cat ? 0 : 0.6;
        p.ears = 0.5;
        p.tailUp = cat ? 0.6 : 0.85; p.tailWag = cat ? 0.25 : 0.7; p.tailHz = cat ? 2 : 4.5;
        p.headRoll = s(t * 1.1) * 0.15;
        break;
      }
      case 'bark': {
        const b = Math.pow(Math.max(0, s(t * 7)), 2);
        p.neck = 0.18; p.head = 0.12 + b * 0.06;
        p.jaw = b * (cat ? 0.35 : 0.55);
        p.hipsY -= b * 0.012; p.pitch = b * 0.03;
        p.tailUp = 0.75; p.tailWag = 0.25; p.tailHz = 3;
        p.ears = 0.6;
        break;
      }
      case 'wag':
        p.tailUp = 0.65; p.tailWag = 0.8; p.tailHz = 4.5;
        p.bend = s(t * 9) * 0.06; p.roll = s(t * 9) * 0.03;
        p.neck = 0.12; p.head = 0.05;
        p.jaw = 0.2; p.tongue = cat ? 0 : 0.7;
        p.headRoll = s(t * 0.7) * 0.2;
        p.ears = 0.1; p.earsOut = 0.3;
        break;
      case 'groom':
        groom();
        break;
      case 'stalk': {
        // Belly low, shoulder blades up, eyes locked, hindquarters wiggling, tail tip twitching.
        const wiggle = s(t * 0.7) > 0.6 ? s(t * 14) : 0;
        p.hipsY = cat ? 0.5 : 0.55;
        p.pitch = -0.08;
        p.chest = -0.08;
        p.roll = wiggle * 0.04; p.bend = wiggle * 0.05;
        p.neck = -0.35; p.head = -0.05;
        foot(0, fx(0) * 1.05, ph, fz(0) + 0.06, 0.55, 0); foot(1, fx(1) * 1.05, ph, fz(1) + 0.06, 0.55, 0);
        foot(2, fx(2) * 1.12, ph, fz(2) + 0.06, 0.95, 0); foot(3, fx(3) * 1.12, ph, fz(3) + 0.06, 0.95, 0);
        p.tailUp = -0.15; p.tailCurl = 0.03; p.tailWag = 0.12; p.tailHz = 3.5;
        p.ears = 0.7;
        break;
      }
      case 'dig': {
        // Head down in the hole, forepaws flinging earth back between the hind legs, tail going.
        const c0 = s(t * 10), c1 = s(t * 10 + Math.PI);
        p.pitch = -0.14;
        p.hipsY = hips[1] / H + 0.02;
        p.neck = -0.75; p.head = -0.55 + s(t * 3) * 0.06;
        foot(0, fx(0) * 0.9, ph + Math.max(0, c0) * 0.1, fz(0) + 0.08 - c0 * 0.1, 0.35 + c0 * 0.55, 0.5);
        foot(1, fx(1) * 0.9, ph + Math.max(0, c1) * 0.1, fz(1) + 0.08 - c1 * 0.1, 0.35 + c1 * 0.55, 0.5);
        foot(2, fx(2) * 1.15, ph, fz(2) - 0.03, undefined, 0); foot(3, fx(3) * 1.15, ph, fz(3) - 0.03, undefined, 0);
        p.tailUp = 0.75; p.tailWag = 0.55; p.tailHz = 4.5;
        p.ears = 0.45;
        break;
      }
      case 'pounce': {
        // The spring: hindquarters bunched, forepaws thrown forward and down onto the quarry.
        p.hipsY = cat ? 0.6 : 0.64;
        p.pitch = -0.3;
        p.chest = -0.1;
        p.neck = -0.35; p.head = -0.35;
        foot(0, fx(0) * 0.9, ph, fz(0) + 0.24, 1.25, 0.2); foot(1, fx(1) * 0.9, ph, fz(1) + 0.22, 1.25, 0.2);
        foot(2, fx(2) * 1.1, ph, fz(2) + 0.02, 0.9, 0); foot(3, fx(3) * 1.1, ph, fz(3) + 0.02, 0.9, 0);
        p.tailUp = 0.25; p.tailCurl = 0.05; p.tailWag = 0.3; p.tailHz = 5;
        p.ears = 0.85; p.jaw = 0.22;
        break;
      }
      case 'shy':
        p.hipsY -= 0.16;
        p.pitch = -0.06;
        p.flex = 0.12;
        p.neck = -0.35; p.head = -0.25;
        foot(0, null, null, null, 0.35, 0); foot(1, null, null, null, 0.35, 0);
        foot(2, null, null, fz(2) + 0.08, 0.8, 0); foot(3, null, null, fz(3) + 0.08, 0.8, 0);
        p.tailUp = -1.1; p.tailCurl = -0.12; p.tailWag = 0.02;
        p.ears = -0.9; p.eyes = 0.8;
        break;
      default: {
        // Idle: weight shifts, breathing, looking about; personality shows in the carriage.
        const shift = wander(t * 0.25, this.seed + 3);
        p.hipsZ += shift * 0.01;
        p.roll = shift * 0.012;
        p.neck = (cat ? 0.02 : 0.06) + wander(t * 0.2, this.seed + 1) * 0.05;
        p.headYaw = wander(t * 0.3, this.seed) * 0.35;
        p.head = -0.06 + wander(t * 0.27, this.seed + 5) * 0.08;
        p.headRoll = wander(t * 0.19, this.seed + 7) * 0.08;
        if (!cat) { p.jaw = 0.12; p.tongue = 0.55; }
        if (has('friendly') || has('affectionate') || has('loyal')) {
          p.tailUp = cat ? 0.95 : 0.6; p.tailCurl = cat ? 0.16 : 0;
          p.tailWag = cat ? 0.08 : 0.45; p.tailHz = cat ? 0.7 : 3.2;
          p.headRoll += s(t * 0.7) * 0.08;
        }
        if (has('nervous')) {
          p.hipsY -= 0.08; p.neck -= 0.2; p.ears = -0.65; p.tailUp = -0.8; p.tailWag *= 0.2; p.tailCurl = -0.06;
        } else if (has('hunter') || has('protective') || has('curious')) {
          p.ears = 0.45; p.neck += 0.08; p.headYaw += s(t * 0.9) * 0.12;
        }
        if (has('aloof') || has('independent')) { p.headYaw += 0.35; p.tailWag = 0.04; }
        if (has('lazy')) { p.hipsY -= 0.04; p.neck -= 0.08; p.eyes = 0.6; }
        if (has('vocal')) {
          const meow = Math.max(0, s(t * 1.15) - 0.88) / 0.12;
          p.jaw = Math.max(p.jaw, meow * 0.32); p.head += meow * 0.15;
        }
        break;
      }
    }
    const hb = this.habit;
    if (hb) {
      const u = clamp((t - hb.at) / hb.len, 0, 1);
      const env = clamp(Math.min(u * 5, (1 - u) * 5), 0, 1);
      const side = hb.side;
      switch (hb.kind) {
        case 'scratch': {
          // Sat down, the head brought down and round to meet a hind foot raised behind the ear,
          // going like the clappers, eyes screwed up with the bliss of it.
          sitLike(0);
          const leg = side < 0 ? 2 : 3, kick = s(t * 26) * 0.035;
          foot(leg, fx(leg) * 1.6, SCRATCH_FOOT[0] + kick, SCRATCH_FOOT[1] + kick * 0.5, -0.6, 1.2);
          p.neck = SCRATCH_NECK; p.neckYaw = -side * SCRATCH_YAW * env; p.headYaw = -side * 0.3 * env;
          p.headRoll = -side * 0.45 * env;
          p.head = 0.1; p.eyes = 0.25; p.jaw = 0.12; p.tongue = 0.3;
          p.tailWag = 0.04;
          break;
        }
        case 'shake': {
          // Shaking off from the nose to the tail.
          const w = s(t * 24) * env;
          p.roll += w * 0.22; p.bend += s(t * 24 + 0.6) * env * 0.12;
          p.headRoll += s(t * 24 + 1.1) * env * 0.5; p.neckYaw += w * 0.2;
          p.earsOut = Math.max(p.earsOut, Math.abs(w) * 0.9); p.ears += w * 0.3;
          p.tailWag = 0.5 * env; p.tailHz = 4;
          p.eyes = 1 - env * 0.8;
          break;
        }
        case 'yawn': {
          // Head up, the jaw opening wide and slow, tongue curled, eyes screwed shut.
          const open = s(Math.PI * u) ** 1.5 * env;
          p.jaw = Math.max(p.jaw, open * (cat ? 0.75 : 0.85)); p.tongue = open * 0.7;
          p.head += open * 0.3; p.neck += open * 0.12;
          p.eyes = 1 - open; p.ears -= open * 0.5;
          break;
        }
        case 'stretch': {
          // The long bow: forelegs out in front, chest down, rump up, then a lean forward.
          const bow = env;
          p.pitch += (-0.42 - p.pitch) * bow;
          p.hipsY += (hips[1] / H + 0.03 - p.hipsY) * bow;
          const reach = cat ? 0.34 : 0.32;
          foot(0, fx(0) * 1.1, ph, fz(0) + reach * bow, Math.PI / 2 - 0.15 * bow, 0); foot(1, fx(1) * 1.1, ph, fz(1) + reach * bow, Math.PI / 2 - 0.15 * bow, 0);
          p.neck += 0.2 * bow; p.head += 0.12 * bow;
          p.tailUp = (cat ? 0.9 : 0.7) * bow + p.tailUp * (1 - bow);
          p.eyes = 1 - 0.6 * bow; p.jaw = Math.max(p.jaw, 0.35 * s(Math.PI * u) * bow);
          break;
        }
        case 'nose':
          // Nose down along the ground, following a scent.
          p.neck += (-0.6 - p.neck) * env; p.head += (-0.6 + s(t * 1.1) * 0.1 - p.head) * env;
          p.headYaw = s(t * 1.4) * 0.4 * env; p.neckYaw = s(t * 1.4 - 0.4) * 0.22 * env;
          p.ears += 0.3 * env; p.tailWag = Math.max(p.tailWag, 0.25 * env); p.tailHz = 2.5;
          p.jaw = 0; p.tongue = 0;
          break;
        case 'wash':
          if (activity === 'lie') {
            // Lying, washing a forepaw where it lies.
            p.neck += (-0.7 - p.neck) * env; p.head += (-0.3 + s(t * 7) * 0.05 - p.head) * env;
            p.headYaw = side * 0.3 * env; p.jaw = Math.max(0, s(t * 8)) * 0.15 * env; p.tongue = Math.max(0, s(t * 8)) * env;
            p.eyes = 1 - 0.6 * env;
          } else groom();
          break;
        case 'flick':
          // Tail tip twitching, one ear swivelled back.
          p.tailWag = 0.3 * env; p.tailHz = 3.5; p.tailCurl += 0.08 * env;
          p.ears += side * 0.4 * s(t * 9) * env; p.earsOut += 0.3 * env;
          break;
        case 'chin':
          // Chin down on the forepaws for a while, eyes half shut; the eyes still follow things.
          p.neck += (-1.45 - p.neck) * env; p.head += (0.02 - p.head) * env;
          p.headYaw *= 1 - env; p.eyes = 1 - 0.5 * env; p.ears -= 0.2 * env;
          p.gazeX = s(t * 0.6) * 0.5 * env;
          break;
        case 'twitch':
          p.ears += s(t * 30) * 0.5 * env; p.earsOut += Math.abs(s(t * 30)) * 0.3 * env;
          break;
        case 'dream': {
          // Running in its sleep: paws paddling, a muffled woof, the tail tip going.
          const r0 = s(t * 9) * 0.035 * env, r1 = s(t * 9 + Math.PI) * 0.035 * env;
          feet[2] += r0; feet[7] += r1; feet[12] += r1 * 0.6; feet[17] += r0 * 0.6;
          p.jaw = Math.max(0, s(t * 2.3) - 0.7) * 0.4 * env;
          p.tailWag = 0.12 * env; p.tailHz = 3;
          p.eyes = 0.08 * Math.max(0, s(t * 5)) * env;
          break;
        }
      }
    }
    return p;
  }

  /** Watch someone or something (a point in the world), or stop watching (null). */
  lookAt(p: THREE.Vector3 | null): void {
    if (!p) this.lookTarget = null;
    else (this.lookTarget ??= new THREE.Vector3()).copy(p);
  }

  /** Ease the head onto whatever is being watched (or off it), within what a neck can turn. */
  private track(dt: number): void {
    const on = this.canLook && !!this.lookTarget;
    if (on) {
      const head = this.rig.joints[BONE.head];
      const local = this.root.worldToLocal(this.lookTarget!.clone());
      const dx = local.x - head[0], dy = local.y - head[1], dz = local.z - head[2];
      const yaw = Math.atan2(dx, dz);
      // Behind it, it doesn't wrench its head round: it lets it go.
      const reachable = Math.abs(yaw) < LOOK_YAW + 0.5;
      if (reachable) {
        this.lookYaw += (clamp(yaw, -LOOK_YAW, LOOK_YAW) - this.lookYaw) * Math.min(1, dt * 6);
        this.lookPitch += (clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.45, 0.6) - this.lookPitch) * Math.min(1, dt * 6);
      }
      this.lookW += ((reachable ? 1 : 0) - this.lookW) * Math.min(1, dt * 3);
    } else this.lookW += (0 - this.lookW) * Math.min(1, dt * 3);
  }

  /** Carry something in the mouth (a mouse, a bird, a bone, a coin), or nothing. */
  hold(kind: string | null): void {
    if (kind === this.heldKind) return;
    this.heldKind = kind;
    for (const c of [...this.held.children]) {
      this.held.remove(c);
      c.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    const prop = kind ? petProp(kind) : null;
    if (!prop) return;
    // Prey hangs from the mouth by its middle, sideways; a bone is gripped across.
    if (kind === 'mouse' || kind === 'rat' || kind === 'sparrow') {
      prop.rotation.set(0, Math.PI / 2, Math.PI / 2);
      prop.position.y = -0.03;
    }
    this.held.add(prop);
  }

  animate(activity: AnimalActivity, moving: boolean, running: boolean, time: number, dt: number, distanceWalked = 0, traits: readonly string[] = []): void {
    dt = clamp(dt, 0, 0.1);
    this.clock += dt;
    const travelled = distanceWalked - this.lastDistance;
    this.lastDistance = distanceWalked;
    if (dt > 0) this.speed += (clamp(Math.abs(travelled) / dt, 0, 12) - this.speed) * Math.min(1, dt * 6);
    // Turning: read how the view rotated the model since the last frame.
    const yaw = this.root.rotation.y;
    if (this.lastYaw !== null && dt > 0) {
      let d = yaw - this.lastYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.turn += (clamp(d / dt, -4, 4) - this.turn) * Math.min(1, dt * 5);
    }
    this.yawStep = this.lastYaw !== null ? Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) : 0;
    this.lastYaw = yaw;
    // Lying down, a dog or cat sits first and slides its forelegs out; getting up it comes up
    // front first, by way of sitting.
    const low = !moving && (activity === 'lie' || activity === 'sleep');
    if (low !== this.low && !moving) this.viaSitUntil = this.clock + (low ? VIA_SIT_DOWN : VIA_SIT_UP);
    if (moving) this.viaSitUntil = 0;
    this.low = low;
    // Now and then a habit: a scratch, a shake, a yawn, a stretch; dreaming asleep.
    const set = moving || this.heldKind || this.clock < this.viaSitUntil ? null : activity === 'idle' ? 'stand' : activity === 'lie' ? 'lie' : activity === 'sleep' ? 'sleep' : null;
    const hb = this.habit;
    if (hb && (!set || time > hb.at + hb.len || time < hb.at || !PET_HABITS[set][this.cat ? 'cat' : 'dog'].some((h) => h[0] === hb.kind))) this.habit = null;
    if (!set) this.habitNext = Math.max(this.habitNext, this.clock + 3);
    else if (!this.habit && this.clock > this.habitNext) {
      // (Not the same one twice running, where there's a choice.)
      const all = PET_HABITS[set][this.cat ? 'cat' : 'dog'];
      const list = all.length > 1 ? all.filter((h) => h[0] !== this.lastHabit) : all;
      let r = Math.random() * list.reduce((a, h) => a + h[1], 0);
      const [kind, , lo, hi] = list.find((h) => (r -= h[1]) < 0) ?? list[0];
      const len = lo + Math.random() * (hi - lo);
      this.habit = { kind, at: time, len, side: Math.random() < 0.5 ? -1 : 1 };
      this.lastHabit = kind;
      this.habitNext = this.clock + len + (set === 'sleep' ? 12 : 6) + Math.random() * 14;
    }
    this.standing = STANDING.has(activity) && this.clock >= this.viaSitUntil && (!this.habit || STILL_HABITS.has(this.habit.kind));
    this.canLook = !moving && LOOKING.has(activity) && (!this.habit || this.habit.kind === 'flick' || this.habit.kind === 'twitch');
    this.track(dt);
    const target = this.pose(activity, time, moving, running, traits);
    // Mouth full: jaws gripping, no panting.
    if (this.heldKind) {
      target.jaw = 0.1;
      target.tongue = 0;
    }
    // Critically damped springs: quick enough to follow, never snapping.
    const half = moving ? 0.09 : 0.16;
    const omega = 2 / half;
    const spring = (cur: number, tgt: number, v: number): [number, number] => {
      const x = omega * dt, exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const change = cur - tgt;
      const temp = (v + omega * change) * dt;
      const nv = (v - omega * temp) * exp;
      return [tgt + (change + temp) * exp, nv];
    };
    const c = this.cur as unknown as Record<string, number>;
    const tg = target as unknown as Record<string, number>;
    for (const k of POSE_KEYS) [c[k], this.vel[k]] = spring(c[k], tg[k], this.vel[k]);
    for (let i = 0; i < 20; i++) [this.cur.feet[i], this.feetVel[i]] = spring(this.cur.feet[i], target.feet[i], this.feetVel[i]);
    const moveRate = Math.min(1, dt * (moving ? 8 : 5));
    this.moveW += ((moving ? 1 : 0) - this.moveW) * moveRate;
    this.runW += ((moving && running ? 1 : 0) - this.runW) * Math.min(1, dt * 4);
    this.apply(time, dt, moving, distanceWalked);
  }

  private apply(time: number, dt: number, moving: boolean, distance = 0): void {
    const rig = this.rig, H = rig.H, c = this.cur, cat = this.cat;
    const b = this.bones;
    const feet = c.feet.slice();
    let hipsY = c.hipsY, pitch = c.pitch, roll = c.roll, flex = c.flex, headAdj = 0, bob = 0;
    // Gait, layered over the pose by the movement weight.
    const mw = ease(this.moveW);
    if (mw > 0.001) {
      const run = this.runW;
      const S = (rig.stride.walk + (rig.stride.run - rig.stride.walk) * run) / H;
      const duty = cat ? 0.62 - run * 0.24 : 0.56 - run * 0.2;
      const phase0 = distance / (S * H);
      // Offsets: FL, FR, HL, HR. Dogs trot on diagonals; cats walk in a lateral sequence; both
      // shift to a rotary gallop at speed.
      const walkOff = cat ? [0.25, 0.75, 0.0, 0.5] : [0.0, 0.5, 0.52, 0.02];
      const runOff = [0.52, 0.62, 0.0, 0.1];
      const stand = this.standFeet();
      for (let l = 0; l < 4; l++) {
        const front = l < 2;
        const off = walkOff[l] + (runOff[l] - walkOff[l]) * run;
        const ph = ((phase0 + off) % 1 + 1) % 1;
        const o = l * 5;
        const exc = duty * S;
        let z: number, y: number, th: number, paw: number;
        const ph0 = stand[o + 1], th0 = stand[o + 3];
        if (ph < duty) {
          const u = ph / duty;
          z = stand[o + 2] + exc * (0.5 - u);
          y = ph0;
          th = th0 + (front ? (u - 0.5) * 0.25 : (u - 0.5) * 0.2);
          paw = smoothstep(0.75, 1, u) * 0.35;
        } else {
          const u = (ph - duty) / (1 - duty);
          const lift = Math.sin(Math.PI * u);
          z = stand[o + 2] + exc * (-0.5 + ease(u));
          y = ph0 + lift * (front ? 0.11 : 0.09) * (1 + run * 0.6);
          th = th0 - lift * (front ? 1.5 : 0.55) + (front ? 0.12 : 0.1);
          paw = lift * (front ? 1.25 : 0.7) + (1 - u) * 0.35 * (1 - u);
        }
        const x = stand[o] * (0.94 - run * 0.08);
        feet[o] += (x - feet[o]) * mw;
        feet[o + 1] += (y - feet[o + 1]) * mw;
        feet[o + 2] += (z - feet[o + 2]) * mw;
        feet[o + 3] += (th - feet[o + 3]) * mw;
        feet[o + 4] += (paw - feet[o + 4]) * mw;
      }
      const cyc = phase0 * Math.PI * 2;
      const walkBob = -Math.cos(cyc * 2) * (cat ? 0.006 : 0.012);
      const runBob = Math.sin(cyc) * 0.045;
      bob = (walkBob * (1 - run) + runBob * run) * mw;
      pitch += Math.sin(cyc + 0.6) * 0.09 * run * mw;
      flex += Math.sin(cyc) * 0.26 * run * mw;
      roll += Math.sin(cyc) * (cat ? 0.02 : 0.015) * (1 - run) * mw;
      headAdj = -Math.sin(cyc * 2) * 0.02 * (1 - run) * mw - Math.sin(cyc + 0.6) * 0.07 * run * mw;
    }
    // Coming to a halt on all fours, a paw stays where it was put down; one left off its mark then
    // steps there, lifted, one at a time, rather than sliding over the ground.
    const planting = !moving && this.standing;
    if (!planting || !this.plantedYet) {
      this.plantedYet = true;
      for (let l = 0; l < 4; l++) { this.planted[l * 2] = feet[l * 5]; this.planted[l * 2 + 1] = feet[l * 5 + 2]; }
      this.stepT.fill(-1);
    } else {
      const stand = this.standFeet();
      // Turning on the spot, the planted paws stay put on the ground while the body turns over
      // them, until they're far enough out of place to step round.
      const c0 = Math.cos(-this.yawStep), s0 = Math.sin(-this.yawStep);
      const turn = (p: number[], i: number) => { const x = p[i], z = p[i + 1]; p[i] = x * c0 + z * s0; p[i + 1] = -x * s0 + z * c0; };
      if (this.yawStep) for (let l = 0; l < 4; l++) { turn(this.planted, l * 2); turn(this.stepFrom, l * 2); }
      for (let l = 0; l < 4; l++) {
        if (this.stepT[l] < 0) continue;
        this.stepT[l] += dt / PAW_STEP;
        if (this.stepT[l] >= 1) {
          this.planted[l * 2] = this.stepTo[l * 2];
          this.planted[l * 2 + 1] = this.stepTo[l * 2 + 1];
          this.stepT[l] = -1;
        }
      }
      const down = (l: number) => feet[l * 5 + 1] < stand[l * 5 + 1] + 0.02;
      // Up to two paws step at once, never both fore or both hind (a diagonal, or one at a time).
      for (;;) {
        const busy = [0, 1, 2, 3].filter((l) => this.stepT[l] >= 0);
        if (busy.length >= 2) break;
        let pick = -1, worst = PAW_SLACK;
        for (let l = 0; l < 4; l++) {
          if (this.stepT[l] >= 0 || !down(l) || busy.some((o) => (o < 2) === (l < 2))) continue;
          const off = Math.hypot(feet[l * 5] - this.planted[l * 2], feet[l * 5 + 2] - this.planted[l * 2 + 1]);
          if (off > worst) { worst = off; pick = l; }
        }
        if (pick < 0) break;
        this.stepFrom[pick * 2] = this.planted[pick * 2]; this.stepFrom[pick * 2 + 1] = this.planted[pick * 2 + 1];
        this.stepTo[pick * 2] = feet[pick * 5]; this.stepTo[pick * 2 + 1] = feet[pick * 5 + 2];
        this.stepT[pick] = 0;
      }
      for (let l = 0; l < 4; l++) {
        const o = l * 5;
        if (!down(l)) { this.planted[l * 2] = feet[o]; this.planted[l * 2 + 1] = feet[o + 2]; this.stepT[l] = -1; continue; }
        if (this.stepT[l] >= 0) {
          const k = smoothstep(0, 1, this.stepT[l]), lift = Math.sin(Math.PI * k);
          feet[o] = this.stepFrom[l * 2] + (this.stepTo[l * 2] - this.stepFrom[l * 2]) * k;
          feet[o + 2] = this.stepFrom[l * 2 + 1] + (this.stepTo[l * 2 + 1] - this.stepFrom[l * 2 + 1]) * k;
          feet[o + 1] += lift * (l < 2 ? 0.09 : 0.07);
          feet[o + 3] -= lift * (l < 2 ? 1.2 : 0.5);
          feet[o + 4] += lift * (l < 2 ? 1 : 0.6);
        } else {
          feet[o] = this.planted[l * 2];
          feet[o + 2] = this.planted[l * 2 + 1];
        }
      }
    }
    hipsY += bob;
    // Breathing, faster after running and in play.
    this.breathe += dt * (1.3 + this.speed * 0.25 + (c.tongue > 0.3 ? 1.6 : 0));
    const breath = Math.sin(this.breathe * Math.PI * 2);
    b[BONE.ribs].scale.set(1 + breath * 0.018, 1 + breath * 0.022, 1);
    b[BONE.ribs].position.y = (rig.joints[BONE.ribs][1] - rig.joints[BONE.chest][1]) + breath * H * 0.002;

    // Torso.
    const turnBend = clamp(this.turn * 0.12, -0.25, 0.25) * (0.4 + this.moveW * 0.6);
    b[BONE.hips].position.set(0, hipsY * H, c.hipsZ * H);
    b[BONE.hips].rotation.set(-pitch, c.bend * 0.3 + turnBend * 0.2, roll, 'YXZ');
    b[BONE.spine].rotation.set(flex * 0.5, c.bend * 0.35 + turnBend * 0.4, 0);
    b[BONE.chest].rotation.set(flex * 0.5 - c.chest, c.bend * 0.35 + turnBend * 0.4, -roll * 0.4);
    const parentPitch = pitch - flex + c.chest;
    // Watching someone: the neck takes part of the turn, the head the rest, and the glances quieten.
    const lw = this.lookW, ly = this.lookYaw * lw, lp = this.lookPitch * lw;
    b[BONE.neck].rotation.set(-c.neck, c.neckYaw + turnBend * 0.6 + ly * 0.45, 0);
    const lookYaw = c.headYaw * (1 - lw * 0.7) + this.glance.yaw * (1 - mw * 0.7) * (1 - lw * 0.8) + turnBend + ly * 0.55;
    b[BONE.head].rotation.set(-(c.head + headAdj + this.glance.pitch * (1 - lw) + lp - parentPitch - c.neck), lookYaw - c.neckYaw * 0.5, c.headRoll, 'YXZ');
    this.jaw.rotation.x = c.jaw;
    this.tongue.position.z = rig.mouth.tongue[2] + c.tongue * c.jaw * rig.H * (cat ? 0.05 : 0.14);
    this.tongue.position.y = rig.mouth.tongue[1] - c.tongue * c.jaw * rig.H * 0.03;
    this.tongue.rotation.x = c.tongue * c.jaw * 0.8;

    // Legs: IK to the paw targets.
    this.root.updateMatrix();
    for (const bone of [b[BONE.hips], b[BONE.spine], b[BONE.chest]]) bone.updateMatrix();
    const hipsM = b[BONE.hips].matrix;
    const chestM = new THREE.Matrix4().multiplyMatrices(hipsM, b[BONE.spine].matrix).multiply(b[BONE.chest].matrix);
    for (let l = 0; l < 4; l++) this.solveLeg(l, l < 2 ? chestM : hipsM, feet.slice(l * 5, l * 5 + 5));
    // Keep the body on the ground: never through it, and resting on it when sitting or lying, whatever
    // the breed's proportions. Raising or lowering the hips leaves the planted paws where they are.
    const lowest = this.lowestProbe(hipsM, chestM);
    const rest = clamp(c.ground, 0, 1);
    const want = rest * -lowest + (1 - rest) * Math.max(0, -lowest);
    this.groundFix = dt > 0 ? this.groundFix + (want - this.groundFix) * Math.min(1, dt * 10) : want;
    const fix = Math.max(this.groundFix, -lowest);
    if (Math.abs(fix) > 1e-5) {
      b[BONE.hips].position.y += fix;
      b[BONE.hips].updateMatrix();
      chestM.multiplyMatrices(hipsM, b[BONE.spine].matrix).multiply(b[BONE.chest].matrix);
      for (let l = 0; l < 4; l++) this.solveLeg(l, l < 2 ? chestM : hipsM, feet.slice(l * 5, l * 5 + 5));
    }

    // Tail: base mood, curl, a travelling wag wave, gait sway, and lag on every segment.
    const wagPhase = time * c.tailHz * Math.PI * 2;
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const h = dt / steps;
    const shortTail = !cat && rig.tailLength < H * 0.2;
    const curled = !cat && !shortTail && rig.tailLength < H * 0.45;
    const up = c.tailUp;
    for (let i = 0; i < TAIL_BONES; i++) {
      const st = this.tailState[i];
      const f = i / (TAIL_BONES - 1);
      let tx: number;
      if (cat) {
        // A cat's tail: hanging in a soft J when relaxed, straight up with the tip hooked
        // forward when content, held low and level when wary.
        const upright = smoothstep(0.35, 1, up);
        if (i === 0) tx = up < 0.35 ? -1.05 + (up + 1) / 1.35 * 0.65 : -0.4 + upright * 2.25;
        else {
          const relaxed = [0, 0.1, 0.16, 0.24, 0.3, 0.32][i];
          const hook = [0, -0.12, -0.06, 0.12, 0.5, 0.62][i];
          tx = relaxed + (hook - relaxed) * upright + c.tailCurl * 0.5;
        }
      } else {
        if (shortTail || curled) {
          tx = i === 0 ? up * (shortTail ? 0.6 : 0.95) : c.tailCurl + -0.04 * (1 - Math.max(0, up));
          if (curled && i > 0) tx += 0.32; // curled tails over the back
        } else {
          // A long tail is never a rod: relaxed, it leaves the croup about level and droops in a
          // soft sabre curve with the tip lifting; raised, it sweeps up in an arc.
          const raise = smoothstep(0.2, 0.9, up);
          // The rest shape (petAnatomy.tailChain) already hangs 0.1 rad more each segment, so each
          // lift here must outdo that for the tail to curve: a whip hanging from the root, its
          // last third sweeping up.
          if (i === 0) tx = Math.max(-1.25, Math.min(1.1, -1.25 + up * 2.3));
          else {
            const droop = [0, 0.06, 0.14, 0.24, 0.32, 0.36][Math.min(i, 5)];
            const arc = [0, 0.16, 0.2, 0.24, 0.26, 0.28][Math.min(i, 5)];
            tx = droop * (1 - raise) + arc * raise + c.tailCurl;
          }
        }
      }
      let ty = Math.sin(wagPhase - i * 0.55) * c.tailWag * (0.35 + f * 0.6);
      ty += c.tailSide * (i === 0 ? 0.25 : 0.2) * (i < 4 ? 1 : 0.6);
      ty += Math.sin(distance / (this.rig.stride.walk) * Math.PI * 2) * 0.06 * this.moveW;
      if (cat) ty += Math.sin(time * 1.7 + i * 0.9) * 0.05 * f;
      // Second-order lag (stiffer at the root), sub-stepped so long frames stay stable.
      const k = 140 - f * 90, d = 2 * Math.sqrt(k) * 0.65;
      for (let n = 0; n < steps; n++) {
        st.vel += ((tx - st.ang) * k - st.vel * d) * h;
        st.ang += st.vel * h;
        st.sideVel += ((ty - st.side) * k - st.sideVel * d) * h;
        st.side += st.sideVel * h;
      }
      if (dt === 0) { st.ang = tx; st.side = ty; }
      b[BONE.tail + i].rotation.set(st.ang, st.side, 0);
    }
    // The tail lies on the ground rather than through it: lift any segment whose end would sink.
    {
      const m = new THREE.Matrix4().copy(b[BONE.hips].matrix);
      const end = new THREE.Vector3();
      const floor = H * (cat ? 0.035 : 0.045);
      for (let i = 0; i < TAIL_BONES; i++) {
        const bone = b[BONE.tail + i];
        const next = i < TAIL_BONES - 1 ? b[BONE.tail + i + 1].position : bone.position.clone().multiplyScalar(i === 0 ? 1 : 1);
        for (let tries = 0; tries < 3; tries++) {
          bone.updateMatrix();
          const mm = new THREE.Matrix4().multiplyMatrices(m, bone.matrix);
          end.copy(next).applyMatrix4(mm);
          if (end.y >= floor) break;
          const len = next.length() || 1;
          bone.rotation.x += Math.asin(clamp((floor - end.y) / len, 0, 1)) + 0.01;
        }
        bone.updateMatrix();
        m.multiply(bone.matrix);
      }
    }

    // Ears: mood target with springy lag; floppy ears bounce with the gait.
    const floppy = rig.ear.shape === 'floppy';
    for (const e of this.ears) {
      const flick = Math.max(0, Math.sin(this.clock * 0.9 + e.side * 2.1 + this.seed) - 0.97) * 18;
      const target = floppy ? -c.ears * 0.25 : -c.ears * 0.5 + flick * 0.25;
      const outT = floppy ? c.earsOut * 0.3 + Math.max(0, -c.ears) * 0.1 : -Math.max(0, -c.ears) * 0.7 + c.earsOut * 0.2;
      const kick = floppy ? -bob * 60 : 0;
      const k = floppy ? 70 : 220, d = 2 * Math.sqrt(k) * (floppy ? 0.35 : 0.7);
      for (let n = 0; n < steps; n++) {
        e.vel += ((target - e.ang) * k - e.vel * d + kick) * h;
        e.ang += e.vel * h;
        e.velOut += ((outT - e.out) * k - e.velOut * d + kick * 0.6) * h;
        e.out += e.velOut * h;
      }
      if (dt === 0) { e.ang = target; e.out = outT; }
      e.pivot.rotation.set(e.ang, 0, -e.side * e.out);
    }

    // Eyes: glances, blinks, sleepy lids.
    if (this.clock > this.glanceAt) {
      const r = (n: number) => (Math.sin(this.clock * 12.9898 + n * 78.233 + this.seed) * 43758.5453) % 1;
      this.glanceAt = this.clock + 1.2 + Math.abs(r(1)) * 3;
      this.glance.yaw = r(2) * 0.25;
      this.glance.pitch = r(3) * 0.08;
    }
    for (const ball of this.eyeballs) ball.rotation.set(-c.gazeY - this.glance.pitch * 0.6, c.gazeX + this.glance.yaw * 0.8, 0);
    this.blinkAt -= dt;
    if (this.blinkAt < 0 && this.blinkT < 0) this.blinkT = 0;
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      blink = Math.sin(clamp(this.blinkT / 0.16, 0, 1) * Math.PI);
      if (this.blinkT > 0.16) { this.blinkT = -1; this.blinkAt = 2 + ((this.seed * 7.3 + this.clock * 3.1) % 4); }
    }
    const open = clamp(c.eyes * (1 - blink), 0, 1);
    for (const lid of this.lids) {
      // A cat's relaxed eye is an almond under a lowered upper lid; a dog's is round and open.
      const up = cat ? 0.68 : 0.95, low = cat ? 0.72 : 0.85;
      lid.upper.rotation.x = -up * open + (1 - open) * 0.12;
      lid.lower.rotation.x = low * open - (1 - open) * 0.1;
    }
  }

  /** Height (root space) of the lowest ground probe in the current pose. */
  private lowestProbe(hipsM: THREE.Matrix4, chestM: THREE.Matrix4): number {
    const b = this.bones, m = new Map<number, THREE.Matrix4>();
    m.set(BONE.hips, hipsM);
    m.set(BONE.spine, new THREE.Matrix4().multiplyMatrices(hipsM, b[BONE.spine].matrix));
    m.set(BONE.chest, chestM);
    b[BONE.ribs].updateMatrix();
    m.set(BONE.ribs, new THREE.Matrix4().multiplyMatrices(chestM, b[BONE.ribs].matrix));
    for (let l = 0; l < 4; l++) {
      const up = b[legBone(l, 0)], mid = b[legBone(l, 1)];
      up.updateMatrix(); mid.updateMatrix();
      const um = new THREE.Matrix4().multiplyMatrices(l < 2 ? chestM : hipsM, up.matrix);
      m.set(legBone(l, 0), um);
      m.set(legBone(l, 1), new THREE.Matrix4().multiplyMatrices(um, mid.matrix));
    }
    let lowest = Infinity;
    const v = new THREE.Vector3();
    for (const probe of this.probes) {
      const e = m.get(probe.bone)!.elements, p = probe.p;
      v.set(p.x, p.y, p.z);
      lowest = Math.min(lowest, e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]);
    }
    return lowest === Infinity ? 0 : lowest;
  }

  private solveLeg(l: number, parentM: THREE.Matrix4, f: number[]): void {
    const rig = this.rig, H = rig.H, leg = rig.legs[l];
    const upper = this.bones[legBone(l, 0)], mid = this.bones[legBone(l, 1)], low = this.bones[legBone(l, 2)], paw = this.bones[legBone(l, 3)];
    const j0 = upper.position.clone().applyMatrix4(parentM);
    const target = new THREE.Vector3(f[0] * H, f[1] * H, f[2] * H);
    const [L1, L2, L3] = leg.lengths;
    const theta = f[3];
    const ankle = target.clone().add(new THREE.Vector3(0, Math.cos(theta) * L3, -Math.sin(theta) * L3));
    // Two-bone IK from the shoulder/hip to the wrist/hock.
    const toAnkle = ankle.clone().sub(j0);
    let d = toAnkle.length();
    const dir = toAnkle.clone().divideScalar(d || 1);
    d = clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);
    const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const parentQ = new THREE.Quaternion().setFromRotationMatrix(parentM);
    // Elbows point back; stifles point forward. The hint follows the body's pitch.
    const pole = new THREE.Vector3(0, leg.front ? -0.25 : 0.1, leg.front ? -1 : 1).applyQuaternion(parentQ);
    const perp = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const j1 = j0.clone().add(dir.clone().multiplyScalar(Math.cos(a) * L1)).add(perp.multiplyScalar(Math.sin(a) * L1));
    const j2 = j0.clone().add(dir.multiplyScalar(d));
    // When the target is out of reach, keep the lower segment hanging from the reached point.
    const pawPos = j2.clone().add(target.clone().sub(ankle));
    const rest = leg.joints;
    const restDir = (i: number) => new THREE.Vector3(rest[i + 1][0] - rest[i][0], rest[i + 1][1] - rest[i][1], rest[i + 1][2] - rest[i][2]).normalize();
    const r1 = new THREE.Quaternion().setFromUnitVectors(restDir(0), j1.clone().sub(j0).normalize());
    const r2 = new THREE.Quaternion().setFromUnitVectors(restDir(1), j2.clone().sub(j1).normalize());
    const r3 = new THREE.Quaternion().setFromUnitVectors(restDir(2), pawPos.clone().sub(j2).normalize());
    const r4 = this.restQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), f[4]).clone();
    upper.quaternion.copy(parentQ.clone().invert().multiply(r1));
    mid.quaternion.copy(r1.clone().invert().multiply(r2));
    low.quaternion.copy(r2.clone().invert().multiply(r3));
    paw.quaternion.copy(r3.clone().invert().multiply(r4));
  }
}

/**
 * Skin on the midline between a pair of legs (the groin, the brisket between the elbows) belongs to
 * the body: weighted to both legs it would tear as they swing apart. Leg influence fades out
 * smoothly towards the midline above the elbow/stifle, handing its weight to the chest or hips.
 */
function groundMidline(pos: Float32Array, index: Uint16Array, weight: Float32Array, rig: PetRig): void {
  const H = rig.H;
  for (let v = 0; v < index.length / 4; v++) {
    const x = Math.abs(pos[v * 3]), y = pos[v * 3 + 1];
    const merged = new Map<number, number>();
    const put = (bone: number, w: number) => merged.set(bone, (merged.get(bone) ?? 0) + w);
    let changed = false;
    for (let k = 0; k < 4; k++) {
      const b = index[v * 4 + k];
      let w = weight[v * 4 + k];
      if (w <= 0) continue;
      if (b < LEG_BASE || b >= LEG_BASE + 16) { put(b, w); continue; }
      const leg = Math.floor((b - LEG_BASE) / 4), seg = (b - LEG_BASE) % 4, j = rig.legs[leg].joints;
      // A lower bone never pulls skin above the joint it hangs from (the shin does not drag the
      // flank, the forearm does not drag the brisket): that skin goes to the bone above.
      const lx = Math.abs(j[0][0]);
      const midline = 1 - (1 - smoothstep(0.1 * lx, 0.85 * lx, x)) * smoothstep(j[1][1] - 0.14 * H, j[1][1] + 0.02 * H, y);
      for (let s2 = seg; s2 >= 0 && w > 0; s2--) {
        const keep = (s2 >= 1 ? smoothstep(j[s2][1] + 0.07 * H, j[s2][1] - 0.01 * H, y) : 1) * midline;
        if (keep < 1) changed = true;
        put(legBone(leg, s2), w * keep);
        w *= 1 - keep;
        if (s2 === 0 || midline < 1) {
          // Whatever the leg cannot hold goes to the body it hangs from.
          put(leg < 2 ? BONE.chest : BONE.hips, w);
          w = 0;
        }
      }
    }
    if (!changed) continue;
    const list = [...merged.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
    let total = 0;
    for (const [, w] of list) total += w;
    for (let k = 0; k < 4; k++) { index[v * 4 + k] = list[k]?.[0] ?? 0; weight[v * 4 + k] = list[k] ? list[k][1] / total : 0; }
  }
}

/** Where the tail ends in the rest pose (one segment past the last tail joint). */
function tailTip(rig: PetRig): V3 {
  const a = rig.joints[BONE.tail + TAIL_BONES - 2], b = rig.joints[BONE.tail + TAIL_BONES - 1];
  return [b[0] * 2 - a[0], b[1] * 2 - a[1], b[2] * 2 - a[2]];
}

/**
 * Re-spread the skin weights of a bone chain (the tail) along its length with overlapping tent
 * functions, so it bends in a smooth arc instead of creasing at every joint. Influence from bones
 * outside the chain (the hips at the tail root) is kept as it is.
 */
function smoothChainWeights(pos: Float32Array, index: Uint16Array, weight: Float32Array, _rig: PetRig, first: number, count: number, joints: V3[]): void {
  const segLen: number[] = [];
  for (let i = 0; i < count; i++) segLen.push(Math.hypot(joints[i + 1][0] - joints[i][0], joints[i + 1][1] - joints[i][1], joints[i + 1][2] - joints[i][2]));
  const n = pos.length / 3;
  for (let v = 0; v < n; v++) {
    let chainW = 0;
    for (let k = 0; k < 4; k++) { const b = index[v * 4 + k]; if (b >= first && b < first + count) chainW += weight[v * 4 + k]; }
    if (chainW <= 1e-4) continue;
    // Closest point on the chain polyline, as a joint coordinate u (0 … count).
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let best = Infinity, u = 0;
    for (let i = 0; i < count; i++) {
      const a = joints[i], b = joints[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / (segLen[i] * segLen[i] || 1), 0, 1);
      const d = (x - a[0] - dx * t) ** 2 + (y - a[1] - dy * t) ** 2 + (z - a[2] - dz * t) ** 2;
      if (d < best) { best = d; u = i + t; }
    }
    const c = clamp(u - 0.5, 0, count - 1);
    const i0 = Math.min(count - 2, Math.floor(c)), f = c - i0;
    const others: [number, number][] = [];
    for (let k = 0; k < 4; k++) { const b = index[v * 4 + k], w = weight[v * 4 + k]; if (w > 0 && !(b >= first && b < first + count)) others.push([b, w]); }
    others.sort((p, q) => q[1] - p[1]);
    const list: [number, number][] = [[first + i0, chainW * (1 - f)], [first + i0 + 1, chainW * f], ...others.slice(0, 2)];
    let total = 0;
    for (const [, w] of list) total += w;
    for (let k = 0; k < 4; k++) {
      index[v * 4 + k] = list[k]?.[0] ?? 0;
      weight[v * 4 + k] = list[k] ? list[k][1] / total : 0;
    }
  }
}

/** Smooth 3D value noise in 0…1 (deterministic). */
function valueNoise(x: number, y: number, z: number): number {
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = ease(x - xi), v = ease(y - yi), w = ease(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v), w);
}

/** Merge simple non-indexed/indexed geometries that share attributes (position, normal, uv). */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let offset = 0;
  for (const g of list) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + offset);
    else for (let i = 0; i < p.count; i++) idx.push(i + offset);
    offset += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

/**
 * An ear as a closed, cupped leaf: thick at the base, thin at the rim, with the inner face as a
 * second material group. Leaf space: grows along +Y, width along X, inner face toward +Z.
 */
function earGeometry(shape: string, length: number, width: number, H: number, fluff: number): THREE.BufferGeometry {
  const NU = 12, NV = 10;
  const pos: number[] = [], nor: number[] = [];
  const outer: number[] = [], inner: number[] = [];
  const thick = H * (shape === 'cat' ? 0.017 : 0.019) * (1 + fluff * 0.5);
  const cup = shape === 'cat' ? 1.05 : shape === 'pricked' ? 0.85 : shape === 'folded' ? 0.3 : 0.16;
  const bendAt = (u: number) => {
    if (shape === 'floppy') return 2.84 * smoothstep(0.0, 0.26, u) + 0.12 * u;
    if (shape === 'folded') return 2.3 * smoothstep(0.32, 0.55, u);
    return -0.15 * u;
  };
  const widthAt = (u: number) => {
    if (shape === 'floppy') return width * 0.5 * (0.72 + 0.4 * Math.sin(Math.min(1, u * 1.1) * Math.PI * 0.85)) * Math.sqrt(Math.max(0, 1 - Math.pow(u, 5)));
    if (shape === 'folded') return width * 0.5 * Math.pow(1 - u, 0.75) * (1 + 0.15 * Math.sin(u * Math.PI));
    // Triangular with a softly rounded tip.
    return width * 0.5 * Math.pow(1 - u, 0.92) * (1 + 0.18 * Math.sin(u * Math.PI)) * Math.min(1, (1 - u) * 6 + 0.25);
  };
  // Integrate the bent centreline.
  const centre: THREE.Vector3[] = [], normal: THREE.Vector3[] = [];
  let p = new THREE.Vector3(0, -length * 0.08, 0);
  for (let i = 0; i <= NU; i++) {
    const u = i / NU;
    const ang = bendAt(u);
    const dirV = new THREE.Vector3(0, Math.cos(ang), Math.sin(ang));
    const nV = new THREE.Vector3(0, -Math.sin(ang), Math.cos(ang));
    centre.push(p.clone()); normal.push(nV);
    p = p.clone().add(dirV.multiplyScalar(length / NU));
  }
  const row = NV + 1;
  for (const face of [1, -1]) {
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      const w = widthAt(u);
      for (let j = 0; j <= NV; j++) {
        const v = j / NV * 2 - 1;
        const t = thick * Math.sqrt(Math.max(0, 1 - v * v)) * (1 - u * 0.65) + (u >= 1 ? 0 : 0);
        const q = centre[i].clone()
          .add(new THREE.Vector3(v * w, 0, 0))
          .add(normal[i].clone().multiplyScalar(cup * w * v * v + face * t));
        pos.push(q.x, q.y, q.z);
        nor.push(0, 0, 0);
      }
    }
  }
  const base = (face: number) => (face === 1 ? 0 : (NU + 1) * row);
  for (const face of [1, -1]) {
    const o = base(face);
    for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
      const a = o + i * row + j, b2 = a + 1, c2 = a + row, d = c2 + 1;
      const tri = face === 1 ? [a, b2, d, a, d, c2] : [a, d, b2, a, c2, d];
      const v = (j + 0.5) / NV * 2 - 1;
      const u = (i + 0.5) / NU;
      const isInner = face === 1 && Math.abs(v) < 0.72 && u > 0.04 && u < 0.86;
      (isInner ? inner : outer).push(...tri);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex([...outer, ...inner]);
  geo.addGroup(0, outer.length, 0);
  geo.addGroup(outer.length, inner.length, 1);
  geo.computeVertexNormals();
  return geo;
}

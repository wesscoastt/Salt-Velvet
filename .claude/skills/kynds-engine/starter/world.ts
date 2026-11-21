/**
 * A starter Kynds game, headless: one room with a hearth and two stools, people who wander,
 * claim a seat and sit by the fire, all on the Kynds Engine. Grow it into your game: add needs and
 * autonomy (see the life-sim-core skill), objects to a Registry, and a three.js view on top.
 *
 *   node --test starter/world.test.ts
 */
import { findPath, NavGrid, pack, placeSlots, Registry, Reservations, Rng, SimTiers, unpack, type PlacedSlot, type SlotSpec, type Vec2 } from '../src/index.ts';

type Posture = 'stand' | 'sit';

export interface ObjectDef {
  id: string;
  name: string;
  width: number;
  depth: number;
  blocking: boolean;
  slots: SlotSpec<Posture>[];
}

export interface WorldObject {
  id: string;
  defId: string;
  x: number;
  z: number;
  /** Quarter turns. */
  rot: number;
}

export interface Person {
  id: string;
  name: string;
  pos: Vec2;
  path: Vec2[];
  /** The slot they're heading for or sitting in. */
  slot: string | null;
  posture: Posture;
}

/** Content by id: a game registers its objects once, at load. */
export const OBJECTS = new Registry<ObjectDef>('object def');
OBJECTS.registerAll(
  [
    { id: 'hearth', name: 'Hearth', width: 1.6, depth: 0.8, blocking: true, slots: [] },
    { id: 'stool', name: 'Stool', width: 0.5, depth: 0.5, blocking: false, slots: [{ name: 'seat', use: { x: 0, z: 0 }, facing: 0, posture: 'sit' }] },
  ],
  (d) => d.id,
);

const WALK = 1.4; // metres a second

export class World {
  readonly nav = new NavGrid(8, 6, 0.25);
  readonly objects = new Map<string, WorldObject>();
  readonly people = new Map<string, Person>();
  readonly claims = new Reservations();
  /** Who's simulated in full (in the room) or only roughly (gone out). */
  readonly tiers = new SimTiers<'full' | 'away'>();
  time = 0;
  private rng: Rng;

  constructor(seed = 1) {
    this.rng = new Rng(seed);
    this.place('hearth-1', 'hearth', 4, 0.6, 0);
    this.place('stool-1', 'stool', 3, 2, 2);
    this.place('stool-2', 'stool', 5, 2, 2);
  }

  place(id: string, defId: string, x: number, z: number, rot: number): void {
    OBJECTS.require(defId);
    this.objects.set(id, { id, defId, x, z, rot });
    this.rebuildNav();
  }

  private rebuildNav(): void {
    this.nav.clear();
    for (const o of this.objects.values()) {
      const d = OBJECTS.require(o.defId);
      if (d.blocking) this.nav.blockBox({ x: o.x, z: o.z, hw: d.width / 2, hd: d.depth / 2, rot: o.rot });
    }
  }

  slots(): PlacedSlot<Posture>[] {
    return [...this.objects.values()].flatMap((o) => placeSlots(o.id, o, OBJECTS.require(o.defId).slots, 'stand'));
  }

  addPerson(id: string, name: string, at: Vec2): Person {
    const p: Person = { id, name, pos: { ...at }, path: [], slot: null, posture: 'stand' };
    this.people.set(id, p);
    return p;
  }

  /** Head for a free seat by the fire (true if one was found and reachable). */
  sitByTheFire(p: Person): boolean {
    const free = [...this.slots()];
    // (In a random order, from the world's own seeded random numbers: runs repeat exactly.)
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    for (const s of free) {
      if (s.posture !== 'sit' || !this.claims.isFree(s.key, p.id)) continue;
      const path = findPath(this.nav, p.pos, s.approaches[0], { exactGoal: true });
      if (!path || !this.claims.reserve(s.key, p.id)) continue;
      this.claims.releaseAll(p.id, s.key);
      p.path = path;
      p.slot = s.key;
      return true;
    }
    return false;
  }

  /** Advance the world by `dt` seconds. */
  step(dt: number): void {
    this.time += dt;
    for (const p of this.people.values()) {
      this.tiers.assign(p.id, 'full');
      let budget = WALK * dt;
      while (budget > 0 && p.path.length) {
        const t = p.path[0];
        const d = Math.hypot(t.x - p.pos.x, t.z - p.pos.z);
        if (d <= budget) {
          p.pos = { ...t };
          p.path.shift();
          budget -= d;
        } else {
          p.pos = { x: p.pos.x + ((t.x - p.pos.x) * budget) / d, z: p.pos.z + ((t.z - p.pos.z) * budget) / d };
          budget = 0;
        }
      }
      if (!p.path.length && p.slot) p.posture = 'sit';
    }
  }

  /** A save, packed small enough for Web Storage. */
  save(): string {
    return pack(JSON.stringify({ time: this.time, people: [...this.people.values()] }));
  }

  load(saved: string): void {
    const data = JSON.parse(unpack(saved) ?? '{}') as { time: number; people: Person[] };
    this.time = data.time;
    this.people.clear();
    this.claims.clear();
    for (const p of data.people) {
      this.people.set(p.id, p);
      if (p.slot) this.claims.reserve(p.slot, p.id);
    }
  }
}

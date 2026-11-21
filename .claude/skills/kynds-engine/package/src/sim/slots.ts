import { quarterToAngle, rotateLocal, type Vec2 } from '../core/math.ts';

/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M7): the places on an object where someone uses it (the seat
 * of a chair, each side of a bed, the front of a stove), and who has claimed which. Plain data: a
 * game describes its slots in the object's own frame, and this places them in the world and keeps
 * the claims.
 */

/** A slot as authored, in the object's own frame. */
export interface SlotSpec<P extends string = string> {
  name: string;
  /** Where the user stands, sits or lies. */
  use: Vec2;
  /** Their facing in the slot (radians, 0 = the object's local +Z). */
  facing: number;
  /** Walkable points to route to first (omit when `use` is walkable floor). */
  approaches?: Vec2[];
  posture?: P;
  tags?: string[];
}

/** Where an object stands: its centre and its turn in quarter turns (fractions allowed). */
export interface Placement {
  x: number;
  z: number;
  rot: number;
}

/** A slot placed in the world. */
export interface PlacedSlot<P extends string = string> {
  objectId: string;
  index: number;
  /** `objectId:index`: what claims are made on. */
  key: string;
  use: Vec2;
  facing: number;
  posture: P;
  /** Walkable points to route to; `[use]` for a standing slot. */
  approaches: Vec2[];
  tags: string[];
}

/** A point in an object's frame, in the world. */
export function toWorld(at: Placement, local: Vec2): Vec2 {
  const r = rotateLocal(local, at.rot);
  return { x: at.x + r.x, z: at.z + r.z };
}

export function slotKey(objectId: string, index: number): string {
  return `${objectId}:${index}`;
}

/** Split a slot key back into its object and index (null if it isn't one). */
export function parseSlotKey(key: string): { objectId: string; index: number } | null {
  const i = key.lastIndexOf(':');
  if (i < 0) return null;
  const index = Number(key.slice(i + 1));
  return Number.isInteger(index) ? { objectId: key.slice(0, i), index } : null;
}

/** An object's slots placed in the world. */
export function placeSlots<P extends string>(objectId: string, at: Placement, specs: readonly SlotSpec<P>[], defaultPosture: P): PlacedSlot<P>[] {
  return specs.map((s, index) => {
    const use = toWorld(at, s.use);
    return {
      objectId,
      index,
      key: slotKey(objectId, index),
      use,
      facing: s.facing + quarterToAngle(at.rot),
      posture: s.posture ?? defaultPosture,
      approaches: s.approaches ? s.approaches.map((a) => toWorld(at, a)) : [use],
      tags: s.tags ?? [],
    };
  });
}

/** Who has claimed which slot: one claimant a slot, any number of slots a claimant. */
export class Reservations {
  private held = new Map<string, string>();

  reservedBy(key: string): string | undefined {
    return this.held.get(key);
  }

  isFree(key: string, who: string): boolean {
    const owner = this.held.get(key);
    return owner === undefined || owner === who;
  }

  /** Claim a slot; false if someone else holds it. */
  reserve(key: string, who: string): boolean {
    if (!this.isFree(key, who)) return false;
    this.held.set(key, who);
    return true;
  }

  release(key: string, who: string): void {
    if (this.held.get(key) === who) this.held.delete(key);
  }

  /** Everything `who` holds, but `except`. */
  releaseAll(who: string, except?: string): void {
    for (const [key, owner] of this.held) if (owner === who && key !== except) this.held.delete(key);
  }

  /** Every claim on an object's slots (it's gone). */
  releaseObject(objectId: string): void {
    for (const key of [...this.held.keys()]) if (parseSlotKey(key)?.objectId === objectId) this.held.delete(key);
  }

  clear(): void {
    this.held.clear();
  }

  get size(): number {
    return this.held.size;
  }
}

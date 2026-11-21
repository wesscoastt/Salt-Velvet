/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M4): simulation tiers. Not everyone in a world is simulated
 * the same way: those where play happens are simulated step by step, those elsewhere in broad
 * strokes, those on the road only until they arrive. The game names its tiers and says which each
 * agent is in, every tick; this keeps the books, so a promotion (arriving where play happens) or a
 * demotion (leaving it) is one event a game can hook, and the numbers in each tier can be watched.
 *
 * Headless and game-agnostic.
 */

export type TierChange<T extends string> = (id: string, from: T | null, to: T) => void;

export class SimTiers<T extends string> {
  private tiers = new Map<string, T>();
  private listeners: TierChange<T>[] = [];

  /** Call when an agent's tier changes (and once when it is first seen). */
  onChange(f: TierChange<T>): void {
    this.listeners.push(f);
  }

  /** Put an agent in a tier for this tick; returns the tier, for dispatch. */
  assign(id: string, tier: T): T {
    const was = this.tiers.get(id) ?? null;
    if (was !== tier) {
      this.tiers.set(id, tier);
      for (const f of this.listeners) f(id, was, tier);
    }
    return tier;
  }

  tierOf(id: string): T | null {
    return this.tiers.get(id) ?? null;
  }

  /** The agent has left the world. */
  forget(id: string): void {
    this.tiers.delete(id);
  }

  /** How many agents are in each tier now. */
  counts(): Partial<Record<T, number>> {
    const out: Partial<Record<T, number>> = {};
    for (const t of this.tiers.values()) out[t] = (out[t] ?? 0) + 1;
    return out;
  }
}

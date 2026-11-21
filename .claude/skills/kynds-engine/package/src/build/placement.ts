import { normalizeRot } from '../core/math.ts';

/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M7): build tools' placement modes. How finely a piece snaps,
 * how far one turn key turns it, and whether pieces may overlap (free decorating). Rotations are in
 * quarter turns (0…4), as objects store them. A game adds its own labels and hints.
 */
export interface PlacementMode {
  id: string;
  /** Grid step for the centre (metres). */
  snap: number;
  /** One turn, in quarter turns (0.5 = 45°). */
  turn: number;
  /** Pieces may overlap (decorating), as long as everything can still be reached. */
  overlap: boolean;
}

/** The modes a life-sim build tool offers, coarse to free. */
export const PLACEMENT_MODES = {
  grid: { id: 'grid', snap: 0.5, turn: 0.5, overlap: false },
  half: { id: 'half', snap: 0.25, turn: 0.5, overlap: false },
  fine: { id: 'fine', snap: 0.125, turn: 0.5, overlap: false },
  free: { id: 'free', snap: 0.02, turn: 1 / 18, overlap: true },
} as const satisfies Record<string, PlacementMode>;

/** A coordinate on the mode's grid. */
export function snapTo(v: number, mode: PlacementMode): number {
  return Math.round(v / mode.snap) * mode.snap;
}

/** One turn left (−1) or right (+1). */
export function turn(rot: number, dir: number, mode: PlacementMode): number {
  return normalizeRot(rot + dir * mode.turn);
}

/** Into a mode: a piece turned freely settles onto that mode's steps. */
export function settle(rot: number, mode: PlacementMode): number {
  return normalizeRot(Math.round(rot / mode.turn) * mode.turn);
}

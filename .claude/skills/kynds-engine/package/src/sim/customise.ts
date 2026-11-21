/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M7): the customisation data model. A thing can be re-coloured
 * in named channels (wood, cloth, metal; a shirt's body and trim), each choosing from an
 * append-only palette. A choice is kept as an index into its palette, so a palette may grow but
 * never be reordered or shortened, or saved things would change colour.
 */

/** One choice in a palette. */
export interface Swatch {
  id: string;
  name: string;
  /** Main colour (and what a picker shows). */
  color: string;
  /** A darker companion tone (end grain, frames, shadowed folds). */
  dark: string;
}

/** What a kind of thing offers: the channels it can be re-coloured in, with its default in each. */
export type Offer<C extends string> = Partial<Record<C, number>>;

export class Customisation<C extends string, S extends Swatch = Swatch> {
  readonly channels: readonly C[];
  readonly palettes: Record<C, readonly S[]>;
  readonly labels: Record<C, string>;
  /** Defaults for things that don't offer a choice in a channel. */
  readonly defaults: Record<C, number>;

  constructor(spec: { channels: readonly C[]; palettes: Record<C, readonly S[]>; labels: Record<C, string>; defaults: Record<C, number> }) {
    this.channels = spec.channels;
    this.palettes = spec.palettes;
    this.labels = spec.labels;
    this.defaults = spec.defaults;
    for (const c of this.channels) {
      const ids = new Set(this.palettes[c].map((s) => s.id));
      if (ids.size !== this.palettes[c].length) throw new Error(`customisation: '${c}' has a swatch id twice`);
      if (!(this.defaults[c] >= 0 && this.defaults[c] < this.palettes[c].length)) throw new Error(`customisation: '${c}' default out of range`);
    }
  }

  /** The channels a thing can be re-coloured in, in display order. */
  channelsOf(offer: Offer<C> | undefined): C[] {
    return this.channels.filter((c) => offer?.[c] !== undefined);
  }

  /** Whether `v` is a choice in channel `c`. */
  valid(c: C, v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < this.palettes[c].length;
  }

  /** The swatch index a thing shows in a channel: its choice, else what it offers by default, else the channel's. */
  index(chosen: unknown, offer: Offer<C> | undefined, c: C): number {
    const list = this.palettes[c];
    if (typeof chosen === 'number' && offer?.[c] !== undefined && chosen >= 0 && chosen < list.length) return Math.floor(chosen);
    return offer?.[c] ?? this.defaults[c];
  }

  /** Keep only valid choices, in channels the thing offers (from a save, a share code, a mod). */
  sanitize(offer: Offer<C> | undefined, look: Partial<Record<C, unknown>> | undefined): Partial<Record<C, number>> {
    const out: Partial<Record<C, number>> = {};
    if (!look) return out;
    for (const c of this.channelsOf(offer)) {
      const v = look[c];
      if (this.valid(c, v)) out[c] = v;
    }
    return out;
  }
}

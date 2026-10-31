import type { Rng } from '../../core/Rng.ts';
import type { AnimalGenome, AnimalSex } from './Animal.ts';

/**
 * Dogs of the period, not modern breed standards: broad types with natural variation. Used for
 * strays, presets in the Companion Creator, and as the starting point for inheritance.
 */
export interface DogType {
  id: string;
  label: string;
  base: Omit<AnimalGenome, 'coat' | 'secondary' | 'eye'>;
  coats: [string, string][];
}

export const DOG_TYPES: DogType[] = [
  {
    id: 'hound',
    label: 'Hound',
    base: { size: 0.6, build: 0.3, pattern: 'saddle', coatLength: 0.15, ears: 'floppy', tail: 'long', muzzle: 0.8 },
    coats: [['#c9a06a', '#3a2a1c'], ['#e8dcc4', '#8a5a34'], ['#b07a45', '#2a1c14']],
  },
  {
    id: 'mastiff',
    label: 'Mastiff',
    base: { size: 0.95, build: 0.95, pattern: 'masked', coatLength: 0.1, ears: 'folded', tail: 'long', muzzle: 0.3 },
    coats: [['#b08a5a', '#2a1c14'], ['#8a6a4a', '#1f1a17'], ['#6b5a4a', '#1f1a17']],
  },
  {
    id: 'shepherd',
    label: 'Shepherd Dog',
    base: { size: 0.7, build: 0.55, pattern: 'patched', coatLength: 0.75, ears: 'pricked', tail: 'plumed', muzzle: 0.6 },
    coats: [['#2a221c', '#e8e2d4'], ['#8a6a4a', '#e8e2d4'], ['#5a5048', '#d9cdb4']],
  },
  {
    id: 'terrier',
    label: 'Terrier',
    base: { size: 0.3, build: 0.5, pattern: 'saddle', coatLength: 0.6, ears: 'folded', tail: 'short', muzzle: 0.5 },
    coats: [['#b8864a', '#2a221c'], ['#d9cdb4', '#8a5a34'], ['#6b5a4a', '#b08a5a']],
  },
  {
    id: 'lapdog',
    label: 'Lap Dog',
    base: { size: 0.15, build: 0.4, pattern: 'patched', coatLength: 0.9, ears: 'floppy', tail: 'curled', muzzle: 0.25 },
    coats: [['#f0e8d8', '#b8864a'], ['#e8dcc4', '#2a221c']],
  },
  {
    id: 'sighthound',
    label: 'Greyhound',
    base: { size: 0.72, build: 0.08, pattern: 'solid', coatLength: 0.05, ears: 'folded', tail: 'long', muzzle: 1 },
    coats: [['#5a5048', '#3a332e'], ['#c9b08a', '#8a6a4a'], ['#e8e0d0', '#b8a888'], ['#2a221c', '#1a1512']],
  },
  {
    id: 'wolfhound',
    label: 'Wolfhound',
    // Lean, deep-chested and long in the leg, in a rough, wiry grey or wheaten coat.
    base: { size: 1, build: 0.32, pattern: 'solid', coatLength: 0.4, ears: 'folded', tail: 'long', muzzle: 0.82 },
    coats: [['#7a746c', '#4a443e'], ['#a8987a', '#7a6a4e'], ['#5a5048', '#3a332e']],
  },
  {
    id: 'spaniel',
    label: 'Spaniel',
    base: { size: 0.38, build: 0.45, pattern: 'patched', coatLength: 0.66, ears: 'floppy', tail: 'plumed', muzzle: 0.45 },
    coats: [['#f0e8d8', '#8a3a1e'], ['#f0e8d8', '#2a221c'], ['#6b3a1e', '#e8dcc4']],
  },
  {
    id: 'sheepdog',
    label: 'Shaggy Sheepdog',
    base: { size: 0.68, build: 0.62, pattern: 'patched', coatLength: 0.98, ears: 'floppy', tail: 'short', muzzle: 0.42 },
    coats: [['#8a8a88', '#f0ece4'], ['#5a5a5c', '#ece8e0']],
  },
  {
    id: 'bloodhound',
    label: 'Scenthound',
    base: { size: 0.74, build: 0.62, pattern: 'saddle', coatLength: 0.1, ears: 'floppy', tail: 'long', muzzle: 0.92 },
    coats: [['#a8552b', '#2a1c14'], ['#8a4a2a', '#1f1a17'], ['#b8864a', '#6b3a1e']],
  },
  {
    id: 'guardian',
    label: 'Flock Guardian',
    base: { size: 0.85, build: 0.8, pattern: 'solid', coatLength: 0.8, ears: 'floppy', tail: 'plumed', muzzle: 0.5 },
    coats: [['#ece4d2', '#d9cdb4'], ['#d9c9a8', '#b8a888']],
  },
];

const EYES = ['#3a2a1e', '#5a3a1e', '#6b4a2a', '#2a221c'];

/** A dog of a random type, with its own variation. */
export function dogGenome(rng: Rng, typeId?: string): AnimalGenome {
  const t = DOG_TYPES.find((d) => d.id === typeId) ?? rng.pick(DOG_TYPES);
  const [coat, secondary] = rng.pick(t.coats);
  const j = (v: number, s = 0.12) => Math.max(0, Math.min(1, v + rng.range(-s, s)));
  return {
    ...t.base,
    size: j(t.base.size),
    build: j(t.base.build),
    coatLength: j(t.base.coatLength, 0.1),
    muzzle: j(t.base.muzzle, 0.1),
    coat,
    secondary,
    eye: rng.pick(EYES),
    type: t.id,
  };
}

const MALE = ['Bran', 'Wolfram', 'Tuck', 'Rufus', 'Hodge', 'Bramble', 'Grim', 'Hector', 'Moss', 'Barley', 'Cob', 'Rook'];
const FEMALE = ['Bess', 'Nell', 'Fern', 'Tansy', 'Holly', 'Juno', 'Maddy', 'Poppet', 'Willow', 'Ember', 'Clover', 'Sorrel'];

export function dogName(rng: Rng, sex: AnimalSex, avoid: Iterable<string> = []): string {
  const taken = new Set(avoid);
  const pool = (sex === 'male' ? MALE : FEMALE).filter((n) => !taken.has(n));
  return rng.pick(pool.length ? pool : sex === 'male' ? MALE : FEMALE);
}

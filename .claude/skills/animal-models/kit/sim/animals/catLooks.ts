import type { Rng } from '../../core/Rng.ts';
import type { AnimalGenome, AnimalSex } from './Animal.ts';

/**
 * Cats of the period vary by coat, build, markings, colour and face rather than by breed. Colours
 * are drawn as a main and a secondary tone; the pattern decides how they're laid out (tabby
 * stripes are "ticked", a tuxedo is "saddle" worn upside down by the renderer, calico "patched",
 * a darker face and paws "masked").
 */
export interface CatCoat {
  id: string;
  label: string;
  coat: string;
  secondary: string;
  pattern: AnimalGenome['pattern'];
}

export const CAT_COATS: CatCoat[] = [
  { id: 'brown_tabby', label: 'Brown Tabby', coat: '#8a6a4a', secondary: '#3a2a1c', pattern: 'ticked' },
  { id: 'grey_tabby', label: 'Grey Tabby', coat: '#8a8a88', secondary: '#3d3a36', pattern: 'ticked' },
  { id: 'ginger', label: 'Ginger', coat: '#d0823a', secondary: '#a8552b', pattern: 'ticked' },
  { id: 'black', label: 'Black', coat: '#1f1c1a', secondary: '#2e2a26', pattern: 'solid' },
  { id: 'white', label: 'White', coat: '#efe9dc', secondary: '#d9d2c4', pattern: 'solid' },
  { id: 'tuxedo', label: 'Black & White', coat: '#1f1c1a', secondary: '#efe9dc', pattern: 'saddle' },
  { id: 'calico', label: 'Calico', coat: '#efe9dc', secondary: '#c8742e', pattern: 'patched' },
  { id: 'smoke', label: 'Blue-Grey', coat: '#6f7478', secondary: '#55595e', pattern: 'solid' },
  { id: 'cream_point', label: 'Cream Point', coat: '#e8dcc4', secondary: '#6b4a2e', pattern: 'masked' },
];

const EYES = ['#b8a040', '#7a9a3a', '#c8862a', '#6a8aa8', '#a8b848'];

export function catGenome(rng: Rng, coatId?: string): AnimalGenome {
  const c = CAT_COATS.find((x) => x.id === coatId) ?? rng.pick(CAT_COATS);
  return {
    size: rng.range(0.25, 0.75),
    build: rng.range(0.2, 0.8),
    coat: c.coat,
    secondary: c.secondary,
    pattern: c.pattern,
    coatLength: rng.next() < 0.2 ? rng.range(0.6, 0.95) : rng.range(0.05, 0.35),
    ears: 'pricked',
    tail: rng.next() < 0.1 ? 'short' : 'long',
    muzzle: rng.range(0.1, 0.35),
    eye: rng.pick(EYES),
    type: c.id,
  };
}

const MALE = ['Tom', 'Grimalkin', 'Sooty', 'Ash', 'Pepper', 'Mouser', 'Jasper', 'Nutmeg', 'Thistle', 'Crumb'];
const FEMALE = ['Tibby', 'Mog', 'Whisker', 'Ember', 'Sage', 'Minnow', 'Dusk', 'Primrose', 'Treacle', 'Wren'];

export function catName(rng: Rng, sex: AnimalSex, avoid: Iterable<string> = []): string {
  const taken = new Set(avoid);
  const pool = (sex === 'male' ? MALE : FEMALE).filter((n) => !taken.has(n));
  return rng.pick(pool.length ? pool : sex === 'male' ? MALE : FEMALE);
}

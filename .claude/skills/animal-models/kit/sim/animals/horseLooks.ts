import type { Rng } from '../../core/Rng.ts';
import type { AnimalGenome, AnimalSex } from './Animal.ts';
import type { AnimalStage } from './Species.ts';

/*
 * Horses of the period by type (rouncey, palfrey, cob, courser, destrier), not modern breeds, and
 * coats from a small, plausible colour genetics so foals take after their parents the way real
 * foals do. Plain data; runs in Node.
 *
 * Six loci, two alleles each, written as a genotype string "Ee Aa nn Gn nn nn":
 *   Extension  E/e  black pigment allowed (ee: chestnut)
 *   Agouti     A/a  restricts black to the points (bay) — only shows on E_
 *   Cream      C/n  one copy dilutes red (palomino, buckskin); two make a cremello
 *   Grey       G/n  dominant, progressive: born dark, dapple grey as an adult, near white when old
 *   Leopard    L/n  appaloosa spotting (LL: a near-white leopard with spots all over)
 *   White      W/n  dominant white
 */

export interface HorseCoat {
  id: string;
  label: string;
  /** Body colour. */
  coat: string;
  /** Points: lower legs, ear rims, muzzle shading. */
  secondary: string;
  mane: string;
  pattern: AnimalGenome['pattern'];
}

export const HORSE_COATS: HorseCoat[] = [
  { id: 'bay', label: 'Bay', coat: '#7b4325', secondary: '#1d1714', mane: '#1a1512', pattern: 'solid' },
  { id: 'chestnut', label: 'Chestnut', coat: '#9c4e22', secondary: '#8a441f', mane: '#a95c2c', pattern: 'solid' },
  { id: 'black', label: 'Black', coat: '#221d1b', secondary: '#1a1614', mane: '#151110', pattern: 'solid' },
  { id: 'palomino', label: 'Palomino', coat: '#d6a754', secondary: '#c99a4b', mane: '#f1e7cf', pattern: 'solid' },
  { id: 'buckskin', label: 'Buckskin', coat: '#c8975a', secondary: '#1f1915', mane: '#1c1714', pattern: 'solid' },
  { id: 'cremello', label: 'Cremello', coat: '#eadcc0', secondary: '#e2d3b6', mane: '#f3ecdc', pattern: 'solid' },
  { id: 'dapple_grey', label: 'Dapple Grey', coat: '#8f8d89', secondary: '#4a4846', mane: '#6f6c68', pattern: 'dappled' },
  { id: 'grey', label: 'Grey', coat: '#cfccc5', secondary: '#9a9792', mane: '#dad7d0', pattern: 'solid' },
  { id: 'appaloosa', label: 'Appaloosa', coat: '#7b4325', secondary: '#efebe2', mane: '#2a211c', pattern: 'spotted' },
  { id: 'white', label: 'White', coat: '#eeece6', secondary: '#e8e5de', mane: '#efece6', pattern: 'solid' },
];

export function horseCoat(id: string): HorseCoat {
  return HORSE_COATS.find((c) => c.id === id) ?? HORSE_COATS[0];
}

const LOCI = ['E', 'A', 'C', 'G', 'L', 'W'] as const;
type Locus = (typeof LOCI)[number];
const DOMINANT: Record<Locus, string> = { E: 'E', A: 'A', C: 'C', G: 'G', L: 'L', W: 'W' };
const RECESSIVE: Record<Locus, string> = { E: 'e', A: 'a', C: 'n', G: 'n', L: 'n', W: 'n' };
/** How common each dominant allele is in the kingdom's horses. */
const FREQ: Record<Locus, number> = { E: 0.55, A: 0.5, C: 0.08, G: 0.12, L: 0.05, W: 0.02 };

function pairs(genes: string): string[] {
  const p = genes.trim().split(/\s+/);
  return LOCI.map((l, i) => (p[i] && p[i].length === 2 ? p[i] : RECESSIVE[l] + RECESSIVE[l]));
}

/** How many copies of the dominant allele at a locus (0, 1 or 2). */
export function doses(genes: string, locus: Locus): number {
  const pair = pairs(genes)[LOCI.indexOf(locus)];
  return [...pair].filter((c) => c === DOMINANT[locus]).length;
}

function pair(locus: Locus, a: boolean, b: boolean): string {
  const s = (d: boolean) => (d ? DOMINANT[locus] : RECESSIVE[locus]);
  // Dominant first, as horsemen write it ("Ee", "Gn").
  return a || !b ? s(a) + s(b) : s(b) + s(a);
}

export function randomGenes(rng: Rng): string {
  return LOCI.map((l) => pair(l, rng.next() < FREQ[l], rng.next() < FREQ[l])).join(' ');
}

/** A foal's genotype: one allele from each parent at every locus. */
export function inheritGenes(rng: Rng, mother: string, father: string): string {
  const m = pairs(mother);
  const f = pairs(father);
  return LOCI.map((l, i) => {
    const a = m[i][rng.next() < 0.5 ? 0 : 1] === DOMINANT[l];
    const b = f[i][rng.next() < 0.5 ? 0 : 1] === DOMINANT[l];
    return pair(l, a, b);
  }).join(' ');
}

/** The coat a genotype shows at a given age (greys are born dark and whiten with the years). */
export function coatIdFor(genes: string, stage: AnimalStage = 'adult'): string {
  if (doses(genes, 'W') > 0) return 'white';
  const grey = doses(genes, 'G');
  if (grey > 0 && stage === 'elder') return 'grey';
  if (grey > 0 && stage === 'adult') return grey === 2 ? 'grey' : 'dapple_grey';
  if (doses(genes, 'L') > 0) return 'appaloosa';
  return baseCoatId(genes);
}

/** The colour under any grey, white or spotting. */
export function baseCoatId(genes: string): string {
  const cream = doses(genes, 'C');
  if (cream === 2) return 'cremello';
  const red = doses(genes, 'E') === 0;
  if (red) return cream ? 'palomino' : 'chestnut';
  const bay = doses(genes, 'A') > 0;
  if (bay) return cream ? 'buckskin' : 'bay';
  return 'black';
}

/** Set the visible coat fields from the genotype (and age). Called at creation and on growing up/old. */
export function applyHorseCoat(g: AnimalGenome, stage: AnimalStage): void {
  if (!g.genes) return;
  const id = coatIdFor(g.genes, stage);
  const c = horseCoat(id);
  const base = horseCoat(baseCoatId(g.genes));
  g.coat = id === 'appaloosa' ? base.coat : c.coat;
  g.secondary = c.secondary;
  g.mane = id === 'appaloosa' ? base.mane : c.mane;
  g.pattern = c.pattern;
}

export interface HorseType {
  id: string;
  label: string;
  blurb: string;
  base: { size: number; build: number; coatLength: number; muzzle: number };
  /** Market price in coin (before the kingdom's prices). */
  price: number;
  coats: string[];
}

export const HORSE_TYPES: HorseType[] = [
  { id: 'rouncey', label: 'Rouncey', blurb: 'A sturdy all-purpose riding horse.', base: { size: 0.45, build: 0.55, coatLength: 0.45, muzzle: 0.5 }, price: 300, coats: ['bay', 'chestnut', 'black', 'dapple_grey', 'bay', 'chestnut'] },
  { id: 'palfrey', label: 'Palfrey', blurb: 'A smooth-gaited, elegant riding horse.', base: { size: 0.4, build: 0.35, coatLength: 0.55, muzzle: 0.45 }, price: 450, coats: ['grey', 'dapple_grey', 'palomino', 'bay', 'black', 'appaloosa', 'white'] },
  { id: 'cob', label: 'Cob', blurb: 'A stocky, sure-footed packhorse.', base: { size: 0.25, build: 0.9, coatLength: 0.7, muzzle: 0.35 }, price: 220, coats: ['bay', 'chestnut', 'black', 'buckskin', 'grey'] },
  { id: 'courser', label: 'Courser', blurb: 'A light, swift hunting horse.', base: { size: 0.7, build: 0.3, coatLength: 0.4, muzzle: 0.6 }, price: 600, coats: ['bay', 'chestnut', 'black'] },
  { id: 'destrier', label: 'Destrier', blurb: 'A great, powerful war horse.', base: { size: 0.95, build: 0.9, coatLength: 0.55, muzzle: 0.55 }, price: 1500, coats: ['black', 'grey', 'bay', 'dapple_grey'] },
];

export function horseType(id: string | undefined): HorseType | undefined {
  return HORSE_TYPES.find((t) => t.id === id);
}

const EYES = ['#2a1d14', '#3a2718', '#22180f'];
const FACES: AnimalGenome['face'][] = ['none', 'none', 'none', 'star', 'star', 'snip', 'stripe', 'blaze', 'blaze'];

function randomSocks(rng: Rng): string {
  // Hind legs are white more often than front legs.
  return [0.25, 0.25, 0.38, 0.38].map((p) => (rng.next() < p ? (rng.next() < 0.4 ? 2 : 1) : 0)).join('');
}

/** Genes that show the wanted coat, sampled from the kingdom's horses (deterministic per seed). */
export function genesForCoat(rng: Rng, coatId: string): string {
  let genes = randomGenes(rng);
  for (let i = 0; i < 3000 && coatIdFor(genes) !== coatId; i++) genes = randomGenes(rng);
  return genes;
}

/** A horse of a type (random if not given), with its own variation. */
export function horseGenome(rng: Rng, typeId?: string, coatId?: string, stage: AnimalStage = 'adult'): AnimalGenome {
  const t = horseType(typeId) ?? rng.pick(HORSE_TYPES.slice(0, 3));
  const genes = genesForCoat(rng, coatId ?? rng.pick(t.coats));
  const j = (v: number, s = 0.1) => Math.max(0, Math.min(1, v + rng.range(-s, s)));
  const g: AnimalGenome = {
    size: j(t.base.size),
    build: j(t.base.build),
    coat: '',
    secondary: '',
    pattern: 'solid',
    coatLength: j(t.base.coatLength, 0.15),
    ears: 'pricked',
    tail: 'long',
    muzzle: j(t.base.muzzle),
    eye: rng.pick(EYES),
    type: t.id,
    genes,
    mane: '',
    face: rng.pick(FACES),
    socks: randomSocks(rng),
  };
  applyHorseCoat(g, stage);
  return g;
}

const FACE_ORDER: NonNullable<AnimalGenome['face']>[] = ['none', 'star', 'snip', 'stripe', 'blaze'];

/** White markings are polygenic: a foal's face and legs take after a parent, give or take. */
export function inheritMarkings(rng: Rng, mother: AnimalGenome, father: AnimalGenome): { face: AnimalGenome['face']; socks: string } {
  const from = rng.next() < 0.5 ? mother : father;
  let fi = FACE_ORDER.indexOf(from.face ?? 'none');
  if (rng.next() < 0.3) fi = Math.max(0, Math.min(FACE_ORDER.length - 1, fi + (rng.next() < 0.5 ? -1 : 1)));
  const ms = mother.socks ?? '0000';
  const fs = father.socks ?? '0000';
  const socks = [0, 1, 2, 3]
    .map((i) => {
      let v = Number((rng.next() < 0.5 ? ms : fs)[i] ?? 0);
      if (rng.next() < 0.25) v += rng.next() < 0.5 ? -1 : 1;
      return Math.max(0, Math.min(2, v));
    })
    .join('');
  return { face: FACE_ORDER[fi], socks };
}

/** "Bay rouncey", "Dapple grey palfrey". */
export function horseDescription(g: AnimalGenome, stage: AnimalStage = 'adult'): string {
  const coat = g.genes ? horseCoat(coatIdFor(g.genes, stage)).label : 'Horse';
  const type = horseType(g.type)?.label.toLowerCase() ?? 'horse';
  return `${coat} ${stage === 'young' ? 'foal' : type}`;
}

const MALE = ['Bayard', 'Morel', 'Lyard', 'Favel', 'Brunel', 'Ferrant', 'Galopin', 'Tancred', 'Valiant', 'Hobb', 'Corbin', 'Sorrel'];
const FEMALE = ['Bellefleur', 'Grisel', 'Rosamund', 'Mirabel', 'Fauvelle', 'Clemence', 'Amabel', 'Columbine', 'Ysolde', 'Sable', 'Hazel', 'Primrose'];

export function horseName(rng: Rng, sex: AnimalSex, avoid: Iterable<string> = []): string {
  const taken = new Set(avoid);
  const pool = (sex === 'male' ? MALE : FEMALE).filter((n) => !taken.has(n));
  return rng.pick(pool.length ? pool : sex === 'male' ? MALE : FEMALE);
}

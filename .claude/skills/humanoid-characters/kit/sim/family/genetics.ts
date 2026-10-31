import { Rng } from '../../core/Rng.ts';
import type { HairStyle, KyndAppearance, Sex } from '../entities/Kynd.ts';
import { CLOTH_COLOURS, DETAIL_FIELDS, EYE_COLOURS, FACE_FIELDS, normalizeAppearance, type BeardStyle, type Headwear, type OutfitStyle } from '../entities/appearance.ts';

/*
 * How children come to look like their parents, and the names Hearthwick gives them. Plain data
 * and colour arithmetic: no three.js here, the simulation must run in Node.
 *
 * The world's random stream drives everything that existed before outfits and faces (skin, hair,
 * build, clothes' colours). The newer details — eye colour, face shape, freckles, outfit and
 * headwear — come from a second generator seeded from the world's state without advancing it, so
 * adding them left every other random roll in the simulation exactly where it was.
 */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mixColor(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Grey the hair with age (0 = as it was, 1 = white). */
export function greyed(hair: string, amount: number): string {
  return mixColor(hair, '#cfcac2', amount);
}

const TUNICS = ['#3f6e5a', '#8c3b3b', '#3f5f8c', '#6b4a2e', '#5a6b3a', '#6a3a7a', '#8a6a2a', '#4a4f5a', '#7a4a3a', '#2f5a5a'];
const TRIMS = ['#c9a44c', '#e6d3a3', '#3a2a1c', '#8a2a2a', '#d9b25a', '#e8e2c8'];
const LEGS = ['#5b4636', '#6b5a48', '#3d3a36', '#4a3f33', '#5a4a3a', '#2f2a26'];
const SKINS = ['#f0c7a4', '#e8b996', '#c98e68', '#b07550', '#8a5a3c', '#e0a882', '#9a6a4a', '#c48a64'];
const HAIRS = ['#1f1a17', '#4a2c1a', '#a8552b', '#d8b25a', '#8a6a3a', '#2a1a14', '#5a5048', '#6b3a1e'];

// One draw from the world's stream picks the hairstyle, as it always has; the lists are longer now.
const MALE_HAIR: readonly HairStyle[] = ['short', 'cropped', 'short', 'curly', 'shoulder', 'cropped', 'wavy', 'short', 'ponytail'];
const FEMALE_HAIR: readonly HairStyle[] = ['long', 'braid', 'wavy', 'twin_braids', 'bun', 'long', 'braid', 'curly', 'shoulder', 'bob', 'ponytail', 'half_up'];

function hairFor(sex: Sex, rng: Rng): HairStyle {
  return sex === 'male' ? rng.pick(MALE_HAIR) : rng.pick(FEMALE_HAIR);
}

/** A second generator seeded from the world's current state; reading the state doesn't advance it. */
function sideRng(rng: Rng, salt: number): Rng {
  return new Rng((Math.imul(rng.state ^ 0x9e3779b9, 0x85ebca6b) + salt * 0x27d4eb2f) >>> 0);
}

/** Linen, undyed wool and the cheaper dyes: what ordinary folk wear for aprons, hoods and linings. */
const PLAIN = ['#e8e0cc', '#d9c9a0', '#b8a888', '#8a7a5a', '#6b4a2e', '#4a3a2a', '#5a6b3a', '#3f5f8c', '#7a4a3a'];
const RICH = ['#7a1f2a', '#1f3f6a', '#5a2a6a', '#2a5a3a', '#6a2436', '#2f5a5a', '#c9a44c'];

/** Class tier from what a parent wears (gowns and surcoats are gentry and above). */
function tierFromLook(a: KyndAppearance | null): number {
  switch (a?.outfit) {
    case 'gown':
    case 'surcoat':
      return 7;
    case 'doublet':
    case 'cotehardie':
      return 3;
    case 'robe':
      return 2;
    default:
      return 1;
  }
}

function outfitFor(r: Rng, sex: Sex, tier: number): OutfitStyle {
  if (tier >= 6) return sex === 'male' ? r.pick(['surcoat', 'surcoat', 'doublet'] as const) : r.pick(['gown', 'gown', 'cotehardie'] as const);
  if (tier >= 3) return sex === 'male' ? r.pick(['doublet', 'tunic', 'robe'] as const) : r.pick(['cotehardie', 'kirtle'] as const);
  if (tier <= 0) return sex === 'male' ? r.pick(['smock', 'tunic'] as const) : r.pick(['apron_dress', 'kirtle'] as const);
  return sex === 'male' ? r.pick(['tunic', 'tunic', 'smock', 'doublet'] as const) : r.pick(['kirtle', 'apron_dress', 'kirtle', 'cotehardie'] as const);
}

function headwearFor(r: Rng, sex: Sex, tier: number, grown: boolean): Headwear {
  if (!grown) return r.next() < 0.15 ? (sex === 'male' ? 'felt_cap' : 'coif') : 'none';
  const roll = r.next();
  if (tier >= 6) return roll < 0.35 ? (sex === 'male' ? 'felt_cap' : 'circlet') : roll < 0.5 && sex === 'female' ? 'veil' : 'none';
  if (sex === 'male') return roll < 0.14 ? 'hood' : roll < 0.24 ? 'felt_cap' : roll < 0.32 ? 'straw_hat' : roll < 0.38 ? 'coif' : 'none';
  return roll < 0.16 ? 'coif' : roll < 0.28 ? 'veil' : roll < 0.34 ? 'wimple' : roll < 0.4 ? 'straw_hat' : 'none';
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Related proportions with soft tails, rather than nine unrelated extreme sliders. */
function naturalFace(r: Rng): Record<(typeof FACE_FIELDS)[number], number> {
  const centered = () => (r.next() + r.next() + r.next()) / 3;
  // Choose a coherent outline before adding small individual differences.
  const outline = r.pick([
    [0.48, 0.53, 0.45], // oval
    [0.68, 0.32, 0.35], // round
    [0.34, 0.72, 0.55], // long
    [0.61, 0.56, 0.67], // angular
    [0.41, 0.43, 0.68], // tapered
  ] as const);
  const width = outline[0] + (centered() - 0.5) * 0.22;
  const length = outline[1] + (centered() - 0.5) * 0.22;
  const feature = () => 0.18 + centered() * 0.64;
  return {
    faceWidth: width, faceLength: length, cheekbones: outline[2] + (centered() - 0.5) * 0.3,
    eyeSpacing: clamp01(0.5 + (width - 0.5) * 0.42 + (centered() - 0.5) * 0.36),
    eyeSize: 0.28 + centered() * 0.38,
    eyeShape: 0.3 + centered() * 0.4,
    mouthWidth: clamp01(0.5 + (width - 0.5) * 0.46 + (centered() - 0.5) * 0.4),
    lipFullness: feature(), browShape: feature(),
  };
}

/** A newborn's looks, drawn from both parents (or at random for a foundling). */
export function inheritAppearance(rng: Rng, sex: Sex, a: KyndAppearance | null, b: KyndAppearance | null): KyndAppearance {
  const p = a ?? b;
  const q = b ?? a;
  const skin = p && q ? mixColor(p.skin, q.skin, rng.range(0.25, 0.75)) : rng.pick(SKINS);
  const hair = p && q ? mixColor(rng.next() < 0.5 ? p.hair : q.hair, rng.next() < 0.5 ? p.hair : q.hair, rng.range(0, 0.4)) : rng.pick(HAIRS);
  const height = p && q ? (p.height + q.height) / 2 + rng.range(-0.04, 0.04) : rng.range(0.94, 1.06);
  const build = p && q ? (p.build + q.build) / 2 + rng.range(-0.15, 0.15) : rng.range(0.2, 0.8);
  const hairStyle = hairFor(sex, rng);
  const tunic = rng.pick(TUNICS);
  const trim = rng.pick(TRIMS);
  const legs = rng.pick(LEGS);
  // Everything below comes from the side generator (see the note at the top).
  const r = sideRng(rng, 1);
  const tier = Math.max(tierFromLook(a), tierFromLook(b));
  const eyes = p && q ? (r.next() < 0.5 ? p.eyes : q.eyes) ?? r.pick(EYE_COLOURS) : r.pick(EYE_COLOURS);
  const parentJaw = p && q && p.jaw !== undefined && q.jaw !== undefined ? (p.jaw + q.jaw) / 2 : null;
  const parentNose = p && q && p.nose !== undefined && q.nose !== undefined ? (p.nose + q.nose) / 2 : null;
  const jaw = clamp01((parentJaw ?? (sex === 'male' ? 0.6 : 0.35)) + (sex === 'male' ? 0.08 : -0.08) * (parentJaw === null ? 0 : 1) + r.range(-0.18, 0.18));
  const nose = clamp01((parentNose ?? 0.5) + r.range(-0.2, 0.2));
  const fair = hexToRgb(skin)[0] > 215;
  const freckles = (p?.freckles || q?.freckles ? r.next() < 0.5 : r.next() < (fair ? 0.22 : 0.06));
  const outfit = outfitFor(r, sex, tier);
  const noble = tier >= 6;
  // A separate stream keeps new facial genes from changing simulation rolls or clothing.
  const faceRng = sideRng(rng, 41);
  const pa = p ? normalizeAppearance(p) : null;
  const pb = q ? normalizeAppearance(q) : null;
  const balanced = naturalFace(faceRng);
  const face = Object.fromEntries(FACE_FIELDS.map((field) => [field,
    pa && pb ? clamp01(pa[field] * 0.5 + pb[field] * 0.5 + faceRng.range(-0.15, 0.15)) : balanced[field],
  ]));
  // The fine detail: from the parents, or a little either side of the middle (its own stream, so
  // adding it changed no one's other looks).
  const detailRng = sideRng(rng, 57);
  const detail = Object.fromEntries(DETAIL_FIELDS.map((field) => {
    const near = (detailRng.next() + detailRng.next() + detailRng.next()) / 3;
    return [field, Math.round((pa && pb ? clamp01(pa[field] * 0.5 + pb[field] * 0.5 + (near - 0.5) * 0.3) : clamp01(0.5 + (near - 0.5) * 1.2)) * 100) / 100];
  }));
  return {
    ...face,
    ...detail,
    sex,
    skin,
    hair,
    hairStyle,
    beard: false,
    tunic,
    trim: noble ? r.pick(['#d9b25a', '#e8e2c8', '#c9a44c'] as const) : trim,
    legs,
    height: Math.max(0.9, Math.min(1.1, height)),
    build: Math.max(0.1, Math.min(1, build)),
    // No beardStyle: a boy grows his beard in Family.ts, which sets `beard` when he comes of age.
    outfit,
    headwear: headwearFor(r, sex, tier, false),
    accent: noble ? r.pick(RICH) : r.pick(PLAIN),
    cloak: null,
    eyes,
    jaw: Math.round(jaw * 100) / 100,
    nose: Math.round(nose * 100) / 100,
    freckles,
    scar: false,
  };
}

/**
 * A grown stranger (newcomers to Hearthwick). `tier` is their class (0 Poor … 8 Royal; see
 * appearance.ts `tierOfRank`), which decides what they can afford to wear.
 */
export function randomAppearance(rng: Rng, sex: Sex, tier = 2): KyndAppearance {
  const look = inheritAppearance(rng, sex, null, null);
  if (sex === 'male') look.beard = rng.next() < 0.55;
  const r = sideRng(rng, 2);
  let beardStyle: BeardStyle = 'none';
  if (look.beard) beardStyle = r.pick(['short', 'short', 'full', 'full', 'forked', 'moustache', 'stubble'] as const);
  else if (sex === 'male' && r.next() < 0.2) beardStyle = 'stubble';
  const noble = tier >= 6;
  look.beardStyle = beardStyle;
  look.outfit = outfitFor(r, sex, tier);
  look.headwear = headwearFor(r, sex, tier, true);
  look.accent = noble ? r.pick(RICH) : r.pick(PLAIN);
  if (noble) look.trim = r.pick(['#d9b25a', '#e8e2c8', '#c9a44c'] as const);
  look.cloak = r.next() < (noble ? 0.5 : 0.18) ? r.pick(noble ? RICH : ['#3a2a1c', '#4a4f5a', '#2f2a26', '#5a4a3a', '#2f5a5a', '#6b4a2e']) : null;
  look.scar = sex === 'male' ? r.next() < 0.08 : r.next() < 0.02;
  if (noble && look.tunic && !RICH.includes(look.tunic)) look.tunic = r.pick(CLOTH_COLOURS.slice(8));
  return look;
}

const MALE_NAMES = ['Wat', 'Hob', 'Piers', 'Ranulf', 'Emrys', 'Tobin', 'Anselm', 'Cuthbert', 'Alard', 'Hamon', 'Jory', 'Osbert', 'Gawen', 'Rowan', 'Benet', 'Dunstan', 'Kit', 'Lowell', 'Merek', 'Noll', 'Perrin', 'Swithin', 'Tam', 'Warin'];
const FEMALE_NAMES = ['Isolde', 'Mabel', 'Elspeth', 'Joan', 'Avice', 'Cecily', 'Edda', 'Gwenllian', 'Hawise', 'Idony', 'Linnet', 'Maud', 'Nesta', 'Petronel', 'Rosamund', 'Sybil', 'Tace', 'Wynne', 'Alys', 'Bryony', 'Clemence', 'Dilys', 'Emmot', 'Fenella'];
const SURNAMES = ['Mayhew', 'Cotter', 'Reeve', 'Hollins', 'Ashby', 'Tanner', 'Wick', 'Fairweather', 'Greaves', 'Pollard', 'Marsh', 'Underhill', 'Thatcher', 'Brightwater', 'Hazeldene', 'Oakshott', 'Penrose', 'Rookwood', 'Sallowmere', 'Whitlock', 'Yarrow', 'Fenwick', 'Merriweather', 'Coldbrook'];

export function randomFirstName(rng: Rng, sex: Sex, avoid: Iterable<string> = []): string {
  const taken = new Set(avoid);
  const pool = (sex === 'male' ? MALE_NAMES : FEMALE_NAMES).filter((n) => !taken.has(n));
  return rng.pick(pool.length ? pool : sex === 'male' ? MALE_NAMES : FEMALE_NAMES);
}

export function randomSurname(rng: Rng, avoid: Iterable<string> = []): string {
  const taken = new Set(avoid);
  const pool = SURNAMES.filter((n) => !taken.has(n));
  return rng.pick(pool.length ? pool : SURNAMES);
}

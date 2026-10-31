import type { HairStyle, KyndAppearance, Sex } from './Kynd.ts';
import type { Rank } from '../kingdom/Class.ts';

/*
 * The vocabulary of how a Kynd can look: hair, beards, outfits, headwear, faces. Shared by the
 * renderer (KyndAvatar), the Kynd Creator and inheritance (genetics.ts). Plain data only: the
 * simulation must keep running in Node.
 *
 * Everything added after the first release is optional on KyndAppearance, so old saves and
 * hand-written looks keep working: `normalizeAppearance` fills in sensible defaults.
 */

export const HAIR_STYLES: { id: HairStyle; label: string }[] = [
  { id: 'cropped', label: 'Cropped' },
  { id: 'short', label: 'Short' },
  { id: 'curly', label: 'Curls' },
  { id: 'shoulder', label: 'Shoulder-Length' },
  { id: 'long', label: 'Long & Loose' },
  { id: 'wavy', label: 'Long Waves' },
  { id: 'braid', label: 'Single Braid' },
  { id: 'twin_braids', label: 'Twin Braids' },
  { id: 'bun', label: 'Pinned Bun' },
  { id: 'shaved', label: 'Shaved' },
  { id: 'bob', label: 'Chin-Length Bob' },
  { id: 'ponytail', label: 'Low Ponytail' },
  { id: 'half_up', label: 'Half-Up Waves' },
];

export type BeardStyle = 'none' | 'stubble' | 'moustache' | 'short' | 'full' | 'forked';
export const BEARD_STYLES: { id: BeardStyle; label: string }[] = [
  { id: 'none', label: 'Clean-Shaven' },
  { id: 'stubble', label: 'Stubble' },
  { id: 'moustache', label: 'Moustache' },
  { id: 'short', label: 'Short Beard' },
  { id: 'full', label: 'Full Beard' },
  { id: 'forked', label: 'Forked Beard' },
];

/**
 * Period outfits. Each is a full costume the renderer builds from layered garments; `tunic` is
 * the main garment colour, `trim` the edging/embroidery, `legs` hose or skirt lining, `accent`
 * the third colour (apron, belt, surcoat, cloak lining).
 */
export type OutfitStyle =
  | 'tunic' // knee tunic, hose and boots: the everyday commoner
  | 'smock' // loose field smock with rolled sleeves and a rope belt: labourers, farmers
  | 'doublet' // fitted buttoned doublet over hose: artisans, merchants
  | 'robe' // ankle-length robe with a wide belt: scholars, clergy, elders
  | 'surcoat' // tunic under a sleeveless surcoat with fur trim: gentry, nobility
  | 'kirtle' // fitted ankle gown with laced bodice: the everyday woman's dress
  | 'apron_dress' // kirtle with a work apron and rolled sleeves: household and trade work
  | 'cotehardie' // close-fitting buttoned gown with tippets: well-to-do townswomen
  | 'gown'
  | 'riding_coat'
  | 'court_dress';
export const OUTFITS: { id: OutfitStyle; label: string; for: Sex | 'any'; minTier: number }[] = [
  { id: 'smock', label: 'Field Smock', for: 'any', minTier: 0 },
  { id: 'tunic', label: 'Tunic & Hose', for: 'any', minTier: 0 },
  { id: 'apron_dress', label: 'Kirtle & Apron', for: 'any', minTier: 0 },
  { id: 'kirtle', label: 'Laced Kirtle', for: 'any', minTier: 1 },
  { id: 'doublet', label: 'Buttoned Doublet', for: 'any', minTier: 3 },
  { id: 'cotehardie', label: 'Cotehardie', for: 'any', minTier: 3 },
  { id: 'robe', label: 'Long Robe', for: 'any', minTier: 2 },
  { id: 'surcoat', label: 'Furred Surcoat', for: 'any', minTier: 6 },
  { id: 'gown', label: 'Houppelande Gown', for: 'any', minTier: 6 },
  { id: 'riding_coat', label: 'Tailored Riding Coat', for: 'any', minTier: 3 },
  { id: 'court_dress', label: 'Pleated Court Dress', for: 'any', minTier: 6 },
];

export type Headwear = 'none' | 'coif' | 'hood' | 'straw_hat' | 'felt_cap' | 'veil' | 'wimple' | 'circlet' | 'crown';
export const HEADWEAR: { id: Headwear; label: string; minTier: number }[] = [
  { id: 'none', label: 'Bare-Headed', minTier: 0 },
  { id: 'coif', label: 'Linen Coif', minTier: 0 },
  { id: 'hood', label: 'Hood & Liripipe', minTier: 0 },
  { id: 'straw_hat', label: 'Straw Hat', minTier: 0 },
  { id: 'felt_cap', label: 'Felt Cap', minTier: 1 },
  { id: 'veil', label: 'Veil', minTier: 1 },
  { id: 'wimple', label: 'Wimple', minTier: 2 },
  { id: 'circlet', label: 'Circlet', minTier: 6 },
  { id: 'crown', label: 'Crown', minTier: 8 },
];

/** Palettes offered in the Kynd Creator (the renderer accepts any hex colour). */
export const SKIN_TONES = ['#f4d2b8', '#f0c7a4', '#e8b996', '#e0a882', '#d9a07a', '#c98e68', '#c48a64', '#b07550', '#9a6a4a', '#8a5a3c', '#6e452c', '#5a3824'];
export const HAIR_COLOURS = ['#1f1a17', '#2a1a14', '#4a2c1a', '#6b3a1e', '#8a6a3a', '#a8552b', '#c46a2e', '#d8b25a', '#e6cf8a', '#5a5048', '#8a7a6a', '#cfcac2'];
export const EYE_COLOURS = ['#3a2a1e', '#5a3a1e', '#6b4a2a', '#4a6a8a', '#5a7a5a', '#7a8a9a', '#2a221c'];
/** Dyes of the period: madder, woad, weld, walnut, lichen purple, undyed linen and wool. */
export const CLOTH_COLOURS = [
  '#e8e0cc', '#d9c9a0', '#b8a888', '#8a7a5a', '#6b4a2e', '#4a3a2a', '#3d3a36', '#2f2a26',
  '#8c3b3b', '#7a1f2a', '#a8452e', '#c46a2e', '#c9a44c', '#8a6a2a', '#5a6b3a', '#3f6e5a',
  '#2f5a5a', '#3f5f8c', '#1f3f6a', '#4a4f5a', '#6a3a7a', '#5a2a6a', '#7a4a3a', '#9a6a7a',
];

/** A Kynd's looks with every optional field filled in. */
export type FullAppearance = Required<KyndAppearance>;

export const FACE_FIELDS = ['faceWidth', 'faceLength', 'cheekbones', 'eyeSpacing', 'eyeSize', 'eyeShape', 'mouthWidth', 'lipFullness', 'browShape'] as const;

/**
 * Fine detail of the face, each 0…1 with 0.5 neutral (a face made before them keeps its looks):
 * the jaw's angle (rounded … sharp), the chin (receding … strong) and its width (pointed … broad),
 * the upper lip (thin … full, against the lower), the mouth's corners (down … up) and height (high …
 * low), the nose's width, bridge (low … high) and tip (drooping … upturned), and the cheeks
 * (hollow … full).
 */
export const DETAIL_FIELDS = ['jawAngle', 'chin', 'chinWidth', 'upperLip', 'mouthCorners', 'mouthHeight', 'noseWidth', 'noseBridge', 'noseTip', 'cheekFullness'] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

/** Stable legacy migration: identity depends on proportions, never clothing or age-greyed hair. */
function legacyFace(a: KyndAppearance): Record<(typeof FACE_FIELDS)[number], number> {
  const key = `${a.sex}|${a.skin}|${a.height}|${a.build}|${a.jaw ?? ''}|${a.nose ?? ''}`;
  let seed = 2166136261;
  for (const ch of key) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  return Object.fromEntries(FACE_FIELDS.map((field) => {
    seed = Math.imul(seed ^ (seed >>> 16), 2246822507);
    const value = a[field];
    // Within the middle of each range: extremes on several features at once make a caricature.
    return [field, Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 0.25 + ((seed >>> 0) / 4294967296) * 0.5];
  })) as Record<(typeof FACE_FIELDS)[number], number>;
}

/** The outfit a Kynd wears if none was chosen: by sex, and by the family's standing. */
export function defaultOutfit(sex: Sex, tier = 2): OutfitStyle {
  if (tier >= 6) return sex === 'male' ? 'surcoat' : 'gown';
  if (tier >= 3) return sex === 'male' ? 'doublet' : 'cotehardie';
  if (tier <= 0) return sex === 'male' ? 'smock' : 'apron_dress';
  return sex === 'male' ? 'tunic' : 'kirtle';
}

/** Fill in defaults for looks made before outfits, headwear and faces existed. */
export function normalizeAppearance(a: KyndAppearance): FullAppearance {
  return {
    ...a,
    ...legacyFace(a),
    ...(Object.fromEntries(DETAIL_FIELDS.map((f) => [f, Number.isFinite(a[f]) ? Math.max(0, Math.min(1, a[f]!)) : 0.5])) as Record<DetailField, number>),
    beardStyle: a.beardStyle ?? (a.beard ? 'short' : 'none'),
    outfit: a.outfit ?? defaultOutfit(a.sex),
    headwear: a.headwear ?? 'none',
    accent: a.accent ?? a.legs,
    cloak: a.cloak ?? null,
    eyes: a.eyes ?? '#3a2a1e',
    jaw: a.jaw ?? (a.sex === 'male' ? 0.6 : 0.35),
    nose: a.nose ?? 0.5,
    freckles: a.freckles ?? false,
    scar: a.scar ?? false,
  };
}

/** Class tier (0 Poor … 8 Royal) for a rank, used to dress people as their station allows. */
export function tierOfRank(rank: Rank | undefined): number {
  switch (rank) {
    case 'royal':
      return 8;
    case 'noble':
      return 7;
    case 'gentry':
      return 6;
    default:
      return 2;
  }
}

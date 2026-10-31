// Type-only stand-in written by export-kit.mjs: just the types the character code uses.
import type { BeardStyle, Headwear, OutfitStyle } from './appearance.ts';

/** What the Kynd's arms/head are doing. The renderer layers this over the posture. */
export type Activity =
  | 'idle'
  | 'eat'
  /** A cup to the lips (ale, nectar, tea, a remedy): sip, and set it down. */
  | 'drink'
  | 'read'
  | 'talk'
  | 'joke'
  | 'laugh'
  | 'flirt'
  | 'kiss'
  | 'argue'
  | 'sulk'
  | 'cook'
  | 'wash'
  | 'warm'
  | 'sleep'
  | 'garden'
  | 'hug'
  | 'think'
  | 'reach'
  | 'watch'
  | 'bathe'
  | 'relax'
  | 'play'
  | 'tend'
  | 'dance'
  | 'confused'
  | 'dress'
  | 'fish'
  /** Under the covers with someone (interactions/woohoo.ts). */
  | 'woohoo';

export type CarryItem = 'bowl' | 'bread' | 'book' | 'pot' | 'lute' | 'rod' | 'lance' | 'cup' | null;

export type Sex = 'male' | 'female';

export type HairStyle = 'short' | 'long' | 'braid' | 'cropped' | 'curly' | 'shoulder' | 'wavy' | 'twin_braids' | 'bun' | 'shaved' | 'bob' | 'ponytail' | 'half_up';

export interface KyndAppearance {
  sex: Sex;
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  beard: boolean;
  tunic: string;
  trim: string;
  legs: string;
  /** Uniform scale around 1.0. */
  height: number;
  /** 0 = slight, 1 = stocky. */
  build: number;
  // Optional (added with the Kynd Creator; see entities/appearance.ts for defaults).
  beardStyle?: BeardStyle;
  outfit?: OutfitStyle;
  headwear?: Headwear;
  /** Third garment colour: apron, belt, surcoat or cloak lining. */
  accent?: string;
  /** Cloak colour, or null for none. */
  cloak?: string | null;
  eyes?: string;
  /** 0 = soft, narrow jaw … 1 = broad, square jaw. */
  jaw?: number;
  /** 0 = small nose … 1 = large nose. */
  nose?: number;
  /** Independent, normalized facial proportions; optional for legacy saves. */
  faceWidth?: number;
  faceLength?: number;
  cheekbones?: number;
  eyeSpacing?: number;
  eyeSize?: number;
  eyeShape?: number;
  mouthWidth?: number;
  lipFullness?: number;
  browShape?: number;
  /**
   * Fine face detail (Kynd Creator ▸ Face detail), 0…1 with 0.5 neutral; optional, so faces made
   * before them are unchanged. See DETAIL_FIELDS.
   */
  jawAngle?: number;
  chin?: number;
  chinWidth?: number;
  upperLip?: number;
  mouthCorners?: number;
  mouthHeight?: number;
  noseWidth?: number;
  noseBridge?: number;
  noseTip?: number;
  cheekFullness?: number;
  freckles?: boolean;
  scar?: boolean;
}

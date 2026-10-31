// Stand-in written by export-kit.mjs: just what the animal code uses from the simulation.
export type AnimalSex = 'male' | 'female';

/**
 * How an animal looks. Every field is heritable, so offspring can later be bred from parents
 * (AnimalGenetics); presets give a historically plausible starting point (hound, mastiff, shepherd,
 * terrier, lap dog).
 */
export interface AnimalGenome {
  /** 0 small … 1 large (within the species). */
  size: number;
  /** 0 slight … 1 heavy. */
  build: number;
  coat: string;
  secondary: string;
  pattern: 'solid' | 'patched' | 'saddle' | 'masked' | 'ticked' | 'dappled' | 'spotted';
  /** 0 smooth … 1 shaggy. */
  coatLength: number;
  ears: 'pricked' | 'floppy' | 'folded';
  tail: 'long' | 'curled' | 'short' | 'plumed';
  /** 0 short-faced … 1 long muzzle. */
  muzzle: number;
  eye: string;
  /** The broad type it was bred from (hound, mastiff…), if known. */
  type?: string;
  // --- Horses (horseLooks.ts) -------------------------------------------------------------
  /**
   * Coat-colour genotype, two letters per locus: Extension (E/e), Agouti (A/a), Cream (C/n),
   * Grey (G/n), Leopard (L/n), Dominant White (W/n), e.g. "Ee Aa nn Gn nn nn". The visible coat
   * (`coat`, `secondary`, `pattern`, `type`) is derived from it.
   */
  genes?: string;
  /** Mane and tail colour. */
  mane?: string;
  /** White on the face. */
  face?: 'none' | 'star' | 'snip' | 'stripe' | 'blaze';
  /** White on each leg (front left, front right, hind left, hind right): 0 none, 1 sock, 2 stocking. */
  socks?: string;
}

/** What an animal is doing right now. The renderer poses it from this. */
export type AnimalActivity = 'idle' | 'walk' | 'run' | 'sit' | 'lie' | 'sleep' | 'eat' | 'drink' | 'sniff' | 'play' | 'beg' | 'bark' | 'wag' | 'shy' | 'groom' | 'stalk' | 'graze' | 'roll' | 'dig' | 'pounce';

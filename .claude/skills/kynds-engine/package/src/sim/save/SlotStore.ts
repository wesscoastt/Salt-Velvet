/**
 * Kynds Engine, save storage (docs/ENGINE_PLAN.md, M1; packing M4). Named save slots and a one-shot handoff
 * across a page reload, over any key-value store (the browser's localStorage and sessionStorage
 * by default). Every access is guarded: storage can be missing, disabled, full or wiped, and the
 * game must keep running either way. Game-agnostic: what goes in a slot is the game's business.
 */

import { pack, unpack } from './pack.ts';

/** Marks a packed value (JSON never starts with it), so older plain-JSON values still read. */
const PACKED = '\u00a7LZ1';

/** A stored value as text: packed if asked (M4: saves shrink about sixfold), else plain JSON. */
function encode(value: unknown, packed: boolean): string {
  const json = JSON.stringify(value);
  return packed ? PACKED + pack(json) : json;
}

/** A stored value back, whichever way it was written; throws if it can't be read. */
function decode<T>(raw: string): T {
  if (raw.startsWith(PACKED)) {
    const json = unpack(raw.slice(PACKED.length));
    if (json === null) throw new Error('damaged save');
    return JSON.parse(json) as T;
  }
  return JSON.parse(raw) as T;
}

/** Options for a store: `packed` writes values packed (reading takes either form). */
export interface StoreOptions {
  packed?: boolean;
}

/** The part of the Web Storage API the store needs (a Map-backed stand-in works in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A store that's always empty and never saves (where real storage can't be had). */
export const NO_STORAGE: StorageLike = { getItem: () => null, setItem: () => { throw new Error('storage unavailable'); }, removeItem: () => {} };

const guard = (get: () => StorageLike | undefined): StorageLike => {
  try {
    return get() ?? NO_STORAGE;
  } catch {
    return NO_STORAGE;
  }
};

/** The browser's persistent storage, if it can be had. */
export const browserLocal = (): StorageLike => guard(() => (typeof localStorage === 'undefined' ? undefined : localStorage));
/** The browser's per-tab storage (it survives a reload), if it can be had. */
export const browserSession = (): StorageLike => guard(() => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage));

/** JSON values in named slots under one key prefix. */
export class SlotStore<T> {
  private readonly prefix: string;
  private readonly storage: () => StorageLike;
  private readonly packed: boolean;

  constructor(prefix: string, storage: () => StorageLike = browserLocal, opts: StoreOptions = {}) {
    this.prefix = prefix;
    this.storage = storage;
    this.packed = !!opts.packed;
  }

  /** The slot's value, or null if it's empty, unreadable or storage is unavailable. */
  read(slot: string): T | null {
    try {
      const raw = this.storage().getItem(this.prefix + slot);
      return raw ? decode<T>(raw) : null;
    } catch {
      return null;
    }
  }

  /** True when written; otherwise a reason fit to show the player. */
  write(slot: string, value: T): true | string {
    try {
      this.storage().setItem(this.prefix + slot, encode(value, this.packed));
      return true;
    } catch (e) {
      return `Couldn't save: ${e instanceof Error ? e.message : 'storage unavailable'}.`;
    }
  }

  remove(slot: string): void {
    try {
      this.storage().removeItem(this.prefix + slot);
    } catch {
      // Nothing to do: it's gone either way.
    }
  }
}

/**
 * A value handed across a page reload (a save to load, a new game to start), taken exactly once.
 */
export class Handoff<T> {
  private readonly key: string;
  private readonly storage: () => StorageLike;
  private readonly packed: boolean;

  constructor(key: string, storage: () => StorageLike = browserSession, opts: StoreOptions = {}) {
    this.key = key;
    this.storage = storage;
    this.packed = !!opts.packed;
  }

  put(value: T): boolean {
    try {
      this.storage().setItem(this.key, encode(value, this.packed));
      return true;
    } catch {
      return false;
    }
  }

  /** The value left for this page load, removed as it's taken (null if none). */
  take(): T | null {
    try {
      const s = this.storage();
      const raw = s.getItem(this.key);
      s.removeItem(this.key);
      return raw ? decode<T>(raw) : null;
    } catch {
      return null;
    }
  }
}

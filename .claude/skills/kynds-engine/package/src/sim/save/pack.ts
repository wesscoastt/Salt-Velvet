/**
 * Kynds Engine (docs/ENGINE_PLAN.md, M4): text packing for saves. Saves are JSON full of repeated
 * keys and ids; a dictionary coder (LZW with literals, as the lz-string format does it) shrinks them
 * several times over, and the result is written 15 bits to a UTF-16 unit (offset clear of control
 * characters and well below the surrogate range), so it stores safely in any Web Storage.
 *
 * Synchronous on purpose: saving and loading stay simple calls. Headless (no DOM).
 */

const BITS = 15;
const OFFSET = 32;

/** Pack a string (any UTF-16 text) into a shorter one. `unpack` reverses it exactly. */
export function pack(text: string): string {
  const out: string[] = [];
  let val = 0, pos = 0;
  const writeBits = (value: number, n: number) => {
    for (let i = 0; i < n; i++) {
      val = (val << 1) | (value & 1);
      if (pos === BITS - 1) {
        pos = 0;
        out.push(String.fromCharCode(val + OFFSET));
        val = 0;
      } else pos++;
      value >>= 1;
    }
  };
  const dict = new Map<string, number>();
  const fresh = new Set<string>();
  let w = '', enlargeIn = 2, dictSize = 3, numBits = 2;
  const grow = () => {
    if (--enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  };
  const emit = (s: string) => {
    if (fresh.has(s)) {
      const code = s.charCodeAt(0);
      if (code < 256) {
        writeBits(0, numBits);
        writeBits(code, 8);
      } else {
        writeBits(1, numBits);
        writeBits(code, 16);
      }
      grow();
      fresh.delete(s);
    } else writeBits(dict.get(s)!, numBits);
    grow();
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!dict.has(c)) {
      dict.set(c, dictSize++);
      fresh.add(c);
    }
    const wc = w + c;
    if (dict.has(wc)) {
      w = wc;
      continue;
    }
    emit(w);
    dict.set(wc, dictSize++);
    w = c;
  }
  if (w !== '') emit(w);
  writeBits(2, numBits);
  // Flush the last unit.
  for (;;) {
    val <<= 1;
    if (pos === BITS - 1) {
      out.push(String.fromCharCode(val + OFFSET));
      break;
    }
    pos++;
  }
  return out.join('');
}

/** The text `pack` was given; null if this isn't packed text (or it's damaged). */
export function unpack(packed: string): string | null {
  if (!packed) return null;
  let index = 0;
  let val = packed.charCodeAt(index++) - OFFSET, position = 1 << (BITS - 1);
  const readBits = (n: number): number => {
    let bits = 0;
    for (let power = 1, k = 0; k < n; k++, power <<= 1) {
      const b = val & position;
      position >>= 1;
      if (position === 0) {
        position = 1 << (BITS - 1);
        val = packed.charCodeAt(index++) - OFFSET;
      }
      if (b) bits |= power;
    }
    return bits;
  };
  const dict: string[] = ['', '', ''];
  let enlargeIn = 4, dictSize = 4, numBits = 3;
  const first = readBits(2);
  if (first === 2) return '';
  if (first > 2) return null;
  let w = String.fromCharCode(readBits(first === 0 ? 8 : 16));
  dict[3] = w;
  const result = [w];
  for (;;) {
    if (index > packed.length + 1) return null;
    let cc = readBits(numBits);
    if (cc === 2) return result.join('');
    if (cc === 0 || cc === 1) {
      dict[dictSize++] = String.fromCharCode(readBits(cc === 0 ? 8 : 16));
      cc = dictSize - 1;
      enlargeIn--;
    }
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
    let entry: string;
    if (dict[cc] !== undefined && cc > 2) entry = dict[cc];
    else if (cc === dictSize) entry = w + w[0];
    else return null;
    result.push(entry);
    dict[dictSize++] = w + entry[0];
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
}

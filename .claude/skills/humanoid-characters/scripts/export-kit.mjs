#!/usr/bin/env node
// Export the Kynds character generator as a self-contained kit (no game simulation behind it).
//
//   node .claude/skills/humanoid-characters/scripts/export-kit.mjs [outDir] [--with-court-clothes]
//
// Run from the root of a Kynds: Medieval checkout. Copies the render files that build, dress and
// animate a character, keeping their folder layout (render/, sim/, core/) so no import needs
// rewriting, and writes small type-only stand-ins for the four simulation files they borrow types
// from (Kynd, world types, emotions, life stages). The result runs in any three.js project:
//   new KyndAvatar(look, 'adult') → avatar.root (add to the scene) → avatar.animate(state, t, dt).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const withCourt = args.includes('--with-court-clothes');
const out = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'kit'));
const src = path.resolve('src');
if (!fs.existsSync(path.join(src, 'render', 'KyndAvatar.ts'))) {
  console.error('Run this from the root of a Kynds: Medieval checkout (src/render/KyndAvatar.ts not found).');
  process.exit(1);
}

/** Copied as they are. */
const FILES = [
  'render/KyndAvatar.ts', 'render/KyndGarments.ts', 'render/kyndBody.ts', 'render/kyndFace.ts',
  'render/kyndFaceTexture.ts', 'render/kyndMaterials.ts', 'render/kyndGeometry.ts', 'render/kyndHand.ts',
  'render/kyndAnatomy.ts', 'render/sdfMesh.ts', 'render/kit.ts', 'render/detailMaterial.ts',
  'render/textures.ts', 'render/LanceMesh.ts',
  'sim/entities/appearance.ts', 'sim/family/genetics.ts', 'core/Rng.ts',
];

/** Pull named `export type`/`export interface` declarations out of a file (brace/semicolon matched). */
function declarations(file, names) {
  const text = fs.readFileSync(path.join(src, file), 'utf8');
  const parts = [];
  for (const name of names) {
    const re = new RegExp(`(?:/\\*\\*(?:(?!\\*/)[\\s\\S])*\\*/\\s*)?export (type|interface) ${name}\\b`);
    const m = re.exec(text);
    if (!m) throw new Error(`${name} not found in ${file}`);
    let i = m.index + m[0].length;
    if (m[1] === 'interface') {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) { i++; break; }
      }
    } else {
      // A type alias ends at the first semicolon outside braces, brackets and parentheses.
      let depth = 0;
      for (; i < text.length; i++) {
        const c = text[i];
        if ('{[('.includes(c)) depth++;
        else if ('}])'.includes(c)) depth--;
        else if (c === ';' && depth === 0) { i++; break; }
      }
    }
    parts.push(text.slice(m.index, i));
  }
  return parts.join('\n\n');
}

const SHIM = '// Type-only stand-in written by export-kit.mjs: just the types the character code uses.\n';
const STUBS = {
  'sim/entities/Kynd.ts': `${SHIM}import type { BeardStyle, Headwear, OutfitStyle } from './appearance.ts';\n\n${declarations('sim/entities/Kynd.ts', ['Activity', 'CarryItem', 'Sex', 'HairStyle', 'KyndAppearance'])}\n`,
  'sim/world/types.ts': `${SHIM}${declarations('sim/world/types.ts', ['Posture'])}\n`,
  'sim/emotion/Emotion.ts': `${SHIM}${declarations('sim/emotion/Emotion.ts', ['EmotionId'])}\n`,
  'sim/family/Life.ts': `${SHIM}${declarations('sim/family/Life.ts', ['LifeStage'])}\n`,
  'sim/kingdom/Class.ts': `${SHIM}${declarations('sim/kingdom/Class.ts', ['Rank'])}\n`,
};

fs.rmSync(out, { recursive: true, force: true });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.writeFileSync(path.join(out, rel), text);
};
for (const f of FILES) write(f, fs.readFileSync(path.join(src, f), 'utf8'));
for (const [f, text] of Object.entries(STUBS)) write(f, text);
// The two tailored court outfits are Blender meshes (1.4 MB of numbers): left out unless asked for.
write('render/courtClothesMeshes.ts', withCourt
  ? fs.readFileSync(path.join(src, 'render/courtClothesMeshes.ts'), 'utf8')
  : '// Left out of the kit (export with --with-court-clothes for the riding coat and court dress).\nexport const ridingCoatPositions: number[] = [];\nexport const ridingCoatIndices: number[] = [];\nexport const courtDressPositions: number[] = [];\nexport const courtDressIndices: number[] = [];\n');

// Every relative import in the kit must land on a file in it.
const missing = [];
for (const dir of ['render', 'sim', 'core']) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else for (const m of fs.readFileSync(p, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
        if (!fs.existsSync(path.resolve(path.dirname(p), m[1]))) missing.push(`${path.relative(out, p)} → ${m[1]}`);
      }
    }
  };
  if (fs.existsSync(path.join(out, dir))) walk(path.join(out, dir));
}
if (missing.length) {
  console.error('Unresolved imports in the kit:\n  ' + missing.join('\n  '));
  process.exit(1);
}
console.log(`Kit written to ${out} (${FILES.length} files, ${Object.keys(STUBS).length} type stand-ins${withCourt ? ', court clothes' : ''}).`);

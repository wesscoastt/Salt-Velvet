#!/usr/bin/env node
// Export the Kynds animal generator (dogs of eleven types, cats, horses) as a self-contained kit.
//
//   node .claude/skills/animal-models/scripts/export-kit.mjs [outDir]
//
// Run from the root of a Kynds: Medieval checkout. Copies the render and looks files, keeping their
// folders (render/, sim/, core/) so no import needs rewriting, and writes type-only stand-ins for
// the simulation types they borrow (the genome, activities, life stages) plus the one colour helper
// they use. The result runs in any three.js project:
//   new DogAvatar(dogGenome(rng, 'shepherd'), 'adult') / new HorseAvatar(horseGenome(rng, 'palfrey'), 'adult')
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'kit'));
const src = path.resolve('src');
if (!fs.existsSync(path.join(src, 'render', 'DogAvatar.ts'))) {
  console.error('Run this from the root of a Kynds: Medieval checkout (src/render/DogAvatar.ts not found).');
  process.exit(1);
}

/** Copied as they are. */
const FILES = [
  'render/DogAvatar.ts', 'render/petAnatomy.ts', 'render/petCoat.ts', 'render/petProps.ts', 'render/sdfMesh.ts',
  'render/HorseAvatar.ts', 'render/horseBodyMesh.ts',
  'render/kit.ts', 'render/detailMaterial.ts', 'render/textures.ts',
  'sim/animals/dogLooks.ts', 'sim/animals/catLooks.ts', 'sim/animals/horseLooks.ts',
  'core/Rng.ts',
];

/** Pull named declarations (exported or not) out of a file, brace/semicolon matched. */
function declarations(file, names) {
  const text = fs.readFileSync(path.join(src, file), 'utf8');
  const parts = [];
  for (const name of names) {
    const re = new RegExp(`(?:/\\*\\*(?:(?!\\*/)[\\s\\S])*\\*/\\s*)?(?:export )?(type|interface|function) ${name}\\b`);
    const m = re.exec(text);
    if (!m) throw new Error(`${name} not found in ${file}`);
    let i = m.index + m[0].length;
    if (m[1] === 'interface' || m[1] === 'function') {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) { i++; break; }
      }
    } else {
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

const SHIM = '// Stand-in written by export-kit.mjs: just what the animal code uses from the simulation.\n';
const STUBS = {
  'sim/animals/Animal.ts': `${SHIM}${declarations('sim/animals/Animal.ts', ['AnimalSex', 'AnimalGenome', 'AnimalActivity'])}\n`,
  'sim/animals/Species.ts': `${SHIM}${declarations('sim/animals/Species.ts', ['AnimalStage'])}\n`,
  'sim/family/genetics.ts': `${SHIM}${declarations('sim/family/genetics.ts', ['hexToRgb', 'rgbToHex', 'mixColor'])}\n`,
};

fs.rmSync(out, { recursive: true, force: true });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.writeFileSync(path.join(out, rel), text);
};
for (const f of FILES) write(f, fs.readFileSync(path.join(src, f), 'utf8'));
for (const [f, text] of Object.entries(STUBS)) write(f, text);

// Every relative import in the kit must land on a file in it.
const missing = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else for (const m of fs.readFileSync(p, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(p), m[1]))) missing.push(`${path.relative(out, p)} → ${m[1]}`);
    }
  }
};
walk(out);
if (missing.length) {
  console.error('Unresolved imports in the kit:\n  ' + missing.join('\n  '));
  process.exit(1);
}
console.log(`Kit written to ${out} (${FILES.length} files, ${Object.keys(STUBS).length} stand-ins).`);

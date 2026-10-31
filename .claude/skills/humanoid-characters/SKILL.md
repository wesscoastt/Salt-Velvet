---
name: humanoid-characters
description: Build polished procedural 3D people for a three.js game (Salt and Velvet, or any other) from the Kynds character generator - faces with sliders, jaw, lips, teeth, hair, beards, layered clothing, skin, ageing, inheritance, and procedural animation (walk, sit, lie, bathe, read, eat, idle habits, facial expressions) - with the tests and visual checks that keep them at a 9/10 bar. Use when adding people/NPCs/player characters to a game, porting the Kynds generator, building a character creator, or fixing characters that clip, float, pass through furniture or look stiff.
---

# Humanoid characters (from the Kynds generator)

Every person is generated from a small appearance record: no models or textures on disk, one
skinned mesh set and one shared skeleton per person, about five materials. A whole town is a few
draw calls a head. The code lives in Kynds: Medieval (`src/render/kynd*.ts`, `KyndAvatar.ts`,
`KyndGarments.ts`); this skill carries a self-contained copy in `kit/`.

## Get it into another game
1. Copy `kit/` into the game's source (e.g. `src/characters/`). It needs only `three`
   (with `three/addons`). It is erasable TypeScript (runs under Vite, or Node with type stripping).
2. Use it:
   ```ts
   import { KyndAvatar } from './characters/render/KyndAvatar.ts';
   import { randomAppearance, inheritAppearance } from './characters/sim/family/genetics.ts';
   import { Rng } from './characters/core/Rng.ts';
   const look = randomAppearance(new Rng(7), 'female');          // or build a KyndAppearance by hand
   const person = new KyndAvatar(look, 'adult');                 // 'infant' | 'child' | 'teen' | 'adult' | 'elder'
   scene.add(person.root);
   // each frame:
   person.animate({ posture: 'stand', activity: 'idle', carrying: null, moving, running: false,
     distanceWalked, lieHeight: 0, riding: false, emotion: 'happy', emotionIntensity: 2 }, time, dt);
   ```
   Move `person.root` yourself (position, `rotation.y` = facing). Drive `distanceWalked` from real
   distance covered so feet don't slide. `posture`: stand, sit, lie, kneel, squat, bathe.
   `activity`: idle, talk, eat, drink, read, cook, sleep, laugh, argue… (`sim/entities/Kynd.ts`).
3. Re-theme freely: outfits, hairstyles and headwear are ids in `sim/entities/appearance.ts` with
   builders in `render/KyndGarments.ts` / `render/kyndBody.ts`. For a different era, add outfits
   rather than editing the medieval ones, and keep the names (`Kynd*`) or rename in one pass.
4. Refresh the kit from a newer Kynds checkout: `node .claude/skills/humanoid-characters/scripts/export-kit.mjs`
   (add `--with-court-clothes` for the two Blender-made court outfits, 1.4 MB, left out by default).

## How it is built (where to change what)
| Concern | File |
| --- | --- |
| Appearance vocabulary, defaults (`normalizeAppearance`), face fields, `DETAIL_FIELDS` | `sim/entities/appearance.ts` |
| Inheritance, random looks | `sim/family/genetics.ts` |
| Skeleton `BONES`, `measure`, skull `skull()` + `mandible()`, head mesh, neck (`neckRadius`), hair, beard, mouth interior (`buildMouth`), hands, legs | `render/kyndBody.ts` |
| Face surface: lids, nose, lips, relief, `faceLayout`, `headShape`, face rows | `render/kyndFace.ts` |
| Painted face detail (lips, brows, stubble, age lines) | `render/kyndFaceTexture.ts` |
| Skin, cloth (weave + drape + dye + hem), hair, eye shaders | `render/kyndMaterials.ts` |
| Garments, collars (`collar`, `neckFacing`), headwear | `render/KyndGarments.ts` |
| Mesh helpers: `grid`, `rowMesh` (with `normal` and `gap` hooks), `tube`, `Path`, `ellipsoid` | `render/kyndGeometry.ts` |
| The avatar: layered poses, face rig, held props, reach and grip solvers, habits | `render/KyndAvatar.ts` |

**Animation is procedural, not clips.** Each frame target joint angles are written in layers:
posture, then activity, then life (breathing, weight shift), trait and mood body language, idle
habits (`idleHabit`), the walk; the rig eases toward them, so every change blends. The face rig
blinks, glances, and shapes brows, lids and mouth from emotion (`expressionFor`).
**Solve, don't guess, where a hand must touch something.** `reachFor` (a cup to the lips) and
`bookGrip` (both hands on an open book) run a small coordinate search over the arm's angles on
the person's own skeleton, once per item/posture, cached; so a child's arms and a tall man's
reach both land within millimetres. Use the same pattern for any new contact (a hand on a hip, a
rail, a partner's shoulder).

## The bar, and the mistakes that cost it (all fixed in Kynds; don't reintroduce them)
- **Faces:** a V-tapered lower face reads as an egg: the jaw needs a lower border (`mandible`). Soft
  jaws narrow to an oval chin. Lips need volume, a philtrum and a groove above the chin. Never
  leave face sliders to random extremes: random faces come from the middle of each range
  (`legacyFace`), and named characters get authored values.
- **Mesh seams:** rows of a face mesh must share column phase or a sliver triangle draws a dark
  stroke; use analytic normals (`RowMeshSpec.normal`). Test: no triangle turned against its
  vertex normals (`tests/faces.test.ts`).
- **Mouth:** an opening jaw must open onto something: a dark cavity, teeth on the dental arch (the
  lower row on the jaw bone), a tongue. The skin strip on the mouth line is a gap.
- **Hair:** not one smooth cap (a helmet): combed tapered locks over it, fading into a soft
  hairline that runs past the edge onto the skin; ragged tips at the nape.
- **Beards:** a moustache is many tapered locks filling the upper lip; a beard feathers to nothing
  along a ragged cheek line over stubble.
- **Clothes:** close every neckline round the neck (look down from the game camera: no hollow
  into the clothes). Cloth needs drape folds and uneven dye, not flat colour. Seated, skirts
  gather in round the thighs, never fan out sideways. Under covers or in a bath, hide by
  scaling bones, never by deleting body parts.
- **Furniture:** never pass through what you use. Chairs at tables slide out, are sat on, scoot
  in (and the reverse to get up); seats with backs or arms are never entered from behind or past
  an arm (tag slots `back` / `arms` and test every def). Into bed from the side: sit on the edge,
  lie back with no spin (a lying body's facing = where the feet point). Into a tub: undress
  beside it, step over the rim. Effects (steam, sparks) must not rise through the body.
- **Hands:** held things at the waist, not offered out at arm's length; a free hand hangs, it
  doesn't hover where a table would be. Read with an open book in both hands, turning pages.
- **Life:** people breathe, shift weight, and now and then rub their neck, stretch, glance round
  (eased in and out, each on their own clock). Expressions must be legible at game distance:
  a smile reaches the eyes, anger knits the brows over a turned-down mouth, fear opens the mouth.
- **Voices:** synthesised babble sounds robotic; ship silence (or recorded human voices) instead.

## Verify (every change)
- Unit tests (Node, headless with a fake canvas; see `tests/faces.test.ts`, `tests/settle.test.ts`,
  `tests/hair-fit.test.ts`, `tests/humanoid-kit.test.ts` in Kynds for the patterns): geometry
  facts (jaw border width, lips painted, teeth behind the lips, no turned triangles), pose facts
  (hands on the book within 1 cm for every age, the free hand hangs), sit/lie/bathe sequences
  traced step by step (no gliding seated, the chair slid and back, stepped over the rim).
- Screenshots at close range (front, three-quarter, side, from above at the game camera's angle)
  for both sexes and every life stage, standing, seated, lying; and at game distance. Look at
  every one; fix, then re-shoot the same view.
- Every new test must fail against the old code before it counts.

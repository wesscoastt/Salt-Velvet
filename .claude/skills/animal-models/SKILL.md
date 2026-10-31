---
name: animal-models
description: Build, change or debug procedural animals for a three.js game (Kynds: Medieval, Salt and Velvet, or any other) — dogs of eleven types, cats and horses — their anatomy, fur coats and markings, faces, gaits, sitting/lying/sleeping poses and rider seating, with a self-contained kit to drop into another game and the quality bar that keeps them at 9/10. Use for new breeds or coat patterns, legs or tails clipping, animals walking or lying oddly, horse tack and riders, or "make animals like the Kynds' dogs".
---

# Animal models

Animals are generated from an `AnimalGenome` (breed proportions, coat colours and pattern genes)
like Kynds are from their appearance: one skinned body, a coat shader, a procedural gait.

## Where things live
| Concern | File |
| --- | --- |
| Species and breeds, genomes and inheritance, behaviour, training, riding (sim side, Node-safe) | `src/sim/animals/` (`Species.ts`, `AnimalGenetics.ts`, `dogLooks.ts`, `catLooks.ts`, `AnimalSystem.ts`, `Training.ts`, `Riding.ts`, `Foraging.ts`) |
| Base sculpts made in Blender and baked to TypeScript arrays | `scripts/build-dog-body.py` → `src/render/dogBodyMesh.ts`, `build-horse-body.py` → `horseBodyMesh.ts`, `build-pet-heads.py` → `petHeadMeshes.ts` (install Blender with `scripts/setup-blender.sh`, run `blender -b --factory-startup -P <script>`) |
| Dog and cat anatomy: bone layout (`BONE`, `TAIL_BONES`, `LEG_BASE`), region tags (`TAG`: leg, paw, tail, head, muzzle…) | `src/render/petAnatomy.ts` |
| Coat: per-vertex coat fields (white, second/third colour, shade, stripes), `coatPlan`, `furMaterial`, fur shells, eyes | `src/render/petCoat.ts` |
| Dog/cat avatar: mesh build, IK legs, gait, tail, ears, blinking, sit/lie/sleep poses | `src/render/DogAvatar.ts` (cats share it with `species: 'cat'`) |
| Collars, bowls, beds and other pet props | `src/render/petProps.ts` |
| Horse: sculpted head (`sculptHead`), skin weights, withers/saddle height for riders, gaits, tack | `src/render/HorseAvatar.ts` |
| Syncing avatars with the sim | `src/render/AnimalViews.ts` |

## How it works
- The body surface is tagged by region at build time; the coat shader reads those tags plus the
  genome to place markings (socks, blaze, saddle, tabby stripes) that follow the body as it moves.
- Legs use two-bone IK onto the ground (`DogAvatar` `solve…`), so paws plant on slopes and stairs.
- Poses (sit, lie, curl up asleep with the head on the paws) are joint targets eased like the
  Kynd rig; the tail is a chain with lag.
- Horses expose `horseSaddleHeight(genome, stage)`: riders sit on that height (the Kynd's seated
  pose plus the horse's motion).

## Get it into another game
1. Copy `kit/` (this skill's folder) into the game's source, e.g. `src/animals/`. It needs only
   `three`; it is erasable TypeScript (runs under Vite, or Node with type stripping).
2. Use it:
   ```ts
   import { DogAvatar } from './animals/render/DogAvatar.ts';      // dogs and cats
   import { HorseAvatar } from './animals/render/HorseAvatar.ts';
   import { dogGenome } from './animals/sim/animals/dogLooks.ts';   // 'hound' | 'mastiff' | 'shepherd' | 'terrier' | 'lapdog' | 'sighthound' | 'wolfhound' | 'spaniel' | 'sheepdog' | 'bloodhound' | 'guardian'
   import { catGenome } from './animals/sim/animals/catLooks.ts';
   import { horseGenome } from './animals/sim/animals/horseLooks.ts'; // 'rouncey' | 'palfrey' | 'cob' | 'courser' | 'destrier'
   import { Rng } from './animals/core/Rng.ts';
   const dog = new DogAvatar(dogGenome(new Rng(7), 'shepherd'), 'adult', 'dog');  // 'young' | 'adult' | 'elder'
   const horse = new HorseAvatar(horseGenome(new Rng(8), 'palfrey'), 'adult');
   scene.add(dog.root, horse.root);
   // each frame (move root yourself; distanceWalked from real distance, so feet don't slide):
   dog.animate('walk', true, false, time, dt, distanceWalked);   // idle walk run sit lie sleep eat drink sniff play beg bark wag shy groom stalk graze roll dig pounce
   ```
3. Refresh the kit from a newer Kynds checkout: `node .claude/skills/animal-models/scripts/export-kit.mjs`
   (Kynds' `tests/animal-kit.test.ts` fails if the committed kit falls behind the game).

## The bar, and the mistakes that cost it (fixed in Kynds; don't reintroduce them)
- **Dog heads need a stop:** the forehead steps down to the bridge between the eyes. Masses melt
  together and fill it in, so carve it (`carve` in `petAnatomy`) and measure the profile.
- **Markings follow real dogs:** a collie's white is a blaze narrowing up the forehead and widening
  over the nose, white lips and chin, dark round the eyes; an all-white muzzle reads as a tube.
- **Every breed must read as itself** in a side-by-side line-up (a wolfhound is lean and wiry, not
  a fluffy pale "sheep"). Line them all up after any anatomy or coat change; puppies too.
- **Horse coats are glossy:** roughness varies (glossy body, duller legs, matte muzzle and hooves),
  a satin sheen at grazing angles, muscle shading over shoulder and quarters.
- **Hair is locks, not tubes:** the tail is a fall of separate locks with ragged ends; the mane lies
  over the neck's surface (measure the neck's width from the body mesh), never inside it.
- **Horses lie down at the stifle:** a hind leg needs hip, stifle, hock and pastern joints, or the
  hocks trail out behind. Fold the stifle first (the hoof lifts clear), then bring the thigh forward.
- **Nothing through the ground** standing, lying, rolling or on the way down/up, for adults and
  foals: tests trace the lowest skinned vertex through every pose. Search joint angles on the rig
  against a clearance rule (the leg's thickness under its bones) on the worst case (a foal).
- **Tests that sample animation must hold random habits and blinks off,** or they fail now and then.
- **Measure every fix, and revert it if the numbers don't back it up** (several tried poses here
  looked plausible and measured worse).

## Recipes
- **New dog breed:** add its proportions and default coat in `src/sim/animals/dogLooks.ts` / `Species.ts`,
  check head/muzzle/ear shape branches in `DogAvatar.ts`, screenshot standing, sitting and asleep.
- **New coat pattern:** a new field in the genome, a branch in `coatFields` (`petCoat.ts`), and a
  colour rule in `coatColorAt`.
- **Reuse elsewhere:** `petAnatomy.ts`, `petCoat.ts`, `DogAvatar.ts` (+ `HorseAvatar.ts`) need only
  three.js and a genome object.

## Verify
- Screenshots at distance ≥ 5 with `scripts/qa-shots.mjs` (`--setup` can spawn an animal), side
  views for leg/tail clipping, close views for faces; night shots for eye shine.
- `npm test` (animal tests cover genomes, behaviour and saves; `animal-render`, `horse-render` and `animal-kit` cover the models).

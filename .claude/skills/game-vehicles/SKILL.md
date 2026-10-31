---
name: game-vehicles
description: "Build or polish cars, trucks, police units and motorcycles in a three.js game to a 9/10 bar: paint, glass, chrome, wheels, lamps, grilles, liveries, interiors, drivers, LOD, and the audit that proves it."
---

# Game vehicles at 9/10

Distilled from bringing every vehicle in Cypress Falls Patrol (three.js r128, single-file ES5
browser game, tested on iPhone, Xbox pad, Logitech G Cloud, Chrome) up to a 9/10 bar. Use it when
adding vehicles to a game, porting this vehicle stack, or when cars look plasticky, float, clip,
or read as boxes. Most of the gain comes from materials, wheels and lamps, then from reshaping the
bodies so they stop reading as shoeboxes; do those before any remodelling.

## Ground rules
- Keep the game's own constraints. In Cypress Falls that means ES5 only (no let/const/arrow/class),
  pure ASCII (escape anything else as \uXXXX), no console.log, one self-contained HTML file.
  Check after every change: an acorn ES5 parse of every script block, a non-ASCII grep, a
  console.log grep. Other games have their own rules: follow those.
- Function declarations inside loops or blocks break strict mode: write `var f = function(){}`.
- Never change the seeded world RNG sequence when adding detail: use a local hash or mulberry32
  seeded from position, or the whole city layout shifts.
- One draw call is worth more than a few hundred triangles on a phone. Merge per material; add a
  separate mesh only when it needs a different material (chrome, grille, glass, lamp lenses).
- Anything built procedurally from measurements of the body (cabin, headliner, visors, seats,
  drivers) must be measured after every warp of the body, or it pokes out of the reshaped car.

## The bar: what a 9/10 vehicle has
1. **Paint that reads as clearcoat**: colour faces you head-on, and the sky and horizon slide along
   the flanks and roof at glancing angles. A crisp horizon line in the environment map is what
   makes paint look glossy.
2. **Glass** that reflects more at glancing angles and is less see-through there, with the cabin
   visible through it head-on.
3. **Chrome that is chrome**: mirror-bright, on its own material. In matte trim it reads as
   white plastic.
4. **Grounding**: the body darkens toward the sills and under the arches. Arch liners are black,
   not paint. Tyres sit about 3 cm inside the body side, never standing proud of the arches. A
   soft contact shadow sits under each car.
5. **Wheels with depth**: a polished rim lip, a dark barrel and dish behind the spokes (the gaps
   must read as depth, not a flat disc), spokes as solid tapered prisms, a hub with lug nuts and a
   centre cap, a brake disc behind, and a dark-grey (not pitch-black) tyre with a sidewall band.
   Offer a few styles: twin five-spoke, wide six-spoke, ten-spoke, and black steel with a chrome
   cap for police.
6. **Lamps that look like lamps by day**: headlamps as chrome reflector bowls with dark projector
   lenses (a row of small bowls for slim LED lamps, one or two big ones for tall lamps). Tail lamps
   with horizontal LED bands, using the same texture as the emissive map so the night glow is
   banded too.
7. **Grilles with an insert**: honeycomb for cars and crossovers, stacked bars for trucks and big
   SUVs, confined to the opening between bumper and hood. Pickup bumpers stay plain.
8. **Liveries** that follow the real department (photos beat memory), run all the way round
   (sides, rear, tailgate), and never spill onto glass or lamps.
9. **Cabins**: no lid at window height, seats and dash visible through the glass, a headliner from
   inside, and a driver who sits at the wheel with hands on the rim. Nothing from the cabin shows
   outside the body: no visor or liner ledge under the roof edge, no headrest through a fastback
   roof.
10. **Night**: environment reflections dim with the night factor (no daytime sky glowing on paint
   at midnight), lamps light up, and the beams and glows read.
11. **Distance**: the LOD model keeps the same silhouette, colours and livery. Nothing pops: no
   missing hood, no changed colour.
12. **A silhouette, not a box**: noses and tails taper and their corners round off in plan, the
   flanks bow and tuck in at the sill, the glasshouse leans in, the hood and deck fall away to the
   ends, the roof crowns. Jeeps, work trucks and buses stay square: they are square.

## Techniques (the code that got there)

### Car surface shader (one patch for paint, glass, trim, chrome, wheels)
Patch the Phong car materials in `onBeforeCompile`. Phong already defines ENV_WORLDPOS, and
`normal` and `geometry.viewDir` are in scope at `envmap_fragment`:
```js
function carSurface(m, o){            // o: {fres, coat, ao, glass, lum}
  m.onBeforeCompile = function(sh){
    sh.uniforms.uNight = WORLD_NIGHT; sh.uniforms.uFres = {value:o.fres}; sh.uniforms.uCoat = {value:o.coat||0};
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCarP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarP;\nuniform float uNight, uFres, uCoat;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + (o.ao ?
        'diffuseColor.rgb *= mix(0.58, 1.0, smoothstep(0.06, 0.62, vCarP.y));' : ''))
      .replace('outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );',
        '{ float nv = clamp(dot(normal, geometry.viewDir), 0.0, 1.0);\n' +
        '  float fr = reflectivity + (uFres - reflectivity) * pow(1.0 - nv, 5.0);\n' +
        (o.lum ? '  fr *= smoothstep(0.015, 0.2, dot(diffuseColor.rgb, vec3(.3,.59,.11)));\n' : '') +
        '  outgoingLight = mix(outgoingLight, envColor.xyz * mix(1.0, 0.10, uNight), specularStrength * fr);\n' +
        '  #if NUM_DIR_LIGHTS > 0\n' +
        '  outgoingLight += directionalLights[0].color * pow(max(dot(normal, normalize(directionalLights[0].direction + geometry.viewDir)), 0.0), 420.0) * uCoat;\n' +
        '  #endif\n' + (o.glass ? '  diffuseColor.a = mix(diffuseColor.a, 0.92, fr * 0.9);\n' : '') + '}');
  };
  m.customProgramCacheKey = function(){ return 'carSurf' + (o.ao?1:0) + (o.glass?1:0) + (o.lum?1:0); };
}
```
Tuning that worked:

| Material | Base reflectivity | Fresnel max | Coat | Options |
| --- | --- | --- | --- | --- |
| Paint | .10 | .72 | 1.1 | ao, shininess 80 |
| Glass | .10 | .85 | 1.4 | opacity .42, glass |
| Trim | .06 | .45 | .4 | ao, lum (dark rubber stops reflecting the sky) |
| Chrome | .62 | .96 | 1.8 | base colour 0x8e949a |
| Wheels | .12 | .6 | .7 | lum |

`vCarP` is mesh-local, so the AO works only if body meshes are built with y = 0 at the road.

### Environment map
Use a 128 px canvas cube:
- Overhead: deep blue with a couple of soft cloud bands.
- Sides: blue sky into bright haze, a hard horizon line with a skyline of 30 seeded boxes on it, then a dark road below. Add a warm sun window on one side face.
- Below: dark grey.

### Body-shape warp (the shoebox fix)
Bodies lofted from straight sections read as boxes however good the paint is. Reshape every
vertex once at load (paint, glass, lamps, trim and police parts alike, so everything stays
together), from the body's own profile (nose, tail, width, sill, beltline and roof heights), with
an amount per body type (`BODY_ROUND`: sedans and crossovers about 1, SUVs .55 to .8, pickups .35
to .5, vans .35, Jeeps, box trucks and buses 0). With u the position along the car (-1 tail, +1
nose), ends = smoothstep(.4, 1, |u|), zn = |z| / half-width, and hy the height between sill and
beltline:
- **plan:** taper the width toward the ends (`.13 * ends^1.4`) and pull the outer corners back
  (`.30 * hw * zn^2.6 * smoothstep(.62, 1, |u|)`), so the ends curve round instead of meeting the
  sides at a right angle;
- **section:** bow the lower body out (`.045 * (1 - (2hy - 1)^2)`), tuck it in at the sill, roll
  the shoulder in toward the beltline, and lean the glasshouse in above it (`.12` at the roof);
- **profile:** rake the nose and tail back above the bumper, let the hood and deck fall away to
  the ends (`.10 * ends^2`), and crown the roof across (`.03 * (1 - zn^2)`).
Run the warp after any cleanup that measures the raw body (glass, cabin volume), and before
anything is built from measurements of it. Raising the crease angle used for flat-shaded paint
normals helped too: 34 degrees made the cars look boxier, 58 rounded them.

### Wheels
- Build the tyre as a lathe (rounded shoulders, 32 segments, 0x1b1c1f) with a sidewall band.
- Build the alloy in this order:
  1. a dark barrel/dish lathe (0x34373c),
  2. a polished lip lathe,
  3. N spoke prisms (front faces at about .93 of the half-width, sides darker, a slight dip mid-spoke),
  4. the hub boss, five lug nuts and a centre cap.
- Put the brake disc behind the rim and never put a caliper on the wheel mesh: the wheel spins.
- Orient flat faces explicitly: build each quad, check its normal against the wanted direction, and swap the winding if it points the wrong way.
- Place each wheel at `min(max(track, wid/2 - .19), wid/2 - .155)` so the outer face is tucked in.
- A full alloy is about 1,250 triangles, so four of them cost more than a distant body. Make a
  light version (a 12-sided tyre and a dished face in the rim's colour, about a tenth of the
  triangles) and swap each wheel's geometry when the car's body LOD switches
  (`lod.getCurrentLevel() > 0`), only on the frame it changes.

### Lamps, grilles, chrome from authored bodies
With vehicle bodies stored as groups by material (PAINT, ROOF, UPPER, GLASS, CHROME, BLACK, DARK,
HEAD, TAIL, AMBER):
- **Grille:** take the forward-facing BLACK and DARK triangles in the nose, between a little under the headlamps and the hood line. Give them planar UVs from (z, y) in metres and a canvas texture, as their own mesh.
- **Headlamps:** planar UVs from (|z|, y), with the tile size from the lamp height (`clamp(h*1.15, .075, .17)`) and offsets centring a bowl on each lamp, mirrored side to side. Side faces sample a plain texel.
- **Tail lamps:** UV v = y / .048 gives level bands that wrap round the corner. Use the texture as both map and emissiveMap, and raise emissive intensity about 30% to make up for the map's average.
- **Chrome:** its own mesh and material, not part of the trim.

### Glass from solid glasshouses
Authored glasshouses are often closed solids: besides the panes there is a flat lid right under
the roof and a flat floor at the beltline. Drop GLASS triangles within about 11 degrees of
horizontal (|ny| > .98) that sit below the painted body's top. A glass roof standing above the
paint (a Model 3 type) is the roof: move its upward faces to the black trim group (real ones are
dark tinted) and keep them in the roof skin the cabin lines.

### Cabin fitted to the roof
- Line the roof from inside with the roof skin itself (its upward PAINT/ROOF faces near the top,
  turned to face down and dropped 3.5 cm).
- Size any flat liner and the sun visors from that roof skin's outline, inset 12 to 14 cm, never
  from the beltline width: once the glasshouse leans in they stick out under the roof edge.
- Measure the glasshouse height along the car near the centreline (sample the glass and roof
  triangles, 0.1 m bins) and scale each seatback so the headrest top clears it by 7 cm. Fastbacks
  otherwise grow headrests through the rear roof.

### Driver at the wheel (with a skinned character kit)
- Seat the driver at the car's eye and seat points, facing +x, reclined about .22 rad.
- Scale them so the eyes land at the car's eye point (compact cabins: about .74 to 1.0). The head must clear the roof.
- Solve each arm by coordinate descent (shoulder x/y/z and elbow) so the wrist lands on the rim at the left and right grips. Solve each leg (hip x/z and knee) so the ankle lands on the floor at the pedals.
- Cache three steering variants (left lock, straight, right lock) and blend them by the car's steer value every frame.
- Real characters only in the nearest six cars. Everyone else keeps the cheap built-in driver mesh.
- Full detail only when the camera can see a face: within about 3.5 m (the cockpit) for the
  player's car, 5 m for others. Behind the car in the chase view the lighter body reads the same
  and costs about a quarter of the triangles.

## Defects found and fixed (check for each of these)
- **Hood deleted with the cabin lid.** Some authored bodies model hood and cabin lid as one long
  flat triangle. Removing upward faces inside the cabin by centroid took the hood with it. Clip
  spanning triangles at the windscreen line instead of dropping them.
- **Saw-tooth teeth round the back glass.** Dark backing panels behind glass were removed by
  centroid only, so fan triangles across the glass edge stayed as teeth. On end-facing panels, also
  test points 70% of the way from the centroid toward each corner.
- **Z-fighting trim on paint.** Give the trim material a polygon offset (factor -1, units -2).
- **Pale crescent over the wheels.** Paint faces inside the arch that face the tyre (within
  radius + .16 of the axle, not low, near the body side, normal toward the axle) are the liner:
  paint them 0x1a1b1d.
- **One black flank on tall bodies.** Side texture coordinates above the reference height ran into
  the neighbouring band's dark rocker stripe. Clamp each region's v to its own band.
- **Tyres standing proud of the arches.** The track was pushed out to `wid/2 - .07`. Tuck them in.
- **Matte paint and white-plastic chrome.** Fixed by the surface shader and the chrome split.
- **Motorcycle as boxes.** Rebuild it from parts:
  - running gear: a raked chrome fork, frame tubes, and a V-twin (finned cylinders on a crankcase, primary cover);
  - bodywork: fenders as curved bands, an ellipsoid tank, a batwing fairing with a raked glass screen;
  - the rest: a chrome exhaust with a flared tip, seat and back, saddlebags with lids, crash bars, and police lights on a rear pole and the crash bars.

  Keep the emergency light elements where the new geometry is: stale positions float in the air.
- **Windows at floor level** (a lid at window height inside the cabin). Remove upward faces at the
  beltline inside the cabin volume, using the clipping above.
- **Cars still boxy after every material pass.** The silhouette was the problem: add the body-shape
  warp. Ask the player which vehicles still read wrong; "Jeeps make sense but not the rest" is
  exactly the per-type amount table.
- **A flat glass shelf sticking out under the roof.** It was three things at once: the glass
  solid's lid, a flat headliner sized from the beltline, and sun visors placed from the side-window
  corners. Strip the lids, and fit the liner and visors to the roof skin.
- **A grey slab under a glass roof.** The cabin found no painted roof, fell back to a flat liner
  and visors at beltline width, and they showed through the glass. Treat the glass roof as the
  roof skin.
- **Headrests through the roof** of coupes and fastbacks: fit the seatbacks to the measured
  glasshouse height.

## Audit (every change)
1. **Studio harness.** Load a debug build that exposes an eval hook and the game state. Park
   vehicles 20 m apart on open ground with the HUD hidden. Render each from front three-quarter,
   rear three-quarter, side and high three-quarter (fov about 34) into PNGs. Build contact sheets:
   one row per vehicle, one column per view, labelled. The high three-quarter, looking down at the
   roof and windscreen header, is where ledges and poking headrests show.
2. **Full fleet.** Cover every civilian body and every police body or livery in 16-up sheets. Large
   vehicles (box trucks, buses, semis) need their own camera distances.
3. **Close-ups.** Wheels at hub height (about 2 m off the side), lamps and grilles (about 3 m off
   the corner, fov 30), the cabin through the side glass, and the driver seated through both front
   windows.
4. **Night.** Set the clock to 23:00 with the world night factor at 1, and look at a rear
   three-quarter with lamps on and a top-down beam shot.
5. **Distance.** Update the LOD objects with the camera and shoot from 30 to 40 m with a long lens
   (fov about 7). The distant model should match the near one, light wheels included.
6. **Diagnose with a raycast, don't guess.** Pick the pixel and report material type, transparency,
   side, base colour, map, face normal and hit distance. Skip invisible objects: the raycaster
   still hits hidden LOD meshes. A front-facing paint hit that renders black means the UVs are
   landing on a dark texel. Coplanar hits from two materials mean z-fighting.
7. **Find a mystery part by elimination.** Render with the transparent materials hidden, then hide
   each mesh of the car in turn and diff a small pixel window over the defect: the mesh whose
   removal changes it is the culprit (the visor ledge turned out to be the cabin mesh, not glass).
8. **Before and after.** For any warp or cleanup, render the same view with it on and off side by
   side: it tells you whether the defect is yours or was already in the models.
9. **Regression.** A short scripted drive (2,400 frames) and a 12,000-frame random-input stress
   test, both reporting zero errors and no NaN positions. Then the ES5, ASCII and console checks.
10. **Score honestly.** Name what is still short of 9/10 rather than calling it done. After all the
   passes above, Cypress Falls' fleet scored about 7/10: paint, reflections, wheels, lamps and
   liveries are there; what holds it back is low-poly bodies with visible facets, rough glass and
   pillars, and box interiors close up. Those need properly sculpted bodies per model, not polish.

## Using this skill in Salt and Velvet (Port Halcyon, 1959)
Salt and Velvet's cars live in `34_carmodel.js` (bodies) and `35_vehicle.js` (driving, fleet),
assembled into `index.html` by `build.py` with headless jsdom tests. Follow that game's own code
rules and tests, not Cypress Falls' ES5 list. The bodies are built differently from Cypress Falls'
authored meshes: a side profile with the wheel arches cut out, extruded across the width with a
bevel, a glass cabin with a painted roof and pillars, all non-indexed and vertex-coloured into
one mesh per car, with z forward, y up and x right (Cypress Falls runs x forward). The body types
are `prewar` (a '41 coupe), `fifties` (a '56 sedan), `flagship` (a '59 hardtop), `wagon`,
`pickup`, `van`, `compact` and `truck`.

### Port the stack to these bodies
1. **Split the one mesh by material** before anything else: paint (and a second paint for
   two-tone), glass, chrome, dark trim, tyres, lamp lenses. Every technique above needs its own
   material per group; vertex colour can stay within a group.
2. **Surface shader** as above, with the AO driven by `vCarP.y` (the bodies already sit on y = 0).
   1959 paint is enamel and lacquer, not clearcoat: paint at Fresnel max about .6 and coat about
   .7. Chrome is the star of the era, so give it the full chrome row and the environment map.
3. **Body-shape warp** with the axes swapped (u runs along z). Profiles extruded straight across
   leave slab sides with square ends in plan: that is the shoebox. A 1959 car is slab-sided on
   purpose, so keep the amounts low: `flagship` and `fifties` about .35 to .5 (round the plan
   corners and a little tumblehome, almost no taper), `wagon` .35, `compact` .5, `prewar` .6 for
   the body tub (its pontoon fenders and fastback already curve), `pickup`, `van` and `truck` .2.
   Never warp the fins: mask them out by height and position.
4. **Cabins and drivers** as above, fitted to the roof after any warp.
5. **LOD, audit and honest scoring** apply as written; add the jsdom tests to the regression step.

### What is period-correct (check every car against this)
- **Wheels:** steel wheels with full chrome hubcaps (plain dish, ribbed, or spinner) or small
  "dog-dish" caps on base and police cars; 14 and 15 inch, tall sidewalls; wide whitewall bands
  (6 to 8 cm) on most private cars, blackwalls on trucks and police. No alloys anywhere: replace
  the alloy styles with hubcap styles (a shallow chrome lathe dish, a raised centre, ribs or
  spinner blades, and a dark ring of steel wheel showing at the rim).
- **Lamps:** round sealed-beam headlamps in chrome bezels with hooded visors (quad lamps on '58
  and '59 cars, singles before), round parking lamps; tail lamps as round or bullet lenses with
  concentric ring texture (no LED bands), the '59 flagship's twin bullets set in the fins.
  Incandescent warmth at night: headlamps a warm yellow-white, nothing blue.
- **Chrome:** massive wraparound bumpers (with bullet guards on the big cars), full-width grilles
  (egg-crate or bars), side spears dividing two-tone paint, window frames and drip rails, fin
  trim, hood ornaments and script badges. It should be the brightest thing on the street.
- **Paint:** solids and two-tones (roof and body, or split along the side spear) in period colours:
  turquoise, seafoam, coral, sun yellow, cream, pink, two-tone black and white, plus plenty of
  black, grey and dark green on older and working cars. Workaday cars are a little dusty and dull.
- **Glass:** wraparound windscreens with dogleg A-pillars on '55 to '59 cars, thin pillars,
  pillarless hardtops on the flagship, split flat windscreens on the prewar coupe.
- **Cabins:** bench seats front and rear, no headrests, a big thin steering wheel with a chrome
  horn ring, a painted metal dash with round dials, a column shifter. Drivers sit upright with
  hands on a large rim.
- **Police (Port Halcyon PD, 1959):** dark or black-and-white sedans, a single red rotating beacon
  on the roof (or none), a siren on the front fender, a spotlight on the A-pillar, "POLICE" door
  lettering and the city seal. No light bars, no push bars, no reflective stripes.
- **Trucks and vans:** rounded cabs, separate fenders and running boards on older ones, painted
  steel bumpers on working trucks, stake beds and canvas covers.

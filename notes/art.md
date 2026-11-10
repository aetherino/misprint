# ART / RENDERING — notes

## What it is
"A first-person shooter printed on a risograph, slightly out of register." Everything is procedural
(shaders, canvas textures, primitive geometry). WebGL2 `WebGLRenderer`, three r187, no addons used.

## Files (public/js/render/)
| file | role |
|---|---|
| `index.js` | entry + contract (`createRenderer`), frame orchestration, camera shake, quality |
| `common.js` | shared theme uniforms, GLSL print library (world-anchored halftone/hatch with LOD), material factory, fonts |
| `post.js` | offscreen "plates" (MRT + depth) and the single composite pass: outlines, misregistration, grain, overlays |
| `world.js` | map boxes -> 3 merged meshes (boxes / floor / typographic walls) + jump pads, baked sun shadow map, floor contact-AO, wall typography atlas |
| `sky.js` | direction-space sky: halftone gradient + sun, cut-paper clouds, registration marks |
| `geo.js`, `rig.js` | primitive modelling kit + matrix-palette "rig" shader (body / ink-rim hull / ghost) |
| `models.js` | 4 office-supply weapons + mitten hands (shared by 3rd and 1st person) |
| `characters.js`, `faces.js` | PRINT-HEADS, procedural animation, CRT pixel faces, name tags, blob shadows |
| `viewmodel.js` | first-person rig: sway/bob/tilt/kick, per-weapon reloads, swap, muzzle burst, `muzzleWorld` |
| `decals.js` | 600 pooled instanced ink splats (face-clipped, drips), `burst` paints all nearby faces |
| `fx.js` | pooled GPU-animated particles, tracers, rings/shockwaves, projectiles |
| `pickups.js` | health bottle / overprint target, halo, watermark when inactive |
Harness: `public/dev/art.html` (params documented at the top of the file).

## Pipeline (2 screen-sized passes)
1. World + characters + fx, then the viewmodel (own scene/camera FOV 60) are drawn into ONE target with two
   colour attachments + depth texture:
   - attachment 0 "colour plate": rgb ink colour, a = 1 if the pixel belongs to spot plate B
   - attachment 1 "line plate": rgb = world normal, a = dark line-ink coverage (hatch, dots, black fills, type)
   The depth range is split in the vertex shaders (`placeDepth`): world uses window depth [0.1,1], the viewmodel
   [0,0.1] — so the gun never clips walls yet shares outlines/misregistration with the world, with no extra pass.
2. `post.js` composite to screen: ink outlines from depth-Laplacian (on 1/z, exact zero on planes) + normal
   differences; line plate sampled in register, colour plate A and plate B sampled at two different offsets that
   grow toward the screen edges (≈0.4 px at the crosshair, ≈4 px in corners at 1080p) with slow wobble; plate gaps
   show bare paper and B overprints A (multiply). Then paper tooth/fibres, ink mottle + "salt", and overlays:
   damage/low-hp red halftone vignette, heal, overprint gold screen, rewind paper-feed tear, kill frame,
   speed lines, localized two-tone "impact frame" for deaths, transient misregistration kick.
Patterns: halftone/hatch are triplanar in WORLD space (object space for rigs). Period follows log2(distance)
octaves (cross-faded), LOD depends on camera position only => no swimming on mouselook. Patterns too fine to
resolve (grazing floors) fall back to their flat average tint. Screen-space dots only in sky/overlays/short fx.
Lighting: fixed sun; tone bands per face + a sun shadow map baked ONCE per `buildWorld` (static geometry, 1 PCF
tap at runtime) + floor contact-AO texture (CPU-baked) + AO gradient at box bases; characters get halftone blob shadows.
Colour: display-referred sRGB end to end (no colour management in shaders).

## Perf numbers (harness, 8 characters, pickups, fx running; SwiftShader so fps is meaningless)
- draw calls: 56–58 at every quality; triangles ≈ 47k (≈ 4.4k per character ×3 meshes; world ≈ 1.5k)
- quality 0: target at 0.8× res, pixel ratio 1, 1024 shadow map, cheaper edge taps, single colour tap
- quality 1 (default): pixel ratio ≤ 1.5, 2048 shadow map; composite = 5 depth + 5 line + 2 colour + 1 grain taps
- quality 2: pixel ratio ≤ 2, 4× MSAA on the plates
- rebuild ×10 (`?test=rebuild`): geometries 17 -> 17, textures 21 -> 21, programs 20 -> 20 (no growth)
- no three warnings / shader errors at q0/q1/q2 (`?test=perf`). No per-frame allocations in the render path
  (fx/decals are ring buffers with partial uploads; particles animate on the GPU from a birth time).
NOT measured on a real GPU — please sanity-check fps on an integrated laptop; cheapest knobs if needed:
`PIXEL_RATIO_CAP`/`TARGET_SCALE` in index.js, `MAX` in decals.js.

## Contract
All stub names/signatures kept. Notes for the engine:
- `resize(w,h)` takes CSS pixels (pixel ratio handled inside per quality).
- `render()` calls `camera.updateProjectionMatrix()` itself; shake never leaks into the engine's camera pose.
- `fx.death(pos, …)` expects the FEET position (burst is centred 0.9 m above); `fx.hitPlayer` the hit point.
- `fx.tracer(…, weaponId 3)` is a no-op (Blotter uses `projectile.*`).
- `time` passed to `render` must be monotonic; fx spawned between frames use the last frame's time.
- Anything added to `R.scene` with stock three materials will not write the line plate correctly; use
  `inkMaterial` from common.js if the engine ever needs debug geometry.
Optional additions: `R.advance(dt,time)` (timers without drawing; `render = advance + draw`),
`R.stats()` → `{calls,triangles,geometries,textures,programs,decals}`, `R.renderer`.

## Screenshots (shots/art-*.png)
fp-theme0..4, vm{0..3}-{idle,fire,reload}, char-{front,side,crouch,ghost,bighead}, splats, explosion, death,
pickups (dais + jump of sky marks), sky, top, q0.

## Known issues / gaps
- Not profiled on real hardware (see above).
- Death "impact frame" is subtle and short (0.13 s); overprint pickup reads mostly through its gold halo —
  the target itself is small/dark at range. Ghost is ~10–15 % visible, hard to capture in stills.
- Blended fx (rings, particles, tracers) do not hide the composite outlines of geometry behind them.
- Splat edges on heavily layered spots look soft; a true MIN "overprint" blend was tried and dropped (mud).
- Decals clip to one box face: splats do not continue across coplanar neighbouring boxes.
- Shadows are baked from boxes only (jump pads/characters do not cast); characters are not shadowed by the world.
- Typographic walls: up to 4 big inward-facing `wall` faces (≥ 60 % of arena size, ≥ 5 m tall); others use the generic style.
- Unknown `kind`s render by tone only; `solid:false` boxes render like any box.
- models.js builders are formatted compactly (body/mover object literals) — functional, could be prettier.
- QUALITY 2 MSAA path compiled and rendered in the harness but was not visually reviewed.

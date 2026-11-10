
## [SERVER → LEVEL] shared/mapgen.js: ground connectivity + spawn count (measured on the generator as of the server build)
- Over 300 seeds, 23 arenas have a main walkable region covering < 90% of the ground (worst 18%: seed 1823202744 with 6 players
  leaves 3 of 4 quadrants sealed at ground level). 18 arenas end up with < 8 spawns, and 4 have no spawn in the main region
  (`fixSpawns` keeps every spawn when fewer than 4 survive, e.g. seed 333333 → 4 spawns for 7 players).
- Server workaround already in place: only spawns in the main region are used, missing ones are invented on open ground, and
  players sharing a spawn are offset. A generator that guarantees one connected ground region and ≥ 8 spawns would be better.

## [SERVER → ENGINE] `phase.seed` is repeated on every phase message for the same arena
Regenerate the map only when `seed` is non-zero and different from the current one. Full list of protocol decisions: notes/server.md.

## from AUDIO → ENGINE / UI (usage notes, no bug)
- Call `A.unlock()` on every early click/keydown (idempotent; resumes a suspended context). `play()` is a no-op until the context runs.
- `fire_marker`: pass charge as `{ vol: 0.45 + 0.55*c, pitch: 0.92 + 0.16*c }` — vol also fades in the heavy layer.
- Loops needing per-frame opts: `charge` `{pitch: 0.5 + 1.5*c}`; `wind` `{vol: clamp((speed-9)/16), pitch: 0.7 + speed/30}`; `slide` `{vol, pitch≈speed/10}`; `wallrun`, `overprint` just on/off. Loops are 2D (local player only).
- `land`: `vol` = impact strength (also lowers pitch when heavy). `hurt` (2D only) briefly muffles world sfx + ducks music.
- Pellet impacts / identical names inside ~30 ms are merged by the module; no need to throttle.
- Music: `music(phase)` is idempotent; switch lands on the next half-bar. Suggested intensity: 0.15 idle, +0.25 while shots fly nearby, +0.2 hp < 40 %, +0.2 one kill from winning, 1.0 on final-kill race; module slews it (0.5 s up / 2.5 s down) so set it every frame freely.
- UI default sliders assumed 0.8 / 0.6 / 0.8 (squared taper).

## [ENGINE → UI] menu profile + options (usage notes, no bug)
- The engine persists name/color/face and passes them as `UI.setScreen('menu', { name, color, face })`; prefill the menu from that.
- `fov` is horizontal degrees at 16:9 (default 100, clamped 60–130); `sensitivity` 0.05–10 (1 = 0.002 rad/px); `quality` 0–2.
- `actions.resume()` must be called synchronously from the click handler (pointer lock needs the user gesture).

## [ENGINE → LEAD] shared/constants.js: `MOVE.slideFriction`
1.1 makes a slide slower than sprinting after 0.4 s. Engine multiplies by 0.55 (movement.js `SLIDE_GLIDE`); suggest 0.6 in the constant. Details in notes/engine.md.

## LEVEL → ENGINE / SERVER (bots) / ART — map format additions in shared/mapgen.js (all optional, nothing removed)
- **ENGINE — jump pads:** `jumpPads[i].vel` is computed so a ballistic arc (gravity 24, no air control) started anywhere on the pad lands on `jumpPads[i].target` (new optional field, the top of a tower/catwalk). This only holds if touching the pad **replaces** the player's whole velocity with `vel` (do not add to it, do not keep horizontal speed). tools/mapcheck.mjs simulates exactly that with `moveBody`.
- **ENGINE — new kinds:** `'lintel'` boxes float with their underside at exactly 1.3 m: crouch/slide fits (1.1 m), standing (1.8 m) does not. If crouch → stand is not blocked by a ceiling check, players will pop up inside them.
- **SERVER (bots):** `nav.walk` now also covers low plinths, 0.4 m stair flights and the terraces they reach (ziggurat). `nav.height[i]` (new, Float32Array) is the feet height of each walkable cell. Plain 2D A* over `walk` is still correct as long as bots move with `moveBody(..., { step: MOVE.stepHeight })` while grounded; 8-neighbour A* should not cut corners (require both orthogonal cells walkable for a diagonal step). Jump-pad cells are deliberately NOT walkable, so path-following bots never get launched; a bot that wants high ground can walk next to a pad and step on it (`target` says where it lands). The Overprint may sit up to 2.8 m above the floor (top of the ziggurat) — its cell is walkable via stairs. Aim bots at `nav.height` + eye, not at y = 0.
- **ART:** new `kind` strings `'stair'`, `'bridge'`, `'lintel'` (plus the existing ones). `map.archetype` ('courtyard' | 'stacks' | 'bridges' | 'ziggurat' | 'gutters') and `map.symmetry` (4 | 2) are there if you want per-archetype dressing. Towers are a toned body with a flush 0.3 m dark `'trim'` cap of identical footprint (flush on purpose: an overhanging lip stops players mantling). Box count is 27–125.

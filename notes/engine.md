# ENGINE — client game hub (public/js/*.js)

## Module map
| file | role |
|---|---|
| `main.js` | entry: boots R / A / UI, `actions`, resize, key + pointer-lock policy, rAF loop, URL params |
| `game.js` | the hub: shared context `G`, frame update (input → fixed steps → remotes → camera → weapons → audio/view/HUD), join/leave/reset |
| `net.js` | WebSocket (JSON), ping, server-clock estimate (`serverNow()`); `?offline=1` swaps in `offline.js` |
| `offline.js` | in-browser fake server = hidden practice range (3 dummies, damage, respawns, pickups; `&seed=`, `&cards=a,b`) |
| `input.js` | keyboard/mouse/pointer lock → one reusable per-frame snapshot (`pressed` catches sub-frame taps); virtual keys for automation |
| `settings.js` | options + profile in localStorage (sanitized) |
| `movement.js` | local body controller on shared `moveBody` (pure sim, emits events) |
| `rewind.js` | 3 s / 20 Hz history ring + 0.25 s backwards sweep + cooldown |
| `camera.js` | camera rig: first person feel layers, death cam, spectator orbit |
| `player.js` | local player glue: look, step, flags, `st` upload, pickups, spawn/die, movement-event sounds + `ev` relays |
| `weapons.js` | swap / mags / reload / fire timing / Marker charge / spread+bloom / recoil / self-knock |
| `combat.js` | hit tracing (world + head sphere + body AABB + ricochets), shot drawing, explosions + knockback |
| `projectiles.js` | Blotter bombs (mine + relayed) via shared `stepProjectile` |
| `remote.js` | roster→renderer diffing, snapshot buffer, interpolation/extrapolation, remote footsteps |
| `flow.js` | roster, arena builds, phase transitions, countdown, draft |
| `messages.js` | server message handlers (hit/kill/heal/saved/pk/buff/spawn/ev/chat/fire/proj/boom/snap) |
| `announcer.js` | announcer copy + rarity rules |
| `hud.js` | per-frame `UI.setHud` payload (one reused object) |
| `debug.js` | `window.__mp` |
| `util.js` | math helpers |

## How things work (short)
- **Timing**: frame dt capped at 0.25 s; simulation runs in fixed 1/120 s steps (accumulator, camera interpolates between the last two steps). Gravity is applied as two half-steps around `moveBody` so parabolas are exact (jump apex = v²/2g to the millimetre). Visual springs use dt ≤ 1/30.
- **Movement**: Quake ground friction/accel + air accel (wish capped at `airWishSpeed`), coyote + jump buffer, air jumps (steerable), crouch with headroom check, slide (boost capped at run+boost, glide friction, steering, slide-hop), dash (charges, flat on ground / aimed in air, keeps ≥1.25× run speed after), wall-run (contact OR wall within 0.15 m while steering into it; head-height wall required; gravity `wallrunGravity`, fades back in the last 0.35 s; same wall locked 1.5 s or until landing; wall-jump with 0.14 s grace), jump pads, impulses (punch / blast), Paper Jam slow ×0.55, kill plane → `fell`.
- **Camera**: eye-height easing, step-up smoothing from `stepped`, landing dip spring, head bob tied to stride, strafe roll, wall-run roll, FOV kick (speed, dash, rewind), recoil kick. Shots are cast from the pose on screen (aim + recoil kick), so what you see is what you hit.
- **Weapons**: per-weapon cooldowns (swap cannot skip them), exact full-auto rate at any fps (sub-frame lag carried), semi-autos fire once per click (held click or 0.18 s buffer), auto-reload 0.25 s after the last round. One `fire` message per trigger pull. My hitscan player hits splat immediately (prediction); the server `hit` only adds the hitmarker.
- **Remotes**: rendered 100 ms behind the freshest snapshot, angle-aware yaw lerp, ≤150 ms dead reckoning, teleport guard (spawn/rewind/10 m jumps). A snap row means "alive"; `kill` means dead.
- **Pointer**: lock on first click / `actions.resume`; user unlock in the arena = pause; draft/lobby unlock programmatically (so re-lock at the next countdown needs no click in Chrome).

## Debug API (`?debug=1`, never takes pointer lock)
`__mp = { G, state, R, A, UI, net, actions, input(keys), look(yaw,pitch), aimAt(id), weapon(i), tp([x,y,z]), hold(on), advance(frameDt, frames), info() }`
- `hold()` + `advance()` drive the game clock by hand (deterministic, fps-independent tests).
- `info()` adds to the brief: `speed, apex, lastApex, lastDash, ammoAll, wallrun, sliding, dashCharges, rewindCooldown, camera, projectiles, nan, …`.
- `?auto=<name>[&color=n&face=n]`, `?offline=1[&seed=n&cards=a,b]`. `public/dev/engine.html` = practice range + live speed graph (uses `?bench=1`, read-only `window.__bench`).

## Tests
`node tools/enginetest.mjs [offline|online|all] [--port 3102] [--stubs] [--shots]` (starts/stops its own servers; exit 1 on failure).
`--stubs` serves recording stand-ins for render/audio/UI (`tools/enginetest-stub-*.mjs`): engine in isolation, no WebGL, ~40 s for everything. Without it the real modules are used (SwiftShader, several minutes).
84 checks: 62 offline (movement numbers, frame-rate independence, weapons, range combat) + 22 online (2 pages + late joiner + 2 bots: lobby/settings/chat, kill flow on both sides, respawn, interpolation, roundEnd, draft, new arena, matchEnd, lobby, disconnect → error → menu, zero console/page errors).

## Deviations / extensions of the brief or contracts
1. Frame dt cap is 0.25 s, not 1/30: with a 1/30 cap anyone under 30 fps would play in slow motion relative to the server. Fixed 1/120 steps keep physics identical (tested 10/30/60/144 fps → 0 m deviation).
2. Wall-run camera rolls AWAY from the wall (genre convention). One constant: `WALL_ROLL` sign in camera.js.
3. Rewind restores position + velocity, not yaw/pitch (keeping your aim is better in a fight); history stores pos/vel only.
4. `fov` option = horizontal FOV on a 16:9 screen (100 → 67.7° vertical), Hor+ on wider windows.
5. Crouched/sliding targets: head sphere is lowered with the hull (top − 0.24·scale). Standing = spec formula.
6. `UI.setScreen('menu', { name, color, face })` passes the saved profile (optional data).
7. `__mp.actions`, `hold/advance`, `G` are additions. `?bench=1` is new.
8. Pickup requests for health are skipped at full HP (server refuses them anyway).
9. Slide friction is `MOVE.slideFriction × 0.55` (see below).

## Constant / tuning notes (shared/constants.js is not mine)
- `MOVE.slideFriction: 1.1` read as a Quake friction coefficient ends a slide in 0.76 s and drops below sprint speed after 0.4 s. I apply ×0.55 (`SLIDE_GLIDE`): 1.4 s / ~12 m slides. Suggest setting the constant to 0.6 and deleting the multiplier.
- Blotter `bounces: 1` means a bomb shot at your own feet bounces away and bursts overhead — blast-jumping needs a second surface (floor at the foot of a wall). Fine, but worth knowing.
- Jump + straight-down Hole Punch stacks to ~17 m/s (≈6 m). Fun; lower `selfKnock` if it breaks maps.

## Known issues / not verified
- Real mouse / pointer-lock path cannot be exercised headless (logic is covered through virtual input only). Feel was tuned by numbers, not by hand.
- Camera can clip a low ceiling for ~0.1 s when sliding under it (eye height eases instead of snapping).
- Respawn countdown on the HUD uses `TIMING.respawn`; under `--fast` the server respawns sooner than shown.
- Remote players' overprint state is not shown (no renderer hook for it).

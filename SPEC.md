# MISPRINT — build spec (read fully before writing code)

A LAN-hosted, browser-based multiplayer **movement shooter printed on a risograph**.
One person runs `node server.js`; friends open `http://<host-ip>:3000` in a browser. No accounts, no build step, no asset files.

## 1. The pitch (what makes it fresh)

| Ingredient | Borrowed from | Our twist |
|---|---|---|
| Fast movement: slide, double-jump, dash, wall-run | Titanfall / modern "movement shooters" | Hole Punch shotgun kicks you backwards → punch-jumps |
| Short rounds, losers draft a mutation card, builds stack all match | ROUNDS / STRAFTAT / roguelike deckbuilders | Cards are print-shop "ERRATA"; the round winner prints nothing (catch-up) |
| Time rewind | Recall-style abilities | Everyone has **Rewind** (Q): snap back 3 s in position and HP |
| Paint the map | Splatoon | Every shot leaves an ink splat in the shooter's color; kills are big splats. The arena ends each round looking like a ruined print |
| Goofy characters for friends | "friendslop" co-op games | Players are **PRINT-HEADS**: chunky little bots with a CRT face that reacts |
| Procedural everything | — | Arena is regenerated from a seed every round ("reprinted"); all textures are shaders/canvas; all audio is synthesized |

**Art direction: RISOGRAPH ZINE.** Cream paper, near-black ink line work, two fluorescent spot inks per arena, halftone dot shading, visible misregistration (color layer slightly offset from the line layer — the "misprint"), paper grain, crop marks, registration targets (⊕), CMYK color bars, giant page-number typography on walls. NOT neon/synthwave, NOT realistic, NOT purple-gradient "AI default".
Weapons are office supplies (stapler, hole punch, marker, ink blotter). Copy/voice: dry print-shop humor ("NOW PRINTING", "FIRST DRAFT", "OUT OF INK", "RETURN TO SENDER").

## 2. Game rules

- **Match** = rounds. A **round** is free-for-all deathmatch with respawns (2.5 s) on a freshly generated arena. First to `killsToWin` (default 8) wins the round; at the buzzer (`roundTime`, default 150 s) most kills wins (ties → fewest deaths → earliest to reach the score).
- After each round: `roundEnd` podium (6 s) → `draft` (16 s): everyone **except the round winner** picks 1 of 3 Errata cards (auto-pick random on timeout; bots pick randomly). Cards stack for the whole match.
- First to `roundsToWin` (default 3) round wins takes the match → `matchEnd` (12 s) → back to lobby (cards and wins reset).
- Phases: `lobby → countdown(4s, spawned but frozen) → playing → roundEnd → draft → countdown → … → matchEnd → lobby`.
- Joining mid-match is fine: you spawn on the next respawn. If all humans leave, the server resets to lobby.
- **Host** = first human to join (reassigned if they leave). Host edits match settings and starts.
- **Bots** (0–6, setting) fill the lobby so 1–2 friends still get a real match. They live on the server.

### Loadout (everyone has all four, keys 1–4 / mouse wheel) — see `shared/weapons.js`
1. **STAPLER** full-auto hitscan. 2. **HOLE PUNCH** 9-pellet shotgun with self-knockback. 3. **MARKER** hold-to-charge rail shot that leaves a drawn line. 4. **BLOTTER** bouncing ink bomb with splash.
Magazines + reload (R), infinite reserve.

### Movement (constants in `shared/constants.js` → `MOVE`)
WASD, Space jump (+ air jumps), C crouch → **slide** when moving fast, Shift **dash** (charges), run along a wall while airborne to **wall-run**, jump off it to wall-jump, Q **Rewind**, jump pads, Quake-style air-strafing.

### Pickups (server-authoritative; positions in the map)
`health` (+50 HP, 14 s respawn), `overprint` (center dais: double damage for 10 s, 40 s respawn, announced to everyone).

### Cards — see `shared/cards.js` (26 cards, `computeStats(cardIds)` → stats object used by server + clients).

## 3. Architecture + file ownership

```
server.js, server/**          SERVER agent     node http static + ws, game authority, bots
public/js/*.js (top level)    ENGINE agent     main.js (entry), net, input, movement, weapons, remote players
public/js/render/**           ART agent        three.js world, characters, viewmodels, post fx, decals, vfx
public/js/audio/**            AUDIO agent      WebAudio synth sfx + generative music
public/index.html, public/css/**, public/js/ui/**   UI agent   menu, lobby, HUD, draft, scoreboard
shared/mapgen.js, tools/mapcheck*   LEVEL agent     arena generator quality
shared/* (other), SPEC.md, tools/static.mjs, tools/shot.mjs   LEAD (do not edit; request changes in notes)
public/dev/<yourname>*.html   each agent's standalone demo/test pages
notes/<agent>.md              each agent's final report: what was built, deviations, known issues, how to test
notes/issues.md               APPEND-ONLY: bugs/requests about files you do not own
```

**Rules for every agent**
- Only edit files you own. Need a change elsewhere? Append to `notes/issues.md` and work around it.
- The stub files `public/js/{render,audio,ui}/index.js` ARE the interface contract. Keep every exported name/signature. Additions are fine if optional and documented.
- Plain ES modules, no build step, no TypeScript, no new npm dependencies. Browser code imports three via the import map (`import * as THREE from 'three'`, addons from `three/addons/...` — vendored under `public/vendor/addons/{postprocessing,shaders,utils,math}`), shared code via absolute URLs (`/shared/constants.js`). Server imports `./shared/...`.
- No network assets (no CDNs, no Google Fonts). Fonts are vendored in `public/fonts/` (woff2): `dela-gothic-one-latin-400-normal`, `archivo-black-latin-400-normal`, `archivo-narrow-latin-500-normal`, `archivo-narrow-latin-700-normal`, `dm-mono-latin-400-normal`, `dm-mono-latin-500-normal`, `permanent-marker-latin-400-normal`.
- Friends connect over plain **http to a LAN IP = NOT a secure context**. Do not use `crypto.randomUUID`, `navigator.clipboard` (without a fallback), service workers, or anything else gated on secure contexts. Pointer lock, WebAudio, WebGL2, WebSocket and localStorage are fine.
- Must run at 60 fps on a mid laptop with integrated graphics at quality 1; target Chrome/Edge/Firefox/Safari current versions.
- Coordinates: meters, Y up, yaw 0 faces −Z, positive yaw turns left; `yawPitchToDir` in constants. Player `pos` = feet.
- Testing: `node tools/static.mjs <port>` serves the client without game logic; `node tools/shot.mjs <url> <png> [--wait ms] [--eval js] [--after ms] [--size WxH]` screenshots a page in headless Chrome and prints console output/errors. **Look at your screenshots** (Read the PNG) and iterate — do not ship unseen visuals. Headless WebGL is software-rendered (slow); judge looks, not fps. Save screenshots under `shots/<agent>-*.png`.
- Use your assigned port only (in your brief). Kill servers you start.
- Write code you would be proud to sign: small focused modules, no dead code, comments only where the why is non-obvious.

## 4. Network protocol (JSON over one WebSocket at `ws://<host>/ws`)

Every message is an object with a type field `t`. Positions/vectors are arrays rounded to 2–3 decimals. Server time is `Date.now()` ms; clients estimate offset from `welcome.now`/`pong.s`.

### Client → server
| t | fields | notes |
|---|---|---|
| `hello` | `v, name, color, face` | first message. name ≤ 14 chars (server sanitizes, dedupes). color = ink index, face = face index |
| `profile` | `name, color, face` | any time |
| `settings` | `settings` (partial DEFAULT_SETTINGS) | host only, lobby only |
| `start` | | host only, lobby only |
| `st` | `p:[x,y,z], yaw, pitch, v:[vx,vy,vz], f, w` | 20 Hz while alive. `f` = flag bits `F`, `w` = weapon id |
| `fire` | `w, o:[x,y,z], c, hits:[{ e:[x,y,z], n:[x,y,z]\|null, id:targetId\|null, hs:0\|1, via?:[[x,y,z]…] }]` | one entry per pellet. `o` = muzzle/eye origin, `c` = charge 0..1, `e` = end point, `n` = surface normal (null if it hit a player or nothing), `via` = ricochet points in order. Client does hit detection (shooter-favored); server validates + applies damage |
| `proj` | `pid, o, vel` | Blotter bomb launched. `pid` = per-client counter. Everyone simulates the same bounce path with `stepProjectile` |
| `boom` | `pid, p:[x,y,z], hits:[{ id, d }]` | shooter's bomb exploded at `p`; players within radius with distance `d` (may include self) |
| `pickup` | `id` | touching a pickup |
| `pick` | `card` | draft choice |
| `rewind` | `p:[x,y,z]` | used Rewind (landed at p). Server restores HP to the max of current and HP 3 s ago (full with Recall Notice) |
| `ev` | `k, …` | cosmetic relay to others: `k` ∈ `dash, jump, walljump, land, pad, emote` (+ `p`) |
| `fell` | | fell below `map.killY` → server kills (no killer) |
| `chat` | `text` | ≤ 140 chars |
| `ping` | `c` | client timestamp; server answers `pong` |

### Server → client
| t | fields | notes |
|---|---|---|
| `welcome` | `id, now, v` | followed immediately by `roster` and `phase` (and `spawn`s/`pk` state if a round is live) |
| `roster` | `hostId, joinUrls:[…], settings, players:[{ id, name, color, face, isBot, wins, kills, deaths, ping, cards:[id], alive }]` | broadcast on any roster/score/card/settings change |
| `phase` | `phase, round, now, endsAt, seed, mapPlayers, pickups:[{id,active}], winnerId, standings:[{id,kills,deaths,wins}]` | `seed`+`mapPlayers` → `generateMap(seed, mapPlayers)`; sent with `countdown` (and to late joiners). `endsAt` = server ms when the phase ends (0 in lobby). `winnerId`/`standings` on roundEnd + matchEnd |
| `snap` | `now, ps:[[id, x, y, z, yaw, pitch, flags, weapon, hp], …]` | 20 Hz, all living players incl. bots and you (use your own row only for hp) |
| `spawn` | `id, p, yaw, hp, protect` | (re)spawn. For self: teleport, reset velocity/ammo. `protect` = seconds of spawn protection |
| `fire` | `id, w, o, c, hits` | relay to everyone except the shooter |
| `proj` | `id, pid, o, vel` | relay (not to shooter) |
| `boom` | `id, pid, p, r` | relay to everyone except the shooter: remove that projectile, show explosion radius `r` |
| `hit` | `from, to, dmg, hp, hs, w, slow, p` | to everyone. `w` −1 = thorns/ink burst. `slow` = seconds (Paper Jam). `p` = hit position |
| `kill` | `killer, victim, w, hs, streak, first, final, burst:{p,r}\|null` | `killer` null = environment. `final` = round-winning kill. Followed by `roster` |
| `heal` | `id, hp, src` | `src` ∈ `pickup, lifesteal, kill, rewind` |
| `saved` | `id` | Second Draft consumed |
| `pk` | `id, active, by` | pickup state change |
| `buff` | `id, type:'overprint', until` | server ms |
| `draft` | `options:[cardId], isWinner` | to each human at draft start |
| `picked` | `id, card` | someone drafted |
| `ev` | `id, k, …` | relayed cosmetic event (also `rewind` with `p`) |
| `chat` | `id, name, color, text` or `system:true, text` | |
| `pong` | `c, s` | |
| `error` | `msg` | then the socket may close (e.g. server full) |

## 5. Client module wiring (engine is the hub)

```
main.js (ENGINE)
  ├─ createRenderer({canvas})        → R   (public/js/render/index.js)
  ├─ createAudio()                   → A   (public/js/audio/index.js)
  ├─ createUI({root, actions, audio})→ UI  (public/js/ui/index.js)
  └─ net (WebSocket) ⇄ server
```
The engine owns: game state, local movement + camera pose (position, rotation, roll tilt, FOV kick), weapon logic and hit detection, interpolation of remote players, and calling R/A/UI with the right data at the right time. R/A/UI never talk to the network or to each other (UI may call `audio.play` for its own clicks).

URL params the engine must support: `?auto=<name>` (skip the menu and join with that name), `&debug=1` (expose `window.__mp` — see ENGINE brief — and run without pointer lock).

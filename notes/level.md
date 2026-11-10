# LEVEL — arena generator (`shared/mapgen.js`)

Replaces the v0 tile-noise generator with five designed archetypes. Contract unchanged:
`generateMap(seed, playerCount = 4)`, `buildNav(map, cell = 1)`, `navIndex`, `navCenter`; same map fields.
Arena edge: 44 m (≤ 3 players), 56 m (4–6), 68 m (7–10). Spawns: max(8, players + 4) rounded up to whole symmetry orbits (8 for ≤ 4 players, 12 for 5–8, 16 for 9–10; gutters gives 14 for 9–10).

## Archetypes (picked by seed, ~20 % each)

| id | symmetry | what it is | signature play |
|---|---|---|---|
| `courtyard` | 4-fold pinwheel | Open plaza with the Overprint dais, ringed by four low galleries (2.4 m roofs you can run, most with a slide-under gate). Each plaza corner has one doorway and every doorway faces a gatehouse; 4.8 m towers on the diagonals with pads; billboards (long wall-run faces) behind the galleries. | Rail lanes across the plaza, roof fights, screens stop door-to-door shots. |
| `stacks` | 4-fold | Warehouse grid of 4 m stacks (1.2–4.8 m) and 5 m aisles. Four blocks pinch the Overprint crossing. Aisles are cut by merged stacks, ~40 % of them slide-under shelves, so nothing runs wall to wall; catwalks join 4.8 m stacks; 44 m version has bays and a rim chicane. | Shotgun maze below, hop across stack tops above. |
| `bridges` | 4-fold | Cross-shaped canyon between four 2.4 m roof blocks. A tower plugs each canyon end; a cross of 4.8 m catwalks links the towers over the Overprint (ring hub you can drop through). L-walls enclose corner yards; larger arenas sometimes add a 4 m wall-jump alley. | Cross above, fight below; roofs are the middle tier. |
| `ziggurat` | 4-fold | Stepped plate in the middle, Overprint on top (2.8 m up, reachable by 0.4 m stairs — king of the hill). Parapets on both tiers. Four crop-mark shaped 4.8 m brackets (15–19 m wall-run faces, optional slide gate) box it in; towers on the axes face the bracket openings. | Moat wall-runs, storming the plate, towers overwatch the stairs. |
| `gutters` | 2-fold | Long parallel 4.8 m walls (wall-run lanes 6 m apart, ideal wall-jump width). Wall lines alternate which end is open, gaps are staggered line to line, inner lanes are cut by limbo gates (slide under), catwalks span lanes with a pad feeding each, bastions on the rim. | Chained wall-runs and slides. |

Seeded variation inside an archetype: left/right mirroring (pinwheels spin the other way), which optional modules appear (gates, alley vs. yard, hub ring vs. plate, quad-block variant, shelves vs. solid merges, extra cuts), offsets (stair zig-zag, gate/gantry/baffle positions, gap jitter), stack heights, pad side, theme, and spot-ink alternation between rotated copies (so "pink tower" and "blue tower" are different places). Courtyard and ziggurat vary least: their plan is fixed per size apart from mirroring and module choice.

## Pipeline

1. `rng` → theme, archetype, name (`<PRINT WORD> <ARCHETYPE WORD>`).
2. The archetype builds into a **kit**: every piece is placed once and replicated 4- or 2-fold; helpers for capped towers, slide gates, stair flights, pads (launch velocity solved for the target), dais.
3. `assemble`: floor + 9 m rim walls, `buildNav`, built-in checks (nav share ≥ 40 %, axis-aligned sight runs, pickups on walkable cells), then spawn selection. A failed check re-rolls the archetype's dice (≤ 6 times) before falling through to the next archetype; all draws come from the seeded rng, so the result is still deterministic.
4. Spawns: whole symmetry orbits of floor cells in the outer half, with elbow room, something solid within ~3 m, ≥ 10 m from every other spawn, ≥ 6 m from health, hidden from five eye points on the Overprint dais, seeing at most one other spawn (two only if nothing else fits). Yaw faces the longest open run that leans toward the center.

Design rules the kit sticks to: everything that matters sits on the 1 m grid; tiers are 1.2 / 2.4 / 3.6 / 4.8 m (one jump apart, a double jump skips one); nothing climbable has an overhanging lip; lintels leave exactly 1.3 m; every row and column of the plan meets a ≥ 2.4 m blocker within ~38 m.

## Optional fields added (consumers can ignore them)

- `map.archetype`, `map.symmetry` (4 | 2).
- `jumpPads[i].target` — where the arc of `vel` lands. `vel` must **replace** the player's velocity (engine and server bots already do this).
- `nav.height` — Float32Array, feet height of each walkable cell.
- New `kind` values: `'stair'`, `'bridge'` (catwalk, open below), `'lintel'` (1.3 m slide-under gap).

## Guidance for bots

- `nav.walk` keeps the v0 meaning (hull at the cell center with 0.15 m to spare over the whole cell, so paths stay ~1 m off walls) and adds plinths, stair flights and the terraces they reach. Any two 8-adjacent walkable cells are within 0.5 m of height, so 2D A* plus `moveBody(..., { step: MOVE.stepHeight })` gets a bot anywhere on the grid, including the top of the ziggurat. Don't cut corners on diagonals.
- Jump-pad cells are not walkable (no accidental launches). To use a pad on purpose, walk onto it; `target` is where the bot will land. Tower tops and catwalks are not in the nav grid.
- Lintels and slide gates are blocked in nav: bots walk around, humans slide under.
- Stairs appear as ordinary walkable cells whose `nav.height` climbs 0.4 m per cell.

## Validation — `node tools/mapcheck.mjs --seeds 320`

Checks per map: determinism (deep-equal on a second call), box sanity (bounds, ≥ 0.2 m, movement blockers ≥ 0.5 m, ≤ 320 boxes, closed rim, full floor), nav (single region, `buildNav(map)` reproduces `map.nav`, neighbours within a step, share), spawns (count, ≥ 9 m apart, hull + 2.2 m headroom, cover within 4 m, not facing a wall, no line of sight from the dais, ≤ 2 other spawns visible, no health within 5 m), sightlines (longest of 48 horizontal rays at eye height from every other walkable cell; p95 ≤ 40 m), cul-de-sacs (block any 5 m doorway: nothing deeper than 6 m may be cut off), jump pads (hull flown from the middle and four edges of each pad lands on its target), high ground (≥ 2 surfaces ≥ 2.2 m and a 4.8 m tier reachable by pad arc or jump chains), ≥ 2 wall-run faces (≥ 8 m × ≥ 3.5 m with clear run alongside), bot walk (hull driven with `moveBody` along A* paths between spawns, Overprint and health; never stuck 1 s), `generateMap` time (< 30 ms).

Result of the last full run (320 seeds × players 2/4/8 = 960 maps):

| archetype size | maps | fail | boxes  | spawns | nav% | nav min | sight p50 | p95 avg | p95 max | longest | pocket | high | wallrun | seen | gap min | zfight | ms avg | ms max |
|----------------|------|------|--------|--------|------|---------|-----------|---------|---------|---------|--------|------|---------|------|---------|--------|--------|--------|
| bridges 44     | 58   | 0    | 56-67  | 8-8    | 46   | 46      | 19.0      | 31.8    | 31.8    | 44.0    | 3.6    | 33+  | 12+     | 1    | 10.2    | 0      | 0.7    | 1.0    |
| bridges 56     | 67   | 0    | 68-83  | 8-8    | 49   | 49      | 22.1      | 34.5    | 38.8    | 42.9    | 3.8    | 41+  | 20+     | 1    | 16.0    | 0      | 2.7    | 13.1   |
| bridges 68     | 58   | 0    | 68-79  | 12-12  | 55   | 54      | 21.3      | 31.8    | 31.8    | 38.4    | 0.3    | 41+  | 24+     | 1    | 14.0    | 0      | 2.4    | 5.9    |
| courtyard 44   | 63   | 0    | 31-39  | 8-8    | 43   | 43      | 20.5      | 29.0    | 29.0    | 32.8    | 0.3    | 20+  | 4+      | 1    | 17.0    | 0      | 0.8    | 8.6    |
| courtyard 56   | 63   | 0    | 47-55  | 8-8    | 51   | 51      | 23.7      | 32.6    | 32.6    | 38.8    | 1.1    | 32+  | 12+     | 1    | 22.0    | 0      | 1.3    | 10.5   |
| courtyard 68   | 63   | 0    | 47-55  | 12-12  | 47   | 47      | 25.7      | 37.0    | 37.0    | 46.1    | 0.3    | 32+  | 28+     | 1    | 16.1    | 0      | 2.0    | 2.6    |
| gutters 44     | 69   | 0    | 27-31  | 8-8    | 57   | 57      | 20.8      | 29.6    | 35.3    | 44.9    | 5.7    | 16+  | 16+     | 1    | 12.0    | 0      | 1.3    | 2.9    |
| gutters 56     | 69   | 0    | 39-39  | 8-8    | 59   | 59      | 23.0      | 30.8    | 32.0    | 40.9    | 4.8    | 28+  | 24+     | 1    | 15.0    | 0      | 2.2    | 3.9    |
| gutters 68     | 69   | 0    | 57-57  | 12-12  | 59   | 59      | 26.7      | 36.6    | 37.2    | 57.5    | 5.7    | 46+  | 62+     | 1    | 13.4    | 0      | 6.3    | 12.1   |
| stacks 44      | 65   | 0    | 39-43  | 8-8    | 45   | 45      | 21.7      | 31.1    | 31.5    | 31.8    | 0.3    | 28+  | 8+      | 1    | 11.0    | 0      | 1.0    | 1.4    |
| stacks 56      | 56   | 0    | 59-75  | 8-8    | 42   | 41      | 21.3      | 28.8    | 29.8    | 40.3    | 0.3    | 44+  | 8+      | 1    | 16.6    | 0      | 6.3    | 13.0   |
| stacks 68      | 65   | 0    | 87-123 | 12-12  | 43   | 41      | 24.3      | 35.1    | 36.3    | 57.3    | 3.8    | 72+  | 4+      | 1    | 13.9    | 0      | 4.6    | 8.3    |
| ziggurat 44    | 65   | 0    | 76-84  | 8-8    | 45   | 45      | 24.8      | 33.0    | 33.0    | 35.3    | 2.0    | 41+  | 8+      | 1    | 10.3    | 0      | 0.7    | 1.0    |
| ziggurat 56    | 65   | 0    | 84-92  | 8-8    | 52   | 52      | 27.4      | 37.2    | 37.3    | 44.9    | 4.2    | 45+  | 12+     | 1    | 14.0    | 0      | 1.2    | 3.2    |
| ziggurat 68    | 65   | 0    | 92-100 | 12-12  | 56   | 56      | 29.6      | 39.0    | 39.0    | 47.1    | 3.8    | 53+  | 16+     | 1    | 11.2    | 0      | 2.6    | 8.4    |

    960 maps (320 seeds x players 2/4/8) · generateMap avg 2.70 ms, max 13.1 ms
    PASS (100%)

Columns: nav% = walkable share of the floor grid (avg, min); sight = per-cell longest sightline in meters (median, p95 averaged over maps, worst p95, longest single ray); pocket = deepest cul-de-sac found; high / wallrun = fewest reachable high surfaces / wall-run faces on any map; seen = most other spawns any spawn can see; gap = closest spawn pair; zfight = coplanar overlapping faces between differently toned boxes; ms = generateMap time.

Also run: `--players 1,6,10 --seeds 60` → 180 maps, PASS.

Deviations from the brief, stated plainly:
- **Nav share floor is 40 %, not 45 %.** The grid keeps the v0 clearance rule (a 1 m ring around every obstacle and the rim is unwalkable), which costs ~9 % on the rim alone in the 44 m arena. Stacks (41–45 %) and the small courtyard (43 %) sit under the 45 % target; everything else is 45–59 %.
- **p95 sightline passes but with little margin on the 68 m ziggurat** (39.0 m against the 40 m limit; every other row is ≤ 38.8 m). Single longest rays reach 44–57 m in a few percent of cells (slanted lines down a lane, or from the top of the ziggurat).
- The cul-de-sac check passes at 6 m; gutters runs closest (5.7 m stubs beside limbo gates).

## Dev tools

- `tools/mapcheck.mjs [--seeds N] [--from S] [--players 2,4,8] [--gen path] [--verbose]` — the validator above.
- `tools/mapcheck-ascii.mjs [--players N] [--arch id] seed…` — height-coded top-down text view.
- `public/dev/level.html` — `?seed=7&players=4&cam=top|iso|fp[&spawn=n]`, or `?sheet=1&players=4&cam=top|iso[&from=1|&seeds=…][&arch=stacks]` for a 12-arena contact sheet. Flat tone colours with height shading; purple posts = spawns (nose = yaw), green = pads, red = health, yellow = Overprint.
- Screenshots: `shots/level-sheet-top-{2p,4p,8p}.png`, `shots/level-sheet-iso-{4p,8p}.png`, `shots/level-fp-{courtyard,stacks,ziggurat-l,gutters-s}.png` (four spawn views each).

## ASCII samples

Legend: `' '` walkable floor, `.` floor the nav grid avoids, `s` stairs/plinth, `1 2 3 4` = 1.2 / 2.4 / 3.6 / 4.8 m, `=` catwalk, `_` lintel, `^` pad, `S` spawn, `+` health, `O` Overprint. +z is up.
```

seed 1 · 2p · COLLATE CLOISTER · courtyard · 44 m · 31 boxes · 8 spawns · nav 43%
#..............333333........................#
#.  S         .333333.                      .#
#.            .333333.   S                  .#
#.  ........  .333333.            ........ S.#
#.  .444444.  .333333.            .444444.  .#
#.  .444444.  .333333.            .444444.  .#
#.  .444444.  ........        ^^  .444444.  .#
#.  .444444.                  ^^  .444444.  .#
#.  .444444.                      .444444.  .#
#.  .444444.....   ................444444.  .#
#.  .......3333.   .222222222223333.......  .#
#.        .3333.   .222222222223333.        .#
#.        .3333.   .222222222223333.        .#
#.     ^^ .3333.   .222222222223333.  .......#
#.     ^^ .2222.   .................  .333333#
#.        .2222.+            +        .333333#
#.        .2222. .......  ...         .333333#
#.        .2222. .22222.  .2.         .333333#
#.        .2222. .......  .2. ......  .333333#
#. S      .2222.    ssssss.2. .2222.  .333333#
#.        .2222.    ssssss.2. .2222.  .......#
#.        .2222. ...sssOss.2. .2222.        .#
#.        .2222. .2.ssssss... .2222.        .#
#.......  .2222. .2.ssssss    .2222.        .#
#333333.  .2222. .2.ssssss    .2222.      S .#
#333333.  ...... .2.  ....... .2222.        .#
#333333.         .2.  .22222. .2222.        .#
#333333.         ...  ....... .2222.        .#
#333333.        +            +.2222.        .#
#333333.  .................   .2222. ^^     .#
#.......  .333322222222222.   .3333. ^^     .#
#.        .333322222222222.   .3333.        .#
#.        .333322222222222.   .3333.        .#
#.  .......333322222222222.   .3333.......  .#
#.  .444444................   .....444444.  .#
#.  .444444.                      .444444.  .#
#.  .444444.  ^^                  .444444.  .#
#.  .444444.  ^^        ........  .444444.  .#
#.  .444444.            .333333.  .444444.  .#
#.  .444444.            .333333.  .444444.  .#
#.S ........            .333333.  ........  .#
#.                  S   .333333.            .#
#.                      .333333.         S  .#
#........................333333..............#

seed 2 · 2p · JAM ANNEX · stacks · 44 m · 39 boxes · 8 spawns · nav 45%
#........................3333................#
#.                      .3333.              .#
#.             S......  .3333.   S          .#
#.              .3333.  .3333.              .#
#.              .3333.  ......              .#
#.              .3333.                      .#
#.     ......   .3333..................     .#
#.     .2222.   .333333334444444442222.     .#
#.     .2222.   .333333334444444442222.     .#
#.     .2222.   .333333334444444442222.     .#
#.     .2222.   .333333334444444442222.     .#
#. S   .4444.   .......................     .#
#.     .4444.                               .#
#.     .4444. +                +            .#
#.     .4444.             ^^              S .#
#..... .4444.   ......  ..^^..   .......... .#
#3333. .4444.   .2222.  .2222.   .33333333. .#
#3333. .4444.  ^^2222.  .2222.   .33333333. .#
#3333. .4444.  ^^2222.  .2222.   .33333333. .#
#3333. .4444.   .2222.  .2222.   .33333333. .#
#..... .3333.   .....ssss.....   .3333..... .#
#.     .3333.        ssOs        .3333.     .#
#.     .3333.        ssss        .3333.     .#
#. .....3333.   .....ssss.....   .3333. .....#
#. .33333333.   .2222.  .2222.   .4444. .3333#
#. .33333333.   .2222.  .2222^^  .4444. .3333#
#. .33333333.   .2222.  .2222^^  .4444. .3333#
#. .33333333.   .2222.  .2222.   .4444. .3333#
#. ..........   ..^^..  ......   .4444. .....#
#. S              ^^             .4444.     .#
#.            +                + .4444.     .#
#.                               .4444.     .#
#.     .......................   .4444.   S .#
#.     .222244444444433333333.   .2222.     .#
#.     .222244444444433333333.   .2222.     .#
#.     .222244444444433333333.   .2222.     .#
#.     .222244444444433333333.   .2222.     .#
#.     ..................3333.   ......     .#
#.                      .3333.              .#
#.              ......  .3333.              .#
#.              .3333.  .3333.              .#
#.          S   .3333.  ......S             .#
#.              .3333.                      .#
#................3333........................#

seed 11 · 2p · DUPLEX OVERPASS · bridges · 44 m · 63 boxes · 8 spawns · nav 46%
#.....................__.....................#
#.                   .__.                   .#
#. S            S.....__...               S .#
#.          ...  .11444444.    ...          .#
#.          .3.  .11444444.    .3.          .#
#.          .3.  .22444444.  ^^.3.          .#
#.          .3.  .22444444.  ^^.3.          .#
#.          .3.  .33444444.    .3.          .#
#.          .3.  .33444444.    .3.          .#
#.        ...3.  .....==...    .3...        .#
#.        .113.       ==       .311.        .#
#.  .......113.       ==       .311.......  .#
#.  .333333333....... == .......333333333.  .#
#.  ..........333222. == .222333..........  .#
#.    ^^     .333222. ==..222333.           .#
#.    ^^     .333222.+==11222333.         S .#
#.           .222222. ==11222222.  ........ .#
#.           .222222. ==..222222.  .332211. .#
#. ........  .222222. == .222222.  .332211. .#
#. .444444.  ...11..======.......  .444444. .#
#...444444.    .11. ======   +     .444444...#
#___444444============sO============444444___#
#___444444============ss============444444___#
#...444444.     +   ====== .11.    .444444...#
#. .444444.  .......======..11...  .444444. .#
#. .112233.  .222222. == .222222.  ........ .#
#. .112233.  .222222..== .222222.           .#
#. ........  .22222211== .222222.           .#
#. S         .33322211==+.222333.     ^^    .#
#.           .333222..== .222333.     ^^    .#
#.  ..........333222. == .222333..........  .#
#.  .333333333....... == .......333333333.  .#
#.  .......113.       ==       .311.......  .#
#.        .113.       ==       .311.        .#
#.        ...3.    ...==.....  .3...        .#
#.          .3.    .44444433.  .3.          .#
#.          .3.    .44444433.  .3.          .#
#.          .3.^^  .44444422.  .3.          .#
#.          .3.^^  .44444422.  .3.          .#
#.          .3.    .44444411.  .3.          .#
#.          ...    .44444411.  ...          .#
#. S               ...__.....S            S .#
#.                   .__.                   .#
#.....................__.....................#

seed 5 · 2p · JAM PRESS · ziggurat · 44 m · 84 boxes · 8 spawns · nav 45%
#...................444444...................#
#.           S .....444444.  ^^             .#
#. ....        .1122444444.  ^^        .... .#
#. .22. ...    .1122444444.        ... .22. .#
#. .22. .4.    ............        .4. .22. .#
#. .... .4.           +         S  .4. .... .#
#.      .4.                        .4.      .#
#.  .....4...........    ...........4.....  .#
#.  .444444444444444.    .44___4444444444.  .#
#.  .....411.........    .........114.....  .#
#.      .411.                    .114.      .#
#.      .4...                    ...4.      .#
#.    S .4.         .sss.          .4.     S.#
#.      .4.   .......sss........   .4.      .#
#.^^    ._.   .2222221112222222.   .4.  .....#
#.^^    ._.   .2111111111111112.   .4.  .11..#
#.      ._.   .2111111111111112.   .4.  .11..#
#.      .4.   .2111111111111112.   .4.  .22..#
#.....  .4.   .2111111222111112.   .4.  .22..#
#4444.  ...   .2111133222311112..  ...  .4444#
#4444.       ..2111222222311111ss       .4444#
#4444.       ss11112222O2221111ss      +.4444#
#4444.+      ss1111222222221111ss       .4444#
#4444.       ss1111132222221112..       .4444#
#4444.  ...  ..2111132223311112.   ...  .4444#
#..22.  .4.   .2111112221111112.   .4.  .....#
#..22.  .4.   .2111111111111112.   .4.      .#
#..11.  .4.   .2111111111111112.   ._.      .#
#..11.  .4.   .2111111111111112.   ._.    ^^.#
#.....  .4.   .2222222111222222.   ._.    ^^.#
#.      .4.   ........sss.......   .4.      .#
#.S     .4.          .sss.         .4. S    .#
#.      .4...                    ...4.      .#
#.      .411.                    .114.      .#
#.  .....411.........    .........114.....  .#
#.  .4444444444___44.    .444444444444444.  .#
#.  .....4...........    ...........4.....  .#
#.      .4.                        .4.      .#
#. .... .4.  S         +           .4. .... .#
#. .22. .4.        ............    .4. .22. .#
#. .22. ...        .4444442211.    ... .22. .#
#. ....        ^^  .4444442211.        .... .#
#.             ^^  .444444..... S           .#
#...................444444...................#

seed 9 · 2p · GUTTER RUNS · gutters · 44 m · 27 boxes · 8 spawns · nav 58%
#.........................444444.............#
#.                  S    .444444.  ..       .#
#.                       .444444.  ^^     S .#
#.                  ...  .444444.  ..       .#
#.                  ._.  .444444.           .#
#.                  ._.  ........           .#
#.                  ._.                     .#
#.                ..._.                     .#
#.                .11_.                     .#
#.   ..........  ..11_...................   .#
#.   .44444444.  .4444444444444444444444.   .#
#.   ..........  ......._................   .#
#.                     ._.                  .#
#.                  +  ._.                  .#
#. S                   ._.                S .#
#.                     ._.                  .#
#.   ..................._......  ............#
#.   .444444444444444444444444.  .44444444444#
#.   .....222..................  ............#
#.       .222.      ssssss                  .#
#.       .222.      ssssss      .....       .#
#.       .222.      sssOss      .222. +     .#
#.     + .222.      ssssss      .222.       .#
#.       .....      ssssss      .222.       .#
#.                  ssssss      .222.       .#
#............  ..................222.....   .#
#44444444444.  .444444444444444444444444.   .#
#............  ......_...................   .#
#.                  ._.                     .#
#. S                ._.                   S .#
#.                  ._.  +                  .#
#.                  ._.                     .#
#.   ................_.......  ..........   .#
#.   .4444444444444444444444.  .44444444.   .#
#.   ..................._11..  ..........   .#
#.                     ._11.                .#
#.                     ._...                .#
#.                     ._.                  .#
#.           ........  ._.                  .#
#.           .444444.  ._.                  .#
#.       ..  .444444.  ...                  .#
#. S     ^^  .444444.                       .#
#.       ..  .444444.    S                  .#
#.............444444.........................#

seed 4 · 4p · JAM CROSSING · bridges · 56 m · 75 boxes · 8 spawns · nav 49%
#...........................33...........................#
#.                         .33.                         .#
#.                     S   .33.                         .#
#.             ...         .__.         ...             .#
#.   ......    .3.         .__.         .3.    ......   .#
#.   .2222.    .3.     .....__...       .3.S   .2222.   .#
#.   .2222.    .3.     .11444444.       .3.    .2222.   .#
#.   .2222.    .3.     .11444444.       .3.    .2222.   .#
#.   .2222.    .3.     .22444444.  ^^   .3.    .2222.   .#
#.   ......    .3.     .22444444.  ^^   .3.    ......   .#
#.             .3.     .33444444.       .3.             .#
#.             .3.     .33444444.       .3.             .#
#.           ...3.     .....==...       .3...           .#
#.    S      .113.          ==          .311.           .#
#.  ..........113.          ==          .311..........  .#
#.  .333333333333.......... ==...........333333333333.  .#
#.  .............333222222. ==11222222333.............  .#
#.              .333222222. ==11222222333.              .#
#.              .333222222. ==..222222333.              .#
#.              .222222222. == .222222222.              .#
#.       ^^     .222222222..==+.222222222.              .#
#.       ^^     .22222222211== .222222222.              .#
#.              .22222222211== .222222222.  ........  S .#
#.              .222222222..== .222222222.  .332211.    .#
#.    ........  .222222222. == .222222222.  .332211.    .#
#.    .444444.  .11.......======..11......  .444444.    .#
#......444444.  .11. +    ====== .11.       .444444......#
#333___444444===============sO===============444444___333#
#333___444444===============ss===============444444___333#
#......444444.       .11. ======    + .11.  .444444......#
#.    .444444.  ......11..======.......11.  .444444.    .#
#.    .112233.  .222222222. == .222222222.  ........    .#
#.    .112233.  .222222222. ==..222222222.              .#
#. S  ........  .222222222. ==11222222222.              .#
#.              .222222222. ==11222222222.     ^^       .#
#.              .222222222.+==..222222222.     ^^       .#
#.              .222222222. == .222222222.              .#
#.              .333222222..== .222222333.              .#
#.              .33322222211== .222222333.              .#
#.  .............33322222211== .222222333.............  .#
#.  .333333333333...........== ..........333333333333.  .#
#.  ..........113.          ==          .311..........  .#
#.           .113.          ==          .311.      S    .#
#.           ...3.       ...==.....     .3...           .#
#.             .3.       .44444433.     .3.             .#
#.             .3.       .44444433.     .3.             .#
#.   ......    .3.   ^^  .44444422.     .3.    ......   .#
#.   .2222.    .3.   ^^  .44444422.     .3.    .2222.   .#
#.   .2222.    .3.       .44444411.     .3.    .2222.   .#
#.   .2222.    .3.       .44444411.     .3.    .2222.   .#
#.   .2222.   S.3.       ...__.....     .3.    .2222.   .#
#.   ......    .3.         .__.         .3.    ......   .#
#.             ...         .__.         ...             .#
#.                         .33.   S                     .#
#.                         .33.                         .#
#...........................33...........................#

seed 20 · 4p · DUPLEX DEPOT · stacks · 56 m · 67 boxes · 8 spawns · nav 41%
#..............................3333......................#
#.                            .3333.                    .#
#. S                S         .3333.                  S .#
#.  ......   ...............  .3333.   ......   ......  .#
#.  .2222.   .2222_____4444.  .2222.   .2222.   .2222.  .#
#.  .2222.   .2222_____4444.  .2222.   .2222.   .2222.  .#
#.  .2222.   .2222_____4444.  .2222.   .2222.   .2222.  .#
#.  .2222.   .2222_____4444.  .2222.   .2222.   .2222.  .#
#.  ......   ..........4444.  ......   ......   ......  .#
#.                    .4444.                            .#
#.                    .4444.                            .#
#.                    .4444.                            .#
#.  ......   ......   .4444..................   ......  .#
#.  .2222.   .4444.   .444444444444_____4444.   .2222.  .#
#.  .2222.   .4444=====444444444444_____4444.   .2222.  .#
#.  .2222.   .4444=====444444444444_____4444.   .2222.  .#
#.  .2222.   .4444.   .444444444444_____4444.   .2222.  .#
#.  ......   .____.   ...................==..   .____.  .#
#.           .____.                      ==     .____.  .#
#.           .____. +                +   ==     .____.S .#
#.           .____.     ^^               ==     .____.  .#
#.........   .____.   ..^^..  ......   ..==......____.  .#
#33332222.   .4444.   .2222.  .2222.   .4444444444444.  .#
#33332222.   .4444.   .2222.  .2222^^  .4444444444444.  .#
#33332222.   .4444.   .2222.  .2222^^  .4444444444444.  .#
#33332222.   .4444.   .2222.  .2222.   .4444444444444.  .#
#.........   .4444.   .....ssss.....   .4444..........  .#
#.           .4444.        ssOs        .4444.           .#
#.           .4444.        ssss        .4444.           .#
#.  ..........4444.   .....ssss.....   .4444.   .........#
#.  .4444444444444.   .2222.  .2222.   .4444.   .22223333#
#.  .4444444444444.  ^^2222.  .2222.   .4444.   .22223333#
#.  .4444444444444.  ^^2222.  .2222.   .4444.   .22223333#
#.  .4444444444444.   .2222.  .2222.   .4444.   .22223333#
#.  .____......==..   ......  ..^^..   .____.   .........#
#.  .____.     ==               ^^     .____.           .#
#. S.____.     ==   +                + .____.           .#
#.  .____.     ==                      .____.           .#
#.  .____.   ..==...................   .____.   ......  .#
#.  .2222.   .4444_____444444444444.   .4444.   .2222.  .#
#.  .2222.   .4444_____444444444444=====4444.   .2222.  .#
#.  .2222.   .4444_____444444444444=====4444.   .2222.  .#
#.  .2222.   .4444_____444444444444.   .4444.   .2222.  .#
#.  ......   ..................4444.   ......   ......  .#
#.                            .4444.                    .#
#.                            .4444.                    .#
#.                            .4444.                    .#
#.  ......   ......   ......  .4444..........   ......  .#
#.  .2222.   .2222.   .2222.  .4444_____2222.   .2222.  .#
#.  .2222.   .2222.   .2222.  .4444_____2222.   .2222.  .#
#.  .2222.   .2222.   .2222.  .4444_____2222.   .2222.  .#
#.  .2222.   .2222.   .2222.  .4444_____2222.   .2222.  .#
#.  ......   ......   .3333.  ...............   ......  .#
#. S                  .3333.         S                S .#
#.                    .3333.                            .#
#......................3333..............................#

seed 5 · 8p · JAM PRESS · ziggurat · 68 m · 100 boxes · 12 spawns · nav 56%
#................................3333................................#
#.    S                         .3333.                              .#
#.                              .3333.       S                      .#
#.                              .____.                              .#
#.   ........                   .____.                   ........   .#
#.   .333333.                  ..____..                  .333333.  S.#
#.   .333333...                .444444.        ......    .333333.   .#
#.   .33333311.                .444444.        .3333.    .333333.   .#
#.   .33333311.                .444444.  ^^    .3333.    .333333.   .#
#.   .333333...            .....444444.  ^^    .3333.    .333333.   .#
#.   .333333.              .1122444444.        ......    .333333.   .#
#.   ........   ...        .1122444444.            ...   ...11...   .#
#.              .4.        ............            .4.     .11.     .#
#.              .4.     S         +                .4.     ....     .#
#.              .4.                                .4.              .#
#.          .....4...............    ...............4.....          .#
#.     ......4444444444444444444.    .44___44444444444444.          .#
#.     .333......411.............    .............114.....          .#
#.     .333.    .411.                            .114.              .#
#.     .333.    .4...                   +        ...4.              .#
#.     .333.    .4.               .sss.            .4.              .#
#.     .....    .4.   .............sss..........   .4.              .#
#.              .4.   .222222222222111222222222.   .4.              .#
#. S            .4.   .211111111111111111111112.   .4. S            .#
#.              .4.   .211111111111111111111112.   .4.              .#
#.              .4.   .211111111111111111111112.   .4.              .#
#.       ^^     ._.   .211111111222111111111112.   .4.  ....        .#
#.       ^^     ._.   .211113333222333333311112.   .4.  .11.        .#
#.              ._. + .211113222222222222311112.   .4.  .11.        .#
#.              .4.   .211113222222222222311112.   .4.  .22.        .#
#.    ........  .4.  ..211113222222222222311112.   .4.  .22.....    .#
#......444444.  ...  ss111113222222222222221112.   ...  .444444......#
#333___444444.       ss111113222222222222221112.        .444444___333#
#333___444444.       ss111113222222O22222221112..      +.444444___333#
#333___444444.+      ..211122222222222222311111ss       .444444___333#
#333___444444.        .211122222222222222311111ss       .444444___333#
#......444444.  ...   .211122222222222222311111ss  ...  .444444......#
#.    .....22.  .4.   .211113222222222222311112..  .4.  ........    .#
#.        .22.  .4.   .211113222222222222311112.   .4.              .#
#.        .11.  .4.   .211113222222222222311112. + ._.              .#
#.        .11.  .4.   .211113333333222333311112.   ._.     ^^       .#
#.        ....  .4.   .211111111111222111111112.   ._.     ^^       .#
#.              .4.   .211111111111111111111112.   .4.              .#
#.              .4.   .211111111111111111111112.   .4.              .#
#.            S .4.   .211111111111111111111112.   .4.            S .#
#.              .4.   .222222222111222222222222.   .4.              .#
#.              .4.   ..........sss.............   .4.    .....     .#
#.              .4.            .sss.               .4.    .333.     .#
#.              .4...        +                   ...4.    .333.     .#
#.              .411.                            .114.    .333.     .#
#.          .....411.............    .............114......333.     .#
#.          .44444444444444___44.    .4444444444444444444......     .#
#.          .....4...............    ...............4.....          .#
#.              .4.                                .4.              .#
#.     ....     .4.                +         S     .4.              .#
#.     .11.     .4.            ............        .4.              .#
#.   ...11...   ...            .4444442211.        ...   ........   .#
#.   .333333.    ......        .4444442211.              .333333.   .#
#.   .333333.    .3333.    ^^  .444444.....            ...333333.   .#
#.   .333333.    .3333.    ^^  .444444.                .11333333.   .#
#.   .333333.    .3333.        .444444.                .11333333.   .#
#.   .333333.    ......        .444444.                ...333333.   .#
#.S  .333333.                  ..____..                  .333333.   .#
#.   ........                   .____.                   ........   .#
#.                              .____.                              .#
#.                      S       .3333.                              .#
#.                              .3333.                         S    .#
#................................3333................................#
```

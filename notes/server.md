# SERVER notes

## What exists
| File | Role |
|---|---|
| `server.js` | Entry. CLI (`--port N` / `PORT`, `--bots N`, `--fast`), banner with LAN URLs + tunnel tip, static HTTP, `/ws` upgrade, 20 Hz ticker, heartbeat (ws ping every 2 s → roster `ping`; socket dropped after 15 s of silence, or 10 s without `hello`), EADDRINUSE message. |
| `server/static.js` | Static handler: `/` → `public/`, `/shared/` → `shared/`, traversal-safe, MIME incl. woff2, `cache-control: no-cache`. |
| `server/game.js` | The room: roster, host, settings, phase machine, spawns, draft, snapshots. Transport-agnostic, injectable clock, no timers (everything polled in `step()`). |
| `server/combat.js` | `fire`/`proj`/`boom` validation, the single `applyDamage` door, card effects, kills, rewind, pickups, `fell`. |
| `server/bots.js` | Bot AI (perception, footwork, aim, weapons, bombs) + the "director". |
| `server/nav.js` | Bot nav grid rasterized from `map.boxes` (regions, hop cells), A*, string pulling. |
| `server/player.js`, `server/util.js` | Player record + helpers; sanitizing, vectors, LAN URLs, rate limiter. |

## Tests (port 3101 only)
```
node tools/servertest.mjs          # e2e over real sockets, spawns server.js --fast   (~70 s)   [--only combat|flow|bots] [--verbose]
node tools/servertest-cards.mjs    # card effects + rules, in-process, simulated clock (<1 s)
node tools/servertest-soak.mjs     # bot soak, in-process, simulated clock: 5 seeds × 60 s, 6 bots (~2 s)
node tools/servertest-soak.mjs --seeds 7,424242 --seconds 120 --bots 6 --skill 2    # the 2-minute soak
```
Last run: e2e 134/134 (combat 77, flow 48, bots 9); cards 59/59; soak PASS at skill 0/1/2.
2-minute soak, 6 bots skill 2 + idle human: 0 errors, 0 rescues, 0.22–0.26 ms/tick average
(worst single tick 12–20 ms, on a machine shared with other agents), bot kills [10,13,11,12,7,5] and [6,15,12,7,7,14].
The soaks use a simulated clock, so "2 minutes" is game time, not wall time.

## Protocol: decisions where SPEC §4 was ambiguous (client must know)
1. **`phase` always carries every field.** `seed`/`mapPlayers`/`pickups` describe the most recently generated arena and are
   repeated unchanged on `playing`, `roundEnd`, `draft`, `matchEnd` and the post-match `lobby` (0 / 0 / [] before the first
   round or after everyone left). **Regenerate the map only when `seed` is non-zero and differs from the one you have.**
   `winnerId` is null and `standings` is [] outside `roundEnd`/`matchEnd`.
2. **Final round goes `playing → roundEnd → matchEnd → lobby`** (no draft). `matchEnd.winnerId` = match winner, `standings` sorted by wins.
3. **`kills`/`deaths` in roster and standings are per round** (reset at each countdown). `wins` and `cards` are per match.
4. **`hit` is aggregated per target per `fire` message** (9 pellets on one player = one `hit` with the summed `dmg`; `hs` = any pellet was a headshot; `p` = first pellet's end point).
5. **Self-kills** (own Blotter) and `fell` send `kill.killer: null`; `w` is 3 for the bomb, −1 for `fell`. Nobody scores. A self-damage `hit` has `from === to`.
6. **`spawn.protect`** is seconds from now; during countdown it is countdown-remaining + 1.5. Protection ends on the player's first `fire`/`proj`.
7. **Draft**: `phase` (draft) is sent first, then `draft` to each human. The draft may end before `endsAt`
   (1.5 s after the last human picks; 4 s total when no human has anything to pick) — no second `phase` is sent, the next `countdown` just arrives early. A human joining mid-draft is offered cards too.
8. **`heal` is broadcast to everyone**; `src:'rewind'` is always sent on an accepted rewind, even when hp did not change.
9. Overprint buff is cleared on death (no message; clear it client-side on `kill`). Late joiners get a `buff` for active ones.
10. `ev` relay copies `k`, plus up to 6 extra fields (numbers, booleans, strings ≤ 24 chars, 3-number arrays). Bots emit `ev` `jump`/`land`/`pad`/`dash` with `p`.
11. Bots chat occasionally after a kill (normal `chat` with their id). System chat announces joins, leaves and host changes.
12. Ids are small integers, unique for the server's lifetime. Spawn rows may be up to ~4 m off a map spawn point
    (two players never share a spot; some maps have fewer spawn points than players).
13. `roster` is also re-sent (at most every 2 s) when a ping changed by ≥ 5 ms.

## Rules decisions
- Round with zero kills at the buzzer still has a winner (fewest deaths, then join order).
- Thorns (Thermal Paper) arrive as `hit` with `w:-1` from the victim; they never take the attacker below 1 hp and never chain.
- Second Draft: lethal hit → hp 1 + `saved`, then 0.6 s of invulnerability. Does not apply to `fell`.
- Ink Burst: flat `stats.inkBurst` damage to everyone else within 5 m of the victim (not the killer), `w:-1`, chains, credited to the killer. Skipped when the kill ended the round.
- Lifesteal/thorns/jam only trigger on direct weapon hits (`w ≥ 0`, not self). Overprint doubles damage to others, not self-damage or Ink Burst.
- Rewind: cooldown × 0.85 slack, reset on respawn; hp history is per life; refused if `p` is > 12 m from where the server saw you 3 s ago.
- Regen: 3 s after last damage, hp is fractional server-side and rounded on the wire (never shown as 0 while alive).

## Validation (bad input is dropped silently)
`fire`: phase playing, shooter alive, hitscan/charge weapon, ≤ `pellets` entries, muzzle within 8 m of the shooter's eye,
fire interval × 0.75 (plus up to 125 ms of packet-bunching allowance for fast weapons); per hit: target alive, not self, not protected,
`via` length ≤ `stats.bounce`, end point within 6 m of the target's chest, path length ≤ range + 6 m. Distance for falloff is the
server's own (muzzle → via → target chest). **Trusted as claimed: `hs`, charge `c` (clamped 0..1), line of sight.**
`proj`/`boom`: pid must be live (≤ 8 per player, expires fuse + 2.5 s), boom position plausible for the bomb's age, each listed
distance clamped to ±3 m of the server's. A bomb still counts if its thrower died.
`st`: finite numbers, clamped to the arena; no speed check (LAN game among friends).
`pickup`: ≤ 2.5 m from chest, active, health refused at full hp. Chat 140 chars, ~0.8 msg/s after a burst of 4.

## Bots
- Same collision world and the same `fire` → damage path as humans; no stat bonuses. Skill table at the top of `server/bots.js`.
  Measured time-to-kill a 100 hp target at 12 m (idle / strafing): skill 0 ≈ 5.3 / 7.3 s, skill 1 ≈ 2.5 / 3.8 s, skill 2 ≈ 1.4 / 2.1 s.
  Reaction 0.19–0.3 s and 8.5 rad/s max turn at skill 2.
- Weapons by range (Hole Punch < 7 m, Stapler bursts, charged Marker > 26 m for skill ≥ 1, occasional Blotter lob simulated
  server-side with `stepProjectile`), magazines, reloads, swap delay. Hold fire on spawn-protected targets.
- Take health when hurt, Overprint sometimes, use jump pads, hop onto crate-height obstacles, dash when shot (skill ≥ 1),
  respect Watermark and Paper Jam. Draft cards apply to them.
- **Director**: a living human no bot has had in its sights for 10 s gets the nearest free bot sent over. Humans also count as
  45% closer when bots choose whom to hunt. First bot→idle-human hit: median ~7–11 s, p90 ~21–25 s.
- Unstick: no progress for 1 s → hop + new goal; 4 in a row → placed on the nearest walkable cell (0 occurrences in the soaks).

## Known limits
- Single room; no reconnection (a refresh is a new player, cards and score are lost).
- Bots navigate the ground plane only: they land on towers/platforms via pads and walk off, but never plan routes up there.
- No lag compensation beyond the slack distances above; no anti-cheat for position, headshots or line of sight.
- Bot bombs are simulated at 60 Hz substeps; clients simulate their own copy and remove it on `boom`, so the visible arc can differ slightly from the explosion point.
- Bot aim is lead-less against server-side positions, which lag real ones by ~1 tick + latency.

// MISPRINT — procedural arena generator. Every round the arena is "reprinted" from a new seed.
// Deterministic: generateMap(seed, playerCount) returns the same map on server and every client.
//
// MAP FORMAT (the contract — renderer, physics, server and bots all read this):
// {
//   seed, name, theme (index into THEMES), size (arena is [-size/2, size/2] on X and Z), killY,
//   boxes:   [{ min:[x,y,z], max:[x,y,z], kind, tone }]      // solid AABBs
//            kind: 'floor' | 'wall' | 'block' | 'crate' | 'tower' | 'pillar' | 'platform' | 'trim'
//                  | 'stair' (0.4 m walkable steps) | 'bridge' (catwalk slab, open underneath)
//                  | 'lintel' (beam with a 1.3 m slide-under gap below it)
//            tone: 0 paper, 1 spot ink A, 2 spot ink B, 3 dark ink   (render hint)
//   spawns:  [{ pos:[x,y,z], yaw }]                           // feet positions
//   pickups: [{ id, type:'health'|'overprint', pos:[x,y,z], respawn }]   // respawn in seconds
//   jumpPads:[{ id, min:[x,y,z], max:[x,y,z], vel:[vx,vy,vz] }]          // trigger volume + launch velocity
//   nav:     { cell, w, h, ox, oz, walk:Uint8Array(w*h) }     // walkability for bots
// }
//
// OPTIONAL FIELDS added by this generator (consumers may ignore all of them):
//   map.archetype          'courtyard' | 'stacks' | 'bridges' | 'ziggurat' | 'gutters'
//   map.symmetry           4 or 2 — order of the rotational symmetry about the Y axis
//   jumpPads[i].target     [x,y,z] where the ballistic arc of `vel` lands (top of a tower / catwalk).
//                          `vel` REPLACES the player's velocity; the arc assumes gravity 24 and no air control.
//   nav.height             Float32Array(w*h): standing height (feet Y) of each walkable cell. 0 on the
//                          floor, > 0 on low plinths, stair flights and terraces. Any two 8-adjacent
//                          walkable cells differ by <= 0.5 m, so a hull walking between their centers
//                          gets there on step-up alone — plain 2D A* over `walk` stays valid.
//
// NAV SEMANTICS: walk[i] = 1 means a player hull standing at that cell's center has >= 0.15 m of
// clearance around the whole 1 m cell (so paths keep ~1 m off walls), the cell belongs to the single
// main region, and it is not on a jump pad (walking bots are never launched by accident).
//
// Geometry rules the level kit sticks to: everything that matters for movement sits on the 1 m grid;
// tiers are 1.2 m apart (1.2 / 2.4 / 3.6 / 4.8) so every tier is one jump above the last and a double
// jump skips one; nothing climbable has an overhanging lip; lintels leave exactly 1.3 m (slide, not walk).
import { makeRng } from './rng.js';
import { THEMES, PLAYER, MOVE } from './constants.js';

const NAMES_A = ['SMUDGE', 'GUTTER', 'BLEED', 'JAM', 'PROOF', 'TONER', 'STAPLE', 'COLLATE', 'DUPLEX', 'OFFSET', 'PULP', 'HALFTONE', 'MOIRE', 'GHOST'];
const SIZES = [44, 56, 68];            // arena edge for 2–3 / 4–6 / 7–10 players
const WALL_H = 9;
const T1 = 1.2, T2 = 2.4, T3 = 3.6, T4 = 4.8;
const RISE = 0.4;                      // stair step height (run is always 1 m)
const SLIDE = 1.3;                     // clearance under a lintel: crouch/slide fits, standing does not
const STEP_OK = 0.5 + 1e-6;            // tallest ledge the nav grid treats as walkable
const NAV_PAD = PLAYER.radius + 0.15;
const SIGHT_LIMIT = 40;                // longest tolerated rail sightline, meters

const r2 = (v) => Math.round(v * 100) / 100;
const mkBox = (x0, z0, x1, z1, y0, y1, kind, tone) => ({ min: [x0, r2(y0), z0], max: [x1, r2(y1), z1], kind, tone });

function rot(b, k) {
  // rotate a box k*90° about the Y axis through the origin: (x,z) -> (-z,x)
  let x0 = b.min[0], x1 = b.max[0], z0 = b.min[2], z1 = b.max[2];
  for (let i = 0; i < k; i++) {
    const nx0 = -z1, nx1 = -z0, nz0 = x0, nz1 = x1;
    x0 = nx0; x1 = nx1; z0 = nz0; z1 = nz1;
  }
  return { ...b, min: [x0, b.min[1], z0], max: [x1, b.max[1], z1] };
}
function rotPoint(p, k) {
  let x = p[0], z = p[2];
  for (let i = 0; i < k; i++) { const nx = -z; z = x; x = nx; }
  return [x + 0, p[1], z + 0];         // "+ 0" turns -0 into 0 so maps deep-compare cleanly
}

// Launch velocity whose ballistic arc from `from` peaks `clear` meters above `to` and lands on it.
function launch(from, to, clear = 2.2) {
  const g = MOVE.gravity;
  const vy = Math.sqrt(2 * g * (to[1] + clear - from[1]));
  const t = vy / g + Math.sqrt(2 * clear / g);
  return [r2((to[0] - from[0]) / t), r2(vy), r2((to[2] - from[2]) / t)];
}

// ---------------------------------------------------------------------------------------------
// Level kit: every piece an archetype places is replicated around the arena (4- or 2-fold), with
// spot inks optionally alternating between copies so mirrored landmarks get different callouts.
// ---------------------------------------------------------------------------------------------
function createKit(half, sym) {
  const turns = sym === 4 ? [0, 1, 2, 3] : [0, 2];
  const kit = { half, sym, turns, boxes: [], pads: [], health: [], spawnHints: [], centerTop: 0 };
  const flip = (tone, n) => (n % 2 === 1 && (tone === 1 || tone === 2) ? 3 - tone : tone);

  kit.box = (x0, z0, x1, z1, y0, y1, kind, tone, alt = false) => {
    const b = mkBox(x0, z0, x1, z1, y0, y1, kind, tone);
    turns.forEach((k, n) => { const r = rot(b, k); if (alt) r.tone = flip(tone, n); kit.boxes.push(r); });
  };
  kit.solo = (x0, z0, x1, z1, y0, y1, kind, tone) => kit.boxes.push(mkBox(x0, z0, x1, z1, y0, y1, kind, tone));
  // landmark mass with a flush dark cap (flush: a lip would stop players mantling up the face)
  kit.capped = (x0, z0, x1, z1, y1, kind, tone, alt = false) => {
    kit.box(x0, z0, x1, z1, 0, y1 - 0.3, kind, tone, alt);
    kit.box(x0, z0, x1, z1, y1 - 0.3, y1, 'trim', 3);
  };
  // wall across z = [z0,z1] between x0..x1 with a slide-under gate at [g0,g1] along x
  kit.gatedX = (x0, x1, z0, z1, g0, g1, y1, kind, tone, alt = false) => {
    if (g0 > x0) kit.box(x0, z0, g0, z1, 0, y1, kind, tone, alt);
    if (g1 < x1) kit.box(g1, z0, x1, z1, 0, y1, kind, tone, alt);
    kit.box(g0, z0, g1, z1, SLIDE, y1, 'lintel', tone, alt);
  };
  kit.gatedZ = (x0, x1, z0, z1, g0, g1, y1, kind, tone, alt = false) => {
    if (g0 > z0) kit.box(x0, z0, x1, g0, 0, y1, kind, tone, alt);
    if (g1 < z1) kit.box(x0, g1, x1, z1, 0, y1, kind, tone, alt);
    kit.box(x0, g0, x1, g1, SLIDE, y1, 'lintel', tone, alt);
  };
  // stair flight on the +z side of an edge at z = zEdge, climbing toward -z from yBase to yTop
  kit.flight = (x0, x1, zEdge, yBase, yTop, tone) => {
    const n = Math.round((yTop - yBase) / RISE) - 1;
    for (let i = 1; i <= n; i++) kit.box(x0, zEdge + n - i, x1, zEdge + n - i + 1, yBase, yBase + RISE * i, 'stair', tone);
  };
  kit.pad = (cx, cz, target) => {
    for (const k of turns) {
      const c = rotPoint([cx, 0, cz], k), t = rotPoint(target, k);
      kit.pads.push({ min: [c[0] - 1, 0, c[2] - 1], max: [c[0] + 1, 0.6, c[2] + 1], vel: launch(c, t), target: t });
    }
  };
  // flip the whole layout left-to-right (the pinwheels spin the other way)
  kit.mirror = () => {
    const flipX = (o) => { const x0 = o.min[0]; o.min[0] = -o.max[0] + 0; o.max[0] = -x0 + 0; };
    kit.boxes.forEach(flipX);
    for (const p of kit.pads) { flipX(p); p.vel[0] = -p.vel[0] + 0; p.target[0] = -p.target[0] + 0; }
    for (const h of [...kit.health, ...kit.spawnHints]) h[0] = -h[0];
  };
  // two-step plinth carrying the Overprint
  kit.dais = (base = 0) => {
    kit.solo(-3, -3, 3, 3, base, base + RISE, 'platform', 1);
    kit.solo(-1, -1, 1, 1, base + RISE, base + 2 * RISE, 'platform', 2);
    kit.centerTop = r2(base + 2 * RISE);
  };
  return kit;
}

// ---------------------------------------------------------------------------------------------
// ARCHETYPES. Each returns false when its dice produced something it cannot use (caller re-rolls).
// Comments name the sightline logic: every row/column of the plan meets a >= 2.4 m blocker within
// ~38 m, by construction, so the rail never gets a wall-to-wall lane.
// ---------------------------------------------------------------------------------------------

// ZIGGURAT — stepped press-bed in the middle (Overprint on top: king of the hill), boxed in by four
// crop-mark shaped wall-run brackets, a tower on each axis behind them.
function buildZiggurat(kit, rng, si) {
  const u = kit.half;
  const a1 = [8, 10, 12][si], a2 = a1 - 5;                 // 5 m ledge: the parapet eats 1 m of it
  kit.solo(-a1, -a1, a1, a1, 0, T1, 'platform', 0);
  kit.solo(-a2, -a2, a2, a2, T1, T2, 'platform', 1);
  kit.solo(-1, -1, 1, 1, T2, T2 + RISE, 'platform', 2);
  kit.centerTop = r2(T2 + RISE);

  // flights zig-zag up the faces: ground flight offset one way, the next the other way
  const o = rng.int(-1, 1) * (si ? 2 : 0);
  kit.flight(o - 1, o + 2, a1, 0, T1, 0);
  kit.flight(-o - 2, -o + 1, a2, T1, T2, 1);
  {                            // parapets round both tiers: cover up top, and no skimming shots across the plate
    kit.box(-a1, a1 - 1, o - 1, a1, T1, T2, 'trim', 3);
    kit.box(o + 2, a1 - 1, a1 - 1, a1, T1, T2, 'trim', 3);
    kit.box(-a2, a2 - 1, -o - 2, a2, T2, T3, 'trim', 3);
    kit.box(-o + 1, a2 - 1, a2 - 1, a2, T2, T3, 'trim', 3);
  }

  // crop-mark brackets, 5 m off the base. Arms reach back to cover the rows the low first tier leaves open.
  const d = a1 + 5, e = 3, tail = d + 5;                   // openings exactly as wide as the towers behind them
  if (rng.chance(0.6)) kit.gatedZ(d, d + 1, e, tail, e + 2, e + 5, T4, 'wall', 3);
  else kit.box(d, e, d + 1, tail, 0, T4, 'wall', 3);
  kit.box(e, d, d, d + 1, 0, T4, 'wall', 3);
  kit.box(d + 1, d, tail, d + 1, 0, T4, 'wall', 3);

  // axis towers face the bracket openings; whatever gap is left to the rim gets a slide-under beam
  const tz0 = tail, tz1 = Math.min(u, tail + 6);
  kit.capped(-3, tz0, 3, tz1, T4, 'tower', 1, true);
  if (u - tz1 >= 2) {
    const g1 = Math.min(u, tz1 + 3);
    kit.box(-2, tz1, 2, g1, SLIDE, T3, 'lintel', 3);
    if (g1 < u) kit.box(-2, g1, 2, u, 0, T3, 'block', 3);
  }
  const side = rng.pick([1, -1]), tzc = (tz0 + tz1) / 2;
  kit.pad(7 * side, tzc, [0, T4, tzc]);
  kit.box(side > 0 ? -5 : 3, tz0, side > 0 ? -3 : 5, tz0 + 2, 0, T2, 'crate', 0);   // hop-up on the far side
  kit.box(side > 0 ? -7 : 5, tz0, side > 0 ? -5 : 7, tz0 + 2, 0, T1, 'crate', 0);

  // corner yards: a bastion to fight around, crates tucked in the bracket's elbow
  const cc = Math.round((d + 1 + u) / 2), cs = [1, 2, 3][si];
  kit.box(cc - cs, cc - cs, cc + cs, cc + cs, 0, si === 2 ? T3 : T2, 'block', 2, true);
  if (si) kit.box(cc - cs - 2, cc - 1, cc - cs, cc + 1, 0, T1, 'crate', 0);
  kit.box(d - 2, d - 2, d, d, 0, T1, 'crate', 0);
  if (si === 2) kit.box(u - 10, 13, u - 7, 17, 0, T3, 'block', 0);       // kiosks: break yard-to-plate shots

  kit.health.push([0.5, d + 3.5]);
  if (si === 2) kit.health.push([a1 + 2.5, 5.5]);
  kit.spawnHints.push([u - 2.5, u - 2.5], [d - 3.5, u - 2.5], [u - 2.5, d - 3.5]);
  return true;
}

// BRIDGES — a cross-shaped canyon between four roof blocks; a tower plugs the end of each arm and a
// cross of catwalks links the towers over the Overprint. Cross above, fight below.
function buildBridges(kit, rng, si) {
  const u = kit.half;
  const R = [9, 12, 14][si], C1 = u - 4;
  kit.dais();

  // roof blocks flanking the canyon (rows/cols 3..R)
  const quad = ((q) => (si === 2 && q === 1 ? 2 : q))(rng.int(0, 2)), w = si ? 4 : 3;   // 68 m arena: no see-over corners
  if (quad === 1) {            // L-shaped roof with a low hop-up corner toward the tower squares
    kit.box(3, 3, R, 3 + w, 0, T2, 'block', 0);
    kit.box(3, 3 + w, 3 + w, R, 0, T2, 'block', 0);
    kit.box(3 + w, 3 + w, R, R, 0, T1, 'crate', 1, true);
  } else {
    kit.box(3, 3, R, R, 0, T2, 'block', 0);
    if (quad === 2) kit.box(R - 3, R - 3, R, R, T2, T3, 'crate', 1, true);
  }

  // corners (rows/cols R..C1): an L of wall around a yard; bigger arenas may add a parallel wall
  // inside it, which makes a 4 m wall-jump alley
  kit.box(R, R, C1, R + 1, 0, T3, 'wall', 2, true);
  kit.box(R, R + 1, R + 1, C1, 0, T3, 'wall', 2, true);
  if (si && rng.chance(0.5)) {
    kit.capped(R + 5, R + 5, C1, R + 6, T4, 'wall', 1, true);
    kit.box(C1 - 2, R + 6, C1, R + 8, 0, T2, 'crate', 0);
  } else if (si) {
    const cc = Math.round((R + 1 + u) / 2);
    kit.box(cc - 2, cc - 2, cc + 2, cc + 2, 0, T2, 'block', 0);
    kit.box(R + 1, R + 1, R + 3, R + 3, 0, T1, 'crate', 0);
  } else kit.box(R + 1, R + 1, R + 3, R + 3, 0, T1, 'crate', 0);

  // towers at the canyon ends, tied to the rim by a beam you can slide under
  const tz0 = R + 4, tz1 = R + 10, tw = si === 2 ? 4 : 3;   // big arena: wider than the canyon, or shots graze past
  kit.capped(-tw, tz0, tw, tz1, T4, 'tower', 1, true);
  const g1 = Math.min(u, tz1 + 3);
  kit.box(-1, tz1, 1, g1, SLIDE, T3, 'lintel', 3);
  if (g1 < u) kit.box(-1, g1, 1, u, 0, T3, 'block', 3);

  // catwalk cross; the hub is a ring so you can drop through onto the Overprint
  kit.box(-1, 3, 1, tz0, T4 - 0.4, T4, 'bridge', 2, true);
  if (rng.chance(0.65)) kit.box(-3, 1, 1, 3, T4 - 0.4, T4, 'bridge', 3);
  else kit.solo(-3, -3, 3, 3, T4 - 0.4, T4, 'bridge', 3);

  // one pad and one crate stair per tower, on opposite sides
  const side = rng.pick([1, -1]), tzc = R + 7;
  kit.pad((tw + 4) * side, tzc, [0, T4, tzc]);
  const sx0 = side > 0 ? -tw - 2 : tw;
  kit.box(sx0, tz0, sx0 + 2, tz0 + 2, 0, T3, 'crate', 0);
  kit.box(sx0, tz0 + 2, sx0 + 2, tz0 + 4, 0, T2, 'crate', 0);
  kit.box(sx0, tz0 + 4, sx0 + 2, tz0 + 6, 0, T1, 'crate', 0);

  // canyon cover against the walls, staggered pinwheel-wise
  kit.box(1, 5, 3, 7, 0, T1, 'crate', 0);
  if (si) kit.box(-3, R - 2, -1, R, 0, T1, 'crate', 0);

  kit.health.push([-1.5, Math.floor((3 + R) / 2) + 0.5]);
  if (si === 2) kit.health.push([R - 3.5, R + 1.5]);
  kit.spawnHints.push([u - 2.5, u - 2.5], [R - 2.5, u - 2.5], [u - 2.5, R - 2.5]);
  return true;
}

// COURTYARD — open plaza ringed by a pinwheel of low galleries (roofs you can run). Each plaza corner
// has one door, and every door faces a gatehouse; towers stand on the diagonals.
function buildCourtyard(kit, rng, si) {
  const u = kit.half;
  const P = [8, 10, 12][si], g1 = P + 4, gl = P - 5;
  kit.dais();

  // galleries: x in [-g1, gl] (they lap over the next gallery's end, so every door is a real doorway),
  // with a slide-under gate somewhere along their length
  if (rng.chance(0.75)) {
    const gx = -P + 3 + rng.int(0, P + gl - 9);
    kit.gatedX(-g1, gl, P, g1, gx, gx + 3, T2, 'block', 0);
  } else kit.box(-g1, P, gl, g1, 0, T2, 'block', 0);
  kit.box(-g1, P, -P, g1, T2, T3, 'crate', 1, true);             // turret on the gallery's corner

  // diagonal towers (rows/cols g1..g1+ts)
  const ts = [6, 6, 12][si];
  kit.capped(g1, g1, g1 + ts, g1 + ts, T4, 'tower', 1, true);
  const px = si === 2 ? g1 + ts - 3 : g1 + ts / 2;       // clear of the next billboard round
  kit.pad(px, g1 - 4, [px, T4, g1 + 2.5]);

  // gatehouse straight out of each door; a beam ties it (or, on big arenas, the axis) to the rim so
  // the outer lane is never a clean shot
  const hz0 = g1 + 4, hz1 = Math.min(u, g1 + 10);
  kit.box(P - 6, hz0, P, hz1, 0, T3, 'block', 2, true);
  if (u - hz1 >= 2) {
    const [b0, b1] = si === 2 ? [-2, 2] : [P - 5, P - 1], bz = si === 2 ? g1 + 7 : hz1, lz = Math.min(u, bz + 3);
    kit.box(b0, bz, b1, lz, SLIDE, T3, 'lintel', 3);
    if (lz < u) kit.box(b0, lz, b1, u, 0, T3, 'block', 3);
  }

  // billboard: a long wall-run face over the lane behind each gallery
  const bx0 = -P + 2;
  if (si) kit.box(si === 2 ? -P : bx0, g1 + 4, si === 2 ? -4 : P - 10, g1 + 5, 0, T4, 'wall', 3);

  // plaza cover (pinwheel) and hop-ups onto the gallery roofs
  kit.box(Math.max(0, P - 9), P - 4, P - 3, P - 3, 0, T2, 'wall', 1, true);   // screens: no shot from door to far door
  if (si) kit.box(2, P - 6, 4, P - 4, 0, T1, 'crate', 0);

  kit.health.push([-P + 1.5, P - 1.5]);
  if (si === 2) kit.health.push([bx0 + 2.5, u - 3.5]);
  kit.spawnHints.push([u - 2.5, u - 2.5], [bx0 + 3.5, u - 2.5], [u - 2.5, 2.5]);
  return true;
}

// STACKS — a warehouse grid of 4 m stacks and 5 m aisles; four low crates box in the Overprint at the
// central crossing. Aisles are cut by merged stacks (some of them slide-under shelves) so they dog-leg
// instead of running wall to wall.
const STACK_BANDS = [[2, 6, 11, 15, 22], [2, 6, 11, 15, 20, 24, 28], [3, 7, 12, 16, 21, 25, 30, 34]];
function buildStacks(kit, rng, si) {
  // coarse grid: band 0 is the central aisle, odd bands hold stacks, even bands are aisles;
  // an odd outermost band (largest arena) is a row of bays built into the rim
  const u = kit.half, edges = STACK_BANDS[si], K = edges.length - 1;
  const lo = (k) => (k === 0 ? -edges[0] : k > 0 ? edges[k - 1] : -edges[-k]);
  const hi = (k) => (k === 0 ? edges[0] : k > 0 ? edges[k] : -edges[-k - 1]);
  const N = 2 * K + 1, at = (kx, kz) => (kz + K) * N + (kx + K);
  const widths = [];
  for (let k = -K; k <= K; k++) widths.push(hi(k) - lo(k));
  const FREE = 0, LOW = 1, SHELF = -1, HALF_IN = -2, HALF_OUT = -3;     // otherwise: solid, height tier 2..4
  const odd = (k) => (k & 1) === 1;
  const orbit = (kx, kz) => [[kx, kz], [-kz, kx], [-kx, -kz], [kz, -kx]];

  let grid = null;
  for (let tries = 0; tries < 20 && !grid; tries++) {
    const g = new Int8Array(N * N);
    const set = (kx, kz, v) => { for (const [a, b] of orbit(kx, kz)) g[at(a, b)] = v; };
    const h = (kx, kz) => (Math.abs(kx) > K || Math.abs(kz) > K ? 3 : g[at(kx, kz)]);
    for (let kz = 1; kz <= K; kz += 2) for (let kx = 1; kx <= K; kx += 2) {
      const r = rng();
      set(kx, kz, r < 0.06 ? FREE : r < 0.15 ? LOW : r < 0.5 ? 2 : r < 0.78 ? 3 : 4);
    }
    set(1, 1, 2);                          // four blocks pinch the Overprint crossing
    set(3, 1, 4);                          // landmark towers fed by the pads
    // close the aisle cell (kx,kz) by merging the stacks on either side of it (raising them if needed)
    const merge = (kx, kz) => {
      const [dx, dz] = odd(Math.abs(kz)) ? [1, 0] : [0, 1];
      for (const sgn of [-1, 1]) {
        const a = kx + sgn * dx, b = kz + sgn * dz;
        if (Math.abs(a) <= K && Math.abs(b) <= K && g[at(a, b)] < 2) set(a, b, 2 + rng.int(0, 1));
      }
      set(kx, kz, rng.chance(0.4) ? SHELF : Math.max(h(kx - dx, kz - dz), h(kx + dx, kz + dz)));
    };
    // Every aisle is cut so no run exceeds ~38 m while every crossing keeps two ways round. The
    // cut patterns below are the families an exhaustive search found (f mirrors them); stacksOk
    // re-checks the result because low or missing stacks can still open a long view.
    const f = rng.pick([1, -1]);
    set(1, 3, 3 + rng.int(0, 1)); set(0, 3, g[at(1, 3)]);       // axis bars: one 13 m wall-run face each
    if (si === 0) {                        // 7 m rim lane: a chicane of two half-width blocks keeps it walkable
      merge(2, 3 * f);
      set(K, -1, HALF_IN); set(K, 1, HALF_OUT);
    } else {
      merge(2, 3 * f); merge(2, -5 * f);
      for (const kz of rng.pick([[1], [1], [1, -3], [1, 5], [1, -5], [3, -3], [3, -5], [-3, 5]])) merge(4, kz * f);
      merge(6, -f);
      if (si === 2 && rng.chance(0.4)) merge(6, 7 * rng.pick([1, -1]));
    }
    if (stacksOk(g, K, widths)) grid = g;
  }
  if (!grid) return false;

  const c = edges[0];
  if (c === 3) kit.dais();
  else {
    kit.solo(-2, -2, 2, 2, 0, RISE, 'platform', 1);
    kit.solo(-1, -1, 1, 1, RISE, 2 * RISE, 'platform', 2);
    kit.centerTop = r2(2 * RISE);
  }
  const ink = (kx, kz) => ((Math.abs(kx) + Math.abs(kz)) % 4 === 2 ? 1 : 0);
  const isTower = (kx, kz) => orbit(3, 1).some(([a, b]) => a === kx && b === kz);
  const isBar = (kx, kz) => [...orbit(0, 3), ...orbit(1, 3)].some(([a, b]) => a === kx && b === kz);
  kit.box(lo(0), lo(3), hi(1), hi(3), 0, grid[at(0, 3)] * T1, 'wall', 3);     // axis bar: aisle cell + stack as one face
  for (let kz = -K; kz <= K; kz++) for (let kx = -K; kx <= K; kx++) {
    const v = grid[at(kx, kz)];
    if (v === FREE) continue;
    const x0 = lo(kx), x1 = hi(kx), z0 = lo(kz), z1 = hi(kz);
    const stack = odd(Math.abs(kx)) && odd(Math.abs(kz));
    if (isBar(kx, kz)) continue;
    if (v === HALF_IN || v === HALF_OUT) {       // 4 m deep block on the stack side / rim side of the rim lane
      const out = v === HALF_OUT, ax = Math.abs(kx) === K ? 0 : 2, s = (ax ? kz : kx) > 0 ? 1 : -1;
      const a = s * (out ? u - 4 : edges[K - 1]), b = a + s * 4, m = [x0, z0, x1, z1];
      m[ax ? 1 : 0] = Math.min(a, b); m[ax ? 3 : 2] = Math.max(a, b);
      kit.solo(m[0], m[1], m[2], m[3], 0, T3, 'block', out ? 3 : 2);
    } else if (v === SHELF) kit.solo(x0, z0, x1, z1, SLIDE, T3, 'lintel', 3);
    else if (v === LOW) kit.solo(x0, z0, x1, z1, 0, T1, 'crate', ink(kx, kz));
    else if (isTower(kx, kz)) {
      kit.solo(x0, z0, x1, z1, 0, T4 - 0.3, 'tower', (kx > 0) === (kz > 0) ? 1 : 2);
      kit.solo(x0, z0, x1, z1, T4 - 0.3, T4, 'trim', 3);
    } else kit.solo(x0, z0, x1, z1, 0, v * T1, stack ? 'block' : 'wall', stack ? ink(kx, kz) : 3);
  }
  // catwalks between 4.8 m stacks that face each other across an open aisle
  for (let kz = 1; kz <= K; kz += 2) for (let kx = 1; kx <= K; kx += 2) {
    if (grid[at(kx, kz)] !== 4) continue;
    const xm = (lo(kx) + hi(kx)) / 2, zm = (lo(kz) + hi(kz)) / 2;
    if (kx + 2 <= K && grid[at(kx + 2, kz)] === 4 && grid[at(kx + 1, kz)] === FREE) kit.box(hi(kx), zm - 1, lo(kx + 2), zm + 1, T4 - 0.4, T4, 'bridge', 2, true);
    if (kz + 2 <= K && grid[at(kx, kz + 2)] === 4 && grid[at(kx, kz + 1)] === FREE) kit.box(xm - 1, hi(kz), xm + 1, lo(kz + 2), T4 - 0.4, T4, 'bridge', 2, true);
  }
  const zm = (lo(1) + hi(1)) / 2;
  kit.pad(hi(1) + 1, zm, [(lo(3) + hi(3)) / 2, T4, zm]);
  const mid2 = (lo(2) + hi(2)) / 2, mid4 = (lo(4) + hi(4)) / 2;
  kit.health.push([mid2, mid2]);
  if (si === 2) kit.health.push([mid4, mid4]);
  kit.spawnHints.push([u - 2.5, u - 2.5], [mid2, u - 2.5], [u - 2.5, mid2]);
  return true;
}

// Coarse checks for a stacks grid: aisles connected, no dead ends, no see-through run over 38 m.
function stacksOk(g, K, widths) {
  const N = 2 * K + 1;
  const walk = (i) => g[i] === 0 || g[i] < -1, see = (i) => g[i] === 0 || g[i] === 1;   // chicane halves: walk, no sight
  for (let a = 0; a < N; a++) {
    let runR = 0, runC = 0;
    for (let b = 0; b < N; b++) {
      runR = see(a * N + b) ? runR + widths[b] : 0;
      runC = see(b * N + a) ? runC + widths[b] : 0;
      if (runR > 38 || runC > 38) return false;
    }
  }
  let first = -1, free = 0;
  for (let i = 0; i < N * N; i++) {
    if (!walk(i)) continue;
    free++; if (first < 0) first = i;
    const x = i % N, z = (i / N) | 0;
    let deg = 0;
    if (x > 0 && walk(i - 1)) deg++;
    if (x < N - 1 && walk(i + 1)) deg++;
    if (z > 0 && walk(i - N)) deg++;
    if (z < N - 1 && walk(i + N)) deg++;
    if (deg < (((x - K) | (z - K)) & 1 ? 1 : 2)) return false;   // crossings need two ways out; a one-cell stub is fine
  }
  const seen = new Uint8Array(N * N), stack = [first];
  seen[first] = 1;
  let n = 0;
  while (stack.length) {
    const i = stack.pop(), x = i % N, z = (i / N) | 0;
    n++;
    for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, z > 0 ? i - N : -1, z < N - 1 ? i + N : -1]) {
      if (j >= 0 && walk(j) && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
  }
  if (n !== free) return false;
  // no chokepoints: closing any one aisle cell must leave the rest (stubs aside) connected
  const degree = (i) => { const x = i % N, z = (i / N) | 0; return (x > 0 && walk(i - 1)) + (x < N - 1 && walk(i + 1)) + (z > 0 && walk(i - N)) + (z < N - 1 && walk(i + N)); };
  for (let cut = 0; cut < N * N; cut++) {
    if (!walk(cut)) continue;
    let start = -1, need = 0;
    for (let i = 0; i < N * N; i++) if (walk(i) && i !== cut && degree(i) > 1) { need++; if (start < 0) start = i; }
    seen.fill(0); seen[start] = 1; stack.push(start);
    let got = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % N, z = (i / N) | 0;
      if (degree(i) > 1) got++;
      for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, z > 0 ? i - N : -1, z < N - 1 ? i + N : -1]) {
        if (j >= 0 && j !== cut && walk(j) && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (got !== need) return false;
  }
  return true;
}

// GUTTERS — long parallel wall-run lanes (2-fold symmetry). Wall lines alternate which end is open,
// gaps are staggered line to line, inner lanes are cut by limbo gates, catwalks span the lanes.
function buildGutters(kit, rng, si) {
  const u = kit.half;
  const zs = [4, 11, 18, 25].slice(0, si + 2);     // wall line i occupies z in [zs[i], zs[i]+1]
  const n = zs.length;
  const apart = (a, b, d) => a[1] + d <= b[0] || b[1] + d <= a[0];

  // wall lines: spans with 4 m gaps; even lines stop 5 m short of the +x rim, odd lines of the -x rim.
  // Gap slots are staggered line to line (no shot through two walls) and jittered as a set.
  const slots = [[[-12], [4]], [[-17, 12], [-10, 2]], [[-24, -11, 12], [-18, 2, 20]]][si];
  const jit = rng.int(0, 1);
  const lines = zs.map((z, i) => {
    const gaps = slots[i % 2].map((x) => [x + jit, x + jit + 4]);
    // the outermost line stops short at both ends, or the rim lane would dead-end against it
    const xa = i % 2 || i === n - 1 ? -u + 5 : -u, xb = i % 2 && i < n - 1 ? u : u - 5;
    const ends = [[-u, xa], [xb, u]].filter(([a, b]) => b > a);
    return { z, xa, xb, gaps, openings: [...gaps, ...ends] };
  });
  const solidAt = (line, x0, x1) => x0 >= line.xa && x1 <= line.xb && line.gaps.every((gp) => apart(gp, [x0, x1], 1));

  kit.dais();
  for (const ln of lines) {
    let x = ln.xa;
    for (const [a, b] of [...ln.gaps, [ln.xb, ln.xb]]) {
      kit.box(x, ln.z, a, ln.z + 1, 0, T4, 'wall', lines.indexOf(ln) % 2 ? 3 : 0);
      x = b;
    }
  }

  // center lane: baffles alternate sides so the lane snakes past the dais (and double as hop-ups)
  const l0 = lines[0];
  const baffles = [];
  for (const [lo, hi] of si === 2 ? [[6, 8], [-19, -15]] : [[6, si ? 8 : 12]]) {
    const opts = [];
    for (let bx = lo; bx <= hi; bx++) if (solidAt(l0, bx - 1, bx + 4)) opts.push(bx);
    if (!opts.length) return false;
    baffles.push(rng.pick(opts));
  }
  for (const bx of baffles) kit.box(bx, -1, bx + 3, 4, 0, T2, 'block', 1, true);

  // inner lanes: limbo gates split each lane into rooms; every room keeps two ways out
  for (let k = 1; k < n; k++) {
    const south = lines[k - 1], north = lines[k], z0 = south.z + 1, z1 = north.z;
    const openings = [...south.openings, ...north.openings];
    // every gate position that keeps its distance from the openings and leaves each room (<= 36 m)
    // with at least two ways out
    const valid = [];
    for (let gx = -u + 10; gx <= u - 11; gx++) {
      if (!openings.every((o) => apart(o, [gx, gx + 1], 2))) continue;
      const rooms = [[-u, gx], [gx + 1, u]];
      // an opening within 6 m on both sides, or the room runs on past its exits into a dead end
      if (!openings.some((o) => o[1] <= gx && gx - o[1] <= 6) || !openings.some((o) => o[0] > gx && o[0] - gx - 1 <= 6)) continue;
      const opensOnto = (line, [a, b]) => line.openings.some((o) => o[0] >= a && o[1] <= b);
      // each room must open through BOTH of its walls, or everything beyond it hangs off one doorway
      if (rooms.every((r) => r[1] - r[0] <= 36 && opensOnto(south, r) && opensOnto(north, r))) valid.push(gx);
    }
    if (!valid.length) return false;
    const gates = [rng.pick(valid)];
    for (const gx of gates) kit.box(gx, z0, gx + 1, z1, SLIDE, T3, 'lintel', 2, true);

    // a catwalk across the lane where both walls are solid, with a pad down the lane feeding it
    const claimed = gates.map((gx) => [gx - 1, gx + 2]);
    let placed = false;
    for (let tries = 0; tries < 40 && !placed; tries++) {
      const gx = rng.int(-u + 8, u - 13), dir = rng.pick([1, -1]);
      const pc = gx + 2.5 + dir * 6.5, span = [Math.min(gx, pc - 1) - 1, Math.max(gx + 5, pc + 1) + 1];
      if (!solidAt(south, gx, gx + 5) || !solidAt(north, gx, gx + 5)) continue;
      if (span[0] < -u + 2 || span[1] > u - 2 || !claimed.every((c) => apart(c, span, 0))) continue;
      kit.box(gx, z0, gx + 5, z1, T4 - 0.4, T4, 'bridge', 1, true);
      kit.pad(pc, (z0 + z1) / 2, [gx + 2.5, T4, (z0 + z1) / 2]);
      const hx = dir > 0 ? gx - 3 : gx + 6;                      // hop-up block behind the catwalk
      if (solidAt(north, hx, hx + 2) && claimed.every((c) => apart(c, [hx, hx + 2], 3))) kit.box(hx, z1 - 2, hx + 2, z1, 0, T2, 'block', 0);
      claimed.push(span);
      placed = true;
    }
    const hx = [2, -3, 7, -8, 12, -13].find((x) => claimed.every((c) => apart(c, [x, x + 1], 1)));
    if (hx !== undefined) kit.health.push([hx + 0.5, z1 - 2.5]);
  }

  // rim lanes: a bastion on the rim and a limbo bar off the last wall, offset so the lane dog-legs.
  // Both sit near the middle so neither half of the lane is a long shot.
  const last = lines[n - 1], rz0 = last.z + 1, bd = u - rz0 >= 9 ? 5 : 4;
  const bx = rng.int(-10, si === 2 ? -10 : -7);
  kit.capped(bx, u - bd, bx + 6, u, T4, 'tower', 1, true);
  kit.pad(bx - 4, u - bd / 2, [bx + 2.5, T4, u - bd / 2]);
  let bar = null;
  for (let x = bx + 10; x <= 38 - u && bar === null; x++) if (solidAt(last, x, x + 1)) bar = x;
  if (bar === null) return false;
  kit.box(bar, rz0, bar + 1, u - 4, SLIDE, T3, 'lintel', 3);
  kit.box(bar + 1, rz0, bar + 3, rz0 + 2, 0, T1, 'crate', 0);

  kit.health.push([-(baffles[0] + 5.5), 0.5]);
  kit.spawnHints.push([u - 2.5, u - 2.5], [-u + 2.5, u - 2.5], [u - 2.5, 7.5], [-u + 2.5, 7.5]);
  return true;
}


const ARCHETYPES = [
  { id: 'courtyard', sym: 4, build: buildCourtyard, names: ['PLAZA', 'COURT', 'YARD', 'QUAD', 'CLOISTER'] },
  { id: 'stacks', sym: 4, build: buildStacks, names: ['STACKS', 'DEPOT', 'ANNEX', 'STOCKROOM', 'BLOCK'] },
  { id: 'bridges', sym: 4, build: buildBridges, names: ['CROSSING', 'GANTRY', 'OVERPASS', 'SPAN', 'WORKS'] },
  { id: 'ziggurat', sym: 4, build: buildZiggurat, names: ['PLATEN', 'PILE', 'ALTAR', 'PRESS', 'FOUNDRY'] },
  { id: 'gutters', sym: 2, build: buildGutters, names: ['ROW', 'ALLEY', 'MARGINS', 'CHANNEL', 'RUNS'] },
];

// ---------------------------------------------------------------------------------------------
export function generateMap(seed, playerCount = 4) {
  const rng = makeRng(seed);
  const si = playerCount <= 3 ? 0 : playerCount <= 6 ? 1 : 2;
  const size = SIZES[si], half = size / 2;
  const theme = rng.int(0, THEMES.length - 1);
  const first = rng.int(0, ARCHETYPES.length - 1);
  const nameA = rng.pick(NAMES_A);
  const pick = rng();
  const spawnsWanted = Math.max(8, playerCount + 4);

  // Re-roll the archetype's dice until the result passes the built-in checks; if an archetype keeps
  // failing (very rare) move on to the next one. Every draw comes from the seeded rng.
  for (let n = 0; n < ARCHETYPES.length; n++) {
    const arch = ARCHETYPES[(first + n) % ARCHETYPES.length];
    for (let attempt = 0; attempt < 6; attempt++) {
      const kit = createKit(half, arch.sym);
      if (!arch.build(kit, rng, si)) continue;
      if (rng.chance(0.5)) kit.mirror();
      const map = assemble(kit, rng, spawnsWanted);
      if (!map) continue;
      const name = `${nameA} ${arch.names[Math.floor(pick * arch.names.length)]}`;
      return { seed, name, theme, size, killY: -30, ...map, archetype: arch.id, symmetry: arch.sym };
    }
  }
  throw new Error(`mapgen: no valid arena for seed ${seed}`);
}

// Turn a kit into map fields: enclosure, nav, pickups, spawns. Returns null if a built-in check fails.
function assemble(kit, rng, spawnsWanted) {
  const { half } = kit;
  const boxes = [
    mkBox(-half, -half, half, half, -1, 0, 'floor', 0),
    mkBox(-half - 1, -half - 1, half + 1, -half, -1, WALL_H, 'wall', 3),
    mkBox(-half - 1, half, half + 1, half + 1, -1, WALL_H, 'wall', 3),
    mkBox(-half - 1, -half, -half, half, -1, WALL_H, 'wall', 3),
    mkBox(half, -half, half + 1, half, -1, WALL_H, 'wall', 3),
    ...kit.boxes,
  ];
  const jumpPads = kit.pads.map((p, id) => ({ id, ...p }));
  const nav = buildNav({ size: half * 2, boxes, jumpPads });

  let walkable = 0;
  for (let i = 0; i < nav.walk.length; i++) walkable += nav.walk[i];
  const share = walkable / nav.walk.length;
  if (share < 0.4 || share > 0.78) return null;
  if (longSightShare(nav, boxes) > 0.03) return null;

  const cellOf = ([x, z]) => {
    const i = navIndex(nav, x, z);
    return i >= 0 && nav.walk[i] ? i : -1;
  };
  const pickups = [];
  for (const h of kit.health) {
    if (cellOf(h) < 0) return null;
    for (const k of kit.turns) {
      const p = rotPoint([h[0], 0, h[1]], k);
      pickups.push({ id: pickups.length, type: 'health', pos: [p[0], r2(nav.height[cellOf([p[0], p[2]])] + 0.9), p[2]], respawn: 14 });
    }
  }
  if (cellOf([0.5, 0.5]) < 0) return null;
  pickups.push({ id: pickups.length, type: 'overprint', pos: [0, r2(kit.centerTop + 1.2), 0], respawn: 40 });

  const spawns = chooseSpawns(kit, rng, nav, boxes, pickups, jumpPads, spawnsWanted);
  if (!spawns) return null;
  return { boxes, spawns, pickups, jumpPads, nav };
}

// Share of walkable floor cells that sit in an axis-aligned sight run longer than SIGHT_LIMIT.
function longSightShare(nav, boxes) {
  const { w, h } = nav;
  const opaque = new Uint8Array(w * h);
  for (const b of boxes) {
    if (b.min[1] > SLIDE || b.max[1] < 1.9) continue;        // only what blocks a standing eye
    const x0 = Math.max(0, Math.ceil(b.min[0] - nav.ox - 0.5)), x1 = Math.min(w - 1, Math.floor(b.max[0] - nav.ox - 0.5));
    const z0 = Math.max(0, Math.ceil(b.min[2] - nav.oz - 0.5)), z1 = Math.min(h - 1, Math.floor(b.max[2] - nav.oz - 0.5));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) opaque[z * w + x] = 1;
  }
  const run = new Uint8Array(w * h);
  const sweep = (count, len, idx) => {
    for (let a = 0; a < count; a++) {
      let start = 0;
      for (let b = 0; b <= len; b++) {
        if (b < len && !opaque[idx(a, b)]) continue;
        for (let c = start; c < b; c++) { const i = idx(a, c); if (b - start > run[i]) run[i] = b - start; }
        start = b + 1;
      }
    }
  };
  sweep(h, w, (z, x) => z * w + x);
  sweep(w, h, (x, z) => z * w + x);
  let long = 0, total = 0;
  for (let i = 0; i < w * h; i++) {
    if (!nav.walk[i]) continue;
    total++;
    if (run[i] > SIGHT_LIMIT) long++;
  }
  return long / total;
}

// True when the segment a→b is blocked by any of the boxes.
function blocked(boxes, a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  for (let i = 0; i < boxes.length; i++) {
    const { min, max } = boxes[i];
    let t0 = 0, t1 = 1, hit = true;
    for (let k = 0; k < 3 && hit; k++) {
      if (Math.abs(d[k]) < 1e-9) { if (a[k] < min[k] || a[k] > max[k]) hit = false; continue; }
      let ta = (min[k] - a[k]) / d[k], tb = (max[k] - a[k]) / d[k];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) hit = false;
    }
    if (hit) return true;
  }
  return false;
}

// Spawn selection: whole symmetry orbits of floor cells in the outer arena, each with elbow room and
// cover nearby, hidden from the Overprint, spread out, and seeing at most one other spawn (two if we
// must). Archetype hints are preferred when they qualify.
function chooseSpawns(kit, rng, nav, boxes, pickups, jumpPads, wanted) {
  const { half, sym, turns } = kit;
  const { w, h, walk } = nav;
  const eye = PLAYER.eye;
  const tall = boxes.filter((b) => b.kind !== 'floor' && b.max[1] > eye);
  const top = kit.centerTop + eye;
  const lookouts = [[0, top, 0], [1.5, top, 0], [-1.5, top, 0], [0, top, 1.5], [0, top, -1.5]];
  const health = pickups.filter((p) => p.type === 'health');
  const hinted = new Set(kit.spawnHints.map(([x, z]) => navIndex(nav, x, z)));

  const cands = [];
  for (let cz = 1; cz < h - 1; cz++) for (let cx = 1; cx < w - 1; cx++) {
    const i = cz * w + cx;
    if (!walk[i] || nav.height[i] !== 0) continue;
    const [x, z] = navCenter(nav, i);
    if (z < 0 || (sym === 4 && x < 0)) continue;                         // one representative per orbit
    if (Math.max(Math.abs(x), Math.abs(z)) < half * 0.5) continue;       // outer arena only
    let open = 0, cover = false;          // elbow room right here, something solid within ~3 m
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const X = cx + dx, Z = cz + dz;
      const free = X >= 0 && Z >= 0 && X < w && Z < h && walk[Z * w + X];
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) { if (free) open++; } else if (!free) cover = true;
    }
    if (open < 6 || !cover) continue;
    if (health.some((p) => Math.hypot(p.pos[0] - x, p.pos[2] - z) < 6)) continue;
    if (jumpPads.some((p) => Math.hypot((p.min[0] + p.max[0]) / 2 - x, (p.min[2] + p.max[2]) / 2 - z) < 4)) continue;
    const pts = turns.map((k) => rotPoint([x, eye + 0.05, z], k));
    let self = Infinity;
    for (let a = 1; a < pts.length; a++) self = Math.min(self, Math.hypot(pts[a][0] - x, pts[a][2] - z));
    if (self < 10) continue;
    cands.push({ pts, bonus: (hinted.has(i) ? 8 : 0) + rng() * 3, hidden: null, selfSeen: null });
  }

  const chosen = [];                      // { p:[x,y,z] eye point, seen:int }
  const orbits = Math.ceil(wanted / sym);
  for (let n = 0; n < orbits; n++) {
    let pickd = null;
    for (const limit of [1, 2]) {
      const ranked = [];
      for (const c of cands) {
        if (c.hidden === false) continue;
        let dmin = 24;
        for (const s of chosen) for (const p of c.pts) dmin = Math.min(dmin, Math.hypot(p[0] - s.p[0], p[2] - s.p[2]));
        if (dmin >= 10) ranked.push([dmin + c.bonus, c]);
      }
      ranked.sort((a, b) => b[0] - a[0]);
      for (const [, c] of ranked) {
        if (c.hidden === null) c.hidden = lookouts.every((l) => blocked(tall, l, c.pts[0]));
        if (!c.hidden) continue;
        if (c.selfSeen === null) { c.selfSeen = 0; for (let a = 1; a < c.pts.length; a++) if (!blocked(tall, c.pts[0], c.pts[a])) c.selfSeen++; }
        const add = chosen.map(() => 0);
        let worst = 0;
        for (const p of c.pts) {
          let mine = c.selfSeen;
          chosen.forEach((s, j) => { if (!blocked(tall, p, s.p)) { mine++; add[j]++; } });
          worst = Math.max(worst, mine);
        }
        if (worst > limit || chosen.some((s, j) => s.seen + add[j] > limit)) continue;
        chosen.forEach((s, j) => { s.seen += add[j]; });
        for (const p of c.pts) chosen.push({ p, seen: worst });
        pickd = c;
        break;
      }
      if (pickd) break;
    }
    if (!pickd) return null;
    cands.splice(cands.indexOf(pickd), 1);
  }
  return chosen.map(({ p }) => ({ pos: [p[0], 0.05, p[2]], yaw: r2(spawnYaw(nav, p[0], p[2])) }));
}

// Face the most useful direction: toward the arena center unless a wall is in the way, then down the
// longest open run that still leans inward. yaw = atan2(-dx, -dz) looks along (dx, dz).
function spawnYaw(nav, x, z) {
  const len = Math.hypot(x, z) || 1;
  let best = -Infinity, bx = -x / len, bz = -z / len;
  for (let a = 0; a < 16; a++) {
    const dx = Math.sin(a * Math.PI / 8), dz = Math.cos(a * Math.PI / 8);
    let free = 0;
    while (free < 10) {
      const i = navIndex(nav, x + dx * (free + 1), z + dz * (free + 1));
      if (i < 0 || !nav.walk[i]) break;
      free++;
    }
    const score = Math.min(free, 6) * 10 + 4 * (dx * -x + dz * -z) / len;   // open run first, then lean inward
    if (score > best) { best = score; bx = dx; bz = dz; }
  }
  return Math.atan2(-bx, -bz);
}

// ---------------------------------------------------------------------------------------------
// Walkability raster for bots. A cell is walkable when a hull fits on the surface under its center
// with NAV_PAD clearance over the whole cell; steps up to 0.5 m count as floor, so plinths, stair
// flights and the terraces they lead to are part of the grid (see nav.height). The result is one
// connected region and excludes jump pads.
export function buildNav(map, cell = 1) {
  const half = map.size / 2;
  const w = Math.round(map.size / cell), h = w, n = w * h;
  const near = new Array(n), cover = new Array(n);
  const clampX = (v) => Math.max(0, Math.min(w - 1, v));
  for (const b of map.boxes) {
    if (b.kind === 'floor' || b.solid === false || b.max[1] <= 0) continue;
    const x0 = clampX(Math.floor((b.min[0] - NAV_PAD + half) / cell)), x1 = clampX(Math.floor((b.max[0] + NAV_PAD + half) / cell));
    const z0 = clampX(Math.floor((b.min[2] - NAV_PAD + half) / cell)), z1 = clampX(Math.floor((b.max[2] + NAV_PAD + half) / cell));
    for (let z = z0; z <= z1; z++) {
      const pz = -half + (z + 0.5) * cell, inZ = pz > b.min[2] && pz < b.max[2];
      for (let x = x0; x <= x1; x++) {
        const i = z * w + x, px = -half + (x + 0.5) * cell;
        (near[i] || (near[i] = [])).push(b);
        if (inZ && px > b.min[0] && px < b.max[0]) (cover[i] || (cover[i] = [])).push(b);
      }
    }
  }
  // can a hull stand on the surface at height t under cell i's center?
  const standable = (i, t) => {
    const c = cover[i], m = near[i];
    if (c) for (let k = 0; k < c.length; k++) if (c[k].min[1] <= t + 0.01 && c[k].max[1] > t + 0.01) return false;
    if (m) for (let k = 0; k < m.length; k++) if (m[k].max[1] > t + STEP_OK && m[k].min[1] < t + PLAYER.height) return false;
    return true;
  };
  // highest standable surface of cell i within one step of height `from`
  const surface = (i, from) => {
    let best = -1;
    if (from <= STEP_OK && standable(i, 0)) best = 0;
    const c = cover[i];
    if (c) for (let k = 0; k < c.length; k++) {
      const t = c[k].max[1];
      if (t > best && Math.abs(t - from) <= STEP_OK && standable(i, t)) best = t;
    }
    return best;
  };

  const walk = new Uint8Array(n), height = new Float32Array(n);
  const queue = [];
  for (let i = 0; i < n; i++) {
    const t = surface(i, 0);
    if (t >= 0) { walk[i] = 1; height[i] = t; queue.push(i); }
  }
  for (let q = 0; q < queue.length; q++) {            // climb stairs outward from the floor
    const i = queue[q], x = i % w, z = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, z > 0 ? i - w : -1, z < h - 1 ? i + w : -1]) {
      if (j < 0 || walk[j]) continue;
      const t = surface(j, height[i]);
      if (t >= 0) { walk[j] = 1; height[j] = t; queue.push(j); }
    }
  }
  for (const p of map.jumpPads || []) {
    const x0 = clampX(Math.ceil((p.min[0] - PLAYER.radius + half) / cell - 0.5)), x1 = clampX(Math.floor((p.max[0] + PLAYER.radius + half) / cell - 0.5));
    const z0 = clampX(Math.ceil((p.min[2] - PLAYER.radius + half) / cell - 0.5)), z1 = clampX(Math.floor((p.max[2] + PLAYER.radius + half) / cell - 0.5));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) walk[z * w + x] = 0;
  }
  // a raised cell next to a lower walkable one (a deck over open floor) would fool 2D path-finding
  for (let i = 0; i < n; i++) {
    if (!walk[i]) continue;
    const x = i % w, z = (i / w) | 0;
    for (let dz = -1; dz <= 1 && walk[i]; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Z = z + dz;
      if (X < 0 || Z < 0 || X >= w || Z >= h) continue;
      const j = Z * w + X;
      if (walk[j] && height[i] - height[j] > STEP_OK) { walk[i] = 0; break; }
    }
  }
  keepLargestRegion(walk, w, h);
  for (let i = 0; i < n; i++) if (!walk[i]) height[i] = 0;
  return { cell, w, h, ox: -half, oz: -half, walk, height };
}

function keepLargestRegion(walk, w, h) {
  const comp = new Int32Array(w * h).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let s = 0; s < comp.length; s++) {
    if (!walk[s] || comp[s] !== -1) continue;
    let size = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const c = stack.pop(), cx = c % w, cz = (c / w) | 0;
      size++;
      for (const j of [cx > 0 ? c - 1 : -1, cx < w - 1 ? c + 1 : -1, cz > 0 ? c - w : -1, cz < h - 1 ? c + w : -1]) {
        if (j >= 0 && walk[j] && comp[j] === -1) { comp[j] = id; stack.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  for (let i = 0; i < comp.length; i++) if (comp[i] !== best) walk[i] = 0;
}

export function navIndex(nav, x, z) {
  const cx = Math.floor((x - nav.ox) / nav.cell), cz = Math.floor((z - nav.oz) / nav.cell);
  if (cx < 0 || cz < 0 || cx >= nav.w || cz >= nav.h) return -1;
  return cz * nav.w + cx;
}
export function navCenter(nav, idx) {
  const cx = idx % nav.w, cz = Math.floor(idx / nav.w);
  return [nav.ox + (cx + 0.5) * nav.cell, nav.oz + (cz + 0.5) * nav.cell];
}

// Arena generator validation. Generates N seeds x playerCounts {2,4,8} and checks every map.
//   node tools/mapcheck.mjs [--seeds 300] [--from 1] [--players 2,4,8] [--gen path/to/mapgen.js] [--verbose]
// Prints one row per archetype x arena size, every failure, and PASS/FAIL. Exit code 1 on FAIL.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorld, overlapsWorld, moveBody, raycast, segmentClear } from '../shared/physics.js';
import { PLAYER, MOVE } from '../shared/constants.js';
import { makeRng } from '../shared/rng.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const PLAYERS = String(opt('players', '2,4,8')).split(',').map(Number);
const SEEDS = Number(opt('seeds', 300)), FROM = Number(opt('from', 1)), VERBOSE = args.includes('--verbose');
const gen = path.resolve(opt('gen', new URL('../shared/mapgen.js', import.meta.url).pathname));
const { generateMap, buildNav, navIndex, navCenter } = await import(pathToFileURL(gen).href);

const LIMITS = { boxes: 320, navMin: 0.40, navMax: 0.78, sightP95: 40, pocket: 6, genMs: 30 };
const R = PLAYER.radius, H = PLAYER.height, EYE = PLAYER.eye;

function same(a, b) {
  if (a === b) return true;
  if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b || {});
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
  }
  return false;
}

// ---- individual checks: each returns a list of problem strings and may add to `stats` ----

function checkBoxes(map) {
  const out = [], half = map.size / 2;
  if (map.boxes.length > LIMITS.boxes) out.push(`box count ${map.boxes.length}`);
  for (const b of map.boxes) {
    const d = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
    if (d.some((v) => !(v > 0))) out.push(`degenerate box ${b.kind}`);
    if (d.some((v) => v < 0.2 - 1e-9)) out.push(`box thinner than 0.2 (${b.kind})`);
    const blocksRun = b.max[1] > 0.55 && b.min[1] < H;
    if (blocksRun && (d[0] < 0.5 || d[2] < 0.5)) out.push(`movement blocker thinner than 0.5 (${b.kind})`);
    if (Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[2]), Math.abs(b.max[2])) > half + 1 + 1e-9 || b.min[1] < -1 || b.max[1] > 9) out.push(`box out of bounds (${b.kind})`);
    if (typeof b.kind !== 'string' || ![0, 1, 2, 3].includes(b.tone)) out.push('bad kind/tone');
  }
  // the floor must cover the arena and the rim must be closed
  if (!map.boxes.some((b) => b.kind === 'floor' && b.min[0] <= -half && b.max[0] >= half && b.min[2] <= -half && b.max[2] >= half && b.max[1] === 0)) out.push('no full floor');
  const world = createWorld(map);
  for (let t = -half + 0.5; t < half; t += 1) {
    for (const [x, z] of [[t, -half - 0.5], [t, half + 0.5], [-half - 0.5, t], [half + 0.5, t]]) {
      if (!overlapsWorld(world, x, 0, z, 0.3, 8)) { out.push('gap in the rim wall'); t = half; break; }
    }
  }
  return out;
}

// coplanar, same-facing, overlapping faces of differently toned boxes (z-fighting)
function zFights(map) {
  let n = 0;
  const bs = map.boxes;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (a.tone === b.tone) continue;
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3, v = (k + 2) % 3;
      const ou = Math.min(a.max[u], b.max[u]) - Math.max(a.min[u], b.min[u]);
      const ov = Math.min(a.max[v], b.max[v]) - Math.max(a.min[v], b.min[v]);
      if (ou <= 1e-6 || ov <= 1e-6) continue;
      if (Math.abs(a.min[k] - b.min[k]) < 1e-6 || Math.abs(a.max[k] - b.max[k]) < 1e-6) n++;
    }
  }
  return n;
}

function checkNav(map, stats) {
  const out = [], nav = map.nav, n = nav.w * nav.h;
  if (nav.cell !== 1 || nav.w !== map.size || nav.h !== map.size || nav.ox !== -map.size / 2 || nav.walk.length !== n) out.push('nav shape');
  let total = 0, first = -1;
  for (let i = 0; i < n; i++) if (nav.walk[i]) { total++; if (first < 0) first = i; }
  stats.nav = total / n;
  if (stats.nav < LIMITS.navMin || stats.nav > LIMITS.navMax) out.push(`nav share ${(stats.nav * 100).toFixed(0)}%`);
  const seen = new Uint8Array(n), stack = [first];
  seen[first] = 1;
  let reached = 0;
  while (stack.length) {
    const i = stack.pop(), x = i % nav.w, z = (i / nav.w) | 0;
    reached++;
    for (const j of [x > 0 ? i - 1 : -1, x < nav.w - 1 ? i + 1 : -1, z > 0 ? i - nav.w : -1, z < nav.h - 1 ? i + nav.w : -1]) {
      if (j >= 0 && nav.walk[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
  }
  if (reached !== total) out.push(`nav has ${total - reached} cells outside the main region`);
  if (!same(buildNav(map).walk, nav.walk)) out.push('buildNav(map) differs from map.nav');
  const hgt = (i) => (nav.height ? nav.height[i] : 0);
  for (let i = 0; i < n; i++) {                   // neighbours must be mutually walkable
    if (!nav.walk[i]) continue;
    const x = i % nav.w, z = (i / nav.w) | 0;
    for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
      const X = x + dx, Z = z + dz;
      if (X < 0 || X >= nav.w || Z >= nav.h) continue;
      const j = Z * nav.w + X;
      if (nav.walk[j] && Math.abs(hgt(i) - hgt(j)) > 0.5 + 1e-3) { out.push('adjacent nav cells more than a step apart'); i = n; break; }
    }
  }
  for (const s of map.spawns) {
    const i = navIndex(nav, s.pos[0], s.pos[2]);
    if (i < 0 || !nav.walk[i]) out.push('spawn off the nav grid');
  }
  for (const p of map.pickups) {
    const i = navIndex(nav, p.pos[0], p.pos[2]);
    if (i < 0 || !nav.walk[i]) { out.push(`${p.type} pickup off the nav grid`); continue; }
    const lift = p.pos[1] - hgt(i);
    if (lift < 0.3 || lift > 2.2) out.push(`${p.type} pickup ${lift.toFixed(1)} m above its cell`);
  }
  if (map.pickups.filter((p) => p.type === 'overprint').length !== 1) out.push('need exactly one overprint');
  if (map.pickups.filter((p) => p.type === 'health').length < 4) out.push('fewer than 4 health pickups');
  return out;
}

function checkSpawns(map, world, pc, stats) {
  const out = [], S = map.spawns;
  if (S.length < Math.max(8, pc + 4)) out.push(`only ${S.length} spawns`);
  const over = map.pickups.find((p) => p.type === 'overprint');
  const top = over.pos[1] - 1.2 + EYE;
  const lookouts = [[0, top, 0], [1.5, top, 0], [-1.5, top, 0], [0, top, 1.5], [0, top, -1.5]];
  let minD = Infinity, maxSeen = 0;
  S.forEach((s, i) => {
    const [x, y, z] = s.pos;
    if (overlapsWorld(world, x, y, z, R, 2.2)) out.push('spawn overlaps geometry or lacks 2.2 m headroom');
    if (!overlapsWorld(world, x, y - 0.2, z, R, H)) out.push('spawn floats');
    const eye = [x, y + EYE, z];
    if (lookouts.some((l) => segmentClear(world, l, eye))) out.push('spawn visible from the overprint dais');
    let seen = 0;
    S.forEach((t, j) => {
      if (i === j) return;
      minD = Math.min(minD, Math.hypot(t.pos[0] - x, t.pos[2] - z));
      if (segmentClear(world, eye, [t.pos[0], t.pos[1] + EYE, t.pos[2]])) seen++;
    });
    maxSeen = Math.max(maxSeen, seen);
    if (seen > 2) out.push(`spawn sees ${seen} other spawns`);
    // cover: something solid at body height within 4 m; open: 3 m of clear run in the facing direction
    if (!overlapsWorld(world, x, 0.3, z, 4, 1.5)) out.push('spawn has no cover within 4 m');
    const face = raycast(world, [x, y + 1, z], [-Math.sin(s.yaw), 0, -Math.cos(s.yaw)], 3);
    if (face) out.push('spawn faces a wall');
    for (const p of map.pickups) if (p.type === 'health' && Math.hypot(p.pos[0] - x, p.pos[2] - z) < 5) out.push('health pickup next to a spawn');
  });
  if (minD < 9) out.push(`spawns ${minD.toFixed(1)} m apart`);
  stats.spawnGap = minD; stats.spawnSeen = maxSeen;
  return out;
}

// Longest horizontal sightline (48 directions, eye height) from every other walkable cell.
function checkSight(map, world, stats) {
  const nav = map.nav, longest = [];
  for (let i = 0; i < nav.walk.length; i++) {
    if (!nav.walk[i] || ((i % nav.w) + ((i / nav.w) | 0)) % 2) continue;
    const [x, z] = navCenter(nav, i), y = (nav.height ? nav.height[i] : 0) + EYE;
    let best = 0;
    for (let a = 0; a < 48; a++) {
      const hit = raycast(world, [x, y, z], [Math.sin(a * Math.PI / 24), 0, Math.cos(a * Math.PI / 24)], 200);
      best = Math.max(best, hit ? hit.t : 200);
    }
    longest.push(best);
  }
  longest.sort((a, b) => a - b);
  stats.s50 = longest[Math.floor(longest.length * 0.5)];
  stats.s95 = longest[Math.floor(longest.length * 0.95)];
  stats.sMax = longest[longest.length - 1];
  return stats.s95 > LIMITS.sightP95 ? [`sightline p95 ${stats.s95.toFixed(1)} m`] : [];
}

// A cul-de-sac: block a 5 m wide doorway (disc r = 2.5) anywhere and see whether some part of the nav
// grid deeper than LIMITS.pocket is cut off from the rest.
function checkDeadEnds(map, stats) {
  const nav = map.nav, w = nav.w, n = w * nav.h;
  const comp = new Int32Array(n), stack = [];
  let worst = 0, where = null;
  for (let c = 0; c < n; c++) {
    if (!nav.walk[c] || ((c % w) + ((c / w) | 0)) % 2) continue;
    const cx = c % w, cz = (c / w) | 0;
    comp.fill(0);
    let id = 0, bestSize = 0;
    const sizes = [0], far = [0];
    for (let s = 0; s < n; s++) {
      if (!nav.walk[s] || comp[s]) continue;
      const sx = s % w, sz = (s / w) | 0;
      if ((sx - cx) ** 2 + (sz - cz) ** 2 <= 6.25) continue;
      id++; sizes.push(0); far.push(0);
      comp[s] = id; stack.push(s);
      while (stack.length) {
        const i = stack.pop(), x = i % w, z = (i / w) | 0;
        sizes[id]++;
        far[id] = Math.max(far[id], Math.hypot(x - cx, z - cz));
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, z > 0 ? i - w : -1, z < nav.h - 1 ? i + w : -1]) {
          if (j < 0 || !nav.walk[j] || comp[j]) continue;
          if (((j % w) - cx) ** 2 + (((j / w) | 0) - cz) ** 2 <= 6.25) continue;
          comp[j] = id; stack.push(j);
        }
      }
      bestSize = Math.max(bestSize, sizes[id]);
    }
    for (let k = 1; k <= id; k++) if (sizes[k] < bestSize && far[k] - 2.5 > worst) { worst = far[k] - 2.5; where = [cx - w / 2 + 0.5, cz - w / 2 + 0.5]; }
  }
  stats.pocket = worst;
  return worst > LIMITS.pocket ? [`cul-de-sac ${worst.toFixed(1)} m deep (doorway near ${where})`] : [];
}

// Fly a hull along a ballistic arc (no air control) and report where it lands.
function fly(world, start, vel) {
  const pos = start.slice(), v = vel.slice();
  for (let t = 0; t < 600; t++) {
    v[1] -= MOVE.gravity / 120;
    const res = moveBody(world, pos, v, R, H, 1 / 120);
    if (res.onGround) return { pos, box: res.ground };
  }
  return { pos, box: null };
}

function checkPads(map, world) {
  const out = [], landings = [];
  for (const p of map.jumpPads) {
    const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2;
    if (overlapsWorld(world, cx, 0.01, cz, 0.9, 0.5)) out.push('jump pad buried in geometry');
    const len = Math.hypot(p.vel[0], p.vel[2]) || 1, fx = p.vel[0] / len, fz = p.vel[2] / len;
    // launched from the middle and from each edge of the trigger (a hull touches it 1.3 m out)
    for (const [a, b] of [[0, 0], [1.3, 0], [-1.3, 0], [0, 1.3], [0, -1.3]]) {
      const start = [cx + fx * a - fz * b, 0, cz + fz * a + fx * b];
      if (overlapsWorld(world, start[0], 0.01, start[2], R, H)) continue;      // cannot stand there anyway
      const land = fly(world, start, p.vel);
      const top = land.box ? land.box.max[1] : 0;
      if (top < 2.2) { out.push(`pad ${p.id} arc lands at height ${top.toFixed(1)}`); break; }
      if (p.target && (Math.abs(top - p.target[1]) > 0.01 || Math.hypot(land.pos[0] - p.target[0], land.pos[2] - p.target[2]) > 2.6)) { out.push(`pad ${p.id} misses its target`); break; }
      if (a === 0 && b === 0) landings.push(land.box);
    }
  }
  if (map.jumpPads.length < 2) out.push('fewer than 2 jump pads');
  return { out, landings };
}

// High ground: box tops >= 2.2 m with headroom, reachable from the floor by jump chains
// (double jump 2.6 m up over a gap <= 2.5 m, single jump 1.4 m up over a gap <= 5 m) or a pad arc.
function checkHighGround(map, world, landings, stats) {
  const tops = map.boxes.filter((b) => {
    if (b.kind === 'floor' || b.max[1] > 8) return false;
    const x = (b.min[0] + b.max[0]) / 2, z = (b.min[2] + b.max[2]) / 2;
    return b.max[0] - b.min[0] >= 0.9 && b.max[2] - b.min[2] >= 0.9 && !overlapsWorld(world, x, b.max[1] + 0.01, z, 0.3, 2.2);
  });
  const gap = (a, b) => Math.hypot(Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]), Math.max(0, a.min[2] - b.max[2], b.min[2] - a.max[2]));
  const height = new Map(tops.map((b) => [b, b.max[1]]));
  const reached = new Set(), queue = [];
  const visit = (b) => { if (!reached.has(b)) { reached.add(b); queue.push(b); } };
  for (const b of tops) if (b.max[1] <= 1.4) visit(b);              // one jump off the floor
  for (const b of landings) if (height.has(b)) visit(b);
  while (queue.length) {
    const a = queue.pop();
    for (const b of tops) {
      if (reached.has(b)) continue;
      const g = gap(a, b), rise = b.max[1] - a.max[1];
      if ((g <= 2.5 && rise <= 2.6) || (g <= 5 && rise <= 1.4)) visit(b);
    }
  }
  for (const b of tops) if (b.max[1] <= 2.6 && b.max[1] >= 2.2) reached.add(b);   // double jump from the floor
  const high = [...reached].filter((b) => b.max[1] >= 2.2);
  stats.high = high.length;
  stats.top = high.reduce((m, b) => Math.max(m, b.max[1]), 0);
  const out = [];
  if (high.length < 2) out.push(`only ${high.length} reachable high surfaces`);
  if (stats.top < 4.7) out.push('no reachable 4.8 m tier');
  return out;
}

// Wall-run faces: vertical faces >= 3.5 m tall starting near the floor with >= 8 m of clear run alongside.
function checkWallRuns(map, world, stats) {
  let faces = 0;
  for (const b of map.boxes) {
    if (b.kind === 'floor' || b.min[1] > 0.6 || b.max[1] < 3.5) continue;
    for (const [axis, sign] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
      const along = axis === 0 ? 2 : 0;
      if (b.max[along] - b.min[along] < 8) continue;
      const off = (sign > 0 ? b.max[axis] : b.min[axis]) + sign * (R + 0.05);
      let run = 0, best = 0;
      for (let t = b.min[along] + 0.25; t < b.max[along]; t += 0.5) {
        const x = axis === 0 ? off : t, z = axis === 0 ? t : off;
        const clear = Math.abs(x) < map.size / 2 && Math.abs(z) < map.size / 2 && !overlapsWorld(world, x, 0.05, z, R, 3.4);
        run = clear ? run + 0.5 : 0;
        best = Math.max(best, run);
      }
      if (best >= 8) faces++;
    }
  }
  stats.wallrun = faces;
  return faces < 2 ? [`only ${faces} wall-run faces`] : [];
}

function astar(nav, from, to) {
  const w = nav.w, n = w * nav.h, g = new Float32Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const tx = to % w, tz = (to / w) | 0, open = [[0, from]];
  g[from] = 0;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, c] = open.splice(bi, 1)[0];
    if (c === to) break;
    const x = c % w, z = (c / w) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const X = x + dx, Z = z + dz;
      if (X < 0 || Z < 0 || X >= w || Z >= nav.h) continue;
      const j = Z * w + X;
      if (!nav.walk[j] || (dx && dz && (!nav.walk[z * w + X] || !nav.walk[Z * w + x]))) continue;   // no corner cutting
      const cost = g[c] + (dx && dz ? 1.414 : 1);
      if (cost < g[j]) { g[j] = cost; prev[j] = c; open.push([cost + Math.hypot(X - tx, Z - tz), j]); }
    }
  }
  if (prev[to] < 0 && to !== from) return null;
  const pathCells = [];
  for (let c = to; c !== -1; c = prev[c]) pathCells.push(c);
  return pathCells.reverse();
}

// Walk a hull along A* paths with the real collision code, the way a server bot would.
function checkBotWalk(map, world, rng) {
  const out = [], nav = map.nav, S = map.spawns;
  const over = map.pickups.find((p) => p.type === 'overprint');
  const trips = [[S[0].pos, over.pos], [over.pos, S[S.length - 1].pos]];
  for (let k = 0; k < 5; k++) trips.push([S[Math.floor(rng() * S.length)].pos, S[Math.floor(rng() * S.length)].pos]);
  for (const p of map.pickups) if (p.type === 'health' && rng() < 0.35) trips.push([S[Math.floor(rng() * S.length)].pos, p.pos]);
  for (const [a, b] of trips) {
    const from = navIndex(nav, a[0], a[2]), to = navIndex(nav, b[0], b[2]);
    const route = astar(nav, from, to);
    if (!route) { out.push('no nav path between two points'); continue; }
    const start = navCenter(nav, from);
    const pos = [start[0], (nav.height ? nav.height[from] : 0) + 0.05, start[1]], vel = [0, 0, 0];
    let ground = true, failed = null;
    for (let wp = 1; wp < route.length && !failed; wp++) {
      const [tx, tz] = navCenter(nav, route[wp]);
      let ticks = 0;
      while (Math.hypot(tx - pos[0], tz - pos[2]) > 0.2) {
        const d = Math.hypot(tx - pos[0], tz - pos[2]), sp = Math.min(MOVE.speed, d * 60);
        vel[0] = (tx - pos[0]) / d * sp; vel[2] = (tz - pos[2]) / d * sp;
        vel[1] -= MOVE.gravity / 60;
        const res = moveBody(world, pos, vel, R, H, 1 / 60, { step: ground ? MOVE.stepHeight : 0 });
        ground = res.onGround;
        if (++ticks > 60) { failed = `bot stuck for 1 s at ${pos.map((v) => v.toFixed(1))}`; break; }
      }
    }
    if (failed) out.push(failed);
  }
  return out;
}

// ---- run ----
const rows = new Map(), failures = [];
let maps = 0, genMs = 0, genMax = 0;
for (let i = 0; i < 30; i++) generateMap(900000 + i, [2, 4, 8][i % 3]);      // warm up the JIT before timing

for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  for (const pc of PLAYERS) {
    const problems = [], stats = {};
    let map;
    try {
      const t0 = performance.now();
      map = generateMap(seed, pc);
      const ms = performance.now() - t0;
      genMs += ms;
      const t1 = performance.now(), again = generateMap(seed, pc);
      stats.ms = Math.min(ms, performance.now() - t1);            // best of two: wall-clock noise is not the generator's fault
      if (!same(map, again)) problems.push('not deterministic');
      if (map.size !== (pc <= 3 ? 44 : pc <= 6 ? 56 : 68)) problems.push(`size ${map.size}`);
      for (const f of ['seed', 'name', 'theme', 'size', 'killY', 'boxes', 'spawns', 'pickups', 'jumpPads', 'nav']) if (map[f] === undefined || map[f] === null) problems.push(`missing field ${f}`);
      const world = createWorld(map), rng = makeRng(seed * 7 + pc);
      problems.push(...checkBoxes(map));
      stats.zfight = zFights(map);
      problems.push(...checkNav(map, stats));
      problems.push(...checkSpawns(map, world, pc, stats));
      problems.push(...checkSight(map, world, stats));
      problems.push(...checkDeadEnds(map, stats));
      const pads = checkPads(map, world);
      problems.push(...pads.out);
      problems.push(...checkHighGround(map, world, pads.landings, stats));
      problems.push(...checkWallRuns(map, world, stats));
      problems.push(...checkBotWalk(map, world, rng));
      genMax = Math.max(genMax, stats.ms);
      if (stats.ms > LIMITS.genMs) problems.push(`generateMap took ${stats.ms.toFixed(0)} ms`);
    } catch (e) {
      problems.push(`threw: ${e.stack.split('\n').slice(0, 2).join(' | ')}`);
    }
    maps++;
    const key = `${map ? map.archetype || '-' : '?'} ${map ? map.size : '?'}`;
    const row = rows.get(key) || { n: 0, fail: 0, sums: {}, max: {}, min: {} };
    rows.set(key, row);
    row.n++;
    if (map) stats.boxes = map.boxes.length, stats.spawns = map.spawns.length;
    for (const [k, v] of Object.entries(stats)) {
      row.sums[k] = (row.sums[k] || 0) + v;
      row.max[k] = Math.max(row.max[k] ?? -Infinity, v);
      row.min[k] = Math.min(row.min[k] ?? Infinity, v);
    }
    if (problems.length) {
      row.fail++;
      failures.push(`seed ${seed} pc ${pc} [${key}]: ${[...new Set(problems)].join('; ')}`);
    } else if (VERBOSE) console.log(`ok seed ${seed} pc ${pc} ${key}`);
  }
}

const cols = ['archetype size', 'maps', 'fail', 'boxes', 'spawns', 'nav%', 'nav min', 'sight p50', 'p95 avg', 'p95 max', 'longest', 'pocket', 'high', 'wallrun', 'seen', 'gap min', 'zfight', 'ms avg', 'ms max'];
const table = [...rows.entries()].sort().map(([key, r]) => {
  const avg = (k, d = 1) => (r.sums[k] / r.n).toFixed(d);
  return [key, r.n, r.fail, `${r.min.boxes}-${r.max.boxes}`, `${r.min.spawns}-${r.max.spawns}`, avg('nav', 2) * 100 | 0, (r.min.nav * 100).toFixed(0), avg('s50'), avg('s95'), r.max.s95.toFixed(1), r.max.sMax.toFixed(1), r.max.pocket.toFixed(1), `${r.min.high}+`, `${r.min.wallrun}+`, r.max.spawnSeen, r.min.spawnGap.toFixed(1), r.max.zfight, avg('ms'), r.max.ms.toFixed(1)];
});
const widths = cols.map((c, i) => Math.max(c.length, ...table.map((t) => String(t[i]).length)));
const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
console.log(line(cols));
console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
for (const t of table) console.log(line(t));
console.log(`\n${maps} maps (${SEEDS} seeds x players ${PLAYERS.join('/')}) · generateMap avg ${(genMs / maps).toFixed(2)} ms, max ${genMax.toFixed(1)} ms`);
if (genMs / maps > LIMITS.genMs) failures.push(`average generateMap time ${(genMs / maps).toFixed(1)} ms`);
for (const f of failures.slice(0, 40)) console.log('FAIL ' + f);
if (failures.length > 40) console.log(`… and ${failures.length - 40} more`);
console.log(failures.length ? `\nFAIL (${failures.length} of ${maps})` : '\nPASS (100%)');
process.exit(failures.length ? 1 : 0);

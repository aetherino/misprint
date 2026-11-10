// Bot navigation on the arena's 1 m ground grid: A* with string-pulled waypoints.
//
// The grid dimensions come from map.nav, but walkability is rasterized here from the boxes, so bots
// also understand (a) regions the generator cut off from its "main" region and (b) low obstacles
// they can hop onto. Cell values: 0 blocked, 1 flat ground, 2 hop (a crate-height obstacle).
import { navIndex, navCenter } from '../shared/mapgen.js';
import { overlapsWorld } from '../shared/physics.js';
import { PLAYER } from '../shared/constants.js';

const SQRT2 = Math.SQRT2;
const WALL_COST = 0.7;      // extra cost for cells touching an obstacle, so paths keep a little clearance
const HOP_COST = 5;         // extra cost per hop cell: walk around when the detour is short
const STEP_MAX = 0.5;       // obstacles up to this height are just stepped over
const HOP_MAX = 1.3;        // obstacles up to this height can be jumped onto (single jump apex ≈ 1.4 m)
const BLOCKED = 99;
const PULL_WINDOW = 24;     // string pulling looks at most this many cells ahead (bounds the cost of long paths)

export function buildBotNav(map, world) {
  const src = map.nav;
  const { w, h, cell, ox, oz } = src;
  const pad = PLAYER.radius + 0.15;

  // tallest obstacle over each cell
  const top = new Float32Array(w * h);
  for (const b of map.boxes) {
    if (b.solid === false || b.kind === 'floor') continue;
    if (b.max[1] <= STEP_MAX || b.min[1] >= PLAYER.height) continue;        // steppable or overhead
    const height = b.min[1] <= 0.05 && b.max[1] <= HOP_MAX ? b.max[1] : BLOCKED;
    const x0 = Math.max(0, Math.floor((b.min[0] - pad - ox) / cell)), x1 = Math.min(w - 1, Math.floor((b.max[0] + pad - ox) / cell));
    const z0 = Math.max(0, Math.floor((b.min[2] - pad - oz) / cell)), z1 = Math.min(h - 1, Math.floor((b.max[2] + pad - oz) / cell));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) top[z * w + x] = Math.max(top[z * w + x], height);
  }
  const walk = new Uint8Array(w * h);
  for (let i = 0; i < walk.length; i++) {
    const [x, z] = navCenter(src, i);
    if (!overlapsWorld(world, x, -0.6, z, 0.2, 0.55)) continue;             // no ground under this cell
    walk[i] = src.walk[i] || top[i] === 0 ? 1 : top[i] < BLOCKED ? 2 : 0;
  }

  // connected regions (bots only ever path inside their own)
  const region = new Int32Array(w * h).fill(-1);
  const regionCells = [];
  for (let i = 0; i < walk.length; i++) {
    if (!walk[i] || region[i] !== -1) continue;
    const id = regionCells.length, flat = [], stack = [i];
    region[i] = id;
    while (stack.length) {
      const c = stack.pop();
      if (walk[c] === 1) flat.push(c);
      const cx = c % w, cz = (c / w) | 0;
      const visit = (n) => { if (walk[n] && region[n] === -1) { region[n] = id; stack.push(n); } };
      if (cx > 0) visit(c - 1);
      if (cx < w - 1) visit(c + 1);
      if (cz > 0) visit(c - w);
      if (cz < h - 1) visit(c + w);
    }
    regionCells.push(flat);
  }
  let main = 0;
  regionCells.forEach((cells, id) => { if (cells.length > regionCells[main].length) main = id; });

  const near = new Uint8Array(w * h);
  for (let i = 0; i < walk.length; i++) {
    if (!walk[i]) continue;
    const cx = i % w, cz = (i / w) | 0;
    for (let dz = -1; dz <= 1 && !near[i]; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= w || z >= h || walk[z * w + x] !== 1) { near[i] = 1; break; }
      }
    }
  }
  return {
    cell, w, h, ox, oz, walk, near, region, regionCells, main,
    g: new Float32Array(w * h), from: new Int32Array(w * h),
    seen: new Uint32Array(w * h), closed: new Uint32Array(w * h), stamp: 0,
  };
}

export function isWalkable(nav, x, z) {
  const i = navIndex(nav, x, z);
  return i >= 0 && nav.walk[i] === 1;
}

/** Index of the flat cell nearest to (x,z), searching outward ring by ring. −1 if none within `maxR` cells. */
export function nearestCell(nav, x, z, maxR = 12) {
  const cx = Math.min(nav.w - 1, Math.max(0, Math.floor((x - nav.ox) / nav.cell)));
  const cz = Math.min(nav.h - 1, Math.max(0, Math.floor((z - nav.oz) / nav.cell)));
  if (nav.walk[cz * nav.w + cx] === 1) return cz * nav.w + cx;
  for (let r = 1; r <= maxR; r++) {
    let best = -1, bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const ax = cx + dx, az = cz + dz;
        if (ax < 0 || az < 0 || ax >= nav.w || az >= nav.h) continue;
        const i = az * nav.w + ax;
        if (nav.walk[i] !== 1) continue;
        const [px, pz] = navCenter(nav, i);
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Region id under (x,z) — of the nearest flat cell when the point itself is off the grid. −1 if nowhere. */
export function regionAt(nav, x, z) {
  const i = nearestCell(nav, x, z);
  return i < 0 ? -1 : nav.region[i];
}

/** Random flat cell center in a region (default: the largest one). */
export function randomCell(nav, region = nav.main) {
  const cells = nav.regionCells[region] && nav.regionCells[region].length ? nav.regionCells[region] : nav.regionCells[nav.main];
  return cells && cells.length ? navCenter(nav, cells[Math.floor(Math.random() * cells.length)]) : [0, 0];
}

/**
 * Up to `n` open-ground points in the main region, as far from each other (and from `taken`
 * points) as possible. Used to invent spawn points when the map's own are unusable.
 */
export function spreadPoints(nav, n, taken = []) {
  const all = nav.regionCells[nav.main] || [];
  const open = all.filter((i) => !nav.near[i]);
  const pool = (open.length >= n ? open : all).map((i) => navCenter(nav, i));
  const chosen = taken.map((p) => [p[0], p[1]]);
  const out = [];
  while (out.length < n && pool.length) {
    let best = 0, bestD = -1;
    for (let i = 0; i < pool.length; i++) {
      let d = Math.hypot(pool[i][0], pool[i][1]) * 0.5;                    // first pick: away from the center
      if (chosen.length) d = Math.min(...chosen.map((c) => Math.hypot(c[0] - pool[i][0], c[1] - pool[i][1])));
      if (d > bestD) { bestD = d; best = i; }
    }
    const [p] = pool.splice(best, 1);
    chosen.push(p);
    out.push(p);
  }
  return out;
}

/** True when a body can walk the straight segment on flat ground (no hops). */
export function lineWalkable(nav, x0, z0, x1, z1) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(len / 0.3));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!isWalkable(nav, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false;
  }
  return true;
}

// Binary min-heap of cell indices keyed by f-score.
class Heap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop(), key = keys.pop();
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = id; keys[i] = key;
    }
    return top;
  }
}

const NEIGHBORS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

/**
 * Waypoints ([x,z] list, start excluded) from `from` to `to`, or null when unreachable.
 * The last waypoint is `to` itself when its cell is flat ground, otherwise the nearest flat cell center.
 * Paths may cross hop cells; those are never string-pulled, so the bot arrives square-on and jumps.
 */
export function findPath(nav, from, to) {
  const start = nearestCell(nav, from[0], from[1]);
  const goal = nearestCell(nav, to[0], to[1]);
  if (start < 0 || goal < 0 || nav.region[start] !== nav.region[goal]) return null;
  const { w, h, walk, near, g, from: came, seen, closed } = nav;
  const stamp = ++nav.stamp;
  const gx = goal % w, gz = (goal / w) | 0;
  const heur = (i) => {
    const dx = Math.abs((i % w) - gx), dz = Math.abs(((i / w) | 0) - gz);
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
  };

  const open = new Heap();
  g[start] = 0; came[start] = -1; seen[start] = stamp;
  open.push(start, heur(start));
  let found = false;
  while (open.size) {
    const c = open.pop();
    if (c === goal) { found = true; break; }
    if (closed[c] === stamp) continue;
    closed[c] = stamp;
    const cx = c % w, cz = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const dx = NEIGHBORS[k][0], dz = NEIGHBORS[k][1];
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= w || z >= h) continue;
      const n = z * w + x;
      if (!walk[n] || closed[n] === stamp) continue;
      if (dx && dz && (!walk[cz * w + x] || !walk[z * w + cx])) continue;   // no corner cutting
      const cost = g[c] + NEIGHBORS[k][2] + (walk[n] === 2 ? HOP_COST : near[n] ? WALL_COST : 0);
      if (seen[n] !== stamp || cost < g[n]) {
        g[n] = cost; came[n] = c; seen[n] = stamp;
        open.push(n, cost + heur(n));
      }
    }
  }
  if (!found) return null;

  const raw = [];
  for (let c = goal; c !== -1; c = came[c]) raw.push(navCenter(nav, c));
  raw.reverse();
  raw[0] = isWalkable(nav, from[0], from[1]) ? [from[0], from[1]] : raw[0];
  if (navIndex(nav, to[0], to[1]) === goal) raw[raw.length - 1] = [to[0], to[1]];

  // String pulling: skip every waypoint that can be reached in a straight walkable line.
  const out = [];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    let next = anchor + 1;
    for (let j = Math.min(raw.length - 1, anchor + PULL_WINDOW); j > anchor + 1; j--) {
      if (lineWalkable(nav, raw[anchor][0], raw[anchor][1], raw[j][0], raw[j][1])) { next = j; break; }
    }
    out.push(raw[next]);
    anchor = next;
  }
  if (!out.length) out.push(raw[raw.length - 1]);
  return out;
}

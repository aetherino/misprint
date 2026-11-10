// MISPRINT — shared collision world. The whole arena is axis-aligned boxes, which keeps
// collision cheap, deterministic and identical on server (bots, validation) and client (movement).
//
// Bodies are upright AABBs described by FEET position `pos` [x,y,z] (bottom center),
// half-width `r` and height `h`.

const CELL = 4;
const KEY = (cx, cz) => (cx + 2048) * 4096 + (cz + 2048);

export function createWorld(map) {
  const boxes = map.boxes.filter((b) => b.solid !== false);
  const grid = new Map();
  boxes.forEach((b, i) => {
    const x0 = Math.floor(b.min[0] / CELL), x1 = Math.floor(b.max[0] / CELL);
    const z0 = Math.floor(b.min[2] / CELL), z1 = Math.floor(b.max[2] / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = KEY(x, z);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(i);
      }
    }
  });
  return { map, boxes, grid, stamp: new Uint32Array(boxes.length), tick: 0, scratch: [] };
}

// Collect boxes whose XZ footprint may touch the given rectangle (unique).
function query(world, minx, minz, maxx, maxz) {
  const out = world.scratch;
  out.length = 0;
  const t = ++world.tick;
  const x0 = Math.floor(minx / CELL), x1 = Math.floor(maxx / CELL);
  const z0 = Math.floor(minz / CELL), z1 = Math.floor(maxz / CELL);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const arr = world.grid.get(KEY(x, z));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const bi = arr[i];
        if (world.stamp[bi] !== t) {
          world.stamp[bi] = t;
          out.push(world.boxes[bi]);
        }
      }
    }
  }
  return out;
}

// Overlap must exceed EPS: a body resting flush against a face (pos = face ± r) can come out a few
// ulps "inside" after rounding (1.4 - 0.4 < 1), and must not count as penetrating that box.
const EPS = 1e-6;
function hits(b, x, y, z, r, h) {
  return x - r < b.max[0] - EPS && x + r > b.min[0] + EPS &&
         y < b.max[1] - EPS && y + h > b.min[1] + EPS &&
         z - r < b.max[2] - EPS && z + r > b.min[2] + EPS;
}

// Is a body at feet position (x,y,z) overlapping any solid box?
export function overlapsWorld(world, x, y, z, r, h) {
  const c = query(world, x - r, z - r, x + r, z + r);
  for (let i = 0; i < c.length; i++) if (hits(c[i], x, y, z, r, h)) return true;
  return false;
}

/**
 * Move a body through the world with collide-and-slide (axis separated) and step-up.
 * Mutates `pos` and `vel` ([x,y,z] arrays).
 * opts.step: step height allowed this move (pass MOVE.stepHeight when grounded, 0 in air).
 * Returns { onGround, ceiling, wallX, wallZ, stepped }
 *   wallX / wallZ: -1 | 0 | 1 — sign of the contact NORMAL on that axis (0 = no contact).
 *   stepped: meters the body was lifted by step-up (for camera smoothing).
 */
export function moveBody(world, pos, vel, r, h, dt, opts = {}) {
  const res = { onGround: false, ceiling: false, wallX: 0, wallZ: 0, stepped: 0 };
  const stepH = opts.step || 0;
  const dx = vel[0] * dt, dy = vel[1] * dt, dz = vel[2] * dt;
  const n = Math.min(10, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.25)));
  for (let s = 0; s < n; s++) {
    if (vel[0] !== 0) axisMove(world, pos, vel, r, h, 0, dx / n, res, stepH);
    if (vel[2] !== 0) axisMove(world, pos, vel, r, h, 2, dz / n, res, stepH);
    if (vel[1] !== 0) axisMove(world, pos, vel, r, h, 1, dy / n, res, 0);
  }
  return res;
}

function axisMove(world, pos, vel, r, h, axis, delta, res, stepH) {
  if (delta === 0) return;
  pos[axis] += delta;
  const c = query(world, pos[0] - r, pos[2] - r, pos[0] + r, pos[2] + r);
  for (let i = 0; i < c.length; i++) {
    const b = c[i];
    if (!hits(b, pos[0], pos[1], pos[2], r, h)) continue;
    if (axis === 1) {
      if (delta < 0) { pos[1] = b.max[1]; res.onGround = true; res.ground = b; }
      else { pos[1] = b.min[1] - h; res.ceiling = true; }
      vel[1] = 0;
    } else {
      // step-up onto low ledges
      const rise = b.max[1] - pos[1];
      if (stepH > 0 && rise > 0 && rise <= stepH && !overlapsWorldNoQuery(c, pos[0], b.max[1], pos[2], r, h)) {
        pos[1] = b.max[1];
        res.stepped += rise;
        continue;
      }
      if (delta > 0) pos[axis] = b.min[axis] - r; else pos[axis] = b.max[axis] + r;
      if (axis === 0) res.wallX = delta > 0 ? -1 : 1; else res.wallZ = delta > 0 ? -1 : 1;
      vel[axis] = 0;
    }
  }
}

function overlapsWorldNoQuery(c, x, y, z, r, h) {
  for (let i = 0; i < c.length; i++) if (hits(c[i], x, y, z, r, h)) return true;
  return false;
}

// Ray vs AABB (slab). Returns entry distance t >= 0 or -1. If outNormal given, writes face normal.
export function rayAABB(o, d, min, max, outNormal) {
  let tmin = 0, tmax = Infinity, axis = -1, sign = 0;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < min[a] || o[a] > max[a]) return -1;
    } else {
      const inv = 1 / d[a];
      let t1 = (min[a] - o[a]) * inv, t2 = (max[a] - o[a]) * inv, s = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  if (outNormal) {
    outNormal[0] = outNormal[1] = outNormal[2] = 0;
    if (axis >= 0) outNormal[axis] = sign;
  }
  return tmin;
}

// Ray vs sphere. Returns nearest t >= 0 or -1.
export function raySphere(o, d, c, radius) {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - radius * radius;
  if (cc > 0 && b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

const _n = [0, 0, 0];
/**
 * Raycast against the static world. `d` must be normalized.
 * Returns null or { t, point:[x,y,z], normal:[x,y,z], box }.
 */
export function raycast(world, o, d, maxDist = 1000) {
  let best = maxDist, bestBox = null, bn = [0, 0, 0];
  const boxes = world.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const t = rayAABB(o, d, b.min, b.max, _n);
    if (t >= 0 && t < best) {
      best = t; bestBox = b; bn[0] = _n[0]; bn[1] = _n[1]; bn[2] = _n[2];
    }
  }
  if (!bestBox) return null;
  return { t: best, point: [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best], normal: bn, box: bestBox };
}

// Line of sight between two points (true when nothing solid is in between).
export function segmentClear(world, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const d = [dx / len, dy / len, dz / len];
  const boxes = world.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const t = rayAABB(a, d, boxes[i].min, boxes[i].max);
    if (t >= 0 && t < len) return false;
  }
  return true;
}

// Reflect direction d about normal n (both arrays), returns new array.
export function reflect(d, n) {
  const k = 2 * (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
  return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]];
}

/**
 * Deterministic bouncing-projectile step (Blotter ink bombs). Mutates p.pos / p.vel / p.bounces / p.age.
 * p: { pos:[3], vel:[3], bounces:int (remaining), age:sec }
 * Returns 'fly' | 'bounce' | 'explode'. Caller also explodes on player contact or when age >= fuse.
 */
export function stepProjectile(world, p, gravity, dt, restitution = 0.55) {
  p.age += dt;
  p.vel[1] -= gravity * dt;
  const len = Math.hypot(p.vel[0], p.vel[1], p.vel[2]) * dt;
  if (len < 1e-6) return 'fly';
  const inv = 1 / (len / dt);
  const d = [p.vel[0] * inv, p.vel[1] * inv, p.vel[2] * inv];
  const hit = raycast(world, p.pos, d, len);
  if (!hit) {
    p.pos[0] += p.vel[0] * dt; p.pos[1] += p.vel[1] * dt; p.pos[2] += p.vel[2] * dt;
    return 'fly';
  }
  p.pos[0] = hit.point[0] + hit.normal[0] * 0.02;
  p.pos[1] = hit.point[1] + hit.normal[1] * 0.02;
  p.pos[2] = hit.point[2] + hit.normal[2] * 0.02;
  p.lastNormal = hit.normal;
  if (p.bounces <= 0) return 'explode';
  p.bounces--;
  const r = reflect(p.vel, hit.normal);
  p.vel[0] = r[0] * restitution; p.vel[1] = r[1] * restitution; p.vel[2] = r[2] * restitution;
  return 'bounce';
}

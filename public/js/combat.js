// Shot tracing (client-side hit detection, shooter-favored), shot rendering and explosions.
import { PLAYER, F } from '/shared/constants.js';
import { raycast, raySphere, rayAABB, reflect } from '/shared/physics.js';
import { clamp, netVec } from './util.js';

const CROUCHING = F.CROUCH | F.SLIDE;
const HEAD_DROP = PLAYER.height - PLAYER.headCenter;   // head center below the top of the hull
const _head = [0, 0, 0], _min = [0, 0, 0], _max = [0, 0, 0];
const _near = { id: null, t: 0, hs: 0 };

/** Hull height of a remote player as currently rendered. */
export const remoteHeight = (e) => ((e.view.flags & CROUCHING ? PLAYER.crouchHeight : PLAYER.height) * e.scale);

// Nearest living remote player along the ray within maxDist → _near. Players are tested where they
// are DRAWN (interpolated), so what you see is what you hit. Any ray through the head sphere is a headshot.
function nearestPlayer(G, o, d, maxDist) {
  _near.id = null; _near.t = maxDist; _near.hs = 0;
  const headMul = G.me.stats.headScale;
  const list = G.remotes.list;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.view.alive) continue;
    const p = e.view.pos, s = e.scale, r = PLAYER.radius * s, h = remoteHeight(e);
    _head[0] = p[0]; _head[1] = p[1] + h - HEAD_DROP * s; _head[2] = p[2];
    _min[0] = p[0] - r; _min[1] = p[1]; _min[2] = p[2] - r;
    _max[0] = p[0] + r; _max[1] = p[1] + h; _max[2] = p[2] + r;
    const th = raySphere(o, d, _head, PLAYER.headRadius * s * headMul);
    const tb = rayAABB(o, d, _min, _max);
    const t = th >= 0 && tb >= 0 ? Math.min(th, tb) : Math.max(th, tb);
    if (t >= 0 && t < _near.t) { _near.id = e.id; _near.t = t; _near.hs = th >= 0 ? 1 : 0; }
  }
}

/**
 * Trace one pellet from `origin` along unit `dir`.
 * Returns { e:[3] end point, n:[3]|null surface normal, id:targetId|null, hs:0|1, via:[[3]…]|null ricochets }.
 */
export function traceShot(G, origin, dir, range, bounces) {
  const shot = { e: null, n: null, id: null, hs: 0, via: null };
  let o = origin, d = dir, left = range;
  for (;;) {
    const wall = raycast(G.world, o, d, left);
    nearestPlayer(G, o, d, wall ? wall.t : left);
    if (_near.id !== null) {
      shot.e = [o[0] + d[0] * _near.t, o[1] + d[1] * _near.t, o[2] + d[2] * _near.t];
      shot.id = _near.id;
      shot.hs = _near.hs;
      return shot;
    }
    if (!wall) {
      shot.e = [o[0] + d[0] * left, o[1] + d[1] * left, o[2] + d[2] * left];
      return shot;
    }
    if (bounces <= 0) {
      shot.e = wall.point;
      shot.n = wall.normal;
      return shot;
    }
    bounces--;
    left -= wall.t;
    (shot.via ||= []).push(wall.point);
    d = reflect(d, wall.normal);
    o = [wall.point[0] + wall.normal[0] * 0.01, wall.point[1] + wall.normal[1] * 0.01, wall.point[2] + wall.normal[2] * 0.01];
  }
}

/** Wire form of a traced pellet for the `fire` message. */
export function shotToNet(shot) {
  const out = { e: netVec(shot.e), n: shot.n, id: shot.id, hs: shot.hs };
  if (shot.via) out.via = shot.via.map(netVec);
  return out;
}

const _n = [0, 0, 0];
// Surface normal at a ricochet point, recovered from the in/out directions (out − in ∝ normal).
function bounceNormal(a, p, b) {
  const l1 = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]) || 1;
  const l2 = Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) || 1;
  for (let i = 0; i < 3; i++) _n[i] = (b[i] - p[i]) / l2 - (p[i] - a[i]) / l1;
  const len = Math.hypot(_n[0], _n[1], _n[2]);
  if (len < 1e-4) { _n[0] = 0; _n[1] = 1; _n[2] = 0; return _n; }
  _n[0] /= len; _n[1] /= len; _n[2] /= len;
  return _n;
}

/**
 * Draw one pellet (local or relayed): tracer segments through its ricochets, then the impact.
 * `splashPlayer`: also burst ink on a player hit (local prediction; relayed shots get theirs from `hit`).
 */
export function drawShot(G, from, shot, color, weaponId, splashPlayer) {
  const fx = G.R.fx;
  let a = from;
  if (shot.via) {
    for (let i = 0; i < shot.via.length; i++) {
      const p = shot.via[i];
      fx.tracer(a, p, color, weaponId);
      fx.impact(p, bounceNormal(a, p, shot.via[i + 1] || shot.e), color, weaponId);
      G.A.play('ricochet', { pos: p, vol: 0.6 });
      a = p;
    }
  }
  fx.tracer(a, shot.e, color, weaponId);
  if (shot.id !== null && shot.id !== undefined) {
    if (splashPlayer) fx.hitPlayer(shot.e, color, !!shot.hs);
  } else if (shot.n) {
    fx.impact(shot.e, shot.n, color, weaponId);
  }
}

/**
 * An explosion at `p`: visuals, sound, camera shake by distance and (when `knock` > 0) knockback
 * on the local player — which is what makes blast-jumping work.
 */
export function blast(G, p, radius, color, knock) {
  G.R.fx.explosion(p, radius, color);
  G.A.play('explode', { pos: p });
  if (!G.me.alive) return;
  const m = G.mover;
  const dx = m.pos[0] - p[0], dy = m.pos[1] + m.height * 0.5 - p[1], dz = m.pos[2] - p[2];
  const d = Math.hypot(dx, dy, dz);
  const shake = clamp(1 - d / (radius * 3), 0, 1);
  if (shake > 0) G.R.fx.shake(shake * 0.9);
  if (knock <= 0 || d >= radius) return;
  const k = knock * (0.35 + 0.65 * (1 - d / radius));
  if (d > 0.05) m.impulse((dx / d) * k, (dy / d) * k, (dz / d) * k);
  else m.impulse(0, k, 0);
}

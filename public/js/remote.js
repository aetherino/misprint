// Remote players: roster → renderer bookkeeping, snapshot buffering and the interpolated state
// that is drawn (and shot at) each frame.
import { F, PLAYER } from '/shared/constants.js';
import { lerp, lerpAngle } from './util.js';

const INTERP_DELAY = 100;     // ms behind the freshest snapshot
const MAX_EXTRAPOLATE = 150;  // ms of dead reckoning when snapshots stop arriving
const BUFFER = 24;
const TELEPORT_SQ = 10 * 10;  // a jump this large between two snapshots is a teleport, not motion
const FOOTSTEP_RANGE_SQ = 28 * 28;
const FOOTSTEP_STRIDE = 2.6;

export function createRemotes(G) {
  const byId = new Map();
  const list = [];

  function makeEntry(p) {
    return {
      id: p.id, name: p.name, color: p.color, face: p.face,
      scale: 1, maxHp: 100, hp: 100, stride: 0,
      buf: [],     // snapshots { t, x, y, z, yaw, pitch, flags, weapon }, oldest first
      view: { pos: [0, 0, 0], yaw: 0, pitch: 0, vel: [0, 0, 0], flags: 0, weapon: 0, alive: false, scale: 1, headScale: 1, ghost: false, hpFrac: 1 },
    };
  }

  function push(e, t, x, y, z, yaw, pitch, flags, weapon) {
    const s = e.buf.length >= BUFFER ? e.buf.shift() : {};
    s.t = t; s.x = x; s.y = y; s.z = z; s.yaw = yaw; s.pitch = pitch; s.flags = flags; s.weapon = weapon;
    e.buf.push(s);
  }

  function setVelocity(v, a, b) {
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) { v.vel[0] = v.vel[1] = v.vel[2] = 0; return; }
    v.vel[0] = (b.x - a.x) / dt; v.vel[1] = (b.y - a.y) / dt; v.vel[2] = (b.z - a.z) / dt;
  }

  // Fill e.view from the snapshot buffer at render time `rt` (server ms).
  function sampleAt(e, rt) {
    const buf = e.buf, v = e.view;
    let i = buf.length - 1;
    while (i > 0 && buf[i].t > rt) i--;
    const a = buf[i], b = buf[i + 1];
    let src = a;
    if (b && rt >= a.t) {
      const jump = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2;
      if (jump > TELEPORT_SQ) {
        src = b;
        v.pos[0] = b.x; v.pos[1] = b.y; v.pos[2] = b.z;
        v.yaw = b.yaw; v.pitch = b.pitch;
        v.vel[0] = v.vel[1] = v.vel[2] = 0;
      } else {
        const k = (rt - a.t) / (b.t - a.t);
        v.pos[0] = lerp(a.x, b.x, k); v.pos[1] = lerp(a.y, b.y, k); v.pos[2] = lerp(a.z, b.z, k);
        v.yaw = lerpAngle(a.yaw, b.yaw, k);
        v.pitch = lerp(a.pitch, b.pitch, k);
        setVelocity(v, a, b);
      }
    } else {
      // newest (or only) sample: dead-reckon a little past it, then hold
      const before = buf[i - 1];
      v.pos[0] = a.x; v.pos[1] = a.y; v.pos[2] = a.z;
      v.yaw = a.yaw; v.pitch = a.pitch;
      v.vel[0] = v.vel[1] = v.vel[2] = 0;
      if (!b && before && rt > a.t && (a.x - before.x) ** 2 + (a.y - before.y) ** 2 + (a.z - before.z) ** 2 < TELEPORT_SQ) {
        setVelocity(v, before, a);
        const ahead = Math.min(rt - a.t, MAX_EXTRAPOLATE) / 1000;
        v.pos[0] += v.vel[0] * ahead; v.pos[1] += v.vel[1] * ahead; v.pos[2] += v.vel[2] * ahead;
      }
    }
    v.flags = src.flags;
    v.weapon = src.weapon;
  }

  function footsteps(e, dt) {
    const v = e.view;
    if (!(v.flags & F.GROUND) || v.flags & (F.SLIDE | F.GHOST)) return;
    const speed = Math.hypot(v.vel[0], v.vel[2]);
    if (speed < 3) return;
    e.stride += speed * dt;
    if (e.stride < FOOTSTEP_STRIDE) return;
    e.stride = 0;
    const eye = G.rig.eye;
    if ((v.pos[0] - eye[0]) ** 2 + (v.pos[1] - eye[1]) ** 2 + (v.pos[2] - eye[2]) ** 2 < FOOTSTEP_RANGE_SQ) {
      G.A.play('footstep', { pos: v.pos, vol: 0.55 });
    }
  }

  return {
    list,
    get: (id) => byId.get(id),

    /** Reconcile with the roster (Map id → player). The local player is never added. */
    sync(players) {
      for (const p of players.values()) {
        if (p.id === G.state.id) continue;
        let e = byId.get(p.id);
        if (!e) {
          e = makeEntry(p);
          byId.set(p.id, e);
          list.push(e);
          G.R.addPlayer(p.id, { name: p.name, color: p.color, face: p.face, isBot: p.isBot });
        } else if (e.name !== p.name || e.color !== p.color || e.face !== p.face) {
          e.name = p.name; e.color = p.color; e.face = p.face;
          G.R.setPlayerInfo(p.id, { name: p.name, color: p.color, face: p.face, isBot: p.isBot });
        }
        e.scale = p.stats.scale;
        e.maxHp = p.stats.maxHp;
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (players.has(e.id) && e.id !== G.state.id) continue;
        G.R.removePlayer(e.id);
        byId.delete(e.id);
        list.splice(i, 1);
      }
    },

    /** A `snap` row of another player. Snapshots only list the living, so a row also means "alive". */
    onSnap(t, row) {
      const e = byId.get(row[0]);
      if (!e) return;
      push(e, t, row[1], row[2], row[3], row[4], row[5], row[6], row[7]);
      e.hp = row[8];
      e.view.alive = true;
    },

    /** Hard position change (spawn, rewind): never interpolate across it. */
    place(id, pos, yaw) {
      const e = byId.get(id);
      if (!e) return;
      const last = e.buf[e.buf.length - 1];
      const pitch = last ? last.pitch : 0, weapon = last ? last.weapon : 0;
      e.buf.length = 0;
      push(e, G.net.serverNow(), pos[0], pos[1], pos[2], yaw ?? (last ? last.yaw : 0), pitch, F.GROUND, weapon);
    },

    setAlive(id, alive) {
      const e = byId.get(id);
      if (e) e.view.alive = alive;
    },

    /** World position a remote player's shots visibly come from. */
    muzzle(e, out) {
      const v = e.view, s = e.scale;
      const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
      const up = (v.flags & (F.CROUCH | F.SLIDE) ? PLAYER.crouchEye : PLAYER.eye) * s * 0.85;
      out[0] = v.pos[0] + (cy * 0.24 - sy * 0.5) * s;
      out[1] = v.pos[1] + up;
      out[2] = v.pos[2] + (-sy * 0.24 - cy * 0.5) * s;
      return out;
    },

    update(dt) {
      const rt = G.net.serverNow() - INTERP_DELAY;
      const headScale = G.me.stats.headScale;
      for (let i = 0; i < list.length; i++) {
        const e = list[i], v = e.view;
        if (e.buf.length) sampleAt(e, rt);
        v.scale = e.scale;
        v.headScale = headScale;
        v.ghost = (v.flags & F.GHOST) !== 0;
        v.hpFrac = e.maxHp > 0 ? Math.min(1, e.hp / e.maxHp) : 1;
        if (v.alive) footsteps(e, dt);
        G.R.updatePlayer(e.id, v);
      }
    },
  };
}

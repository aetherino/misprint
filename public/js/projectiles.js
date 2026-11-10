// Blotter ink bombs. Every client simulates the same bounce path with shared `stepProjectile`;
// only the shooter decides when and where a bomb bursts (and tells everyone with `boom`).
import { PLAYER } from '/shared/constants.js';
import { WEAPONS } from '/shared/weapons.js';
import { raycast, stepProjectile } from '/shared/physics.js';
import { blast, remoteHeight } from './combat.js';
import { netVec, round2, dist3 } from './util.js';

const BLOTTER = WEAPONS[3];
const MUZZLE_AHEAD = 0.5;      // bombs start this far in front of the eye
const ORPHAN_GRACE = 1;        // a relayed bomb whose `boom` never arrives is dropped this long after its fuse
const _center = [0, 0, 0];

export function createProjectiles(G) {
  const live = [];             // { rid, owner, pid, mine, color, pos, vel, bounces, age }
  let nextPid = 1, nextRid = 1;

  function add(owner, pid, o, vel, color) {
    const p = { rid: nextRid++, owner, pid, mine: owner === G.state.id, color, pos: o.slice(), vel: vel.slice(), bounces: BLOTTER.bounces, age: 0 };
    live.push(p);
    G.R.projectile.spawn(p.rid, color);
    G.R.projectile.move(p.rid, p.pos);
    return p;
  }

  function removeAt(i) {
    G.R.projectile.remove(live[i].rid);
    live.splice(i, 1);
  }

  function touchesPlayer(p) {
    const list = G.remotes.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.view.alive) continue;
      const q = e.view.pos, r = PLAYER.radius * e.scale + BLOTTER.projRadius;
      if (Math.abs(p.pos[0] - q[0]) < r && Math.abs(p.pos[2] - q[2]) < r &&
          p.pos[1] > q[1] - BLOTTER.projRadius && p.pos[1] < q[1] + remoteHeight(e) + BLOTTER.projRadius) return true;
    }
    return false;
  }

  // My bomb bursts: report everyone in range (distance to body center, self included).
  function explode(p) {
    const radius = BLOTTER.radius * G.me.stats.splashRadius;
    const hits = [];
    const m = G.mover;
    if (G.me.alive) {
      _center[0] = m.pos[0]; _center[1] = m.pos[1] + m.height * 0.5; _center[2] = m.pos[2];
      const d = dist3(p.pos, _center);
      if (d < radius) hits.push({ id: G.state.id, d: round2(d) });
    }
    for (const e of G.remotes.list) {
      if (!e.view.alive) continue;
      _center[0] = e.view.pos[0]; _center[1] = e.view.pos[1] + remoteHeight(e) * 0.5; _center[2] = e.view.pos[2];
      const d = dist3(p.pos, _center);
      if (d < radius) hits.push({ id: e.id, d: round2(d) });
    }
    G.net.send({ t: 'boom', pid: p.pid, p: netVec(p.pos), hits });
    blast(G, p.pos, radius, p.color, BLOTTER.splashKnock);
  }

  return {
    get count() { return live.length; },

    /** Local player fires a bomb from the eye along unit `dir`. */
    launch(eye, dir) {
      // start in front of the eye unless a wall is closer than that
      const wall = raycast(G.world, eye, dir, MUZZLE_AHEAD + BLOTTER.projRadius);
      const ahead = wall ? Math.max(0, wall.t - BLOTTER.projRadius) : MUZZLE_AHEAD;
      const o = netVec([eye[0] + dir[0] * ahead, eye[1] + dir[1] * ahead, eye[2] + dir[2] * ahead]);
      const vel = netVec([dir[0] * BLOTTER.speed, dir[1] * BLOTTER.speed, dir[2] * BLOTTER.speed]);
      const p = add(G.state.id, nextPid++, o, vel, G.me.color);
      G.net.send({ t: 'proj', pid: p.pid, o, vel });
    },

    /** Relayed `proj`: someone else's bomb. */
    onProj(msg) {
      const owner = G.players.get(msg.id);
      add(msg.id, msg.pid, msg.o, msg.vel, owner ? owner.color : 0);
    },

    /** Relayed `boom`: remove that bomb and show the burst where the shooter says it happened. */
    onBoom(msg) {
      const i = live.findIndex((p) => p.owner === msg.id && p.pid === msg.pid);
      const owner = G.players.get(msg.id);
      if (i >= 0) removeAt(i);
      blast(G, msg.p, msg.r, owner ? owner.color : 0, BLOTTER.splashKnock);
    },

    step(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        const state = stepProjectile(G.world, p, BLOTTER.gravity, dt);
        if (state === 'bounce') G.A.play('bounce', { pos: p.pos });
        if (p.mine) {
          if (state === 'explode' || p.age >= BLOTTER.fuse || touchesPlayer(p)) {
            explode(p);
            removeAt(i);
          }
        } else if (p.age >= BLOTTER.fuse + ORPHAN_GRACE) {
          removeAt(i);
        } else if (state === 'explode') {
          p.vel[0] = p.vel[1] = p.vel[2] = 0;   // rest where it landed until the owner's boom arrives
        }
      }
    },

    /** Push current positions to the renderer (once per frame). */
    draw() {
      for (let i = 0; i < live.length; i++) G.R.projectile.move(live[i].rid, live[i].pos);
    },

    clear() {
      for (let i = live.length - 1; i >= 0; i--) removeAt(i);
    },
  };
}

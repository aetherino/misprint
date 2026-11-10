// The local player: turns input into movement, drives weapons and Rewind, reports state to the
// server, and gives every movement event its sound / effect / relay.
import { MOVE, F, TICK_HZ, TIMING, PHASE } from '/shared/constants.js';
import { createMover, STEP } from './movement.js';
import { createRewind } from './rewind.js';
import { PITCH_LIMIT } from './camera.js';
import { clamp, netVec, r3 } from './util.js';

const LOOK_SCALE = 0.0012;       // radians per mouse count at sensitivity 1 (~0.07°, close to common FPS defaults)
const ST_INTERVAL = 1 / TICK_HZ;
const PICKUP_REACH = 1.4;        // meters from body center
const PICKUP_RETRY = 0.25;
const LAND_SOUND_SPEED = 4;      // softer landings are silent
const LAND_RELAY_SPEED = 9;      // only real impacts are worth telling everyone about
const GHOST_STILL_SPEED = 0.6;

export function createLocalPlayer(G) {
  const { R, A, me } = G;
  const m = createMover(onMove);
  const rewind = createRewind();
  G.mover = m;
  G.rewind = rewind;
  m.setStats(me.stats);

  let stAcc = 0, pickupWait = 0, flags = 0;
  const center = [0, 0, 0];

  const relay = (k) => G.net.send({ t: 'ev', k, p: netVec(m.pos) });

  function onMove(kind, data) {
    switch (kind) {
      case 'jump': A.play('jump'); relay('jump'); break;
      case 'airjump': A.play('airjump'); relay('jump'); break;
      case 'walljump': A.play('walljump'); relay('walljump'); break;
      case 'land':
        G.rig.land(data);
        if (data >= LAND_SOUND_SPEED) A.play('land', { vol: clamp(data / 16, 0.3, 1) });
        if (data >= LAND_RELAY_SPEED) relay('land');
        break;
      case 'dash': A.play('dash'); G.rig.dashKick(); relay('dash'); break;
      case 'slide': A.play('slide_start'); break;
      case 'step': A.play('footstep', { vol: 0.45, pitch: 0.92 + Math.random() * 0.16 }); break;
      case 'pad':
        A.play('jumppad');
        R.fx.ring([(data.min[0] + data.max[0]) / 2, data.min[1], (data.min[2] + data.max[2]) / 2], me.color, 'jumppad');
        relay('pad');
        break;
      case 'fell': G.net.send({ t: 'fell' }); break;
      default:
    }
  }

  function computeFlags() {
    let f = 0;
    if (m.onGround) f |= F.GROUND;
    if (m.crouched) f |= F.CROUCH;
    if (m.sliding) f |= F.SLIDE;
    const side = m.wallSide();
    if (side < 0) f |= F.WALL_L; else if (side > 0) f |= F.WALL_R;
    if (m.dashT > 0) f |= F.DASH;
    if (G.weapons.reloading) f |= F.RELOAD;
    if (G.weapons.charging) f |= F.CHARGE;
    if (me.stats.ghost && (m.crouched || m.hSpeed() < GHOST_STILL_SPEED)) f |= F.GHOST;
    return f;
  }

  function startRewind() {
    if (rewind.cooldown > 0 || m.frozen || !rewind.begin(m)) return;
    rewind.cooldown = MOVE.rewindCooldown * me.stats.rewindCooldown;
    G.weapons.interrupt();
    A.play('rewind');
    R.fx.flash('rewind');
    R.fx.ring(m.pos.slice(), me.color, 'rewind');
  }

  function touchPickups(dt) {
    pickupWait -= dt;
    if (pickupWait > 0) return;
    center[0] = m.pos[0]; center[1] = m.pos[1] + m.height * 0.5; center[2] = m.pos[2];
    const list = G.state.pickups;
    for (let i = 0; i < list.length; i++) {
      const pk = list[i];
      if (!pk.active || (pk.type === 'health' && me.hp >= me.stats.maxHp)) continue;   // the server refuses health at full hp
      const dx = pk.pos[0] - center[0], dy = pk.pos[1] - center[1], dz = pk.pos[2] - center[2];
      if (dx * dx + dy * dy + dz * dz > PICKUP_REACH * PICKUP_REACH) continue;
      G.net.send({ t: 'pickup', id: pk.id });
      pickupWait = PICKUP_RETRY;
      return;
    }
  }

  const local = {
    /** True while the player has a body to drive. */
    get control() { return me.alive && G.inArena(); },
    get flags() { return flags; },

    /** Once per frame, before the fixed steps: mouse look and one-shot presses. */
    begin(inp) {
      const sens = G.options.sensitivity * LOOK_SCALE;
      m.yaw -= inp.lookX * sens;
      m.pitch = clamp(m.pitch - inp.lookY * sens * (G.options.invertY ? -1 : 1), -PITCH_LIMIT, PITCH_LIMIT);
      m.frozen = G.state.phase !== PHASE.PLAYING;
      if (inp.pressed.jump) m.queueJump();
      if (inp.pressed.dash) m.queueDash();
      if (inp.pressed.rewind) startRewind();
    },

    /** One fixed simulation step. */
    step(inp) {
      if (rewind.active) {
        if (rewind.step(m, STEP)) {
          G.net.send({ t: 'rewind', p: netVec(m.pos) });
          R.fx.ring(m.pos.slice(), me.color, 'rewind');
        }
      } else {
        m.step(inp, STEP);
        rewind.record(m, STEP);
      }
    },

    /** Once per frame, after the camera pose is final: weapons, pickups, state upload. */
    finish(dt, inp) {
      rewind.cooldown = Math.max(0, rewind.cooldown - dt);
      G.weapons.update(dt, inp, !m.frozen && !rewind.active);
      touchPickups(dt);
      flags = computeFlags();
      stAcc += dt;
      if (stAcc >= ST_INTERVAL) {
        stAcc %= ST_INTERVAL;
        G.net.send({ t: 'st', p: netVec(m.pos), yaw: r3(m.yaw), pitch: r3(m.pitch), v: netVec(m.vel), f: flags, w: G.weapons.cur });
      }
    },

    /** Server `spawn` for the local player. */
    spawn(msg) {
      me.alive = true;
      me.hp = msg.hp;
      m.setStats(me.stats);
      m.spawn(msg.p, msg.yaw);
      rewind.clear();
      rewind.active = false;
      rewind.cooldown = 0;
      G.weapons.reset();
      G.rig.reset();
      G.rig.mode = 'fp';
      R.view.setVisible(true);
      R.fx.ring(msg.p, me.color, 'spawn');
      A.play('spawn');
    },

    /** The local player died. `killer` is a roster entry or null (environment). */
    die(killer) {
      me.alive = false;
      me.hp = 0;
      me.respawnAt = G.time + TIMING.respawn;
      me.killerName = killer ? killer.name : '';
      rewind.active = false;
      G.weapons.interrupt();
      // below the arena there is nothing to look at: fall back to the overview
      G.rig.startDeath(killer && killer.id !== G.state.id ? killer.id : null);
      G.rig.mode = m.pos[1] < -5 ? 'orbit' : 'death';
      R.view.setVisible(false);
      A.play('die');
    },

    /** Paper Jam: slowed for `seconds`. */
    slow(seconds) { m.slowT = Math.max(m.slowT, seconds); },
  };
  return local;
}

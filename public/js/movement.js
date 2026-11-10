// Local player movement controller. Pure simulation (no rendering, audio or networking): the game
// hub steps it at a fixed rate and reacts to `emit(kind, data)`:
//   'jump' | 'airjump' | 'walljump' | 'land' (impact speed) | 'dash' | 'slide' | 'pad' (pad) | 'step' | 'fell'
import { MOVE, PLAYER, yawPitchToDir } from '/shared/constants.js';
import { moveBody, overlapsWorld } from '/shared/physics.js';
import { clamp } from './util.js';

export const STEP = 1 / 120;      // fixed simulation step: identical physics at any frame rate
export const STRIDE = 2.5;        // meters of ground travel per footstep

// Feel tuning that MOVE does not define.
const STOP_SPEED = 2.5;           // friction acts as if moving at least this fast → crisp stops
const SLOW_FACTOR = 0.55;         // Paper Jam
const SLIDE_ENTER = MOVE.slideMinSpeed + 1;
const SLIDE_STEER = 0.5;          // fraction of air accel available to curve a slide
const DASH_BUFFER = 0.12;
const DASH_EXIT = 1.25;           // speed kept after a dash, × run speed (or the entry speed if higher)
const AIRJUMP_STEER = 5;          // m/s an air jump may add toward the held direction
const WALL_MIN_SPEED = 4.5;       // along-wall speed needed to start a wall-run
const WALL_REACH = 0.15;          // a wall this close can be grabbed without touching it …
const WALL_LEAN = 0.2;            // … if the held direction leans into it at least this much
const WALL_ACCEL = 22;
const WALL_STICK = 2;             // m/s pressed into the wall to keep contact
const WALL_FADE = 0.35;           // seconds at the end of a run over which gravity returns
const WALL_RELOCK = 1.5;          // seconds before the same wall can be run again
const WALL_GRACE = 0.14;          // late wall-jump window after leaving a wall
const WALL_ENTRY_RISE = 5;        // vertical speed is clamped to [-2, this] when a run starts
const PAD_REARM = 0.4;

const WITH_STEP = { step: MOVE.stepHeight };
const NO_STEP = { step: 0 };

export function createMover(emit) {
  const m = {
    pos: [0, 0, 0], prev: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0,
    stats: null, scale: 1, radius: PLAYER.radius, height: PLAYER.height,
    world: null, pads: [], killY: -Infinity,
    frozen: false, fell: false,
    onGround: false, crouched: false, sliding: false,
    jumpBuf: 0, coyote: 0, airJumps: 0,
    slideCd: 0, slowT: 0, padCd: 0,
    dashBuf: 0, dashT: 0, dashDir: [0, 0, 0], dashExit: 0, dashCharges: 1, dashRecharge: 0,
    wallOn: false, wallAxis: 0, wallN: 0, wallDir: 0, wallT: 0, wallCoord: 0, wallGrace: 0,
    lockT: 0, lockAxis: 0, lockN: 0, lockCoord: 0,
    stepLift: 0,           // meters lifted by step-ups since the camera last consumed it
    stride: 0,
    // measurements for tests/tuning
    dashFrom: [0, 0, 0], lastDash: 0,   // length of the last completed dash
    airFrom: 0, apex: 0, lastApex: 0,   // takeoff height, highest point since, and rise of the last flight
  };
  const good = { pos: [0, 0, 0], vel: [0, 0, 0] };

  const hSpeed = () => Math.hypot(m.vel[0], m.vel[2]);

  function setHull() {
    m.radius = PLAYER.radius * m.scale;
    m.height = (m.crouched ? PLAYER.crouchHeight : PLAYER.height) * m.scale;
  }

  // Quake accelerate: add speed along the wish direction until `wishSpeed` is reached along it.
  function accelerate(wx, wz, wishSpeed, add) {
    const room = wishSpeed - (m.vel[0] * wx + m.vel[2] * wz);
    if (room <= 0) return;
    const a = add < room ? add : room;
    m.vel[0] += wx * a;
    m.vel[2] += wz * a;
  }

  function friction(k, floor, dt) {
    const sp = hSpeed();
    if (sp < 1e-4) { m.vel[0] = m.vel[2] = 0; return; }
    const f = Math.max(0, sp - Math.max(sp, floor) * k * dt) / sp;
    m.vel[0] *= f;
    m.vel[2] *= f;
  }

  function startSlide() {
    m.sliding = true;
    const sp = hSpeed();
    if (m.slideCd <= 0) {
      // the boost tops out at run speed + boost so chained slide-hops cannot accelerate forever
      const cap = MOVE.speed * m.stats.moveSpeed + MOVE.slideBoost;
      const k = Math.max(sp, Math.min(sp + MOVE.slideBoost, cap)) / sp;
      m.vel[0] *= k;
      m.vel[2] *= k;
    }
    emit('slide');
  }
  function endSlide() {
    m.sliding = false;
    m.slideCd = MOVE.slideCooldown;
  }

  function updateCrouch(want) {
    if (want === m.crouched) return;
    if (want) {
      m.crouched = true;
      setHull();
      if (m.onGround && hSpeed() >= SLIDE_ENTER) startSlide();
    } else if (!overlapsWorld(m.world, m.pos[0], m.pos[1], m.pos[2], m.radius, PLAYER.height * m.scale)) {
      m.crouched = false;
      if (m.sliding) endSlide();
      setHull();
    }
  }

  function endWallrun() {
    m.wallOn = false;
    m.vel[m.wallAxis] = 0;
    m.wallGrace = WALL_GRACE;
    m.lockT = WALL_RELOCK;
    m.lockAxis = m.wallAxis;
    m.lockN = m.wallN;
    m.lockCoord = m.wallCoord;
  }

  // Try to start a wall-run on the wall whose normal is `n` along `axis` (0 = X, 2 = Z).
  function tryWallrun(axis, n) {
    const along = 2 - axis;
    const vt = m.vel[along];
    if (Math.abs(vt) < WALL_MIN_SPEED) return false;
    const coord = m.pos[axis] - n * m.radius;
    if (m.lockT > 0 && m.lockAxis === axis && m.lockN === n && Math.abs(coord - m.lockCoord) < 0.5) return false;
    // a wall within reach that also covers head height (a crate is something to hop over, not to run on)
    const px = m.pos[0] - (axis === 0 ? n * WALL_REACH : 0), pz = m.pos[2] - (axis === 2 ? n * WALL_REACH : 0);
    if (!overlapsWorld(m.world, px, m.pos[1] + m.height * 0.8, pz, m.radius, m.height * 0.2)) return false;
    m.wallOn = true;
    m.wallAxis = axis;
    m.wallN = n;
    m.wallDir = Math.sign(vt);
    m.wallCoord = coord;
    m.wallT = MOVE.wallrunTime * m.stats.wallrun;
    m.airJumps = m.stats.airJumps;
    m.vel[1] = clamp(m.vel[1], -2, WALL_ENTRY_RISE);
    return true;
  }

  // Airborne: start a wall-run on a wall we hit, or on one right beside us that the player is
  // steering into (air control is too weak to physically press into a wall at speed).
  function seekWall(res, wx, wz) {
    if (res.wallX !== 0 || res.wallZ !== 0) {
      if (res.wallX !== 0 && res.wallZ !== 0) return;   // wedged in a corner
      if (res.wallX !== 0) tryWallrun(0, res.wallX); else tryWallrun(2, res.wallZ);
      return;
    }
    const leanX = Math.abs(wx) > WALL_LEAN, leanZ = Math.abs(wz) > WALL_LEAN;
    if (leanX && !leanZ) tryWallrun(0, wx > 0 ? -1 : 1);
    else if (leanZ && !leanX) tryWallrun(2, wz > 0 ? -1 : 1);
    else if (leanX && leanZ && !tryWallrun(0, wx > 0 ? -1 : 1)) tryWallrun(2, wz > 0 ? -1 : 1);
  }

  function wallUpkeep(inp, wx, wz, dt) {
    m.wallT -= dt;
    const pushing = (m.wallAxis === 0 ? wz : wx) * m.wallDir;   // held direction along the run
    if (m.wallT <= 0 || inp.crouch || pushing < -0.5) endWallrun();
  }

  // Returns the gravity to use this step.
  function wallMove(run, gravity, dt) {
    const along = 2 - m.wallAxis;
    const target = MOVE.wallrunSpeed * (run / MOVE.speed);
    let vt = m.vel[along] * m.wallDir;
    if (vt < target) vt = Math.min(target, vt + WALL_ACCEL * dt);
    m.vel[along] = vt * m.wallDir;
    m.vel[m.wallAxis] = -m.wallN * WALL_STICK;
    const hold = clamp(m.wallT / WALL_FADE, 0, 1);
    return gravity + (MOVE.wallrunGravity * m.stats.gravity - gravity) * hold;
  }

  function groundMove(wx, wz, run, dt) {
    if (m.sliding) {
      friction(MOVE.slideFriction, 0, dt);
      accelerate(wx, wz, MOVE.airWishSpeed, MOVE.accelAir * SLIDE_STEER * dt);
      if (hSpeed() < MOVE.slideMinSpeed) endSlide();
    } else {
      friction(MOVE.friction, STOP_SPEED, dt);
      accelerate(wx, wz, m.crouched ? run * (MOVE.crouchSpeed / MOVE.speed) : run, MOVE.accelGround * dt);
    }
  }

  function tryJump(wx, wz, run) {
    const jump = m.stats.jump;
    if (m.wallOn || m.wallGrace > 0) {
      if (m.wallOn) endWallrun();
      m.wallGrace = 0;
      m.vel[m.lockAxis] = m.lockN * MOVE.wallJumpOut;
      m.vel[1] = MOVE.wallJumpUp * jump;
      emit('walljump');
    } else if (m.onGround || m.coyote > 0) {
      m.vel[1] = MOVE.jump * jump;
      if (m.sliding) endSlide();   // horizontal momentum carries: slide-hops
      emit('jump');
    } else if (m.airJumps > 0) {
      m.airJumps--;
      m.vel[1] = MOVE.airJump * jump;
      accelerate(wx, wz, run, AIRJUMP_STEER);
      emit('airjump');
    } else {
      return;
    }
    m.jumpBuf = 0;
    m.coyote = 0;
    m.onGround = false;
  }

  function startDash(wx, wz, run) {
    const d = m.dashDir;
    if (wx !== 0 || wz !== 0) {
      d[0] = wx; d[1] = 0; d[2] = wz;
    } else {
      yawPitchToDir(m.yaw, m.onGround && m.pitch < 0 ? 0 : m.pitch, d);
    }
    m.dashExit = Math.max(hSpeed(), run * DASH_EXIT);
    m.dashT = MOVE.dashTime;
    m.dashBuf = 0;
    m.dashCharges--;
    if (m.wallOn) endWallrun();
    if (m.sliding) endSlide();
    m.dashFrom[0] = m.pos[0]; m.dashFrom[1] = m.pos[1]; m.dashFrom[2] = m.pos[2];
    emit('dash');
  }

  function dashStep(dt) {
    const d = m.dashDir, v = m.vel, grounded = m.onGround;
    v[0] = d[0] * MOVE.dashSpeed;
    v[2] = d[2] * MOVE.dashSpeed;
    // a flat dash hugs the floor (keeps ground state and step-ups); an aimed one flies
    v[1] = grounded && d[1] === 0 ? -1 : d[1] * MOVE.dashSpeed;
    const res = moveBody(m.world, m.pos, v, m.radius, m.height, dt, grounded ? WITH_STEP : NO_STEP);
    m.dashT -= dt;
    if (m.dashT <= 1e-6) {
      m.dashT = 0;
      v[0] = d[0] * m.dashExit;
      v[1] = d[1] * m.dashExit;
      v[2] = d[2] * m.dashExit;
      m.lastDash = Math.hypot(m.pos[0] - m.dashFrom[0], m.pos[1] - m.dashFrom[1], m.pos[2] - m.dashFrom[2]);
    }
    return res;
  }

  function land(impact, crouchHeld) {
    m.airJumps = m.stats.airJumps;
    m.lockT = 0;
    m.wallGrace = 0;
    emit('land', impact);
    if (crouchHeld && m.crouched && !m.sliding && hSpeed() >= SLIDE_ENTER) startSlide();
  }

  function checkPads() {
    if (m.padCd > 0) return;
    const p = m.pos, r = m.radius;
    for (let i = 0; i < m.pads.length; i++) {
      const pad = m.pads[i];
      if (p[0] + r < pad.min[0] || p[0] - r > pad.max[0] || p[2] + r < pad.min[2] || p[2] - r > pad.max[2] ||
          p[1] > pad.max[1] || p[1] + m.height < pad.min[1]) continue;
      m.vel[0] = pad.vel[0]; m.vel[1] = pad.vel[1]; m.vel[2] = pad.vel[2];
      m.padCd = PAD_REARM;
      m.onGround = false;
      m.coyote = 0;
      m.dashT = 0;
      m.airJumps = m.stats.airJumps;
      if (m.sliding) endSlide();
      if (m.wallOn) endWallrun();
      emit('pad', pad);
      return;
    }
  }

  function tickTimers(dt) {
    m.jumpBuf -= dt; m.dashBuf -= dt; m.coyote -= dt; m.slideCd -= dt;
    m.slowT -= dt; m.padCd -= dt; m.lockT -= dt; m.wallGrace -= dt;
    if (m.dashCharges < m.stats.dashCharges) {
      m.dashRecharge += dt;
      if (m.dashRecharge >= dashCooldown()) { m.dashRecharge = 0; m.dashCharges++; }
    } else {
      m.dashRecharge = 0;
    }
  }
  const dashCooldown = () => MOVE.dashCooldown * m.stats.dashCooldown;

  /** Advance one fixed step. inp: { moveX (right +), moveZ (forward +), crouch }. */
  m.step = (inp, dt) => {
    const pos = m.pos, vel = m.vel, st = m.stats;
    m.prev[0] = pos[0]; m.prev[1] = pos[1]; m.prev[2] = pos[2];
    tickTimers(dt);

    const run = MOVE.speed * st.moveSpeed * (m.slowT > 0 ? SLOW_FACTOR : 1);
    let wx = 0, wz = 0;
    if (!m.frozen) {
      const sy = Math.sin(m.yaw), cy = Math.cos(m.yaw);
      wx = inp.moveX * cy - inp.moveZ * sy;
      wz = -inp.moveX * sy - inp.moveZ * cy;
      const len = Math.hypot(wx, wz);
      if (len > 1e-6) { wx /= len; wz /= len; }
    }

    updateCrouch(inp.crouch && !m.frozen);
    if (m.dashBuf > 0 && m.dashCharges > 0 && m.dashT <= 0 && !m.frozen) startDash(wx, wz, run);

    let res, wasGround, fallSpeed = 0;
    if (m.dashT > 0) {
      wasGround = m.onGround;
      res = dashStep(dt);
    } else {
      if (m.wallOn) wallUpkeep(inp, wx, wz, dt);
      if (m.jumpBuf > 0 && !m.frozen) tryJump(wx, wz, run);
      let g = MOVE.gravity * st.gravity;
      if (m.wallOn) g = wallMove(run, g, dt);
      else if (m.onGround) groundMove(wx, wz, run, dt);
      else accelerate(wx, wz, Math.min(run, MOVE.airWishSpeed), MOVE.accelAir * dt);
      if (m.frozen) vel[0] = vel[2] = 0;

      // gravity in two half steps around the move: exact parabolas, so jump heights match v²/2g
      vel[1] -= g * dt * 0.5;
      wasGround = m.onGround;
      fallSpeed = -vel[1];
      res = moveBody(m.world, pos, vel, m.radius, m.height, dt, wasGround ? WITH_STEP : NO_STEP);
      vel[1] = Math.max(vel[1] - g * dt * 0.5, -MOVE.terminal);
    }

    m.onGround = res.onGround;
    if (res.stepped) m.stepLift += res.stepped;
    if (m.onGround) {
      if (!wasGround) {
        m.lastApex = m.apex - m.airFrom;
        land(fallSpeed, inp.crouch);
      }
      m.airFrom = m.apex = pos[1];
    } else {
      if (wasGround && vel[1] <= 0) m.coyote = MOVE.coyote;
      if (pos[1] > m.apex) m.apex = pos[1];
    }

    if (m.wallOn) {
      const contact = m.wallAxis === 0 ? res.wallX : res.wallZ;
      if (contact !== m.wallN || m.onGround || Math.abs(vel[2 - m.wallAxis]) < 1) endWallrun();
    } else if (!m.onGround && !m.crouched && m.dashT <= 0) {
      seekWall(res, wx, wz);
    }

    checkPads();
    if (m.onGround && !m.sliding) {
      m.stride += hSpeed() * dt;
      if (m.stride >= STRIDE) { m.stride -= STRIDE; emit('step'); }
    }
    if (pos[1] < m.killY && !m.fell) { m.fell = true; emit('fell'); }

    // never let a NaN/Infinity escape into rendering or the network
    if (Number.isFinite(pos[0] + pos[1] + pos[2] + vel[0] + vel[1] + vel[2])) {
      good.pos[0] = pos[0]; good.pos[1] = pos[1]; good.pos[2] = pos[2];
      good.vel[0] = vel[0]; good.vel[1] = vel[1]; good.vel[2] = vel[2];
    } else {
      m.place(good.pos, good.vel);
    }
  };

  m.setStats = (stats) => {
    m.stats = stats;
    m.scale = stats.scale;
    setHull();
    m.dashCharges = Math.min(m.dashCharges, stats.dashCharges);
  };

  m.setWorld = (world) => {
    m.world = world;
    m.pads = world.map.jumpPads;
    m.killY = world.map.killY;
  };

  /** Move the body somewhere without sweeping (teleport, rewind). Cancels transient movement states. */
  m.place = (pos, vel) => {
    for (let i = 0; i < 3; i++) {
      m.pos[i] = m.prev[i] = good.pos[i] = pos[i];
      m.vel[i] = good.vel[i] = vel ? vel[i] : 0;
    }
    m.onGround = m.sliding = m.wallOn = false;
    m.dashT = m.coyote = m.wallGrace = m.lockT = m.jumpBuf = m.dashBuf = 0;
    m.stepLift = 0;
    m.airFrom = m.apex = m.pos[1];
  };

  /** Fresh life at a spawn point. */
  m.spawn = (pos, yaw) => {
    m.crouched = false;
    setHull();
    m.place(pos, null);
    m.yaw = yaw;
    m.pitch = 0;
    m.fell = false;
    m.slowT = m.slideCd = m.padCd = 0;
    m.airJumps = m.stats.airJumps;
    m.dashCharges = m.stats.dashCharges;
    m.dashRecharge = 0;
    m.stride = 0;
  };

  /** Knockback. Anything with lift takes the body off the ground so friction cannot eat it. */
  m.impulse = (x, y, z) => {
    m.vel[0] += x; m.vel[1] += y; m.vel[2] += z;
    if (m.vel[1] > 0.5) {
      m.onGround = false;
      m.coyote = 0;
      if (m.sliding) endSlide();
    }
  };

  m.queueJump = () => { m.jumpBuf = MOVE.jumpBuffer; };
  m.queueDash = () => { m.dashBuf = DASH_BUFFER; };
  m.hSpeed = hSpeed;
  /** -1 wall on the left of the view, 1 on the right, 0 not wall-running. */
  m.wallSide = () => {
    if (!m.wallOn) return 0;
    const toWall = m.wallAxis === 0 ? -m.wallN * Math.cos(m.yaw) : m.wallN * Math.sin(m.yaw);
    return toWall >= 0 ? 1 : -1;
  };
  /** Progress 0..1 toward the next dash charge. */
  m.dashFrac = () => (m.dashCharges >= m.stats.dashCharges ? 1 : m.dashRecharge / dashCooldown());

  return m;
}

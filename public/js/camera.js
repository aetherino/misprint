// Camera rig: turns the simulated body into the pose that is actually shown (and shot from).
// First person adds the feel layers — eye-height easing, step-up smoothing, landing dip, head bob,
// strafe / wall-run roll, speed + dash FOV kick, recoil. Also the death cam and the spectator orbit.
import { MOVE, PLAYER, yawPitchToDir } from '/shared/constants.js';
import { raycast } from '/shared/physics.js';
import { STRIDE } from './movement.js';
import { clamp, damp, lerp, lerpAngle, TAU, yawTo } from './util.js';

export const PITCH_LIMIT = Math.PI / 2 - 0.02;

const SLIDE_EYE = PLAYER.crouchEye - 0.12;
const WALL_ROLL = 0.14;         // radians of lean AWAY from the wall while wall-running
const STRAFE_ROLL = 0.02;       // radians at full strafe speed
const BOB_HEIGHT = 0.018;
const DIP_STIFFNESS = 220, DIP_DAMPING = 26, DIP_PER_SPEED = 0.3, DIP_MAX_SPEED = 22;
const SPEED_FOV = 11;           // degrees added at 2× run speed
const DASH_FOV = 9;
const REWIND_FOV = 14;
const RECOIL_RECOVERY = 11;
const DEATH_BACK = 4.2, DEATH_UP = 2.4;
const ORBIT_SPEED = 0.1;

const toVertical = (hfov16x9) => 2 * Math.atan(Math.tan((hfov16x9 * Math.PI) / 360) * (9 / 16)) * (180 / Math.PI);

export function createCameraRig(G) {
  const cam = G.R.camera;
  cam.rotation.order = 'YXZ';

  const rig = {
    mode: 'orbit',                 // 'fp' | 'death' | 'orbit'
    eye: [0, 12, 30], yaw: 0, pitch: 0, dir: [0, 0, -1],   // the pose on screen this frame
    kick: 0,                       // recoil: pitch offset that recovers
  };
  let eyeH = PLAYER.eye, stepOff = 0, dip = 0, dipVel = 0, bobAmt = 0, roll = 0;
  let fovKick = 0, dashPulse = 0, shownFov = 0, orbit = Math.random() * TAU;
  const death = { from: [0, 0, 0], yaw: 0, killerId: null, t: 0 };
  const look = [0, 0, 0], want = [0, 0, 0], ray = [0, 0, 0];

  function firstPerson(dt, vdt) {
    const m = G.mover, a = G.alpha, speed = m.hSpeed();
    const run = MOVE.speed * m.stats.moveSpeed;

    eyeH = damp(eyeH, (m.sliding ? SLIDE_EYE : m.crouched ? PLAYER.crouchEye : PLAYER.eye) * m.scale, 16, dt);
    stepOff = damp(stepOff - m.stepLift, 0, 14, dt);
    m.stepLift = 0;
    dipVel += (-DIP_STIFFNESS * dip - DIP_DAMPING * dipVel) * vdt;
    dip += dipVel * vdt;
    bobAmt = damp(bobAmt, m.onGround && !m.sliding && speed > 2 ? Math.min(1, speed / run) : 0, 8, dt);
    const bob = Math.sin((m.stride / STRIDE) * TAU) * BOB_HEIGHT * bobAmt;

    rig.eye[0] = lerp(m.prev[0], m.pos[0], a);
    rig.eye[1] = lerp(m.prev[1], m.pos[1], a) + eyeH + stepOff + dip + bob;
    rig.eye[2] = lerp(m.prev[2], m.pos[2], a);

    const side = m.wallSide();
    const strafe = (Math.cos(m.yaw) * m.vel[0] - Math.sin(m.yaw) * m.vel[2]) / run;
    roll = damp(roll, side !== 0 ? side * WALL_ROLL : -clamp(strafe, -1.5, 1.5) * STRAFE_ROLL, 9, dt);

    rig.kick = damp(rig.kick, 0, RECOIL_RECOVERY, dt);
    rig.yaw = m.yaw;
    rig.pitch = clamp(m.pitch + rig.kick, -PITCH_LIMIT, PITCH_LIMIT);

    dashPulse = damp(dashPulse, 0, 5, dt);
    const rewind = G.rewind.active ? -Math.sin(G.rewind.progress * Math.PI) * REWIND_FOV : 0;
    fovKick = damp(fovKick, clamp((speed - run) / run, 0, 1) * SPEED_FOV + dashPulse + rewind, 8, dt);
  }

  function lookAt(target, blend) {
    const dx = target[0] - rig.eye[0], dy = target[1] - rig.eye[1], dz = target[2] - rig.eye[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return;
    rig.yaw = lerpAngle(rig.yaw, yawTo(rig.eye, target), blend);
    rig.pitch = lerp(rig.pitch, Math.asin(clamp(dy / len, -1, 1)), blend);
  }

  // Detach from the body: drift back and up from where we died, watching the killer.
  function deathCam(dt) {
    death.t += dt;
    const killer = death.killerId === null ? null : G.remotes.get(death.killerId);
    if (killer) {
      look[0] = killer.view.pos[0]; look[1] = killer.view.pos[1] + PLAYER.eye * killer.scale * 0.8; look[2] = killer.view.pos[2];
    } else {
      look[0] = death.from[0]; look[1] = death.from[1] - 1; look[2] = death.from[2];
    }
    // away from the killer; straight back along the old view if they are on top of us
    let bx = death.from[0] - look[0], bz = death.from[2] - look[2];
    const bl = Math.hypot(bx, bz);
    if (bl > 0.5) { bx /= bl; bz /= bl; } else { bx = Math.sin(death.yaw); bz = Math.cos(death.yaw); }
    const ease = 1 - Math.exp(-3.5 * death.t);
    want[0] = bx * DEATH_BACK * ease; want[1] = DEATH_UP * ease; want[2] = bz * DEATH_BACK * ease;
    let dist = Math.hypot(want[0], want[1], want[2]);
    if (dist > 1e-3) {
      ray[0] = want[0] / dist; ray[1] = want[1] / dist; ray[2] = want[2] / dist;
      const hit = raycast(G.world, death.from, ray, dist + 0.4);
      if (hit) dist = Math.max(0, hit.t - 0.4);
      rig.eye[0] = death.from[0] + ray[0] * dist;
      rig.eye[1] = death.from[1] + ray[1] * dist;
      rig.eye[2] = death.from[2] + ray[2] * dist;
    }
    lookAt(look, 1 - Math.exp(-6 * dt));
    roll = damp(roll, 0, 6, dt);
    fovKick = damp(fovKick, 0, 6, dt);
  }

  function orbitCam(dt) {
    orbit += dt * ORBIT_SPEED;
    const size = G.state.map ? G.state.map.size : 56;
    rig.eye[0] = Math.sin(orbit) * size * 0.62;
    rig.eye[1] = size * 0.3;
    rig.eye[2] = Math.cos(orbit) * size * 0.62;
    look[0] = 0; look[1] = 1.5; look[2] = 0;
    lookAt(look, 1);
    roll = 0;
    fovKick = damp(fovKick, 0, 6, dt);
  }

  /** Feel impulses from movement events. */
  rig.land = (speed) => { dipVel -= Math.min(speed, DIP_MAX_SPEED) * DIP_PER_SPEED; };
  rig.dashKick = () => { dashPulse = DASH_FOV; };
  /** Snap the feel layers to rest (spawn / teleport). */
  rig.reset = () => {
    eyeH = PLAYER.eye * G.mover.scale;
    stepOff = dip = dipVel = bobAmt = roll = fovKick = dashPulse = 0;
    rig.kick = 0;
  };
  rig.startDeath = (killerId) => {
    death.from[0] = rig.eye[0]; death.from[1] = rig.eye[1]; death.from[2] = rig.eye[2];
    death.yaw = rig.yaw;
    death.killerId = killerId;
    death.t = 0;
    rig.kick = 0;
  };

  rig.update = (dt) => {
    const vdt = Math.min(dt, 1 / 30);   // springs stay stable through frame hitches
    if (rig.mode === 'fp') firstPerson(dt, vdt);
    else if (rig.mode === 'death') deathCam(dt);
    else orbitCam(dt);

    yawPitchToDir(rig.yaw, rig.pitch, rig.dir);
    cam.position.set(rig.eye[0], rig.eye[1], rig.eye[2]);
    cam.rotation.set(rig.pitch, rig.yaw, roll);
    const fov = clamp(toVertical(G.options.fov) + fovKick, 30, 140);
    if (Math.abs(fov - shownFov) > 0.01) {
      shownFov = cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();   // R.muzzleWorldPos() reads it before the frame is rendered
  };

  return rig;
}

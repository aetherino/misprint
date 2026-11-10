// Rewind (Q): a rolling 3 s history of the body sampled at 20 Hz, and the short backwards sweep
// that plays when the ability is used.
import { MOVE, TICK_HZ } from '/shared/constants.js';

const SAMPLE_DT = 1 / TICK_HZ;
const SWEEP_TIME = 0.25;
const FIELDS = 6;   // pos xyz, vel xyz

export function createRewind() {
  const cap = Math.round(MOVE.rewindSeconds * TICK_HZ) + 1;
  const ring = new Float32Array(cap * FIELDS);
  const path = new Float32Array((cap + 1) * FIELDS);   // sweep route: now → newest … oldest sample
  const pos = [0, 0, 0], vel = [0, 0, 0];
  let head = 0, count = 0, acc = 0, pathLen = 0, t = 0;

  const rw = {
    active: false,
    progress: 0,      // 0..1 through the sweep (drives the screen effect)
    cooldown: 0,      // seconds until Rewind is available again

    clear() { head = count = 0; acc = 0; },

    /** Call once per fixed step while the player is in control. */
    record(m, dt) {
      acc += dt;
      if (acc < SAMPLE_DT - 1e-9) return;
      acc -= SAMPLE_DT;
      ring.set(m.pos, head * FIELDS);
      ring.set(m.vel, head * FIELDS + 3);
      head = (head + 1) % cap;
      if (count < cap) count++;
    },

    /** Start sweeping back to the oldest sample. False when there is no history yet. */
    begin(m) {
      if (rw.active || count < 2) return false;
      path.set(m.pos, 0);
      path.set(m.vel, 3);
      for (let i = 0; i < count; i++) {
        const src = ((head - 1 - i + cap) % cap) * FIELDS;
        path.set(ring.subarray(src, src + FIELDS), (i + 1) * FIELDS);
      }
      pathLen = count + 1;
      t = 0;
      rw.active = true;
      rw.progress = 0;
      return true;
    },

    /** Advance the sweep by one fixed step. Returns true on the step it arrives. */
    step(m, dt) {
      t += dt;
      const u = Math.min(1, t / SWEEP_TIME);
      rw.progress = u;
      const f = u * u * (3 - 2 * u) * (pathLen - 1);
      const i = Math.min(pathLen - 2, Math.floor(f)), k = f - i;
      const a = i * FIELDS, b = a + FIELDS;
      for (let c = 0; c < 3; c++) pos[c] = path[a + c] + (path[b + c] - path[a + c]) * k;
      if (u < 1) {
        m.place(pos, null);
        return false;
      }
      for (let c = 0; c < 3; c++) vel[c] = path[b + 3 + c];
      m.place(pos, vel);
      rw.active = false;
      rw.progress = 0;
      rw.clear();
      return true;
    },
  };
  return rw;
}

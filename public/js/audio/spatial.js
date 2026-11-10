// Cheap positional audio: one gain, one equal-power pan, one optional low-pass per voice.
// No HRTF. Conventions from shared/constants.js: Y up, yaw 0 faces -Z, positive yaw turns left.

const REF = 4;        // metres inside which a sound plays at full level
const FADE_START = 55; // inverse-distance rolloff out to here…
const FADE_END = 80;   // …then faded to silence so nothing pops in/out at the edge
const SOUND_SPEED = 343;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createListener() {
  let lx = 0, ly = 0, lz = 0, fx = 0, fz = -1, rx = 1, rz = 0;
  const out = { gain: 1, pan: 0, cutoff: 0, delay: 0, dist: 0 };

  return {
    set(pos, yaw) {
      lx = pos[0]; ly = pos[1]; lz = pos[2];
      const s = Math.sin(yaw), c = Math.cos(yaw);
      fx = -s; fz = -c; // forward
      rx = c; rz = -s;  // right
    },

    /**
     * Where a world position sits relative to the listener. `reach` > 1 makes a sound carry further.
     * Returns a reused scratch object: gain 0..1, pan -1..1, cutoff Hz (0 = no filter), delay s, dist m.
     */
    locate(pos, reach = 1) {
      const dx = pos[0] - lx, dy = pos[1] - ly, dz = pos[2] - lz;
      const dist = Math.hypot(dx, dy, dz), d = dist / reach, inv = 1 / Math.max(dist, 1e-3);
      const right = (dx * rx + dz * rz) * inv, behind = Math.max(0, -(dx * fx + dz * fz) * inv);
      out.dist = dist;
      out.gain = (d <= REF ? 1 : REF / d) * (1 - smooth(FADE_START, FADE_END, d)) * (1 - 0.12 * behind);
      // sources on top of the listener stay centred instead of flipping sides as you turn
      out.pan = Math.max(-1, Math.min(1, right)) * 0.85 * smooth(0.4, 2.5, dist);
      // air absorption + a little head shadow for sounds behind you
      const cutoff = 20000 * Math.exp(-d / 26) * (1 - 0.45 * behind);
      out.cutoff = cutoff < 15000 ? Math.max(1500, cutoff) : 0;
      out.delay = Math.min(0.12, dist / SOUND_SPEED);
      return out;
    },
  };
}

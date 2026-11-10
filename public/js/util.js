// Small math helpers shared by the engine modules.

export const TAU = Math.PI * 2;

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential approach of `cur` toward `target` (rate in 1/s). */
export const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);

/** Wrap an angle into [-PI, PI). */
export const wrapPi = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
export const lerpAngle = (a, b, t) => a + wrapPi(b - a) * t;

export const copy3 = (out, a) => { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; };
export const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const r2 = (x) => Math.round(x * 100) / 100;
export const r3 = (x) => Math.round(x * 1000) / 1000;
/** Wire format for positions/vectors: plain arrays rounded to centimeters. */
export const netVec = (v) => [r2(v[0]), r2(v[1]), r2(v[2])];
export const round2 = r2;

/** Yaw that faces from `from` toward `to` on the ground plane (see yawPitchToDir: yaw 0 looks at -Z). */
export const yawTo = (from, to) => Math.atan2(from[0] - to[0], from[2] - to[2]);

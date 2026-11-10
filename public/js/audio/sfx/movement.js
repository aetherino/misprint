// Movement foley: sneakers on paper. Kept quiet and mostly below 3 kHz so it never competes with
// weapons or the hit tick; whooshes are band-passed noise sweeps with distinct contours.

const TAU = Math.PI * 2;

export default {
  footstep: {
    level: 0.13, vars: 5, jitter: 0.07, send: 0, gap: 0.06, prio: 0,
    make({ noise, filt, env, decay, thump, mix, jit }) {
      const heel = thump(jit(125, 0.12), 62, 0.012, 0.016, 0.003);
      const sole = env(filt(noise(0.05), 'lp', jit(720, 0.2)), decay(0.008, 0.002));
      const paper = env(filt(noise(0.07), 'bp', jit(3100, 0.2), 0.9), decay(0.013, 0.004));
      return mix([heel, 1], [sole, 0.6], [paper, 0.24, 0.004]);
    },
  },

  jump: {
    level: 0.17, vars: 3, jitter: 0.06, send: 0, gap: 0.06, prio: 1,
    make({ whoosh, points, thump, click, mix, jit }) {
      const push = thump(jit(155), 85, 0.02, 0.024, 0.002);
      const air = whoosh(0.13, (t) => 500 + 7000 * t, 1.1, points([[0, 0], [0.03, 1], [0.13, 0]]));
      return mix([push, 1], [click(2600, 0.004), 0.3], [air, 0.5, 0.005]);
    },
  },

  airjump: {
    level: 0.2, vars: 3, jitter: 0.06, send: 1, gap: 0.06, prio: 1,
    make({ noise, filt, env, decay, whoosh, points, bloop, mix, jit }) {
      const pop = bloop(jit(520), jit(1080), 0.03);
      const puff = env(filt(noise(0.07), 'hp', 2400), decay(0.012));
      const air = whoosh(0.17, (t) => 900 + 14000 * t, 1.4, points([[0, 0], [0.02, 1], [0.17, 0]]));
      return mix([pop, 1], [puff, 0.5], [air, 0.55, 0.01]);
    },
  },

  land: {
    level: 0.3, vars: 3, jitter: 0.06, send: 0, gap: 0.06, prio: 1, volPitch: 0.3,
    make({ noise, filt, env, decay, thump, drive, mix, jit }) {
      const thud = drive(thump(jit(118), 46, 0.03, 0.05, 0.002), 1.6);
      const slap = env(filt(noise(0.1), 'lp', 1000), decay(0.017));
      const crunch = env(filt(noise(0.12), 'bp', jit(2800, 0.15), 0.8), decay(0.022, 0.003));
      return mix([thud, 1], [slap, 0.6], [crunch, 0.2, 0.006]);
    },
  },

  dash: {
    level: 0.3, vars: 3, jitter: 0.05, send: 1, gap: 0.08, prio: 1,
    make({ noise, osc, filt, env, decay, sweep, whoosh, points, thump, mix, jit }) {
      // everything falls in pitch: you already left
      const air = whoosh(0.3, sweep(jit(3600), 420, 0.085), 1.3, points([[0, 0], [0.012, 1], [0.1, 0.6], [0.3, 0]]));
      const zip = env(filt(osc(0.2, 'saw', sweep(jit(980), 240, 0.065)), 'lp', 1800), points([[0, 0], [0.01, 1], [0.2, 0]]));
      const hiss = env(filt(noise(0.2), 'hp', 5000), decay(0.04, 0.005));
      return mix([thump(200, 90, 0.015, 0.02), 0.6], [air, 1], [zip, 0.16], [hiss, 0.2]);
    },
  },

  slide_start: {
    level: 0.22, vars: 3, jitter: 0.06, send: 0, gap: 0.1, prio: 1,
    make({ whoosh, points, thump, mix, jit }) {
      const base = jit(2400, 0.06);
      const scrape = whoosh(0.3, (t) => base + 1800 * Math.exp(-t / 0.05), 0.8, points([[0, 0], [0.01, 1], [0.08, 0.5], [0.3, 0]]));
      return mix([thump(120, 60, 0.02, 0.035, 0.002), 0.8], [scrape, 1]);
    },
  },

  walljump: {
    level: 0.24, vars: 3, jitter: 0.06, send: 1, gap: 0.06, prio: 1,
    make({ osc, env, glide, hann, whoosh, points, thump, click, mix, jit }) {
      const kick = thump(jit(172), 80, 0.015, 0.028, 0.0015);
      const squeak = env(osc(0.045, 'sine', glide(jit(1700), jit(2750), 0.04)), hann(0.045));
      const air = whoosh(0.14, (t) => 700 + 9000 * t, 1.2, points([[0, 0], [0.025, 1], [0.14, 0]]));
      return mix([kick, 1], [click(2200, 0.004), 0.5], [squeak, 0.14, 0.004], [air, 0.5, 0.01]);
    },
  },

  jumppad: {
    level: 0.34, vars: 2, jitter: 0.04, send: 2, gap: 0.1, prio: 1,
    make({ osc, env, decay, glide, whoosh, points, thump, click, mix, jit }) {
      // boi-oi-oing: rising pitch with a decaying spring wobble
      const rise = glide(jit(150), jit(640), 0.42, 0.7);
      const wob = (t) => 1 + 0.24 * Math.sin(TAU * 17 * t) * Math.exp(-t / 0.17);
      const spring = env(osc(0.5, 'tri', (t) => rise(t) * wob(t)), decay(0.13, 0.004));
      const coil = env(osc(0.4, 'sine', (t) => rise(t) * wob(t) * 2.01), decay(0.08, 0.004));
      const air = whoosh(0.36, (t) => 600 + 5200 * t, 1, points([[0, 0], [0.05, 0.7], [0.36, 0]]));
      return mix([thump(185, 90, 0.02, 0.03), 0.7], [click(1200, 0.005), 0.5], [spring, 1], [coil, 0.3], [air, 0.3]);
    },
  },

  rewind: {
    level: 0.34, vars: 2, jitter: 0.03, send: 2, gap: 0.2, prio: 2, duck: 0.35,
    make({ noise, osc, filt, env, decay, glide, points, reverse, thump, click, mix, jit }) {
      const dur = 0.42, f = glide(jit(260), 2700, 0.4, 1.3);
      // tape spooling backwards: warbling chirp, chopped by the reel
      const chirp = filt(osc(dur, 'saw', (t) => f(t) * (1 + 0.12 * Math.sin(TAU * 28 * t))), 'bp', (t) => f(t) * 2, 2);
      const tape = env(chirp, (t) => (0.6 + 0.4 * Math.sin(TAU * 41 * t)) * points([[0, 0], [0.03, 0.5], [0.38, 1], [dur, 0]])(t));
      const suck = reverse(env(filt(noise(dur), 'bp', (t) => 3200 * Math.exp(-t / 0.15) + 300, 1), decay(0.12)));
      return mix([tape, 0.6], [suck, 0.8], [click(900, 0.005), 0.9, dur], [thump(165, 60, 0.012, 0.03), 0.9, dur]);
    },
  },
};

// Weapon sounds: "ASMR office supplies turned into guns". Each weapon owns a spectral slot so a
// firefight stays readable by ear:
//   stapler  = 2-5 kHz double click + 100 Hz tap, over in 90 ms (10 shots/s must stay a rhythm)
//   punch    = low-mid crunch + 45 Hz sub + paper hiss, the long heavy one
//   marker   = 1.5-6 kHz squeak into a whip crack
//   blotter  = hollow 150-500 Hz tube "thoonk" + glassy clink
//   explode  = sub + full-band splat + droplets, bigger than everything else
//
// Per-sound fields (see bank.js / voices.js): level = normalised peak, vars = variations rendered,
// jitter = ± playback-rate jitter per play, send = reverb bus (0 dry … 3 wet), gap = min seconds
// between two plays of the same name, prio = steal priority, duck = music duck depth 0..1,
// reach = distance multiplier (how far it carries).

export default {
  fire_stapler: {
    level: 0.5, vars: 4, jitter: 0.03, send: 1, gap: 0.028, prio: 2,
    make({ noise, filt, env, decay, modes, fm, thump, drive, mix, jit }) {
      // click + ring are centred on 2-2.8 kHz and thin out above 3 kHz: that band belongs to `hit`,
      // which plays at the same instant whenever a staple lands
      const ka = env(filt(noise(0.014), 'bp', jit(2500, 0.1), 1.3), decay(0.0022));
      const ring = modes(0.05, [[jit(1980), 0.007, 0.8], [jit(2760), 0.008, 0.6], [jit(3900), 0.005, 0.25], [jit(7900), 0.003, 0.2]]);
      const chunkNoise = env(filt(noise(0.03), 'lp', 2600), decay(0.005));
      const chunkBody = modes(0.06, [[jit(880), 0.011, 0.7], [jit(1560), 0.009, 0.5], [jit(2700), 0.007, 0.3]]);
      const tap = drive(thump(180, 70, 0.012, 0.014), 1.6);
      const spring = env(fm(0.07, jit(4200), 1.41, 1.2), decay(0.016));
      // KA (0 ms) carries the transient; CHUNK + the low tap land 9 ms later
      return mix([ka, 1.5], [ring, 0.75], [chunkNoise, 0.6, 0.009], [chunkBody, 0.8, 0.009], [tap, 0.8, 0.008], [spring, 0.07, 0.012]);
    },
  },

  fire_punch: {
    level: 0.62, vars: 3, jitter: 0.03, send: 2, gap: 0.05, prio: 2, duck: 0.35, reach: 1.4,
    make({ sr, noise, filt, env, decay, modes, thump, drive, crush, points, mix, jit }) {
      // stage 1: the lever bites — dull crunchy bark
      const bite = drive(env(filt(noise(0.06), 'bp', jit(1100, 0.1), 0.8), decay(0.012)), 3);
      const lever = modes(0.08, [[jit(410), 0.02, 0.8], [jit(960), 0.014, 0.5]]);
      // stage 2 (45 ms later): the die goes through nine sheets — crack + sub
      const crack = env(filt(noise(0.09), 'hp', 1800), decay(0.013));
      const die = modes(0.12, [[jit(610), 0.03, 0.8], [jit(1320), 0.024, 0.55], [jit(2440), 0.016, 0.4], [jit(3900), 0.01, 0.25]]);
      const sub = drive(thump(105, 38, 0.05, 0.1, 0.002), 2.2);
      const body = drive(thump(240, 90, 0.02, 0.035), 1.5);
      // confetti: sparkly high hiss, amplitude chopped into flecks
      const gate = crush(noise(0.42), Math.round(sr * 0.004));
      const flecks = env(filt(noise(0.42), 'hp', 5200), (t) => (gate[Math.round(t * sr)] > 0.3 ? 1 : 0.2) * Math.exp(-t / 0.11) * Math.min(1, t / 0.015));
      const spring = modes(0.09, [[jit(2900), 0.02, 0.5], [jit(4300), 0.014, 0.3]]);
      const tail = env(filt(noise(0.3), 'lp', (t) => 2400 * Math.exp(-t / 0.08) + 180), points([[0, 0], [0.01, 1], [0.3, 0]]));
      return mix(
        [bite, 0.7], [lever, 0.45], [body, 0.5],
        [crack, 0.65, 0.045], [die, 0.55, 0.045], [sub, 1.1, 0.043], [tail, 0.6, 0.05],
        [flecks, 0.15, 0.06], [spring, 0.1, 0.2],
      );
    },
  },

  fire_marker: {
    level: 0.5, vars: 3, jitter: 0.025, send: 2, gap: 0.04, prio: 2, duck: 0.2, reach: 1.5,
    // the heavy layer fades in with opts.vol so a full charge lands harder than a tap
    layers: [{ name: '_marker_heavy', vol: (v) => Math.max(0, Math.min(1, (v - 0.45) / 0.55)) }],
    make({ noise, filt, env, decay, osc, glide, sweep, points, thump, click, mix, jit }) {
      // felt tip on whiteboard: a pulse wave zipping upward with stick-slip wobble
      const zipHz = glide(jit(1400), jit(4600), 0.03, 0.8);
      const zip = env(
        filt(osc(0.045, 'square', (t) => zipHz(t) * (1 + 0.06 * Math.sin(t * 1900)), { width: 0.3 }), 'bp', (t) => zipHz(t) * 1.5, 2.5),
        points([[0, 0.7], [0.003, 1], [0.03, 1], [0.045, 0]]));
      const tick = click(4800, 0.0015, 1, 'hp');
      // the line gets drawn: crack + a fast falling whistle
      const crack = env(filt(noise(0.12), 'hp', 1500), decay(0.017));
      const whip = env(osc(0.14, 'sine', sweep(jit(6200), 420, 0.022)), decay(0.03));
      const snap = thump(260, 80, 0.012, 0.03);
      const fizz = env(filt(noise(0.22), 'bp', (t) => 5200 * Math.exp(-t / 0.07) + 900, 1.2), decay(0.06, 0.004));
      return mix([tick, 0.8], [zip, 0.8], [crack, 0.9, 0.022], [whip, 0.55, 0.022], [snap, 0.6, 0.022], [fizz, 0.3, 0.03]);
    },
  },

  _marker_heavy: {
    level: 0.3, vars: 2, jitter: 0.03, send: 2, gap: 0.04, prio: 2,
    make({ noise, filt, env, decay, thump, drive, mix }) {
      const boom = drive(thump(130, 40, 0.05, 0.1, 0.002), 2);
      const air = env(filt(noise(0.3), 'bp', (t) => 3200 * Math.exp(-t / 0.08) + 400, 0.7), decay(0.07, 0.003));
      return mix([boom, 0.8, 0.02], [air, 0.7, 0.024]);
    },
  },

  fire_blotter: {
    level: 0.55, vars: 3, jitter: 0.04, send: 2, gap: 0.05, prio: 2, duck: 0.2, reach: 1.2,
    make({ noise, filt, env, decay, comb, thump, modes, bloop, points, mix, jit, rand }) {
      // hollow tube: a puff of noise ringing in a short comb, plus a round pitch drop
      const puff = env(filt(noise(0.05), 'lp', 900), decay(0.009));
      const tube = filt(comb(puff, 1 / jit(205), 0.86, 0.22), 'lp', 1400);
      const thoonk = thump(330, 105, 0.03, 0.07, 0.002);
      const air = env(filt(noise(0.18), 'bp', 480, 1.4), points([[0, 0], [0.006, 1], [0.05, 0.3], [0.17, 0]]));
      // glass bottle + ink inside
      const clink = modes(0.16, [[jit(2350), 0.03, 0.6], [jit(3140), 0.025, 0.5], [jit(4720), 0.016, 0.3]]);
      const slosh = mix(
        [bloop(rand(380, 460), rand(760, 900), 0.045), 0.8, 0.07],
        [bloop(rand(520, 640), rand(300, 380), 0.05), 0.6, 0.12],
        [bloop(rand(700, 820), rand(1200, 1500), 0.035), 0.45, 0.16],
      );
      return mix([tube, 0.55], [thoonk, 1], [air, 0.35], [clink, 0.16, 0.012], [clink, 0.08, 0.075], [slosh, 0.3]);
    },
  },

  bounce: {
    level: 0.4, vars: 3, jitter: 0.06, send: 1, gap: 0.05, prio: 1,
    make({ osc, env, points, decay, bloop, click, mix, jit, rand }) {
      const f = jit(210, 0.08);
      // rubbery: pitch squashes down then springs up and settles
      const boing = env(
        osc(0.2, 'sine', points([[0, f * 1.5], [0.018, f * 0.8], [0.06, f * 1.7], [0.2, f * 1.15]])),
        decay(0.05, 0.002));
      const squish = env(osc(0.12, 'tri', points([[0, f * 3], [0.02, f * 1.6], [0.07, f * 3.4]])), decay(0.03, 0.002));
      const plop = bloop(rand(480, 560), rand(1000, 1250), 0.04);
      return mix([boing, 1], [squish, 0.25], [click(1500, 0.004, 0.9), 0.4], [plop, 0.4, 0.035]);
    },
  },

  explode: {
    level: 0.85, vars: 3, jitter: 0.04, send: 3, gap: 0.06, prio: 3, duck: 0.6, reach: 2,
    make({ noise, filt, env, decay, thump, drive, points, droplets, mix, jit }) {
      const snap = env(noise(0.02), decay(0.003));
      const sub = drive(thump(jit(120), 31, 0.09, 0.26, 0.003), 2.6);
      const boom = drive(env(filt(noise(0.9), 'lp', (t) => 5200 * Math.exp(-t / 0.085) + 140, 0.9), decay(0.17, 0.002)), 2.4);
      // the wet part: band of noise whose filter gurgles
      const splat = env(
        filt(noise(0.5), 'bp', (t) => 1250 + 650 * Math.sin(t * 240) * Math.exp(-t / 0.12), 2.2),
        points([[0, 0], [0.012, 1], [0.1, 0.5], [0.45, 0]]));
      const spray = env(filt(noise(0.6), 'hp', 3800), decay(0.1, 0.02));
      const drips = droplets(13, 0.13, 0.95, 240, 1500);
      const rumble = env(filt(noise(1.1), 'lp', 110), points([[0, 0], [0.05, 1], [0.4, 0.5], [1.05, 0]]));
      return mix([snap, 0.7], [sub, 1.15], [boom, 0.95], [splat, 0.6, 0.008], [spray, 0.2, 0.01], [drips, 0.34], [rumble, 0.8]);
    },
  },

  impact: {
    level: 0.24, vars: 4, jitter: 0.1, send: 0, gap: 0.035, prio: 0,
    make({ click, thump, bloop, mix, jit, rand }) {
      return mix(
        [click(jit(2300, 0.15), 0.003, 1.4), 1],
        [thump(jit(760, 0.1), 300, 0.008, 0.012), 0.6],
        [bloop(rand(900, 1300), rand(1700, 2300), 0.018), 0.3, 0.006],
      );
    },
  },

  ricochet: {
    level: 0.26, vars: 4, jitter: 0.12, send: 1, gap: 0.045, prio: 0,
    make({ fm, env, decay, click, glide, mix, jit }) {
      const f0 = jit(2900, 0.15);
      const pew = env(fm(0.2, (t) => glide(f0, f0 * 0.34, 0.16, 0.6)(t) * (1 + 0.025 * Math.sin(t * 330)), 2.01, (t) => 1.4 * Math.exp(-t / 0.05)), decay(0.05, 0.001));
      return mix([click(5200, 0.0016, 1, 'hp'), 0.8], [pew, 0.8]);
    },
  },

  dry: {
    level: 0.2, vars: 2, jitter: 0.04, send: 0, gap: 0.08, prio: 1,
    make({ modes, click, mix, jit }) {
      const tock = modes(0.05, [[jit(1150), 0.006, 0.9], [jit(1900), 0.005, 0.4]]);
      const spring = modes(0.07, [[jit(3300), 0.014, 0.25]]);
      return mix([click(1700, 0.002), 0.7], [tock, 0.8], [spring, 0.3, 0.004]);
    },
  },

  reload_start: {
    level: 0.26, vars: 2, jitter: 0.04, send: 1, gap: 0.1, prio: 1,
    make({ whoosh, points, modes, click, thump, mix, jit }) {
      const slide = whoosh(0.09, (t) => 1300 + 9000 * t, 2, points([[0, 0], [0.02, 0.6], [0.08, 1], [0.09, 0]]));
      const unlatch = modes(0.06, [[jit(720), 0.012, 0.8], [jit(1480), 0.01, 0.6], [jit(2600), 0.006, 0.3]]);
      return mix([click(2400, 0.002), 0.6], [unlatch, 0.7], [slide, 0.35, 0.02], [thump(190, 110, 0.01, 0.018), 0.5, 0.105], [click(1200, 0.004), 0.5, 0.105]);
    },
  },

  reload_end: {
    level: 0.34, vars: 2, jitter: 0.03, send: 1, gap: 0.1, prio: 1,
    make({ whoosh, points, modes, click, thump, drive, mix, jit }) {
      const slide = whoosh(0.055, (t) => 3200 - 22000 * t, 2, points([[0, 0], [0.012, 1], [0.05, 0.7], [0.055, 0]]));
      // cha-CHUNK: a bright seat, then the heavier lock 55 ms later
      const seat = modes(0.05, [[jit(1850), 0.008, 0.8], [jit(2950), 0.007, 0.5], [jit(4400), 0.005, 0.3]]);
      const lock = modes(0.09, [[jit(520), 0.018, 0.9], [jit(1120), 0.014, 0.7], [jit(2250), 0.01, 0.45], [jit(3600), 0.007, 0.25]]);
      const knock = drive(thump(150, 68, 0.014, 0.026), 1.5);
      const ring = modes(0.12, [[jit(3150), 0.03, 0.2]]);
      return mix(
        [slide, 0.3], [click(3000, 0.002), 0.7, 0.055], [seat, 0.6, 0.055],
        [click(1600, 0.003), 0.9, 0.11], [lock, 0.85, 0.11], [knock, 0.9, 0.11], [ring, 0.25, 0.115],
      );
    },
  },

  switch: {
    level: 0.2, vars: 3, jitter: 0.06, send: 0, gap: 0.06, prio: 1,
    make({ whoosh, points, modes, click, mix, jit }) {
      const swish = whoosh(0.11, (t) => 700 + 26000 * t * (1 - t * 3.5), 1.3, points([[0, 0], [0.03, 1], [0.11, 0]]));
      const latch = modes(0.04, [[jit(1400), 0.007, 0.7], [jit(2300), 0.005, 0.4]]);
      return mix([swish, 0.55], [click(2600, 0.002), 0.6, 0.085], [latch, 0.7, 0.085]);
    },
  },
};

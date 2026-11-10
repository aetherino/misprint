// World pickups + match flow stingers. Tonal ones are written in C major / A minor pentatonic so
// they sit politely over whatever key the generative soundtrack picked for this match.
import { midiHz } from '../dsp.js';

/** Lay notes out as [midi, startSeconds, gain?] using one voice builder. */
const seq = (mix, notes, voice) => mix(...notes.map(([n, at, g = 1]) => [voice(midiHz(n)), g, at]));

export default {
  pickup_health: {
    level: 0.34, vars: 1, jitter: 0, send: 1, gap: 0.1, prio: 2,
    make({ noise, filt, env, decay, bloop, pluck, mix }) {
      const sip = mix([bloop(420, 980, 0.05), 1], [env(filt(noise(0.05), 'hp', 3000), decay(0.008)), 0.3, 0.04]);
      const arp = seq(mix, [[84, 0.045], [88, 0.1], [91, 0.155], [96, 0.21, 0.7]], (hz) => pluck(hz, 0.075, 0.6));
      return mix([sip, 0.8], [arp, 0.8]);
    },
  },

  pickup_overprint: {
    level: 0.55, vars: 1, jitter: 0, send: 3, gap: 0.3, prio: 3, duck: 0.6,
    make({ saws, drive, whoosh, points, thump, bell, mix }) {
      const chord = drive(mix(...[45, 52, 57, 64, 69].map((n, i) => [saws(midiHz(n), 0.75, { cutoff: 5200, close: 0.28, detune: 0.011 }), 0.5 - i * 0.05])), 1.4);
      const riser = whoosh(0.75, (t) => 500 * Math.pow(16, t / 0.75), 1.5, points([[0, 0], [0.66, 1], [0.75, 0]]));
      const sparkle = mix([bell(1760, 0.11), 1], [bell(2637, 0.09), 0.7, 0.04], [bell(3520, 0.08), 0.5, 0.08]);
      return mix([thump(95, 40, 0.06, 0.2, 0.002), 0.9], [chord, 0.8], [riser, 0.3], [sparkle, 0.3, 0.72]);
    },
  },

  overprint_end: {
    level: 0.3, vars: 1, jitter: 0, send: 2, gap: 0.3, prio: 2,
    make({ osc, filt, env, glide, points, thump, mix }) {
      const down = env(
        filt(osc(0.45, 'saw', glide(440, 98, 0.42)), 'lp', (t) => 3200 * Math.exp(-t / 0.14) + 200, 2),
        points([[0, 0], [0.01, 1], [0.35, 0.7], [0.45, 0]]));
      return mix([down, 1], [thump(100, 45, 0.03, 0.05), 0.7, 0.4]);
    },
  },

  pickup_respawn: {
    level: 0.2, vars: 2, jitter: 0.03, send: 2, gap: 0.1, prio: 0,
    make({ noise, filt, env, decay, bloop, bell, mix }) {
      return mix([bloop(560, 940, 0.06), 1], [bell(1880, 0.06, 0.5), 0.5, 0.045], [env(filt(noise(0.08), 'hp', 4000), decay(0.02, 0.01)), 0.15]);
    },
  },

  spawn: {
    level: 0.3, vars: 2, jitter: 0.04, send: 1, gap: 0.1, prio: 1,
    make({ noise, osc, filt, env, glide, points, whoosh, thump, click, mix, jit }) {
      // dot-matrix head: a narrow pulse train through a band-pass, in two passes (zzzt-zzt)
      const pins = filt(osc(0.3, 'square', points([[0, jit(96)], [0.14, 128], [0.15, 110], [0.3, 165]]), { width: 0.18 }), 'bp', jit(2500), 1.6);
      const head = env(pins, points([[0, 0], [0.006, 1], [0.135, 1], [0.145, 0.1], [0.165, 1], [0.29, 1], [0.3, 0]]));
      const motor = env(osc(0.36, 'sine', glide(720, 1350, 0.34)), points([[0, 0], [0.02, 1], [0.3, 0.8], [0.36, 0]]));
      const feed = whoosh(0.34, 3400, 0.7, points([[0, 0], [0.03, 0.6], [0.3, 1], [0.34, 0]]));
      return mix([head, 0.8], [motor, 0.07], [feed, 0.25], [thump(170, 80, 0.015, 0.03), 0.8, 0.33], [click(1900, 0.004), 0.7, 0.33]);
    },
  },

  countdown_tick: {
    level: 0.26, vars: 1, jitter: 0, send: 0, gap: 0.1, prio: 2,
    make({ modes, click, mix }) {
      return mix([click(2500, 0.002), 0.5], [modes(0.16, [[880, 0.028, 1], [1760, 0.014, 0.3], [2640, 0.008, 0.15]]), 1]);
    },
  },

  countdown_go: {
    level: 0.42, vars: 1, jitter: 0, send: 2, gap: 0.2, prio: 3, duck: 0.4,
    make({ noise, filt, env, decay, saws, bell, thump, mix }) {
      const chord = mix(...[72, 76, 79, 84].map((n) => [saws(midiHz(n), 0.34, { cutoff: 4800, close: 0.16 }), 0.4]));
      const burst = env(filt(noise(0.2), 'hp', 3000), decay(0.04));
      return mix([thump(140, 55, 0.03, 0.07), 0.8], [bell(1760, 0.1, 0.6), 0.6], [chord, 0.8], [burst, 0.25]);
    },
  },

  round_win: {
    level: 0.4, vars: 1, jitter: 0, send: 2, gap: 0.5, prio: 3, duck: 0.6,
    make({ saws, pluck, bell, mix }) {
      const stab = (dur) => (hz) => mix([saws(hz, dur, { cutoff: 4200, close: 0.14 }), 0.7], [pluck(hz * 2, 0.08), 0.4]);
      const run = seq(mix, [[67, 0], [72, 0.1], [76, 0.2]], stab(0.1));
      const landing = seq(mix, [[72, 0.32, 0.6], [76, 0.32, 0.6], [79, 0.32, 1], [84, 0.32, 0.7]], stab(0.5));
      return mix([run, 0.8], [landing, 0.7], [bell(3136, 0.14, 0.5), 0.2, 0.32]);
    },
  },

  round_lose: {
    level: 0.34, vars: 1, jitter: 0, send: 2, gap: 0.5, prio: 3, duck: 0.6,
    make({ saws, filt, mix }) {
      const sad = (dur) => (hz) => saws(hz, dur, { cutoff: 1500, close: 0.2, detune: 0.014 });
      const fall = seq(mix, [[76, 0], [72, 0.2], [69, 0.4]], sad(0.2));
      const sigh = seq(mix, [[57, 0.4, 0.8], [64, 0.4, 0.6], [69, 0.4, 0.5]], sad(0.55));
      return filt(mix([fall, 0.8], [sigh, 0.7]), 'lp', 2600);
    },
  },

  match_win: {
    level: 0.45, vars: 1, jitter: 0, send: 3, gap: 1, prio: 3, duck: 0.8,
    make({ saws, pluck, bell, thump, noise, filt, env, decay, mix }) {
      const brass = (dur) => (hz) => mix([saws(hz, dur, { cutoff: 4600, close: 0.2, attack: 0.008 }), 0.7], [pluck(hz * 2, 0.07), 0.3]);
      // da-da-da-DAAA … da-DAAAAA
      const call = seq(mix, [[67, 0], [72, 0.13], [76, 0.26]], brass(0.11));
      const hold = seq(mix, [[79, 0.39]], brass(0.24));
      const turn = seq(mix, [[76, 0.66]], brass(0.11));
      const final = seq(mix, [[60, 0.79, 0.6], [67, 0.79, 0.6], [72, 0.79, 0.7], [76, 0.79, 0.7], [84, 0.79, 1]], brass(0.95));
      const glitter = seq(mix, [[96, 0.82], [100, 0.9, 0.8], [103, 0.98, 0.7], [108, 1.06, 0.6]], (hz) => bell(hz, 0.12, 0.5));
      const hits = [0, 0.39, 0.79].map((at) => [thump(130, 50, 0.03, 0.08), 0.7, at]);
      const crash = env(filt(noise(0.9), 'hp', 4500), decay(0.22, 0.002));
      return mix([call, 0.8], [hold, 0.85], [turn, 0.8], [final, 0.7], [glitter, 0.16], ...hits, [crash, 0.16, 0.79]);
    },
  },

  match_lose: {
    level: 0.36, vars: 1, jitter: 0, send: 3, gap: 1, prio: 3, duck: 0.8,
    make({ osc, filt, env, points, glide, thump, mix }) {
      // a tired tune whose last note runs out of power (tape-stop droop)
      const note = (hz, dur, droop) => {
        const f = droop ? glide(hz, hz * 0.55, dur, 2.2) : () => hz;
        const pair = mix([osc(dur, 'saw', (t) => f(t) * 0.992), 0.5], [osc(dur, 'saw', (t) => f(t) * 1.008), 0.5]);
        return env(filt(pair, 'lp', 1700, 1.2), points([[0, 0], [0.01, 1], [dur * 0.7, 0.8], [dur, 0]]));
      };
      const tune = mix(
        [note(midiHz(76), 0.22), 1], [note(midiHz(74), 0.22), 1, 0.22], [note(midiHz(72), 0.22), 1, 0.44],
        [note(midiHz(69), 1.0, true), 1, 0.66], [note(midiHz(57), 1.0, true), 0.7, 0.66], [note(midiHz(64), 1.0, true), 0.5, 0.66]);
      return mix([tune, 1], [thump(90, 40, 0.04, 0.09), 0.6, 1.55]);
    },
  },

  announce: {
    level: 0.46, vars: 2, jitter: 0.01, send: 3, gap: 0.2, prio: 3, duck: 0.6,
    make({ noise, filt, env, decay, saws, thump, drive, mix }) {
      const boom = drive(thump(115, 42, 0.07, 0.2, 0.002), 2);
      const slap = env(filt(noise(0.1), 'lp', 1300), decay(0.018));
      // sus4 stab: big, unresolved, "something just happened"
      const stab = mix(...[50, 57, 62, 67, 69].map((n) => [saws(midiHz(n), 0.42, { cutoff: 3800, close: 0.2 }), 0.35]));
      return mix([boom, 1], [slap, 0.7], [stab, 0.7, 0.004]);
    },
  },

  streak: {
    level: 0.34, vars: 1, jitter: 0, send: 2, gap: 0.2, prio: 3, duck: 0.3,
    make({ pluck, bell, mix }) {
      const run = seq(mix, [[88, 0], [91, 0.045], [93, 0.09], [96, 0.135]], (hz) => pluck(hz, 0.05, 0.8));
      return mix([run, 0.8], [bell(midiHz(100), 0.12, 0.6), 0.5, 0.18]);
    },
  },

  card_reveal: {
    level: 0.24, vars: 3, jitter: 0.05, send: 1, gap: 0.04, prio: 2,
    make({ whoosh, points, thump, click, mix, jit }) {
      const peak = jit(5200, 0.1);
      const slide = whoosh(0.2, (t) => 1500 + (peak - 1500) * Math.sin(Math.PI * Math.min(1, t / 0.2)), 1,
        (t) => points([[0, 0], [0.03, 0.8], [0.15, 1], [0.2, 0]])(t) * (0.75 + 0.25 * Math.sin(t * 400)));
      return mix([slide, 1], [click(1800, 0.006, 0.8), 0.8, 0.19], [thump(230, 120, 0.01, 0.018), 0.5, 0.19]);
    },
  },

  card_hover: {
    level: 0.09, vars: 3, jitter: 0.05, send: 0, gap: 0.04, prio: 1,
    make({ modes, click, mix, jit }) {
      return mix([click(jit(3200), 0.003), 1], [modes(0.04, [[jit(1250), 0.007, 0.5]]), 1]);
    },
  },

  card_pick: {
    level: 0.42, vars: 1, jitter: 0.01, send: 2, gap: 0.1, prio: 3, duck: 0.4,
    make({ noise, filt, env, decay, thump, drive, bell, mix }) {
      const thunk = drive(thump(128, 55, 0.03, 0.06, 0.0015), 2);
      const slap = env(filt(noise(0.08), 'lp', 1100), decay(0.014));
      const sparkle = mix([bell(2637, 0.07), 1, 0.05], [bell(3520, 0.07), 0.8, 0.1], [bell(5274, 0.09), 0.6, 0.15]);
      return mix([thunk, 1], [slap, 0.7], [sparkle, 0.28]);
    },
  },
};

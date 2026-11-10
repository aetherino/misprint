// Combat feedback (always 2D). `hit` is the dopamine sound: a pure 3-6 kHz tick that nothing else
// in the game occupies (the music bus has an EQ notch there), so it reads through any firefight.
import { midiHz } from '../dsp.js';

export default {
  hit: {
    level: 0.5, vars: 2, jitter: 0.012, send: 0, gap: 0.02, prio: 3, duck: 0.12,
    make({ modes, click, mix }) {
      const tick = modes(0.07, [[3150, 0.012, 1], [4725, 0.009, 0.55], [6300, 0.006, 0.3]]);
      const knock = modes(0.02, [[1050, 0.004, 0.5]]);
      return mix([click(6500, 0.0012, 1, 'hp'), 0.7], [tick, 1], [knock, 0.6]);
    },
  },

  hit_head: {
    level: 0.52, vars: 2, jitter: 0.012, send: 1, gap: 0.02, prio: 3, duck: 0.15,
    make({ modes, click, bell, mix }) {
      const tick = modes(0.07, [[3150, 0.012, 1], [4725, 0.009, 0.55], [6300, 0.006, 0.3]]);
      const ding = mix([bell(5300, 0.045, 0.6), 1], [bell(7950, 0.03, 0.4), 0.5, 0.012]);
      return mix([click(6500, 0.0012, 1, 'hp'), 0.7], [tick, 1], [ding, 0.75, 0.006]);
    },
  },

  kill: {
    level: 0.55, vars: 2, jitter: 0.01, send: 2, gap: 0.05, prio: 3, duck: 0.4,
    make({ noise, filt, env, decay, thump, drive, bell, modes, mix }) {
      // rubber stamp comes down…
      const stamp = mix(
        [drive(thump(160, 66, 0.02, 0.034), 1.8), 1],
        [env(filt(noise(0.06), 'lp', 950), decay(0.011)), 0.7]);
      // …and the till rings: a rising fifth, second note long and shimmery
      const ka = bell(midiHz(88), 0.045, 0.7);
      const ching = mix(
        [bell(midiHz(95), 0.15, 0.9), 1],
        [modes(0.5, [[midiHz(107), 0.09, 0.3], [6270, 0.05, 0.18], [8372, 0.035, 0.1]]), 1]);
      return mix([stamp, 0.85], [ka, 0.6], [stamp, 0.4, 0.085], [ching, 0.8, 0.085]);
    },
  },

  hurt: {
    // `muffle` dips a low-pass over the positional world for a moment: the "ow" you feel, not hear
    level: 0.5, vars: 3, jitter: 0.05, send: 0, gap: 0.05, prio: 3, duck: 0.45, muffle: 1,
    make({ noise, filt, env, decay, thump, drive, modes, mix, jit }) {
      const body = drive(thump(jit(145), 52, 0.03, 0.055, 0.0015), 2);
      const flesh = env(filt(noise(0.14), 'lp', 520), decay(0.028));
      const knock = modes(0.08, [[jit(232), 0.018, 0.6], [jit(410), 0.01, 0.25]]);
      return mix([body, 1], [flesh, 0.8], [knock, 0.5]);
    },
  },

  die: {
    level: 0.5, vars: 2, jitter: 0.03, send: 2, gap: 0.2, prio: 3, duck: 0.5,
    make({ noise, osc, filt, env, glide, points, thump, click, drive, mix, jit }) {
      // a shredder eating the page while the tape motor loses power
      const dur = 0.8, slow = glide(1, 0.07, dur, 1.5), whine = jit(330, 0.03);
      const motor = filt(osc(dur, 'saw', (t) => whine * slow(t)), 'lp', (t) => 3200 * slow(t) + 180, 1.5);
      const teeth = osc(dur, 'square', (t) => 96 * slow(t), { width: 0.25 });
      const paper = filt(noise(dur), 'bp', (t) => 2700 * slow(t) + 280, 1.1);
      for (let i = 0; i < paper.length; i++) paper[i] *= 0.45 + 0.55 * teeth[i];
      const shred = env(mix([motor, 0.45], [paper, 0.9]), points([[0, 0], [0.008, 1], [0.55, 0.75], [dur, 0]]));
      return mix([click(2800, 0.003), 0.8], [shred, 1], [drive(thump(95, 38, 0.04, 0.08), 1.6), 0.8, 0.66]);
    },
  },

  second_draft: {
    level: 0.42, vars: 1, jitter: 0, send: 3, gap: 0.3, prio: 3, duck: 0.5,
    make({ noise, filt, env, decay, saws, reverse, bell, mix }) {
      const chord = [69, 73, 76].map((n) => [saws(midiHz(n), 0.5, { cutoff: 2600, close: 0.3 }), 0.4]);
      const air = [env(filt(noise(0.5), 'hp', 2500), decay(0.14)), 0.5];
      const swell = reverse(env(mix(...chord, air), decay(0.13)));
      const chime = mix(...[81, 85, 88, 93].map((n, i) => [bell(midiHz(n), 0.2, 0.7), 1 - i * 0.12, i * 0.035]));
      return mix([swell, 0.8], [chime, 0.7, 0.47]);
    },
  },
};

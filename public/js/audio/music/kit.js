// The soundtrack's sample kit, rendered by the same DSP toolkit as the sfx. Pitched samples
// (stab / ep / lead) are rendered at a reference note and re-pitched by playback rate, sampler
// style — that slight chipmunk/slow-down colouring is half of the jungle sound.
import { midiHz } from '../dsp.js';

/** MIDI note every pitched sample is rendered at. */
export const REF_NOTE = { stab: 60, ep: 60, lead: 72 };

export const KIT = {
  kick: {
    level: 0.9,
    make({ thump, click, drive, mix }) {
      return mix([drive(thump(190, 47, 0.028, 0.11, 0.0008), 2.2), 1], [thump(430, 120, 0.006, 0.012), 0.4], [click(3200, 0.002), 0.3]);
    },
  },
  kick_soft: {
    level: 0.9,
    make({ thump, drive, filt, mix }) {
      return filt(mix([drive(thump(150, 44, 0.035, 0.15, 0.002), 1.6), 1], [thump(300, 100, 0.008, 0.015), 0.25]), 'lp', 2200);
    },
  },
  snare: {
    level: 0.8,
    make({ noise, filt, env, decay, thump, modes, drive, mix }) {
      const body = thump(255, 178, 0.012, 0.045);
      const ring = modes(0.15, [[331, 0.035, 0.5], [473, 0.02, 0.3]]);
      const wires = env(filt(noise(0.3), 'bp', 3300, 0.6), decay(0.06));
      const crack = env(filt(noise(0.08), 'hp', 5500), decay(0.014));
      return drive(mix([body, 0.9], [ring, 0.4], [wires, 0.8], [crack, 0.6]), 1.5);
    },
  },
  rim: {
    level: 0.6,
    make({ modes, click, mix }) {
      return mix([click(2600, 0.002), 0.8], [modes(0.06, [[820, 0.011, 1], [1745, 0.008, 0.6], [2930, 0.005, 0.3]]), 1]);
    },
  },
  hat: {
    level: 0.5, vars: 2,
    make({ noise, osc, filt, env, decay, mix, jit }) {
      const metal = mix(...[5230, 6170, 7410, 8730, 10290].map((f) => [osc(0.07, 'square', jit(f, 0.01)), 0.2]));
      const body = mix([filt(metal, 'hp', 7000), 0.6], [filt(noise(0.07), 'hp', 7800), 1]);
      return env(body, decay(0.013));
    },
  },
  hat_open: {
    level: 0.45,
    make({ noise, osc, filt, env, decay, mix }) {
      const metal = mix(...[5230, 6170, 7410, 8730, 10290].map((f) => [osc(0.4, 'square', f), 0.2]));
      const body = mix([filt(metal, 'hp', 6500), 0.7], [filt(noise(0.4), 'hp', 7000), 1]);
      return env(body, decay(0.075, 0.001));
    },
  },
  shaker: {
    level: 0.35, vars: 2,
    make({ noise, filt, env, points }) {
      return env(filt(noise(0.07), 'bp', 6400, 1.2), points([[0, 0], [0.012, 1], [0.03, 0.4], [0.07, 0]]));
    },
  },
  crash: {
    level: 0.5,
    make({ noise, filt, env, decay, modes, mix }) {
      const wash = env(filt(noise(1.4), 'hp', 3600), decay(0.3, 0.002));
      const metal = modes(1.2, [[3410, 0.25, 0.3], [4870, 0.2, 0.25], [6130, 0.16, 0.2], [8350, 0.12, 0.15]]);
      return mix([wash, 1], [metal, 0.35]);
    },
  },
  // reversed crash: the breath before a section lands
  swell: {
    level: 0.4,
    make({ noise, filt, env, decay, reverse }) {
      return reverse(env(filt(noise(0.9), 'bp', (t) => 5200 * Math.exp(-t / 0.4) + 700, 0.8), decay(0.2)));
    },
  },
  // office percussion: a stapler click standing in for a hi-hat…
  staple: {
    level: 0.5, vars: 2,
    make({ noise, filt, env, decay, modes, mix, jit }) {
      const ka = env(filt(noise(0.012), 'bp', jit(3600, 0.08), 1.1), decay(0.002));
      const ring = modes(0.04, [[jit(2150), 0.006, 0.8], [jit(3380), 0.007, 0.6], [jit(5240), 0.005, 0.4]]);
      const chunk = modes(0.04, [[jit(880), 0.008, 0.6], [jit(1560), 0.007, 0.4]]);
      return mix([ka, 0.9], [ring, 0.5], [chunk, 0.6, 0.011]);
    },
  },
  // …and a dot-matrix print head zipping across the page for fills
  zip: {
    level: 0.45, vars: 2,
    make({ osc, filt, env, points, jit }) {
      const pins = filt(osc(0.13, 'square', points([[0, jit(110)], [0.13, jit(190)]]), { width: 0.18 }), 'bp', jit(2600), 1.8);
      return env(pins, points([[0, 0], [0.004, 1], [0.115, 1], [0.13, 0]]));
    },
  },
  // rave stab: detuned saws through a fast-closing filter
  stab: {
    level: 0.6,
    make({ saws, drive }) {
      return drive(saws(midiHz(REF_NOTE.stab), 0.32, { cutoff: 4200, close: 0.08, detune: 0.012, release: 0.12 }), 1.3);
    },
  },
  // warm FM electric piano for the menu
  ep: {
    level: 0.6,
    make({ fm, filt, env, decay, mix }) {
      const hz = midiHz(REF_NOTE.ep);
      const tone = env(fm(1.6, hz, 1, (t) => 1.7 * Math.exp(-t / 0.3)), decay(0.5, 0.004));
      const tine = env(fm(0.3, hz, 14, (t) => 0.5 * Math.exp(-t / 0.04)), decay(0.06, 0.002));
      return filt(mix([tone, 1], [tine, 0.25]), 'lp', 3400);
    },
  },
  // lead: nasal pulse pluck, the "marker pen" voice of the hook
  lead: {
    level: 0.6,
    make({ osc, filt, env, decay, mix }) {
      const hz = midiHz(REF_NOTE.lead);
      const pulse = filt(osc(0.6, 'square', hz, { width: 0.32 }), 'lp', (t) => 1300 + 3600 * Math.exp(-t / 0.07), 2);
      return env(mix([pulse, 1], [osc(0.6, 'sine', hz * 2), 0.2]), decay(0.17, 0.003));
    },
  },
  // paper dust: sparse crackle + hiss bed for the lo-fi states (looped)
  dust: {
    raw: true,
    make({ noise, filt, rng, len }) {
      const n = len(3), out = filt(noise(3), 'hp', 2500);
      for (let i = 0; i < n; i++) out[i] *= 0.012;
      for (let i = 0; i < 14; i++) {
        const at = Math.floor(rng() * (n - 200)), a = (rng() < 0.5 ? -1 : 1) * (0.04 + 0.1 * rng() * rng()), tau = 4 + rng() * 6;
        for (let j = 0; j < 60; j++) out[at + j] += a * Math.exp(-j / tau) * (j % 2 ? -0.6 : 1);
      }
      // quiet enough at both ends that the loop point needs no cross-fade
      for (let i = 0; i < 400; i++) { out[i] *= i / 400; out[n - 1 - i] *= i / 400; }
      return out;
    },
  },
};

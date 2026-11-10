// UI sounds: tiny, dry and quiet. Ticks stay under 120 ms so sweeping the mouse across a menu
// sounds like riffling paper, not a pinball table.
import { midiHz } from '../dsp.js';

export default {
  ui_hover: {
    level: 0.06, vars: 3, jitter: 0.04, send: 0, gap: 0.03, prio: 1,
    make({ modes, click, mix, jit }) {
      return mix([click(4200, 0.0015), 0.5], [modes(0.04, [[jit(2200), 0.006, 1], [jit(3300), 0.004, 0.4]]), 1]);
    },
  },

  ui_click: {
    level: 0.13, vars: 2, jitter: 0.03, send: 0, gap: 0.03, prio: 2,
    make({ modes, click, mix, jit }) {
      return mix([click(3000, 0.0015), 0.8], [modes(0.07, [[jit(1400), 0.008, 1], [jit(700), 0.012, 0.7]]), 1]);
    },
  },

  ui_back: {
    level: 0.11, vars: 1, jitter: 0.02, send: 0, gap: 0.05, prio: 2,
    make({ modes, mix }) {
      return mix([modes(0.05, [[1100, 0.01, 1]]), 1], [modes(0.06, [[740, 0.012, 1]]), 0.9, 0.05]);
    },
  },

  ui_toggle: {
    level: 0.11, vars: 1, jitter: 0.02, send: 0, gap: 0.05, prio: 2,
    make({ click, bloop, mix }) {
      return mix([click(2400, 0.002), 1.6], [bloop(900, 1500, 0.035), 1, 0.004]);
    },
  },

  chat: {
    level: 0.14, vars: 1, jitter: 0.02, send: 1, gap: 0.08, prio: 1,
    make({ pluck, mix }) {
      return mix([pluck(midiHz(76), 0.035, 0.3), 1], [pluck(midiHz(81), 0.05, 0.3), 0.9, 0.07]);
    },
  },

  join: {
    level: 0.17, vars: 1, jitter: 0, send: 1, gap: 0.1, prio: 1,
    make({ pluck, whoosh, points, mix }) {
      const paper = whoosh(0.1, (t) => 1500 + 20000 * t, 1, points([[0, 0], [0.04, 1], [0.1, 0]]));
      return mix([paper, 0.25], [pluck(midiHz(79), 0.06, 0.5), 1, 0.02], [pluck(midiHz(84), 0.1, 0.5), 1, 0.11]);
    },
  },

  leave: {
    level: 0.15, vars: 1, jitter: 0, send: 1, gap: 0.1, prio: 1,
    make({ pluck, filt, mix }) {
      return filt(mix([pluck(midiHz(84), 0.06, 0.3), 1], [pluck(midiHz(79), 0.1, 0.3), 1, 0.09]), 'lp', 2400);
    },
  },
};

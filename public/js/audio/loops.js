// Looping beds (slide, wallrun, charge, overprint, wind): each is a seamless pre-rendered buffer
// played by one looping BufferSource whose gain and playback rate follow opts.vol / opts.pitch.
import { seamless } from './dsp.js';

const TAU = Math.PI * 2;

/** Peak-normalise a loop without touching its ends (finalize() would fade them and break the seam). */
function level(x, peak) {
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]));
  for (let i = 0; i < x.length; i++) x[i] *= peak / max;
  return x;
}

/** Second half of a periodic render: filters have settled, so start and end states match. */
const settled = (x) => x.slice(x.length / 2);

export const LOOP_DEFS = {
  // paper hiss under a sliding sneaker
  slide: {
    raw: true, fadeIn: 0.04, fadeOut: 0.12,
    make({ sr, noise, filt, env, crush, mix }) {
      const dur = 1.3;
      const hiss = env(filt(filt(noise(dur), 'bp', 2600, 0.9), 'lp', 5200), (t) => 0.75 + 0.15 * Math.sin(TAU * 7 * t) + 0.1 * Math.sin(TAU * 11.3 * t));
      const gate = crush(noise(dur), Math.round(sr * 0.006));
      const grit = env(filt(noise(dur), 'bp', 5500, 1.5), (t) => (gate[Math.round(t * sr)] > 0.2 ? 1 : 0.15));
      const rumble = filt(noise(dur), 'lp', 240);
      return level(seamless(mix([hiss, 1], [grit, 0.2], [rumble, 1.2]), sr, 0.1), 0.16);
    },
  },

  // quick light steps along the wall + air rushing past
  wallrun: {
    raw: true, fadeIn: 0.03, fadeOut: 0.1,
    make({ sr, noise, filt, env, decay, thump, click, mix }) {
      const stepGap = 0.135, dur = stepGap * 4;
      const wind = seamless(filt(filt(noise(dur + 0.08), 'bp', 950, 0.8), 'lp', 2800), sr, 0.08);
      const steps = [0, 1, 2, 3].map((i) => {
        const tap = mix(
          [thump(i % 2 ? 150 : 132, 78, 0.01, 0.014, 0.002), 1],
          [env(filt(noise(0.05), 'bp', i % 2 ? 2900 : 2500, 1), decay(0.008, 0.002)), 0.35],
          [click(1500, 0.003), 0.3]);
        return [tap, 1.5, i * stepGap + 0.004];
      });
      return level(mix([wind, 0.7], ...steps).subarray(0, wind.length), 0.2);
    },
  },

  // marker squeak: opts.pitch 0.5 → 2 sweeps it two octaves, stick-slip wobble speeding up with it
  charge: {
    raw: true, fadeIn: 0.03, fadeOut: 0.05,
    make({ sr, osc, filt, noise, env, mix }) {
      const dur = 0.5, f = 440; // 220 cycles and 12 wobble cycles per loop: seamless by construction
      const wob = (t) => Math.sin(TAU * 24 * t);
      const squeak = filt(osc(dur * 2, 'square', (t) => f * (1 + 0.035 * wob(t)), { width: 0.28 }), 'bp', (t) => 1750 + 500 * wob(t), 3);
      const squeal = env(osc(dur * 2, 'sine', (t) => f * 3 * (1 + 0.035 * wob(t))), (t) => 0.6 + 0.4 * wob(t));
      const tone = settled(env(mix([squeak, 1], [squeal, 0.25]), (t) => 0.8 + 0.2 * wob(t)));
      // the felt-tip friction noise is not periodic, so it gets cross-faded instead
      const felt = seamless(env(filt(noise(dur + 0.05), 'bp', 2600, 1.5), (t) => 0.5 + 0.5 * wob(t + 0.01)), sr, 0.05);
      return level(mix([tone, 1], [felt, 0.18]).subarray(0, tone.length), 0.16);
    },
  },

  // double-damage buff: a 4 Hz pulsing mains hum with a faint shimmer on top
  overprint: {
    raw: true, fadeIn: 0.15, fadeOut: 0.25,
    make({ osc, filt, env, mix }) {
      const dur = 2; // rendered twice the 1 s loop, second half kept
      const pulse = (t) => 0.55 + 0.45 * Math.sin(TAU * 4 * t);
      const hum = filt(mix([osc(dur, 'saw', 55), 1], [osc(dur, 'saw', 110), 0.5], [osc(dur, 'square', 165), 0.2]), 'lp', (t) => 260 + 420 * pulse(t), 1.2);
      const shimmer = env(mix([osc(dur, 'sine', 880), 1], [osc(dur, 'sine', 1320), 0.6], [osc(dur, 'sine', 1763), 0.3]), (t) => 0.5 + 0.5 * Math.sin(TAU * 8 * t));
      return level(settled(mix([env(hum, pulse), 1], [shimmer, 0.07])), 0.13);
    },
  },

  // speed wind: opts.vol and opts.pitch should both rise with the player's speed
  wind: {
    raw: true, fadeIn: 0.2, fadeOut: 0.3,
    make({ sr, noise, filt, env, mix }) {
      const dur = 2.6;
      const gust = (t) => 0.75 + 0.15 * Math.sin(TAU * 0.83 * t) + 0.1 * Math.sin(TAU * 2.1 * t + 1);
      const body = env(filt(filt(noise(dur), 'bp', 520, 0.6), 'lp', 1600), gust);
      const whistle = env(filt(noise(dur), 'bp', (t) => 1500 + 300 * Math.sin(TAU * 1.3 * t), 3), (t) => gust(t + 0.4));
      return level(seamless(mix([body, 1], [whistle, 0.25]), sr, 0.2), 0.2);
    },
  },
};

export function createLoops(ctx, out, bank) {
  const live = new Map(); // name -> { src, gain, vol, rate }

  function start(name, def) {
    const src = ctx.createBufferSource();
    src.buffer = bank.get(name)[0];
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(out);
    // start at a random phase so re-triggered loops do not always open on the same grain
    src.start(ctx.currentTime, Math.random() * src.buffer.duration);
    const l = { src, gain, vol: -1, rate: 1, def };
    live.set(name, l);
    return l;
  }

  function stop(name, l) {
    const now = ctx.currentTime, tau = l.def.fadeOut / 3;
    l.gain.gain.cancelScheduledValues(now);
    l.gain.gain.setTargetAtTime(0, now, tau);
    l.src.stop(now + l.def.fadeOut * 2);
    l.src.onended = () => l.gain.disconnect();
    live.delete(name);
  }

  /** Start / update / stop a loop. Safe to call every frame; unchanged values schedule nothing. */
  function set(name, on, opts = {}) {
    const def = LOOP_DEFS[name];
    let l = live.get(name);
    if (!on) {
      if (l) stop(name, l);
      return;
    }
    const fresh = !l;
    if (fresh) l = start(name, def);
    const now = ctx.currentTime;
    const vol = Math.min(1.5, Math.max(0, opts.vol ?? 1)), rate = Math.min(4, Math.max(0.25, opts.pitch || 1));
    if (Math.abs(vol - l.vol) > 0.004) {
      l.vol = vol;
      l.gain.gain.setTargetAtTime(vol, now, fresh ? def.fadeIn / 3 : 0.03);
    }
    if (Math.abs(rate - l.rate) > 0.002) {
      l.rate = rate;
      if (fresh) l.src.playbackRate.value = rate;
      else l.src.playbackRate.setTargetAtTime(rate, now, 0.03);
    }
  }

  return { set, active: () => [...live.keys()] };
}

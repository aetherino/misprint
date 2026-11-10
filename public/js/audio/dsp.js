// Offline DSP toolkit: plain buffer math used to pre-render every one-shot, loop bed and
// music-kit sample into Float32Arrays. Nothing here touches WebAudio, so it runs identically
// on a live AudioContext, an OfflineAudioContext, or in node.
import { makeRng } from '../../../shared/rng.js';

const TAU = Math.PI * 2;

export const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/** A toolkit bound to one sample rate and one seeded RNG (the seed is what makes a "variation"). */
export function createDsp(sr, seed) {
  const rng = makeRng(seed);
  const len = (dur) => Math.max(1, Math.round(dur * sr));
  const rand = (lo = 0, hi = 1) => lo + rng() * (hi - lo);
  /** Jitter a design value by ±amt (fraction) so variations differ in timbre, not just noise. */
  const jit = (v, amt = 0.05) => v * (1 + (rng() * 2 - 1) * amt);

  // ---- time functions (envelopes and pitch curves are just t => value) ----
  const decay = (tau, attack = 0) => (t) => (t < attack ? t / attack : Math.exp(-(t - attack) / tau));
  /** Exponential approach from f0 to f1 — the classic drum/laser pitch drop. */
  const sweep = (f0, f1, tau) => (t) => f1 + (f0 - f1) * Math.exp(-t / tau);
  /** Constant-ratio glide from f0 to f1 over dur (curve > 1 = late, < 1 = early). */
  const glide = (f0, f1, dur, curve = 1) => (t) => f0 * Math.pow(f1 / f0, Math.pow(Math.min(1, t / dur), curve));
  /** Piecewise-linear breakpoint envelope: [[t, v], ...]. */
  const points = (pts) => (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t < pts[i][0]) {
        const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
        return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
      }
    }
    return pts[pts.length - 1][1];
  };
  /** Raised-cosine window over [0, dur]. */
  const hann = (dur) => (t) => (t < 0 || t > dur ? 0 : 0.5 - 0.5 * Math.cos((TAU * t) / dur));

  // ---- sources ----
  const blep = (p, dp) => {
    if (p < dp) { const t = p / dp; return t + t - t * t - 1; }
    if (p > 1 - dp) { const t = (p - 1) / dp; return t * t + t + t + 1; }
    return 0;
  };

  /** Band-limited oscillator. freq is Hz or t => Hz. shape: sine | tri | saw | square. */
  function osc(dur, shape, freq, { phase = 0, width = 0.5 } = {}) {
    const n = len(dur), out = new Float32Array(n);
    const dyn = typeof freq === 'function';
    let p = phase % 1, dp = dyn ? 0 : Math.min(0.49, freq / sr);
    for (let i = 0; i < n; i++) {
      if (dyn) dp = Math.min(0.49, Math.max(0, freq(i / sr)) / sr);
      if (shape === 'sine') out[i] = Math.sin(TAU * p);
      else if (shape === 'tri') out[i] = 4 * Math.abs(p - 0.5) - 1;
      else if (shape === 'saw') out[i] = 2 * p - 1 - blep(p, dp);
      else out[i] = (p < width ? 1 : -1) + blep(p, dp) - blep((p + 1 - width) % 1, dp);
      p += dp;
      if (p >= 1) p -= 1;
    }
    return out;
  }

  /** Two-operator FM: sine carrier at freq, modulator at freq*ratio, index is number or t => index. */
  function fm(dur, freq, ratio, index) {
    const n = len(dur), out = new Float32Array(n);
    const fd = typeof freq === 'function', id = typeof index === 'function';
    let pc = 0, pm = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, hz = fd ? freq(t) : freq;
      out[i] = Math.sin(TAU * pc + (id ? index(t) : index) * Math.sin(TAU * pm));
      pc += hz / sr;
      pm += (hz * ratio) / sr;
    }
    return out;
  }

  function noise(dur) {
    const out = new Float32Array(len(dur));
    for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
    return out;
  }

  /** Sum of exponentially decaying sine partials [[hz, tau, gain], ...] — struck metal, glass, bells. */
  function modes(dur, list) {
    const n = len(dur), out = new Float32Array(n);
    for (const [hz, tau, gain = 1] of list) {
      const w = (TAU * hz) / sr, k = Math.exp(-1 / (tau * sr)), ph = rng() * 0.6;
      let a = gain;
      for (let i = 0; i < n; i++) { out[i] += a * Math.sin(w * i + ph); a *= k; }
    }
    return out;
  }

  // ---- processors (return a new buffer unless noted) ----

  /** TPT state-variable filter; cutoff is Hz or t => Hz (stable under fast modulation). type: lp | hp | bp. */
  function filt(x, type, cutoff, q = 0.707) {
    const n = x.length, out = new Float32Array(n);
    const dyn = typeof cutoff === 'function', k = 1 / q;
    let a1, a2, a3, ic1 = 0, ic2 = 0;
    const set = (fc) => {
      const g = Math.tan((Math.PI * Math.min(Math.max(fc, 10), sr * 0.45)) / sr);
      a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
    };
    set(dyn ? cutoff(0) : cutoff);
    for (let i = 0; i < n; i++) {
      if (dyn && (i & 15) === 0) set(cutoff(i / sr));
      const v3 = x[i] - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      out[i] = type === 'lp' ? v2 : type === 'bp' ? k * v1 : x[i] - k * v1 - v2;
    }
    return out;
  }

  /** Multiply by an envelope function, in place. */
  function env(x, f) {
    for (let i = 0; i < x.length; i++) x[i] *= f(i / sr);
    return x;
  }

  /** tanh saturation, in place. amount ~1 = warm, 4+ = crunchy. Output peak stays ≤ 1. */
  function drive(x, amount) {
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * amount);
    return x;
  }

  /** Feedback comb — hollow tubes and short metallic rings. */
  function comb(x, delay, feedback, tail = 0) {
    const d = Math.max(1, Math.round(delay * sr)), out = new Float32Array(x.length + len(tail));
    for (let i = 0; i < out.length; i++) out[i] = (i < x.length ? x[i] : 0) + (i >= d ? out[i - d] * feedback : 0);
    return out;
  }

  /** Sample-and-hold + quantise: dot-matrix / lo-fi grit. */
  function crush(x, hold, levels = 0) {
    const out = new Float32Array(x.length);
    let v = 0;
    for (let i = 0; i < x.length; i++) {
      if (i % hold === 0) v = levels ? Math.round(x[i] * levels) / levels : x[i];
      out[i] = v;
    }
    return out;
  }

  function reverse(x) {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[x.length - 1 - i];
    return out;
  }

  /** Sum parts given as [buffer, gain = 1, startSeconds = 0]. */
  function mix(...parts) {
    let n = 0;
    for (const [b, , at = 0] of parts) n = Math.max(n, Math.round(at * sr) + b.length);
    const out = new Float32Array(n);
    for (const [b, g = 1, at = 0] of parts) {
      const o = Math.round(at * sr);
      for (let i = 0; i < b.length; i++) out[o + i] += b[i] * g;
    }
    return out;
  }

  // ---- compound voices shared by many sounds ----

  /** Filtered noise burst: the "tk" of anything small and hard. */
  const click = (fc, tau, q = 1.2, type = 'bp') => env(filt(noise(tau * 7 + 0.004), type, fc, q), decay(tau));

  /** Pitch-dropping sine: body thumps, kicks, sub punches. */
  const thump = (f0, f1, tauPitch, tauAmp, attack = 0.0008) =>
    env(osc(tauAmp * 6.5, 'sine', sweep(f0, f1, tauPitch)), decay(tauAmp, attack));

  /** Inharmonic bell/ding at hz. */
  const bell = (hz, tau, bright = 1) =>
    modes(tau * 5.5, [[hz, tau, 1], [hz * 2.76, tau * 0.55, 0.36 * bright], [hz * 5.4, tau * 0.3, 0.2 * bright], [hz * 8.93, tau * 0.16, 0.1 * bright]]);

  /** Soft mallet/synth pluck for arpeggios and jingles. */
  const pluck = (hz, tau, bright = 0.5) =>
    mix(
      [env(osc(tau * 5, 'tri', hz), decay(tau, 0.002)), 1],
      [env(osc(tau * 3, 'sine', hz * 2), decay(tau * 0.5, 0.002)), 0.4 * bright],
      [env(osc(tau * 2, 'square', hz * 3.01), decay(tau * 0.22, 0.001)), 0.12 * bright],
    );

  /** Detuned-saw synth note through a closing low-pass: stabs, fanfares, power chords. */
  const saws = (hz, dur, { cutoff = 3000, close = 0.15, detune = 0.008, attack = 0.004, release = 0.05 } = {}) => {
    const a = osc(dur, 'saw', hz * (1 - detune), { phase: rng() });
    const b = osc(dur, 'saw', hz * (1 + detune), { phase: rng() });
    const c = osc(dur, 'saw', hz, { phase: rng() });
    const sum = mix([a, 0.4], [b, 0.4], [c, 0.4]);
    const shaped = filt(sum, 'lp', (t) => cutoff * (0.25 + 0.75 * Math.exp(-t / close)), 1.4);
    return env(shaped, points([[0, 0], [attack, 1], [dur - release, 0.8], [dur, 0]]));
  };

  /** Band-passed noise sweep with its own amplitude shape: every whoosh, swish and scrape. */
  const whoosh = (dur, cutoff, q, shape) => env(filt(noise(dur), 'bp', cutoff, q), shape);

  /** One liquid "bloop": a windowed sine chirp. */
  const bloop = (f0, f1, dur) => env(osc(dur, 'sine', glide(f0, f1, dur, 0.7)), hann(dur));

  /** A scatter of bloops between t0 and t1, thinning and quietening over time. */
  function droplets(count, t0, t1, fLo, fHi) {
    const parts = [];
    for (let i = 0; i < count; i++) {
      const u = Math.pow(rng(), 1.6), f = fLo * Math.pow(fHi / fLo, rng());
      const up = rng() < 0.75 ? rand(1.5, 2.6) : rand(0.5, 0.8);
      parts.push([bloop(f, f * up, rand(0.025, 0.07)), (1 - u * 0.75) * rand(0.5, 1), t0 + u * (t1 - t0)]);
    }
    return mix(...parts);
  }

  return {
    sr, rng, rand, jit, len,
    decay, sweep, glide, points, hann,
    osc, fm, noise, modes,
    filt, env, drive, comb, crush, reverse, mix,
    click, thump, bell, pluck, saws, whoosh, bloop, droplets,
  };
}

/** Peak-normalise to `peak`, strip DC and inaudible tail, and guarantee a click-free end. In place where possible. */
export function finalize(x, sr, peak) {
  // one-pole DC blocker (~20 Hz)
  const r = 1 - (TAU * 20) / sr;
  let px = 0, py = 0, max = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] - px + r * py;
    px = x[i]; py = y; x[i] = y;
    const a = Math.abs(y);
    if (a > max) max = a;
  }
  if (max < 1e-9) return x;
  let end = x.length;
  while (end > 1 && Math.abs(x[end - 1]) < max * 0.001) end--;
  const fade = Math.min(end, Math.round(sr * 0.004));
  end = Math.min(x.length, end + fade);
  const out = x.subarray(0, end), g = peak / max;
  for (let i = 0; i < end; i++) out[i] *= g;
  for (let i = 0; i < fade; i++) out[end - 1 - i] *= i / fade;
  return out;
}

/** Make a buffer loop seamlessly by cross-fading its tail into its head (equal power). Returns the shorter loop. */
export function seamless(x, sr, overlap = 0.08) {
  const o = Math.round(overlap * sr), n = x.length - o, out = new Float32Array(n);
  out.set(x.subarray(0, n));
  for (let i = 0; i < o; i++) {
    const a = i / o;
    out[i] = x[i] * Math.sqrt(a) + x[n + i] * Math.sqrt(1 - a);
  }
  return out;
}

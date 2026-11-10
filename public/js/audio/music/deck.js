// One "deck" = the instrument rack for one playing music state. Two decks overlap briefly during
// a state change (old one sweeps shut and fades, new one lands on its downbeat).
//
//   drum samples → drum bus → soft-clip ─────────────┐
//   sub sine + 2 detuned saws → filter → pump ───────┤   pump = bass/chords bus ducked by the kick
//   chord samples (re-pitched) → pump ───────────────┼→ deck low-pass → fade → graph.musicIn
//   lead samples → dotted-eighth feedback delay ─────┤
//   paper-dust loop ─────────────────────────────────┘        (+ per-style intensity VCA)
//   chords / lead / some drums also feed the shared reverb send
import { midiHz } from '../dsp.js';
import { REF_NOTE } from './kit.js';

const OUTPUT = 0.34; // overall music level into the music bus (tuned against the sfx by tools/audiotest)
const MIX = {
  kick: 0.62, kick_soft: 0.56, snare: 0.9, rim: 0.8, hat: 0.7, hat_open: 0.6, shaker: 0.7,
  crash: 0.6, swell: 0.8, staple: 0.75, zip: 0.7, stab: 0.45, ep: 0.6, lead: 0.7, sub: 0.28, reese: 0.6,
};

function softClip(ctx, amount) {
  const n = 1025, curve = new Float32Array(n), norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * amount) / norm;
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  return shaper;
}

export function createDeck(ctx, graph, kit, style, startAt) {
  const tone = style.tone, stepDur = 15 / style.bpm;
  const gain = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };

  const out = ctx.createBiquadFilter();
  out.type = 'lowpass'; out.Q.value = 0.7; out.frequency.value = 20000;
  const vca = gain(), fade = gain(0), sendFade = gain(0);
  out.connect(vca).connect(fade).connect(graph.musicIn);
  const send = gain(tone.send);
  send.connect(sendFade).connect(graph.musicSend);
  for (const f of [fade, sendFade]) {
    f.gain.setValueAtTime(0, startAt);
    f.gain.linearRampToValueAtTime(OUTPUT * tone.level, startAt + 0.02);
  }

  const drums = gain();
  drums.connect(softClip(ctx, 1.6)).connect(out);
  const pump = gain();
  pump.connect(out);

  // bass: sine sub + two detuned saws an octave up ("reese") through a resonant low-pass
  const sub = ctx.createOscillator(), sawA = ctx.createOscillator(), sawB = ctx.createOscillator();
  sawA.type = sawB.type = 'sawtooth';
  sawA.detune.value = -11; sawB.detune.value = 11;
  const subAmp = gain(0), reeseAmp = gain(0), reeseMix = gain(tone.reese);
  const bassFilter = ctx.createBiquadFilter();
  bassFilter.type = 'lowpass'; bassFilter.Q.value = 3; bassFilter.frequency.value = 300;
  sub.connect(subAmp).connect(pump);
  sawA.connect(reeseMix); sawB.connect(reeseMix);
  reeseMix.connect(bassFilter).connect(reeseAmp).connect(pump);
  for (const o of [sub, sawA, sawB]) o.start(startAt);

  const chords = gain();
  chords.connect(pump); chords.connect(send);

  // lead → dotted-eighth echo with a dark feedback path
  const leadBus = gain(), delay = ctx.createDelay(1), feedback = gain(0.36), echo = gain(tone.delayMix);
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass'; damp.frequency.value = 2200;
  delay.delayTime.value = Math.min(1, stepDur * 3);
  leadBus.connect(out); leadBus.connect(send);
  leadBus.connect(delay).connect(damp).connect(feedback).connect(delay);
  damp.connect(echo).connect(out);

  let dust = null;
  if (tone.dust) {
    dust = ctx.createBufferSource();
    dust.buffer = kit.get('dust')[0];
    dust.loop = true;
    dust.connect(gain(tone.dust)).connect(out);
    dust.start(startAt);
  }

  /** Fire one kit sample. rate re-pitches; hold > 0 gates it after that many seconds. */
  function sample(name, t, level, rate, dest, hold = 0) {
    const variants = kit.get(name), src = ctx.createBufferSource();
    src.buffer = variants[Math.floor(Math.random() * variants.length)];
    src.playbackRate.value = rate;
    const g = gain(level);
    src.connect(g).connect(dest);
    src.start(t);
    if (hold) {
      g.gain.setValueAtTime(level, t + hold);
      g.gain.setTargetAtTime(0, t + hold, 0.03);
      src.stop(t + hold + 0.2);
    }
    src.onended = () => g.disconnect();
    return g;
  }

  let bassCutoff = 300, closing = Infinity;

  const play = {
    drum(e, t) {
      const pitched = e.s.startsWith('kick') || e.s === 'snare' || e.s === 'rim';
      const g = sample(e.s, t, e.v * MIX[e.s] * (0.92 + Math.random() * 0.16), (e.rate || 1) * (pitched ? tone.drumRate : 1), drums);
      if (e.send) { const s = gain(e.send); g.connect(s).connect(send); }
      if (e.s.startsWith('kick') && e.v > 0.6) {
        pump.gain.setTargetAtTime(0.5, t, 0.003);
        pump.gain.setTargetAtTime(1, t + 0.04, 0.06);
      }
    },
    bass(e, t) {
      const hz = midiHz(e.midi), end = t + e.len * stepDur;
      sub.frequency.setTargetAtTime(hz, t, 0.008); // a few ms of glide: the rubber in the bass
      sawA.frequency.setTargetAtTime(hz * 2, t, 0.008);
      sawB.frequency.setTargetAtTime(hz * 2, t, 0.008);
      subAmp.gain.setTargetAtTime(e.v * tone.sub * MIX.sub, t, 0.005);
      subAmp.gain.setTargetAtTime(0, end, 0.03);
      reeseAmp.gain.setTargetAtTime(e.v * MIX.reese, t, 0.005);
      reeseAmp.gain.setTargetAtTime(0, end, 0.03);
      bassFilter.frequency.setTargetAtTime(bassCutoff * 2.4, t, 0.003);
      bassFilter.frequency.setTargetAtTime(bassCutoff, t + 0.015, 0.08);
    },
    chord(e, t) {
      for (const n of e.notes) sample(e.s, t, e.v * MIX[e.s], Math.pow(2, (n - REF_NOTE[e.s]) / 12), chords, e.len * stepDur);
    },
    lead(e, t) {
      sample('lead', t, e.v * MIX.lead, Math.pow(2, (e.midi - REF_NOTE.lead) / 12), leadBus, e.len * stepDur);
    },
  };

  return {
    stepDur,
    trigger: (e, t) => play[e.k](e, t),

    /** Per-step tone update: the deck filter opens with intensity (and whatever shape the style gives it). */
    setTone(intensity, bar, step, t) {
      if (t >= closing) return;
      out.frequency.setTargetAtTime(Math.min(20000, tone.cutoff(intensity, bar, step)), t, 0.06);
      if (tone.gain) vca.gain.setTargetAtTime(tone.gain(intensity), t, 0.1);
      bassCutoff = tone.bassCutoff(intensity, bar, step);
    },

    /** Leave at time T: the filter sweeps shut into T, then a short fade. Click-free by construction. */
    end(T) {
      closing = Math.max(startAt, T - 0.25);
      out.frequency.cancelScheduledValues(closing);
      out.frequency.setTargetAtTime(350, closing, 0.1);
      for (const f of [fade, sendFade]) {
        f.gain.setValueAtTime(OUTPUT * tone.level, Math.max(T, startAt + 0.02));
        f.gain.linearRampToValueAtTime(0, Math.max(T, startAt + 0.02) + 0.35);
      }
      const stopAt = Math.max(T, startAt) + 0.5;
      for (const o of [sub, sawA, sawB]) o.stop(stopAt);
      if (dust) dust.stop(stopAt);
      return stopAt;
    },

    dispose() {
      fade.disconnect();
      sendFade.disconnect();
    },
  };
}

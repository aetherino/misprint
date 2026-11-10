// The fixed part of the audio graph, buildable on any BaseAudioContext (live or offline):
//
//   2D sfx ───────────────┐
//   world sfx → muffle ───┴→ sfx vol ─┐
//   reverb sends → sfx vol → convolver┤
//   music in → hit-notch EQ → duck → music vol ─┴→ master vol → compressor → trim → ceiling → out
//
// The compressor glues the mix and absorbs pile-ups; the wave-shaper after it is a memoryless
// soft clip whose curve tops out at -1 dBFS, so the output can never exceed that whatever happens.
import { createDsp } from './dsp.js';

const CEILING = 0.89;      // -1.0 dBFS
const KNEE = 0.62;         // below this the ceiling stage is perfectly linear
const SHAPER_RANGE = 4;    // input amplitude mapped onto the shaper curve's [-1, 1]
// Blink/WebKit/Gecko compressors add automatic make-up gain derived from threshold/knee/ratio.
// Measured for the settings below (tools/audiotest.mjs asserts it): +4.33 dB. Undo it so that
// quiet material passes at unity and only loud material is touched.
const COMP_MAKEUP_DB = 4.33;
const SENDS = [0, 0.07, 0.16, 0.3];
// Buffers are authored with ~6 dB of headroom; this brings a lone gunshot at the default sliders
// to about -9 dBFS. Pile-ups are the compressor's job.
const MASTER_BOOST = 2.2;

function ceilingCurve() {
  const n = 8193, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * SHAPER_RANGE, a = Math.abs(x);
    const y = a <= KNEE ? a : KNEE + (CEILING - KNEE) * Math.tanh((a - KNEE) / (CEILING - KNEE));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/** Short, dark "print room" impulse: a few early slaps then ~0.6 s of decaying filtered noise. Unit energy. */
function roomImpulse(ctx) {
  const sr = ctx.sampleRate, dur = 0.7;
  const buf = ctx.createBuffer(2, Math.round(dur * sr), sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = createDsp(sr, 7001 + ch * 131);
    const tail = d.env(
      d.filt(d.noise(dur), 'lp', (t) => 6500 * Math.exp(-t / 0.22) + 900),
      (t) => (t < 0.014 ? 0 : Math.exp(-(t - 0.014) / 0.09)));
    for (let i = 0; i < 6; i++) tail[Math.round(d.rand(0.006, 0.05) * sr)] += (d.rng() < 0.5 ? -1 : 1) * d.rand(5, 9) * (1 - i * 0.1);
    let energy = 0;
    for (let i = 0; i < tail.length; i++) energy += tail[i] * tail[i];
    const k = 1 / Math.sqrt(energy), data = buf.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] = tail[i] * k;
  }
  return buf;
}

export function buildGraph(ctx) {
  const gain = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };

  const master = gain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 12;
  comp.attack.value = 0.002; comp.release.value = 0.16;
  const trim = gain(Math.pow(10, -COMP_MAKEUP_DB / 20) / SHAPER_RANGE);
  const ceiling = ctx.createWaveShaper();
  ceiling.curve = ceilingCurve();
  master.connect(comp).connect(trim).connect(ceiling).connect(ctx.destination);

  const reverb = ctx.createConvolver();
  reverb.normalize = false;
  reverb.buffer = roomImpulse(ctx);
  reverb.connect(master);

  // sfx: `self` is 2D feedback/own sounds, `world` is positional and can be muffled when you get hurt
  const self = gain();
  const muffle = ctx.createBiquadFilter();
  muffle.type = 'lowpass'; muffle.frequency.value = 20000; muffle.Q.value = 0.5;
  const world = gain();
  world.connect(muffle).connect(self);
  self.connect(master);
  const sfxSend = gain();
  sfxSend.connect(reverb);
  const sends = SENDS.map((level) => {
    if (!level) return null;
    const s = gain(level);
    s.connect(sfxSend);
    return s;
  });

  // music: the notch keeps the 3-5 kHz slot free for the `hit` tick
  const musicIn = gain();
  const notch = ctx.createBiquadFilter();
  notch.type = 'peaking'; notch.frequency.value = 3600; notch.Q.value = 0.9; notch.gain.value = -5;
  const duck = gain();
  const music = gain();
  musicIn.connect(notch).connect(duck).connect(music).connect(master);
  const musicSend = gain(0);
  musicSend.connect(reverb);

  const ramp = (param, v) => param.setTargetAtTime(v, ctx.currentTime, 0.02);

  return {
    master, self, world, sends, musicIn, musicSend, output: ceiling,

    /** Slider values 0..1 → squared taper (feels linear to the ear). */
    setVolume({ master: m, music: mu, sfx: s }) {
      ramp(master.gain, m * m * MASTER_BOOST);
      ramp(self.gain, s * s);
      ramp(sfxSend.gain, s * s);
      ramp(music.gain, mu * mu);
      ramp(musicSend.gain, mu * mu);
    },

    /** Side-chain style dip of the music under a big sound. depth 0..1. */
    duckMusic(depth, at) {
      duck.gain.setTargetAtTime(1 - 0.75 * Math.min(1, depth), at, 0.012);
      duck.gain.setTargetAtTime(1, at + 0.09, 0.2);
    },

    /** Getting hit: the world goes briefly dull (low-pass dip on positional sfx). amount 0..1. */
    muffleWorld(amount, at) {
      muffle.frequency.setTargetAtTime(20000 * Math.pow(0.035, Math.min(1, amount)), at, 0.008);
      muffle.frequency.setTargetAtTime(20000, at + 0.1, 0.16);
    },
  };
}

// One-shot playback: BufferSource → gain → [low-pass] → [pan] → bus. Keeps combat clean with
// three guards: a per-name rate limit (nine pellet impacts = one tick), crowd scaling (the fifth
// simultaneous stapler is quieter than the first), and a hard voice cap that steals the oldest,
// least important voice.

const MAX_VOICES = 28;
const CROWD_WINDOW = 0.12; // seconds: same-name voices started this recently count as a crowd
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function createVoices(ctx, graph, bank, listener) {
  const lastStart = new Map();   // name -> scheduled start time of the latest play
  const lastVariant = new Map(); // name -> index, so the same variation never plays twice running
  let voices = [];

  function steal(prio, at) {
    let victim = null;
    for (const v of voices) if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.t0 < victim.t0)) victim = v;
    if (victim.prio > prio) return false;
    victim.gain.gain.setTargetAtTime(0, at, 0.004);
    victim.src.stop(at + 0.03);
    voices = voices.filter((v) => v !== victim);
    return true;
  }

  /** @returns true if a voice was started */
  function play(name, defs, opts = {}) {
    const def = defs[name];
    let at = ctx.currentTime + Math.max(0, opts.delay || 0);
    if (at - (lastStart.get(name) ?? -1) < def.gap) return false;

    let level = clamp(opts.vol ?? 1, 0, 1.5), pan = 0, cutoff = 0, send = def.send;
    const positional = !!opts.pos;
    if (positional) {
      const s = listener.locate(opts.pos, def.reach);
      level *= s.gain;
      pan = s.pan; cutoff = s.cutoff; at += s.delay;
      if (s.dist > 20 && send < 3) send++; // distant = more room than source
    }
    if (level < 0.004) return false;

    voices = voices.filter((v) => v.t1 > at);
    let crowd = 0;
    for (const v of voices) if (v.name === name && at - v.t0 < CROWD_WINDOW) crowd++;
    level /= Math.sqrt(1 + 0.6 * crowd);
    if (voices.length >= MAX_VOICES && !steal(def.prio, at)) return false;
    lastStart.set(name, at);

    const variants = bank.get(name);
    let idx = Math.floor(Math.random() * variants.length);
    if (variants.length > 1 && idx === lastVariant.get(name)) idx = (idx + 1) % variants.length;
    lastVariant.set(name, idx);

    const vol = clamp(opts.vol ?? 1, 0, 1);
    const rate = clamp((opts.pitch || 1) * (1 + (Math.random() * 2 - 1) * def.jitter) * (1 + (def.volPitch || 0) * (1 - vol)), 0.25, 4);
    const src = ctx.createBufferSource();
    src.buffer = variants[idx];
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = level;
    let tail = src.connect(gain);
    if (cutoff) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0.5;
      tail = tail.connect(lp);
    }
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      tail = tail.connect(p);
    }
    tail.connect(positional ? graph.world : graph.self);
    if (send) tail.connect(graph.sends[send]);
    src.onended = () => tail.disconnect();
    src.start(at);
    voices.push({ name, prio: def.prio, t0: at, t1: at + src.buffer.duration / rate, src, gain });

    if (def.duck && level > 0.2) graph.duckMusic(def.duck * Math.min(1, level), at);
    if (def.muffle && !positional) graph.muffleWorld(def.muffle * Math.min(1, level), at);
    if (def.layers) for (const l of def.layers) play(l.name, defs, { ...opts, vol: (opts.vol ?? 1) * l.vol(vol) });
    return true;
  }

  return { play, count: () => voices.length };
}

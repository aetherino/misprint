// AUDIO MODULE — 100% synthesized with WebAudio: no audio files, no dependencies.
// One-shots are pre-rendered buffers (2-5 variations each) played through a small spatial voice
// pool; the soundtrack is sequenced live. See notes/audio.md for the architecture.
import { buildGraph } from './context.js';
import { createListener } from './spatial.js';
import { createBank } from './bank.js';
import { createVoices } from './voices.js';
import { createLoops, LOOP_DEFS } from './loops.js';
import { SFX } from './sfx/index.js';
import { KIT } from './music/kit.js';
import { createSequencer } from './music/sequencer.js';

/** Every one-shot sound name the engine/UI may play. Unknown names must be ignored silently. */
export const SOUNDS = [
  // weapons
  'fire_stapler', 'fire_punch', 'fire_marker', 'fire_blotter', 'dry', 'reload_start', 'reload_end', 'switch',
  'bounce', 'explode', 'impact', 'ricochet',
  // combat feedback (2D)
  'hit', 'hit_head', 'kill', 'hurt', 'die', 'second_draft',
  // movement
  'footstep', 'jump', 'airjump', 'land', 'dash', 'slide_start', 'walljump', 'jumppad', 'rewind',
  // world
  'pickup_health', 'pickup_overprint', 'overprint_end', 'spawn', 'pickup_respawn',
  // flow
  'countdown_tick', 'countdown_go', 'round_win', 'round_lose', 'match_win', 'match_lose',
  'announce', 'streak', 'card_reveal', 'card_hover', 'card_pick',
  // ui
  'ui_hover', 'ui_click', 'ui_back', 'ui_toggle', 'chat', 'join', 'leave',
];
/** Looping sounds toggled with A.loop(name, on, opts). */
export const LOOPS = ['slide', 'wallrun', 'charge', 'overprint', 'wind'];

const DEFAULT_VOLUME = { master: 0.8, music: 0.6, sfx: 0.8 };
const TICK_MS = 25;
const LOOKAHEAD = 0.12;        // seconds of music scheduled ahead of the audio clock
const LOOKAHEAD_HIDDEN = 1.6;  // background tabs only get ~1 timer tick per second
// Rendered first after unlock so the menu and the first firefight never wait on a render.
const WARM_FIRST = ['ui_hover', 'ui_click', 'ui_back', 'ui_toggle', 'fire_stapler', 'hit', 'footstep', 'jump', 'land'];

const unit = (x, fallback) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback);

/**
 * @param {object} [options] dev/test only — the game calls createAudio() with no arguments.
 *   options.context: build on this BaseAudioContext (e.g. an OfflineAudioContext) instead of
 *     creating one in unlock(); the instance is then usable immediately.
 *   options.seed: fixes the soundtrack's key/patterns (default: random per page load).
 */
export function createAudio(options = {}) {
  const sounds = new Set(SOUNDS), loopNames = new Set(LOOPS);
  const listener = createListener();
  const injected = !!options.context;
  // what the game has asked for so far — applied when the context comes up
  const wanted = { music: 'off', intensity: 0, volume: { ...DEFAULT_VOLUME }, loops: new Map() };
  let ctx = options.context || null, engine = null;

  function boot() {
    const graph = buildGraph(ctx);
    const bank = createBank(ctx, SFX), loopBank = createBank(ctx, LOOP_DEFS), kit = createBank(ctx, KIT);
    engine = {
      graph,
      voices: createVoices(ctx, graph, bank, listener),
      loops: createLoops(ctx, graph.self, loopBank),
      music: createSequencer(ctx, graph, kit, options.seed ?? Math.floor(Math.random() * 0x7fffffff)),
    };
    graph.setVolume(wanted.volume);
    engine.music.setState(wanted.music);
    engine.music.setIntensity(wanted.intensity);
    for (const [name, opts] of wanted.loops) engine.loops.set(name, true, opts);
    if (injected) return;
    // Render order: the music kit (the soundtrack starts the moment it is ready, ~0.1 s), then
    // one-shots, then loop beds. Anything played before its turn is rendered on the spot.
    kit.warm(Object.keys(KIT)).then(() => {
      setInterval(() => {
        if (ctx.state === 'running') engine.music.schedule(ctx.currentTime + (document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD));
      }, TICK_MS);
      return bank.warm([...WARM_FIRST, ...SOUNDS, ...Object.keys(SFX)]);
    }).then(() => loopBank.warm(LOOPS));
  }

  if (injected) boot();

  return {
    /** Call from the first user gesture (click/keydown) to start the AudioContext. Safe to call repeatedly. */
    unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }
        boot();
      }
      if (!injected && ctx.state !== 'running') ctx.resume().catch(() => {});
    },

    /** Listener pose each frame. pos:[x,y,z] (eye), yaw in radians (see shared/constants.js). */
    setListener(pos, yaw) {
      listener.set(pos, yaw);
    },

    /**
     * Play a one-shot. opts: { pos:[x,y,z] (omit => non-positional 2D), vol:0..1 (default 1),
     * pitch: playback-rate-ish multiplier (default 1), delay: seconds }
     */
    play(name, opts) {
      if (!engine || !sounds.has(name)) return;
      if (!injected && ctx.state !== 'running') return; // would otherwise all fire at once on resume
      engine.voices.play(name, SFX, opts);
    },

    /** Start/stop/update a loop. opts: { vol, pitch } can be updated every frame while on. */
    loop(name, on, opts) {
      if (!loopNames.has(name)) return;
      if (on) wanted.loops.set(name, opts);
      else wanted.loops.delete(name);
      if (engine) engine.loops.set(name, !!on, opts);
    },

    /** Generative soundtrack state: 'menu' | 'lobby' | 'combat' | 'draft' | 'victory' | 'off' */
    music(state) {
      wanted.music = state;
      if (engine) engine.music.setState(state);
    },

    /** Combat intensity 0..1 (engine raises it when shots are flying / low hp / last kill). */
    setIntensity(x) {
      wanted.intensity = unit(x, 0);
      if (engine) engine.music.setIntensity(wanted.intensity);
    },

    /** { master, music, sfx } each 0..1 (any subset) */
    setVolume(v = {}) {
      for (const k of ['master', 'music', 'sfx']) wanted.volume[k] = unit(v[k], wanted.volume[k]);
      if (engine) engine.graph.setVolume(wanted.volume);
    },

    /** Dev/test hooks (soundboard, tools/audiotest). Not part of the game contract. */
    _dev: {
      get context() { return ctx; },
      /** Final node before the destination (after the limiter) — tap it with an AnalyserNode for meters. */
      get output() { return engine ? engine.graph.output : null; },
      get voices() { return engine ? engine.voices.count() : 0; },
      get musicState() { return engine ? engine.music.state : 'off'; },
      get session() { return engine ? engine.music.session : null; },
      /** Offline rendering: place all music up to `until` seconds in one go. */
      scheduleMusic(until) { engine.music.schedule(until); },
    },
  };
}

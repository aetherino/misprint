// Recording stand-in for public/js/audio/index.js (see enginetest-stub-render.mjs).
const log = (window.__stub ||= { calls: {}, last: {} });
log.sounds = {};
log.loops = {};
log.music = null;

export const SOUNDS = [];
export const LOOPS = [];

export function createAudio() {
  return {
    unlock() {},
    setListener() {},
    play(name) { log.sounds[name] = (log.sounds[name] || 0) + 1; },
    loop(name, on) { log.loops[name] = on; },
    music(state) { log.music = state; },
    setIntensity(x) { log.intensity = x; },
    setVolume(v) { log.volume = v; },
  };
}

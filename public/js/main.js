// MISPRINT client entry: boot the renderer, audio and UI, wire the UI's actions to the game hub,
// and run the frame loop. URL params: ?auto=<name>[&color=n][&face=n]  ?debug=1  ?offline=1
import { createRenderer } from './render/index.js';
import { createAudio } from './audio/index.js';
import { createUI } from './ui/index.js';
import { createInput } from './input.js';
import { createGame } from './game.js';
import { loadOptions, saveOptions, sanitizeOption, loadProfile, saveProfile, sanitizeProfile } from './settings.js';

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const offline = params.get('offline') === '1';
const canvas = document.getElementById('game');

const options = loadOptions();
let profile = loadProfile();
const clock = { manual: false, fps: 60 };   // debug can take the clock over (see debug.js)

const R = await createRenderer({ canvas });
const A = createAudio();
let G = null;

const send = (msg) => G.net.send(msg);
const actions = {
  join(p) {
    profile = sanitizeProfile({ ...profile, ...p });
    saveProfile(profile);
    A.unlock();
    G.join({ ...profile, name: profile.name || 'INTERN' });
  },
  setProfile(p) {
    profile = sanitizeProfile({ ...profile, ...p });
    saveProfile(profile);
    send({ t: 'profile', ...profile });
  },
  setMatchSettings(partial) { send({ t: 'settings', settings: partial }); },
  start() { send({ t: 'start' }); },
  pickCard(card) { send({ t: 'pick', card }); },
  chat(text) {
    const clean = String(text ?? '').trim().slice(0, 140);
    if (clean) send({ t: 'chat', text: clean });
  },
  setOption(key, value) {
    const v = sanitizeOption(key, value);
    if (v === undefined) return;
    options[key] = v;
    saveOptions(options);
    applyOptions();
  },
  resume() { G.capturePointer(); },
  backToMenu() {
    G.leave();
    showMenu();
  },
};

const UI = createUI({ root: document.getElementById('ui'), actions, audio: A });

// sensitivity / fov / invertY are read live from `options` by the engine
function applyOptions() {
  A.setVolume({ master: options.master, music: options.music, sfx: options.sfx });
  R.setOptions({ quality: options.quality });
}

function showMenu() {
  UI.setScreen('menu', { ...profile });
  A.music('menu');
}

function onKey(code, down, e) {
  if (code === 'Tab') {
    if (G.inArena()) e.preventDefault();
    UI.showScoreboard(down && G.inArena());
    return;
  }
  if (!down) return;
  if (code === 'Enter' && G.net.connected) {
    e.preventDefault();   // do not also type a newline / submit into the field we are opening
    UI.openChat();
  } else if (code === 'Escape' && G.inArena() && !input.locked) {
    G.setPaused(!G.paused);
  }
}

function onLockChange(locked) {
  if (debug) return;
  UI.setPointerLocked(locked);
  if (locked) G.setPaused(false);
  else if (G.inArena()) G.setPaused(true);
}

const input = createInput({ canvas, isTyping: () => UI.isTyping(), onKey, onLockChange });
G = createGame({ R, A, UI, input, options, debug, offline });

// first click on the arena takes the mouse (the UI's own "click to play" goes through actions.resume)
document.addEventListener('mousedown', (e) => {
  if (debug || !G.inArena() || input.locked || G.paused || UI.isTyping()) return;
  if (e.target instanceof Element && e.target.closest('button, input, select, textarea, a, label, [role="button"]')) return;
  input.lock();
});

// browsers only start (or resume) audio from a user gesture; unlock() is idempotent
window.addEventListener('pointerdown', () => A.unlock(), true);
window.addEventListener('keydown', () => A.unlock(), true);

const resize = () => R.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', resize);
resize();

applyOptions();
UI.setOptions({ ...options });
G.flow.buildArena(1 + Math.floor(Math.random() * 1e9), 4);   // something to look at behind the menus

if (debug) {
  const { installDebug } = await import('./debug.js');
  window.__mp = installDebug(G, clock, actions);
} else if (params.get('bench') === '1') {
  // read-only inspection for public/dev/engine.html, with normal pointer-lock play
  const { installDebug } = await import('./debug.js');
  window.__bench = installDebug(G, clock, actions);
}

if (params.has('auto')) {
  const pick = (key) => (params.has(key) ? Number(params.get(key)) : undefined);
  G.join(sanitizeProfile({ name: params.get('auto') || 'AUTO', color: pick('color'), face: pick('face') }));
} else {
  showMenu();
}

// Auto quality: if the arena renders below 40 fps for 4 s straight, step the quality down once per
// level and say so. Never steps back up by itself (the pause menu can).
const SLOW_FPS = 40, SLOW_SECONDS = 4;
let slowFor = 0;
function watchFrameRate(dt) {
  if (debug || options.quality <= 0 || !G.inArena() || document.hidden || dt > 0.5) { slowFor = 0; return; }
  slowFor = clock.fps < SLOW_FPS ? slowFor + dt : 0;
  if (slowFor < SLOW_SECONDS) return;
  slowFor = 0;
  actions.setOption('quality', options.quality - 1);
  UI.setOptions({ ...options });
  UI.chat({ system: true, text: `Low frame rate: print quality lowered to ${['LOW', 'MED'][options.quality]}. Change it in the pause menu (Esc).` });
}

let last = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.max(0, (t - last) / 1000);
  last = t;
  if (dt > 0) clock.fps += (1 / dt - clock.fps) * 0.1;
  if (!clock.manual) G.update(dt);
  watchFrameRate(dt);
  R.render(Math.min(dt, 0.25), G.time);
}
requestAnimationFrame(frame);

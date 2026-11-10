// Recording stand-in for public/js/ui/index.js (see enginetest-stub-render.mjs).
const log = (window.__stub ||= { calls: {}, last: {} });
const rec = (name) => (...args) => { log.calls[name] = (log.calls[name] || 0) + 1; log.last[name] = args; };
log.screens = [];
log.announces = [];

export function createUI({ actions }) {
  log.actions = actions;
  const ui = Object.fromEntries(['setLobby', 'setOptions', 'setHud', 'setScores', 'showScoreboard', 'killfeed', 'hitmarker', 'damageFrom',
    'countdown', 'chat', 'setDraft', 'setPointerLocked', 'openChat', 'setPaused'].map((n) => [n, rec(`UI.${n}`)]));
  ui.setScreen = (name, data) => { log.screens.push(name); log.screen = name; log.last['UI.setScreen'] = [name, data]; };
  ui.announce = (text, sub, style) => { log.announces.push(text); log.last['UI.announce'] = [text, sub, style]; };
  ui.isTyping = () => false;
  return ui;
}

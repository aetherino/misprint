// Pause menu / settings sheet. One panel, two modes:
//   'pause'    in a match (resume, leave, controls reference, settings)
//   'settings' from the menu or lobby (settings only)
import { h } from './dom.js';
import { segmented, trapFocus } from './widgets.js';
import { tape } from './print.js';

const SLIDERS = [
  { key: 'sensitivity', label: 'Mouse sensitivity', min: 0.1, max: 3, step: 0.05, show: (v) => v.toFixed(2) },
  { key: 'fov', label: 'Field of view', min: 70, max: 120, step: 1, show: (v) => `${Math.round(v)}°` },
  { key: 'master', label: 'Master volume', min: 0, max: 1, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
  { key: 'music', label: 'Music', min: 0, max: 1, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
  { key: 'sfx', label: 'Sound effects', min: 0, max: 1, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
];
const QUALITY = [{ value: 0, label: 'Low' }, { value: 1, label: 'Med' }, { value: 2, label: 'High' }];
const ON_OFF = [{ value: false, label: 'Off' }, { value: true, label: 'On' }];

const CONTROLS = [
  ['W A S D', 'Move'], ['SPACE', 'Jump / air jump / wall jump'], ['SHIFT', 'Dash'], ['C', 'Crouch, slide when fast'],
  ['Q', 'Rewind 3 seconds'], ['MOUSE 1', 'Fire (hold to charge the Marker)'], ['1 – 4 / WHEEL', 'Switch weapon'],
  ['R', 'Reload'], ['TAB', 'Scores and builds'], ['ENTER', 'Chat'], ['ESC', 'This menu'],
];

export function createPause(app) {
  const set = (key, value) => {
    app.state.options[key] = value;
    app.actions.setOption(key, value);
    app.onOptions();
  };

  const sliders = SLIDERS.map((s) => {
    const out = h('output.mono');
    const input = h('input.range', { type: 'range', min: s.min, max: s.max, step: s.step, id: `mp-opt-${s.key}`, 'data-hover': 'none' });
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = s.show(v); set(s.key, v); });
    return { ...s, input, out, row: h('div.opt-row', null, h('label', { for: `mp-opt-${s.key}` }, s.label), input, out) };
  });
  const quality = segmented('Quality', QUALITY, 1, (v) => set('quality', v));
  const invert = segmented('Invert Y', ON_OFF, false, (v) => set('invertY', v));

  const title = h('h2.display.misreg');
  const resume = h('button.btn.btn-pink', { type: 'button', onclick: () => { close(); app.actions.resume(); } }, 'Resume');
  const leave = h('button.btn.btn-paper', { type: 'button', 'data-sfx': 'ui_back', onclick: () => { close(); app.actions.backToMenu(); } }, 'Leave to menu');
  const done = h('button.btn.btn-pink', { type: 'button', 'data-sfx': 'ui_back', onclick: () => close() }, 'Done');
  const controls = h('section.pause-controls', { 'aria-label': 'Controls' },
    h('h3.head', null, 'Controls'),
    h('dl', null, CONTROLS.map(([k, what]) => h('div', null, h('dt.mono', null, k), h('dd', null, what)))));

  const panel = h('div.pause-panel.sheet.sheet-white', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mp-pause-title' },
    tape('right:2rem;top:-.8rem;transform:rotate(4deg)'),
    h('header.pause-head', null, title, h('div.pause-actions', null, resume, done, leave)),
    h('div.pause-body', null,
      h('section.pause-opts', { 'aria-label': 'Settings' },
        h('h3.head', null, 'Settings'),
        sliders.map((s) => s.row),
        h('div.opt-row.opt-row-seg', null, h('span', null, 'Graphics quality'), quality.el),
        h('div.opt-row.opt-row-seg', null, h('span', null, 'Invert Y axis'), invert.el)),
      controls));
  title.id = 'mp-pause-title';
  trapFocus(panel);

  const el = h('div.overlay.pause', { hidden: true }, panel);
  let mode = null;
  let returnFocus = null;

  // In a match the engine owns Escape (it calls setPaused); from the menu/lobby we close ourselves.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode === 'settings') { e.stopPropagation(); app.sfx('ui_back'); close(); }
  });

  function paint() {
    const o = app.state.options;
    sliders.forEach((s) => {
      const v = Number(o[s.key] ?? s.min);
      if (document.activeElement !== s.input) s.input.value = String(v);
      s.out.textContent = s.show(v);
    });
    quality.set(o.quality);
    invert.set(!!o.invertY);
  }

  function open(nextMode) {
    if (mode === nextMode) return;
    const wasOpen = mode !== null;
    mode = nextMode;
    const paused = mode === 'pause';
    title.textContent = paused ? 'Paused' : 'Settings';
    resume.hidden = !paused;
    leave.hidden = !paused;
    done.hidden = paused;
    controls.hidden = !paused;
    panel.classList.toggle('is-compact', !paused);
    paint();
    if (!wasOpen) returnFocus = document.activeElement;
    el.hidden = false;
    (paused ? resume : done).focus({ preventScroll: true });
  }

  function close() {
    if (mode === null) return;
    const wasPause = mode === 'pause';
    mode = null;
    el.hidden = true;
    if (returnFocus && returnFocus.isConnected && returnFocus.focus) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    if (wasPause) app.onPauseClosed();
  }

  return { el, open, close, paint, get mode() { return mode; } };
}

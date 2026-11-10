// The two small full-page states: connecting and error.
import { h } from './dom.js';
import { cropMarks, regMark, stamp } from './print.js';

export function createConnecting() {
  const el = h('div.scr.scr-paper.wait', { role: 'status' },
    cropMarks(),
    regMark('wait-reg'),
    h('h1.display.misreg', null, 'Warming up the drum'),
    h('p', null, 'Connecting to the press room.'));
  return { el };
}

export function createError(app) {
  const msg = h('p.wait-msg');
  const back = h('button.btn.btn-pink', { type: 'button', 'data-sfx': 'ui_back', onclick: () => app.actions.backToMenu() }, 'Back to menu');
  const el = h('div.scr.scr-paper.wait', { role: 'alert' },
    cropMarks(),
    h('h1.display.misreg.err-title', null, 'Paper jam', stamp('Return to sender')),
    msg,
    h('p', null, 'Check that the host is still running the server and that you are on the same network, then try again.'),
    back);
  return {
    el,
    show(data) {
      msg.textContent = (data && data.message) || 'Lost the connection to the server.';
      back.focus({ preventScroll: true });
    },
  };
}

// Death state: the page washes out and your entry is redacted until the reprint.
import { h, textSlot, classSlot } from '../dom.js';

export function createDeath() {
  const by = h('span.dead-by-name');
  const secs = h('span.dead-secs.mono');
  const byLine = h('p.dead-by.hand', null, 'by ', by);
  const el = h('div.hud-dead', { hidden: true },
    h('div.dead-wash'),
    h('div.dead-card', { role: 'status' },
      h('div.dead-bars', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('div.dead-title.display', null, 'Redacted'),
      byLine,
      h('p.dead-next', null, h('span.label', null, 'Reprinting in'), secs)));

  const setBy = textSlot(by, '');
  const setSecs = textSlot(secs, '');
  const setNoKiller = classSlot(byLine, 'is-env');
  let dead = false;
  let tenths = -1;

  return {
    els: [el],
    update(s) {
      const isDead = !s.alive && s.respawnIn > 0;
      if (isDead !== dead) { dead = isDead; el.hidden = !dead; }
      if (!dead) return;
      const t = Math.ceil(s.respawnIn * 10);
      if (t !== tenths) { tenths = t; setSecs((t / 10).toFixed(1)); }
      setBy(s.killerName || 'gravity');
      setNoKiller(!s.killerName);
    },
  };
}

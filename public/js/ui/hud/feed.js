// Top-right kill feed: killer ink > weapon glyph > victim ink. Newest at the bottom, five rows, self rows inverted.
import { h, svg } from '../dom.js';
import { weaponGlyph, pict } from '../icons.js';
import { inkHex } from '../faces.js';

const MAX_ROWS = 5;
const TTL = 5500;

const who = (name, color) => h('span.feed-who', null, h('i.feed-ink', { style: `background:${inkHex(color)}` }), h('span', null, name));

export function createFeed() {
  const el = h('ol.hud-feed', { 'aria-label': 'Kill feed' });

  function retire(row) {
    if (!row.isConnected || row.classList.contains('is-out')) return;
    row.classList.add('is-out');
    setTimeout(() => row.remove(), 260);
  }

  return {
    els: [el],
    killfeed(e) {
      const env = e.killerId == null || e.killerId === e.victimId;
      const row = h(`li.feed-row${e.self ? '.is-self' : ''}`, null,
        env ? null : who(e.killerName, e.killerColor),
        h('span.feed-how', null,
          svg(weaponGlyph(env ? -1 : e.weapon)),
          e.headshot ? svg(pict('headshot', 'feed-hs')) : null,
          e.headshot ? h('span.sr', null, 'headshot') : null),
        who(e.victimName, e.victimColor),
        env ? h('span.feed-env', null, 'returned to sender') : null);
      el.appendChild(row);
      const live = [...el.children].filter((r) => !r.classList.contains('is-out'));
      for (let i = 0; i < live.length - MAX_ROWS; i++) retire(live[i]);
      setTimeout(() => retire(row), TTL);
    },
    clear() { el.textContent = ''; },
  };
}

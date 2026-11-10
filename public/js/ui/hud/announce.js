// Upper-centre announcements (queued, never overlapping) and the pre-round countdown.
import { h, replace } from '../dom.js';
import { plates } from '../print.js';

const HOLD = { kill: 1500, streak: 2000, round: 2400, info: 1700, warn: 2000 };
const RUSHED = 900;       // hold time when more are waiting
const LEAVE = 170;
const MAX_QUEUE = 4;

export function createAnnounce() {
  const slot = h('div.hud-ann', { role: 'status', 'aria-live': 'polite' });
  const count = h('div.hud-count', { hidden: true });
  const queue = [];
  let busy = false;
  let countTimer = 0;

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const a = queue.shift();
    const node = h(`div.ann.ann-${a.style}`, null,
      plates('div', 'ann-text display', a.text),
      a.sub ? h('div.ann-sub', null, a.sub) : null);
    replace(slot, node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => { if (node.parentNode === slot) node.remove(); busy = false; pump(); }, LEAVE);
    }, queue.length ? RUSHED : (HOLD[a.style] || HOLD.info));
  }

  return {
    els: [slot, count],
    announce(text, sub, style) {
      if (!text) return;
      queue.push({ text: String(text), sub: sub ? String(sub) : '', style: HOLD[style] ? style : 'info' });
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      pump();
    },
    countdown(n, mapName) {
      clearTimeout(countTimer);
      const go = n <= 0;
      replace(count,
        mapName && !go ? h('div.count-map', null, h('span.label', null, 'Now printing'), h('span.head', null, mapName)) : null,
        go ? plates('div', 'count-num count-go display', 'Print!')
          : n <= 3 ? plates('div', 'count-num display', String(n))
            : h('div.count-ready.hand', null, 'loading paper...'));
      count.hidden = false;
      countTimer = setTimeout(() => { count.hidden = true; }, go ? 900 : 1600);
    },
    clear() {
      queue.length = 0;
      clearTimeout(countTimer);
      count.hidden = true;
      slot.textContent = '';
      busy = false;
    },
  };
}

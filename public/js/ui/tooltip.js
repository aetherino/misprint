// One shared tooltip for anything carrying data-tip (card chips, mini cards). Works for pointer and keyboard focus.
import { h } from './dom.js';

export function createTooltip(root) {
  const title = h('b');
  const body = h('span');
  const el = h('div.tip', { role: 'tooltip', hidden: true }, title, body);
  let target = null;

  function show(t) {
    target = t;
    title.textContent = t.dataset.tipTitle || '';
    body.textContent = t.dataset.tip;
    el.hidden = false;
    const r = t.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const gap = 8;
    const x = Math.max(gap, Math.min(host.width - w - gap, r.left - host.left + r.width / 2 - w / 2));
    const above = r.top - host.top - hgt - gap;
    el.style.left = `${x}px`;
    el.style.top = `${above > gap ? above : r.bottom - host.top + gap}px`;
  }
  function hide() { target = null; el.hidden = true; }

  const find = (e) => (e.target.closest ? e.target.closest('[data-tip]') : null);
  root.addEventListener('pointerover', (e) => { const t = find(e); if (t && t !== target) show(t); else if (!t && target) hide(); });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focusin', (e) => { const t = find(e); if (t) show(t); });
  root.addEventListener('focusout', hide);

  return { el, hide };
}

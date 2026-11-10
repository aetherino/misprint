// Reusable controls and player/card bits used across screens.
import { INKS, FACES } from '/shared/constants.js';
import { CARD_BY_ID, RARITY_NAMES } from '/shared/cards.js';
import { h, svg, clamp } from './dom.js';
import { cardIcon, pict } from './icons.js';
import { badgeSvg, faceSvg, faceId, inkHex } from './faces.js';

export const NAME_MAX = 14;
const PROFILE_KEY = 'misprint.profile';

export function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { /* corrupted or blocked storage: start fresh */ }
  return {
    name: typeof p.name === 'string' ? p.name.slice(0, NAME_MAX) : '',
    color: Number.isInteger(p.color) ? clamp(p.color, 0, INKS.length - 1) : Math.floor(Math.random() * INKS.length),
    face: Number.isInteger(p.face) ? clamp(p.face, 0, FACES.length - 1) : Math.floor(Math.random() * FACES.length),
  };
}

export function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: p.name, color: p.color, face: p.face })); } catch { /* private mode */ }
}

/** Player avatar sticker. */
export function badge(player, cls = '') {
  const el = svg(badgeSvg(faceId(player.face), cls));
  el.style.setProperty('--c', inkHex(player.color));
  return el;
}

/** Radio-group behaviour: arrow keys move, one tab stop. */
function radioGroup(el, buttons, onPick) {
  el.setAttribute('role', 'radiogroup');
  const select = (i, user) => {
    buttons.forEach((b, j) => {
      b.setAttribute('aria-checked', j === i ? 'true' : 'false');
      b.tabIndex = j === i ? 0 : -1;
    });
    if (user) onPick(i);
  };
  buttons.forEach((b, i) => {
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => select(i, true));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = (i + d + buttons.length) % buttons.length;
      if (buttons[n].disabled) return;
      select(n, true);
      buttons[n].focus();
    });
  });
  return (i) => select(i, false);
}

export function swatchPicker(value, onPick) {
  const buttons = INKS.map((ink) => h('button.swatch', { type: 'button', style: `--c:${ink.hex}`, 'aria-label': ink.name, title: ink.name, 'data-sfx': 'ui_toggle' }));
  const el = h('div.swatches', { 'aria-label': 'Ink colour' }, buttons);
  const set = radioGroup(el, buttons, onPick);
  set(value);
  return { el, set };
}

export function facePicker(value, onPick) {
  const buttons = FACES.map((f) => h('button.faceopt', { type: 'button', 'aria-label': `${f} face`, title: f, 'data-sfx': 'ui_toggle', html: faceSvg(f) }));
  const el = h('div.facepick', { 'aria-label': 'Screen face' }, buttons);
  const set = radioGroup(el, buttons, onPick);
  set(value);
  return { el, set, setColor: (hex) => el.style.setProperty('--c', hex) };
}

/** Segmented control. options: [{ value, label }] */
export function segmented(label, options, value, onPick) {
  const buttons = options.map((o) => h('button', { type: 'button', 'data-sfx': 'ui_toggle' }, o.label));
  const el = h('div.seg', { 'aria-label': label }, buttons);
  const set = radioGroup(el, buttons, (i) => onPick(options[i].value));
  const setValue = (v) => set(options.findIndex((o) => o.value === v));
  setValue(value);
  return { el, set: setValue, setDisabled: (d) => buttons.forEach((b) => { b.disabled = d; }) };
}

/** Number stepper. */
export function stepper(label, { min, max, step = 1, format = String }, value, onChange) {
  const out = h('output', { 'aria-live': 'off' });
  const dec = h('button', { type: 'button', 'aria-label': `Less: ${label}`, 'data-sfx': 'ui_toggle' }, '−');
  const inc = h('button', { type: 'button', 'aria-label': `More: ${label}`, 'data-sfx': 'ui_toggle' }, '+');
  const el = h('div.stepper', { role: 'group', 'aria-label': label }, dec, out, inc);
  let cur = value;
  let disabled = false;
  const paint = () => {
    out.textContent = format(cur);
    dec.disabled = disabled || cur <= min;
    inc.disabled = disabled || cur >= max;
  };
  const bump = (d) => {
    const next = clamp(cur + d * step, min, max);
    if (next === cur) return;
    cur = next;
    paint();
    onChange(cur);
  };
  dec.addEventListener('click', () => bump(-1));
  inc.addEventListener('click', () => bump(1));
  paint();
  return {
    el,
    set(v) { if (v !== cur) { cur = v; paint(); } },
    setDisabled(d) { disabled = d; paint(); },
  };
}

/** Collapse a card id list into [{ card, count }] in draft order. */
export function stackCards(ids = []) {
  const map = new Map();
  for (const id of ids) {
    const card = CARD_BY_ID[id];
    if (!card) continue;
    const e = map.get(id);
    if (e) e.count++; else map.set(id, { card, count: 1 });
  }
  return [...map.values()];
}

/** Small build chip. Tooltip data is read by the shared tooltip (pointer + keyboard). */
export function cardChip(card, count = 1, { named = false, focusable = false } = {}) {
  const el = h(`span.chip.chip-r${card.rarity}${named ? '' : '.chip-icon'}`, {
    'data-tip-title': `${card.name}${count > 1 ? ` ×${count}` : ''} · ${RARITY_NAMES[card.rarity]}`,
    'data-tip': card.desc,
    tabindex: focusable ? '0' : null,
    role: 'img',
    'aria-label': `${card.name}${count > 1 ? ` times ${count}` : ''}: ${card.desc}`,
    html: cardIcon(card.icon),
  });
  if (named) el.appendChild(document.createTextNode(card.name));
  if (count > 1) el.appendChild(h('b', null, `×${count}`));
  return el;
}

export function buildChips(ids, opts) {
  return h('span.chips', null, stackCards(ids).map(({ card, count }) => cardChip(card, count, opts)));
}

export const icon = (name, cls) => svg(pict(name, cls));

/** Copy without the async clipboard API (plain-http LAN pages are not secure contexts). */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through to the legacy path */ }
  }
  const ta = h('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;left:-99em;top:0;opacity:0' });
  ta.value = text;
  document.body.appendChild(ta);
  const prev = document.activeElement;
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (prev && prev.focus) prev.focus();
  return ok;
}

/** Keep Tab inside a modal panel. */
export function trapFocus(panel) {
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...panel.querySelectorAll('button, input, [tabindex="0"]')].filter((n) => !n.disabled && n.tabIndex !== -1 && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// Tiny DOM helpers. User-supplied strings (names, chat) only ever enter the page through text nodes.

const SPEC = /([.#]?)([\w-]+)/g;

/** h('button.btn.btn-pink', { onclick, 'aria-label': 'x' }, child, 'text', [more]) */
export function h(spec, props, ...kids) {
  let tag = 'div';
  const cls = [];
  let id = '';
  spec.replace(SPEC, (_, kind, name) => {
    if (!kind) tag = name; else if (kind === '.') cls.push(name); else id = name;
    return '';
  });
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (cls.length) el.className = cls.join(' ');
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

/** Parse trusted, module-authored SVG markup into an element. */
export function svg(markup, cls) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const el = t.content.firstChild;
  if (cls) el.classList.add(...cls.split(' '));
  return el;
}

export function clear(el) { el.textContent = ''; return el; }
export function replace(el, ...kids) { clear(el); return append(el, kids); }

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// --- write-on-change slots: the HUD is pushed 60x a second and may only touch the DOM when a value moved ---

export function textSlot(parent, initial = '') {
  const node = document.createTextNode(initial);
  parent.appendChild(node);
  let cur = initial;
  return (v) => { if (v !== cur) { cur = v; node.data = v; } };
}

export function classSlot(el, cls, initial = false) {
  let cur = initial;
  return (on) => { on = !!on; if (on !== cur) { cur = on; el.classList.toggle(cls, on); } };
}

export function attrSlot(el, name) {
  let cur;
  return (v) => { if (v !== cur) { cur = v; el.setAttribute(name, v); } };
}

/** fraction 0..1 -> transform: scaleX|scaleY, quantised so sub-pixel jitter never writes */
export function scaleSlot(el, axis = 'X', steps = 400) {
  let cur = -1;
  return (frac) => {
    const q = Math.round(clamp(frac, 0, 1) * steps);
    if (q !== cur) { cur = q; el.style.transform = `scale${axis}(${q / steps})`; }
  };
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Restartable one-shot animation without forcing layout (Web Animations API). */
export function play(el, frames, opts) {
  if (reducedMotion()) opts = { ...opts, duration: Math.min(opts.duration, 120) };
  return el.animate(frames, { fill: 'both', ...opts });
}

/** Shrink a one-line element (width: max-content) so it fits its parent; never grows past its CSS size. */
export function fitText(el) {
  el.style.fontSize = '';
  const room = el.parentNode.clientWidth;
  const width = el.offsetWidth;
  if (!room || width <= room) return;
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const px = parseFloat(getComputedStyle(el).fontSize) * (room / width) * 0.98;
  el.style.fontSize = `${px / rootPx}rem`;
}

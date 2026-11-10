// Print-shop furniture shared by every page: crop marks, registration targets, colour bars,
// barcodes, tally marks, rubber stamps and misregistered display type.
import { h, svg } from './dom.js';

const REG = '<svg class="reg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><path d="M12 1v22M1 12h22"/></svg>';

export const regMark = (cls = '') => svg(REG, cls);

/** Four corner crop marks; add to any position:relative page. */
export function cropMarks() {
  return ['tl', 'tr', 'bl', 'br'].map((c) => h(`i.crop.crop-${c}`, { 'aria-hidden': 'true' }));
}

const BAR_COLORS = ['#22c8e8', '#ff48b0', '#ffd21f', '#1b1a20', '#2f6bff', '#ff4b33', '#19c98a'];
export function colorBar(colors = BAR_COLORS) {
  return h('span.colorbar', { 'aria-hidden': 'true' }, colors.map((c) => h('i', { style: `background:${c}` })));
}

/** Deterministic fake barcode from any string. */
export function barcode(text) {
  let seed = 7;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  let x = 0;
  let rects = '';
  while (x < 100) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const w = 1 + (seed >>> 29) % 3;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const gap = 1 + (seed >>> 30);
    if (x + w <= 100) rects += `<rect x="${x}" y="0" width="${w}" height="20"/>`;
    x += w + gap;
  }
  return svg(`<svg class="barcode" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`);
}

/** Hand-drawn tally marks (groups of five with a strike). */
export function tally(n) {
  n = Math.max(0, Math.min(15, n | 0));
  let d = '';
  let x = 2;
  for (let i = 0; i < n; i++) {
    if (i % 5 === 4) {
      d += `M${x - 27} 15L${x - 1} 5`;
      x += 5;
    } else {
      const lean = (i % 3) - 1;
      d += `M${x + lean} 2L${x - lean * 0.5} 18`;
      x += 6;
    }
  }
  const el = svg(`<svg class="tally" viewBox="0 0 ${Math.max(4, x)} 20" role="img" aria-label="${n} wins"><path d="${d}"/></svg>`);
  return el;
}

export function stamp(text, cls = '') {
  return h(`span.stamp${cls ? '.' + cls.split(' ').join('.') : ''}`, null, text);
}

/** Display text whose colour plates sit off register. The plates are pseudo-elements fed by data-text. */
export function plates(tag, cls, text) {
  return h(`${tag}.${cls.split(' ').join('.')}`, { 'data-text': text }, text);
}

export const tape = (style) => h('i.tape', { style, 'aria-hidden': 'true' });

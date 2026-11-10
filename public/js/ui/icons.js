// Every icon in the game, drawn as chunky cut-paper SVG on a 48-unit grid.
// A shape is [mode, path]:
//   'f'  spot-colour fill printed slightly off register + ink keyline   (the house look)
//   'l'  ink keyline only      's'  solid ink      'p'  spot colour only
// The spot layer is shifted by the renderer, so every icon is "misprinted" the same way.

const TAU = Math.PI * 2;
const r1 = (n) => Math.round(n * 10) / 10;

function star(cx, cy, ro, ri, n, rot = -Math.PI / 2) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = rot + (i * TAU) / (n * 2);
    d += `${i ? 'L' : 'M'}${r1(cx + Math.cos(a) * r)} ${r1(cy + Math.sin(a) * r)}`;
  }
  return `${d}Z`;
}

// rounded lobes: an ink splat
function blob(cx, cy, ro, ri, n, rot = 0) {
  const pt = (r, a) => `${r1(cx + Math.cos(a) * r)} ${r1(cy + Math.sin(a) * r)}`;
  let d = `M${pt(ri, rot)}`;
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i * TAU) / n;
    const a1 = rot + ((i + 1) * TAU) / n;
    d += `Q${pt(ro * 1.25, (a0 + a1) / 2)} ${pt(ri, a1)}`;
  }
  return `${d}Z`;
}

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
const rays = (cx, cy, r0, r1_, n, rot = 0) => {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = rot + (i * TAU) / n;
    d += `M${r1(cx + Math.cos(a) * r0)} ${r1(cy + Math.sin(a) * r0)}L${r1(cx + Math.cos(a) * r1_)} ${r1(cy + Math.sin(a) * r1_)}`;
  }
  return d;
};

const HEART = 'M24 42C9 31 4 21 8 13c4-7 13-6 16 1 3-7 12-8 16-1 4 8-1 18-16 29Z';
const SMALL_HEART = 'M25 37c-7-5-9-9-7-12 2-3 6-2 7 1 1-3 5-4 7-1 2 3 0 7-7 12Z';

const CARD_ICONS = {
  jump: [['f', 'M7 23 24 6l17 17v9L24 15 7 32Z'], ['f', 'M7 37 24 20l17 17v8L24 28 7 45Z']],
  speed: [['f', 'M5 9 23 24 5 39Z'], ['f', 'M24 9l19 15-19 15Z'], ['l', 'M2 18h4M2 30h4']],
  shield: [['f', 'M24 4 41 10v13c0 10-7 17-17 21C14 40 7 33 7 23V10Z'], ['l', 'M24 12v24M15 22h18']],
  shrink: [['f', 'M18 18h12v12H18Z'], ['f', 'M16 16 4 12l8-8Z'], ['f', 'M32 16l4-12 8 8Z'], ['f', 'M16 32l-4 12-8-8Z'], ['f', 'M32 32l12 4-8 8Z']],
  dmg: [['f', star(24, 24, 21, 11, 8)], ['s', circle(24, 24, 4)]],
  rate: [['f', 'M5 7h17l7 5-7 5H5Z'], ['f', 'M13 19h17l7 5-7 5H13Z'], ['f', 'M21 31h17l7 5-7 5H21Z']],
  mag: [['f', 'M11 5h26v38H11Z'], ['l', 'M11 14h26M11 23h26M11 32h26'], ['s', 'M20 8h8v3h-8Z']],
  aim: [['f', circle(24, 24, 15)], ['l', 'M24 2v12M24 34v12M2 24h12M34 24h12'], ['s', circle(24, 24, 3.2)]],
  heal: [['f', 'M18 5h12v13h13v12H30v13H18V30H5V18h13Z']],
  regen: [['f', HEART], ['l', 'M12 24h7l3-7 5 13 3-6h6']],
  dash: [['f', 'M21 8l22 16-22 16v-9H12V17h9Z'], ['l', 'M3 17h4M1 24h6M3 31h4']],
  wall: [['f', 'M5 8h38v32H5Z'], ['l', 'M5 19h38M5 30h38M24 8v11M14 19v11M34 19v11M24 30v10']],
  steal: [['f', 'M24 3s15 17 15 27a15 15 0 0 1-30 0C9 20 24 3 24 3Z'], ['s', 'M21 22h6v5h5v6h-5v5h-6v-5h-5v-6h5Z']],
  head: [['f', circle(24, 17, 12)], ['f', 'M6 45c0-9 8-13 18-13s18 4 18 13Z'], ['l', 'M24 9v16M16 17h16']],
  bounce: [['l', 'M4 9l13 27 12-19 8 12'], ['f', circle(39, 31, 5.5)], ['s', 'M3 40h42v4H3Z']],
  moon: [['f', 'M31 5a20 20 0 1 0 13 28A17 17 0 0 1 31 5Z'], ['s', star(37, 12, 5, 2, 4)]],
  thorns: [['f', star(24, 24, 22, 13, 12)], ['s', circle(24, 24, 5)]],
  jam: [['f', 'M11 4h26v16l-7 6 7 6v12H11V32l7-6-7-6Z'], ['s', circle(7, 26, 4.5)], ['s', circle(41, 26, 4.5)], ['l', 'M17 11h14M17 38h14']],
  clock: [['f', circle(24, 25, 17)], ['l', 'M24 14v11l8 5'], ['s', 'M19 2h10v5H19Z']],
  rewind: [['s', 'M5 9h5v30H5Z'], ['f', 'M27 9v30L12 24Z'], ['f', 'M44 9v30L29 24Z']],
  splash: [['f', blob(24, 25, 15, 11, 7, 0.3)], ['f', circle(8, 8, 3.5)], ['f', circle(42, 11, 2.6)], ['s', circle(21, 22, 3)]],
  bighead: [['f', circle(24, 19, 16)], ['f', 'M19 35h10v9H19Z'], ['s', circle(18, 18, 3)], ['s', circle(30, 18, 3)], ['l', 'M19 26q5 4 10 0']],
  ghost: [['f', 'M9 44V21a15 15 0 0 1 30 0v23l-5-5-5 5-5-5-5 5-5-5Z'], ['s', circle(18.5, 21, 3.4)], ['s', circle(29.5, 21, 3.4)]],
  burst: [['f', circle(24, 24, 8)], ['l', rays(24, 24, 13, 21, 8, 0.39)], ['p', circle(6, 9, 3)], ['p', circle(43, 40, 3)]],
  revive: [['f', 'M11 4h19l8 8v32H11Z'], ['l', 'M30 4v8h8'], ['s', SMALL_HEART]],
  skull: [['f', 'M24 4C13 4 6 11 6 21c0 6 3 10 8 12v9h20v-9c5-2 8-6 8-12 0-10-7-17-18-17Z'], ['s', circle(16.5, 21, 4.4)], ['s', circle(31.5, 21, 4.4)], ['s', 'M24 26l-3 6h6Z'], ['l', 'M20 37v5M24 37v5M28 37v5']],
  unknown: [['f', circle(24, 24, 17)], ['l', 'M18 19a6 6 0 1 1 9 5c-2 1-3 2-3 5'], ['s', circle(24, 35, 2.4)]],
};

// weapon silhouettes, 64 x 32
const WEAPON_GLYPHS = [
  // stapler
  [['f', 'M3 23h58v6H3Z'], ['f', 'M5 21 8 9c1-4 4-5 8-5l36 3c6 1 9 4 8 9l-1 5Z'], ['l', 'M14 13h30'], ['s', circle(9, 21, 2.5)]],
  // hole punch
  [['f', 'M3 24h58v6H3Z'], ['f', 'M9 24v-8h34v8Z'], ['f', 'M6 14 55 3l2 6-49 12Z'], ['s', circle(18, 20, 2.2)], ['s', circle(33, 20, 2.2)], ['p', circle(50, 18, 2.4)], ['p', circle(57, 14, 1.8)]],
  // marker
  [['f', 'M3 10h38v12H3Z'], ['f', 'M41 8h9v16h-9Z'], ['f', 'M50 12l11 3v2l-11 3Z'], ['l', 'M12 10v12'], ['s', 'M18 14h16v4H18Z']],
  // blotter (rocker)
  [['f', 'M5 15h54c0 9-12 15-27 15S5 24 5 15Z'], ['f', 'M9 10h46v5H9Z'], ['f', 'M27 3h10v7H27Z'], ['s', 'M23 1h18v3H23Z'], ['l', 'M16 21q16 7 32 0']],
];

function render(shapes, viewBox, cls, shift) {
  let spot = '';
  let line = '';
  let solid = '';
  for (const [mode, d] of shapes) {
    const p = `<path d="${d}"/>`;
    if (mode === 'f') { spot += p; line += p; } else if (mode === 'l') line += p; else if (mode === 's') solid += p; else spot += p;
  }
  return `<svg class="${cls}" viewBox="${viewBox}" aria-hidden="true" focusable="false">`
    + `<g class="ic-spot" transform="translate(${shift})">${spot}</g><g class="ic-line">${line}</g><g class="ic-solid">${solid}</g></svg>`;
}

const cardCache = {};
export function cardIcon(key) {
  return cardCache[key] || (cardCache[key] = render(CARD_ICONS[key] || CARD_ICONS.unknown, '0 0 48 48', 'ic', '2.6 2.2'));
}

const weaponCache = [];
/** id 0..3; anything else (environment, ink burst, thorns) gets the splat. */
export function weaponGlyph(id) {
  if (!WEAPON_GLYPHS[id]) return cardIcon('splash').replace('class="ic"', 'class="ic wglyph-env"');
  return weaponCache[id] || (weaponCache[id] = render(WEAPON_GLYPHS[id], '0 0 64 32', 'ic wglyph', '2.2 1.8'));
}

// one-colour pictograms, 24 x 24, fill = currentColor
const PICTS = {
  gear: `<path fill-rule="evenodd" d="${star(12, 12, 11.5, 8.2, 8, 0.2)}${circle(12, 12, 3.6)}"/>`,
  copy: '<path fill-rule="evenodd" d="M8 2h13v15H8ZM10.5 4.5v10h8v-10ZM3 7h3v12h10v3H3Z"/>',
  check: '<path d="M2 13l3-3 4.5 4.5L19 5l3 3L9.5 20.5Z"/>',
  cross: '<path d="M4 6.5 6.5 4 12 9.5 17.5 4 20 6.5 14.5 12 20 17.5 17.5 20 12 14.5 6.5 20 4 17.5 9.5 12Z"/>',
  arrow: '<path d="M2 9.5h11V4l9 8-9 8v-5.5H2Z"/>',
  crown: '<path d="M2 6l5 5 5-8 5 8 5-5-2 13H4Z"/>',
  headshot: `<path fill-rule="evenodd" d="${circle(12, 12, 9)}${circle(12, 12, 5.2)}"/><path d="M10.6 0h2.8v6h-2.8ZM10.6 18h2.8v6h-2.8ZM0 10.6h6v2.8H0ZM18 10.6h6v2.8h-6Z"/><circle cx="12" cy="12" r="2"/>`,
  skull: '<path fill-rule="evenodd" d="M12 2C6.5 2 3 5.6 3 10.5c0 3 1.5 5 4 6V21h10v-4.500c2.500-1 4-3 4-6C21 5.600 17.500 2 12 2ZM8.500 13a2.300 2.300 0 1 1 0-4.600 2.300 2.300 0 0 1 0 4.600ZM15.500 13a2.300 2.300 0 1 1 0-4.600 2.300 2.300 0 0 1 0 4.600Z"/>',
  chat: '<path d="M2 3h20v14H11l-6 5v-5H2Z"/>',
  bolt: '<path d="M14 1 4 14h6l-2 9 12-14h-7Z"/>',
  mouse: '<path fill-rule="evenodd" d="M12 1c4 0 7 3 7 7v8c0 4-3 7-7 7s-7-3-7-7V8c0-4 3-7 7-7Zm-1.200 3v6h2.400V4Z"/>',
  ping: '<path d="M2 16h4v6H2ZM8 11h4v11H8ZM14 6h4v16h-4Z"/>',
};

export function pict(name, cls = '') {
  return `<svg class="pic ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PICTS[name] || ''}</svg>`;
}

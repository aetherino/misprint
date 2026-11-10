// Print-head faces: 12 x 8 pixel maps shown on the bots' CRT screens. Ids match shared FACES.
import { FACES, INKS } from '/shared/constants.js';

const MAPS = {
  happy: [
    '............',
    '..##....##..',
    '..##....##..',
    '..##....##..',
    '............',
    '.#........#.',
    '..########..',
    '............',
  ],
  smug: [
    '............',
    '.####.......',
    '.......####.',
    '..##....##..',
    '............',
    '........##..',
    '..######....',
    '............',
  ],
  angry: [
    '.##......##.',
    '...##..##...',
    '..##....##..',
    '..##....##..',
    '............',
    '...######...',
    '..#......#..',
    '............',
  ],
  sleepy: [
    '.........###',
    '..........#.',
    '.........###',
    '.###..###...',
    '............',
    '....##......',
    '....##......',
    '............',
  ],
  cat: [
    '............',
    '..#......#..',
    '.#.#....#.#.',
    '............',
    '.....##.....',
    '..#..##..#..',
    '...##..##...',
    '............',
  ],
  skull: [
    '............',
    '.###....###.',
    '.###....###.',
    '..#......#..',
    '.....##.....',
    '............',
    '.#.#.##.#.#.',
    '.#.#.##.#.#.',
  ],
  uwu: [
    '............',
    '.#..#..#..#.',
    '.#..#..#..#.',
    '..##....##..',
    '............',
    '..#..##..#..',
    '...##..##...',
    '............',
  ],
  // b / p print in the spot inks instead of white: a screen that lost registration
  glitch: [
    'bbb....##...',
    '......pppp..',
    '..####....##',
    '.##..bb.....',
    '......#####.',
    'pp..........',
    '...###..bb..',
    '.........ppp',
  ],
};

function pixels(face, x, y, s) {
  const map = MAPS[face] || MAPS.happy;
  let out = '';
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    let c = 0;
    while (c < row.length) {
      const ch = row[c];
      if (ch === '.') { c++; continue; }
      let e = c;
      while (e < row.length && row[e] === ch) e++;
      const cls = ch === 'b' ? ' class="face-b"' : ch === 'p' ? ' class="face-p"' : '';
      out += `<rect${cls} x="${x + c * s}" y="${y + r * s}" width="${(e - c) * s}" height="${s}"/>`;
      c = e;
    }
  }
  return out;
}

export const faceId = (index) => FACES[index] || FACES[0];
export const inkHex = (index) => (INKS[index] || INKS[0]).hex;

/** Just the face, for the face picker (24 x 16). */
export function faceSvg(face) {
  return `<svg viewBox="0 0 24 16" aria-hidden="true" focusable="false"><g fill="currentColor">${pixels(face, 0, 0, 2)}</g></svg>`;
}

/** Head-only sticker avatar (40 x 40). Colour comes from --c on the element or an ancestor. */
export function badgeSvg(face, cls = '') {
  return `<svg class="badge ${cls}" viewBox="0 0 40 40" aria-hidden="true" focusable="false">`
    + '<g class="badge-fill" transform="translate(1.6 1.4)"><rect x="3" y="5" width="34" height="27" rx="5"/><rect x="14" y="32" width="12" height="5"/></g>'
    + '<rect class="badge-screen" x="7" y="9" width="26" height="19" rx="2"/>'
    + `<g class="badge-face">${pixels(face, 8, 10.5, 2)}</g>`
    + '<g class="badge-line"><rect x="3" y="5" width="34" height="27" rx="5"/><path d="M14 32v5h12v-5"/></g>'
    + '</svg>';
}

/** Full-body print-head for covers and podiums (120 x 156). */
export function botSvg(face, cls = '') {
  const shell = '<path d="M50 22 44 4l30-2 4 20Z"/>'
    + '<rect x="14" y="22" width="92" height="68" rx="12"/>'
    + '<rect x="5" y="44" width="9" height="22" rx="2"/><rect x="106" y="44" width="9" height="22" rx="2"/>'
    + '<rect x="50" y="90" width="20" height="9"/>'
    + '<path d="M36 99h48l7 31H29Z"/>'
    + '<path d="M33 104 15 120l7 8 14-12Z"/><path d="M87 104l18 16-7 8-14-12Z"/>'
    + '<rect x="38" y="130" width="14" height="14"/><rect x="68" y="130" width="14" height="14"/>'
    + '<rect x="31" y="143" width="24" height="10" rx="3"/><rect x="65" y="143" width="24" height="10" rx="3"/>';
  return `<svg class="bot ${cls}" viewBox="0 0 120 156" aria-hidden="true" focusable="false">`
    + `<g class="bot-fill" transform="translate(4 3)">${shell}</g>`
    + '<path class="bot-paper" d="M50 22 44 4l30-2 4 20Z"/>'
    + '<rect class="badge-screen" x="23" y="31" width="74" height="50" rx="5"/>'
    + `<g class="badge-face">${pixels(face, 24, 32, 6)}</g>`
    + `<g class="bot-line">${shell}<path d="M50 9h20M51 15h20M44 112h12M44 118h8"/></g>`
    + '</svg>';
}

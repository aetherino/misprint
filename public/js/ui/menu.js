// Menu: the zine's front cover. Profile entry lives on a taped-on press pass; the cover star is your own bot.
import { h, svg } from './dom.js';
import { cropMarks, regMark, colorBar, barcode, tape } from './print.js';
import { botSvg, faceId, inkHex } from './faces.js';
import { loadProfile, saveProfile, swatchPicker, facePicker, icon, NAME_MAX } from './widgets.js';

const LOGO = 'MISPRINT';
const FALLBACK_NAMES = ['INTERN', 'TONER', 'PAPERCUT', 'SMUDGE', 'GUTTER', 'OFFCUT', 'DOGEAR', 'BLEED'];

const HOWTO = [
  [['W', 'A', 'S', 'D'], 'move'],
  [['SPACE'], 'jump, again in the air'],
  [['SHIFT'], 'dash'],
  [['C'], 'slide'],
  [['Q'], 'rewind 3 s'],
  [['1', '–', '4'], 'weapons'],
  [['R'], 'reload'],
  [['TAB'], 'scores'],
  [['ENTER'], 'chat'],
];

const SCRIBBLE_RING = '<svg class="menu-sic-ring" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M52 6C28 4 8 22 7 49c-1 27 18 45 44 45 27 0 43-20 42-46C92 22 74 8 48 9"/></svg>';
const SCRIBBLE_ARROW = '<svg class="scribble-arrow" viewBox="0 0 60 40" aria-hidden="true"><path d="M3 34C14 12 34 6 54 12"/><path d="M43 4l12 8-11 9"/></svg>';

export function createMenu(app) {
  const profile = loadProfile();
  const fallback = `${FALLBACK_NAMES[Math.floor(Math.random() * FALLBACK_NAMES.length)]}-${10 + Math.floor(Math.random() * 90)}`;

  const logo = h('h1.logo.display', { 'aria-label': LOGO },
    [...LOGO].map((c, i) => h(`span.logo-l.logo-l${i}`, { 'data-c': c, 'aria-hidden': 'true' }, c)));

  const hero = h('div.menu-bot');
  const paintHero = () => {
    hero.replaceChildren(svg(botSvg(faceId(profile.face))));
    el.style.setProperty('--c', inkHex(profile.color));
  };

  const name = h('input.field', {
    type: 'text', id: 'mp-name', maxLength: NAME_MAX, autocomplete: 'off', spellcheck: false,
    placeholder: fallback, value: profile.name, 'aria-describedby': 'mp-name-hint',
  });
  name.addEventListener('input', () => { profile.name = name.value.slice(0, NAME_MAX); saveProfile(profile); });

  const inks = swatchPicker(profile.color, (i) => { profile.color = i; saveProfile(profile); faces.setColor(inkHex(i)); paintHero(); });
  const faces = facePicker(profile.face, (i) => { profile.face = i; saveProfile(profile); paintHero(); });
  faces.setColor(inkHex(profile.color));

  const join = (e) => {
    e.preventDefault();
    app.sfx('ui_click');
    const p = { name: profile.name.trim() || fallback, color: profile.color, face: profile.face };
    saveProfile({ ...profile, name: profile.name.trim() });
    app.actions.join(p);
  };

  const pass = h('form.pass.sheet.sheet-white', { onsubmit: join, 'aria-label': 'Your print-head' },
    tape('left:-1.6rem;top:.5rem;transform:rotate(-38deg)'),
    tape('right:-1.7rem;bottom:.9rem;transform:rotate(-42deg)'),
    h('div.pass-head', null,
      h('h2.head', null, 'Press pass'),
      h('span.mono.pass-no', { 'aria-hidden': 'true' }, 'PRINT-HEAD / LAN')),
    h('div.pass-row', null,
      h('label.label', { for: 'mp-name' }, 'Name'),
      name,
      h('span.sr', { id: 'mp-name-hint' }, `Up to ${NAME_MAX} characters`)),
    h('div.pass-row', null, h('span.label', null, 'Ink'), inks.el),
    h('div.pass-row', null, h('span.label', null, 'Face'), faces.el),
    h('button.btn.btn-pink.menu-play', { type: 'submit', 'data-sfx': 'none' },
      h('span.display', null, 'Play'), h('span.kbd', { 'aria-hidden': 'true' }, 'ENTER')));

  const el = h('div.scr.scr-paper.menu', null,
    cropMarks(),
    regMark('reg-abs menu-reg-a'), regMark('reg-abs menu-reg-b'),
    h('div.menu-halftone.halftone', { 'aria-hidden': 'true' }),
    h('header.menu-top', null,
      h('span.label', null, 'Issue No. 01'),
      h('span.label.menu-top-dim', null, 'LAN edition'),
      h('span.label.menu-top-dim', null, 'Free, take one'),
      h('span.menu-top-gap'),
      barcode('MISPRINT-01'),
      h('button.btn.btn-paper.btn-sm', { type: 'button', onclick: () => app.openSettings() }, icon('gear'), 'Settings')),
    h('div.menu-logo', null,
      logo,
      svg(SCRIBBLE_RING),
      h('span.hand.menu-sic', { 'aria-hidden': 'true' }, 'sic.'),
      h('span.hand.menu-fix', { 'aria-hidden': 'true' }, 'fix before print!!', svg(SCRIBBLE_ARROW))),
    h('div.menu-pitch', null,
      h('p.head.menu-tag', null, 'A movement shooter printed on a risograph.'),
      h('span.hand.menu-badly', { 'aria-hidden': 'true' }, '(badly)'),
      h('ul.menu-lines', null,
        h('li', null, h('b', null, 'Four office supplies,'), ' all of them loaded.'),
        h('li', null, h('b', null, 'Lose a round, draft an Errata card.'), ' They stack all match.'),
        h('li', null, h('b', null, 'Everyone can rewind'), ' three seconds. Once in a while.'))),
    h('div.menu-hero', { 'aria-hidden': 'true' },
      h('i.menu-sun.halftone'),
      hero,
      h('span.hand.menu-you', null, 'you', svg(SCRIBBLE_ARROW))),
    pass,
    h('section.howto.sheet', { 'aria-label': 'How to play' },
      h('h2.howto-title.head', null, 'How to play'),
      h('ul.howto-keys', null, HOWTO.map(([keys, what]) => h('li', null,
        h('span.howto-k', null, keys.map((k) => (k === '–' ? h('span', { 'aria-hidden': 'true' }, '–') : h('kbd.kbd', null, k)))),
        h('span.howto-w', null, what))))),
    h('div.menu-foot', { 'aria-hidden': 'true' }, colorBar(), h('span.mono', null, 'PLATE 2 OF 2 / PINK + BLUE / DO NOT TRIM')));

  paintHero();

  return {
    el,
    show() { name.focus({ preventScroll: true }); name.select(); },
  };
}

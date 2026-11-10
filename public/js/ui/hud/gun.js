// Bottom-right: ammo sticker (count, pips, reload bar) and the four-slot weapon strip.
import { WEAPONS } from '/shared/weapons.js';
import { h, svg, textSlot, classSlot, scaleSlot } from '../dom.js';
import { weaponGlyph } from '../icons.js';

export function createGun() {
  const glyph = h('span.gun-glyph');
  const name = h('span.gun-name.head');
  const ammo = h('span.gun-ammo.display');
  const mag = h('span.gun-mag.mono');
  const spent = h('i.gun-spent');
  const pips = h('div.gun-pips', null, spent);
  const reloadFill = h('i');
  const note = h('span.gun-note.label');
  const el = h('div.hud-gun.sticker', null,
    h('div.gun-top', null, glyph, name),
    h('div.gun-count', null, ammo, mag),
    pips,
    h('div.gun-reload', null, reloadFill),
    note);

  const slotEls = WEAPONS.map((w) => h('li.slot-w', null, h('span.kbd', null, String(w.id + 1)), svg(weaponGlyph(w.id))));
  const slots = h('ol.hud-slots', { 'aria-hidden': 'true' }, slotEls);

  const setName = textSlot(name, '');
  const setAmmo = textSlot(ammo, '');
  const setMag = textSlot(mag, '');
  const setNote = textSlot(note, '');
  const setSpent = scaleSlot(spent, 'X', 200);
  const setReload = scaleSlot(reloadFill, 'X', 200);
  const setReloading = classSlot(el, 'is-reloading');
  const setLow = classSlot(el, 'is-low');
  let weapon = -1;
  let ammoN = -1;
  let magN = -1;

  return {
    els: [slots, el],
    update(s) {
      if (s.weapon !== weapon) {
        if (slotEls[weapon]) slotEls[weapon].classList.remove('is-on');
        weapon = s.weapon;
        const w = WEAPONS[weapon] || WEAPONS[0];
        if (slotEls[weapon]) slotEls[weapon].classList.add('is-on');
        glyph.replaceChildren(svg(weaponGlyph(w.id)));
        setName(w.name);
      }
      if (s.mag !== magN) {
        magN = s.mag;
        setMag(`/${magN}`);
        pips.style.setProperty('--n', String(Math.max(1, magN)));
      }
      if (s.ammo !== ammoN) { ammoN = s.ammo; setAmmo(String(ammoN)); }
      setSpent(magN > 0 ? 1 - ammoN / magN : 1);
      const reloading = s.reload != null;
      setReloading(reloading);
      setReload(reloading ? s.reload : 0);
      setLow(!reloading && ammoN <= Math.max(1, Math.floor(magN * 0.25)));
      setNote(reloading ? 'Reloading' : ammoN === 0 ? 'Out of ink  [R]' : '');
    },
  };
}

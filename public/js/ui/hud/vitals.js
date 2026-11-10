// Bottom-left: ink level (health) with a lagging damage ghost, plus the player's build as icon chips.
import { h, replace, textSlot, classSlot, scaleSlot, play } from '../dom.js';
import { cardChip, stackCards } from '../widgets.js';

const LOW_HP = 0.3;
const SHAKE = [{ transform: 'rotate(-1.2deg) translate(0,0)' }, { transform: 'rotate(-3deg) translate(-.3rem,.15rem)' }, { transform: 'rotate(.4deg) translate(.2rem,-.1rem)' }, { transform: 'rotate(-1.2deg) translate(0,0)' }];

export function createVitals() {
  const num = h('span.hp-num.display');
  const max = h('span.hp-max.mono');
  const ghost = h('i.hp-ghost');
  const fill = h('i.hp-fill');
  const el = h('div.hud-hp.sticker', null,
    h('div.hp-top', null, h('span.label', null, 'Ink'), num, max),
    h('div.hp-bar', null, ghost, fill));
  const cards = h('div.hud-cards');

  const setNum = textSlot(num, '');
  const setMax = textSlot(max, '');
  const setFill = scaleSlot(fill);
  const setGhost = scaleSlot(ghost);
  const setLow = classSlot(el, 'is-low');
  let hp = -1;
  let maxHp = -1;
  let cardIds = [];

  function sameCards(next) {
    if (next.length !== cardIds.length) return false;
    for (let i = 0; i < next.length; i++) if (next[i] !== cardIds[i]) return false;
    return true;
  }

  return {
    els: [cards, el],
    update(s) {
      const v = Math.max(0, Math.ceil(s.hp));
      if (v !== hp) {
        if (hp > 0 && v < hp) play(el, SHAKE, { duration: 160, easing: 'steps(3)', fill: 'none' });
        hp = v;
        setNum(String(v));
      }
      if (s.maxHp !== maxHp) { maxHp = s.maxHp; setMax(`/${maxHp}`); }
      const frac = maxHp > 0 ? s.hp / maxHp : 0;
      setFill(frac);
      setGhost(frac);
      setLow(s.alive && frac <= LOW_HP);
      const next = s.cards || [];
      if (!sameCards(next)) {
        cardIds = next.slice();
        replace(cards, stackCards(cardIds).map(({ card, count }) => cardChip(card, count)));
      }
    },
  };
}

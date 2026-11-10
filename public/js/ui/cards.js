// Errata cards as printed objects: the full trading card (draft) and the mini card (other players' picks, teasers).
import { CARDS, RARITY_NAMES } from '/shared/cards.js';
import { h, svg } from './dom.js';
import { cardIcon } from './icons.js';
import { regMark } from './print.js';

const RARITY_CLASS = ['is-common', 'is-rare', 'is-misprint'];
const cardNo = (card) => String(CARDS.indexOf(card) + 1).padStart(2, '0');

function back() {
  return h('div.card-face.card-back', { 'aria-hidden': 'true' },
    h('div.card-back-inner', null, regMark(), h('span.display', null, 'Errata'), h('span.label', null, 'Correction slip')));
}

/**
 * Full card as a button. `owned` = how many copies the player already holds.
 * Structure: button.card > .card-tilt (pointer tilt) > .card-flip (deal/flip) > front + back
 */
export function cardButton(card, { index, owned = 0 }) {
  const stack = owned > 0
    ? h('span.card-stack', null, h('b.mono', null, `×${owned}`), ` owned, this makes ×${owned + 1}`)
    : h('span.card-stack.is-new', null, card.max > 1 ? `Stacks up to ×${card.max}` : 'One per player');
  const front = h('div.card-face.card-front', null,
    h('div.card-band', null,
      h('span.card-rarity', { 'data-text': RARITY_NAMES[card.rarity] }, RARITY_NAMES[card.rarity]),
      h('span.card-no.mono', { 'aria-hidden': 'true' }, `No.${cardNo(card)}`)),
    h('div.card-art', { 'aria-hidden': 'true' }, h('i.card-art-dots.halftone'), h('i.card-art-disc'), svg(cardIcon(card.icon))),
    h('h3.card-name.display', null, card.name),
    h('p.card-desc', null, card.desc),
    h('div.card-foot', null, h('kbd.kbd', { 'aria-hidden': 'true' }, String(index + 1)), stack),
    h('span.card-approved.stamp', { 'aria-hidden': 'true' }, 'Approved'));
  return h(`button.card.${RARITY_CLASS[card.rarity]}`, {
    type: 'button', style: `--i:${index}`, 'data-sfx': 'none', 'data-card': card.id,
    'aria-label': `Option ${index + 1}: ${card.name}, ${RARITY_NAMES[card.rarity]}. ${card.desc}${owned ? ` You own ${owned}.` : ''}`,
  }, h('div.card-tilt', null, h('div.card-flip', null, front, back())));
}

/** Small face-up card: rarity band + icon. */
export function miniCard(card) {
  return h(`span.mini.${RARITY_CLASS[card.rarity]}`, {
    'data-tip-title': `${card.name} · ${RARITY_NAMES[card.rarity]}`, 'data-tip': card.desc, role: 'img', 'aria-label': card.name,
  }, h('i.mini-band'), svg(cardIcon(card.icon)));
}

export function miniBack() {
  return h('span.mini.mini-back', { 'aria-hidden': 'true' }, regMark());
}

// Draft: ERRATA. Three cards are dealt, flipped and picked with 1/2/3 or a click. The round winner
// prints nothing and watches everyone else's corrections come in.
import { CARD_BY_ID } from '/shared/cards.js';
import { h, replace, reducedMotion } from './dom.js';
import { inkHex } from './faces.js';
import { plates } from './print.js';
import { cardButton, miniCard, miniBack } from './cards.js';
import { badge, buildChips } from './widgets.js';

const DEAL_STAGGER = 150;
const FLIP_AT = 380;
const TILT = 8;       // degrees

export function createDraft(app) {
  const sub = h('p.draft-sub.hand');
  const secs = h('span.draft-secs');
  const timerBar = h('div.draft-timer-bar');
  const table = h('div.draft-table');
  const build = h('div.draft-build-chips');
  const buildWrap = h('section.draft-build', { 'aria-label': 'Your build' }, h('h2.label', null, 'Your build so far'), build);
  const others = h('ol.draft-others-list');
  const othersTitle = h('h2.label');
  const othersWrap = h('section.draft-others', { 'aria-label': 'Other players' }, othersTitle, others);
  const live = h('span.sr', { 'aria-live': 'polite' });
  const el = h('div.scr.draft.on-blue', null,
    h('i.draft-mat', { 'aria-hidden': 'true' }),
    h('header.draft-head', null,
      h('div.draft-title', null, plates('h1', 'draft-h display', 'Errata'), sub),
      h('div.draft-timer', null, h('span.label', null, 'Press closes in'), secs, timerBar)),
    table,
    h('footer.draft-foot', null, buildWrap, othersWrap),
    live);

  let key = null;          // identifies the current deal
  let cards = [];          // [{ card, el }]
  let picked = null;
  let isWinner = false;
  let endsAt = 0;
  let tick = 0;
  let dealTimers = [];
  let dealtAt = 0;
  const otherEls = new Map();   // id -> { li, slot, picked }

  function setPicked(id, announce) {
    if (picked === id) return;
    picked = id;
    cards.forEach((c) => {
      c.el.classList.toggle('is-picked', c.card.id === id);
      c.el.classList.toggle('is-rejected', c.card.id !== id);
      c.el.disabled = true;
    });
    table.classList.add('has-pick');
    sub.textContent = 'correction filed.';
    if (announce) live.textContent = `${CARD_BY_ID[id] ? CARD_BY_ID[id].name : 'Card'} approved.`;
  }

  function pick(i) {
    const c = cards[i];
    // ignore input until the card has actually turned face-up (players are still mashing game keys)
    if (!c || picked || isWinner || performance.now() < dealtAt + FLIP_AT + i * DEAL_STAGGER + 250) return;
    app.sfx('card_pick');
    setPicked(c.card.id, true);
    app.actions.pickCard(c.card.id);
  }

  function tilt(card) {
    const inner = card.querySelector('.card-tilt');
    let raf = 0;
    let rx = 0;
    let ry = 0;
    const apply = () => { raf = 0; inner.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`; };
    card.addEventListener('pointermove', (e) => {
      if (reducedMotion() || card.disabled) return;
      const r = card.getBoundingClientRect();
      ry = ((e.clientX - r.left) / r.width - 0.5) * 2 * TILT;
      rx = -((e.clientY - r.top) / r.height - 0.5) * 2 * TILT;
      if (!raf) raf = requestAnimationFrame(apply);
    });
    card.addEventListener('pointerleave', () => { rx = 0; ry = 0; if (!raf) raf = requestAnimationFrame(apply); });
  }

  function deal(d) {
    dealTimers.forEach(clearTimeout);
    dealTimers = [];
    picked = null;
    table.classList.remove('has-pick');
    dealtAt = performance.now();
    const mine = (app.me() && app.me().cards) || [];
    if (d.isWinner || !d.options.length) {
      cards = [];
      el.classList.add('is-winner');
      sub.textContent = 'admire your work.';
      replace(table, h('div.draft-win', null,
        plates('h2', 'draft-win-h display', 'Winner prints nothing'),
        h('p', null, 'You took the round, so you sit this draft out while everyone else files a correction.')));
      othersTitle.textContent = 'Corrections coming in';
      return;
    }
    el.classList.remove('is-winner');
    sub.textContent = 'pick one correction.';
    othersTitle.textContent = 'The other editors';
    cards = d.options.map((id, index) => {
      const card = CARD_BY_ID[id];
      if (!card) return null;
      const owned = mine.filter((c) => c === id).length;
      const btn = cardButton(card, { index, owned });
      btn.addEventListener('click', () => pick(index));
      btn.addEventListener('pointerenter', () => { if (!btn.disabled) app.sfx('card_hover'); });
      btn.addEventListener('focus', () => { if (!btn.disabled && btn.matches(':focus-visible')) app.sfx('card_hover'); });
      tilt(btn);
      dealTimers.push(setTimeout(() => app.sfx('card_reveal', { pitch: 1 + index * 0.08 }), FLIP_AT + index * DEAL_STAGGER));
      return { card, el: btn };
    }).filter(Boolean);
    replace(table, cards.map((c) => c.el));
  }

  function paintOthers(list) {
    const seen = new Set();
    for (const o of list) {
      seen.add(o.id);
      let e = otherEls.get(o.id);
      if (!e) {
        const slot = h('span.other-slot', null, miniBack());
        const state = h('span.other-state');
        const li = h('li.other', { style: `--c:${inkHex(o.color)}` },
          slot, h('span.other-who', null, badge({ color: o.color, face: (app.player(o.id) || {}).face || 0 }), h('span.other-name', null, o.name)), state);
        e = { li, slot, state, picked: undefined };
        otherEls.set(o.id, e);
        others.appendChild(li);
      }
      if (o.picked !== e.picked) {
        e.picked = o.picked;
        const card = o.picked && CARD_BY_ID[o.picked];
        if (card) {
          const mini = miniCard(card);
          mini.classList.add('is-flipping');
          e.slot.replaceChildren(mini);
          e.state.textContent = card.name;
          e.li.classList.add('has-picked');
        } else {
          e.slot.replaceChildren(miniBack());
          e.state.textContent = 'choosing...';
          e.li.classList.remove('has-picked');
        }
      }
    }
    for (const [id, e] of otherEls) if (!seen.has(id)) { e.li.remove(); otherEls.delete(id); }
    othersWrap.hidden = !otherEls.size;
  }

  function paintTimer() {
    const left = Math.max(0, endsAt - Date.now());
    secs.textContent = String(Math.ceil(left / 1000));
    secs.classList.toggle('is-urgent', left < 5000);
  }

  function onKey(e) {
    if (el.hidden || app.isTyping() || app.state.paused || e.repeat) return;
    if (e.key >= '1' && e.key <= '3') { e.preventDefault(); pick(Number(e.key) - 1); }
  }

  return {
    el,
    show() { window.addEventListener('keydown', onKey); clearInterval(tick); tick = setInterval(paintTimer, 200); },
    hide() {
      window.removeEventListener('keydown', onKey);
      clearInterval(tick);
      dealTimers.forEach(clearTimeout);
      key = null;
      otherEls.clear();
      replace(others);
      replace(table);
    },
    setDraft(d) {
      const opts = d.options || [];
      const nextKey = `${opts.join(',')}|${d.isWinner ? 1 : 0}`;
      if (nextKey !== key) {
        key = nextKey;
        isWinner = !!d.isWinner || !opts.length;
        otherEls.clear();
        replace(others);
        deal({ options: opts, isWinner });
      }
      if (d.picked && !isWinner) setPicked(d.picked, false);
      if (d.endsAt !== endsAt) {
        endsAt = d.endsAt;
        const ms = Math.max(0, endsAt - Date.now());
        timerBar.replaceChildren(h('i', { style: `animation-duration:${ms}ms` }));
      }
      paintTimer();
      paintOthers(d.others || []);
      const mine = (app.me() && app.me().cards) || [];
      const sig = mine.join(',');
      if (build.dataset.sig !== sig) {
        build.dataset.sig = sig;
        replace(build, mine.length ? buildChips(mine, { named: true, focusable: true }) : h('span.draft-nobuild', null, 'Nothing yet. This is your first correction.'));
      }
    },
  };
}

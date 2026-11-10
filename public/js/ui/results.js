// Between-round and end-of-match pages: the round's results sheet and the EXTRA! front page.
import { TIMING } from '/shared/constants.js';
import { h, svg, replace, fitText } from './dom.js';
import { botSvg, faceId, inkHex } from './faces.js';
import { cropMarks, tally, stamp, tape, barcode, colorBar, plates } from './print.js';
import { badge, buildChips } from './widgets.js';
import { byScore } from './scoreboard.js';

const UNKNOWN = { name: '???', color: 0, face: 0, cards: [], wins: 0, kills: 0, deaths: 0 };

/** standings rows may be bare { id, kills, deaths, wins }; fill names/colours/cards from the roster. Winner first. */
function resolve(app, standings, winnerId) {
  const rows = (standings && standings.length ? standings : app.roster()).map((s) => ({ ...UNKNOWN, ...app.player(s.id), ...s }));
  return rows.sort((a, b) => ((b.id === winnerId) - (a.id === winnerId)) || byScore(a, b));
}

function bot(player) {
  const el = svg(botSvg(faceId(player.face)));
  el.style.setProperty('--c', inkHex(player.color));
  return el;
}

/** Counts down once per second from `seconds`; returns a stop function. */
function ticker(seconds, paint) {
  const end = performance.now() + seconds * 1000;
  const tick = () => paint(Math.max(0, Math.ceil((end - performance.now()) / 1000)));
  tick();
  const id = setInterval(tick, 250);
  return () => clearInterval(id);
}

export function createRoundEnd(app) {
  const kicker = h('span.re-kicker.label');
  const hero = h('div.re-bot');
  const name = h('h1.re-name.display');
  const wins = h('div.re-wins');
  const list = h('ol.re-list');
  const next = h('p.re-next');
  const nextNum = h('b.mono');
  const bar = h('div.re-bar');
  const pageNo = h('span.re-pageno.display', { 'aria-hidden': 'true' });
  const el = h('div.scr.veil.roundend', null,
    h('div.re-page.sheet', { role: 'region', 'aria-label': 'Round results' },
      cropMarks(), tape('left:44%;top:-.8rem;transform:rotate(2deg)'), pageNo,
      h('section.re-winner', null,
        kicker,
        h('div.re-photo', null, h('i.re-sun.halftone'), hero, stamp('OK to print', 're-ok')),
        h('p.re-by.label', null, 'Printed by'),
        name, wins),
      h('section.re-standings', null,
        h('header.re-head', null, h('h2.head', null, 'Print run'), h('span.re-cols.label', { 'aria-hidden': 'true' }, h('span', null, 'Errata'), h('span', null, 'Kills'), h('span', null, 'Deaths'), h('span', null, 'Rounds'))),
        list),
      h('footer.re-foot', null, next, bar)));
  let stop = null;

  return {
    el,
    show(data = {}) {
      const st = app.state.lobby;
      const rows = resolve(app, data.standings, data.winnerId);
      const winner = rows.find((r) => r.id === data.winnerId) || rows[0] || UNKNOWN;
      el.style.setProperty('--c', inkHex(winner.color));
      kicker.textContent = `Round ${data.round ?? ''} results`;
      hero.replaceChildren(bot(winner));
      name.textContent = winner.name;
      fitText(name);
      pageNo.textContent = String(data.round ?? '').padStart(2, '0');
      replace(wins, winner.wins > 0 ? [tally(winner.wins), h('span.label', null, winner.wins === 1 ? 'round won' : 'rounds won')] : null);
      replace(list, rows.map((p, i) => h(`li.re-row${p.id === st.selfId ? '.is-me' : ''}${p.id === data.winnerId ? '.is-winner' : ''}`, { style: `--c:${inkHex(p.color)};--i:${i}` },
        h('span.re-rank.mono', null, String(i + 1)),
        badge(p),
        h('span.re-who', null, h('span.head', null, p.name), p.id === st.selfId ? h('span.tag.tag-pink', null, 'You') : null),
        h('span.re-build', null, p.cards && p.cards.length ? buildChips(p.cards) : null),
        h('span.re-num.mono', null, String(p.kills | 0)),
        h('span.re-num.mono.re-d', null, String(p.deaths | 0)),
        h('span.re-tally', null, p.wins > 0 ? tally(p.wins) : null))));

      const toWin = (st.settings && st.settings.roundsToWin) || Infinity;
      const matchOver = winner.wins >= toWin;
      const iWon = data.winnerId != null && data.winnerId === st.selfId;
      const what = matchOver ? 'Final edition' : iWon ? 'You won, so you print nothing. The others draft' : 'Errata draft: you pick one card';
      const secs = Number(data.nextIn) > 0 ? Number(data.nextIn) : TIMING.roundEnd;
      if (stop) stop();
      replace(next, `${what} in `, nextNum, ' s');
      stop = ticker(secs, (n) => { nextNum.textContent = String(n); });
      bar.replaceChildren(h('i', { style: `animation-duration:${secs}s` }));
    },
    hide() { if (stop) { stop(); stop = null; } },
  };
}

export function createMatchEnd(app) {
  const headline = h('h1.me-headline');
  const photo = h('div.me-bot');
  const caption = h('p.me-caption.hand');
  const build = h('div.me-build');
  const list = h('ol.me-list');
  const backNum = h('b.mono');
  const el = h('div.scr.scr-paper.matchend', null,
    cropMarks(),
    h('header.me-mast', null,
      h('span.me-paper.display.misreg', null, 'The Misprint'),
      h('span.label', null, 'Final edition'),
      h('span.me-mast-gap'),
      colorBar(),
      barcode('MISPRINT-FINAL')),
    h('section.me-front', null,
      stamp('Extra!', 'me-extra'),
      headline,
      h('div.me-story', null,
        h('figure.me-photo', null, tape('left:-1.4rem;top:.6rem;transform:rotate(-40deg)'), h('i.me-sun.halftone'), photo),
        h('div.me-copy', null,
          caption,
          h('h2.label', null, 'The winning build'),
          build,
          h('p.me-back', null, 'Back to the press room in ', backNum, ' s. Cards and wins reset.')))),
    h('section.me-standings.sheet.sheet-white', { 'aria-label': 'Final standings' },
      h('header.re-head', null, h('h2.head', null, 'Final standings'), h('span.label', null, 'Rounds / kills / deaths')),
      list));
  let stop = null;

  return {
    el,
    show(data = {}) {
      const st = app.state.lobby;
      const rows = resolve(app, data.standings, data.winnerId).sort((a, b) => ((b.id === data.winnerId) - (a.id === data.winnerId)) || (b.wins - a.wins) || byScore(a, b));
      const winner = rows[0] || UNKNOWN;
      el.style.setProperty('--c', inkHex(winner.color));
      replace(headline,
        plates('span', 'me-name display', winner.name),
        h('span.me-wins.display', null, 'wins the press'));
      fitText(headline.firstChild);
      photo.replaceChildren(bot(winner));
      caption.textContent = winner.id === st.selfId ? 'that is you. frame it.' : 'ink still wet. do not touch.';
      replace(build, winner.cards && winner.cards.length ? buildChips(winner.cards, { named: true, focusable: true }) : h('span.me-nobuild', null, 'No Errata at all. A clean first draft.'));
      replace(list, rows.map((p, i) => h(`li.me-row${p.id === st.selfId ? '.is-me' : ''}`, { style: `--c:${inkHex(p.color)}` },
        h('span.re-rank.mono', null, String(i + 1)),
        badge(p),
        h('div.me-who', null,
          h('span.me-who-top', null, h('span.head', null, p.name), p.id === st.selfId ? h('span.tag.tag-pink', null, 'You') : null),
          p.cards && p.cards.length ? buildChips(p.cards, { focusable: true }) : null),
        h('span.me-tally', null, p.wins > 0 ? tally(p.wins) : null),
        h('span.re-num.mono', null, String(p.kills | 0)),
        h('span.re-num.mono.re-d', null, String(p.deaths | 0)))));
      if (stop) stop();
      stop = ticker(Number(data.nextIn) > 0 ? Number(data.nextIn) : TIMING.matchEnd, (n) => { backNum.textContent = String(n); });
    },
    hide() { if (stop) { stop(); stop = null; } },
  };
}

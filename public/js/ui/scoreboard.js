// Scoreboard overlay (held TAB). This is where people read each other's builds, so card chips carry names.
import { h, replace } from './dom.js';
import { inkHex } from './faces.js';
import { tally, tape } from './print.js';
import { badge, buildChips } from './widgets.js';

export const byScore = (a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (b.wins - a.wins) || String(a.name).localeCompare(String(b.name));

export function createScoreboard(app) {
  const body = h('tbody');
  const meta = h('span.label');
  const el = h('div.overlay.score', { hidden: true },
    h('div.score-sheet.sheet', { role: 'region', 'aria-label': 'Scoreboard' },
      tape('left:3rem;top:-.8rem;transform:rotate(-4deg)'),
      h('header.score-head', null, h('h2.display.misreg', null, 'Proof sheet'), meta),
      h('table.score-table', null,
        h('thead', null, h('tr', null,
          h('th.c-rank', { scope: 'col' }, '#'), h('th.c-name', { scope: 'col' }, 'Print-head'),
          h('th.c-num', { scope: 'col' }, 'Kills'), h('th.c-num', { scope: 'col' }, 'Deaths'),
          h('th.c-wins', { scope: 'col' }, 'Rounds'), h('th.c-num', { scope: 'col' }, 'Ping'),
          h('th.c-build', { scope: 'col' }, 'Errata'))),
        body)));

  function render() {
    const st = app.state.lobby;
    const rows = [...app.roster()].sort(byScore);
    replace(body, rows.map((p, i) => h(`tr${p.id === st.selfId ? '.is-me' : ''}`, { style: `--c:${inkHex(p.color)}` },
      h('td.c-rank.mono', null, String(i + 1)),
      h('td.c-name', null, h('span.score-who', null, badge(p), h('span.head', null, p.name),
        p.id === st.selfId ? h('span.tag.tag-pink', null, 'You') : null,
        p.id === st.hostId ? h('span.tag.tag-line', null, 'Host') : null,
        p.isBot ? h('span.tag.tag-line', null, 'Bot') : null)),
      h('td.c-num.mono.score-k', null, String(p.kills | 0)),
      h('td.c-num.mono', null, String(p.deaths | 0)),
      h('td.c-wins', null, p.wins > 0 ? tally(p.wins) : h('span.score-dim', null, '–')),
      h('td.c-num.mono', null, p.isBot ? '–' : String(Math.round(p.ping || 0))),
      h('td.c-build', null, p.cards && p.cards.length ? buildChips(p.cards, { named: true }) : h('span.score-dim', null, 'first draft')))));
    const s = st.settings || {};
    meta.textContent = `First to ${s.killsToWin ?? '–'} kills takes the round. ${s.roundsToWin ?? '–'} rounds take the match.`;
  }

  return {
    el,
    setVisible(v) { if (v) render(); el.hidden = !v; },
    refresh() { if (!el.hidden) render(); },
  };
}

// Top-centre: round clock sticker + the three leading scores as a race to "first to N".
import { h, replace, textSlot, classSlot, fmtTime } from '../dom.js';
import { inkHex } from '../faces.js';
import { byScore } from '../scoreboard.js';

const URGENT = 10;

export function createTop(app) {
  const round = h('span.clock-round.label');
  const time = h('span.clock-time.display');
  const goal = h('span.clock-goal.label');
  const mine = h('span.clock-mine.mono');
  const clock = h('div.hud-clock.sticker', null, round, time, h('span.clock-side', null, goal, mine));
  const board = h('ol.hud-board');
  const el = h('div.hud-top', null, clock, board);

  const setRound = textSlot(round, '');
  const setTime = textSlot(time, '');
  const setGoal = textSlot(goal, '');
  const setMine = textSlot(mine, '');
  const setUrgent = classSlot(clock, 'is-urgent');
  let secs = -2;
  let roundN = -1;
  let goalN = -1;
  let kills = -1;
  let boardSig = '';
  let leaderSig = '';

  function paintBoard(rows, killsToWin, selfId) {
    const sig = rows.map((p) => `${p.id}:${p.name}:${p.kills}:${p.color}`).join('|') + killsToWin;
    if (sig === boardSig) return;
    boardSig = sig;
    replace(board, rows.map((p, i) => h(`li.board-row${p.id === selfId ? '.is-me' : ''}`, { style: `--c:${inkHex(p.color)};--f:${Math.min(1, (p.kills | 0) / Math.max(1, killsToWin))}` },
      h('span.board-rank.mono', null, String(i + 1)),
      h('i.board-ink'),
      h('span.board-name', null, p.name),
      h('span.board-kills.mono', null, String(p.kills | 0)),
      h('i.board-bar'))));
  }

  return {
    els: [el],
    onRoster() {
      const st = app.state.lobby;
      const rows = [...app.roster()].sort(byScore).slice(0, 3);
      if (rows.length) paintBoard(rows, (st.settings && st.settings.killsToWin) || goalN || 1, st.selfId);
    },
    update(s) {
      const t = Number.isFinite(s.timeLeft) ? Math.max(0, Math.ceil(s.timeLeft)) : -1;
      if (t !== secs) { secs = t; setTime(fmtTime(t < 0 ? NaN : t)); setUrgent(t >= 0 && t <= URGENT); }
      if (s.round !== roundN) { roundN = s.round; setRound(`Round ${roundN ?? '–'}`); }
      if (s.killsToWin !== goalN) { goalN = s.killsToWin; setGoal(`First to ${goalN ?? '–'}`); }
      if (s.kills !== kills) { kills = s.kills; setMine(`you ${kills | 0}`); }
      // no roster yet (engine only gave us the leader): show that single row
      if (!boardSig && s.leader) {
        const sig = `${s.leader.name}:${s.leader.kills}:${s.leader.color}`;
        if (sig !== leaderSig) {
          leaderSig = sig;
          replace(board, h('li.board-row', { style: `--c:${inkHex(s.leader.color)};--f:${Math.min(1, s.leader.kills / Math.max(1, goalN))}` },
            h('span.board-rank.mono', null, '1'), h('i.board-ink'), h('span.board-name', null, s.leader.name),
            h('span.board-kills.mono', null, String(s.leader.kills)), h('i.board-bar')));
        }
      }
    },
  };
}

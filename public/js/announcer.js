// The announcer: print-shop one-liners for the moments that deserve them. Kept sparse on purpose —
// most kills only get the plain "REDACTED" line; your own deaths are shown by the HUD death card.
import { PHASE } from '/shared/constants.js';

const MULTI = ['DOUBLE PRINT', 'TRIPLE SPREAD', 'FULL SPREAD'];
const STREAKS = { 3: 'ON A ROLL', 5: 'BESTSELLER', 7: 'GOING TO REPRINT' };
const MULTI_WINDOW = 3.5;       // seconds between kills that still chain
const PUBLIC_STREAK = 5;        // other players' streaks are news from here up

export function createAnnouncer(G) {
  let lastKill = -Infinity, chain = 0, deadlineCalled = false, matchPointCalled = false;

  function say(text, sub, style, sound) {
    G.UI.announce(text, sub, style);
    if (sound) G.A.play(sound);
  }

  return {
    newRound() {
      lastKill = -Infinity;
      chain = 0;
      deadlineCalled = matchPointCalled = false;
    },

    /** Every `kill` message. killer / victim are roster entries (killer null = environment). */
    kill(msg, killer, victim) {
      const self = G.state.id;
      const byOther = killer && killer.id !== msg.victim;
      if (msg.victim === self) {
        // a death by another player is already shown by the HUD's own "REDACTED by …" death card
        if (msg.final && byOther) say('FINAL EDIT', `${killer.name} closes the issue`, 'round');
        else if (byOther) return;
        else if (msg.w === -1) say('RETURN TO SENDER', 'you left the page', 'warn');
        else say('SELF-EDITED', 'by your own hand', 'warn');
        return;
      }
      if (msg.killer === self) {
        chain = G.time - lastKill <= MULTI_WINDOW ? chain + 1 : 1;
        lastKill = G.time;
        const sub = msg.hs ? 'HEADLINE!' : victim.name;
        if (msg.final) say('FINAL EDIT', sub, 'round', 'streak');
        else if (chain >= 2) say(MULTI[Math.min(chain, MULTI.length + 1) - 2], sub, 'streak', 'streak');
        else if (STREAKS[msg.streak]) say(STREAKS[msg.streak], sub, 'streak', 'streak');
        else if (msg.first) say('FIRST DRAFT', sub, 'kill');
        else say(`REDACTED ${victim.name}`, msg.hs ? 'HEADLINE!' : '', 'kill');
        return;
      }
      if (!byOther) return;
      if (msg.final) say('FINAL EDIT', `${killer.name} closes the issue`, 'round');
      else if (msg.streak >= PUBLIC_STREAK && STREAKS[msg.streak]) say(STREAKS[msg.streak], killer.name, 'info');
    },

    saved() { say('SECOND DRAFT!', 'one more proof', 'info'); },

    overprint(player) { say(`${player.name} IS OVERPRINTED`, 'double damage', 'warn', 'announce'); },

    /** Per frame while a round is live. */
    clock(timeLeft) {
      if (deadlineCalled || timeLeft > 30 || timeLeft < 20 || G.state.settings.roundTime < 60) return;
      deadlineCalled = true;
      say('DEADLINE: 30 SECONDS', '', 'warn', 'announce');
    },

    /** After every roster update: call match point once per round. */
    scores() {
      const goal = G.state.settings.killsToWin;
      if (matchPointCalled || G.state.phase !== PHASE.PLAYING || goal < 3) return;
      for (const p of G.players.values()) {
        if (p.kills !== goal - 1) continue;
        matchPointCalled = true;
        say(`${p.name} — ONE KILL FROM PRINT`, '', 'warn', 'announce');
        return;
      }
    },
  };
}

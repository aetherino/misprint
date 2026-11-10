// Per-frame HUD payload for UI.setHud. One reused object: nothing is allocated per frame.
import { PHASE, MOVE, F } from '/shared/constants.js';
import { WEAPONS, magSize } from '/shared/weapons.js';

export function createHud(G) {
  const leader = { name: '', kills: 0, color: 0 };
  const hud = {
    alive: false, hp: 0, maxHp: 100, weapon: 0, ammo: 0, mag: 0, reload: null, charge: 0,
    dash: { charges: 0, max: 1, frac: 1 }, rewind: 1, overprint: 0, speed: 0, spread: 0,
    timeLeft: 0, round: 0, kills: 0, killsToWin: 0, leader: null,
    respawnIn: 0, killerName: '', slowed: false, ghost: false, cards: [],
  };

  function findLeader() {
    let best = null;
    for (const p of G.players.values()) if (p.kills > 0 && (!best || p.kills > best.kills)) best = p;
    if (!best) return null;
    leader.name = best.name; leader.kills = best.kills; leader.color = best.color;
    return leader;
  }

  return function pushHud(serverNow) {
    const { me, state: s, mover: m, weapons: w, rewind } = G;
    const def = WEAPONS[w.cur];
    const self = G.players.get(s.id);
    const playing = s.phase === PHASE.PLAYING;

    hud.alive = me.alive;
    hud.hp = me.hp;
    hud.maxHp = me.stats.maxHp;
    hud.weapon = w.cur;
    hud.ammo = w.ammo[w.cur];
    hud.mag = magSize(def, me.stats);
    hud.reload = w.reloadT > 0 ? 1 - w.reloadT / w.reloadDur : null;
    hud.charge = w.charge;
    hud.dash.charges = m.dashCharges;
    hud.dash.max = me.stats.dashCharges;
    hud.dash.frac = m.dashFrac();
    hud.rewind = 1 - Math.min(1, rewind.cooldown / (MOVE.rewindCooldown * me.stats.rewindCooldown));
    hud.overprint = Math.max(0, (me.overprintUntil - serverNow) / 1000);
    hud.speed = me.alive ? m.hSpeed() : 0;
    hud.spread = w.spread();
    hud.timeLeft = playing ? Math.max(0, (s.endsAt - serverNow) / 1000) : 0;
    hud.round = s.round;
    hud.kills = self ? self.kills : 0;
    hud.killsToWin = s.settings.killsToWin;
    hud.leader = findLeader();
    hud.respawnIn = !me.alive && playing ? Math.max(0, me.respawnAt - G.time) : 0;
    hud.killerName = me.killerName;
    hud.slowed = me.alive && m.slowT > 0;
    hud.ghost = me.alive && (G.local.flags & F.GHOST) !== 0;
    hud.cards = me.cards;
    G.UI.setHud(hud);
    return hud;
  };
}

// In-browser stand-in for the game server (`?offline=1`): a practice range with target dummies.
// Speaks just enough of the SPEC §4 protocol for movement, weapons, pickups, deaths and respawns.
// Extra URL params: `seed=<n>` picks the arena, `cards=id,id` gives you Errata cards to try.
import { PROTOCOL_VERSION, TICK_HZ, TIMING, DEFAULT_SETTINGS, PHASE, F } from '/shared/constants.js';
import { WEAPONS, hitscanDamage, splashDamage } from '/shared/weapons.js';
import { computeStats, CARD_BY_ID } from '/shared/cards.js';
import { generateMap, navCenter, navIndex } from '/shared/mapgen.js';

const SELF = 1;
const COUNTDOWN = 1.5;
const DUMMIES = [
  { name: 'PROOF COPY', color: 4, face: 3, angle: 0.4, radius: 9 },
  { name: 'TEST SHEET', color: 1, face: 5, angle: 2.5, radius: 11 },
  { name: 'SPOILAGE', color: 3, face: 7, angle: 4.6, radius: 13 },
];
const BLOTTER = WEAPONS[3];

export function createOfflineServer(deliver) {
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed')) || 7;
  const myCards = (params.get('cards') || '').split(',').filter((id) => CARD_BY_ID[id]);
  const map = generateMap(seed, 4);
  const settings = { ...DEFAULT_SETTINGS, killsToWin: 99, roundTime: 5940, bots: DUMMIES.length };
  const pickups = map.pickups.map((p) => ({ ...p, active: true }));
  const players = new Map();
  const timers = new Set();
  const now = () => performance.timeOrigin + performance.now();
  let me = null, ticker = 0, spawnCount = 0, firstKill = true, overprintUntil = 0;

  function later(seconds, fn) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, seconds * 1000);
    timers.add(id);
  }

  // Nearest ground cell a player-sized body fits in.
  function freeSpot(x, z) {
    const nav = map.nav;
    let best = [x, z], bestD = Infinity;
    for (let i = 0; i < nav.walk.length; i++) {
      if (!nav.walk[i]) continue;
      const c = navCenter(nav, i);
      const d = (c[0] - x) ** 2 + (c[1] - z) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return [best[0], 0, best[1]];
  }
  const walkable = (x, z) => { const i = navIndex(map.nav, x, z); return i >= 0 && map.nav.walk[i] === 1; };

  function addPlayer(id, info, cards, isBot) {
    const stats = computeStats(cards);
    const p = { id, ...info, isBot, cards, stats, wins: 0, kills: 0, deaths: 0, streak: 0, alive: false, hp: stats.maxHp, pos: [0, 0, 0], yaw: 0, st: null, home: null, sway: 0 };
    players.set(id, p);
    return p;
  }

  function addDummies() {
    DUMMIES.forEach((d, i) => {
      const p = addPlayer(SELF + 1 + i, { name: d.name, color: d.color, face: d.face }, [], true);
      p.home = freeSpot(Math.cos(d.angle) * d.radius, Math.sin(d.angle) * d.radius);
      // strafe along X only where both ends of the path are clear
      p.sway = i > 0 && walkable(p.home[0] - 1.5, p.home[2]) && walkable(p.home[0] + 1.5, p.home[2]) ? 1.2 : 0;
    });
  }

  const rosterRow = (p) => ({ id: p.id, name: p.name, color: p.color, face: p.face, isBot: p.isBot, wins: p.wins, kills: p.kills, deaths: p.deaths, ping: 0, cards: p.cards, alive: p.alive });
  const sendRoster = () => deliver({ t: 'roster', hostId: SELF, joinUrls: [location.origin], settings, players: [...players.values()].map(rosterRow) });
  const sendPhase = (phase, seconds) => deliver({
    t: 'phase', phase, round: 1, now: now(), endsAt: now() + seconds * 1000, seed, mapPlayers: 4,
    pickups: pickups.map((p) => ({ id: p.id, active: p.active })), winnerId: null, standings: [],
  });

  function spawn(p) {
    const at = p.home ? { pos: p.home, yaw: 0 } : map.spawns[spawnCount++ % map.spawns.length];
    p.alive = true;
    p.hp = p.stats.maxHp;
    p.pos = at.pos.slice();
    p.yaw = at.yaw;
    p.st = null;
    deliver({ t: 'spawn', id: p.id, p: p.pos, yaw: p.yaw, hp: p.hp, protect: 0 });
  }

  function kill(killer, victim, w, hs) {
    victim.alive = false;
    victim.deaths++;
    victim.streak = 0;
    const credited = killer && killer !== victim;
    if (credited) { killer.kills++; killer.streak++; }
    const burst = credited && killer.stats.inkBurst ? { p: victim.pos, r: 5 } : null;
    deliver({ t: 'kill', killer: killer ? killer.id : null, victim: victim.id, w, hs: hs ? 1 : 0, streak: credited ? killer.streak : 0, first: credited && firstKill, final: false, burst });
    if (credited) firstKill = false;
    sendRoster();
    later(TIMING.respawn, () => spawn(victim));
  }

  function damage(from, to, amount, w, hs, p) {
    if (!to || !to.alive) return;
    const dmg = Math.max(1, Math.round(amount * (now() < overprintUntil ? 2 : 1)));
    to.hp = Math.max(0, to.hp - dmg);
    deliver({ t: 'hit', from: from.id, to: to.id, dmg, hp: to.hp, hs: hs ? 1 : 0, w, slow: from.stats.jam, p });
    if (to.hp <= 0) kill(from, to, w, hs);
  }

  function snap() {
    const t = now();
    const ps = [];
    for (const p of players.values()) {
      if (!p.alive) continue;
      if (p === me) {
        if (!p.st) continue;
        p.pos = p.st.p;
        ps.push([p.id, ...p.st.p, p.st.yaw, p.st.pitch, p.st.f, p.st.w, p.hp]);
      } else {
        p.pos = [p.home[0] + Math.sin(t / 900 + p.id) * p.sway, p.home[1], p.home[2]];
        if (me) p.yaw = Math.atan2(p.pos[0] - me.pos[0], p.pos[2] - me.pos[2]);
        ps.push([p.id, ...p.pos, p.yaw, 0, F.GROUND, 0, p.hp]);
      }
    }
    deliver({ t: 'snap', now: t, ps });
  }

  const handlers = {
    hello(msg) {
      me = addPlayer(SELF, { name: String(msg.name || 'YOU').slice(0, 14), color: msg.color | 0, face: msg.face | 0 }, myCards, false);
      addDummies();
      deliver({ t: 'welcome', id: SELF, now: now(), v: PROTOCOL_VERSION });
      sendRoster();
      sendPhase(PHASE.COUNTDOWN, COUNTDOWN);
      for (const p of players.values()) spawn(p);
      later(COUNTDOWN, () => sendPhase(PHASE.PLAYING, settings.roundTime));
      ticker = setInterval(snap, 1000 / TICK_HZ);
    },
    profile(msg) {
      Object.assign(me, { name: String(msg.name || me.name).slice(0, 14), color: msg.color | 0, face: msg.face | 0 });
      sendRoster();
    },
    st(msg) { if (me.alive) me.st = msg; },
    fire(msg) {
      const w = WEAPONS[msg.w];
      if (!w || !me.alive) return;
      for (const h of msg.hits) {
        const target = players.get(h.id);
        if (!target || target === me) continue;
        const dist = Math.hypot(h.e[0] - msg.o[0], h.e[1] - msg.o[1], h.e[2] - msg.o[2]);
        damage(me, target, hitscanDamage(w, dist, !!h.hs, me.stats, msg.c ?? 1, me.hp / me.stats.maxHp), w.id, !!h.hs, h.e);
      }
    },
    boom(msg) {
      for (const h of msg.hits) {
        const target = players.get(h.id);
        if (!target) continue;
        const selfMul = target === me ? BLOTTER.selfDmg * me.stats.selfDmg : 1;
        damage(me, target, splashDamage(BLOTTER, h.d, me.stats, me.hp / me.stats.maxHp) * selfMul, BLOTTER.id, false, [target.pos[0], target.pos[1] + 0.9, target.pos[2]]);
      }
    },
    pickup(msg) {
      const pk = pickups[msg.id];
      if (!pk || !pk.active || !me.alive) return;
      pk.active = false;
      deliver({ t: 'pk', id: pk.id, active: false, by: SELF });
      if (pk.type === 'health') {
        me.hp = Math.min(me.stats.maxHp, me.hp + 50);
        deliver({ t: 'heal', id: SELF, hp: me.hp, src: 'pickup' });
      } else {
        overprintUntil = now() + 10000;
        deliver({ t: 'buff', id: SELF, type: 'overprint', until: overprintUntil });
      }
      later(pk.respawn, () => { pk.active = true; deliver({ t: 'pk', id: pk.id, active: true, by: null }); });
    },
    rewind() {
      if (me.stats.rewindFullHeal) me.hp = me.stats.maxHp;
      deliver({ t: 'heal', id: SELF, hp: me.hp, src: 'rewind' });
    },
    fell() { if (me.alive) kill(null, me, -1, false); },
    chat(msg) { deliver({ t: 'chat', id: SELF, name: me.name, color: me.color, text: String(msg.text).slice(0, 140) }); },
    ping(msg) { deliver({ t: 'pong', c: msg.c, s: now() }); },
  };

  return {
    receive(msg) { const h = handlers[msg.t]; if (h && (me || msg.t === 'hello')) h(msg); },
    stop() {
      clearInterval(ticker);
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}

// Player record (humans and bots share it) + the few pure helpers that read it.
import { PLAYER, INKS, FACES, MOVE } from '../shared/constants.js';
import { WEAPONS } from '../shared/weapons.js';
import { computeStats } from '../shared/cards.js';
import { clamp, isNum, makeLimiter } from './util.js';

const HISTORY_MS = 100;                                   // hp/pos history sample period (~10 Hz)
const HISTORY_LEN = Math.ceil((MOVE.rewindSeconds * 1000) / HISTORY_MS) + 12;

export const cleanColor = (c) => (isNum(c) ? clamp(Math.floor(c), 0, INKS.length - 1) : 0);
export const cleanFace = (f) => (isNum(f) ? clamp(Math.floor(f), 0, FACES.length - 1) : 0);

export function createPlayer(id, { name, color, face, conn = null, brain = null }) {
  return {
    id, name, color: cleanColor(color), face: cleanFace(face),
    conn,                       // network connection (null for bots)
    brain,                      // bot AI state (null for humans)
    isBot: !conn,
    joinedAt: id,               // ids are monotonic, so they double as join order
    ping: 0, pingSent: 0,
    // match
    wins: 0, cards: [], stats: computeStats([]),
    // round
    kills: 0, deaths: 0, streak: 0, lastKillAt: 0,
    // life
    alive: false, hp: 0,
    pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, flags: 0, weapon: 0,
    respawnAt: 0, spawnedAt: 0, protectUntil: 0, lastDamageAt: 0, secondDraftUsed: false,
    overprintUntil: 0, slowUntil: 0,
    botContactAt: 0,            // last time a bot had this player in its sights (bots seek out neglected humans)
    nextFire: WEAPONS.map(() => 0),
    lastRewindAt: 0,
    history: [], historyAt: 0,  // [{ t, hp, pos }] newest last
    bombs: new Map(),           // live Blotter projectiles this player launched: pid → launch info
    // rate limits
    chatLimit: makeLimiter(0.8, 4),
    evLimit: makeLimiter(30, 40),
  };
}

export function setCards(p, cards) {
  p.cards = cards;
  p.stats = computeStats(cards);
}

/** Roster row exactly as SPEC §4 lists it. */
export function rosterRow(p) {
  return {
    id: p.id, name: p.name, color: p.color, face: p.face, isBot: p.isBot,
    wins: p.wins, kills: p.kills, deaths: p.deaths, ping: p.ping,
    cards: p.cards.slice(), alive: p.alive,
  };
}

export const hpWire = (p) => (p.alive ? Math.max(1, Math.round(p.hp)) : 0);
export const hpFrac = (p) => clamp(p.hp / p.stats.maxHp, 0, 1);

export const bodyRadius = (p) => PLAYER.radius * p.stats.scale;
export const bodyHeight = (p) => PLAYER.height * p.stats.scale;
export const chest = (p) => [p.pos[0], p.pos[1] + PLAYER.height * 0.5 * p.stats.scale, p.pos[2]];
export const eye = (p) => [p.pos[0], p.pos[1] + PLAYER.eye * p.stats.scale, p.pos[2]];

export function recordHistory(p, now) {
  if (now - p.historyAt < HISTORY_MS) return;
  p.historyAt = now;
  p.history.push({ t: now, hp: p.hp, pos: p.pos.slice() });
  if (p.history.length > HISTORY_LEN) p.history.shift();
}

/** The history sample closest to `ms` ago; the oldest sample of this life if the life is younger than that. */
export function historyAt(p, now, ms) {
  const h = p.history;
  if (!h.length) return null;
  const want = now - ms;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= want) return h[i];
  return h[0];
}

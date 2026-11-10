// Damage authority: validates what clients (and bots) claim to have hit, applies it, and
// resolves everything that follows from damage — card effects, kills, pickups, rewind.
import { PHASE, MOVE, MAX_PLAYERS } from '../shared/constants.js';
import { WEAPONS, fireInterval, hitscanDamage, splashDamage } from '../shared/weapons.js';
import { clamp, isNum, vec3, rv, r2, dist } from './util.js';
import { chest, eye, hpWire, hpFrac, historyAt } from './player.js';

const BLOTTER = WEAPONS.find((w) => w.kind === 'projectile');

const ORIGIN_SLACK = 8;        // m between claimed muzzle and the shooter's last reported eye
const END_SLACK = 6;           // m between claimed impact and the target's last reported position
const RANGE_SLACK = 6;         // m beyond weapon.range
const SPLASH_SLACK = 3;        // m of disagreement tolerated on blast distances
const FIRE_RATE_SLACK = 0.75;  // shots may arrive up to 25% faster than the weapon allows
const JITTER_MS = 150;         // bunching tolerated for fast weapons (packets arrive in clumps)
const MAX_VIA = 4;
const MAX_LIVE_BOMBS = 8;
const BOMB_LATE_S = 2.5;       // a `boom` may trail the fuse by this much
const BURST_RADIUS = 5;        // Ink Burst
const SAVE_GRACE_MS = 600;     // invulnerability after Second Draft triggers, so it is worth a card
const THORNS_FLOOR = 1;        // Thermal Paper never takes the attacker below this
const REWIND_SLACK = 0.85;
const REWIND_POS_SLACK = 12;
const HEALTH_AMOUNT = 50;
const OVERPRINT_MS = 10000;
const PICKUP_REACH = 2.5;

function fireRateOk(p, w, now) {
  const interval = fireInterval(w, p.stats) * 1000;
  const allowance = Math.max(0, JITTER_MS - interval * (1 - FIRE_RATE_SLACK));
  const earliest = Math.max(p.nextFire[w.id], now - allowance);
  if (earliest > now) return false;
  p.nextFire[w.id] = earliest + interval * FIRE_RATE_SLACK;
  return true;
}

function cleanHits(raw) {
  const out = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') return null;
    const e = vec3(h.e);
    if (!e) return null;
    const n = h.n == null ? null : vec3(h.n, 1.01);
    const hit = { e: rv(e), n: n ? rv(n) : null, id: Number.isInteger(h.id) ? h.id : null, hs: h.hs ? 1 : 0 };
    if (Array.isArray(h.via) && h.via.length) {
      const via = h.via.slice(0, MAX_VIA).map((v) => vec3(v));
      if (via.some((v) => !v)) return null;
      hit.via = via.map(rv);
    }
    out.push(hit);
  }
  return out;
}

/** `fire` from a human socket or a bot. Bad input is dropped without a reply. */
export function handleFire(game, p, m) {
  if (game.phase !== PHASE.PLAYING || !p.alive) return;
  const w = Number.isInteger(m.w) ? WEAPONS[m.w] : null;
  if (!w || w.kind === 'projectile') return;
  if (!Array.isArray(m.hits) || m.hits.length > w.pellets) return;
  const o = vec3(m.o);
  if (!o || dist(o, eye(p)) > ORIGIN_SLACK) return;
  const hits = cleanHits(m.hits);
  if (!hits) return;
  const now = game.now();
  if (!fireRateOk(p, w, now)) return;

  p.protectUntil = 0;
  const c = isNum(m.c) ? clamp(m.c, 0, 1) : 0;
  game.broadcast({ t: 'fire', id: p.id, w: w.id, o: rv(o), c: r2(c), hits }, p);

  const boost = p.overprintUntil > now ? 2 : 1;
  const frac = hpFrac(p);
  const perTarget = new Map();
  for (const h of hits) {
    if (h.id === null) continue;
    const target = game.players.get(h.id);
    if (!target || target === p || !target.alive) continue;
    const via = h.via || [];
    if (via.length > p.stats.bounce) continue;
    const center = chest(target);
    if (dist(h.e, center) > END_SLACK) continue;
    let len = 0, from = o;
    for (const v of via) { len += dist(from, v); from = v; }
    len += dist(from, center);
    if (len > w.range + RANGE_SLACK) continue;
    const dmg = hitscanDamage(w, len, h.hs === 1, p.stats, c, frac) * boost;
    const acc = perTarget.get(target);
    if (acc) { acc.dmg += dmg; acc.hs |= h.hs; } else perTarget.set(target, { dmg, hs: h.hs, p: h.e });
  }
  for (const [target, acc] of perTarget) applyDamage(game, p, target, acc.dmg, { w: w.id, hs: acc.hs, p: acc.p });
}

/** Blotter bomb launched. */
export function handleProj(game, p, m) {
  if (game.phase !== PHASE.PLAYING || !p.alive) return;
  if (!Number.isInteger(m.pid)) return;
  const o = vec3(m.o), vel = vec3(m.vel, 200);
  if (!o || !vel || dist(o, eye(p)) > ORIGIN_SLACK) return;
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  if (speed > BLOTTER.speed * 2 + 20) return;       // generous: throws inherit the thrower's velocity
  const now = game.now();
  for (const [pid, bomb] of p.bombs) if (now - bomb.at > (BLOTTER.fuse + BOMB_LATE_S) * 1000) p.bombs.delete(pid);
  if (p.bombs.size >= MAX_LIVE_BOMBS || p.bombs.has(m.pid)) return;
  if (!fireRateOk(p, BLOTTER, now)) return;

  p.protectUntil = 0;
  p.bombs.set(m.pid, { at: now, o, speed });
  game.broadcast({ t: 'proj', id: p.id, pid: m.pid, o: rv(o), vel: rv(vel) }, p);
}

/** Blotter bomb exploded. The thrower may have died since the throw; the bomb still counts. */
export function handleBoom(game, p, m) {
  if (game.phase !== PHASE.PLAYING) return;
  const bomb = p.bombs.get(m.pid);
  if (!bomb) return;
  p.bombs.delete(m.pid);
  const pos = vec3(m.p);
  if (!pos) return;
  const now = game.now();
  const age = (now - bomb.at) / 1000;
  if (age > BLOTTER.fuse + BOMB_LATE_S) return;
  if (dist(pos, bomb.o) > Math.max(bomb.speed, BLOTTER.speed) * (age + 0.3) + 4) return;

  const radius = BLOTTER.radius * p.stats.splashRadius;
  game.broadcast({ t: 'boom', id: p.id, pid: m.pid, p: rv(pos), r: r2(radius) }, p);

  const boost = p.overprintUntil > now ? 2 : 1;
  const frac = p.alive ? hpFrac(p) : 1;
  const seen = new Set();
  const claimed = Array.isArray(m.hits) ? m.hits.slice(0, MAX_PLAYERS) : [];
  for (const h of claimed) {
    if (!h || !Number.isInteger(h.id) || !isNum(h.d) || seen.has(h.id)) continue;
    seen.add(h.id);
    const target = game.players.get(h.id);
    if (!target || !target.alive) continue;
    const center = chest(target);
    const real = dist(pos, center);
    if (real > radius + SPLASH_SLACK) continue;
    const d = clamp(h.d, Math.max(0, real - SPLASH_SLACK), real + SPLASH_SLACK);
    let dmg = splashDamage(BLOTTER, d, p.stats, frac);
    if (dmg <= 0) continue;
    dmg *= target === p ? BLOTTER.selfDmg * p.stats.selfDmg : boost;
    applyDamage(game, p, target, dmg, { w: BLOTTER.id, hs: 0, p: center });
  }
}

function heal(game, p, amount, src) {
  if (!p.alive || amount <= 0) return false;
  const before = p.hp;
  p.hp = Math.min(p.stats.maxHp, p.hp + amount);
  if (p.hp <= before) return false;
  game.broadcast({ t: 'heal', id: p.id, hp: hpWire(p), src });
  return true;
}

/**
 * Single door for all damage. `info.w` = weapon id, or −1 for thorns / Ink Burst (which never
 * trigger on-hit cards themselves). Returns the damage actually dealt.
 */
export function applyDamage(game, attacker, victim, amount, info) {
  if (game.phase !== PHASE.PLAYING || !victim.alive) return 0;
  const now = game.now();
  if (victim.protectUntil > now) return 0;

  let dmg = Math.max(1, Math.round(amount));
  const direct = info.w >= 0 && attacker !== victim;
  let saved = false;
  if (victim.hp - dmg <= 0 && victim.stats.secondDraft > 0 && !victim.secondDraftUsed) {
    saved = true;
    victim.secondDraftUsed = true;
    dmg = Math.max(0, Math.round(victim.hp - 1));
    victim.hp = 1;
    victim.protectUntil = now + SAVE_GRACE_MS;
  } else {
    victim.hp -= dmg;
  }
  victim.lastDamageAt = now;
  const dead = victim.hp <= 0;
  if (dead) victim.hp = 0;

  const slow = direct && !dead && attacker.stats.jam > 0 ? attacker.stats.jam : 0;
  if (slow) victim.slowUntil = now + slow * 1000;
  if (victim.brain && attacker !== victim) {
    victim.brain.attackerId = attacker.id;
    victim.brain.attackedAt = now;
  }

  game.broadcast({
    t: 'hit', from: attacker.id, to: victim.id, dmg, hp: dead ? 0 : hpWire(victim),
    hs: info.hs ? 1 : 0, w: info.w, slow, p: rv(info.p || chest(victim)),
  });
  if (saved) game.broadcast({ t: 'saved', id: victim.id });

  if (direct && attacker.alive) {
    if (attacker.stats.lifesteal > 0) heal(game, attacker, dmg * attacker.stats.lifesteal, 'lifesteal');
    if (victim.stats.thorns > 0) reflect(game, victim, attacker, dmg * victim.stats.thorns, now);
  }
  if (dead) killPlayer(game, attacker === victim ? null : attacker, victim, info);
  return dmg;
}

// Thermal Paper: hurts, never kills (dying to your own bullets with no counterplay is not fun).
function reflect(game, owner, attacker, amount, now) {
  const dmg = Math.min(Math.max(1, Math.round(amount)), Math.floor(attacker.hp - THORNS_FLOOR));
  if (dmg <= 0) return;
  attacker.hp -= dmg;
  attacker.lastDamageAt = now;
  game.broadcast({
    t: 'hit', from: owner.id, to: attacker.id, dmg, hp: hpWire(attacker), hs: 0, w: -1, slow: 0, p: rv(chest(attacker)),
  });
}

/** `killer` null = environment or self-inflicted. */
export function killPlayer(game, killer, victim, info) {
  const now = game.now();
  victim.alive = false;
  victim.hp = 0;
  victim.deaths++;
  victim.streak = 0;
  victim.overprintUntil = 0;
  victim.respawnAt = now + game.timing.respawn * 1000;

  let first = false, final = false;
  if (killer) {
    killer.kills++;
    killer.streak++;
    killer.lastKillAt = now;
    first = !game.arena.firstBlood;
    game.arena.firstBlood = true;
    final = killer.kills >= game.settings.killsToWin;
  }
  const where = chest(victim);
  const burst = killer && killer.stats.inkBurst > 0 ? { p: rv(where), r: BURST_RADIUS } : null;
  game.broadcast({
    t: 'kill', killer: killer ? killer.id : null, victim: victim.id, w: info.w, hs: info.hs ? 1 : 0,
    streak: killer ? killer.streak : 0, first, final, burst,
  });
  game.rosterDirty = true;
  game.afterKill(killer, victim);

  if (killer && killer.stats.killHeal > 0) heal(game, killer, killer.stats.killHeal, 'kill');
  if (final) { game.endRound(); return; }
  if (!burst) return;
  for (const q of [...game.players.values()]) {
    if (q === killer || q === victim || !q.alive) continue;
    const center = chest(q);
    if (dist(center, where) <= BURST_RADIUS) applyDamage(game, killer, q, killer.stats.inkBurst, { w: -1, hs: 0, p: center });
  }
}

export function handleFell(game, p) {
  if (!p.alive || !game.arena) return;
  if (game.phase === PHASE.PLAYING) killPlayer(game, null, p, { w: -1, hs: 0 });
  else if (game.phase === PHASE.COUNTDOWN || game.phase === PHASE.ROUND_END) game.spawnPlayer(p);
}

export function handleRewind(game, p, m) {
  if (game.phase !== PHASE.PLAYING || !p.alive) return;
  const pos = vec3(m.p);
  if (!pos) return;
  const now = game.now();
  const cooldown = MOVE.rewindCooldown * p.stats.rewindCooldown * 1000;
  if (p.lastRewindAt && now - p.lastRewindAt < cooldown * REWIND_SLACK) return;
  const past = historyAt(p, now, MOVE.rewindSeconds * 1000);
  if (past && dist(pos, past.pos) > REWIND_POS_SLACK) return;

  p.lastRewindAt = now;
  p.pos = pos;
  const restored = p.stats.rewindFullHeal ? p.stats.maxHp : Math.max(p.hp, past ? past.hp : p.hp);
  p.hp = Math.min(p.stats.maxHp, restored);
  game.broadcast({ t: 'heal', id: p.id, hp: hpWire(p), src: 'rewind' });
  game.broadcast({ t: 'ev', id: p.id, k: 'rewind', p: rv(pos) }, p);
}

/** Applies a pickup to `p` if it is available and useful. Shared by humans (after validation) and bots. */
export function takePickup(game, p, pk) {
  if (!pk.active || !p.alive) return false;
  const now = game.now();
  if (pk.type === 'health') {
    if (p.hp >= p.stats.maxHp - 0.5) return false;
  } else if (pk.type !== 'overprint') {
    return false;
  }
  pk.active = false;
  pk.respawnAt = now + pk.respawn * 1000;
  game.broadcast({ t: 'pk', id: pk.id, active: false, by: p.id });
  if (pk.type === 'health') {
    heal(game, p, HEALTH_AMOUNT, 'pickup');
  } else {
    p.overprintUntil = now + OVERPRINT_MS;
    game.broadcast({ t: 'buff', id: p.id, type: 'overprint', until: p.overprintUntil });
  }
  return true;
}

export function handlePickup(game, p, m) {
  if (game.phase !== PHASE.PLAYING || !p.alive) return;
  const pk = game.arena.pickups.get(m.id);
  if (!pk || dist(chest(p), pk.pos) > PICKUP_REACH) return;
  takePickup(game, p, pk);
}

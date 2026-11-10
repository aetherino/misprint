// Print-shop staff: server-side bots. They walk the same collision world as humans (shared/physics.js),
// see with line-of-sight + field of view + reaction time, and shoot real `fire` messages through the
// same validation and damage path as everyone else — no hidden stat bonuses.
import { PLAYER, MOVE, F, INKS, FACES, yawPitchToDir } from '../shared/constants.js';
import { WEAPONS, fireInterval, magSize, reloadTime, chargeTime } from '../shared/weapons.js';
import { moveBody, raycast, rayAABB, raySphere, segmentClear, reflect, stepProjectile } from '../shared/physics.js';
import { navCenter } from '../shared/mapgen.js';
import { clamp, rand, randInt, pick, angDiff, dist, distXZ, rv } from './util.js';
import { chest, eye, bodyRadius, bodyHeight } from './player.js';
import { findPath, isWalkable, lineWalkable, nearestCell, randomCell, regionAt } from './nav.js';
import { handleFire, handleProj, handleBoom, takePickup } from './combat.js';

export const BOT_NAMES = [
  'Toner Tony', 'Jam Pam', 'Staple Steve', 'Collate Kate', 'Duplex Dex', 'Inkjet Ian',
  'Margin Marge', 'Gutter Gus', 'Serif Sheryl', 'Bleed Reid',
];

const QUIPS = [
  'Filed under: deleted.', 'That one goes in the shredder.', 'Reprint requested.', 'Out of ink already?',
  'Paper beats you.', 'Stapled. Collated. Done.', 'Please hold for the next available intern.',
];

const [STAPLER, PUNCH, MARKER, BLOTTER] = [0, 1, 2, 3];

// react: seconds before a newly seen enemy gets shot at. turn: max rad/s. aim: base angular error (rad),
// shrinking to aim×tight over ~tau seconds of unbroken line of sight; track: extra error per rad/s the
// target moves across the view. trigger: how well lined up before pulling the trigger. pump: Hole Punch
// cadence as a multiple of its fire interval (nobody racks it like a metronome).
const SKILLS = [
  { // intern — a newcomer should win most duels
    react: [0.55, 0.9], turn: 3.2, aim: 0.105, tight: 0.5, tau: 1.6, track: 0.22, trigger: 0.16,
    fov: 1.9, view: 45, memory: 2, speed: 0.8, range: 9,
    burst: [2, 4], pause: [0.55, 1.1], pump: [1.5, 2.2], strafe: 0.45, hop: 0.05, dash: 0, head: 0,
    marker: false, charge: 0.5, blotter: 0.12, lobErr: 2.2,
    hunt: 0.55, greed: 0.2, seekHealth: 0.4,
  },
  { // staff
    react: [0.32, 0.52], turn: 5.5, aim: 0.055, tight: 0.4, tau: 1.2, track: 0.14, trigger: 0.1,
    fov: 2.4, view: 60, memory: 3, speed: 0.92, range: 12,
    burst: [3, 6], pause: [0.3, 0.7], pump: [1.1, 1.5], strafe: 0.8, hop: 0.25, dash: 0.35, head: 0.15,
    marker: true, charge: 0.6, blotter: 0.2, lobErr: 1.2,
    hunt: 0.7, greed: 0.3, seekHealth: 0.5,
  },
  { // editor-in-chief — scary, but reacts no faster than a sharp human and cannot flick 180°
    react: [0.19, 0.3], turn: 8.5, aim: 0.03, tight: 0.3, tau: 0.8, track: 0.085, trigger: 0.07,
    fov: 2.9, view: 80, memory: 4, speed: 1, range: 13,
    burst: [4, 8], pause: [0.2, 0.45], pump: [1.02, 1.25], strafe: 1, hop: 0.5, dash: 0.8, head: 0.35,
    marker: true, charge: 0.8, blotter: 0.28, lobErr: 0.6,
    hunt: 0.8, greed: 0.45, seekHealth: 0.6,
  },
];

const SWAP_MS = 350;
const STUCK_WINDOW_MS = 1000;
const STUCK_MOVE = 0.5;        // m per window below which a bot that wants to move counts as stuck
const STUCK_RESCUE = 4;        // windows in a row before the bot is put back on the nav grid
const SUBSTEP = 1 / 40;
const BOMB_STEP = 1 / 60;
const GRAB_RADIUS = 1.2;
// Hunting bots weigh distance to a human by this factor: the match exists for the humans.
const HUMAN_PULL = 0.55;
// The director: a human no bot has had in its sights for NEGLECT_MS gets one bot sent over on a
// "mission" (it walks past other bots unless they shoot it), so nobody waits long for a fight.
const NEGLECT_MS = 10000;
const MISSION_MS = 20000;

export function botIdentity(players) {
  const all = [...players.values()];
  const names = new Set(all.map((p) => p.name));
  const colors = new Set(all.map((p) => p.color));
  const freeNames = BOT_NAMES.filter((n) => !names.has(n));
  const freeColors = INKS.map((_, i) => i).filter((i) => !colors.has(i));
  return {
    name: freeNames.length ? pick(freeNames) : `Temp ${randInt(100, 999)}`,
    color: freeColors.length ? pick(freeColors) : randInt(0, INKS.length - 1),
    face: randInt(0, FACES.length - 1),
  };
}

export function createBrain() {
  return { pid: 0, lastQuip: 0, rescues: 0 };
}

/** Called on every (re)spawn. */
export function resetBrain(bot, now) {
  const keep = bot.brain;
  bot.brain = {
    pid: keep.pid, lastQuip: keep.lastQuip, rescues: keep.rescues,
    // navigation
    goal: null, path: null, pathI: 0, pathGoal: null, repathAt: 0, forceWander: false, cantReachUntil: 0,
    mission: null, missionUntil: 0,
    onGround: true, blocked: false, jumpAt: now + 400, hopNow: false, padAt: 0,
    dashUntil: 0, dashReadyAt: now + 1500, dashDir: [0, 0],
    stuckPos: [bot.pos[0], bot.pos[2]], stuckAt: now, stuckCount: 0, wantedMs: 0,
    strafe: Math.random() < 0.5 ? -1 : 1, strafeUntil: 0,
    // perception
    thinkAt: now + rand(0, 150), targetId: null, visible: false, seenSince: 0, lastSeen: 0, lastSeenPos: null,
    reactAt: 0, aimHead: false, attackerId: null, attackedAt: 0,
    // aim
    err: [0, 0], errGoal: [0, 0], errAt: 0, aimOff: 9, scanYaw: bot.yaw, scanAt: 0,
    // weapons
    weapon: STAPLER, swapUntil: 0, mags: WEAPONS.map((w) => magSize(w, bot.stats)), reloading: -1, reloadUntil: 0,
    nextShot: 0, burstLeft: 0, pauseUntil: 0, charging: false, chargeFrom: 0, chargeFor: 0,
    lobAt: now + rand(2000, 6000), lobPending: 0,
  };
}

export function quip(game, bot) {
  const now = game.now();
  if (now - bot.brain.lastQuip < 20000 || Math.random() > 0.12) return;
  bot.brain.lastQuip = now;
  game.broadcast({ t: 'chat', id: bot.id, name: bot.name, color: bot.color, text: pick(QUIPS) });
}

const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.732;   // ≈ N(0, 1)
const targetOf = (game, b) => {
  const t = b.targetId === null ? null : game.players.get(b.targetId);
  return t && t.alive ? t : null;
};

/**
 * One simulation tick for one bot.
 * mode: 'frozen' (countdown), 'play', or 'idle' (round over: stop fighting, the winner celebrates).
 */
export function updateBot(game, bot, now, dt, mode) {
  const b = bot.brain;
  const S = SKILLS[game.settings.botSkill] || SKILLS[1];
  let wish = [0, 0];

  if (mode === 'play') {
    if (now >= b.thinkAt) {
      b.thinkAt = now + rand(90, 150);
      perceive(game, bot, b, S, now);
      chooseWeapon(game, bot, b, S, now);
    }
    wish = steer(game, bot, b, S, now);
  } else {
    b.targetId = null;
    b.visible = false;
    b.charging = false;
    if (mode === 'idle' && bot.id === game.winnerId && b.onGround && now >= b.jumpAt) {
      b.hopNow = true;
      b.jumpAt = now + 650;
    }
  }

  move(game, bot, b, S, wish, now, dt);
  aim(game, bot, b, S, now, dt);
  if (mode === 'play') {
    shoot(game, bot, b, S, now);
    grabPickups(game, bot);
  }

  bot.weapon = b.weapon;
  bot.flags = (b.onGround ? F.GROUND : 0) | (b.reloading >= 0 ? F.RELOAD : 0)
    | (b.charging ? F.CHARGE : 0) | (now < b.dashUntil ? F.DASH : 0);
}

// ───────────────────────────── perception ─────────────────────────────

function perceive(game, bot, b, S, now) {
  const world = game.arena.world;
  const from = eye(bot);
  if (b.mission !== null && (now >= b.missionUntil || !game.players.get(b.mission)?.alive)) b.mission = null;
  const mission = b.mission;
  let best = null, bestScore = Infinity;
  for (const q of game.players.values()) {
    if (q === bot || !q.alive) continue;
    const c = chest(q);
    const d = dist(from, c);
    if (d > S.view) continue;
    if (q.stats.ghost > 0 && (q.flags & F.GHOST) && d > 7) continue;       // Watermark works on bots too
    const hurtMe = b.attackerId === q.id && now - b.attackedAt < 3000;
    if (mission !== null && q.id !== mission && !hurtMe && d > 6) continue;
    if (!(d < 5 || hurtMe || q.id === b.targetId)) {
      const yawTo = Math.atan2(-(c[0] - from[0]), -(c[2] - from[2]));
      if (Math.abs(angDiff(yawTo, bot.yaw)) > S.fov / 2) continue;
    }
    if (!segmentClear(world, from, c)) continue;
    const score = d * (q.id === b.targetId ? 0.7 : 1) * (hurtMe ? 0.75 : 1);
    if (score < bestScore) { bestScore = score; best = q; }
  }

  if (best) {
    if (best.id !== b.targetId) {
      b.targetId = best.id;
      b.seenSince = now;
      b.reactAt = now + rand(S.react[0], S.react[1]) * 1000;
      b.aimHead = Math.random() < S.head;
      b.errAt = 0;
    } else if (!b.visible) {
      b.seenSince = now;                                                   // re-acquired: aim loosens again
      b.reactAt = Math.max(b.reactAt, now + S.react[0] * 500);
    }
    b.visible = true;
    best.botContactAt = now;
    if (best.id === mission) b.mission = null;                              // found them: back to normal
    b.lastSeen = now;
    b.lastSeenPos = best.pos.slice();
    return;
  }
  b.visible = false;
  if (b.targetId !== null && (!targetOf(game, b) || now - b.lastSeen > S.memory * 1000)) b.targetId = null;
}

/** Once per tick: send the nearest unassigned bot after every human the bots have been ignoring. */
export function directBots(game, now) {
  const nav = game.arena.nav;
  const bots = game.botList().filter((q) => q.alive);
  for (const h of game.players.values()) {
    if (h.isBot || !h.alive || now - h.botContactAt < NEGLECT_MS) continue;
    if (bots.some((q) => q.brain.mission === h.id)) continue;
    let best = null, bestD = Infinity;
    for (const q of bots) {
      if (q.brain.mission !== null || !reachable(nav, q, h.pos[0], h.pos[2])) continue;
      const d = distXZ(q.pos, h.pos);
      if (d < bestD) { bestD = d; best = q; }
    }
    if (!best) continue;
    best.brain.mission = h.id;
    best.brain.missionUntil = now + MISSION_MS;
    best.brain.goal = null;
  }
}

// ───────────────────────────── navigation ─────────────────────────────

/** Can the bot walk (and hop) there? Arenas may have ground regions that are sealed off from each other. */
function reachable(nav, bot, x, z) {
  const here = regionAt(nav, bot.pos[0], bot.pos[2]);
  return here >= 0 && here === regionAt(nav, x, z);
}

function healthGoal(game, bot, now) {
  const nav = game.arena.nav;
  let best = null, bestD = Infinity;
  for (const pk of game.arena.pickups.values()) {
    if (pk.type !== 'health' || !pk.active || !reachable(nav, bot, pk.pos[0], pk.pos[2])) continue;
    const d = distXZ(pk.pos, bot.pos);
    if (d < bestD) { bestD = d; best = pk; }
  }
  return best && { x: best.pos[0], z: best.pos[2], kind: 'health', id: best.id, direct: true, until: now + 12000 };
}

function pickGoal(game, bot, b, S, now) {
  const { nav, pickups } = game.arena;
  const wander = () => {
    const [x, z] = randomCell(nav, regionAt(nav, bot.pos[0], bot.pos[2]));
    return { x, z, kind: 'wander', until: now + 12000 };
  };
  if (b.forceWander) { b.forceWander = false; return wander(); }
  const quarry = b.mission === null ? null : game.players.get(b.mission);
  if (quarry && quarry.alive && reachable(nav, bot, quarry.pos[0], quarry.pos[2])) {
    return { x: quarry.pos[0], z: quarry.pos[2], kind: 'hunt', prey: quarry.id, until: now + 2000 };
  }

  if (bot.hp < bot.stats.maxHp * S.seekHealth) {
    const g = healthGoal(game, bot, now);
    if (g) return g;
  }
  for (const pk of pickups.values()) {
    if (pk.type === 'overprint' && pk.active && Math.random() < S.greed && reachable(nav, bot, pk.pos[0], pk.pos[2])) {
      return { x: pk.pos[0], z: pk.pos[2], kind: 'overprint', id: pk.id, direct: true, until: now + 15000 };
    }
  }
  // a hunt that merely timed out usually carries on (the prey moved; re-aim at where it is now)
  const r = b.goal?.kind === 'hunt' ? Math.random() * 0.6 : Math.random();
  if (r < S.hunt) {
    const prey = [...game.players.values()]
      .filter((q) => q !== bot && q.alive && reachable(nav, bot, q.pos[0], q.pos[2]))
      .map((q) => ({
        q,
        score: distXZ(q.pos, bot.pos) * rand(0.7, 1.3) * (q.id === b.goal?.prey ? 0.6 : 1) * (q.isBot ? 1 : HUMAN_PULL),
      }))
      .sort((a, c) => a.score - c.score);
    if (prey.length) {
      const { q } = prey[0];
      return { x: q.pos[0], z: q.pos[2], kind: 'hunt', prey: q.id, until: now + 2500 };
    }
  }
  if (r < S.hunt + 0.15) {
    const a = rand(0, Math.PI * 2), d = rand(4, 10);
    const i = nearestCell(nav, Math.cos(a) * d, Math.sin(a) * d);
    if (i >= 0) {
      const [x, z] = navCenter(nav, i);
      return { x, z, kind: 'wander', until: now + 10000 };
    }
  }
  return wander();
}

function goalDone(game, bot, g, now) {
  if (now > g.until) return true;
  if (g.id !== undefined && !game.arena.pickups.get(g.id)?.active) return true;
  if (g.kind === 'health' && bot.hp >= bot.stats.maxHp - 0.5) return true;
  if (g.kind === 'hunt' && !game.players.get(g.prey)?.alive) return true;
  return false;
}

function setGoal(b, g) {
  b.goal = g;
  b.path = null;
}

/** Unit wish direction along the current goal's path ([0,0] when there is nowhere to go this tick). */
function follow(game, bot, b, now) {
  const nav = game.arena.nav;
  const g = b.goal;
  const x = bot.pos[0], z = bot.pos[2];
  if (!b.path || b.pathGoal !== g || now >= b.repathAt) {
    b.path = findPath(nav, [x, z], [g.x, g.z]);
    b.pathI = 0;
    b.pathGoal = g;
    b.repathAt = now + rand(900, 1500);
    if (!b.path) {
      if (g.kind === 'approach' || g.kind === 'chase') b.cantReachUntil = now + 3000;   // fight from here instead
      b.goal = null;
      return [0, 0];
    }
  }
  while (b.pathI < b.path.length) {
    const wp = b.path[b.pathI];
    if (Math.hypot(wp[0] - x, wp[1] - z) > (b.pathI === b.path.length - 1 ? 0.5 : 0.8)) break;
    b.pathI++;
  }
  let tx, tz;
  if (b.pathI < b.path.length) {
    [tx, tz] = b.path[b.pathI];
  } else if (g.direct && Math.hypot(g.x - x, g.z - z) > 0.3) {
    tx = g.x; tz = g.z;                     // last leg off the grid (e.g. up the Overprint dais)
  } else {
    if (g.kind === 'chase') b.targetId = null;      // nobody here any more: give up the pursuit
    b.goal = null;
    return [0, 0];
  }
  const len = Math.hypot(tx - x, tz - z) || 1;
  return [(tx - x) / len, (tz - z) / len];
}

function steer(game, bot, b, S, now) {
  const t = targetOf(game, b);
  const hurt = bot.hp < bot.stats.maxHp * S.seekHealth;
  if (hurt && b.goal?.kind !== 'health') {
    const g = healthGoal(game, bot, now);
    if (g) setGoal(b, g);
  }
  const fleeing = b.goal?.kind === 'health' && !goalDone(game, bot, b.goal, now);

  if (t && b.visible && !fleeing) {
    const w = combatMove(game, bot, b, S, t, now);
    if (w) return w;
  } else if (t && !fleeing && b.goal?.kind !== 'chase' && now >= b.cantReachUntil) {
    setGoal(b, { x: b.lastSeenPos[0], z: b.lastSeenPos[2], kind: 'chase', until: now + S.memory * 1000 });
  }

  if (!b.goal || goalDone(game, bot, b.goal, now)) setGoal(b, pickGoal(game, bot, b, S, now));
  let w = follow(game, bot, b, now);
  if (!b.goal) {                            // arrived (or unreachable): pick the next errand right away
    setGoal(b, pickGoal(game, bot, b, S, now));
    w = follow(game, bot, b, now);
  }
  return w;
}

/** Fight footwork: close to the weapon's comfortable range, then strafe. Null → fall back to pathing. */
function combatMove(game, bot, b, S, t, now) {
  const nav = game.arena.nav;
  const x = bot.pos[0], z = bot.pos[2];
  const dx = t.pos[0] - x, dz = t.pos[2] - z;
  const d = Math.hypot(dx, dz) || 1;
  const fx = dx / d, fz = dz / d;
  const ideal = b.weapon === PUNCH ? 3.5 : b.weapon === MARKER ? 26 : S.range;

  if (now >= b.strafeUntil) {
    const still = b.strafe !== 0 && Math.random() > S.strafe;
    b.strafe = still ? 0 : (Math.random() < 0.5 ? -1 : 1);
    b.strafeUntil = now + (still ? rand(250, 600) : rand(500, 1500));
  }
  let fwd = d > ideal + 3 ? 1 : d < ideal - 3 ? -0.7 : 0;
  if (fwd === 1 && now < b.cantReachUntil) fwd = 0;
  if (fwd === 1 && !lineWalkable(nav, x, z, t.pos[0], t.pos[2])) {
    const g = b.goal;
    if (g?.kind !== 'approach' || Math.hypot(g.x - t.pos[0], g.z - t.pos[2]) > 3) {
      setGoal(b, { x: t.pos[0], z: t.pos[2], kind: 'approach', until: now + 2500 });
    }
    return null;
  }
  if (b.goal?.kind === 'approach') b.goal = null;

  const dirFor = (side) => {
    const wx = fx * fwd - fz * side, wz = fz * fwd + fx * side;
    const len = Math.hypot(wx, wz);
    return len > 1e-3 ? [wx / len, wz / len] : [0, 0];
  };
  const side = fwd === 1 ? b.strafe * 0.5 : b.strafe;
  let w = dirFor(side);
  if (!isWalkable(nav, x + w[0] * 1.3, z + w[1] * 1.3)) {
    b.strafe = -b.strafe || 1;
    w = dirFor(fwd === 1 ? b.strafe * 0.5 : b.strafe);
    if (!isWalkable(nav, x + w[0] * 1.3, z + w[1] * 1.3)) {
      w = isWalkable(nav, x + fx * fwd * 1.3, z + fz * fwd * 1.3) && fwd ? [fx * Math.sign(fwd), fz * Math.sign(fwd)] : null;
    }
  }
  return w;
}

// ───────────────────────────── movement ─────────────────────────────

function emit(game, bot, k) {
  game.broadcast({ t: 'ev', id: bot.id, k, p: rv(bot.pos) });
}

function move(game, bot, b, S, wish, now, dt) {
  const { world, map, nav } = game.arena;
  const stats = bot.stats;
  const r = bodyRadius(bot), h = bodyHeight(bot);
  const pos = bot.pos, vel = bot.vel;
  const wants = wish[0] !== 0 || wish[1] !== 0;
  const fighting = b.visible && b.targetId !== null;
  const speed = MOVE.speed * stats.moveSpeed * S.speed * (now < bot.slowUntil ? 0.55 : 1);

  // footwork decisions for this tick
  let jump = b.hopNow;
  b.hopNow = false;
  if (b.onGround && now >= b.jumpAt && wants) {
    if (b.blocked) { jump = true; b.jumpAt = now + 500; }
    else if (fighting && Math.random() < S.hop * dt) { jump = true; b.jumpAt = now + 900; }
  }
  if (fighting && wants && S.dash > 0 && now >= b.dashReadyAt && now - b.attackedAt < 400 && Math.random() < S.dash) {
    b.dashUntil = now + MOVE.dashTime * 1000;
    b.dashReadyAt = now + MOVE.dashCooldown * stats.dashCooldown * 1000 + rand(500, 2500);
    b.dashDir = wish.slice();
    emit(game, bot, 'dash');
  }

  b.blocked = false;
  const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
  const sdt = dt / steps;
  for (let s = 0; s < steps; s++) {
    if (now < b.dashUntil) {
      vel[0] = b.dashDir[0] * MOVE.dashSpeed;
      vel[2] = b.dashDir[1] * MOVE.dashSpeed;
    } else {
      const ax = wish[0] * speed - vel[0], az = wish[1] * speed - vel[2];
      const need = Math.hypot(ax, az);
      if (need > 1e-4) {
        const k = Math.min(1, ((b.onGround ? MOVE.accelGround * 0.7 : MOVE.accelAir * 0.5) * sdt) / need);
        vel[0] += ax * k;
        vel[2] += az * k;
      }
    }
    if (jump && b.onGround) {
      vel[1] = MOVE.jump * stats.jump;
      b.onGround = false;
      jump = false;
      emit(game, bot, 'jump');
    }
    vel[1] = Math.max(-MOVE.terminal, vel[1] - MOVE.gravity * stats.gravity * sdt);
    const falling = vel[1];
    const res = moveBody(world, pos, vel, r, h, sdt, { step: b.onGround ? MOVE.stepHeight : 0 });
    if (res.onGround && !b.onGround && falling < -9) emit(game, bot, 'land');
    b.onGround = res.onGround;
    if (res.wallX || res.wallZ) b.blocked = true;

    if (now - b.padAt > 400) {
      for (const pad of map.jumpPads) {
        if (pos[0] + r > pad.min[0] && pos[0] - r < pad.max[0] && pos[2] + r > pad.min[2] && pos[2] - r < pad.max[2]
          && pos[1] < pad.max[1] + 0.15 && pos[1] + h > pad.min[1]) {
          vel[0] = pad.vel[0]; vel[1] = pad.vel[1]; vel[2] = pad.vel[2];
          b.onGround = false;
          b.padAt = now;
          emit(game, bot, 'pad');
          break;
        }
      }
    }
  }

  // The rim is walled, but never trust geometry with a bot's life.
  const lim = map.size / 2 - r;
  pos[0] = clamp(pos[0], -lim, lim);
  pos[2] = clamp(pos[2], -lim, lim);
  if (pos[1] < -2) rescue(nav, bot, b);

  // Unstick: wanted to move for most of a second and went nowhere → hop, forget the errand, try elsewhere.
  if (wants) b.wantedMs += dt * 1000;
  if (now - b.stuckAt >= STUCK_WINDOW_MS) {
    const moved = Math.hypot(pos[0] - b.stuckPos[0], pos[2] - b.stuckPos[1]);
    if (b.wantedMs > STUCK_WINDOW_MS * 0.6 && moved < STUCK_MOVE) {
      b.stuckCount++;
      b.hopNow = true;
      b.goal = null;
      b.path = null;
      b.forceWander = true;
      b.strafe = -b.strafe || 1;
      if (b.stuckCount >= STUCK_RESCUE) { rescue(nav, bot, b); b.stuckCount = 0; }
    } else {
      b.stuckCount = 0;
    }
    b.stuckPos = [pos[0], pos[2]];
    b.stuckAt = now;
    b.wantedMs = 0;
  }
}

// Last resort: put the bot on the nearest walkable cell.
function rescue(nav, bot, b) {
  const i = nearestCell(nav, bot.pos[0], bot.pos[2], 40);
  const [x, z] = i >= 0 ? navCenter(nav, i) : [0, 0];
  bot.pos[0] = x; bot.pos[1] = 0.05; bot.pos[2] = z;
  bot.vel[0] = bot.vel[1] = bot.vel[2] = 0;
  b.path = null;
  b.rescues++;
}

function grabPickups(game, bot) {
  const mid = bot.pos[1] + bodyHeight(bot) / 2;
  for (const pk of game.arena.pickups.values()) {
    if (!pk.active || Math.abs(pk.pos[1] - mid) > 2.2 || distXZ(pk.pos, bot.pos) > GRAB_RADIUS) continue;
    takePickup(game, bot, pk);
  }
}

// ───────────────────────────── aim ─────────────────────────────

function aim(game, bot, b, S, now, dt) {
  const t = targetOf(game, b);
  let wantYaw = bot.yaw, wantPitch = 0;

  if (t && (b.visible || now - b.lastSeen < 700)) {
    const from = eye(bot);
    const to = !b.visible ? [b.lastSeenPos[0], b.lastSeenPos[1] + 0.9, b.lastSeenPos[2]]
      : b.aimHead ? [t.pos[0], t.pos[1] + PLAYER.headCenter * t.stats.scale, t.pos[2]] : chest(t);
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const flat = Math.hypot(dx, dz) || 1e-3;
    const d = Math.hypot(flat, dy);

    if (now >= b.errAt) {
      // how fast the target crosses our view, in rad/s
      const along = (t.vel[0] * dx + t.vel[1] * dy + t.vel[2] * dz) / d;
      const lateral = Math.sqrt(Math.max(0, t.vel[0] ** 2 + t.vel[1] ** 2 + t.vel[2] ** 2 - along * along));
      const settle = S.tight + (1 - S.tight) * Math.exp(-(now - b.seenSince) / 1000 / S.tau);
      const sigma = S.aim * settle + S.track * Math.min(2, lateral / d);
      b.errGoal = [gauss() * sigma, gauss() * sigma * 0.6];
      b.errAt = now + rand(160, 380);
    }
    const k = 1 - Math.exp(-8 * dt);
    b.err[0] += (b.errGoal[0] - b.err[0]) * k;
    b.err[1] += (b.errGoal[1] - b.err[1]) * k;

    wantYaw = Math.atan2(-dx, -dz) + b.err[0];
    wantPitch = Math.atan2(dy, flat) + b.err[1];
  } else {
    const sp = Math.hypot(bot.vel[0], bot.vel[2]);
    if (sp > 1.5) {
      wantYaw = Math.atan2(-bot.vel[0], -bot.vel[2]);
      b.scanYaw = wantYaw;
    } else {
      if (now >= b.scanAt) { b.scanYaw = bot.yaw + rand(-1.2, 1.2); b.scanAt = now + rand(900, 2200); }
      wantYaw = b.scanYaw;
    }
  }

  const maxStep = S.turn * dt, ease = Math.min(1, 14 * dt);
  const dYaw = angDiff(wantYaw, bot.yaw), dPitch = wantPitch - bot.pitch;
  bot.yaw = angDiff(bot.yaw + clamp(dYaw * ease, -maxStep, maxStep), 0);
  bot.pitch = clamp(bot.pitch + clamp(dPitch * ease, -maxStep, maxStep), -1.4, 1.4);
  b.aimOff = Math.abs(angDiff(wantYaw, bot.yaw)) + Math.abs(wantPitch - bot.pitch);
}

// ───────────────────────────── weapons ─────────────────────────────

function swap(b, w, now) {
  b.weapon = w;
  b.swapUntil = now + SWAP_MS;
  b.reloading = -1;
  b.charging = false;
  b.burstLeft = 0;
}

function startReload(bot, b, now) {
  b.reloading = b.weapon;
  b.reloadUntil = now + reloadTime(WEAPONS[b.weapon], bot.stats) * 1000;
  b.charging = false;
}

function chooseWeapon(game, bot, b, S, now) {
  const t = targetOf(game, b);
  if (!t || !b.visible || b.charging) return;
  if (b.lobPending) {
    if (now < b.lobPending) return;
    b.lobPending = 0;
  }
  const d = dist(bot.pos, t.pos);
  let want = d < 7 ? PUNCH : d > 26 && S.marker ? MARKER : STAPLER;
  if (b.mags[want] <= 0 && b.reloading !== want) {
    const alt = want === PUNCH ? STAPLER : d < 12 ? PUNCH : want;
    if (b.mags[alt] > 0) want = alt;
  }
  if (now >= b.lobAt) {
    b.lobAt = now + rand(3000, 7000);
    if (want !== PUNCH && d > 8 && d < 24 && b.mags[BLOTTER] > 0 && Math.random() < S.blotter) {
      want = BLOTTER;
      b.lobPending = now + 1500;
    }
  }
  if (want !== b.weapon) swap(b, want, now);
}

function shoot(game, bot, b, S, now) {
  if (b.reloading >= 0 && now >= b.reloadUntil) {
    b.mags[b.reloading] = magSize(WEAPONS[b.reloading], bot.stats);
    b.reloading = -1;
  }
  const w = WEAPONS[b.weapon];
  const t = targetOf(game, b);
  if (!t || !b.visible || now < b.reactAt) {
    b.charging = false;
    if (now - b.lastSeen > 1500 && b.reloading < 0 && b.mags[b.weapon] < magSize(w, bot.stats)) startReload(bot, b, now);
    // long quiet spell: assume the holstered weapons got topped up too
    if (now - b.lastSeen > 5000) b.mags = WEAPONS.map((x, i) => (i === b.reloading ? b.mags[i] : magSize(x, bot.stats)));
    return;
  }
  if (b.reloading >= 0 || now < b.swapUntil) return;
  if (b.mags[b.weapon] <= 0) { startReload(bot, b, now); return; }
  if (t.protectUntil > now) return;
  const lined = b.aimOff <= (b.weapon === PUNCH ? S.trigger * 1.5 : S.trigger);
  const interval = fireInterval(w, bot.stats) * 1000;

  if (w.kind === 'projectile') {
    if (now < b.nextShot || !lined) return;
    if (lob(game, bot, b, S, t)) b.nextShot = now + interval;
    b.lobPending = 0;
    return;
  }
  if (w.kind === 'charge') {
    const full = chargeTime(w, bot.stats) * 1000;
    if (!b.charging) {
      if (now < b.nextShot) return;
      b.charging = true;
      b.chargeFrom = now;
      b.chargeFor = full * rand(S.charge, 1);
      return;
    }
    if (now - b.chargeFrom < b.chargeFor || !lined) return;
    b.charging = false;
    fireHitscan(game, bot, b, w, clamp((now - b.chargeFrom) / full, 0, 1));
    b.nextShot = now + interval;
    return;
  }
  if (now < b.nextShot || !lined) return;
  if (b.weapon === STAPLER) {
    if (now < b.pauseUntil) return;
    if (b.burstLeft <= 0) b.burstLeft = randInt(S.burst[0], S.burst[1]);
    if (--b.burstLeft === 0) b.pauseUntil = now + rand(S.pause[0], S.pause[1]) * 1000;
  }
  fireHitscan(game, bot, b, w, 1);
  b.nextShot = now + interval * (w.auto ? 1 : rand(S.pump[0], S.pump[1]));
}

function fireHitscan(game, bot, b, w, charge) {
  const o = eye(bot);
  const moving = Math.hypot(bot.vel[0], bot.vel[2]) > 2;
  const spread = (w.spread + (moving ? w.spreadMove : 0)) * bot.stats.spread;
  const hits = [];
  for (let i = 0; i < w.pellets; i++) {
    const a = rand(0, Math.PI * 2), rr = Math.sqrt(Math.random()) * spread;
    const dir = yawPitchToDir(bot.yaw + Math.cos(a) * rr, bot.pitch + Math.sin(a) * rr);
    hits.push(tracePellet(game, bot, o, dir, w.range));
  }
  b.mags[w.id]--;
  handleFire(game, bot, { w: w.id, o, c: charge, hits });
}

/** One pellet against world + players, including Carbon Copy ricochets. Returns a protocol `hits` entry. */
function tracePellet(game, shooter, o, d, range) {
  const world = game.arena.world;
  const via = [];
  let from = o, dir = d, left = range;
  for (;;) {
    const wall = raycast(world, from, dir, left);
    let bestT = wall ? wall.t : left, victim = null, head = 0;
    for (const q of game.players.values()) {
      if (q === shooter || !q.alive) continue;
      const sc = q.stats.scale, r = PLAYER.radius * sc;
      const tall = ((q.flags & F.CROUCH) ? PLAYER.crouchHeight : PLAYER.height) * sc;
      const headY = q.pos[1] + tall - (PLAYER.height - PLAYER.headCenter) * sc;
      const tb = rayAABB(from, dir, [q.pos[0] - r, q.pos[1], q.pos[2] - r], [q.pos[0] + r, headY, q.pos[2] + r]);
      const th = raySphere(from, dir, [q.pos[0], headY, q.pos[2]], PLAYER.headRadius * sc * shooter.stats.headScale);
      const isHead = th >= 0 && (tb < 0 || th <= tb);
      const tq = isHead ? th : tb;
      if (tq >= 0 && tq < bestT) { bestT = tq; victim = q; head = isHead ? 1 : 0; }
    }
    const end = [from[0] + dir[0] * bestT, from[1] + dir[1] * bestT, from[2] + dir[2] * bestT];
    const hit = (extra) => (via.length ? { ...extra, via: via.slice() } : extra);
    if (victim) return hit({ e: end, n: null, id: victim.id, hs: head });
    if (!wall) return hit({ e: end, n: null, id: null, hs: 0 });
    if (via.length >= shooter.stats.bounce) return hit({ e: end, n: wall.normal, id: null, hs: 0 });
    via.push(end);
    left -= wall.t;
    from = [end[0] + wall.normal[0] * 0.02, end[1] + wall.normal[1] * 0.02, end[2] + wall.normal[2] * 0.02];
    dir = reflect(dir, wall.normal);
  }
}

/** Throw a Blotter bomb on a low ballistic arc at the target's feet. */
function lob(game, bot, b, S, t) {
  const w = WEAPONS[BLOTTER];
  const o = eye(bot);
  const dx = t.pos[0] + gauss() * S.lobErr - o[0], dz = t.pos[2] + gauss() * S.lobErr - o[2];
  const dy = t.pos[1] + 0.2 - o[1];
  const x = Math.hypot(dx, dz);
  const v2 = w.speed * w.speed, g = w.gravity;
  const disc = v2 * v2 - g * (g * x * x + 2 * dy * v2);
  if (x < 1 || disc < 0) return false;
  const theta = Math.atan2(v2 - Math.sqrt(disc), g * x);
  const hv = Math.cos(theta) * w.speed;
  const vel = [(dx / x) * hv, Math.sin(theta) * w.speed, (dz / x) * hv];
  const pid = ++b.pid;
  handleProj(game, bot, { pid, o, vel });
  if (!bot.bombs.has(pid)) return false;
  b.mags[BLOTTER]--;
  game.arena.bombs.push({ owner: bot, pid, pos: o.slice(), vel, bounces: w.bounces, age: 0 });
  return true;
}

/** Fly every bot-thrown bomb and detonate it through the same `boom` path humans use. */
export function stepBombs(game, dt) {
  const { world, bombs } = game.arena;
  if (!bombs.length) return;
  const w = WEAPONS[BLOTTER];
  const steps = Math.max(1, Math.round(dt / BOMB_STEP));
  const sdt = dt / steps;
  for (let i = bombs.length - 1; i >= 0; i--) {
    const bomb = bombs[i];
    let explode = game.players.get(bomb.owner.id) !== bomb.owner;      // thrower left the game: fizzle
    const orphan = explode;
    for (let s = 0; s < steps && !explode; s++) {
      explode = stepProjectile(world, bomb, w.gravity, sdt) === 'explode' || bomb.age >= w.fuse || touchesPlayer(game, bomb, w);
    }
    if (!explode) continue;
    bombs.splice(i, 1);
    if (orphan) continue;
    const reach = w.radius * bomb.owner.stats.splashRadius;
    const hits = [];
    for (const q of game.players.values()) {
      if (!q.alive) continue;
      const d = dist(bomb.pos, chest(q));
      if (d < reach) hits.push({ id: q.id, d });
    }
    handleBoom(game, bomb.owner, { pid: bomb.pid, p: bomb.pos, hits });
  }
}

function touchesPlayer(game, bomb, w) {
  for (const q of game.players.values()) {
    if (q === bomb.owner || !q.alive) continue;
    const r = bodyRadius(q) + w.projRadius;
    if (Math.abs(bomb.pos[0] - q.pos[0]) < r && Math.abs(bomb.pos[2] - q.pos[2]) < r
      && bomb.pos[1] > q.pos[1] - w.projRadius && bomb.pos[1] < q.pos[1] + bodyHeight(q) + w.projRadius) return true;
  }
  return false;
}

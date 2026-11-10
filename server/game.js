// The single game room: roster, host, settings, phase machine, draft, snapshots.
// Network-agnostic — it talks to "connections" ({ send(string, droppable), close() }) and reads time
// from an injectable clock, so tests can drive it at any speed. Everything timed is polled from
// step(); there are no timers to leak between rounds.
import {
  PROTOCOL_VERSION, TICK_HZ, MAX_PLAYERS, PHASE, TIMING, DEFAULT_SETTINGS, F,
} from '../shared/constants.js';
import { WEAPONS } from '../shared/weapons.js';
import { rollDraft } from '../shared/cards.js';
import { generateMap } from '../shared/mapgen.js';
import { createWorld } from '../shared/physics.js';
import { makeRng } from '../shared/rng.js';
import { clamp, isNum, vec3, rv, r2, r3, rand, pick, dist, cleanText, uniqueName } from './util.js';
import { createPlayer, setCards, rosterRow, hpWire, recordHistory, cleanColor, cleanFace } from './player.js';
import { buildBotNav, lineWalkable, regionAt, spreadPoints } from './nav.js';
import { handleFire, handleProj, handleBoom, handleFell, handleRewind, handlePickup } from './combat.js';
import { botIdentity, createBrain, resetBrain, updateBot, directBots, stepBombs, quip } from './bots.js';

const FAST_TIMING = { countdown: 1, roundEnd: 1.5, draft: 3, matchEnd: 3, respawn: 1, spawnProtect: TIMING.spawnProtect };

const SETTING_LIMITS = {
  killsToWin: [3, 30], roundTime: [60, 600], roundsToWin: [1, 9], bots: [0, 6], botSkill: [0, 2],
};
const LIVE = new Set([PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END]);   // an arena is on screen and players exist in it
const BOT_MODE = { [PHASE.COUNTDOWN]: 'frozen', [PHASE.PLAYING]: 'play', [PHASE.ROUND_END]: 'idle' };
const EV_KINDS = new Set(['dash', 'jump', 'walljump', 'land', 'pad', 'emote']);
const REGEN_DELAY_MS = 3000;
const DRAFT_BEAT_MS = 1500;          // pause after the last human picks
const DRAFT_SPECTATE_S = 4;          // draft length when no human has anything to pick
const PING_ROSTER_MS = 2000;
const PING_ROSTER_DELTA = 5;
const STALE_STATE_MS = 400;          // after a spawn, ignore `st` still describing the old life
const MIN_SPAWNS = 4;
const SPAWN_GAP = 1.4;               // m between players sharing a spawn point (maps can have fewer spawns than players)
const STATE_MASK = 0x1ff;            // every F bit a client may set (not DEAD)

/**
 * Some arenas have ground pockets sealed off from the rest. Nobody should start a life in one (bots
 * could never walk out, and a human there would have no one to play with), so only spawn points in
 * the main region are used — topped up with invented ones when too few are left.
 */
function usableSpawns(map, nav) {
  const connected = map.spawns.filter((s) => regionAt(nav, s.pos[0], s.pos[2]) === nav.main);
  if (connected.length >= MIN_SPAWNS) return connected;
  const extra = spreadPoints(nav, MIN_SPAWNS - connected.length, connected.map((s) => [s.pos[0], s.pos[2]]))
    .map(([x, z]) => ({ pos: [x, 0.05, z], yaw: Math.atan2(x, z) }));
  const spawns = [...connected, ...extra];
  return spawns.length ? spawns : map.spawns;
}

export class Game {
  constructor({ joinUrls = [], bots = DEFAULT_SETTINGS.bots, fast = false, now = Date.now, log = console.error } = {}) {
    this.now = now;
    this.log = log;
    this.timing = fast ? FAST_TIMING : TIMING;
    this.joinUrls = joinUrls;
    this.settings = { ...DEFAULT_SETTINGS, bots: clamp(Math.round(bots) || 0, ...SETTING_LIMITS.bots) };
    this.players = new Map();
    this.nextId = 1;
    this.hostId = null;

    this.phase = PHASE.LOBBY;
    this.roundNo = 0;
    this.endsAt = 0;
    this.arena = null;               // { seed, mapPlayers, map, world, nav, spawns, pickups, firstBlood, bombs }
    this.winnerId = null;
    this.standings = [];
    this.matchOver = false;
    this.draft = null;               // { picks: Map(id → { options, card, botAt }), closeAt }
    this.seedQueue = [];             // tests push seeds here to pin the next arenas

    this.rosterDirty = false;
    this.lastStep = now();
    this.pingRosterAt = 0;
    this.stepMs = 0;                 // cost of the last step(), for soak reports
    this.syncBots();
  }

  // ───────────────────────────── plumbing ─────────────────────────────

  humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  botList() { return [...this.players.values()].filter((p) => p.isBot); }

  send(p, msg) {
    if (p.conn) p.conn.send(JSON.stringify(msg), false);
  }

  /** To every human, optionally except one player. `droppable` messages may be skipped for congested sockets. */
  broadcast(msg, except = null, droppable = false) {
    let data = null;
    for (const p of this.players.values()) {
      if (!p.conn || p === except) continue;
      data ??= JSON.stringify(msg);
      p.conn.send(data, droppable);
    }
  }

  systemChat(text) { this.broadcast({ t: 'chat', system: true, text }); }

  rosterMsg() {
    return {
      t: 'roster', hostId: this.hostId, joinUrls: this.joinUrls, settings: { ...this.settings },
      players: [...this.players.values()].map(rosterRow),
    };
  }

  flushRoster() {
    if (!this.rosterDirty) return;
    this.rosterDirty = false;
    for (const p of this.players.values()) p.pingSent = p.ping;
    this.broadcast(this.rosterMsg());
  }

  phaseMsg() {
    const a = this.arena;
    const result = this.phase === PHASE.ROUND_END || this.phase === PHASE.MATCH_END;
    return {
      t: 'phase', phase: this.phase, round: this.roundNo, now: this.now(), endsAt: this.endsAt,
      seed: a ? a.seed : 0, mapPlayers: a ? a.mapPlayers : 0,
      pickups: a ? [...a.pickups.values()].map((k) => ({ id: k.id, active: k.active })) : [],
      winnerId: result ? this.winnerId : null,
      standings: result ? this.standings : [],
    };
  }

  setPhase(phase, seconds) {
    this.flushRoster();              // scores first, so a result screen never shows stale numbers
    this.phase = phase;
    this.endsAt = seconds ? this.now() + seconds * 1000 : 0;
    this.broadcast(this.phaseMsg());
  }

  spawnMsg(p) {
    return {
      t: 'spawn', id: p.id, p: rv(p.pos), yaw: r3(p.yaw), hp: hpWire(p),
      protect: r2(Math.max(0, p.protectUntil - this.now()) / 1000),
    };
  }

  // ───────────────────────────── connections ─────────────────────────────

  /** Wrap a transport. The caller feeds raw frames to receive() and calls disconnect() on close. */
  connect(transport) {
    return { send: transport.send, close: transport.close, player: null };
  }

  receive(conn, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try {
      this.dispatch(conn, m);
    } catch (err) {
      this.log(`[misprint] error handling "${m.t}":`, err);
    }
    this.flushRoster();
  }

  dispatch(conn, m) {
    const p = conn.player;
    if (!p) {
      if (m.t === 'hello') this.onHello(conn, m);
      else if (m.t === 'ping') conn.send(JSON.stringify({ t: 'pong', c: isNum(m.c) ? m.c : 0, s: this.now() }), false);
      return;
    }
    switch (m.t) {
      case 'st': this.onState(p, m); break;
      case 'fire': handleFire(this, p, m); break;
      case 'proj': handleProj(this, p, m); break;
      case 'boom': handleBoom(this, p, m); break;
      case 'pickup': handlePickup(this, p, m); break;
      case 'rewind': handleRewind(this, p, m); break;
      case 'fell': handleFell(this, p); break;
      case 'ping': this.send(p, { t: 'pong', c: isNum(m.c) ? m.c : 0, s: this.now() }); break;
      case 'ev': this.onEv(p, m); break;
      case 'chat': this.onChat(p, m); break;
      case 'pick': this.onPick(p, m.card); break;
      case 'hello':
      case 'profile': this.onProfile(p, m); break;
      case 'settings': this.onSettings(p, m); break;
      case 'start': this.onStart(p); break;
      default:
    }
  }

  onHello(conn, m) {
    const refuse = (msg) => {
      conn.send(JSON.stringify({ t: 'error', msg }), false);
      conn.close();
    };
    if (m.v !== PROTOCOL_VERSION) {
      refuse(`Version mismatch (server v${PROTOCOL_VERSION}, you v${isNum(m.v) ? m.v : '?'}). Refresh the page.`);
      return;
    }
    if (this.humans().length >= MAX_PLAYERS) { refuse('Server full.'); return; }
    while (this.players.size >= MAX_PLAYERS) this.removeBot();        // humans outrank bots

    const taken = [...this.players.values()].map((q) => q.name);
    const p = createPlayer(this.nextId++, { name: uniqueName(m.name, taken), color: m.color, face: m.face, conn });
    conn.player = p;
    this.players.set(p.id, p);
    if (this.hostId === null) this.hostId = p.id;

    const now = this.now();
    this.send(p, { t: 'welcome', id: p.id, now, v: PROTOCOL_VERSION });
    this.rosterDirty = true;
    this.flushRoster();
    this.send(p, this.phaseMsg());
    if (LIVE.has(this.phase)) {
      for (const q of this.players.values()) {
        if (!q.alive) continue;
        this.send(p, this.spawnMsg(q));
        if (q.overprintUntil > now) this.send(p, { t: 'buff', id: q.id, type: 'overprint', until: q.overprintUntil });
      }
    }
    if (this.phase === PHASE.COUNTDOWN) this.spawnPlayer(p);
    else if (this.phase === PHASE.PLAYING) p.respawnAt = now + this.timing.respawn * 1000;
    else if (this.phase === PHASE.DRAFT) this.offerDraft(p, 0.8);
    this.systemChat(`${p.name} clocked in.`);
  }

  disconnect(conn) {
    const p = conn.player;
    if (!p) return;
    conn.player = null;
    this.players.delete(p.id);
    this.rosterDirty = true;
    const humans = this.humans();
    if (!humans.length) {
      this.hostId = null;
      this.resetToLobby(true);
      return;
    }
    this.systemChat(`${p.name} clocked out.`);
    if (this.hostId === p.id) {
      const next = humans.reduce((a, c) => (c.id < a.id ? c : a));
      this.hostId = next.id;
      this.systemChat(`${next.name} is now the host.`);
    }
    if (this.phase === PHASE.LOBBY) this.syncBots();
    if (this.draft) { this.draft.picks.delete(p.id); this.checkDraftDone(); }
    this.flushRoster();
  }

  /** Round-trip time measured by the transport (server.js heartbeat). */
  setPing(conn, ms) {
    const p = conn.player;
    if (p) p.ping = Math.round(p.ping ? p.ping * 0.6 + ms * 0.4 : ms);
  }

  // ───────────────────────────── lobby ─────────────────────────────

  addBot() {
    const bot = createPlayer(this.nextId++, { ...botIdentity(this.players), brain: createBrain() });
    this.players.set(bot.id, bot);
    this.rosterDirty = true;
    return bot;
  }

  removeBot() {
    const bots = this.botList();
    if (!bots.length) return false;
    const bot = bots[bots.length - 1];
    this.players.delete(bot.id);
    if (this.draft) this.draft.picks.delete(bot.id);
    this.rosterDirty = true;
    return true;
  }

  /** Lobby only: make the bot count match the setting (as far as MAX_PLAYERS allows). */
  syncBots() {
    const want = Math.min(this.settings.bots, MAX_PLAYERS - this.humans().length);
    while (this.botList().length > want) this.removeBot();
    while (this.botList().length < want) this.addBot();
  }

  onProfile(p, m) {
    if (m.name !== undefined) {
      const taken = [...this.players.values()].filter((q) => q !== p).map((q) => q.name);
      p.name = uniqueName(m.name, taken);
    }
    if (m.color !== undefined) p.color = cleanColor(m.color);
    if (m.face !== undefined) p.face = cleanFace(m.face);
    this.rosterDirty = true;
  }

  onSettings(p, m) {
    if (p.id !== this.hostId || this.phase !== PHASE.LOBBY) return;
    const patch = m.settings;
    if (!patch || typeof patch !== 'object') return;
    for (const [key, [lo, hi]] of Object.entries(SETTING_LIMITS)) {
      if (isNum(patch[key])) this.settings[key] = clamp(Math.round(patch[key]), lo, hi);
    }
    this.settings.bots = Math.min(this.settings.bots, MAX_PLAYERS - this.humans().length);
    this.syncBots();
    this.rosterDirty = true;
  }

  onStart(p) {
    if (p.id !== this.hostId || this.phase !== PHASE.LOBBY) return;
    this.syncBots();
    for (const q of this.players.values()) { q.wins = 0; setCards(q, []); }
    this.roundNo = 0;
    this.startCountdown();
  }

  resetToLobby(empty = false) {
    for (const q of this.players.values()) {
      q.wins = 0; q.kills = 0; q.deaths = 0; q.streak = 0; q.alive = false;
      setCards(q, []);
    }
    this.draft = null;
    this.winnerId = null;
    this.standings = [];
    this.matchOver = false;
    this.roundNo = 0;
    if (empty) this.arena = null;
    this.rosterDirty = true;
    this.setPhase(PHASE.LOBBY, 0);
    this.syncBots();
    this.flushRoster();
  }

  // ───────────────────────────── rounds ─────────────────────────────

  nextSeed() {
    if (this.seedQueue.length) return this.seedQueue.shift() >>> 0;
    for (;;) {
      const seed = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
      if (!this.arena || seed !== this.arena.seed) return seed;
    }
  }

  startCountdown() {
    this.roundNo++;
    this.draft = null;
    const seed = this.nextSeed();
    const mapPlayers = this.players.size;
    const map = generateMap(seed, mapPlayers);
    const world = createWorld(map);
    const nav = buildBotNav(map, world);
    this.arena = {
      seed, mapPlayers, map, world, nav,
      spawns: usableSpawns(map, nav),
      pickups: new Map(map.pickups.map((k) => [k.id, { id: k.id, type: k.type, pos: k.pos, respawn: k.respawn, active: true, respawnAt: 0 }])),
      firstBlood: false,
      bombs: [],                     // bot-thrown Blotter bombs in flight
    };
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.streak = 0; p.lastKillAt = 0;
      p.alive = false; p.respawnAt = 0; p.overprintUntil = 0;
      p.bombs.clear();
    }
    this.setPhase(PHASE.COUNTDOWN, this.timing.countdown);
    const order = [...this.players.values()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const p of order) this.spawnPlayer(p);
  }

  startPlaying() {
    const protectUntil = this.now() + this.timing.spawnProtect * 1000;
    for (const p of this.players.values()) if (p.alive) p.protectUntil = protectUntil;
    this.setPhase(PHASE.PLAYING, this.settings.roundTime);
  }

  /** Farthest spawn point from every living opponent; random among equals. */
  chooseSpawn(p) {
    const foes = [...this.players.values()].filter((q) => q !== p && q.alive);
    const scored = this.arena.spawns.map((s) => ({ s, d: Math.min(1e9, ...foes.map((q) => dist(s.pos, q.pos))) }));
    const best = Math.max(...scored.map((x) => x.d));
    return pick(scored.filter((x) => x.d >= best - 0.01)).s;
  }

  /** Feet position at (or, if someone is standing there, right next to) a spawn point. */
  freeSpot(p, spawn) {
    const others = [...this.players.values()].filter((q) => q !== p && q.alive);
    const crowded = (x, z) => others.some((q) => Math.hypot(q.pos[0] - x, q.pos[2] - z) < SPAWN_GAP);
    const [sx, sy, sz] = spawn.pos;
    if (!crowded(sx, sz)) return [sx, sy, sz];
    const nav = this.arena.nav;
    let best = null, bestD = Infinity;
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = sx + dx, z = sz + dz, d = Math.hypot(dx, dz);
        if (d >= bestD || crowded(x, z) || !lineWalkable(nav, sx, sz, x, z)) continue;
        best = [x, sy, z];
        bestD = d;
      }
    }
    return best || [sx, sy, sz];
  }

  spawnPlayer(p) {
    const now = this.now();
    const s = this.chooseSpawn(p);
    p.alive = true;
    p.hp = p.stats.maxHp;
    p.pos = this.freeSpot(p, s);
    p.vel = [0, 0, 0];
    p.yaw = s.yaw;
    p.pitch = 0;
    p.flags = F.GROUND;
    p.weapon = 0;
    p.respawnAt = 0;
    p.spawnedAt = now;
    p.secondDraftUsed = false;
    p.lastDamageAt = 0;
    p.slowUntil = 0;
    p.overprintUntil = 0;
    p.lastRewindAt = 0;
    p.botContactAt = now;
    p.nextFire.fill(0);
    p.history = [];
    p.historyAt = 0;
    const frozen = this.phase === PHASE.COUNTDOWN ? Math.max(0, this.endsAt - now) : 0;
    p.protectUntil = now + frozen + this.timing.spawnProtect * 1000;
    if (p.brain) resetBrain(p, now);
    this.broadcast(this.spawnMsg(p));
    this.rosterDirty = true;
  }

  /** Round ranking: most kills, then fewest deaths, then whoever reached their score first. */
  ranking() {
    return [...this.players.values()].sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths)
      || ((a.lastKillAt || Infinity) - (b.lastKillAt || Infinity)) || (a.id - b.id));
  }

  endRound() {
    if (this.phase !== PHASE.PLAYING) return;
    const order = this.ranking();
    const winner = order[0];
    winner.wins++;
    this.winnerId = winner.id;
    this.standings = order.map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths, wins: p.wins }));
    this.matchOver = winner.wins >= this.settings.roundsToWin;
    this.arena.bombs.length = 0;
    for (const p of this.players.values()) p.bombs.clear();
    this.rosterDirty = true;
    this.setPhase(PHASE.ROUND_END, this.timing.roundEnd);
  }

  startMatchEnd() {
    for (const p of this.players.values()) p.alive = false;
    const order = [...this.players.values()].sort((a, b) => (b.wins - a.wins) || (b.kills - a.kills) || (a.id - b.id));
    if (!this.players.has(this.winnerId) && order.length) this.winnerId = order[0].id;
    this.standings = order.map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths, wins: p.wins }));
    this.rosterDirty = true;
    this.setPhase(PHASE.MATCH_END, this.timing.matchEnd);
  }

  afterKill(killer) {
    if (killer && killer.brain) quip(this, killer);
  }

  // ───────────────────────────── draft ─────────────────────────────

  startDraft() {
    for (const p of this.players.values()) p.alive = false;
    const rng = makeRng((this.arena.seed ^ Math.imul(this.roundNo, 0x9e3779b1)) >>> 0);
    const order = [...this.players.values()].sort((a, b) => (b.wins - a.wins) || (b.kills - a.kills) || (a.deaths - b.deaths));
    const drafters = order.filter((p) => p.id !== this.winnerId);
    const humansPick = drafters.some((p) => !p.isBot);
    const seconds = humansPick ? this.timing.draft : Math.min(this.timing.draft, DRAFT_SPECTATE_S);
    this.draft = { picks: new Map(), closeAt: 0, rng };
    this.rosterDirty = true;
    this.setPhase(PHASE.DRAFT, seconds);

    order.forEach((p, rank) => {
      if (p.id === this.winnerId) {
        this.send(p, { t: 'draft', options: [], isWinner: true });
        return;
      }
      // further behind → luckier draws
      this.offerDraft(p, order.length > 1 ? (0.8 * rank) / (order.length - 1) : 0);
    });
  }

  offerDraft(p, luck) {
    const now = this.now();
    const options = rollDraft(this.draft.rng, p.cards, 3, luck);
    const latest = Math.max(now + 600, this.endsAt - 700);
    this.draft.picks.set(p.id, {
      options, card: options.length ? null : '',
      botAt: p.isBot ? rand(Math.min(now + 600, latest), latest) : 0,
    });
    this.draft.closeAt = 0;
    this.send(p, { t: 'draft', options, isWinner: false });
  }

  onPick(p, card) {
    if (this.phase !== PHASE.DRAFT || !this.draft) return;
    const entry = this.draft.picks.get(p.id);
    if (!entry || entry.card !== null || !entry.options.includes(card)) return;
    entry.card = card;
    setCards(p, [...p.cards, card]);
    this.broadcast({ t: 'picked', id: p.id, card });
    this.rosterDirty = true;
    this.checkDraftDone();
  }

  /** Once no human is still choosing, close the draft after a short beat. */
  checkDraftDone() {
    const d = this.draft;
    if (!d || d.closeAt) return;
    let humansHadChoice = false;
    for (const [id, entry] of d.picks) {
      const p = this.players.get(id);
      if (!p || p.isBot) continue;
      humansHadChoice = true;
      if (entry.card === null) return;
    }
    if (humansHadChoice) d.closeAt = Math.min(this.endsAt, this.now() + DRAFT_BEAT_MS);
  }

  finishDraft() {
    for (const [id, entry] of this.draft.picks) {
      const p = this.players.get(id);
      if (p && entry.card === null) this.onPick(p, pick(entry.options));
    }
    this.draft = null;
    this.startCountdown();
  }

  // ───────────────────────────── per-message handlers ─────────────────────────────

  onState(p, m) {
    if (!p.alive || !LIVE.has(this.phase)) return;
    const pos = vec3(m.p);
    if (!pos || !isNum(m.yaw) || !isNum(m.pitch)) return;
    if (this.now() - p.spawnedAt < STALE_STATE_MS && dist(pos, p.pos) > 6) return;
    const { map } = this.arena;
    const lim = map.size / 2 + 6;
    pos[0] = clamp(pos[0], -lim, lim);
    pos[1] = clamp(pos[1], map.killY - 20, 300);
    pos[2] = clamp(pos[2], -lim, lim);
    p.pos = pos;
    p.vel = vec3(m.v, 500) || [0, 0, 0];
    p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
    p.pitch = clamp(m.pitch, -1.6, 1.6);
    p.flags = (isNum(m.f) ? m.f : 0) & STATE_MASK;
    if (Number.isInteger(m.w) && WEAPONS[m.w]) p.weapon = m.w;
  }

  onEv(p, m) {
    if (!EV_KINDS.has(m.k) || !p.evLimit(this.now())) return;
    const out = { t: 'ev', id: p.id, k: m.k };
    let extras = 0;
    for (const [key, val] of Object.entries(m)) {
      if (key === 't' || key === 'k' || key === 'id' || ++extras > 6) continue;
      if (isNum(val) || typeof val === 'boolean') out[key] = val;
      else if (typeof val === 'string') out[key] = cleanText(val, 24);
      else { const v = vec3(val); if (v) out[key] = rv(v); }
    }
    this.broadcast(out, p);
  }

  onChat(p, m) {
    const text = cleanText(m.text, 140);
    if (!text || !p.chatLimit(this.now())) return;
    this.broadcast({ t: 'chat', id: p.id, name: p.name, color: p.color, text });
  }

  // ───────────────────────────── simulation ─────────────────────────────

  step() {
    const started = performance.now();
    const now = this.now();
    const dt = clamp((now - this.lastStep) / 1000, 0, 0.25);
    this.lastStep = now;
    try {
      this.advance(now, dt);
    } catch (err) {
      this.log('[misprint] error in tick:', err);
    }
    this.flushRoster();
    this.stepMs = performance.now() - started;
  }

  advance(now, dt) {
    if (this.endsAt && now >= this.endsAt) this.onPhaseTimeout();

    if (this.phase === PHASE.PLAYING) {
      for (const p of this.players.values()) {
        if (!p.alive) {
          if (p.respawnAt && now >= p.respawnAt) this.spawnPlayer(p);
          continue;
        }
        if (p.stats.regen > 0 && p.hp < p.stats.maxHp && now - p.lastDamageAt >= REGEN_DELAY_MS) {
          p.hp = Math.min(p.stats.maxHp, p.hp + p.stats.regen * dt);
        }
        recordHistory(p, now);
      }
      for (const pk of this.arena.pickups.values()) {
        if (pk.active || now < pk.respawnAt) continue;
        pk.active = true;
        this.broadcast({ t: 'pk', id: pk.id, active: true, by: null });
      }
    } else if (this.phase === PHASE.DRAFT && this.draft) {
      for (const [id, entry] of this.draft.picks) {
        const p = this.players.get(id);
        if (p && p.isBot && entry.card === null && now >= entry.botAt) this.onPick(p, pick(entry.options));
      }
      if (this.draft.closeAt && now >= this.draft.closeAt) this.finishDraft();
    }

    if (LIVE.has(this.phase)) {
      if (this.phase === PHASE.PLAYING) directBots(this, now);
      // a bot's shot can end the round mid-loop, so the mode is re-read for every bot
      for (const p of [...this.players.values()]) {
        if (p.brain && p.alive) updateBot(this, p, now, dt, BOT_MODE[this.phase]);
      }
      if (this.phase === PHASE.PLAYING) stepBombs(this, dt);
      this.sendSnapshot(now);
    }

    if (now - this.pingRosterAt >= PING_ROSTER_MS) {
      this.pingRosterAt = now;
      for (const p of this.players.values()) {
        if (p.conn && Math.abs(p.ping - (p.pingSent ?? 0)) >= PING_ROSTER_DELTA) this.rosterDirty = true;
      }
    }
  }

  onPhaseTimeout() {
    switch (this.phase) {
      case PHASE.COUNTDOWN: this.startPlaying(); break;
      case PHASE.PLAYING: this.endRound(); break;
      case PHASE.ROUND_END: if (this.matchOver) this.startMatchEnd(); else this.startDraft(); break;
      case PHASE.DRAFT: this.finishDraft(); break;
      case PHASE.MATCH_END: this.resetToLobby(); break;
      default: this.endsAt = 0;
    }
  }

  sendSnapshot(now) {
    const ps = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      ps.push([p.id, r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2]), r3(p.yaw), r3(p.pitch), p.flags, p.weapon, hpWire(p)]);
    }
    this.broadcast({ t: 'snap', now, ps }, null, true);
  }
}

export const TICK_MS = 1000 / TICK_HZ;

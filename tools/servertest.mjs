// End-to-end protocol test: boots the real server (port 3101, --fast) and drives it with scripted
// WebSocket clients that speak SPEC §4.
//   node tools/servertest.mjs [--only combat|flow|bots] [--verbose]
// Companions: servertest-cards.mjs (card effects, simulated clock), servertest-soak.mjs (bot soak).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { generateMap } from '../shared/mapgen.js';
import { computeStats, CARD_BY_ID } from '../shared/cards.js';
import { PROTOCOL_VERSION } from '../shared/constants.js';

const PORT = 3101;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const verbose = process.argv.includes('--verbose');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let suite = '';
function check(name, ok, detail = '') {
  results.push({ suite, name, ok: !!ok });
  if (!ok || verbose) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return !!ok;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ───────────────────────────── server process ─────────────────────────────

async function startServer(extra = []) {
  const child = spawn(process.execPath, ['server.js', '--port', String(PORT), '--fast', ...extra], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv = { child, out: '', err: '' };
  child.stdout.on('data', (d) => { srv.out += d; });
  child.stderr.on('data', (d) => { srv.err += d; });
  for (let i = 0; i < 100 && !srv.out.includes(`localhost:${PORT}`); i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${srv.out}\n${srv.err}`);
    await sleep(50);
  }
  if (!srv.out.includes(`localhost:${PORT}`)) throw new Error('server did not print its banner');
  return srv;
}

async function stopServer(srv) {
  check('server process still alive at the end', srv.child.exitCode === null, `exit code ${srv.child.exitCode}`);
  check('server logged no errors', srv.err.trim() === '', srv.err.trim().slice(0, 400));
  srv.child.kill('SIGTERM');
  for (let i = 0; i < 40 && srv.child.exitCode === null && srv.child.signalCode === null; i++) await sleep(50);
  if (srv.child.exitCode === null && srv.child.signalCode === null) srv.child.kill('SIGKILL');
  await sleep(100);
}

// ───────────────────────────── scripted client ─────────────────────────────

class Client {
  constructor(label) {
    this.label = label;
    this.log = [];             // every message except snapshots
    this.waiters = [];
    this.rows = new Map();     // latest snapshot rows by player id
    this.snaps = 0;
    this.id = null;
    this.roster = null;
    this.phase = null;
    this.closed = false;
    this.protect = new Map();  // player id → local ms when spawn protection ends
  }

  async open(hello) {
    this.ws = new WebSocket(WS_URL);
    this.ws.on('message', (data) => this.onMessage(JSON.parse(data.toString())));
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('error', () => {});
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    if (hello) this.send({ t: 'hello', v: PROTOCOL_VERSION, color: 0, face: 0, ...hello });
    return this;
  }

  static async join(label, hello = {}) {
    const c = await new Client(label).open({ name: label, ...hello });
    const welcome = await c.waitFor((m) => m.t === 'welcome', { from: 0 });
    c.id = welcome.id;
    await c.waitFor((m) => m.t === 'phase', { from: 0 });
    return c;
  }

  onMessage(m) {
    if (m.t === 'snap') {
      this.snaps++;
      this.rows = new Map(m.ps.map((r) => [r[0], r]));
      this.snapNow = m.now;
      return;
    }
    if (m.t === 'roster') this.roster = m;
    else if (m.t === 'phase') this.phase = m;
    else if (m.t === 'spawn') this.protect.set(m.id, Date.now() + m.protect * 1000);
    this.log.push(m);
    this.waiters = this.waiters.filter((w) => {
      if (!w.pred(m)) return true;
      clearTimeout(w.timer);
      w.resolve(m);
      return false;
    });
  }

  send(m) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  mark() { return this.log.length; }
  since(mark, pred) { return this.log.slice(mark).filter(pred); }
  me() { return this.roster?.players.find((p) => p.id === this.id); }
  player(id) { return this.roster?.players.find((p) => p.id === id); }
  pos(id = this.id) { const r = this.rows.get(id); return r ? [r[1], r[2], r[3]] : null; }
  hp(id = this.id) { const r = this.rows.get(id); return r ? r[8] : 0; }

  /** Resolves with the first message matching `pred` at or after log index `from` (default: from now on). */
  waitFor(pred, { ms = 4000, from = this.log.length, what = '' } = {}) {
    const hit = this.log.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`${this.label}: timed out after ${ms} ms waiting for ${what || pred}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  waitPhase(phase, ms = 8000, from = this.log.length) {
    return this.waitFor((m) => m.t === 'phase' && m.phase === phase, { ms, from, what: `phase ${phase}` });
  }

  state(p, w = 0) { this.send({ t: 'st', p, yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w }); }

  /** Stand 2 m from the target (as last seen in a snapshot) and claim `pellets` hits on it. */
  shoot(targetId, { w = 0, hs = 0, pellets = 1, from = null, end = null, c = 1 } = {}) {
    const tp = this.pos(targetId);
    if (!tp) return false;
    const my = from || [tp[0] + 2, tp[1], tp[2]];
    this.state(my, w);
    const e = end || [tp[0], tp[1] + 1.2, tp[2]];
    this.send({ t: 'fire', w, o: [my[0], my[1] + 1.62, my[2]], c, hits: Array.from({ length: pellets }, () => ({ e, n: null, id: targetId, hs })) });
    return true;
  }

  close() { this.ws.close(); }
}

const hitOn = (id) => (m) => m.t === 'hit' && m.to === id;

async function expectNone(client, mark, pred, ms = 250) {
  await sleep(ms);
  return client.since(mark, pred).length === 0;
}

// ───────────────────────────── suite 1: protocol + combat validation ─────────────────────────────

async function suiteCombat() {
  suite = 'combat';
  console.log('\n[1/3] protocol + combat validation (3 humans, no bots)');
  const srv = await startServer(['--bots', '0']);
  try {
    // static files
    const index = await fetch(`${HTTP}/`);
    check('GET / serves public/index.html', index.status === 200 && (index.headers.get('content-type') || '').startsWith('text/html'));
    check('cache-control: no-cache', index.headers.get('cache-control') === 'no-cache');
    const shared = await fetch(`${HTTP}/shared/constants.js`);
    check('GET /shared/… serves shared modules as javascript', shared.status === 200 && (shared.headers.get('content-type') || '').includes('javascript'));
    const font = await fetch(`${HTTP}/fonts/dm-mono-latin-400-normal.woff2`);
    check('woff2 MIME type', font.headers.get('content-type') === 'font/woff2');
    const sneaky = await Promise.all(['/%2e%2e/package.json', '/shared/%2e%2e/%2e%2e/package.json', '/..%2fserver.js', '/shared/..%5cserver.js']
      .map((u) => fetch(HTTP + u).then((r) => r.status)));
    check('path traversal is refused', sneaky.every((s) => s === 403 || s === 404), sneaky);
    check('banner mentions LAN sharing + tunnel tip', /Wi-Fi/.test(srv.out) && /cloudflared/.test(srv.out));

    // hello / roster / names
    const A = await Client.join('Alice', { name: '  Al\u0007ice \n the   Magnificent!! ', color: 3, face: 2 });
    check('welcome carries id, now, v', Number.isInteger(A.id) && near(A.log[0].now, Date.now(), 2000) && A.log[0].v === PROTOCOL_VERSION, A.log[0]);
    check('welcome → roster → phase order', A.log[0].t === 'welcome' && A.log[1].t === 'roster' && A.log.find((m) => m.t === 'phase') && A.log.findIndex((m) => m.t === 'roster') < A.log.findIndex((m) => m.t === 'phase'));
    check('name sanitized (trimmed, no control chars, ≤14)', A.me().name === 'Al ice the Mag', A.me().name);
    check('first human is host', A.roster.hostId === A.id);
    check('roster.joinUrls is a non-empty list of http URLs', Array.isArray(A.roster.joinUrls) && A.roster.joinUrls.length > 0 && A.roster.joinUrls.every((u) => /^http:\/\/.+:3101$/.test(u)), A.roster.joinUrls);
    check('lobby phase has endsAt 0', A.phase.phase === 'lobby' && A.phase.endsAt === 0, A.phase);
    check('roster rows have every SPEC field', ['id', 'name', 'color', 'face', 'isBot', 'wins', 'kills', 'deaths', 'ping', 'cards', 'alive'].every((k) => k in A.me()), A.me());

    const old = await new Client('old').open({ name: 'Old', v: 999 });
    const refusal = await old.waitFor((m) => m.t === 'error', { from: 0 });
    await sleep(300);
    check('protocol version mismatch → error + close', typeof refusal.msg === 'string' && old.closed, refusal);

    const B = await Client.join('Bob', { name: 'al ice THE mag' });
    const C = await Client.join('Cee', { name: '' });
    await sleep(100);
    check('duplicate name gets a suffix', B.me().name !== A.me().name && B.me().name.length <= 14 && /2$/.test(B.me().name), B.me().name);
    check('empty name gets a default', C.me().name.length > 0, C.me().name);
    check('everyone sees 3 players', [A, B, C].every((c) => c.roster.players.length === 3));

    // settings + lobby authority
    let mark = A.mark();
    B.send({ t: 'settings', settings: { killsToWin: 20 } });
    B.send({ t: 'start' });
    check('non-host cannot change settings or start', await expectNone(A, mark, (m) => m.t === 'phase' || (m.t === 'roster' && m.settings.killsToWin === 20), 300));
    A.send({ t: 'settings', settings: { killsToWin: 1, roundTime: 99999, roundsToWin: 0, bots: 99, botSkill: 7, bogus: 1 } });
    let r = await A.waitFor((m) => m.t === 'roster' && m.settings.roundTime === 600);
    check('settings are clamped', r.settings.killsToWin === 3 && r.settings.roundsToWin === 1 && r.settings.botSkill === 2 && r.settings.bots === 6 && !('bogus' in r.settings), r.settings);
    check('bots fill the lobby (and never exceed MAX_PLAYERS)', r.players.filter((p) => p.isBot).length === 6 && r.players.length === 9, r.players.length);
    A.send({ t: 'settings', settings: { killsToWin: 3, roundTime: 60, roundsToWin: 1, bots: 0, botSkill: 1 } });
    r = await A.waitFor((m) => m.t === 'roster' && m.settings.bots === 0);
    check('bots removed when the setting drops to 0', r.players.length === 3);

    // profile / chat / ev / ping / garbage
    C.send({ t: 'profile', name: 'Cee', color: 5, face: 4 });
    r = await A.waitFor((m) => m.t === 'roster' && m.players.some((p) => p.name === 'Cee'));
    check('profile updates name/color/face', r.players.find((p) => p.id === C.id).color === 5 && r.players.find((p) => p.id === C.id).face === 4);
    mark = B.mark();
    A.send({ t: 'chat', text: `  hi\u0000 there ${'x'.repeat(300)}` });
    const chat = await B.waitFor((m) => m.t === 'chat' && m.id === A.id, { from: mark });
    check('chat relayed with id/name/color, sanitized, ≤140', chat.text.startsWith('hi there x') && chat.text.length === 140 && chat.name === A.me().name && chat.color === 3, chat);
    mark = B.mark();
    for (let i = 0; i < 12; i++) A.send({ t: 'chat', text: `spam ${i}` });
    await sleep(300);
    const spam = B.since(mark, (m) => m.t === 'chat' && m.id === A.id).length;
    check('chat is rate limited', spam >= 1 && spam <= 5, spam);
    mark = B.mark(); const markA = A.mark();
    A.send({ t: 'ev', k: 'emote', e: 3, p: [1, 2, 3] });
    A.send({ t: 'ev', k: 'selfdestruct' });
    const ev = await B.waitFor((m) => m.t === 'ev', { from: mark });
    await sleep(100);
    check('ev relayed to others with id + extra fields', ev.id === A.id && ev.k === 'emote' && ev.e === 3 && ev.p.join() === '1,2,3', ev);
    check('ev not echoed to sender; unknown kinds dropped', A.since(markA, (m) => m.t === 'ev').length === 0 && B.since(mark, (m) => m.t === 'ev').length === 1);
    A.send({ t: 'ping', c: 4242 });
    const pong = await A.waitFor((m) => m.t === 'pong');
    check('ping → pong { c, s }', pong.c === 4242 && near(pong.s, Date.now(), 2000), pong);
    A.send('{not json');
    A.send(JSON.stringify([1, 2]));
    A.send({ t: 'warp-drive', engage: true });
    A.send({ t: 'fire' });
    A.send({ t: 'st', p: 'nope' });
    A.send({ t: 'pick', card: 'typo' });
    A.send({ t: 'boom', pid: {}, p: [NaN] });
    A.send({ t: 'pickup', id: 0 });
    A.send({ t: 'ping', c: 1 });
    await A.waitFor((m) => m.t === 'pong' && m.c === 1);
    check('garbage and out-of-phase messages are ignored', true);

    // countdown
    mark = B.mark();
    const mA = A.mark();
    A.send({ t: 'start' });
    const cd = await B.waitPhase('countdown', 3000, mark);
    check('countdown phase: seed, mapPlayers, endsAt ≈ +1s (fast)', cd.seed > 0 && cd.mapPlayers === 3 && near(cd.endsAt - cd.now, 1000, 60) && cd.round === 1, cd);
    const map = generateMap(cd.seed, cd.mapPlayers);
    check('phase.pickups lists every map pickup as active', cd.pickups.length === map.pickups.length && cd.pickups.every((k) => k.active === true), cd.pickups);
    await sleep(150);
    const spawns = B.since(mark, (m) => m.t === 'spawn');
    check('everyone is spawned during countdown', spawns.length === 3 && new Set(spawns.map((s) => s.id)).size === 3, spawns.length);
    check('spawns sit on distinct map spawn points', new Set(spawns.map((s) => s.p.join())).size === 3
      && spawns.every((s) => map.spawns.some((ms) => Math.hypot(ms.pos[0] - s.p[0], ms.pos[2] - s.p[2]) < 0.1)), spawns.map((s) => s.p));
    check('spawn has hp 100 and protection covering countdown + 1.5s', spawns.every((s) => s.hp === 100 && s.protect > 1.5 && s.protect <= 2.6), spawns.map((s) => s.protect));
    check('phase arrives before the spawns', A.since(mA, (m) => m.t === 'phase' || m.t === 'spawn')[0].t === 'phase');
    const play = await B.waitPhase('playing', 3000, mark);
    const T0 = Date.now();
    check('playing phase ends at now + roundTime', near(play.endsAt - play.now, 60000, 100) && play.seed === cd.seed, play);

    // spawn protection
    await sleep(120);                                   // a snapshot or two, so positions are known
    mark = A.mark();
    A.shoot(B.id, { hs: 1 });
    check('spawn-protected players take no damage', await expectNone(A, mark, hitOn(B.id), 300));

    const s0 = A.snaps;
    await sleep(1000);
    const rate = A.snaps - s0;
    check('snapshots arrive at ~20 Hz with a row per living player', rate >= 16 && rate <= 24 && A.rows.size === 3, `${rate}/s, ${A.rows.size} rows`);
    check('snapshot rows are [id,x,y,z,yaw,pitch,flags,weapon,hp]', A.rows.get(A.id).length === 9 && A.hp(A.id) === 100, A.rows.get(A.id));
    await sleep(Math.max(0, 1700 - (Date.now() - T0)));

    // range
    B.state([26, 0.05, 26]);
    A.state([-26, 0.05, -26]);
    await sleep(150);
    mark = A.mark();
    A.shoot(B.id, { w: 1, pellets: 9, from: [-26, 0.05, -26] });
    check('hit beyond weapon range rejected (Hole Punch at 73 m)', await expectNone(A, mark, hitOn(B.id)));
    mark = A.mark();
    const bp = A.pos(B.id);
    A.shoot(B.id, { end: [bp[0] - 20, bp[1], bp[2]] });
    check('hit whose end point is far from the target rejected', await expectNone(A, mark, hitOn(B.id)));
    mark = A.mark(); let markB = B.mark();
    A.shoot(B.id, { pellets: 3 });
    check('more pellets than the weapon fires → dropped, not relayed', await expectNone(A, mark, hitOn(B.id)) && B.since(markB, (m) => m.t === 'fire').length === 0);
    mark = A.mark();
    A.send({ t: 'fire', w: 0, o: [0, 1.6, 0], c: 1, hits: [{ e: [bp[0], bp[1] + 1, bp[2]], n: null, id: B.id, hs: 0 }] });
    check('muzzle origin far from the shooter rejected', await expectNone(A, mark, hitOn(B.id)));
    mark = A.mark();
    A.shoot(A.id);
    A.shoot(9999);
    A.shoot(B.id, { w: 3 });
    A.shoot(B.id, { w: 17 });
    check('self / unknown target / non-hitscan weapon / bad weapon id rejected', await expectNone(A, mark, (m) => m.t === 'hit', 300));

    // fire rate + exact damage
    await sleep(700);
    mark = A.mark(); markB = B.mark();
    A.shoot(B.id, { w: 1, pellets: 9 });
    await sleep(60);
    A.shoot(B.id, { w: 1, pellets: 9 });
    await sleep(300);
    let hits = A.since(mark, hitOn(B.id));
    check('too-fast second Hole Punch shot rejected', hits.length === 1, hits.length);
    check('9 pellets point blank = one aggregated hit for 90, hp 10', hits[0]?.dmg === 90 && hits[0]?.hp === 10 && hits[0]?.from === A.id && hits[0]?.w === 1 && hits[0]?.hs === 0 && hits[0]?.slow === 0 && Array.isArray(hits[0]?.p), hits[0]);
    const relayed = B.since(markB, (m) => m.t === 'fire');
    check('valid fire relayed once to others (id, w, o, c, hits), never to the shooter',
      relayed.length === 1 && relayed[0].id === A.id && relayed[0].w === 1 && relayed[0].hits.length === 9 && relayed[0].o.length === 3 && 'c' in relayed[0]
      && A.since(mark, (m) => m.t === 'fire').length === 0, relayed.length);
    await sleep(150);
    check('snapshot hp follows damage', B.hp() === 10, B.hp());

    // kill
    mark = A.mark();
    A.shoot(B.id);
    const kill = await A.waitFor((m) => m.t === 'kill', { from: mark });
    check('kill message: killer, victim, w, hs, streak 1, first, not final, no burst',
      kill.killer === A.id && kill.victim === B.id && kill.w === 0 && kill.hs === 0 && kill.streak === 1 && kill.first === true && kill.final === false && kill.burst === null, kill);
    r = await A.waitFor((m) => m.t === 'roster' && m.players.find((p) => p.id === A.id).kills === 1, { from: mark });
    check('kill is followed by a roster with scores', r.players.find((p) => p.id === B.id).deaths === 1 && r.players.find((p) => p.id === B.id).alive === false
      && A.log.indexOf(r) > A.log.indexOf(kill));
    const lastHit = A.since(mark, hitOn(B.id))[0];
    check('killing hit reports hp 0 and precedes the kill', lastHit && lastHit.hp === 0 && A.log.indexOf(lastHit) < A.log.indexOf(kill), lastHit);
    await sleep(150);
    mark = A.mark();
    A.send({ t: 'fire', w: 0, o: [bp[0] + 2, bp[1] + 1.62, bp[2]], c: 1, hits: [{ e: bp, n: null, id: B.id, hs: 1 }] });
    check('hit on a dead target rejected', await expectNone(A, mark, hitOn(B.id)));
    check('dead players leave the snapshot', !A.rows.has(B.id));
    const respawn = await A.waitFor((m) => m.t === 'spawn' && m.id === B.id, { from: A.log.indexOf(kill), ms: 2500 });
    check('respawn after the delay with full hp + 1.5s protection', respawn.hp === 100 && near(respawn.protect, 1.5, 0.05), respawn);

    // rewind
    await sleep(Math.max(0, 3500 - (Date.now() - T0)));
    mark = A.mark();
    A.shoot(C.id);
    let h = await A.waitFor(hitOn(C.id), { from: mark });
    check('Stapler body shot at 2 m = 14', h.dmg === 14 && h.hp === 86, h);
    mark = A.mark(); let markC = C.mark();
    const cPos = C.pos();
    C.send({ t: 'rewind', p: cPos });
    const heal = await A.waitFor((m) => m.t === 'heal' && m.id === C.id, { from: mark });
    const rew = await A.waitFor((m) => m.t === 'ev' && m.k === 'rewind', { from: mark });
    check('rewind restores hp from 3 s ago (heal src rewind)', heal.hp === 100 && heal.src === 'rewind', heal);
    check('rewind relayed as ev {k:"rewind", id, p} to others only', rew.id === C.id && rew.p.length === 3 && C.since(markC, (m) => m.t === 'ev').length === 0, rew);
    mark = A.mark();
    C.send({ t: 'rewind', p: cPos });
    check('rewind cooldown enforced', await expectNone(A, mark, (m) => m.t === 'heal'));

    // pickups
    mark = A.mark();
    A.shoot(C.id);
    await A.waitFor(hitOn(C.id), { from: mark });
    const healths = map.pickups.filter((k) => k.type === 'health');
    const farthest = healths.slice().sort((a, b) => Math.hypot(b.pos[0] - cPos[0], b.pos[2] - cPos[2]) - Math.hypot(a.pos[0] - cPos[0], a.pos[2] - cPos[2]))[0];
    mark = A.mark();
    C.send({ t: 'pickup', id: farthest.id });
    check('pickup from far away refused', await expectNone(A, mark, (m) => m.t === 'pk'));
    C.state([farthest.pos[0], 0.05, farthest.pos[2]]);
    C.send({ t: 'pickup', id: farthest.id });
    const pk = await A.waitFor((m) => m.t === 'pk', { from: mark });
    const pkHeal = await A.waitFor((m) => m.t === 'heal' && m.src === 'pickup', { from: mark });
    check('health pickup: pk {id, active:false, by} + heal capped at max hp', pk.id === farthest.id && pk.active === false && pk.by === C.id && pkHeal.id === C.id && pkHeal.hp === 100, [pk, pkHeal]);
    const other = healths.find((k) => k.id !== farthest.id);
    mark = A.mark();
    C.state([other.pos[0], 0.05, other.pos[2]]);
    C.send({ t: 'pickup', id: other.id });
    C.send({ t: 'pickup', id: farthest.id });
    check('health refused at full hp; taken pickup cannot be taken again', await expectNone(A, mark, (m) => m.t === 'pk', 300));

    // blotter
    await sleep(150);
    const cNow = A.pos(C.id);
    const aPos = [cNow[0] + 3, cNow[1], cNow[2]];
    A.state(aPos, 3);
    mark = A.mark(); markB = B.mark();
    A.send({ t: 'proj', pid: 7, o: [aPos[0], aPos[1] + 1.62, aPos[2]], vel: [-20, 5, 0] });
    const proj = await B.waitFor((m) => m.t === 'proj', { from: markB });
    check('proj relayed (id, pid, o, vel), not to the thrower', proj.id === A.id && proj.pid === 7 && proj.vel.length === 3 && A.since(mark, (m) => m.t === 'proj').length === 0, proj);
    A.send({ t: 'boom', pid: 7, p: [cNow[0], cNow[1] + 0.9, cNow[2]], hits: [{ id: C.id, d: 1 }, { id: A.id, d: 2 }, { id: 9999, d: 0 }] });
    const boom = await B.waitFor((m) => m.t === 'boom', { from: markB });
    check('boom relayed with radius', boom.id === A.id && boom.pid === 7 && near(boom.r, 4.6, 0.01) && boom.p.length === 3, boom);
    await sleep(200);
    const splashC = A.since(mark, hitOn(C.id))[0], splashA = A.since(mark, hitOn(A.id))[0];
    check('splash damage by distance (d=1 → 74)', splashC?.dmg === 74 && splashC?.w === 3 && splashC?.hp === 26, splashC);
    check('self splash is halved (d=2 → 30)', splashA?.dmg === 30 && splashA?.from === A.id && splashA?.hp === 70, splashA);
    mark = A.mark();
    A.send({ t: 'boom', pid: 7, p: [cNow[0], cNow[1] + 0.9, cNow[2]], hits: [{ id: C.id, d: 0 }] });
    A.send({ t: 'boom', pid: 8, p: [cNow[0], cNow[1] + 0.9, cNow[2]], hits: [{ id: C.id, d: 0 }] });
    check('boom for an unknown / already exploded pid ignored', await expectNone(A, mark, (m) => m.t === 'hit' || m.t === 'boom'));

    // fell
    mark = A.mark();
    C.send({ t: 'fell' });
    const fell = await A.waitFor((m) => m.t === 'kill' && m.victim === C.id, { from: mark });
    r = await A.waitFor((m) => m.t === 'roster' && m.players.find((p) => p.id === C.id).deaths === 1, { from: mark });
    check('fell → environment kill (killer null), nobody scores', fell.killer === null && fell.w === -1 && fell.first === false && r.players.find((p) => p.id === A.id).kills === 1, fell);

    // overprint
    const op = map.pickups.find((k) => k.type === 'overprint');
    mark = A.mark(); markB = B.mark();
    A.state([op.pos[0], op.pos[1] - 1, op.pos[2]]);
    A.send({ t: 'pickup', id: op.id });
    const buff = await B.waitFor((m) => m.t === 'buff', { from: markB });
    check('overprint: buff {id, type, until ≈ now+10s} announced to everyone', buff.id === A.id && buff.type === 'overprint' && near(buff.until - Date.now(), 10000, 1500), buff);
    await sleep(Math.max(0, (A.protect.get(B.id) || 0) - Date.now() + 150));
    mark = A.mark();
    A.shoot(B.id);
    h = await A.waitFor(hitOn(B.id), { from: mark });
    check('overprint doubles outgoing damage (14 → 28)', h.dmg === 28, h);

    // win the round: 2 more kills
    mark = A.mark();
    for (let i = 0; i < 6 && A.since(mark, (m) => m.t === 'kill').length < 1; i++) { A.shoot(B.id, { hs: 1 }); await sleep(110); }
    const kill2 = await A.waitFor((m) => m.t === 'kill' && m.killer === A.id, { from: mark });
    check('second kill: streak 2, not first', kill2.streak === 2 && kill2.first === false && kill2.hs === 1, kill2);
    await A.waitFor((m) => m.t === 'spawn' && m.id === C.id, { from: A.log.indexOf(fell), ms: 3000 });
    await sleep(Math.max(0, (A.protect.get(C.id) || 0) - Date.now() + 150));
    mark = A.mark();
    for (let i = 0; i < 8 && A.since(mark, (m) => m.t === 'kill').length < 1; i++) { A.shoot(C.id, { hs: 1 }); await sleep(110); }
    const kill3 = await A.waitFor((m) => m.t === 'kill' && m.killer === A.id, { from: mark });
    check('round-winning kill is flagged final', kill3.final === true && kill3.streak === 3, kill3);
    const end = await A.waitPhase('roundEnd', 2000, mark);
    check('roundEnd: winnerId + standings sorted by kills', end.winnerId === A.id && end.standings[0].id === A.id && end.standings[0].kills === 3 && end.standings[0].wins === 1
      && end.standings.length === 3 && near(end.endsAt - end.now, 1500, 60), end);
    check('kill → roster → roundEnd order', A.since(mark, (m) => m.t === 'roster' || m.t === 'phase')[0].t === 'roster');
    mark = A.mark();
    A.shoot(B.id);
    check('no damage after the round is over', await expectNone(A, mark, (m) => m.t === 'hit'));
    const mEnd = await A.waitPhase('matchEnd', 3000, mark);
    check('roundsToWin reached → matchEnd without a draft', mEnd.winnerId === A.id && A.since(mark, (m) => m.t === 'draft' || (m.t === 'phase' && m.phase === 'draft')).length === 0
      && near(mEnd.endsAt - mEnd.now, 3000, 60), mEnd);
    const lobby = await A.waitPhase('lobby', 5000, mark);
    await sleep(150);
    check('back to lobby: endsAt 0, wins/cards/scores reset', lobby.endsAt === 0 && A.roster.players.every((p) => p.wins === 0 && p.cards.length === 0 && p.kills === 0 && !p.alive), A.roster.players);
    [A, B, C].forEach((c) => c.close());
    await sleep(200);
  } finally {
    await stopServer(srv);
  }
}

// ───────────────────────────── suite 2: full match flow with bots ─────────────────────────────

async function suiteFlow() {
  suite = 'flow';
  console.log('\n[2/3] full match flow (3 humans + 2 bots, late joiner, host leaves, everyone leaves)');
  const srv = await startServer(['--bots', '0']);
  const clients = [];
  try {
    const A = await Client.join('Host');
    const B = await Client.join('Ace');
    const C = await Client.join('Idle');
    clients.push(A, B, C);
    A.send({ t: 'settings', settings: { killsToWin: 3, roundsToWin: 3, bots: 2, botSkill: 0, roundTime: 60 } });
    let r = await B.waitFor((m) => m.t === 'roster' && m.players.length === 5);
    const bots = r.players.filter((p) => p.isBot);
    check('2 bots with distinct names, colors and ids', bots.length === 2 && bots[0].name !== bots[1].name && bots[0].color !== bots[1].color, bots);
    check('bots avoid colors humans already use', bots.every((b) => b.color !== 0), bots.map((b) => b.color));

    let mark = B.mark();
    A.send({ t: 'start' });
    const seeds = [];
    let D = null, aceWins = 0, drafts = 0, rounds = 0, hostLeft = false;

    // Ace farms kills so rounds end quickly; everything else is asserted around it.
    const hunt = async (untilPhaseMark) => {
      while (!B.since(untilPhaseMark, (m) => m.t === 'phase' && m.phase === 'roundEnd').length) {
        const now = Date.now();
        const targets = [...B.rows.keys()].filter((id) => id !== B.id && (B.protect.get(id) || 0) + 120 < now);
        if (B.rows.has(B.id) && targets.length) B.shoot(targets[0], { hs: 1 });
        await sleep(105);
      }
    };

    for (;;) {
      const cd = await B.waitPhase('countdown', 6000, mark);
      rounds++;
      seeds.push(cd.seed);
      check(`round ${rounds}: countdown has round number, fresh seed, mapPlayers = player count`,
        cd.round === rounds && cd.seed > 0 && seeds.indexOf(cd.seed) === seeds.length - 1 && cd.mapPlayers === B.roster.players.length, [cd.round, cd.seed, cd.mapPlayers]);
      await sleep(200);
      const spawns = B.since(mark, (m) => m.t === 'spawn');
      check(`round ${rounds}: every player spawned for the countdown`, new Set(spawns.map((s) => s.id)).size === B.roster.players.length, spawns.length);
      if (rounds > 1) {
        const bad = spawns.filter((s) => s.hp !== computeStats(B.player(s.id).cards).maxHp);
        check(`round ${rounds}: spawn hp reflects drafted cards (maxHp)`, bad.length === 0, bad);
      }
      const frozen = B.pos(bots[0].id);
      const play = await B.waitPhase('playing', 3000, mark);
      mark = B.log.indexOf(play);
      const still = B.pos(bots[0].id);
      if (rounds === 1) check('bots hold still during the countdown', Math.hypot(frozen[0] - still[0], frozen[2] - still[2]) < 0.5);

      if (rounds === 1) {
        // late joiner mid-round
        await sleep(400);
        D = await new Client('Late').open({ name: 'Late' });
        clients.push(D);
        const w = await D.waitFor((m) => m.t === 'welcome', { from: 0 });
        D.id = w.id;
        const dSpawn = await D.waitFor((m) => m.t === 'spawn' && m.id === D.id, { from: 0, ms: 3000 });
        const joinedAt = D.log.indexOf(w), ownAt = D.log.indexOf(dSpawn);
        const before = D.log.slice(joinedAt, ownAt);
        const ph = before.find((m) => m.t === 'phase');
        check('late joiner: welcome, roster, then phase with the live seed + pickups', before[0].t === 'welcome' && before[1].t === 'roster' && ph
          && ph.phase === 'playing' && ph.seed === cd.seed && ph.mapPlayers === cd.mapPlayers && ph.pickups.length === generateMap(cd.seed, cd.mapPlayers).pickups.length, ph);
        const alive = before.find((m) => m.t === 'roster').players.filter((p) => p.alive).map((p) => p.id);
        const got = new Set(before.filter((m) => m.t === 'spawn').map((m) => m.id));
        check('late joiner: gets a spawn for every living player', alive.length >= 1 && alive.every((id) => got.has(id)), { alive, got: [...got] });
        const waited = D.log.indexOf(dSpawn) > D.log.indexOf(ph) && dSpawn.hp === 100;
        check('late joiner: spawns after the respawn delay', waited && near(dSpawn.protect, 1.5, 0.05), dSpawn);
        r = await B.waitFor((m) => m.t === 'roster' && m.players.some((p) => p.id === D.id), { from: 0 });
        check('late joiner appears in everyone\'s roster', r.players.length === 6);
        const walked = [0, 0];
        let last = bots.map((b) => B.pos(b.id));
        for (let i = 0; i < 20; i++) {
          await sleep(100);
          bots.forEach((b, k) => {
            const p = B.pos(b.id);
            if (p && last[k]) walked[k] += Math.hypot(p[0] - last[k][0], p[2] - last[k][2]);
            last[k] = p;
          });
        }
        check('bots move once the round starts', walked.every((d) => d > 2), walked);
        const row = B.rows.get(bots[0].id) || B.rows.get(bots[1].id);
        check('bot snapshot rows are well formed (yaw/pitch finite, flags int, hp > 0)', row && row.length === 9 && row.every(Number.isFinite) && Number.isInteger(row[6]) && row[8] > 0, row);
      } else {
        await sleep(1600);
      }

      if (rounds === 2 && !hostLeft) {
        // host walks away mid-round
        const m2 = B.mark();
        A.close();
        hostLeft = true;
        r = await B.waitFor((m) => m.t === 'roster' && !m.players.some((p) => p.id === A.id), { from: m2 });
        check('host leaving reassigns host to the next human', r.hostId === B.id, r.hostId);
        check('system chat announces the new host', (await B.waitFor((m) => m.t === 'chat' && m.system === true && /host/.test(m.text), { from: m2 })).text.includes('Ace'));
      }

      await hunt(mark);
      const end = await B.waitPhase('roundEnd', 3000, mark);
      const winner = end.winnerId;
      if (winner === B.id) aceWins++;
      const sorted = end.standings.every((s, i, a) => i === 0 || a[i - 1].kills >= s.kills);
      check(`round ${rounds}: roundEnd names the top scorer`, end.standings[0].id === winner && end.standings[0].kills === 3 && sorted && end.standings.length === B.roster.players.length, end.standings);
      const finalKill = B.since(mark, (m) => m.t === 'kill').pop();
      check(`round ${rounds}: last kill is the final one`, finalKill.final === true && finalKill.killer === winner, finalKill);
      mark = B.log.indexOf(end);

      const next = await B.waitFor((m) => m.t === 'phase' && (m.phase === 'draft' || m.phase === 'matchEnd'), { from: mark + 1, ms: 4000 });
      if (next.phase === 'matchEnd') {
        check('matchEnd after 3 round wins, with winner + standings by wins', next.winnerId === winner && next.standings[0].id === winner && next.standings[0].wins === 3, next);
        mark = B.log.indexOf(next);
        break;
      }

      // draft
      drafts++;
      const draftAt = Date.now();
      await sleep(250);
      const humans = clients.filter((c) => !c.closed);
      const offers = new Map(humans.map((c) => [c, c.since(0, (m) => m.t === 'draft').pop()]));
      const winnerClient = humans.find((c) => c.id === winner);
      if (winnerClient) check(`draft ${drafts}: round winner gets no options`, offers.get(winnerClient).options.length === 0 && offers.get(winnerClient).isWinner === true, offers.get(winnerClient));
      const losers = humans.filter((c) => c.id !== winner);
      check(`draft ${drafts}: everyone else gets 3 distinct valid cards`, losers.length > 0 && losers.every((c) => {
        const o = offers.get(c);
        return o && o.isWinner === false && o.options.length === 3 && new Set(o.options).size === 3 && o.options.every((id) => CARD_BY_ID[id]);
      }), losers.map((c) => offers.get(c)));
      check(`draft ${drafts}: draft phase lasts 3s (fast)`, near(next.endsAt - next.now, 3000, 60), next.endsAt - next.now);

      const picker = losers[0];
      const owned = B.player(picker.id).cards.slice();
      const m3 = B.mark();
      picker.send({ t: 'pick', card: 'definitely_not_a_card' });
      const notOffered = Object.keys(CARD_BY_ID).find((id) => !offers.get(picker).options.includes(id));
      picker.send({ t: 'pick', card: notOffered });
      const choice = offers.get(picker).options[1];
      picker.send({ t: 'pick', card: choice });
      picker.send({ t: 'pick', card: offers.get(picker).options[0] });
      const picked = await B.waitFor((m) => m.t === 'picked' && m.id === picker.id, { from: m3 });
      await sleep(150);
      check(`draft ${drafts}: only an offered card can be picked, once`, picked.card === choice && B.since(m3, (m) => m.t === 'picked' && m.id === picker.id).length === 1
        && B.player(picker.id).cards.join() === [...owned, choice].join(), B.player(picker.id).cards);

      if (drafts === 1) {
        // everybody picks → the draft closes early
        for (const c of losers.slice(1)) c.send({ t: 'pick', card: offers.get(c).options[0] });
        const cdNext = await B.waitPhase('countdown', 4000, mark);
        const took = Date.now() - draftAt;
        check('draft closes early once every human has picked (~1.5s beat)', took > 1200 && took < 2600, took);
        mark = B.log.indexOf(cdNext) - 1;
      } else {
        // one human stays silent → auto-pick at the buzzer
        const cdNext = await B.waitPhase('countdown', 5000, mark);
        const took = Date.now() - draftAt;
        check('draft runs to the buzzer when a human does not pick', took > 2700, took);
        mark = B.log.indexOf(cdNext) - 1;
      }
      const pickedIds = new Set(B.since(B.log.indexOf(next), (m) => m.t === 'picked').map((m) => m.id));
      const mustPick = B.roster.players.filter((p) => p.id !== winner).map((p) => p.id);
      check(`draft ${drafts}: every non-winner (bots + silent humans) ends up with a card, winner without`,
        mustPick.every((id) => pickedIds.has(id)) && !pickedIds.has(winner), { mustPick, picked: [...pickedIds] });
      check(`draft ${drafts}: roster shows one card per round lost`, B.roster.players.every((p) => p.cards.length === rounds - p.wins), B.roster.players.map((p) => [p.id, p.wins, p.cards.length]));
    }

    check('match took 3+ rounds, each on a new seed', rounds >= 3 && new Set(seeds).size === seeds.length, seeds);
    check('the scripted ace won rounds (winner path exercised)', aceWins >= 1, aceWins);
    const lobby = await B.waitPhase('lobby', 5000, mark);
    await sleep(150);
    check('lobby after matchEnd: wins and cards reset, bots kept', lobby.endsAt === 0 && B.roster.players.every((p) => p.wins === 0 && p.cards.length === 0) && B.roster.players.filter((p) => p.isBot).length === 2, B.roster.players);

    // host can start again; then everyone leaves mid-countdown
    mark = B.mark();
    B.send({ t: 'start' });
    await B.waitPhase('countdown', 3000, mark);
    check('new host can start a rematch', true);
    clients.forEach((c) => c.close());
    await sleep(400);
    const E = await Client.join('Fresh');
    await sleep(100);
    check('everyone left → server reset to lobby and kept running', E.phase.phase === 'lobby' && E.roster.hostId === E.id && E.roster.players.filter((p) => !p.isBot).length === 1
      && E.roster.players.every((p) => p.wins === 0 && p.cards.length === 0), E.phase);
    E.close();

    // a vanishing client (no close frame) must not take the server down
    const G = await Client.join('Ghost');
    G.ws.terminate();
    await sleep(300);
    const F = await Client.join('After');
    await sleep(100);
    check('abruptly dropped socket is cleaned up', F.roster.players.filter((p) => !p.isBot).length === 1 && F.roster.hostId === F.id, F.roster.players.map((p) => p.name));
    F.close();
    await sleep(200);
  } finally {
    clients.forEach((c) => { try { c.close(); } catch { /* already closed */ } });
    await stopServer(srv);
  }
}

// ───────────────────────────── suite 3: bots vs an idle human ─────────────────────────────

async function suiteBots() {
  suite = 'bots';
  console.log('\n[3/3] bots vs an idle human (started with --bots 2)');
  const srv = await startServer(['--bots', '2']);
  try {
    const A = await Client.join('Sitting Duck');
    check('--bots N pre-fills the lobby', A.roster.players.filter((p) => p.isBot).length === 2 && A.roster.settings.bots === 2);
    A.send({ t: 'settings', settings: { killsToWin: 30, roundTime: 120, botSkill: 1 } });
    A.send({ t: 'start' });
    const play = await A.waitPhase('playing', 4000, 0);
    const bots = A.roster.players.filter((p) => p.isBot).map((p) => p.id);
    const trail = new Map(bots.map((id) => [id, []]));
    let hurtBy = null, fired = 0, tracers = 0, flagsSeen = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !(hurtBy && Date.now() - t0 > 8000)) {
      await sleep(100);
      for (const id of bots) { const p = A.pos(id); if (p) trail.get(id).push(p); const row = A.rows.get(id); if (row) flagsSeen |= row[6]; }
      const hit = A.since(A.log.indexOf(play), (m) => m.t === 'hit' && m.to === A.id && bots.includes(m.from))[0];
      if (hit) hurtBy = hit;
    }
    const fires = A.since(0, (m) => m.t === 'fire' && bots.includes(m.id));
    fired = fires.length;
    tracers = fires.filter((f) => f.hits.every((h) => Array.isArray(h.e) && h.e.length === 3 && (h.id !== null || h.n === null || h.n.length === 3))).length;
    const walls = fires.flatMap((f) => f.hits).filter((h) => h.id === null && h.n).length;
    check('bots damage an idle human', !!hurtBy, `no hit in ${Math.round((Date.now() - t0) / 1000)}s`);
    check('bot hits go through the normal hit message', !hurtBy || (hurtBy.dmg > 0 && hurtBy.w >= 0 && hurtBy.w <= 3 && Array.isArray(hurtBy.p)), hurtBy);
    check('bots send real fire messages (end points, normals on wall hits)', fired > 0 && tracers === fired && walls > 0, { fired, tracers, walls });
    const size = generateMap(play.seed, play.mapPlayers).size / 2;
    for (const id of bots) {
      const pts = trail.get(id);
      const span = Math.max(...pts.map((p) => Math.hypot(p[0] - pts[0][0], p[2] - pts[0][2])));
      check(`bot ${id} roams (${span.toFixed(0)} m from start) and stays inside the arena`, span > 5 && pts.every((p) => Math.abs(p[0]) <= size && Math.abs(p[2]) <= size && p[1] > -0.5), span);
    }
    check('bot rows carry the GROUND flag', (flagsSeen & 1) === 1, flagsSeen);
    A.close();
    await sleep(200);
  } finally {
    await stopServer(srv);
  }
}

// ───────────────────────────── run ─────────────────────────────

const suites = { combat: suiteCombat, flow: suiteFlow, bots: suiteBots };
const started = Date.now();
for (const [name, run] of Object.entries(suites)) {
  if (only && only !== name) continue;
  try {
    await run();
  } catch (err) {
    check(`suite "${name}" ran to completion`, false, err.stack || String(err));
  }
}

console.log('\n──────── summary ────────');
for (const name of Object.keys(suites)) {
  const rows = results.filter((r) => r.suite === name);
  if (!rows.length) continue;
  const bad = rows.filter((r) => !r.ok);
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${name.padEnd(7)} ${rows.length - bad.length}/${rows.length} checks`);
  for (const b of bad) console.log(`        ✗ ${b.name}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${failed ? 'FAIL' : 'PASS'} — ${results.length - failed}/${results.length} checks in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);

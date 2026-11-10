// Card effects + rule details that are awkward to reach over a real socket (they need specific
// cards, hp values and long waits). Runs the real Game in-process on a simulated clock.
//   node tools/servertest-cards.mjs [--verbose]
import { Game, TICK_MS } from '../server/game.js';
import { setCards } from '../server/player.js';
import { MAX_PLAYERS, PHASE } from '../shared/constants.js';

const verbose = process.argv.includes('--verbose');
let failed = 0, total = 0;
function check(name, ok, detail = '') {
  total++;
  if (!ok) failed++;
  if (!ok || verbose) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail !== '' ? ` — ${JSON.stringify(detail)}` : ''}`);
}

/** A game in the `playing` phase with `n` scripted humans standing 2 m apart, spawn protection expired. */
function arena(n = 3, settings = {}) {
  const t = { clock: 1_700_000_000_000, errors: [] };
  const game = new Game({ bots: 0, now: () => t.clock, log: (...a) => t.errors.push(a.map(String).join(' ')) });
  const users = [];
  for (let i = 0; i < n; i++) {
    const u = { inbox: [], closed: false };
    u.conn = game.connect({ send: (raw) => { const m = JSON.parse(raw); if (m.t !== 'snap') u.inbox.push(m); else u.snap = m; }, close: () => { u.closed = true; } });
    u.say = (m) => game.receive(u.conn, JSON.stringify(m));
    u.say({ t: 'hello', v: 1, name: `P${i + 1}` });
    u.p = u.conn.player;
    u.id = u.p.id;
    users.push(u);
  }
  const advance = (ms) => { for (let left = ms; left > 0; left -= TICK_MS) { t.clock += Math.min(TICK_MS, left); game.step(); } };
  users[0].say({ t: 'settings', settings: { bots: 0, killsToWin: 30, roundTime: 600, roundsToWin: 9, ...settings } });
  users[0].say({ t: 'start' });
  advance(4000 + 1600);
  users.forEach((u, i) => { u.at = [i * 2, 0, 0]; u.say({ t: 'st', p: u.at, yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 }); });
  const all = users[0].inbox;       // every user receives every broadcast; user 0's inbox is the log
  const fire = (from, to, { w = 0, hs = 0, c = 1, pellets = 1, via, o } = {}) => {
    const mark = all.length;
    const origin = o || [from.p.pos[0], from.p.pos[1] + 1.62, from.p.pos[2]];
    const hit = { e: [to.p.pos[0], to.p.pos[1] + 1, to.p.pos[2]], n: null, id: to.id, hs };
    if (via) hit.via = via;
    from.say({ t: 'fire', w, o: origin, c, hits: Array.from({ length: pellets }, () => hit) });
    advance(1200);                  // clears every weapon's fire interval for the next shot
    return all.slice(mark);
  };
  return { game, users, advance, fire, all, t };
}
const hitsOn = (msgs, u) => msgs.filter((m) => m.t === 'hit' && m.to === u.id);
const of = (msgs, type) => msgs.filter((m) => m.t === type);

console.log('card effects + rules (simulated clock)');

{ // base numbers
  const { users: [a, b], fire, advance } = arena(2);
  let out = fire(a, b);
  check('stapler body = 14', hitsOn(out, b)[0]?.dmg === 14, out);
  out = fire(a, b, { hs: 1 });
  check('stapler headshot = 14 × 1.6 → 22', hitsOn(out, b)[0]?.dmg === 22, out);
  b.p.hp = 100;
  check('marker uncharged = 34', hitsOn(fire(a, b, { w: 2, c: 0 }), b)[0]?.dmg === 34);
  b.p.hp = 100;
  check('marker half charge = 65', hitsOn(fire(a, b, { w: 2, c: 0.5 }), b)[0]?.dmg === 65);
  b.p.hp = 100;
  check('marker full charge = 96 (c clamped to 1)', hitsOn(fire(a, b, { w: 2, c: 7 }), b)[0]?.dmg === 96);
  b.p.hp = 100;
  b.say({ t: 'st', p: [27, 0, 0], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  advance(100);
  check('stapler falloff at 27 m ≈ 14 × 0.79 → 11 (distance computed by the server)', hitsOn(fire(a, b), b)[0]?.dmg === 11);
  a.say({ t: 'st', p: [-20, 0, 0], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  b.say({ t: 'st', p: [25, 0, 0], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  advance(100);
  check('stapler falloff floor beyond 42 m = 7', hitsOn(fire(a, b), b)[0]?.dmg === 7);
}

{ // stat cards on the attacker
  const { users: [a, b], fire } = arena(2);
  setCards(a.p, ['overprint']);
  check('OVERPRINT card: 14 × 1.22 → 17', hitsOn(fire(a, b), b)[0]?.dmg === 17);
  setCards(a.p, ['spot_color']);
  check('SPOT COLOR: headshot 14 × 1.6 × 1.5 → 34', hitsOn(fire(a, b, { hs: 1 }), b)[0]?.dmg === 34);
  setCards(a.p, ['deadline']);
  b.p.hp = 100;
  check('DEADLINE: no bonus above 35% hp', hitsOn(fire(a, b), b)[0]?.dmg === 14);
  a.p.hp = 30;
  check('DEADLINE: +45% at ≤ 35% hp → 20', hitsOn(fire(a, b), b)[0]?.dmg === 20);
  setCards(a.p, ['paper_jam']);
  b.p.hp = 100;
  check('PAPER JAM: hit.slow = 1', hitsOn(fire(a, b), b)[0]?.slow === 1);
  setCards(a.p, []);
  b.p.hp = 100;
  let out = fire(a, b, { via: [[1, 1.6, 5]] });
  check('ricochet claim without CARBON COPY rejected', hitsOn(out, b).length === 0);
  setCards(a.p, ['carbon_copy']);
  out = fire(a, b, { via: [[1, 1.6, 5]] });
  check('CARBON COPY: one ricochet accepted', hitsOn(out, b)[0]?.dmg === 14, out);
  out = fire(a, b, { via: [[1, 1.6, 5], [1, 1.6, -5]] });
  check('CARBON COPY: more ricochets than owned rejected', hitsOn(out, b).length === 0);
}

{ // sustain
  const { users: [a, b], fire, advance, game } = arena(2);
  setCards(a.p, ['bleed']);
  a.p.hp = 50;
  let out = fire(a, b);
  const steal = of(out, 'heal')[0];
  check('FULL BLEED: heal 20% of damage dealt (src lifesteal)', steal?.id === a.id && steal.src === 'lifesteal' && Math.abs(a.p.hp - 52.8) < 1e-6 && steal.hp === 53, steal);
  setCards(a.p, ['royalties']);
  a.p.hp = 40; b.p.hp = 5;
  out = fire(a, b);
  const kh = of(out, 'heal')[0];
  check('ROYALTIES: +35 on kill (src kill)', kh?.id === a.id && kh.src === 'kill' && kh.hp === 75, kh);
  check('heal never exceeds max hp', (() => { advance(4500); a.p.hp = 90; b.p.hp = 5; fire(a, b); return a.p.hp === 100 && !b.p.alive; })());

  setCards(b.p, ['heavy_stock']);
  advance(1500);
  game.spawnPlayer(b.p);
  check('HEAVY STOCK: max hp 145 on spawn', b.p.hp === 145 && b.inbox.filter((m) => m.t === 'spawn' && m.id === b.id).pop().hp === 145);

  setCards(b.p, ['lamination']);
  game.spawnPlayer(b.p);
  advance(1600);
  b.say({ t: 'st', p: [2, 0, 0], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  fire(a, b);                                         // 100 → 86, then 1.2 s pass inside fire()
  check('LAMINATION: no regen before 3 s out of combat', b.p.hp === 86, b.p.hp);
  advance(1700);
  check('LAMINATION: no regen at 2.9 s', b.p.hp === 86, b.p.hp);
  advance(1100);
  check('LAMINATION: 7 hp/s afterwards, visible in snapshots', Math.abs(b.p.hp - 93) < 0.8 && a.snap.ps.find((r) => r[0] === b.id)[8] === Math.round(b.p.hp), b.p.hp);
  advance(5000);
  check('LAMINATION: stops at max hp', b.p.hp === 100);
}

{ // thorns
  const { users: [a, b], fire } = arena(2);
  setCards(b.p, ['thermal_paper']);
  let out = fire(a, b);
  const back = hitsOn(out, a)[0];
  check('THERMAL PAPER: attacker takes 25% as a hit with w −1 from the victim', back?.from === b.id && back.w === -1 && back.dmg === 4 && back.hp === 96, back);
  a.p.hp = 3;
  out = fire(a, b);
  check('thorns cannot take the attacker below 1 hp', hitsOn(out, a)[0]?.dmg === 2 && a.p.hp === 1 && a.p.alive, hitsOn(out, a));
  out = fire(a, b);
  check('thorns at 1 hp: nothing happens, attacker lives', hitsOn(out, a).length === 0 && a.p.alive && of(out, 'kill').length === 0);
  setCards(a.p, ['thermal_paper']);
  a.p.hp = 100; b.p.hp = 100;
  out = fire(a, b);
  check('thorns do not echo back and forth', of(out, 'hit').length === 2, of(out, 'hit'));
}

{ // second draft
  const { users: [a, b], fire, advance, game, all } = arena(2);
  setCards(b.p, ['second_draft']);
  b.p.hp = 10;
  let out = fire(a, b, { hs: 1 });
  check('SECOND DRAFT: lethal hit leaves 1 hp + `saved`', hitsOn(out, b)[0]?.hp === 1 && of(out, 'saved')[0]?.id === b.id && of(out, 'kill').length === 0 && b.p.alive, out);
  out = fire(a, b);
  check('SECOND DRAFT: only once per life', of(out, 'kill')[0]?.victim === b.id);
  advance(3000);
  b.p.hp = 10;
  const mark = all.length;
  a.say({ t: 'fire', w: 0, o: [a.p.pos[0], 1.62, a.p.pos[2]], c: 1, hits: [{ e: b.p.pos, n: null, id: b.id, hs: 0 }] });
  advance(200);
  a.say({ t: 'fire', w: 0, o: [a.p.pos[0], 1.62, a.p.pos[2]], c: 1, hits: [{ e: b.p.pos, n: null, id: b.id, hs: 0 }] });
  advance(100);
  check('SECOND DRAFT: available again after respawn, with a short grace period', of(all.slice(mark), 'saved').length === 1 && b.p.alive && b.p.hp === 1);
  advance(600);
  out = fire(a, b);
  check('SECOND DRAFT: grace ends', !b.p.alive);
  void game;
}

{ // ink burst
  const { users: [a, v1, v2, v3], fire, game } = arena(4);
  setCards(a.p, ['ink_burst']);
  v3.say({ t: 'st', p: [20, 0, 0], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  v1.p.hp = 5; v2.p.hp = 40;
  const out = fire(a, v1);
  const kills = of(out, 'kill');
  check('INK BURST: kill carries burst {p, r:5}', kills[0]?.victim === v1.id && kills[0].burst && kills[0].burst.r === 5 && kills[0].burst.p.length === 3, kills[0]);
  const splash = hitsOn(out, v2)[0];
  check('INK BURST: bystander within 5 m takes 45 as a hit with w −1', splash?.dmg === 45 && splash.w === -1 && splash.from === a.id, splash);
  check('INK BURST: chain kill credited to the killer', kills[1]?.victim === v2.id && kills[1].killer === a.id && kills[1].w === -1 && a.p.kills === 2 && kills[1].streak === 2, kills[1]);
  check('INK BURST: killer and far players unharmed', a.p.hp === 100 && v3.p.hp === 100 && hitsOn(out, v3).length === 0);
  check('first blood only on the first kill', kills[0].first === true && kills[1].first === false);
  void game;
}

{ // rewind
  const { users: [a, b], fire, advance, all } = arena(2);
  advance(2000);
  fire(a, b);
  fire(a, b);                                          // b: 72, was 100 three seconds ago
  let mark = all.length;
  b.say({ t: 'rewind', p: b.p.pos });
  check('rewind: hp = max(now, 3 s ago)', of(all.slice(mark), 'heal')[0]?.hp === 100 && b.p.hp === 100);
  b.p.hp = 20;
  advance(10000);
  mark = all.length;
  b.say({ t: 'rewind', p: b.p.pos });
  check('rewind: 14 s cooldown (10 s is too early)', of(all.slice(mark), 'heal').length === 0);
  advance(2500);
  b.say({ t: 'rewind', p: b.p.pos });
  check('rewind: allowed again after the cooldown; never lowers hp', of(all.slice(mark), 'heal')[0]?.hp === 20);
  setCards(b.p, ['recall_notice']);
  advance(6500);
  mark = all.length;
  b.say({ t: 'rewind', p: b.p.pos });
  check('RECALL NOTICE: half cooldown + full heal', of(all.slice(mark), 'heal')[0]?.hp === 100);
  advance(8000);
  mark = all.length;
  b.say({ t: 'rewind', p: [b.p.pos[0] + 40, 0, 0] });
  check('rewind to a place the player never was is refused', of(all.slice(mark), 'heal').length === 0);
}

{ // pickups + overprint timing
  const { users: [a, b], fire, advance, game, all } = arena(2);
  const health = [...game.arena.pickups.values()].find((k) => k.type === 'health');
  const over = [...game.arena.pickups.values()].find((k) => k.type === 'overprint');
  fire(a, b);
  b.say({ t: 'st', p: [health.pos[0], 0, health.pos[2]], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  let mark = all.length;
  b.say({ t: 'pickup', id: health.id });
  check('health pickup taken', of(all.slice(mark), 'pk')[0]?.active === false && b.p.hp === 100);
  advance(13000);
  check('health pickup still gone at 13 s', of(all.slice(mark), 'pk').length === 1);
  advance(1200);
  const back = of(all.slice(mark), 'pk')[1];
  check('health pickup respawns after 14 s (pk active:true, by:null)', back?.id === health.id && back.active === true && back.by === null, back);
  a.say({ t: 'st', p: [over.pos[0], over.pos[1] - 1, over.pos[2]], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  b.say({ t: 'st', p: [over.pos[0] + 2, over.pos[1] - 1, over.pos[2]], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  mark = all.length;
  a.say({ t: 'pickup', id: over.id });
  const buff = of(all.slice(mark), 'buff')[0];
  check('overprint buff lasts 10 s', buff?.until === game.now() + 10000, buff);
  check('overprint: ×2 while active', hitsOn(fire(a, b), b)[0]?.dmg === 28);
  advance(9000);
  check('overprint: back to normal after 10 s', hitsOn(fire(a, b), b)[0]?.dmg === 14);
  advance(27000);
  check('overprint still gone at 38.4 s', !of(all.slice(mark), 'pk').some((m) => m.id === over.id && m.active === true));
  advance(2000);
  check('overprint respawns after 40 s', of(all.slice(mark), 'pk').some((m) => m.id === over.id && m.active === true));
  a.say({ t: 'pickup', id: over.id });
  b.p.hp = 5;
  advance(1500);
  mark = all.length;
  b.say({ t: 'st', p: [over.pos[0] + 2, over.pos[1] - 1, over.pos[2]], yaw: 0, pitch: 0, v: [0, 0, 0], f: 1, w: 0 });
  a.p.hp = 1;
  b.say({ t: 'fire', w: 0, o: [b.p.pos[0], b.p.pos[1] + 1.62, b.p.pos[2]], c: 1, hits: [{ e: a.p.pos, n: null, id: a.id, hs: 0 }] });
  check('overprint buff is lost on death', !a.p.alive && a.p.overprintUntil === 0);
}

{ // buzzer + tie-breaks, streaks
  const { users: [a, b, c], advance, game, all, fire } = arena(3, { roundTime: 60 });
  b.p.hp = 5;
  fire(a, b);
  c.p.hp = 5;
  fire(a, c);
  check('streak counts kills since last death', of(all, 'kill').pop().streak === 2 && a.p.streak === 2);
  a.say({ t: 'fell' });
  check('death resets the streak; fell costs no kills', a.p.streak === 0 && a.p.kills === 2 && a.p.deaths === 1);
  // make it a three-way tie on kills: fewest deaths wins, then earliest to reach the score
  a.p.kills = 2; a.p.deaths = 1; a.p.lastKillAt = 10;
  b.p.kills = 2; b.p.deaths = 0; b.p.lastKillAt = 30;
  c.p.kills = 2; c.p.deaths = 0; c.p.lastKillAt = 20;
  advance(60000);
  const end = of(all, 'phase').filter((m) => m.phase === 'roundEnd').pop();
  check('buzzer: round ends at roundTime', !!end && game.phase !== PHASE.PLAYING);
  check('tie-break: fewest deaths, then earliest to reach the score', end?.winnerId === c.id && end.standings.map((s) => s.id).join() === [c.id, b.id, a.id].join(), end?.standings);
}

{ // spawn choice
  const { users: [a, b], game } = arena(2);
  const spawns = game.arena.map.spawns;
  const far = (from) => Math.max(...spawns.map((s) => Math.hypot(s.pos[0] - from[0], s.pos[2] - from[2])));
  let ok = true;
  for (let i = 0; i < 10; i++) {
    const s = spawns[i % spawns.length];
    a.p.pos = s.pos.slice();
    b.p.alive = false;
    game.spawnPlayer(b.p);
    const d = Math.hypot(b.p.pos[0] - a.p.pos[0], b.p.pos[2] - a.p.pos[2]);
    if (Math.abs(d - far(a.p.pos)) > 0.01) ok = false;
  }
  check('respawn picks the spawn point farthest from living enemies', ok);
}

{ // capacity: humans outrank bots
  const t = { clock: 1 };
  const game = new Game({ bots: 6, now: () => t.clock, log: () => {} });
  const mk = () => { const u = { inbox: [], closed: false }; u.conn = game.connect({ send: (raw) => u.inbox.push(JSON.parse(raw)), close: () => { u.closed = true; } }); return u; };
  const users = [];
  for (let i = 0; i < MAX_PLAYERS; i++) { const u = mk(); game.receive(u.conn, JSON.stringify({ t: 'hello', v: 1, name: `H${i}` })); users.push(u); }
  check('bots make room for humans up to MAX_PLAYERS', game.players.size === MAX_PLAYERS && game.botList().length === 0 && game.humans().length === MAX_PLAYERS);
  const extra = mk();
  game.receive(extra.conn, JSON.stringify({ t: 'hello', v: 1, name: 'Eleven' }));
  check('server full → error, socket closed, nobody added', extra.inbox[0]?.t === 'error' && extra.closed && game.players.size === MAX_PLAYERS, extra.inbox[0]);
  game.disconnect(users[9].conn);
  game.disconnect(users[8].conn);
  check('bots refill the lobby when humans leave', game.botList().length === 2 && game.players.size === MAX_PLAYERS);
  for (const u of users.slice(0, 8)) game.disconnect(u.conn);
  check('empty server idles in the lobby with its bots', game.phase === PHASE.LOBBY && game.hostId === null && game.botList().length === 6);
}

console.log(`${failed ? 'FAIL' : 'PASS'} — ${total - failed}/${total} card/rule checks`);
process.exit(failed ? 1 : 0);

// Bot soak: runs the real Game in-process on a simulated clock (so minutes take seconds) with one
// idle human and N bots, on pinned seeds, and checks the bots stay sane.
//   node tools/servertest-soak.mjs [--seeds 11,22,33,44,55] [--seconds 60] [--bots 6] [--skill 1] [--verbose]
import { Game, TICK_MS } from '../server/game.js';
import { PHASE } from '../shared/constants.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const seeds = String(arg('seeds', '11,2222,333333,44444444,3055555555')).split(',').map(Number);
const seconds = Number(arg('seconds', 60));
const botCount = Number(arg('bots', 6));
const skill = Number(arg('skill', 1));
const verbose = process.argv.includes('--verbose');

const STILL_WINDOW_S = 6;      // a living bot must move at least STILL_MIN metres in any window this long
const STILL_MIN = 1;

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL  ${msg}`); };

function describe(game, bot) {
  const b = bot.brain;
  const t = game.players.get(b.targetId);
  return JSON.stringify({
    goal: b.goal, pathI: b.pathI, path: b.path && b.path.slice(0, 4), target: t && [t.name, t.pos.map((v) => +v.toFixed(1))],
    visible: b.visible, strafe: b.strafe, ground: b.onGround, stuck: b.stuckCount, vel: bot.vel.map((v) => +v.toFixed(1)), weapon: b.weapon,
  });
}

function runSeed(seed) {
  let clock = 1_700_000_000_000;
  const errors = [];
  const game = new Game({ bots: botCount, now: () => clock, log: (...a) => errors.push(a.map(String).join(' ')) });
  const seen = {};
  const shots = new Map();           // bot id → { fired, landed }
  const conn = game.connect({
    send: (raw) => {
      const m = JSON.parse(raw);
      seen[m.t] = (seen[m.t] || 0) + 1;
      if (m.t === 'fire') {
        const s = shots.get(m.id) || { fired: 0, landed: 0 };
        s.fired += m.hits.length;
        s.landed += m.hits.filter((h) => h.id !== null).length;
        shots.set(m.id, s);
      }
    },
    close() {},
  });
  const say = (m) => game.receive(conn, JSON.stringify(m));
  say({ t: 'hello', v: 1, name: 'Idle Human', color: 0, face: 0 });
  say({ t: 'settings', settings: { bots: botCount, botSkill: skill, killsToWin: 30, roundTime: 600, roundsToWin: 9 } });
  game.seedQueue.push(seed);
  say({ t: 'start' });

  const half = () => game.arena.map.size / 2;
  const track = new Map();           // bot id → { trail: [[t,x,z]], travelled, stillMax, last }
  let cost = 0, worst = 0, ticks = 0, watch = null;
  const totalTicks = Math.round((seconds * 1000) / TICK_MS) + Math.round(4000 / TICK_MS);   // + countdown
  for (let i = 0; i < totalTicks; i++) {
    clock += TICK_MS;
    game.step();
    cost += game.stepMs; worst = Math.max(worst, game.stepMs); ticks++;
    if (game.phase !== PHASE.PLAYING) continue;
    if (watch && watch.left-- > 0) console.log(`    +${24 - watch.left} [${watch.bot.pos.map((v) => v.toFixed(2))}] blocked=${watch.bot.brain.blocked} ${describe(game, watch.bot)}`);
    for (const bot of game.botList()) {
      let tr = track.get(bot.id);
      if (!tr) track.set(bot.id, (tr = { trail: [], travelled: 0, stillMax: 0, last: null, out: 0 }));
      if (!bot.alive) { tr.trail.length = 0; tr.last = null; continue; }
      const [x, y, z] = bot.pos;
      if (y < -0.5 || Math.abs(x) > half() || Math.abs(z) > half() || !Number.isFinite(x + y + z)) tr.out++;
      if (tr.last) tr.travelled += Math.hypot(x - tr.last[0], z - tr.last[1]);
      tr.last = [x, z];
      tr.trail.push([clock, x, z]);
      while (tr.trail.length && clock - tr.trail[0][0] > STILL_WINDOW_S * 1000) tr.trail.shift();
      if (clock - tr.trail[0][0] >= STILL_WINDOW_S * 1000 - TICK_MS) {
        let reach = 0;
        for (const [, px, pz] of tr.trail) reach = Math.max(reach, Math.hypot(px - x, pz - z));
        if (reach < STILL_MIN) {
          if (verbose && !tr.stillMax) { console.log(`  still: ${bot.name} at [${bot.pos.map((v) => v.toFixed(1))}] ${describe(game, bot)}`); watch = { bot, left: 24 }; }
          tr.stillMax = STILL_WINDOW_S;
        }
      }
    }
  }

  const bots = game.botList();
  const kills = bots.map((b) => b.kills);
  const totalKills = kills.reduce((a, c) => a + c, 0);
  const human = game.humans()[0];
  const rescues = bots.reduce((a, b) => a + b.brain.rescues, 0);
  const acc = bots.map((b) => { const s = shots.get(b.id); return s && s.fired ? Math.round((100 * s.landed) / s.fired) : 0; });
  console.log(`seed ${seed} (${game.arena.map.name}): ${seconds}s, ${bots.length} bots skill ${skill} — `
    + `kills [${kills.join(', ')}], human deaths ${human.deaths}, accuracy% [${acc.join(', ')}], rescues ${rescues}, `
    + `${(cost / ticks).toFixed(3)} ms/tick avg, ${worst.toFixed(1)} ms worst`);
  if (verbose) console.log('  messages:', JSON.stringify(seen));

  const tag = `seed ${seed}:`;
  if (errors.length) fail(`${tag} ${errors.length} server errors, first: ${errors[0]}`);
  if (game.phase !== PHASE.PLAYING) fail(`${tag} expected to still be playing, phase is ${game.phase}`);
  for (const bot of bots) {
    const tr = track.get(bot.id);
    if (!tr) { fail(`${tag} ${bot.name} never appeared in play`); continue; }
    if (tr.out) fail(`${tag} ${bot.name} was outside the arena for ${tr.out} ticks`);
    if (tr.stillMax) fail(`${tag} ${bot.name} stood still for ${STILL_WINDOW_S}s+`);
    if (tr.travelled < seconds * 1.5) fail(`${tag} ${bot.name} only travelled ${tr.travelled.toFixed(0)} m`);
  }
  if (bots.length >= 2 && seconds >= 60) {
    if (totalKills < bots.length) fail(`${tag} only ${totalKills} bot kills in ${seconds}s`);
    if (seconds >= 120 && Math.min(...kills) === 0) fail(`${tag} a bot scored no kills in ${seconds}s (stuck?)`);
    if (totalKills && Math.max(...kills) / totalKills > 0.6) fail(`${tag} one bot took ${Math.max(...kills)}/${totalKills} kills`);
  }
  if (cost / ticks > 5) fail(`${tag} tick cost ${(cost / ticks).toFixed(2)} ms is too high`);
  return { cost: cost / ticks, worst, humanDeaths: human.deaths };
}

console.log(`bot soak: ${seeds.length} seed(s) × ${seconds}s simulated, ${botCount} bots, skill ${skill}`);
const t0 = Date.now();
const runs = seeds.map(runSeed);
if (seconds >= 60 && runs.reduce((a, r) => a + r.humanDeaths, 0) === 0) fail('bots never killed the idle human on any seed');
console.log(`${failures.length ? 'FAIL' : 'PASS'} — bot soak (${((Date.now() - t0) / 1000).toFixed(1)}s wall)`);
process.exit(failures.length ? 1 : 0);

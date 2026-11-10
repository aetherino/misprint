// Engine end-to-end tests in headless Chrome.
//   node tools/enginetest.mjs [offline|online|all] [--port 3102] [--seed 7] [--shots] [--stubs]
// --stubs swaps the render / audio / UI modules for recording stand-ins (tools/enginetest-stub-*.mjs):
//         the engine alone, no WebGL — immune to whatever state the other modules are in.
// offline: movement / weapons / practice-range combat against the in-browser fake server, with the
//          game clock driven manually (window.__mp.hold/advance) so results do not depend on fps.
// online:  two browser pages + bots against the real server (`node server.js --fast`): a full match.
// The script starts and stops the servers it needs. Exit code 1 if any check fails.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = ['offline', 'online', 'all'].includes(args[0]) ? args[0] : 'all';
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const port = Number(opt('port', 3102));
const seed = Number(opt('seed', 7));
const wantShots = args.includes('--shots');
const useStubs = args.includes('--stubs');
const base = `http://localhost:${port}`;

// constants mirrored from shared/constants.js + shared/weapons.js (kept literal so a silent change there shows up here)
const G = 24, JUMP = 8.2, AIRJUMP = 7.8, RUN = 8.2, DASH_DIST = 26 * 0.15, SLIDE_TOP = 8.2 + 4.5, WALL_SPEED = 10.5;

let failed = 0;
const problems = [];   // console errors / page errors, with the page they came from
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const fmt = (x) => (typeof x === 'number' ? x.toFixed(3) : JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(cmd, readyText) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', cmd, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { out += d; if (out.includes(readyText)) resolve(child); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

async function openPage(browser, url, label) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // a missing file is reported by the response handler below with its URL
    if (!/Failed to load resource/.test(m.text())) problems.push(`[${label}] console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}\n${e.stack || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${label}] http ${r.status()} ${r.url()}`); });
  if (useStubs) {
    for (const mod of ['render', 'audio', 'ui']) {
      const body = fs.readFileSync(path.join(root, `tools/enginetest-stub-${mod}.mjs`), 'utf8');
      await page.route(`**/js/${mod}/index.js`, (route) => route.fulfill({ body, contentType: 'text/javascript' }));
    }
  }
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mp, null, { timeout: 90000 });
  return page;
}

const info = (page) => page.evaluate(() => window.__mp.info());
const keys = (page, k) => page.evaluate((v) => window.__mp.input(v), k);
const NONE = { fwd: false, back: false, left: false, right: false, jump: false, crouch: false, dash: false, fire: false, rewind: false, reload: false };

// Runs in the page: count the calls the engine makes into UI / render / audio (works on the real
// modules and on the stubs alike). Results in window.__calls.
function installSpies() {
  const mp = window.__mp;
  const calls = (window.__calls = { hitmarker: 0, headshots: 0, killfeed: 0, damageFrom: 0, chat: [], announce: [], screens: [], screenData: {}, countdown: [], draft: null, fx: {}, events: {}, sounds: {} });
  const wrap = (obj, name, fn) => { const orig = obj[name].bind(obj); obj[name] = (...a) => { fn(...a); return orig(...a); }; };
  wrap(mp.UI, 'hitmarker', (e) => { calls.hitmarker++; if (e.headshot) calls.headshots++; });
  wrap(mp.UI, 'killfeed', () => { calls.killfeed++; });
  wrap(mp.UI, 'announce', (text) => { calls.announce.push(text); });
  wrap(mp.UI, 'damageFrom', () => { calls.damageFrom++; });
  wrap(mp.UI, 'chat', (m) => { calls.chat.push(m.text); });
  wrap(mp.UI, 'setScreen', (name, data) => { calls.screens.push(name); calls.screenData[name] = data; });
  wrap(mp.UI, 'countdown', (n) => { calls.countdown.push(n); });
  wrap(mp.UI, 'setDraft', (d) => { calls.draft = d; });
  for (const name of ['tracer', 'impact', 'hitPlayer', 'death', 'explosion', 'flash']) wrap(mp.R.fx, name, () => { calls.fx[name] = (calls.fx[name] || 0) + 1; });
  wrap(mp.R, 'playerEvent', (id, kind) => { calls.events[kind] = (calls.events[kind] || 0) + 1; });
  wrap(mp.A, 'play', (name) => { calls.sounds[name] = (calls.sounds[name] || 0) + 1; });
}

// ───────────────────────────────────────── offline ─────────────────────────────────────────

// Runs in the page: find open test areas in whatever arena the generator produced.
function surveyArena() {
  const map = window.__mp.state.map, half = map.size / 2;
  const blocks = (b, x0, z0, x1, z1) => b.min[0] < x1 && b.max[0] > x0 && b.min[2] < z1 && b.max[2] > z0;
  const inside = (b) => b.max[1] > 0.01 && b.min[0] < half && b.max[0] > -half && b.min[2] < half && b.max[2] > -half;
  const solid = map.boxes.filter(inside);
  const clear = (x0, z0, x1, z1) => !solid.some((b) => blocks(b, x0, z0, x1, z1)) && !map.jumpPads.some((b) => blocks(b, x0, z0, x1, z1));
  // longest obstacle-free strip along X: in the open (`field`) and hugging the +Z wall (`wall`)
  const longest = (z0, z1) => {
    let best = null;
    for (let a = -half + 0.5; a < half; a += 0.5) {
      for (let L = Math.floor(half - 0.5 - a); L >= 10; L--) {
        if (clear(a, z0, a + L, z1)) { if (!best || L > best.L) best = { x: a, L }; break; }
      }
    }
    return best;
  };
  let field = null;
  for (let z = -half + 3; z <= half - 3; z += 0.5) {
    const lane = longest(z - 0.7, z + 0.7);
    if (lane && (!field || lane.L > field.L)) field = { ...lane, z };
  }
  const wall = longest(half - 1.8, half);
  const pad = map.jumpPads[0];
  const health = map.pickups.find((p) => p.type === 'health');
  return { half, field, wall, pad: pad && { x: (pad.min[0] + pad.max[0]) / 2, z: (pad.min[2] + pad.max[2]) / 2, y: pad.min[1], vel: pad.vel }, health };
}

async function offlineSuite(browser) {
  console.log('\n── offline: movement + weapons (manual clock) ──');
  const page = await openPage(browser, `${base}/?offline=1&debug=1&auto=TESTER&seed=${seed}`, 'offline');
  await page.waitForFunction(() => { const i = window.__mp.info(); return i.phase === 'playing' && i.alive; }, null, { timeout: 20000 });
  let i = await info(page);
  check('boot: joined, playing, alive', i.id === 1 && i.players.length === 4 && i.hp === 100 && !i.nan, `map ${i.map}, ${i.players.length} players`);

  const area = await page.evaluate(surveyArena);
  check('arena has test lanes', !!(area.field && area.field.L >= 24 && area.wall && area.wall.L >= 16 && area.pad), JSON.stringify({ field: area.field, wall: area.wall }));
  const laneStart = [area.field.x + 1, 0, area.field.z];
  const EAST = -Math.PI / 2;   // yaw that faces +X

  await page.evaluate(() => window.__mp.hold(true));
  const adv = (seconds, fps = 60) => page.evaluate(([dt, n]) => window.__mp.advance(dt, n), [1 / fps, Math.round(seconds * fps)]);
  // fresh body at the lane start, facing along it, settled on the ground
  const reset = async (pos = laneStart, yaw = EAST, pitch = 0) => {
    await keys(page, NONE);
    await page.evaluate(([p, y, pt]) => { window.__mp.tp(p); window.__mp.look(y, pt); }, [pos, yaw, pitch]);
    await adv(0.25);
  };

  // walk / stop
  await reset();
  await keys(page, { fwd: true });
  await adv(1.5);
  i = await info(page);
  check('run: reaches MOVE.speed', near(i.speed, RUN, 0.02), `speed ${fmt(i.speed)} (want ${RUN})`);
  check('run: travels along the view direction', i.pos[0] - laneStart[0] > 11 && Math.abs(i.pos[2] - laneStart[2]) < 0.01, `dx ${fmt(i.pos[0] - laneStart[0])}`);
  await keys(page, { fwd: false });
  await adv(0.3);
  i = await info(page);
  check('stop: friction halts within 0.3 s', i.speed < 0.01, `speed ${fmt(i.speed)}`);

  // jump apex
  const apex1 = (JUMP * JUMP) / (2 * G);
  await reset();
  await keys(page, { jump: true });
  await adv(JUMP / G);
  i = await info(page);
  check('jump: apex = v²/2g', near(i.apex, apex1, 0.01), `apex ${fmt(i.apex)} (want ${fmt(apex1)})`);
  await keys(page, { jump: false });
  await adv(0.6);
  i = await info(page);
  check('jump: lands, flight recorded', i.onGround && near(i.lastApex, apex1, 0.01), `lastApex ${fmt(i.lastApex)}`);

  // double jump at the apex of the first
  const apex2 = apex1 + (AIRJUMP * AIRJUMP) / (2 * G);
  await reset();
  await keys(page, { jump: true });
  await adv(JUMP / G, 120);
  await keys(page, { jump: false });
  await adv(1 / 120, 120);
  i = await info(page);
  const jumpsBefore = i.airJumps;
  await keys(page, { jump: true });
  await adv(AIRJUMP / G, 120);
  i = await info(page);
  check('double jump: spends the air jump, stacks height', jumpsBefore === 1 && i.airJumps === 0 && near(i.apex, apex2, 0.03), `apex ${fmt(i.apex)} (want ${fmt(apex2)})`);
  await keys(page, { jump: false });
  await adv(1 / 60);
  await keys(page, { jump: true });
  await adv(0.1);
  i = await info(page);
  check('double jump: no third jump', i.vel[1] < 0, `vy ${fmt(i.vel[1])}`);
  await keys(page, { jump: false });
  await adv(1.2);
  i = await info(page);
  check('double jump: air jump restored on landing', i.onGround && i.airJumps === 1);

  // coyote time + jump buffer
  await reset();
  await page.evaluate(() => { const m = window.__mp.G.mover; m.onGround = false; m.coyote = 0.05; });
  await keys(page, { jump: true });
  await adv(1 / 60);
  i = await info(page);
  check('coyote: jump shortly after leaving the ground', i.vel[1] > 7 && i.airJumps === 1, `vy ${fmt(i.vel[1])}`);
  await keys(page, { jump: false });
  await adv(0.62);       // falling again, ~0.05 s before touchdown
  await page.evaluate(() => { window.__mp.G.mover.airJumps = 0; });
  await keys(page, { jump: true });
  await adv(0.12);
  i = await info(page);
  check('jump buffer: press just before landing still jumps', i.vel[1] > 5 && i.airJumps === 1, `vy ${fmt(i.vel[1])}, airJumps ${i.airJumps}`);

  // dash
  await reset();
  await keys(page, { dash: true });
  await adv(0.15);
  i = await info(page);
  check('dash: displacement = dashSpeed × dashTime', near(i.lastDash, DASH_DIST, 0.02) && near(i.pos[0] - laneStart[0], DASH_DIST, 0.05), `dash ${fmt(i.lastDash)} (want ${fmt(DASH_DIST)})`);
  check('dash: charge spent', i.dashCharges === 0);
  await keys(page, { dash: false });
  await adv(1 / 60);
  await keys(page, { dash: true });
  await adv(0.3);
  i = await info(page);
  check('dash: cannot dash without a charge', near(i.lastDash, DASH_DIST, 0.02) && !i.dashing);
  await keys(page, { dash: false });
  await adv(2.3);
  i = await info(page);
  check('dash: recharges after dashCooldown', i.dashCharges === 1);
  await reset([laneStart[0] + 6, 0, laneStart[2]]);
  await keys(page, { back: true, dash: true });
  await adv(0.15);
  i = await info(page);
  check('dash: follows the held direction', near(laneStart[0] + 6 - i.pos[0], DASH_DIST, 0.05), `dx ${fmt(i.pos[0] - laneStart[0] - 6)}`);

  // crouch + slide
  await reset();
  await keys(page, { fwd: true, crouch: true });
  await adv(1);
  i = await info(page);
  check('crouch: walks at crouchSpeed, no slide from rest', near(i.speed, 4.2, 0.02) && i.crouched && !i.sliding, `speed ${fmt(i.speed)}`);
  await reset();
  await keys(page, { fwd: true });
  await adv(1);
  await keys(page, { crouch: true });
  await adv(1 / 60);
  i = await info(page);
  check('slide: starts with run + slideBoost', i.sliding && near(i.speed, SLIDE_TOP, 0.4), `speed ${fmt(i.speed)} (want ≈${SLIDE_TOP})`);
  await adv(0.4);
  i = await info(page);
  const midSlide = i.speed;
  check('slide: low friction keeps speed above a run', i.sliding && midSlide > RUN && midSlide < SLIDE_TOP, `speed after 0.4 s ${fmt(midSlide)}`);
  await adv(1.2);
  i = await info(page);
  check('slide: ends below slideMinSpeed into a crouch walk', !i.sliding && i.crouched && near(i.speed, 4.2, 0.05), `speed ${fmt(i.speed)}`);
  // slide-jump keeps the momentum
  await reset();
  await keys(page, { fwd: true });
  await adv(1);
  await keys(page, { crouch: true });
  await adv(2 / 60);
  await keys(page, { jump: true });
  await adv(0.2);
  i = await info(page);
  check('slide-jump: carries slide speed into the air', !i.onGround && i.speed > 12, `air speed ${fmt(i.speed)}`);

  // air strafing: turning with a strafe key held gains speed in the air
  await reset();
  await keys(page, { fwd: true });
  await adv(1);
  await keys(page, { jump: true });
  await adv(1 / 60);
  await keys(page, { fwd: false, jump: false, left: true });
  const before = (await info(page)).speed;
  for (let k = 0; k < 30; k++) {
    await page.evaluate((y) => window.__mp.look(y, 0), EAST + (k + 1) * 0.02);
    await adv(1 / 60);
  }
  i = await info(page);
  check('air strafe: turning into a held strafe gains speed', i.speed > before + 0.5 && !i.onGround, `${fmt(before)} → ${fmt(i.speed)}`);

  // wall-run along the +Z perimeter wall
  const wallStart = [area.wall.x + 1, 0, area.half - 1.3];
  const INTO_WALL = EAST - 0.45;   // facing +X, angled toward +Z
  await reset(wallStart, INTO_WALL);
  await keys(page, { fwd: true });
  await adv(0.6);
  await keys(page, { jump: true });
  await adv(0.2);
  await keys(page, { jump: false });
  i = await info(page);
  check('wall-run: starts when jumping along a wall', i.wallrun && i.wallSide === 1, `wallrun ${i.wallrun}, side ${i.wallSide}`);
  await adv(0.8);
  i = await info(page);
  check('wall-run: holds height at wallrunSpeed', i.wallrun && i.pos[1] > 0.8 && near(i.speed, WALL_SPEED, 0.3), `y ${fmt(i.pos[1])}, speed ${fmt(i.speed)}`);
  check('wall-run: flags + air jump restored', (i.flags & 16) !== 0 && i.airJumps === 1);
  await adv(0.7);
  i = await info(page);
  check('wall-run: ends after wallrunTime', !i.wallrun, `y ${fmt(i.pos[1])}`);
  await adv(0.3);
  i = await info(page);
  check('wall-run: same wall cannot be re-run right away', !i.wallrun);
  // wall-jump
  await reset(wallStart, INTO_WALL);
  await keys(page, { fwd: true });
  await adv(0.6);
  await keys(page, { jump: true });
  await adv(0.2);
  await keys(page, { jump: false });
  await adv(0.4);
  await keys(page, { jump: true });
  await adv(1 / 60);
  i = await info(page);
  check('wall-jump: kicks out and up', !i.wallrun && near(i.vel[2], -7.5, 0.05) && near(i.vel[1], 8 - G / 60, 0.05), `vz ${fmt(i.vel[2])}, vy ${fmt(i.vel[1])} one frame later`);

  // rewind
  await reset();
  const origin = (await info(page)).pos;
  await keys(page, { fwd: true });
  await adv(3);
  const far = (await info(page)).pos;
  await keys(page, { fwd: false, rewind: true });
  await adv(0.1);
  i = await info(page);
  check('rewind: sweep in progress', i.rewinding && i.pos[0] < far[0] - 1, `x ${fmt(i.pos[0])}`);
  await adv(0.2);
  i = await info(page);
  const back = Math.hypot(i.pos[0] - origin[0], i.pos[2] - origin[2]);
  check('rewind: returns to the position 3 s earlier', !i.rewinding && back < 0.3 && far[0] - origin[0] > 20, `moved ${fmt(far[0] - origin[0])} m, landed ${fmt(back)} m from the 3 s-old spot`);
  check('rewind: cooldown started', near(i.rewindCooldown, 14 - 0.3, 0.1), `cooldown ${fmt(i.rewindCooldown)}`);
  await keys(page, { rewind: false, fwd: true });
  await adv(1);
  await keys(page, { rewind: true });
  await adv(0.2);
  i = await info(page);
  check('rewind: unavailable while cooling down', !i.rewinding && i.speed > 8);

  // jump pad
  await keys(page, NONE);
  await page.evaluate(([p]) => { window.__mp.tp(p); }, [[area.pad.x, area.pad.y + 0.01, area.pad.z]]);
  await adv(1 / 60);
  i = await info(page);
  check('jump pad: launches with the pad velocity', near(i.vel[1], area.pad.vel[1] - G / 60, 0.3) && !i.onGround && near(Math.hypot(i.vel[0], i.vel[2]), Math.hypot(area.pad.vel[0], area.pad.vel[2]), 0.1), `v ${JSON.stringify(i.vel)}`);
  await adv(i.vel[1] / G);
  i = await info(page);
  check('jump pad: apex = v²/2g', near(i.pos[1] - area.pad.y, area.pad.vel[1] ** 2 / (2 * G), 0.1), `height ${fmt(i.pos[1] - area.pad.y)} (want ${fmt(area.pad.vel[1] ** 2 / (2 * G))})`);

  // frame-rate independence: the same input script at different frame rates ends in the same place
  const script = async (fps) => {
    await reset();
    await keys(page, { fwd: true }); await adv(0.5, fps);
    await keys(page, { jump: true }); await adv(0.5, fps);
    await keys(page, { jump: false, crouch: true, right: true }); await adv(0.5, fps);
    await keys(page, { crouch: false, dash: true }); await adv(0.5, fps);
    await keys(page, { dash: false, right: false, jump: true }); await adv(0.5, fps);
    await keys(page, NONE);
    return info(page);
  };
  const runs = {};
  for (const fps of [10, 30, 60, 144]) runs[fps] = await script(fps);
  const ref = runs[60];
  const spread = Math.max(...Object.values(runs).map((r) => Math.hypot(r.pos[0] - ref.pos[0], r.pos[1] - ref.pos[1], r.pos[2] - ref.pos[2])));
  check('frame-rate independence: 10 / 30 / 60 / 144 fps end at the same position', spread < 1e-6 && ref.pos[0] - laneStart[0] > 10,
    `max deviation ${spread.toExponential(2)} m after ${fmt(ref.pos[0] - laneStart[0])} m of run/jump/slide/dash`);

  // ── weapons ──
  await reset();
  i = await info(page);
  check('weapons: full magazines at spawn', JSON.stringify(i.ammoAll) === '[28,4,3,2]' && i.weapon === 0, JSON.stringify(i.ammoAll));
  await keys(page, { fire: true });
  await adv(0.95);
  i = await info(page);
  check('stapler: 600 rpm at 60 fps', i.ammo === 18, `ammo ${i.ammo} after 0.95 s (want 18)`);
  await keys(page, { fire: false });
  await adv(0.5);
  await keys(page, { fire: true });
  await adv(1, 10);
  i = await info(page);
  check('stapler: same fire rate at 10 fps', i.ammo === 8 || i.ammo === 7, `ammo ${i.ammo} after 1 s more (want 8)`);
  await keys(page, { fire: false, reload: true });
  await adv(0.1);
  i = await info(page);
  check('reload: R starts it', i.reloading && (i.flags & 64) !== 0);
  await keys(page, { reload: false });
  await adv(1.4);
  i = await info(page);
  check('reload: refills after the reload time', !i.reloading && i.ammo === 28, `ammo ${i.ammo}`);

  await page.evaluate(() => window.__mp.weapon(1));
  await keys(page, { fire: true });
  await adv(1 / 60);
  i = await info(page);
  check('swap: weapon is not ready during the swap', i.weapon === 1 && i.ammo === 4);
  await adv(0.3);
  i = await info(page);
  check('hole punch: fires once per click, kicks backwards', i.ammo === 3 && i.pos[0] < laneStart[0] - 0.3, `ammo ${i.ammo}, pushed ${fmt(laneStart[0] - i.pos[0])} m`);
  await adv(1.5);
  i = await info(page);
  check('hole punch: holding the trigger does not auto-fire', i.ammo === 3);
  await keys(page, { fire: false });
  await reset(laneStart, EAST, -1.5);
  await keys(page, { fire: true });
  await adv(1 / 60);
  i = await info(page);
  check('punch-jump: aiming down launches upward', i.vel[1] > 8 && i.ammo === 2, `vy ${fmt(i.vel[1])}`);
  await keys(page, { fire: false });

  await reset();
  await page.evaluate(() => window.__mp.weapon(2));
  await adv(0.3);
  await keys(page, { fire: true });
  await adv(0.5);
  i = await info(page);
  check('marker: charges while held', near(i.charge, 0.5 / 0.95, 0.05) && i.ammo === 3 && (i.flags & 128) !== 0, `charge ${fmt(i.charge)}`);
  await adv(0.6);
  i = await info(page);
  check('marker: holds at full charge', i.charge === 1 && i.ammo === 3);
  await keys(page, { fire: false });
  await adv(1 / 60);
  i = await info(page);
  check('marker: fires on release', i.ammo === 2 && i.charge === 0);

  await page.evaluate(() => window.__mp.weapon(3));
  await adv(0.3);
  await keys(page, { fire: true });
  await adv(1 / 60);
  await keys(page, { fire: false });
  i = await info(page);
  check('blotter: launches a bomb', i.ammo === 1 && i.projectiles === 1);
  await adv(2);
  i = await info(page);
  check('blotter: bomb bursts by its fuse', i.projectiles === 0);
  await keys(page, { fire: true });
  await adv(1 / 60);
  await keys(page, { fire: false });
  await adv(0.9);
  i = await info(page);
  check('auto-reload: starts on an empty magazine', i.ammo === 0 && i.reloading);
  await adv(2.2);
  i = await info(page);
  check('auto-reload: refills', i.ammo === 2 && !i.reloading);
  await page.evaluate(() => window.__mp.weapon(0));
  await adv(0.3);
  i = await info(page);
  check('no NaN after the movement + weapon runs', !i.nan);

  // ── practice-range combat in real time ──
  console.log('\n── offline: combat against the range dummies (real time) ──');
  await page.evaluate(installSpies);
  // stand a few meters from dummy 2 with a clear line to it
  const spot = await page.evaluate(async () => {
    const { segmentClear, overlapsWorld } = await import('/shared/physics.js');
    const mp = window.__mp, world = mp.G.world;
    const d = mp.info().players.find((p) => p.id === 2).pos;
    for (let r = 4; r <= 9; r++) {
      for (let a = 0; a < 6.28; a += 0.3) {
        const x = d[0] + Math.cos(a) * r, z = d[2] + Math.sin(a) * r;
        if (!overlapsWorld(world, x, 0.01, z, 0.5, 1.8) && segmentClear(world, [x, 1.6, z], [d[0], 1.5, d[2]]) && segmentClear(world, [x, 0.3, z], [d[0], 0.3, d[2]])) return [x, 0.01, z];
      }
    }
    return null;
  });
  check('range: found a firing spot', !!spot, JSON.stringify(spot));
  await keys(page, NONE);
  await page.evaluate((p) => { window.__mp.tp(p); window.__mp.hold(false); window.__aim = setInterval(() => window.__mp.aimAt(2), 16); }, spot);
  await sleep(400);
  await keys(page, { fire: true });
  // sample the moment the kill lands (the dummy respawns 2.5 s later)
  const atKill = await (await page.waitForFunction(() => {
    const now = window.__mp.info();
    return now.kills >= 1 ? { kills: now.kills, dummyAlive: now.players.find((p) => p.id === 2).alive, calls: window.__calls } : false;
  }, null, { timeout: 20000 })).jsonValue();
  await keys(page, { fire: false });
  const calls = atKill.calls;
  check('stapler kill: server hits → hitmarkers, headshots, kill', calls.hitmarker >= 5 && calls.headshots >= 4 && calls.killfeed === 1 && atKill.kills === 1 && !atKill.dummyAlive, JSON.stringify(atKill));
  check('announcer: first kill of the round', calls.announce.includes('FIRST DRAFT'), JSON.stringify(calls.announce));
  await page.waitForFunction(() => window.__mp.info().players.find((p) => p.id === 2).alive, null, { timeout: 8000 });
  check('dummy respawns', true);

  // blotter: direct hit bursts on contact
  await page.evaluate(() => window.__mp.weapon(3));
  await sleep(500);
  await keys(page, { fire: true });
  await sleep(120);
  await keys(page, { fire: false });
  await page.waitForFunction(() => window.__mp.info().players.find((p) => p.id === 2).hp < 100, null, { timeout: 8000 });
  i = await info(page);
  check('blotter: bursts on a player, splash damage applied', i.players.find((p) => p.id === 2).hp < 100 && i.projectiles === 0, `dummy hp ${i.players.find((p) => p.id === 2).hp}`);
  await page.evaluate(() => clearInterval(window.__aim));

  // blast jump + self damage: the bomb needs its second surface, so shoot the foot of a wall
  await page.evaluate((p) => { window.__mp.tp(p); window.__mp.look(Math.PI, -0.8); }, [area.wall.x + 3, 0.01, area.half - 1.4]);
  await sleep(1100);
  const hpBefore = (await info(page)).hp;
  await keys(page, { fire: true });
  await sleep(120);
  await keys(page, { fire: false });
  await page.waitForFunction((h) => window.__mp.info().hp < h, hpBefore, { timeout: 8000 });
  i = await info(page);
  await page.waitForFunction(() => window.__mp.info().onGround, null, { timeout: 8000 });
  const hop = (await info(page)).lastApex;
  check('blotter at the foot of a wall: self damage + blast jump', i.hp < hpBefore && i.hp > 10 && hop > 0.3, `hp ${hpBefore} → ${i.hp}, blast hop ${fmt(hop)} m`);
  // health pickup
  const hurt = i.hp;
  await page.evaluate((p) => window.__mp.tp([p.pos[0], 0.05, p.pos[2]]), area.health);
  await page.waitForFunction((h) => window.__mp.info().hp > h, hurt, { timeout: 8000 });
  i = await info(page);
  const pk = await page.evaluate((id) => window.__mp.state.pickups.find((p) => p.id === id).active, area.health.id);
  check('pickup: health restores up to +50, pickup goes inactive', i.hp === Math.min(100, hurt + 50) && pk === false, `hp ${hurt} → ${i.hp}`);

  // kill plane
  await page.evaluate(() => window.__mp.tp([0, -40, 0]));
  await page.waitForFunction(() => !window.__mp.info().alive, null, { timeout: 8000 });
  i = await info(page);
  const after = await page.evaluate(() => window.__calls);
  check('kill plane: fell → dead, overview camera, announcement', !i.alive && i.camera === 'orbit' && after.announce.includes('RETURN TO SENDER'), `camera ${i.camera}`);
  await page.waitForFunction(() => window.__mp.info().alive, null, { timeout: 8000 });
  i = await info(page);
  check('respawn: alive again with full hp and ammo', i.alive && i.hp === 100 && i.camera === 'fp' && JSON.stringify(i.ammoAll) === '[28,4,3,2]' && !i.nan);

  if (wantShots) await page.screenshot({ path: path.join(root, 'shots/engine-test-offline.png') });
  await page.close();
}

// ───────────────────────────────────────── online ─────────────────────────────────────────

// Runs in the page: an autopilot that teleports to a spot with line of sight on a living enemy,
// aims at their head and holds the trigger. window.__hunt.only pins it to one player id.
async function installHunter() {
  const { segmentClear, overlapsWorld } = await import('/shared/physics.js');
  const mp = window.__mp;
  const hunt = (window.__hunt = { only: null, on: true });
  const spotNear = (world, d) => {
    for (let r = 5; r <= 12; r++) {
      for (let a = 0; a < 6.28; a += 0.4) {
        const x = d[0] + Math.cos(a) * r, z = d[2] + Math.sin(a) * r, y = d[1] + 0.02;
        if (!overlapsWorld(world, x, y, z, 0.5, 1.8) && overlapsWorld(world, x, y - 0.3, z, 0.3, 0.2) &&
            segmentClear(world, [x, y + 1.6, z], [d[0], d[1] + 1.5, d[2]])) return [x, y, z];
      }
    }
    return null;
  };
  let movedAt = 0;
  setInterval(() => {
    const i = mp.info(), world = mp.G.world;
    const foes = i.players.filter((p) => p.id !== i.id && p.alive && p.pos && (hunt.only === null || p.id === hunt.only));
    if (!hunt.on || i.phase !== 'playing' || !i.alive || !foes.length) { mp.input({ fire: false }); return; }
    foes.sort((a, b) => Math.hypot(a.pos[0] - i.pos[0], a.pos[2] - i.pos[2]) - Math.hypot(b.pos[0] - i.pos[0], b.pos[2] - i.pos[2]));
    const t = foes[0];
    const seen = segmentClear(world, [i.pos[0], i.pos[1] + 1.6, i.pos[2]], [t.pos[0], t.pos[1] + 1.5, t.pos[2]]);
    const far = Math.hypot(t.pos[0] - i.pos[0], t.pos[2] - i.pos[2]) > 16;
    if ((!seen || far) && performance.now() - movedAt > 300) {
      const spot = spotNear(world, t.pos);
      if (spot) { mp.tp(spot); movedAt = performance.now(); }
    }
    mp.aimAt(t.id);
    mp.input({ fire: performance.now() - movedAt > 150 });   // let the server learn the new position first
  }, 30);
}

async function onlineSuite(browser) {
  console.log('\n── online: two pages + bots against the real server (--fast) ──');
  const A = await openPage(browser, `${base}/?debug=1&auto=ALPHA&color=0&face=0`, 'A');
  await A.waitForFunction(() => window.__mp.info().phase === 'lobby', null, { timeout: 20000 });
  const B = await openPage(browser, `${base}/?debug=1&auto=BRAVO&color=1&face=1`, 'B');
  await B.waitForFunction(() => window.__mp.info().phase === 'lobby' && window.__mp.info().players.length >= 4, null, { timeout: 20000 });
  await A.evaluate(installSpies);
  await B.evaluate(installSpies);
  const waitPhase = (page, phase, timeout = 90000) => page.waitForFunction((p) => window.__mp.info().phase === p, phase, { timeout });
  const st = (page) => page.evaluate(() => { const s = window.__mp.state; return { id: s.id, hostId: s.hostId, phase: s.phase, round: s.round, seed: s.seed, settings: s.settings, winnerId: s.winnerId, draft: { options: s.draft.options, isWinner: s.draft.isWinner, picked: s.draft.picked } }; });

  let a = await info(A), b = await info(B);
  let sa = await st(A), sb = await st(B);
  check('lobby: both joined, same roster, first human is host', a.players.length === 4 && b.players.length === 4 && sa.hostId === a.id && sb.hostId === a.id && a.id !== b.id &&
    a.players.filter((p) => p.isBot).length === 2, `ids ${a.id}/${b.id}, players ${a.players.map((p) => p.name).join(', ')}`);

  await A.evaluate(() => window.__mp.actions.setMatchSettings({ killsToWin: 3, roundsToWin: 2, roundTime: 60, botSkill: 0 }));
  await B.waitForFunction(() => window.__mp.state.settings.killsToWin === 3 && window.__mp.state.settings.roundsToWin === 2, null, { timeout: 5000 });
  check('lobby: host settings reach the other client', true);
  await A.evaluate(() => window.__mp.actions.chat('hello from A'));
  await B.waitForFunction(() => window.__calls.chat.includes('hello from A'), null, { timeout: 5000 });
  check('chat: relayed to the other client', true);

  // phases can be shorter than a slow headless frame, so wait on what was seen rather than on what is current
  const waitRound = (page, n) => page.waitForFunction((r) => window.__mp.state.round >= r && window.__mp.info().phase === 'playing', n, { timeout: 60000 });
  const waitScreen = (page, name, timeout = 100000) => page.waitForFunction((n) => window.__calls.screens.includes(n), name, { timeout });
  await A.evaluate(() => window.__mp.actions.start());
  await waitRound(A, 1); await waitRound(B, 1);
  sa = await st(A); sb = await st(B);
  a = await info(A); b = await info(B);
  check('countdown: same arena on both clients', sa.seed === sb.seed && a.map === b.map && !!a.map, `seed ${sa.seed}, ${a.map}`);
  await A.waitForFunction(() => window.__mp.info().alive, null, { timeout: 5000 });
  await B.waitForFunction(() => window.__mp.info().alive, null, { timeout: 5000 });
  const cd = await A.evaluate(() => window.__calls);
  check('countdown: ticks shown, GO at the start, HUD screen', cd.countdown.includes(1) && cd.countdown.includes(0) && cd.screens.includes('game'), JSON.stringify(cd.countdown));

  // A hunts B
  await A.evaluate(installHunter);
  await A.evaluate((id) => { window.__hunt.only = id; }, b.id);
  const bDead = await (await B.waitForFunction(() => {
    const i = window.__mp.info();
    return !i.alive ? { camera: i.camera, hp: i.hp, calls: window.__calls, killerName: window.__mp.G.me.killerName } : false;
  }, null, { timeout: 40000 })).jsonValue();
  check('victim: took directional damage, died, death cam', bDead.calls.damageFrom >= 1 && bDead.calls.killfeed >= 1 && bDead.hp === 0 && (bDead.camera === 'death' || bDead.camera === 'orbit') &&
    bDead.killerName.length > 0 && !bDead.calls.announce.some((t) => /REDACTED|RETURN TO SENDER/.test(t)),   // the HUD death card names the killer; no duplicate banner
    JSON.stringify({ camera: bDead.camera, damageFrom: bDead.calls.damageFrom, killerName: bDead.killerName, announce: bDead.calls.announce }));
  check('victim: saw the shooter fire (tracers, fire event, hit splat)', bDead.calls.fx.tracer >= 1 && bDead.calls.events.fire >= 1 && bDead.calls.fx.hitPlayer >= 1, JSON.stringify({ fx: bDead.calls.fx, events: bDead.calls.events }));
  await A.waitForFunction((id) => window.__mp.info().kills >= 1 && window.__mp.info().players.find((p) => p.id === id).deaths >= 1, b.id, { timeout: 5000 });
  await B.waitForFunction((id) => window.__mp.info().players.find((p) => p.id === id).kills >= 1, a.id, { timeout: 5000 });
  const ca = await A.evaluate(() => window.__calls);
  check('shooter: hitmarkers, kill feedback, roster scores on both clients', ca.hitmarker >= 2 && ca.killfeed >= 1 && ca.sounds.kill >= 1 && ca.fx.death >= 1 && ca.announce.length >= 1, JSON.stringify({ hitmarker: ca.hitmarker, headshots: ca.headshots, announce: ca.announce }));
  await A.evaluate(() => { window.__hunt.on = false; });
  await B.waitForFunction(() => { const i = window.__mp.info(); return i.alive && i.camera === 'fp' && i.hp === i.maxHp; }, null, { timeout: 15000 });
  check('victim respawns with full hp, back in first person', true);
  // interpolation: A's picture of (stationary) B matches B's own position
  await sleep(600);
  b = await info(B);
  const bSeen = (await info(A)).players.find((p) => p.id === b.id);
  check('remote interpolation: A draws B where B is', !!bSeen.pos && Math.hypot(bSeen.pos[0] - b.pos[0], bSeen.pos[1] - b.pos[1], bSeen.pos[2] - b.pos[2]) < 0.3 || !bSeen.alive, JSON.stringify({ seen: bSeen.pos, actual: b.pos }));

  // late joiner spectates until spawned
  const C = await openPage(browser, `${base}/?debug=1&auto=CHARLIE`, 'C');
  const cFirst = await (await C.waitForFunction(() => { const i = window.__mp.info(); return i.id !== null && i.phase !== 'lobby' && i.phase !== 'connecting' ? { phase: i.phase, alive: i.alive, camera: i.camera, map: i.map } : false; }, null, { timeout: 60000 })).jsonValue();
  // rounds are seconds long under --fast, so compare arenas until both pages are sampled in the same round
  let sameArena = false;
  for (let k = 0; k < 20 && !sameArena; k++) {
    const [x, y] = await Promise.all([st(A), st(C)]);
    sameArena = x.seed === y.seed && x.round === y.round;
    if (!sameArena) await sleep(250);
  }
  check('late join: arrives mid-match as a spectator in the same arena', sameArena && !!cFirst.map && (cFirst.alive || cFirst.camera === 'orbit'), JSON.stringify(cFirst));
  await A.evaluate(() => { window.__hunt.on = true; });

  // play the match out: A hunts everyone; a page-side recorder drafts the first card offered the
  // moment it appears and logs arenas + everyone's cards (phases are short under --fast)
  await A.evaluate(() => { window.__hunt.only = null; });
  const record = () => {
    const mp = window.__mp, log = (window.__log = { seeds: [], picked: [], confirmed: [], cardsSeen: {}, winnerDrafts: 0 });
    setInterval(() => {
      const s = mp.state;
      if ((s.phase === 'countdown' || s.phase === 'playing') && log.seeds[log.seeds.length - 1] !== s.seed) log.seeds.push(s.seed);
      for (const p of mp.G.players.values()) for (const c of p.cards) (log.cardsSeen[p.id] ||= []).includes(c) || log.cardsSeen[p.id].push(c);
      if (s.phase !== 'draft') { log.asked = false; return; }
      if (s.draft.picked && !log.confirmed.includes(s.draft.picked)) log.confirmed.push(s.draft.picked);
      if (log.asked) return;
      if (s.draft.isWinner) { log.asked = true; log.winnerDrafts++; }
      else if (s.draft.options.length) { log.asked = true; log.picked.push(s.draft.options[0]); mp.actions.pickCard(s.draft.options[0]); }
    }, 50);
  };
  await A.evaluate(record);
  await B.evaluate(record);
  await waitScreen(A, 'matchEnd', 400000);
  const end = await A.evaluate(() => ({ data: window.__calls.screenData.roundEnd, sounds: window.__calls.sounds, screens: window.__calls.screens }));
  check('roundEnd: screen with full standings', !!end.data && end.data.standings.length >= 4 && end.data.standings.every((r) => typeof r.name === 'string' && typeof r.kills === 'number') && end.data.winnerId !== null && (end.sounds.round_win || end.sounds.round_lose) >= 1,
    end.data ? `winner ${end.data.winnerId}, ${end.data.standings.map((r) => `${r.name}:${r.kills}`).join(' ')}` : 'no data');
  const la = await A.evaluate(() => window.__log), lb = await B.evaluate(() => window.__log);
  const seeds = la.seeds;
  const seenBy = (log, id, cards) => cards.every((c) => (log.cardsSeen[id] || []).includes(c));
  check('draft: screen shown, losers pick a card, winner prints nothing', end.screens.includes('draft') && la.picked.length + lb.picked.length >= 1 && la.picked.length + la.winnerDrafts >= 1,
    `A picked [${la.picked}] (winner ${la.winnerDrafts}×), B picked [${lb.picked}] (winner ${lb.winnerDrafts}×)`);
  check('draft: picks confirmed and visible to the other client', seenBy(la, a.id, la.picked) && seenBy(lb, a.id, la.picked) && seenBy(lb, b.id, lb.picked) && seenBy(la, b.id, lb.picked) && la.confirmed.length === la.picked.length && lb.confirmed.length === lb.picked.length);
  check('every round used a new arena', seeds.length >= 2 && new Set(seeds).size === seeds.length, `seeds ${seeds.join(', ')}`);
  await waitScreen(B, 'matchEnd', 10000);
  const me = await A.evaluate(() => ({ data: window.__calls.screenData.matchEnd, sounds: window.__calls.sounds }));
  check('matchEnd: screen with winner + standings', !!me.data && me.data.winnerId !== null && me.data.standings.length >= 4 && (me.sounds.match_win || me.sounds.match_lose) >= 1, `after ${seeds.length} rounds`);
  await waitPhase(A, 'lobby', 30000); await waitPhase(B, 'lobby', 30000);
  a = await info(A);
  check('back to lobby: cards and wins reset', a.players.every((p) => p.cards.length === 0 && p.wins === 0) && !a.alive && a.camera === 'orbit' && !a.nan);
  for (const [page, label] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
    const i = await info(page);
    check(`no NaN on page ${label}`, !i.nan);
  }
  if (wantShots) await A.screenshot({ path: path.join(root, 'shots/engine-test-online.png') });
  return [A, B, C];
}

// ───────────────────────────────────────── main ─────────────────────────────────────────

const browser = await launchBrowser();
let server = null;
try {
  if (mode !== 'online') {
    server = await startServer(['tools/static.mjs', String(port)], 'static dev server');
    await offlineSuite(browser);
    server.kill();
    server = null;
  }
  if (mode !== 'offline') {
    server = await startServer(['server.js', '--port', String(port), '--fast', '--bots', '2'], 'MISPRINT');
    const [A, B] = await onlineSuite(browser);
    // losing the server must land on the error screen, and from there back to the menu
    server.kill();
    server = null;
    await A.waitForFunction(() => window.__calls.screens.includes('error'), null, { timeout: 15000 });
    const err = await A.evaluate(() => { const d = window.__calls.screenData.error; window.__mp.actions.backToMenu(); return { message: d && d.message, screens: window.__calls.screens.slice(-2), phase: window.__mp.info().phase }; });
    check('disconnect: error screen with a message, then back to menu', !!err.message && err.screens.join() === 'error,menu' && err.phase === 'menu', JSON.stringify(err));
    await B.waitForFunction(() => window.__calls.screens.includes('error'), null, { timeout: 15000 });
  }
} catch (err) {
  failed++;
  console.log(`FAIL  test run aborted — ${err.stack || err}`);
} finally {
  if (server) server.kill();
  await browser.close();
}

check('zero console errors / page errors / failed requests', problems.length === 0, problems.length ? `\n  ${[...new Set(problems)].join('\n  ')}` : '');
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

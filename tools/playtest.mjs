// Lead's integration playtest: real server + N headless clients + bots; screenshots per phase.
//   node tools/playtest.mjs [--port 3110] [--clients 2] [--fast] [--secs 40] [--tag x]
import { spawn } from 'node:child_process';
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] ?? true) : d; };
const port = Number(opt('port', 3110));
const nClients = Number(opt('clients', 2));
const secs = Number(opt('secs', 40));
const tag = opt('tag', 'play');
const fast = args.includes('--fast');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', ['server.js', '--port', String(port), ...(fast ? ['--fast'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; process.stdout.write('[server.err] ' + d); });
await sleep(800);

const browser = await launchBrowser();
const errors = [];
const pages = [];
const names = ['Inky', 'Pulp', 'Gutter', 'Smudge'];
for (let i = 0; i < nClients; i++) {
  const page = await browser.newPage({ viewport: { width: Number(opt('w', 1280)), height: Number(opt('h', 720)) } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[p${i} ${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[p${i} pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`[p${i} http ${r.status()}] ${r.url()}`); });
  await page.goto(`http://localhost:${port}/?auto=${names[i]}&debug=1&color=${i}&face=${i}&ktw=${opt('ktw', 4)}`, { waitUntil: 'load' });
  pages.push(page);
  await sleep(1200);
}
const info = (p) => p.evaluate(() => { try { return window.__mp.info(); } catch (e) { return { err: String(e) }; } });
const shot = async (label) => { for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: `shots/${tag}-${label}-p${i}.png` }); };

await sleep(1500);
await shot('lobby');
console.log('lobby', JSON.stringify(await info(pages[0])).slice(0, 300));
await pages[0].evaluate(() => { const a = window.__mp.actions; a.setMatchSettings({ bots: 3, killsToWin: Number(new URLSearchParams(location.search).get('ktw') || 4), roundsToWin: 2, botSkill: 1 }); });
await sleep(500);
await pages[0].evaluate(() => window.__mp.actions.start());
await sleep(fast ? 600 : 2000);
await shot('countdown');

// simple autopilot for each client: run around, aim at the nearest living player, fire
const pilot = () => {
  const mp = window.__mp; const i = mp.info();
  if (!i.alive || i.phase !== 'playing') { mp.input({ fwd: false, fire: false }); return; }
  let best = null, bd = 1e9;
  for (const p of i.players) { if (p.id === i.id || !p.alive) continue; const d = Math.hypot(p.pos[0] - i.pos[0], p.pos[2] - i.pos[2]); if (d < bd) { bd = d; best = p; } }
  if (best) mp.aimAt(best.id);
  mp.input({ fwd: bd > 8, left: Math.floor(performance.now() / 900) % 2 === 0, right: Math.floor(performance.now() / 900) % 2 === 1, fire: !!best && bd < 45, jump: Math.random() < 0.05 });
};
const t0 = Date.now();
let lastPhase = '', n = 0;
const seen = new Set();
while (Date.now() - t0 < secs * 1000) {
  for (const p of pages) await p.evaluate(pilot).catch(() => {});
  const i = await info(pages[0]);
  if (i.phase !== lastPhase) {
    lastPhase = i.phase; console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)} phase=${i.phase} fps=${i.fps} hp=${i.hp}`);
    if (!seen.has(i.phase) || i.phase === 'playing') { await sleep(i.phase === 'draft' ? 1400 : 500); await shot(`${i.phase}${seen.has(i.phase) ? ++n : ''}`); seen.add(i.phase); }
    if (i.phase === 'draft') { for (const p of pages) await p.keyboard.press('Digit2'); await sleep(1200); await shot(`picked${n}`); }
  }
  if (i.phase === 'playing' && Math.random() < Number(opt('midp', 0.08))) await shot(`mid${++n}`);
  if (i.phase === 'playing' && !i.alive && !seen.has('dead')) { seen.add('dead'); await shot('dead'); }
  if (i.phase === 'playing' && !seen.has('score') && Date.now() - t0 > 15000) { seen.add('score'); await pages[0].evaluate(() => window.__mp.UI.showScoreboard(true)); await sleep(400); await shot('score'); await pages[0].evaluate(() => window.__mp.UI.showScoreboard(false)); }
  await sleep(350);
}
await shot('end');
console.log('final', JSON.stringify(await info(pages[0])).slice(0, 600));
console.log(`errors: ${errors.length}`);
[...new Set(errors)].slice(0, 25).forEach((e) => console.log(e));
await browser.close();
server.kill();
console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-6).join('\n'));

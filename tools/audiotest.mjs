// Audio measurement + assertion run (nobody can listen in CI, so we measure).
//   node tools/audiotest.mjs [--only sounds,loops,music,mix,live,shots] [--port 3104] [--json out.json]
// Serves the client with tools/static.mjs, opens public/dev/audiotest.html in headless Chrome,
// renders every sound / loop / music state through OfflineAudioContexts, prints the numbers,
// asserts the loudness + design rules, writes shots/audio-*.png, then exercises a live AudioContext.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const port = Number(opt('port', 3104));
const only = opt('only', 'sounds,loops,music,mix,live,shots').split(',');
const want = (k) => only.includes(k);

const CEILING_DB = -1;
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); return ok; };
const pad = (v, n) => String(v ?? '-').padStart(n);
const row = (name, m, extra = '') =>
  `${name.padEnd(30)}${pad(m.dur, 7)}${pad(m.peakDb, 7)}${pad(m.rmsDb, 7)}${pad(m.crestDb, 7)}${pad(m.centroid, 7)}${pad(m.attackDb, 7)}${pad(m.dc, 9)}${pad(m.clip, 5)}  ${extra}`;
const HEADER = `${'name'.padEnd(30)}${pad('dur s', 7)}${pad('peak', 7)}${pad('rms', 7)}${pad('crest', 7)}${pad('cent', 7)}${pad('atk10', 7)}${pad('dc', 9)}${pad('clip', 5)}`;

/** Rules every rendered thing must pass. */
function sane(name, m) {
  check(!m.silent, `${name}: silent`);
  check(m.clip === 0, `${name}: ${m.clip} clipped samples`);
  check(m.peakDb <= CEILING_DB, `${name}: peak ${m.peakDb} dBFS above ${CEILING_DB}`);
  check(Math.abs(m.dc) < 0.002, `${name}: DC offset ${m.dc}`);
}

// audible (-40 dB) duration windows in seconds: [min, max]
const DURATION = {
  fire_stapler: [0.03, 0.25], fire_punch: [0.2, 0.9], fire_marker: [0.08, 0.7], fire_blotter: [0.12, 0.7],
  explode: [0.6, 1.6], impact: [0.01, 0.15], ricochet: [0.05, 0.4], bounce: [0.06, 0.4], dry: [0.01, 0.15],
  reload_start: [0.08, 0.4], reload_end: [0.1, 0.45], switch: [0.05, 0.3],
  hit: [0.01, 0.12], hit_head: [0.03, 0.4], kill: [0.2, 0.9], hurt: [0.05, 0.4], die: [0.5, 1.5], second_draft: [0.8, 2.2],
  footstep: [0.02, 0.15], jump: [0.05, 0.3], airjump: [0.08, 0.35], land: [0.05, 0.4], dash: [0.12, 0.5],
  slide_start: [0.1, 0.5], walljump: [0.06, 0.35], jumppad: [0.25, 0.8], rewind: [0.3, 0.9],
  pickup_health: [0.2, 0.8], pickup_overprint: [0.6, 1.8], overprint_end: [0.3, 0.9], spawn: [0.3, 0.8], pickup_respawn: [0.08, 0.6],
  countdown_tick: [0.03, 0.3], countdown_go: [0.25, 0.9], round_win: [0.6, 1.6], round_lose: [0.6, 1.6],
  match_win: [1.2, 2.8], match_lose: [1.2, 2.8], announce: [0.3, 1.2], streak: [0.2, 0.8],
  card_reveal: [0.12, 0.45], card_hover: [0.005, 0.12], card_pick: [0.2, 0.9],
  ui_hover: [0.005, 0.12], ui_click: [0.005, 0.12], ui_back: [0.03, 0.2], ui_toggle: [0.01, 0.12],
  chat: [0.08, 0.4], join: [0.15, 0.6], leave: [0.15, 0.6],
};
// sounds whose loudest moment must sit inside the first 10 ms (peak there within 3 dB of the max)
const SHARP = ['fire_stapler', 'fire_blotter', 'explode', 'impact', 'ricochet', 'dry', 'hit', 'hit_head', 'hurt', 'land', 'footstep', 'ui_hover', 'ui_click', 'card_hover', 'card_pick', 'countdown_tick'];

const server = spawn(process.execPath, [path.join(root, 'tools/static.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));

const browser = await launchBrowser();
const report = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('404')) console.log(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => { console.log(`[pageerror] ${e.message}\n${e.stack || ''}`); failures.push(`page error: ${e.message}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) console.log(`[http ${r.status()}] ${r.url()}`); });
  await page.goto(`http://localhost:${port}/dev/audiotest.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.T, null, { timeout: 15000 });
  const T = (fn, ...a) => page.evaluate(([f, x]) => window.T[f](...x), [fn, a]);
  const names = await page.evaluate(() => ({ sounds: window.T.SOUNDS, loops: window.T.LOOPS, states: window.T.STATES, bpm: window.T.bpm }));

  // ---------------------------------------------------------------- one-shots
  if (want('sounds')) {
    console.log('\n== one-shots (through the full chain, default sliders) ==\n' + HEADER);
    const S = (report.sounds = {});
    for (const name of names.sounds) {
      const m = (S[name] = await T('sound', name));
      console.log(row(name, m));
      sane(name, m);
      const [lo, hi] = DURATION[name] || [0.005, 2.8];
      check(m.dur >= lo && m.dur <= hi, `${name}: audible duration ${m.dur}s outside ${lo}-${hi}s`);
      if (SHARP.includes(name)) check(m.attackDb >= -3, `${name}: soft attack (${m.attackDb} dB in first 10 ms)`);
    }
    check(names.sounds.every((n) => DURATION[n]), 'a sound has no duration rule');
    // variants used by the engine
    const tap = (report.markerTap = await T('sound', 'fire_marker', { vol: 0.45, pitch: 0.92, label: 'fire_marker (tap)' }));
    console.log(row('fire_marker vol .45 pitch .92', tap));
    const softLand = await T('sound', 'land', { vol: 0.3, label: 'land (soft)' });
    console.log(row('land vol .3', softLand));

    check(S.hit.centroid > 3000, `hit centroid ${S.hit.centroid} Hz should be > 3 kHz`);
    check(S.hurt.centroid < 900, `hurt centroid ${S.hurt.centroid} Hz should be < 900 Hz`);
    check(S.hit.centroid > 4 * S.hurt.centroid, 'hit must sit far above hurt spectrally');
    check(S.hit_head.centroid > S.hit.centroid, 'hit_head should be brighter than hit');
    check(S.hit_head.dur > S.hit.dur, 'hit_head should ring longer than hit');
    for (const w of ['fire_stapler', 'fire_punch', 'fire_marker', 'fire_blotter', 'bounce', 'impact', 'ricochet']) {
      check(S.explode.peakDb > S[w].peakDb && S.explode.rmsDb + 10 * Math.log10(S.explode.dur) > S[w].rmsDb + 10 * Math.log10(S[w].dur) + 3,
        `explode must be clearly bigger than ${w}`);
    }
    check(S.fire_marker.peakDb > tap.peakDb + 2, 'charged marker shot should be louder than a tap');
    check(S.land.peakDb > softLand.peakDb + 6 && softLand.centroid > S.land.centroid, 'soft landing should be quieter and lighter');
    for (const ui of ['ui_hover', 'ui_click', 'ui_back', 'ui_toggle', 'card_hover']) {
      check(S[ui].peakDb < S.hit.peakDb - 6, `${ui} (${S[ui].peakDb}) should be well below hit (${S.hit.peakDb})`);
      check(S[ui].peakDb < -20, `${ui} too loud for a UI tick (${S[ui].peakDb} dBFS)`);
    }
    check(S.kill.peakDb >= S.hit.peakDb, 'kill should be at least as loud as hit');
    check(S.footstep.peakDb < S.fire_stapler.peakDb - 8, 'footsteps should sit well under gunfire');

    const train = (report.staplerTrain = await T('staplerTrain'));
    console.log(`\nstapler at 600 rpm: envelope dips ${train.minDipDb} dB (min) / ${train.meanDipDb} dB (mean) between shots, peak ${train.peakDb} dBFS`);
    check(train.minDipDb >= 15, `stapler turns to mush at 10/s (only ${train.minDipDb} dB between shots)`);
  }

  // ---------------------------------------------------------------- loops
  if (want('loops')) {
    console.log('\n== loops (steady state) ==\n' + HEADER);
    const L = (report.loops = {});
    for (const name of names.loops) {
      const m = (L[name] = await T('loop', name));
      console.log(row(name, m, `loop ${m.loopLen}s seam ${m.seam}`));
      sane(`loop ${name}`, m);
      check(m.seam <= 1, `loop ${name}: discontinuity at the loop point (${m.seam}× the largest in-loop step)`);
      check(m.peakDb < -12, `loop ${name} too loud (${m.peakDb} dBFS)`);
    }
    const lo = await T('loop', 'charge', { vol: 1, pitch: 0.5, label: 'loop:charge pitch 0.5' });
    const hi = await T('loop', 'charge', { vol: 1, pitch: 2, label: 'loop:charge pitch 2' });
    console.log(row('charge pitch 0.5', lo) + '\n' + row('charge pitch 2', hi));
    check(hi.centroid > 2.5 * lo.centroid, 'charge loop pitch must follow opts.pitch');
    const calm = await T('loop', 'wind', { vol: 0.3, pitch: 0.7, label: 'loop:wind slow' });
    const fast = await T('loop', 'wind', { vol: 1, pitch: 1.6, label: 'loop:wind fast' });
    console.log(row('wind vol .3 pitch .7', calm) + '\n' + row('wind vol 1 pitch 1.6', fast));
    check(fast.rmsDb > calm.rmsDb + 6 && fast.centroid > calm.centroid, 'wind loop must follow vol/pitch');
  }

  // ---------------------------------------------------------------- music
  if (want('music')) {
    console.log('\n== music (16 bars each) ==\n' + HEADER);
    const M = (report.music = {});
    for (const state of names.states) {
      for (const i of [0, 0.5, 1]) {
        const key = `${state}@${i}`, m = (M[key] = await T('music', state, i, 16));
        console.log(row(`music ${key}`, m, `${m.onsetsPerSec} on/s beat ${m.beatPeriodicity} bar ${m.barPeriodicity} Δphrase ${m.phraseChange} ${m.key} bands% sub ${m.bands.sub} low ${m.bands.low} mid ${m.bands.mid} hit ${m.bands.hitSlot} air ${m.bands.air}`));
        sane(`music ${key}`, m);
        check(m.onsetsPerSec > 1.5, `music ${key}: no rhythm (${m.onsetsPerSec} onsets/s)`);
        check(m.barPeriodicity > 0.15, `music ${key}: no bar-level structure (${m.barPeriodicity})`);
        check(m.phraseChange > 0.02, `music ${key}: every 4-bar phrase is identical`);
        check(m.bands.hitSlot < 12, `music ${key}: ${m.bands.hitSlot}% of energy in the hit tick's 2.5-6 kHz slot`);
      }
    }
    const [c0, c5, c1] = [M['combat@0'], M['combat@0.5'], M['combat@1']];
    check(c0.rmsDb < c5.rmsDb && c5.rmsDb < c1.rmsDb, `combat RMS must rise with intensity (${c0.rmsDb} / ${c5.rmsDb} / ${c1.rmsDb})`);
    check(c0.centroid < c5.centroid && c5.centroid < c1.centroid, `combat brightness must rise with intensity (${c0.centroid} / ${c5.centroid} / ${c1.centroid})`);
    check(c0.onsetsPerSec < c5.onsetsPerSec && c5.onsetsPerSec < c1.onsetsPerSec, `combat density must rise with intensity (${c0.onsetsPerSec} / ${c5.onsetsPerSec} / ${c1.onsetsPerSec})`);
    check(M['menu@0'].rmsDb < c1.rmsDb, 'menu should be more laid back than full combat');
    check(M['draft@0'].rmsDb < M['menu@0'].rmsDb && M['draft@0'].centroid < M['menu@0'].centroid, 'draft should be quieter and darker than menu');

    const keys = new Set([c1.key]);
    for (const seed of [1, 2, 3, 4, 5]) keys.add((await T('music', 'combat', 1, 4, seed)).key);
    console.log(`keys/progressions across 6 seeds: ${[...keys].join('  ')}`);
    check(keys.size >= 4, 'different seeds should give different keys/progressions');

    const tr = (report.transitions = await T('transitions'));
    console.log(row('menu→combat→draft→off', tr, `max step ${tr.maxSampleStep} (steady combat ${c1.maxSampleStep}) tail ${tr.tailAfterOffDb} dB`));
    sane('transitions', tr);
    check(tr.maxSampleStep <= c1.maxSampleStep * 1.3 + 0.02, `click at a music transition (step ${tr.maxSampleStep} vs ${c1.maxSampleStep} steady)`);
    check(tr.tailAfterOffDb === null || tr.tailAfterOffDb < -70, `music('off') leaves ${tr.tailAfterOffDb} dBFS behind`);
  }

  // ---------------------------------------------------------------- mix
  if (want('mix')) {
    console.log('\n== mix ==');
    const cal = (report.calibration = await T('calibration'));
    console.log(`compressor make-up after trim: ${cal.lowLevelGainDb} dB at -40 dBFS (want 0)`);
    check(Math.abs(cal.lowLevelGainDb) < 0.6, `master chain is not unity for quiet signals (${cal.lowLevelGainDb} dB)`);

    const worst = (report.worstCase = await T('worstCase'));
    console.log(HEADER + '\n' + row('worst case, sliders at max', worst, `${worst.kneePercent}% in soft-clip knee`));
    check(worst.peakDb <= CEILING_DB, `worst-case mix peaks at ${worst.peakDb} dBFS`);
    check(worst.clip === 0, 'worst-case mix clips');
    check(worst.kneePercent < 5, `limiter is doing the mixing (${worst.kneePercent}% of samples in the knee)`);

    const both = await T('firefight', true, true), sfx = await T('firefight', false, true), music = await T('firefight', true, false);
    report.firefight = { both, sfx, music };
    console.log(row('firefight sfx+music', both) + '\n' + row('firefight sfx only', sfx) + '\n' + row('combat music only (0.8)', music));
    check(music.rmsDb <= sfx.rmsDb - 3, `music (${music.rmsDb}) must sit under combat sfx (${sfx.rmsDb})`);
    check(both.peakDb <= CEILING_DB, 'firefight peaks above ceiling');

    const hit = (report.hitAudibility = await T('hitAudibility'));
    console.log(`hit tick vs full music + own stapler in the 3-6.5 kHz slot: +${hit.hitOverBedDb} dB`);
    check(hit.hitOverBedDb >= 8, `hit tick is masked (only +${hit.hitOverBedDb} dB over the bed)`);

    const sp = (report.spatial = await T('spatial'));
    console.log('spatial:', JSON.stringify(sp));
    check(sp.rightPanDb > 6 && sp.leftPanDb < -6, 'left/right panning is wrong');
    check(Math.abs(sp.turnedPanDb) < 1.5, 'a source dead ahead after turning right should be centred (yaw convention)');
    check(sp.nearPeakDb - sp.at40mPeakDb > 12 && sp.nearPeakDb - sp.at40mPeakDb < 30, '40 m attenuation out of range');
    check(sp.at200mPeakDb === null, 'sound audible at 200 m');
    check(sp.at40mCentroid < sp.nearCentroid && sp.behind40mCentroid < sp.at40mCentroid, 'distance / behind low-pass missing');
    check(sp.at40mDelay > 0.08, 'no distance delay');
  }

  // ---------------------------------------------------------------- pictures
  if (want('shots') && want('sounds') && want('loops') && want('music') && want('mix')) {
    const sheets = {
      'audio-weapons': [['fire_stapler', 'stapler ×10/s', 'fire_punch', 'fire_marker', 'fire_marker (tap)', 'fire_blotter', 'bounce', 'explode', 'impact', 'ricochet', 'dry', 'reload_start', 'reload_end', 'switch', 'loop:charge pitch 0.5', 'loop:charge pitch 2'], 4, 400, 230],
      'audio-feedback': [['hit', 'hit_head', 'kill', 'hurt', 'die', 'second_draft', 'footstep', 'jump', 'airjump', 'land', 'dash', 'slide_start', 'walljump', 'jumppad', 'rewind', 'loop:slide', 'loop:wallrun', 'loop:overprint', 'loop:wind', 'land (soft)'], 4, 400, 230],
      'audio-flow': [['pickup_health', 'pickup_overprint', 'overprint_end', 'pickup_respawn', 'spawn', 'countdown_tick', 'countdown_go', 'round_win', 'round_lose', 'match_win', 'match_lose', 'announce', 'streak', 'card_reveal', 'card_hover', 'card_pick', 'ui_hover', 'ui_click', 'ui_back', 'ui_toggle', 'chat', 'join', 'leave'], 4, 400, 230],
      'audio-music': [['music:menu@0', 'music:lobby@0', 'music:combat@0', 'music:combat@0.5', 'music:combat@1', 'music:draft@0', 'music:victory@0'], 1, 1600, 230],
      'audio-mix': [['worst case (all sliders max)', 'transitions menu→combat→draft→off'], 1, 1600, 300],
    };
    fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
    for (const [file, [labels, cols, w, h]] of Object.entries(sheets)) {
      await T('draw', file, labels, cols, w, h);
      const data = await page.evaluate((id) => document.getElementById(id).toDataURL('image/png'), file);
      fs.writeFileSync(path.join(root, 'shots', `${file}.png`), Buffer.from(data.split(',')[1], 'base64'));
      console.log(`saved shots/${file}.png`);
    }
  }

  // ---------------------------------------------------------------- live context
  if (want('live')) {
    const live = (report.live = await T('live'));
    console.log('\n== live AudioContext ==\n' + JSON.stringify(live));
    check(live.state === 'running', `live context state is ${live.state}`);
    check(live.errors.length === 0, `live errors: ${live.errors.join('; ')}`);
    check(live.statesSeen.join() === 'menu,lobby,combat,draft,victory,off,combat', `music states did not follow: ${live.statesSeen}`);
    check(live.livePeakDb > -40 && live.livePeakDb <= CEILING_DB, `live output peak ${live.livePeakDb} dBFS`);
  }
} finally {
  await browser.close();
  server.kill();
}

const json = opt('json', null);
if (json) fs.writeFileSync(json, JSON.stringify(report, null, 1));
console.log(failures.length ? `\nFAILED (${failures.length}):\n - ${failures.join('\n - ')}` : '\nALL AUDIO CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

// Pattern generators: one "style" per music state. A style turns (session harmony, seeded phrase
// plan, bar number) into a flat list of note events on a 16-step grid. Each event may carry
// `min` / `max` intensity gates, which is how combat layers appear and vanish without re-planning:
//   0     two-step kick/snare, quarter hats, held sub
//   0.2   eighth hats, ghost snares
//   0.45  moving reese bassline, chord stabs
//   0.65  full chopped break, sixteenth hats + stapler clicks
//   0.7   lead hook            0.85+  fills, crashes, octave-doubled lead
import { makeRng } from '../../../../shared/rng.js';
import { degree, voicing } from './theory.js';

const drum = (at, s, v, o) => ({ at, k: 'drum', s, v, ...o });
const bass = (at, len, midi, v, o) => ({ at, k: 'bass', len, midi, v, ...o });
const chord = (at, s, notes, v, len, o) => ({ at, k: 'chord', s, notes, v, len, ...o });
const lead = (at, len, midi, v, o) => ({ at, k: 'lead', len, midi, v, ...o });

const on = (pattern, i, ch = 'x') => pattern[i] === ch;

/** Bass note for a chord: root folded to sit within a fifth of the tonic, plus a scale-degree offset. */
function bassNote(session, chordDeg, offset = 0) {
  let root = degree(session, chordDeg);
  while (root > session.tonic + 7) root -= 12;
  return root + degree(session, chordDeg + offset) - degree(session, chordDeg);
}

/** The session hook: call over bars 0-1, answer over bars 2-3 (eighth-note slots → sixteenth steps). */
function hook(session, b, v, o) {
  const phrase = b < 2 ? session.motif.call : session.motif.answer, base = (b % 2) * 8;
  return phrase
    .filter((n) => n.slot >= base && n.slot < base + 8)
    .map((n) => lead((n.slot - base) * 2, n.len * 2, degree(session, n.deg, session.tonic + 24), v, o));
}

/** Cap regular drums in the last beat so a fill can take the bar over above `min` intensity. */
function makeRoomForFill(events, min) {
  for (const e of events) if (e.k === 'drum' && e.at >= 12) e.max = Math.min(e.max ?? 2, min);
}

/** Step at which the 0.9 s reversed-crash sample must start so that it peaks exactly on the next bar line. */
const swellStart = (bpm) => 16 - 0.9 / (15 / bpm);

const FILLS = {
  roll: (min) => [12, 13, 14, 14.5, 15, 15.5].map((at, i) => drum(at, 'snare', 0.5 + i * 0.08, { rate: 1 + i * 0.05, min })),
  zip: (min) => [drum(12, 'kick', 1, { min }), drum(12, 'zip', 0.8, { min }), drum(14, 'zip', 0.9, { rate: 1.25, min })],
  kicks: (min) => [drum(12, 'kick', 1, { min }), drum(13, 'kick', 0.8, { min }), drum(14, 'kick', 0.9, { min }), drum(15, 'snare', 0.9, { min }), drum(15.5, 'snare', 0.7, { rate: 1.1, min })],
  staples: (min) => [12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5].map((at, i) => drum(at, 'staple', 0.45 + i * 0.06, { rate: 1 + i * 0.04, min })),
};

// ---------------------------------------------------------------- combat: 170 bpm zine-core jungle

// [kicks, snares] per bar; 'x' = hit, 'g' = ghost snare. Chopped-amen family.
const BREAKS = [
  ['x.x.......xx....', '....x..g.g..x..g'],
  ['x.x.......x.....', '....x..g.g..g.x.'],
  ['x..x..x...x.....', '....x....g..x..g'],
  ['x.xx......x.....', '....x..g.g..x..g'],
  ['x.........x..x..', '....x..x.g..x...'],
];
const TWO_STEP = ['x.........x.....', '....x.......x...'];

// Reese riffs: [step, length, scale-degree offset from the chord root] (4 = fifth, 7 = octave, -1 = seventh below)
const RIFFS = [
  [[0, 5, 0], [6, 2, 0], [10, 3, 7], [13, 3, 4]],
  [[0, 3, 0], [3, 3, 0], [6, 4, 4], [10, 2, 0], [12, 2, -1], [14, 2, 2]],
  [[0, 6, 0], [8, 2, 7], [10, 1, 0], [11, 3, 4], [14, 2, -1]],
  [[0, 2, 0], [2, 4, 0], [6, 2, 7], [8, 2, 0], [10, 4, 2], [14, 2, 4]],
  [[0, 8, 0], [8, 4, 4], [12, 4, -1]],
];
const STAB_RHYTHMS = [[3, 6, 11, 14], [0, 3, 10], [6, 9, 14], [2, 8, 11]];

const combat = {
  bpm: 170, swing: 0.05,
  tone: {
    level: 1, drumRate: 1.04, reese: 0.5, sub: 0.75, delayMix: 0.3, send: 0.12,
    cutoff: (i) => 2400 * Math.pow(8, i),       // 2.4 kHz (next room) → 19 kHz (in your face)
    gain: (i) => 0.78 + 0.22 * i,
    bassCutoff: (i) => 260 + 1300 * i * i,
  },
  plan(rng, session, phrase, salt) {
    const fixed = makeRng(session.seed * 31 + salt * 977 + 5);
    const main = fixed.int(0, BREAKS.length - 1), riff = fixed.int(0, RIFFS.length - 1);
    const stabs = fixed.pick(STAB_RHYTHMS);
    const other = (rng.int(1, BREAKS.length - 1) + main) % BREAKS.length;
    return {
      phrase,
      breaks: [main, main, other, rng.chance(0.5) ? main : rng.int(0, BREAKS.length - 1)],
      riffs: [riff, riff, riff, (riff + fixed.int(1, RIFFS.length - 1)) % RIFFS.length],
      stabs, stabsAlt: rng.pick(STAB_RHYTHMS),
      staples: Array.from({ length: 16 }, () => rng.chance(0.45)),
      open: rng.pick([6, 14]),
      fill: rng.pick(Object.keys(FILLS)),
      fillMin: phrase % 2 ? 0.5 : 0.82,
    };
  },
  bar(plan, b, session) {
    const ev = [], deg = session.progression[b], [kicks, snares] = BREAKS[plan.breaks[b]];
    for (let i = 0; i < 16; i++) {
      const loK = on(TWO_STEP[0], i), hiK = on(kicks, i), loS = on(TWO_STEP[1], i);
      if (loK || hiK) ev.push(drum(i, 'kick', 1, { min: loK ? 0 : 0.6, max: hiK ? 2 : 0.6 }));
      if (on(snares, i)) ev.push(drum(i, 'snare', 0.95, { min: loS ? 0 : 0.65 }));
      else if (loS) ev.push(drum(i, 'snare', 0.95, { max: 0.65 }));
      if (on(snares, i, 'g')) ev.push(drum(i, 'snare', 0.3, { rate: 1.07, min: loS ? 0.65 : 0.2 }));

      if (i % 4 === 0) ev.push(drum(i, 'hat', 0.42));
      else if (i % 2 === 0) {
        if (i === plan.open) ev.push(drum(i, 'hat', 0.6, { min: 0.2, max: 0.5 }), drum(i, 'hat_open', 0.55, { min: 0.5 }));
        else ev.push(drum(i, 'hat', 0.6, { min: 0.2 }));
      } else ev.push(plan.staples[i] ? drum(i, 'staple', 0.5, { min: 0.65 }) : drum(i, 'hat', 0.28, { min: 0.65 }));
    }
    if (b === 0) ev.push(drum(0, 'crash', 0.7, { min: plan.phrase % 4 === 0 ? 0.4 : 0.8 }));
    if (b === 3) {
      makeRoomForFill(ev, plan.fillMin);
      ev.push(...FILLS[plan.fill](plan.fillMin));
    }

    // held sub below 0.45, the riff above
    ev.push(bass(0, 9.5, bassNote(session, deg), 0.9, { max: 0.45 }), bass(10, 5.5, bassNote(session, deg), 0.8, { max: 0.45 }));
    for (const [at, len, off] of RIFFS[plan.riffs[b]]) ev.push(bass(at, len - 0.3, bassNote(session, deg, off), at === 0 ? 0.95 : 0.8, { min: 0.45 }));

    const notes = voicing(session, deg, 3, 55);
    (b === 3 ? plan.stabsAlt : plan.stabs).forEach((at, i) => ev.push(chord(at, 'stab', notes, i ? 0.6 : 0.8, 1.6, { min: i > 1 ? 0.8 : 0.45 })));

    ev.push(...hook(session, b, 0.8, { min: 0.7 }), ...hook(session, b, 0.3, { min: 0.9 }).map((e) => ({ ...e, midi: e.midi + 12 })));
    return ev;
  },
};

// ---------------------------------------------------------------- menu: 100 bpm lo-fi boom-bap

const MENU_KICKS = ['x......x..x.....', 'x.........xx....', 'x..x......x.....', 'x......x..x..x..'];
const MENU_BASS = [
  [[0, 6, 0], [7, 2, 0], [10, 4, 4]],
  [[0, 5, 0], [6, 2, 4], [8, 2, 7], [10, 5, 0]],
  [[0, 7, 0], [10, 2, 2], [12, 4, 4]],
];

const menu = {
  bpm: 100, swing: 0.22,
  tone: {
    level: 0.9, drumRate: 0.88, reese: 0.12, sub: 0.8, delayMix: 0.45, send: 0.2, dust: 0.5,
    cutoff: () => 5200,
    bassCutoff: () => 340,
  },
  plan(rng, session, phrase, salt) {
    const fixed = makeRng(session.seed * 31 + salt * 977 + 11);
    const kick = fixed.int(0, MENU_KICKS.length - 1);
    return {
      phrase,
      kicks: [kick, kick, kick, rng.int(0, MENU_KICKS.length - 1)],
      riff: fixed.int(0, MENU_BASS.length - 1),
      ghosts: Array.from({ length: 16 }, () => rng.chance(0.2)),
      rehit: rng.pick([6, 10, 11]),
      ghostSnare: rng.pick([7, 15]),
    };
  },
  bar(plan, b, session) {
    const ev = [], deg = session.progression[b];
    for (let i = 0; i < 16; i++) {
      if (on(MENU_KICKS[plan.kicks[b]], i)) ev.push(drum(i, 'kick_soft', i ? 0.8 : 1));
      if (i === 4 || i === 12) ev.push(drum(i, 'snare', 0.55), drum(i, 'rim', 0.3));
      if (i % 2 === 0) ev.push(drum(i, 'hat', i % 4 ? 0.26 : 0.38));
      else if (plan.ghosts[i]) ev.push(drum(i, 'hat', 0.15));
    }
    ev.push(drum(plan.ghostSnare, 'snare', 0.18, { rate: 1.05 }));
    if (b === 1) ev.push(drum(14, 'staple', 0.3));
    if (b === 3 && plan.phrase % 2) ev.push(drum(13, 'zip', 0.22), drum(14, 'staple', 0.3), drum(15, 'staple', 0.36));

    for (const [at, len, off] of MENU_BASS[plan.riff]) ev.push(bass(at, len - 0.4, bassNote(session, deg, off), at === 0 ? 0.9 : 0.7));
    // rootless seventh/ninth voicing over the bass root: instant lo-fi
    const notes = voicing(session, deg, 4, 55, 1);
    ev.push(chord(0, 'ep', notes, 0.7, 0), chord(plan.rehit, 'ep', notes.slice(1), 0.4, 0));
    if (plan.phrase % 2 === 0) ev.push(...hook(session, b, 0.5));
    return ev;
  },
};

// ---------------------------------------------------------------- lobby: the menu leaning forward

const lobby = {
  bpm: 108, swing: 0.16,
  tone: {
    level: 0.95, drumRate: 0.94, reese: 0.22, sub: 0.75, delayMix: 0.4, send: 0.18, dust: 0.35,
    // an eight-bar filter rise that resets: a held breath, over and over
    cutoff: (i, bar, step) => 2400 * Math.pow(3.6, ((bar % 8) * 16 + step) / 128),
    bassCutoff: () => 480,
  },
  plan(rng, session, phrase, salt) {
    const fixed = makeRng(session.seed * 31 + salt * 977 + 17);
    return { phrase, busy: fixed.chance(0.5), stabs: fixed.pick([[0, 3, 6], [0, 3, 10], [0, 6, 11]]), flip: rng.chance(0.5) };
  },
  bar(plan, b, session) {
    const ev = [], deg = session.progression[b], build = b === 3 && plan.phrase % 2 === 1;
    const kicks = plan.busy && b % 2 ? 'x..x..x...x.....' : 'x.....x...x.....';
    for (let i = 0; i < 16; i++) {
      if (on(kicks, i)) ev.push(drum(i, 'kick_soft', i ? 0.85 : 1));
      if (i === 4 || i === 12) ev.push(drum(i, 'snare', 0.6), drum(i, 'rim', 0.3));
      if (i % 2 === 0) ev.push(drum(i, 'hat', i % 4 ? 0.3 : 0.4));
      else ev.push(drum(i, i % 4 === 3 ? 'staple' : 'shaker', 0.22));
      // pedal eighths on the root: the anticipation
      if (i % 2 === 0) ev.push(bass(i, 1.3, bassNote(session, deg, b === 3 && i >= 12 ? 4 : 0), i % 4 ? 0.6 : 0.85));
      if (build && i >= 8) ev.push(drum(i, 'snare', 0.12 + (i - 8) * 0.05, { rate: 1 + (i - 8) * 0.02 }));
    }
    if (build) ev.push(drum(swellStart(lobby.bpm), 'swell', 0.5));
    const notes = voicing(session, deg, 4, 55, 1);
    plan.stabs.forEach((at, i) => ev.push(chord(at, 'ep', i ? notes.slice(1) : notes, i ? 0.45 : 0.7, 1.8)));
    if (plan.flip ? b >= 2 : b < 2) ev.push(...hook(session, b, 0.5));
    return ev;
  },
};

// ---------------------------------------------------------------- draft: half-time, shopping music with menace

const draft = {
  bpm: 85, swing: 0,
  tone: {
    level: 0.9, drumRate: 0.8, reese: 0.3, sub: 0.8, delayMix: 0.6, send: 0.35, dust: 0.3,
    cutoff: (i, bar, step) => 2600 + 1200 * Math.sin(((bar * 16 + step) / 64) * Math.PI * 2),
    bassCutoff: (i, bar) => (bar % 4 === 3 ? 520 : 300),
  },
  plan(rng, session, phrase) {
    return { phrase, order: rng.shuffle([0, 1, 2, 3]), fragment: rng.int(2, 4) };
  },
  bar(plan, b, session) {
    const ev = [];
    ev.push(drum(0, 'kick_soft', 1), drum(8, 'rim', 0.6, { send: 0.9 }), drum(8, 'snare', 0.25, { rate: 0.8, send: 0.9 }));
    if (b % 2) ev.push(drum(10, 'kick_soft', 0.5));
    // the till clock: stapler on the beat, hat between
    for (let i = 0; i < 16; i += 2) ev.push(i % 4 ? drum(i, 'hat', 0.12) : drum(i, 'staple', 0.25));
    // drone on the tonic; bar 4 leans a semitone up (phrygian ♭2) and falls back — the menace
    const lean = b === 3;
    ev.push(bass(0, 15.6, session.tonic + (lean ? 1 : 0), 0.85));
    // muzak arpeggio of i(add9), then the ♭II major triad on the leaning bar
    const tonicChord = voicing(session, 0, 5, 55);
    const notes = lean ? [1, 5, 8, 13].map((s) => session.tonic + 24 + s) : plan.order.map((i) => tonicChord[i]);
    [0, 3, 6, 10].forEach((at, i) => ev.push(chord(at, 'ep', [notes[i]], 0.6 - i * 0.07, 0)));
    // a few notes of the hook drift past, as if from the shop next door
    if (b === 1 && plan.phrase % 2 === 0) ev.push(...hook(session, 0, 0.4).slice(0, plan.fragment));
    if (b === 3) ev.push(drum(swellStart(draft.bpm), 'swell', 0.45, { send: 0.5 }));
    return ev;
  },
};

// ---------------------------------------------------------------- victory: 132 bpm, relative major, short and loud

const victory = {
  bpm: 132, swing: 0.08,
  tone: {
    level: 1, drumRate: 1, reese: 0.4, sub: 0.7, delayMix: 0.3, send: 0.18,
    cutoff: () => 16000,
    bassCutoff: () => 900,
  },
  plan(rng, session, phrase) {
    return { phrase };
  },
  bar(plan, b, session) {
    const ev = [], deg = session.progression[b];
    for (let i = 0; i < 16; i++) {
      if (on('x.....x...x..x..', i)) ev.push(drum(i, 'kick', 1));
      if (i === 4 || i === 12) ev.push(drum(i, 'snare', 0.95));
      if (i % 4 === 2) ev.push(drum(i, 'hat_open', 0.45));
      else if (i % 2 === 0) ev.push(drum(i, 'hat', 0.45));
      else ev.push(drum(i, 'staple', 0.3));
      // octave-bouncing bass
      if (i % 2 === 0) ev.push(bass(i, 1.5, bassNote(session, deg, i >= 12 && b === 3 ? 4 : i % 4 ? 7 : 0), 0.85));
    }
    if (b === 0) ev.push(drum(0, 'crash', 0.8));
    if (b === 3) { makeRoomForFill(ev, 0); ev.push(...FILLS.roll(0)); }
    const notes = voicing(session, deg, 3, 57);
    [0, 3, 6, 10, 12].forEach((at, i) => ev.push(chord(at, 'stab', [...notes, notes[0] + 12], i ? 0.6 : 0.85, 1.8)));
    // rising chord-tone arpeggio in eighths; last bar runs up the scale
    for (let i = 0; i < 8; i++) {
      const d = b === 3 ? deg + i : deg + [0, 2, 4, 7, 4, 7, 9, 7][i];
      ev.push(lead(i * 2, 1.8, degree(session, d, session.tonic + 24), 0.6));
    }
    return ev;
  },
};

export const STYLES = { menu, lobby, combat, draft, victory };

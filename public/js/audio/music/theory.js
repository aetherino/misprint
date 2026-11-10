// Harmony for the generative soundtrack. A "session" (one per match) fixes the key, mode, chord
// progression and the lead hook, so every state — menu, combat, draft — is recognisably the same
// tune. Everything melodic is expressed in scale degrees, never raw semitones, so nothing can
// leave the key.
import { makeRng } from '../../../../shared/rng.js';

const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
};

// Four-bar progressions as scale degrees (0 = tonic). Chosen to avoid the diminished chord of each mode.
const PROGRESSIONS = {
  aeolian: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [0, 5, 3, 6], [0, 2, 5, 4]],
  dorian: [[0, 3, 0, 6], [0, 2, 3, 6], [0, 6, 3, 0], [0, 3, 6, 2]],
};

// Pentatonic ladders (scale degrees): safe over every diatonic chord, so the hook never clashes.
const PENTA = { minor: [0, 2, 3, 4, 6], major: [0, 1, 2, 4, 5] };

// Hook rhythms on an eighth-note grid across two bars (16 slots). Syncopated, with air.
const MOTIF_RHYTHMS = [
  [0, 2, 3, 6, 8, 10, 11, 14],
  [0, 3, 4, 6, 8, 11, 12],
  [0, 1, 3, 6, 7, 9, 12, 14],
  [0, 3, 6, 8, 9, 11, 14],
  [2, 3, 5, 8, 10, 11, 13],
];

const ladder = (penta, k) => penta[((k % 5) + 5) % 5] + 7 * Math.floor(k / 5);

/** Two-bar hook + its answer. Notes are { slot, len (slots), deg (scale degree, 7 = octave up) }. */
function makeMotif(rng, penta) {
  const slots = rng.pick(MOTIF_RHYTHMS);
  let k = rng.pick([5, 6, 8]); // start on the tonic, third or fifth, an octave above the chords
  const call = slots.map((slot, i) => {
    if (i > 0 && !rng.chance(0.2)) k = Math.min(10, Math.max(3, k + rng.pick([-2, -1, -1, 1, 1, 2])));
    return { slot, len: Math.min(2, (slots[i + 1] ?? 16) - slot), k };
  });
  // the call hangs on the fifth or seventh; the answer repeats it but walks home to the tonic
  call[call.length - 1].k = rng.pick([3, 4, 8]);
  const answer = call.map((n) => ({ ...n }));
  answer[answer.length - 2].k = rng.pick([4, 6]);
  answer[answer.length - 1].k = 5;
  answer[answer.length - 1].len = 3;
  const toNotes = (list) => list.map(({ slot, len, k: idx }) => ({ slot, len, deg: ladder(penta, idx) }));
  return { call: toNotes(call), answer: toNotes(answer) };
}

export function createSession(seed) {
  const rng = makeRng(seed);
  const mode = rng.pick(['aeolian', 'aeolian', 'dorian']);
  const tonic = rng.int(29, 37); // F1 … C#2: the sub's root, 44-69 Hz
  const session = {
    seed, mode, tonic,
    scale: MODES[mode],
    progression: rng.pick(PROGRESSIONS[mode]),
    motif: makeMotif(rng, PENTA.minor),
  };
  // Victory lap: relative major (same notes, brighter home), I-IV-vi-V or I-V-vi-IV.
  session.victory = {
    seed: seed + 1, mode: 'major', tonic: tonic + 3,
    scale: MODES.major,
    progression: rng.pick([[0, 3, 5, 4], [0, 4, 5, 3]]),
    motif: makeMotif(rng, PENTA.major),
  };
  return session;
}

/** Scale degree (any integer; 7 = one octave up) → MIDI note relative to `base` = the tonic's MIDI note. */
export function degree(session, deg, base = session.tonic) {
  const d = ((deg % 7) + 7) % 7;
  return base + 12 * Math.floor(deg / 7) + session.scale[d];
}

/**
 * Diatonic chord on `rootDeg`, `size` notes stacked in thirds from `from` (0 = root, 1 = start on the
 * third → rootless voicing), folded into the octave starting at MIDI `lo` so chord changes move
 * by small steps instead of jumping in parallel.
 */
export function voicing(session, rootDeg, size, lo, from = 0) {
  const notes = [];
  for (let i = from; i < from + size; i++) {
    let n = degree(session, rootDeg + i * 2);
    while (n < lo) n += 12;
    while (n >= lo + 12) n -= 12;
    notes.push(n);
  }
  return notes.sort((a, b) => a - b);
}

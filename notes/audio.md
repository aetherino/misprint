# AUDIO — report

100% WebAudio synthesis, no files, no deps. Entry `public/js/audio/index.js` (contract unchanged; `createAudio()` takes
an optional dev-only `{context, seed}` and returns an extra `_dev` object used by the soundboard/tests).

## How to test
- `node tools/audiotest.mjs` (port 3104) — renders every sound/loop/music state through OfflineAudioContexts in headless
  Chrome, prints the table, asserts the rules below, writes `shots/audio-{weapons,feedback,flow,music,mix}.png`, then
  exercises a live AudioContext. Exit code 1 on any failure. `--only sounds,loops,music,mix,live,shots`, `--json file`.
- `public/dev/audio.html` — soundboard for humans (every sound, loops + pitch/vol sliders, music states + intensity,
  firefight stress button, output meter). `public/dev/audiotest.html` is the measurement bench the tool drives.

## Architecture (public/js/audio/)
| file | role |
|---|---|
| `dsp.js` | offline buffer-math toolkit (band-limited oscs, FM, modal partials, TPT SVF, envelopes, compound voices) |
| `sfx/{weapons,feedback,movement,world,ui}.js` | one-shot definitions: `make(dsp)` + level / variations / jitter / reverb send / rate-limit gap / priority / music duck |
| `bank.js` | renders definitions to buffers (cached per sample rate), time-sliced warm-up after unlock (kit → sfx → loops); anything played early renders on demand |
| `context.js` | fixed graph: 2D + world(sfx, muffle LP) buses, 3 reverb sends → generated 0.7 s room impulse, music bus (hit-slot notch, duck), master → compressor → trim → soft-clip ceiling at −1 dBFS |
| `voices.js` | one-shot playback: per-name rate limit, crowd scaling, 28-voice cap with priority stealing, variation + pitch jitter |
| `spatial.js` | listener + distance gain (ref 4 m, 1/d, fade 55→80 m), equal-power pan, distance/behind low-pass, ≤120 ms distance delay |
| `loops.js` | seamless loop beds, gain/playbackRate follow `opts.vol`/`opts.pitch` |
| `music/{theory,styles,kit,deck,sequencer}.js` | generative soundtrack |

Voice cost: BufferSource + Gain (+ Biquad if far/behind, + StereoPanner if off-centre). No HRTF.

## Music
- **Session** (per match; new one when returning to menu/lobby after a combat): tonic F1–C#2, aeolian or dorian, a 4-bar
  diatonic progression, and a seeded 2-bar hook + answer on the minor pentatonic. Everything is in scale degrees so
  nothing leaves the key (only deliberate exception: the ♭II bar in `draft`). Victory uses the relative major.
- **Styles** emit events on a 16-step grid per bar, re-planned every 4 bars from a seeded RNG (break variant, fill,
  stab rhythm, stapler-hat mask). Events carry `min`/`max` intensity gates.
  - menu 100 bpm swung boom-bap, EP 7th/9th voicings, paper-dust bed · lobby 108 bpm, pedal-8th bass, 8-bar filter rise
  - combat 170 bpm chopped breaks: 0 = two-step + held sub (filter 2.4 kHz) · 0.2 8th hats/ghosts · 0.45 reese riff + stabs ·
    0.65 full break, 16th hats/stapler clicks · 0.7 lead hook · 0.82+ fills (snare roll / printer zips / kicks / staples), crashes, octave lead
  - draft 85 bpm half-time, tonic drone, muzak arpeggio, stapler "till clock", ♭II lean on bar 4 · victory 132 bpm
- **Deck** per state: sample drums → soft clip; sine sub + detuned saws → resonant LP; re-pitched stab/EP/lead samples;
  dotted-8th echo; kick-pumped bass/chord bus. Transitions land on the next half-bar: old deck's filter sweeps shut and
  fades 0.35 s, new deck starts on its downbeat.
- **Sequencer**: `setInterval` 25 ms, 120 ms look-ahead on the audio clock (1.6 s when `document.hidden`); stalled timers
  skip steps on the grid instead of bursting. Intensity is slewed (≈0.5 s up, 2.5 s down).
- Music ducks under sounds with a `duck` value (explode, punch, kill, hit …); `hurt` also dips a low-pass over world sfx.

## Measurements (default sliders 0.8/0.6/0.8, 48 kHz offline, full chain)
| sound | dur s | peak dBFS | rms | centroid Hz |
|---|---|---|---|---|
| fire_stapler | 0.22 | −10.0 | −29.8 | 1604 |
| fire_punch | 0.56 | −7.1 | −20.5 | 4367 |
| fire_marker (full / tap) | 0.48 / 0.30 | −7.3 / −15.9 | −24.4 | 5390 / 7142 |
| fire_blotter | 0.45 | −9.8 | −22.3 | 790 |
| explode | 1.55 | −6.4 | −18.7 | 2420 |
| hit / hit_head | 0.05 / 0.24 | −10.8 / −10.5 | −28.2 | 3809 / 6467 |
| kill | 0.71 | −7.7 | −24.4 | 2671 |
| hurt | 0.30 | −10.7 | −20.2 | 167 |
| footstep | 0.08 | −21.5 | −33.6 | 3282 |
| ui_hover / ui_click | 0.03 / 0.05 | −29.0 / −22.2 | | |
| loops (slide/wallrun/charge/overprint/wind) | | −16.8/−14.9/−16.8/−18.6/−14.9 | | seam ≤ 0.15 |
| music menu / lobby / draft / victory | | −14.2/−13.1/−14.2/−11.8 | −27.8/−27.0/−28.9/−24.5 | |
| music combat @0 / 0.5 / 1 | | −14.2/−12.5/−10.3 | −27.2/−26.0/−23.8 | 640/2239/4135, 6.3/9.2/10.6 onsets/s |

- Stapler at 600 rpm: envelope dips 35 dB between shots (stays a rhythm).
- Firefight (default sliders): sfx-only RMS −19.6, music-only −24.0, both peak −5.8 dBFS.
- Worst case (all sliders at 1, intensity-1 music, 8 staplers at 600 rpm + punches/markers/blotters/explosions/hits, plus
  12 weapons + explosion in one 10 ms window): peak **−4.0 dBFS**, 0 clipped, 0 % of samples in the soft-clip knee.
- Hit tick over full music + own stapler at the same instant: +13.6 dB in its 3–6.5 kHz slot. Music keeps <1.5 % of its energy there.
- Spatial: ±18 dB L/R at 6 m to the side, 0 dB after turning to face it (yaw convention verified); −14.6 dB at 40 m,
  silent at 200 m; centroid drops with distance and further behind; 0.12 s delay at 40 m.
- No DC (|dc| < 0.001), no clipping anywhere; transitions menu→combat→draft→off add no sample step larger than steady music.
- Live headless Chrome: context `running`, all states followed, no exceptions.

## Known limits
- Tuned by measurement and spectrograms only — nobody has listened. Expect taste-level tweaks (levels live in each def's `level`, music mix in `music/deck.js` `MIX`/`OUTPUT`).
- Music is bass-weighted (50–80 % of energy below 120 Hz depending on state); on laptop speakers menu/draft will sound thin.
- Onset-density numbers for sparse states (draft) are inflated by echo/dust; assertion there uses RMS/centroid instead.
- Loops are 2D only (no `pos`); one-shot positions are fixed at play time (no doppler/tracking).
- First unlock renders ~1.3 s of CPU worth of buffers in 5 ms slices; single long sounds (match_win, explode) can cost one 40–80 ms slice in the menu.
- AudioWorklet is unavailable on plain-http LAN, so the limiter is DynamicsCompressor + WaveShaper; the +4.33 dB make-up compensation was measured in Chrome (test asserts it), other engines share the algorithm but were not measured.
- Not checked: Firefox/Safari, real output devices, CPU on a mid laptop.

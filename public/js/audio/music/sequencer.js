// Look-ahead sequencer for the generative soundtrack. The host calls schedule(horizon) often
// (every ~25 ms live; once for the whole render offline); everything is placed on the audio
// clock, so timer jitter never reaches the ear. If timers stall (background tab), missed steps
// are skipped on the grid rather than played late in a burst.
import { makeRng } from '../../../../shared/rng.js';
import { createSession } from './theory.js';
import { STYLES } from './styles.js';
import { createDeck } from './deck.js';

const LATE = 0.02; // a step this far in the past is dropped

function bucket(events) {
  const steps = Array.from({ length: 16 }, () => []);
  for (const e of events) steps[Math.min(15, Math.max(0, Math.floor(e.at)))].push(e);
  return steps;
}

export function createSequencer(ctx, graph, kit, seed) {
  let wanted = 'off', current = 'off';
  let target = 0, intensity = 0;
  let sessions = 0, session = createSession(seed), sessionUsed = false, round = 0;
  let track = null;
  const leaving = [];

  function createTrack(state, startAt) {
    const style = STYLES[state], sess = state === 'victory' ? session.victory : session, salt = round;
    const deck = createDeck(ctx, graph, kit, style, startAt), stepDur = deck.stepDur;
    let step = 0, endStep = Infinity, stopAt = Infinity, plan = null, steps = null;
    if (style === STYLES.combat || style === STYLES.victory) deck.trigger({ k: 'drum', s: 'crash', v: 0.7 }, startAt);

    return {
      stepDur,
      get nextTime() { return startAt + step * stepDur; },
      get done() { return step >= endStep; },
      get stopAt() { return stopAt; },
      /** Next half-bar line that nothing has been scheduled past yet. */
      boundary: () => startAt + Math.ceil(step / 8) * 8 * stepDur,
      end(T) {
        endStep = Math.max(step, Math.round((T - startAt) / stepDur));
        stopAt = deck.end(T);
      },
      advance(level, audible) {
        const bar = Math.floor(step / 16), s = step % 16;
        if (s === 0) {
          const phrase = bar >> 2;
          if (bar % 4 === 0) plan = style.plan(makeRng(sess.seed * 131 + salt * 31 + phrase * 7 + 3), sess, phrase, salt);
          steps = bucket(style.bar(plan, bar % 4, sess));
        }
        if (audible) {
          const t = startAt + step * stepDur + (s % 2 ? style.swing * stepDur : 0);
          deck.setTone(level, bar, s, t);
          for (const e of steps[s]) {
            if (level >= (e.min ?? 0) && level < (e.max ?? 2)) deck.trigger(e, t + (e.at - Math.floor(e.at)) * stepDur);
          }
        }
        step++;
      },
      dispose: deck.dispose,
    };
  }

  function transition(now) {
    const T = track ? Math.max(track.boundary(), now + 0.03) : now + 0.06;
    if (track) {
      track.end(T);
      leaving.push(track);
    }
    const idle = (s) => s === 'menu' || s === 'lobby';
    if (idle(wanted) && sessionUsed) {
      // back in the lobby after a match: new key, new hook, new breaks
      session = createSession(seed + ++sessions * 7919);
      sessionUsed = false;
      round = 0;
    }
    if (wanted === 'combat') { round++; sessionUsed = true; }
    intensity = target;
    track = wanted === 'off' ? null : createTrack(wanted, T);
    current = wanted;
  }

  function run(t, until, now) {
    while (!t.done && t.nextTime < until) {
      if (t === track) intensity += (target - intensity) * Math.min(1, t.stepDur / (target > intensity ? 0.5 : 2.5));
      t.advance(intensity, t.nextTime >= now - LATE);
    }
  }

  return {
    setState(state) { if (state === 'off' || STYLES[state]) wanted = state; },
    setIntensity(x) { target = Math.min(1, Math.max(0, +x || 0)); },
    get state() { return current; },
    get session() { return session; },

    /** Place every note that starts before `until` (audio-clock seconds). */
    schedule(until) {
      const now = ctx.currentTime;
      if (wanted !== current) transition(now);
      for (const t of leaving) run(t, until, now);
      if (track) run(track, until, now);
      for (let i = leaving.length - 1; i >= 0; i--) {
        if (now > leaving[i].stopAt + 1) leaving.splice(i, 1)[0].dispose();
      }
    },
  };
}

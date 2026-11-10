// Bottom-centre: dash charges, speedometer, Rewind cooldown ring. Above it: status tags (Overprint, slowed, hidden).
import { h, replace, textSlot, classSlot, scaleSlot, play } from '../dom.js';

const RING_STEPS = 120;
const SPEED_EVERY = 3;        // frames between speed readout writes (20 Hz at 60 fps)
const FAST = 11.5;            // m/s: clearly above run speed
const POP = [{ transform: 'scale(1.35)' }, { transform: 'scale(.94)' }, { transform: 'scale(1)' }];

export function createMove() {
  // dash
  const dashPips = h('div.dash-pips');
  const dash = h('div.hud-dash.sticker', null, dashPips, h('span.kbd', null, 'Shift'), h('span.label', null, 'Dash'));
  let dashMax = -1;
  let pipSetters = [];

  // speed
  const speedNum = h('span.speed-num.mono');
  const speedFill = h('i');
  const speed = h('div.hud-speed.sticker', null, speedNum, h('span.label', null, 'm/s'), h('div.speed-bar', null, speedFill, h('b')));
  const setSpeed = textSlot(speedNum, '0.0');
  const setSpeedFill = scaleSlot(speedFill, 'X', 100);
  const setFast = classSlot(speed, 'is-fast');
  let speedQ = 0;
  let frame = 0;

  // rewind ring: two half-discs rotating behind half-windows (transform only)
  const spinA = h('i');
  const spinB = h('i');
  const rewindNote = h('span.label');
  const ring = h('div.ring', null, h('span.ring-half.ring-a', null, spinA), h('span.ring-half.ring-b', null, spinB), h('span.ring-key.mono', null, 'Q'));
  const rewind = h('div.hud-rewind.sticker', null, ring, h('div.rewind-text', null, h('span.label', null, 'Rewind'), rewindNote));
  const setRewindNote = textSlot(rewindNote, '');
  const setReady = classSlot(rewind, 'is-ready');
  let ringQ = -1;
  let ready = null;

  // status
  const opSecs = h('b.mono');
  const overprint = h('div.status.status-op', { hidden: true }, h('span', null, 'Overprint ×2'), opSecs);
  const slowed = h('div.status.status-slow', { hidden: true }, 'Paper jam: slowed');
  const ghost = h('div.status.status-ghost', { hidden: true }, 'Watermark: hidden');
  const status = h('div.hud-status', null, overprint, slowed, ghost);
  const setOpSecs = textSlot(opSecs, '');
  let opQ = -1;
  let isSlowed = false;
  let isGhost = false;

  return {
    els: [status, h('div.hud-move', null, dash, speed, rewind)],
    update(s) {
      const d = s.dash;
      if (d) {
        if (d.max !== dashMax) {
          dashMax = d.max;
          const fills = [];
          for (let i = 0; i < dashMax; i++) fills.push(h('i'));
          replace(dashPips, fills.map((f) => h('span.dash-pip', null, f)));
          pipSetters = fills.map((f) => scaleSlot(f, 'X', 60));
        }
        for (let i = 0; i < pipSetters.length; i++) pipSetters[i](i < d.charges ? 1 : i === d.charges ? d.frac : 0);
      }

      if (++frame % SPEED_EVERY === 0) {
        const q = Math.round((s.speed || 0) * 10);
        if (q !== speedQ) {
          speedQ = q;
          setSpeed((q / 10).toFixed(1));
          setSpeedFill(q / 260);
          setFast(q >= FAST * 10);
        }
      }

      const rq = Math.round((s.rewind ?? 1) * RING_STEPS);
      if (rq !== ringQ) {
        ringQ = rq;
        const deg = (rq / RING_STEPS) * 360;
        spinA.style.transform = `rotate(${Math.min(deg, 180)}deg)`;
        spinB.style.transform = `rotate(${Math.max(deg - 180, 0)}deg)`;
        const nowReady = rq >= RING_STEPS;
        if (nowReady !== ready) {
          if (nowReady && ready === false) play(rewind, POP, { duration: 260, easing: 'ease-out', fill: 'none', composite: 'add' });
          ready = nowReady;
          setReady(ready);
          setRewindNote(ready ? 'Ready' : 'Winding');
        }
      }

      const op = Math.ceil(s.overprint || 0);
      if (op !== opQ) {
        if (opQ <= 0 && op > 0) overprint.hidden = false; else if (op <= 0) overprint.hidden = true;
        opQ = op;
        if (op > 0) setOpSecs(`${op}s`);
      }
      if (!!s.slowed !== isSlowed) { isSlowed = !!s.slowed; slowed.hidden = !isSlowed; }
      if (!!s.ghost !== isGhost) { isGhost = !!s.ghost; ghost.hidden = !isGhost; }
    },
  };
}

// Keyboard / mouse / pointer-lock capture. Produces one reusable per-frame snapshot via sample().
// Debug automation drives the same actions through setVirtual() (see debug.js).

export const ACTIONS = ['fwd', 'back', 'left', 'right', 'jump', 'crouch', 'dash', 'fire', 'rewind', 'reload'];

const KEYS = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  // crouch is NOT on Ctrl: Ctrl+W closes the tab and a page cannot prevent it
  Space: 'jump', KeyC: 'crouch', KeyX: 'crouch', ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyQ: 'rewind', KeyR: 'reload',
};
const WEAPON_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const MAX_MOUSE_STEP = 600;   // px; browsers occasionally report a bogus huge movement on lock/unlock

const flags = () => Object.fromEntries(ACTIONS.map((a) => [a, false]));

/**
 * @param canvas       pointer-lock target
 * @param isTyping     () => boolean, true while a text field owns the keyboard
 * @param onKey        (code, down, event) => void for non-gameplay keys (Tab, Enter, Escape …)
 * @param onLockChange (locked) => void
 */
export function createInput({ canvas, isTyping, onKey, onLockChange }) {
  const real = flags(), virtual = flags(), tapped = flags(), prev = flags();
  let lookX = 0, lookY = 0, wheel = 0, select = -1;

  const frame = { ...flags(), pressed: flags(), released: flags(), moveX: 0, moveZ: 0, lookX: 0, lookY: 0, wheel: 0, select: -1 };

  const isLocked = () => document.pointerLockElement === canvas;
  const releaseAll = () => { for (const a of ACTIONS) real[a] = false; };

  function setKey(action, down) {
    if (down && !real[action]) tapped[action] = true;
    real[action] = down;
  }

  window.addEventListener('keydown', (e) => {
    if (isTyping()) return;
    const locked = isLocked();
    const action = KEYS[e.code];
    if (action) {
      if (!e.repeat) setKey(action, true);
    } else if (e.code in WEAPON_KEYS) {
      select = WEAPON_KEYS[e.code];
    }
    // keep the browser from scrolling, focus-walking or firing Ctrl shortcuts while playing
    if (locked && (action || e.code === 'Tab' || e.ctrlKey)) e.preventDefault();
    if (!e.repeat) onKey(e.code, true, e);
  });
  window.addEventListener('keyup', (e) => {
    const action = KEYS[e.code];
    if (action) real[action] = false;
    onKey(e.code, false, e);
  });
  window.addEventListener('blur', releaseAll);

  document.addEventListener('mousedown', (e) => { if (isLocked() && e.button === 0) setKey('fire', true); });
  document.addEventListener('mouseup', (e) => { if (e.button === 0) real.fire = false; });
  document.addEventListener('mousemove', (e) => {
    if (!isLocked()) return;
    if (Math.abs(e.movementX) > MAX_MOUSE_STEP || Math.abs(e.movementY) > MAX_MOUSE_STEP) return;
    lookX += e.movementX;
    lookY += e.movementY;
  });
  document.addEventListener('wheel', (e) => { if (isLocked() && e.deltaY !== 0) wheel += Math.sign(e.deltaY); }, { passive: true });
  document.addEventListener('contextmenu', (e) => { if (isLocked()) e.preventDefault(); });
  document.addEventListener('pointerlockchange', () => {
    const locked = isLocked();
    if (!locked) releaseAll();
    lookX = lookY = 0;
    onLockChange(locked);
  });
  document.addEventListener('pointerlockerror', () => onLockChange(isLocked()));

  return {
    get locked() { return isLocked(); },

    /** Ask for pointer lock (needs a user gesture unless the last unlock was programmatic). */
    lock() {
      if (isLocked()) return;
      const fallback = () => { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); };
      try {
        // raw, unaccelerated mouse input where the browser supports it
        const p = canvas.requestPointerLock({ unadjustedMovement: true });
        if (p && p.catch) p.catch((err) => { if (err && err.name === 'NotSupportedError') fallback(); });
      } catch { fallback(); }
    },
    unlock() { if (isLocked()) document.exitPointerLock(); },

    /** Hold / release virtual keys; values persist until changed. */
    setVirtual(state) {
      for (const a of ACTIONS) {
        if (!(a in state)) continue;
        const down = !!state[a];
        if (down && !virtual[a]) tapped[a] = true;
        virtual[a] = down;
      }
    },
    selectWeapon(i) { select = i; },

    /**
     * Snapshot of this frame's input. `active` false (menus, typing, dead) reads as "nothing held".
     * `pressed` also catches taps that began and ended between two frames.
     */
    sample(active) {
      for (const a of ACTIONS) {
        const down = active && (real[a] || virtual[a]);
        frame.pressed[a] = active && (tapped[a] || (down && !prev[a]));
        frame.released[a] = prev[a] && !down;
        frame[a] = down;
        prev[a] = down;
        tapped[a] = false;
      }
      frame.moveX = (frame.right ? 1 : 0) - (frame.left ? 1 : 0);
      frame.moveZ = (frame.fwd ? 1 : 0) - (frame.back ? 1 : 0);
      frame.lookX = active ? lookX : 0;
      frame.lookY = active ? lookY : 0;
      frame.wheel = active ? wheel : 0;
      frame.select = active ? select : -1;
      lookX = lookY = wheel = 0;
      select = -1;
      return frame;
    },
  };
}

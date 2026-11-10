// Centre of the screen: dynamic crosshair (one shape per weapon), charge/reload meter, hit marker with
// floating damage numbers, kill stamp, and damage-direction arcs. Everything animates with transforms/opacity.
import { h, svg, textSlot, classSlot, scaleSlot, attrSlot, play } from '../dom.js';

const MIN_GAP = [5, 4, 9, 7];          // px, per weapon
const NUM_POOL = 8;
const ARC_POOL = 6;
const MERGE_MS = 110;                  // shotgun pellets landing together read as one number
const ARC = '<svg viewBox="0 0 120 40" aria-hidden="true"><path class="arc-fill" d="M4 37C22 13 42 3 60 3s38 10 56 34l-15 1C88 24 74 19 60 19s-28 5-41 19Z"/></svg>';

export function createCrosshair(app) {
  const ticks = ['u', 'd', 'l', 'r'].map((d) => h(`i.xh-t.xh-${d}`));
  const ring = h('i.xh-ring');
  const hit = h('div.xh-hit', null, h('i'), h('i'), h('i'), h('i'));
  const voidStamp = h('span.xh-void.stamp', null, 'Void');
  const meterFill = h('i');
  const meterLabel = h('span.label');
  const meter = h('div.xh-meter', { hidden: true }, h('div.xh-meter-bar', null, meterFill), meterLabel);
  const nums = [];
  for (let i = 0; i < NUM_POOL; i++) { const el = h('span.xh-num.display'); nums.push({ el, set: textSlot(el, ''), value: 0, at: 0, head: false }); }
  const arcs = [];
  for (let i = 0; i < ARC_POOL; i++) arcs.push(h('div.xh-arc', { html: ARC }));
  const flash = h('div.hud-hurt');
  const el = h('div.xh', { 'aria-hidden': 'true' }, arcs, ring, ticks, h('i.xh-dot'), hit, voidStamp, meter, nums.map((n) => n.el));

  const setWeapon = attrSlot(el, 'data-w');
  const setMeterFill = scaleSlot(meterFill, 'X', 100);
  const setMeterLabel = textSlot(meterLabel, '');
  const setMeterFull = classSlot(meter, 'is-full');
  let gapQ = -1;
  let ringQ = -1;
  let meterMode = '';
  let pxPerRad = 300;
  let numNext = 0;
  let arcNext = 0;
  let lastNum = null;

  function measure() {
    const fov = Number(app.state.options.fov) || 100;
    pxPerRad = (window.innerHeight / 2) / Math.tan((fov * Math.PI) / 360);
  }
  measure();
  window.addEventListener('resize', measure);

  return {
    els: [flash, el],
    measure,
    update(s) {
      const w = s.weapon | 0;
      setWeapon(String(w));
      const spreadPx = (s.spread || 0) * pxPerRad;
      // Marker: ticks close in as the charge builds
      const gap = w === 2 ? MIN_GAP[2] + 10 * (1 - (s.charge || 0)) : Math.max(MIN_GAP[w] || 5, spreadPx);
      const gq = Math.round(gap * 2);
      if (gq !== gapQ) {
        gapQ = gq;
        const g = gq / 2;
        ticks[0].style.transform = `translateY(${-g}px)`;
        ticks[1].style.transform = `translateY(${g}px)`;
        ticks[2].style.transform = `translateX(${-g}px)`;
        ticks[3].style.transform = `translateX(${g}px)`;
      }
      if (w === 1) {
        const rq = Math.round(Math.max(10, spreadPx));
        if (rq !== ringQ) { ringQ = rq; ring.style.transform = `scale(${rq / 50})`; }
      }

      const mode = s.reload != null ? 'reload' : (w === 2 && s.charge > 0.02 ? 'charge' : '');
      if (mode !== meterMode) {
        meterMode = mode;
        meter.hidden = !mode;
        if (mode) { meter.dataset.mode = mode; setMeterLabel(mode === 'reload' ? 'Reloading' : 'Charge'); }
      }
      if (mode) {
        const f = mode === 'reload' ? s.reload : s.charge;
        setMeterFill(f);
        setMeterFull(mode === 'charge' && f >= 0.995);
      }
    },

    hitmarker({ dmg, headshot, kill }) {
      hit.classList.toggle('is-head', !!headshot);
      hit.classList.toggle('is-kill', !!kill);
      play(hit, [
        { opacity: 1, transform: `scale(${kill ? 2.1 : headshot ? 1.7 : 1.4}) rotate(45deg)` },
        { opacity: 1, transform: 'scale(1) rotate(45deg)', offset: 0.3 },
        { opacity: 1, transform: 'scale(1) rotate(45deg)', offset: 0.7 },
        { opacity: 0, transform: 'scale(.9) rotate(45deg)' },
      ], { duration: kill ? 460 : 300, easing: 'ease-out' });
      if (kill) {
        play(voidStamp, [
          { opacity: 0, transform: 'rotate(-9deg) scale(2.2)' },
          { opacity: 1, transform: 'rotate(-9deg) scale(.92)', offset: 0.18 },
          { opacity: 1, transform: 'rotate(-9deg) scale(1)', offset: 0.3 },
          { opacity: 1, transform: 'rotate(-9deg) scale(1)', offset: 0.8 },
          { opacity: 0, transform: 'rotate(-9deg) scale(1)' },
        ], { duration: 900, easing: 'linear' });
      }
      const amount = Math.round(dmg || 0);
      if (amount <= 0) return;
      const now = performance.now();
      let n = lastNum;
      if (n && now - n.at < MERGE_MS && !kill) {
        n.value += amount;
        n.head = n.head || !!headshot;
      } else {
        n = nums[numNext];
        numNext = (numNext + 1) % NUM_POOL;
        n.value = amount;
        n.head = !!headshot;
        n.at = now;
        const dx = 26 + Math.random() * 30;
        const dy = -18 - Math.random() * 22;
        play(n.el, [
          { opacity: 0, transform: `translate(${dx - 8}px, ${dy + 10}px) scale(.6)` },
          { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(1.15)`, offset: 0.12 },
          { opacity: 1, transform: `translate(${dx + 4}px, ${dy - 10}px) scale(1)`, offset: 0.6 },
          { opacity: 0, transform: `translate(${dx + 8}px, ${dy - 30}px) scale(1)` },
        ], { duration: 720, easing: 'ease-out' });
        lastNum = n;
      }
      n.set(String(n.value));
      n.el.classList.toggle('is-head', n.head);
    },

    damageFrom(angle, amount) {
      const arc = arcs[arcNext];
      arcNext = (arcNext + 1) % ARC_POOL;
      const deg = (-angle * 180) / Math.PI;      // + angle = left = counter-clockwise on screen
      const heavy = amount >= 30;
      arc.classList.toggle('is-heavy', heavy);
      play(arc, [
        { opacity: 1, transform: `rotate(${deg}deg) translateY(-5.4rem) scale(1.25)` },
        { opacity: 1, transform: `rotate(${deg}deg) translateY(-4.6rem) scale(1)`, offset: 0.12 },
        { opacity: heavy ? 1 : 0.8, transform: `rotate(${deg}deg) translateY(-4.6rem) scale(1)`, offset: 0.5 },
        { opacity: 0, transform: `rotate(${deg}deg) translateY(-4.6rem) scale(1)` },
      ], { duration: 1000, easing: 'linear' });
      play(flash, [{ opacity: Math.min(0.85, 0.35 + amount / 80) }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
    },
  };
}

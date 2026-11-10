// Sample bank: renders sound definitions (see sfx/, loops.js, music/kit.js) into buffers once and
// hands out AudioBuffers. Rendering is pure math, so the Float32Arrays are cached per sample rate
// and shared by every context (live and offline); only the cheap AudioBuffer wrap is per context.
import { createDsp, finalize } from './dsp.js';
import { hashString } from '../../../shared/rng.js';

const rendered = new Map(); // "sampleRate:name:variation" -> Float32Array

function renderVariation(name, def, sr, v) {
  const key = `${sr}:${name}:${v}`;
  let x = rendered.get(key);
  if (!x) {
    x = def.make(createDsp(sr, hashString(name) + v * 9973));
    if (!def.raw) x = finalize(x, sr, def.level);
    rendered.set(key, x);
  }
  return x;
}

export function createBank(ctx, defs) {
  const sr = ctx.sampleRate, buffers = new Map();

  /** AudioBuffer[] for a sound (renders on first use — a few ms — if the warm-up has not reached it yet). */
  function get(name) {
    let list = buffers.get(name);
    if (!list) {
      list = [];
      for (let v = 0; v < (defs[name].vars || 1); v++) {
        const x = renderVariation(name, defs[name], sr, v), b = ctx.createBuffer(1, x.length, sr);
        b.getChannelData(0).set(x);
        list.push(b);
      }
      buffers.set(name, list);
    }
    return list;
  }

  /**
   * Pre-render in the background, one variation per slice, so first plays never hitch a frame.
   * Resolves when everything named is rendered.
   */
  function warm(names, budgetMs = 5) {
    const queue = [];
    for (const n of new Set(names)) for (let v = 0; v < (defs[n].vars || 1); v++) queue.push([n, v]);
    return new Promise((resolve) => {
      const step = () => {
        const t0 = performance.now();
        while (queue.length && performance.now() - t0 < budgetMs) {
          const [n, v] = queue.shift();
          renderVariation(n, defs[n], sr, v);
        }
        if (queue.length) setTimeout(step, 8);
        else resolve();
      };
      setTimeout(step, 0);
    });
  }

  return { get, warm };
}

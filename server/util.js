// Small helpers shared by the server modules: number hygiene, vectors, text sanitizing, LAN discovery.
import os from 'node:os';

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const r2 = (v) => Math.round(v * 100) / 100;
export const r3 = (v) => Math.round(v * 1000) / 1000;
export const rv = (a) => [r2(a[0]), r2(a[1]), r2(a[2])];

export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Returns a clean [x,y,z] copy, or null when `a` is not three finite numbers within ±limit. */
export function vec3(a, limit = 2000) {
  if (!Array.isArray(a) || a.length < 3) return null;
  const x = a[0], y = a[1], z = a[2];
  if (!isNum(x) || !isNum(y) || !isNum(z)) return null;
  if (Math.abs(x) > limit || Math.abs(y) > limit || Math.abs(z) > limit) return null;
  return [x, y, z];
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const distXZ = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Shortest signed difference a − b, wrapped to [−π, π]. */
export function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// C0/C1 control characters, zero-width + bidi overrides, line/paragraph separators.
const JUNK = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return [...s.replace(JUNK, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
}

/** Sanitized, unique display name. `taken` = names already in use (case-insensitive). */
export function uniqueName(raw, taken, max = 14) {
  const base = cleanText(raw, max) || 'Intern';
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = ` ${i}`;
    const name = [...base].slice(0, max - suffix.length).join('').trim() + suffix;
    if (!used.has(name.toLowerCase())) return name;
  }
  return base;
}

/** http URLs for every external IPv4 interface (what friends on the same Wi-Fi should open). */
export function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      const v4 = ni.family === 'IPv4' || ni.family === 4;
      if (v4 && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
  return urls;
}

/** Token bucket: `take()` returns false when the caller is over `perSec` (bursts up to `burst`). */
export function makeLimiter(perSec, burst) {
  let tokens = burst, last = 0;
  return (now) => {
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

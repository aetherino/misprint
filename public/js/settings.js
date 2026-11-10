// Persisted local options + player profile (localStorage; tolerant of it being unavailable).
import { INKS, FACES } from '/shared/constants.js';
import { clamp } from './util.js';

const OPTIONS_KEY = 'misprint.options';
const PROFILE_KEY = 'misprint.profile';

// `fov` is the horizontal field of view on a 16:9 screen, in degrees (see camera.js).
export const DEFAULT_OPTIONS = { sensitivity: 1, fov: 100, master: 0.8, music: 0.6, sfx: 0.9, quality: 1, invertY: false };

const LIMITS = { sensitivity: [0.05, 10], fov: [60, 130], master: [0, 1], music: [0, 1], sfx: [0, 1], quality: [0, 2] };

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / storage disabled */ }
}

/** Coerce one option to its valid range; returns undefined for unknown keys or junk values. */
export function sanitizeOption(key, value) {
  if (key === 'invertY') return !!value;
  const lim = LIMITS[key];
  const n = Number(value);
  if (!lim || !Number.isFinite(n)) return undefined;
  return clamp(key === 'quality' ? Math.round(n) : n, lim[0], lim[1]);
}

export function loadOptions() {
  const saved = read(OPTIONS_KEY);
  const out = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    const v = sanitizeOption(key, saved[key]);
    if (v !== undefined && saved[key] !== undefined) out[key] = v;
  }
  return out;
}
export const saveOptions = (options) => write(OPTIONS_KEY, options);

const pickIndex = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : Math.floor(Math.random() * n));

export function sanitizeProfile(p = {}) {
  return {
    name: String(p.name ?? '').trim().slice(0, 14),
    color: pickIndex(Number(p.color), INKS.length),
    face: pickIndex(Number(p.face), FACES.length),
  };
}
export const loadProfile = () => sanitizeProfile(read(PROFILE_KEY));
export const saveProfile = (profile) => write(PROFILE_KEY, profile);

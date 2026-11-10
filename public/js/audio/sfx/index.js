// Every one-shot definition, keyed by the public sound name (names starting with "_" are internal layers).
import weapons from './weapons.js';
import feedback from './feedback.js';
import movement from './movement.js';
import world from './world.js';
import ui from './ui.js';

export const SFX = { ...weapons, ...feedback, ...movement, ...world, ...ui };

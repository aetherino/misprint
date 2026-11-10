// MISPRINT — shared constants (imported by BOTH the node server and the browser client).
// Units: meters, seconds. Y is up. Yaw 0 looks toward -Z; positive yaw turns left (CCW from above).
// Camera rotation order is 'YXZ' => camera.rotation.set(pitch, yaw, 0).

export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 20;            // server snapshot rate and client state send rate
export const DEFAULT_PORT = 3000;
export const MAX_PLAYERS = 10;        // humans + bots

export const PLAYER = {
  radius: 0.4,
  height: 1.8,
  crouchHeight: 1.1,
  eye: 1.62,
  crouchEye: 0.95,
  headCenter: 1.56,   // head hit-sphere center above feet (times stats.scale)
  headRadius: 0.3,    // (times stats.scale, times shooter's stats.headScale)
};

export const MOVE = {
  speed: 8.2,          // ground run speed
  accelGround: 75,
  accelAir: 26,        // Quake-style air accel, wish speed capped at airWishSpeed
  airWishSpeed: 1.6,
  friction: 9,
  gravity: 24,
  terminal: 50,
  jump: 8.2,
  airJump: 7.8,
  coyote: 0.1,
  jumpBuffer: 0.12,
  stepHeight: 0.55,
  crouchSpeed: 4.2,
  slideBoost: 4.5,     // speed added when a slide starts
  slideFriction: 0.6,
  slideMinSpeed: 5.5,  // slide ends below this
  slideCooldown: 0.5,
  dashSpeed: 26,
  dashTime: 0.15,
  dashCooldown: 2.5,
  wallrunTime: 1.5,
  wallrunSpeed: 10.5,
  wallrunGravity: 4,
  wallJumpOut: 7.5,
  wallJumpUp: 8.0,
  rewindSeconds: 3,
  rewindCooldown: 14,
};

// state flags bitfield sent in `st` / `snap`
export const F = {
  GROUND: 1,
  CROUCH: 2,
  SLIDE: 4,
  WALL_L: 8,
  WALL_R: 16,
  DASH: 32,
  RELOAD: 64,
  CHARGE: 128,
  GHOST: 256,    // Watermark card is currently hiding this player
  DEAD: 512,
};

export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  ROUND_END: 'roundEnd',
  DRAFT: 'draft',
  MATCH_END: 'matchEnd',
};

export const TIMING = {
  countdown: 4,       // seconds, players are spawned but frozen
  roundEnd: 6,
  draft: 16,
  matchEnd: 12,
  respawn: 2.5,
  spawnProtect: 1.5,
};

export const DEFAULT_SETTINGS = {
  killsToWin: 8,      // kills to win a round
  roundTime: 150,     // seconds; highest kills wins at the buzzer
  roundsToWin: 3,     // round wins to take the match
  bots: 2,            // number of bots (0..6)
  botSkill: 1,        // 0 intern, 1 staff, 2 editor-in-chief
};

// Risograph ink palette. Player colors are indices into INKS.
export const INKS = [
  { name: 'Fluoro Pink',  hex: '#ff48b0' },
  { name: 'Riso Blue',    hex: '#2f6bff' },
  { name: 'Sunflower',    hex: '#ffd21f' },
  { name: 'Mint',         hex: '#19c98a' },
  { name: 'Bright Red',   hex: '#ff4b33' },
  { name: 'Violet',       hex: '#8a5cff' },
  { name: 'Orange',       hex: '#ff8a1f' },
  { name: 'Aqua',         hex: '#22c8e8' },
  { name: 'Kelly Green',  hex: '#5fd13a' },
  { name: 'Coral',        hex: '#ff7a8a' },
];

export const PAPER = '#f1e9d6';
export const INK_BLACK = '#1b1a20';

// Screen-face ids for the little "print-head" characters. Purely cosmetic.
export const FACES = ['happy', 'smug', 'angry', 'sleepy', 'cat', 'skull', 'uwu', 'glitch'];

// Arena themes: paper + two spot inks. Map generator picks one per round.
export const THEMES = [
  { name: 'NEWSPRINT', paper: '#f1e9d6', ink: '#1b1a20', a: '#2f6bff', b: '#ff48b0', sky: '#f7d9e6' },
  { name: 'BLUEPRINT', paper: '#e8eefc', ink: '#101a3a', a: '#ff8a1f', b: '#2f6bff', sky: '#cfe0ff' },
  { name: 'MIMEO',     paper: '#f6efdc', ink: '#2a1b3d', a: '#19c98a', b: '#8a5cff', sky: '#ffe9a8' },
  { name: 'HAZARD',    paper: '#f3ead0', ink: '#1c1c1c', a: '#ffd21f', b: '#ff4b33', sky: '#ffe0c2' },
  { name: 'GOLDENROD', paper: '#f4cf58', ink: '#1b1a20', a: '#7a4dff', b: '#ff4b33', sky: '#fff1c2' },
];

export function yawPitchToDir(yaw, pitch, out = [0, 0, 0]) {
  const cp = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * cp;
  return out;
}

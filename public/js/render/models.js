// The four office-supply weapons + mitten hands, built from primitives into a RigBuilder.
// Weapon space: muzzle toward -Z, +Y up, origin at the grip. Each weapon has a rigid `body` part and one
// animated `mover` part (stapler arm, punch lever, marker ink bead, blotter bottle); third-person rigs
// simply pass the same part index for both.
import { PAL } from './geo.js';

const X90 = Math.PI / 2;

/** Muzzle tip in weapon space. */
export const MUZZLE = [
  [0, 0.028, -0.37],
  [0, 0.03, -0.33],
  [0, 0, -0.47],
  [0, 0.01, -0.35],
];

/** Where the mover part pivots (weapon space) and its rest rotation about X. */
export const MOVER = [
  { pivot: [0, 0.062, 0.07], rest: 0.14 },     // stapler arm hinge (rear), resting slightly open
  { pivot: [0, 0.095, -0.2], rest: -0.22 },    // punch lever hinge (front), resting raised
  { pivot: [0, -0.012, -0.455], rest: 0 },     // marker ink bead at the tip
  { pivot: [0, 0.07, -0.1], rest: 0 },         // blotter bottle seat
];

function grip(b, part, z = 0.03) {
  b.box(0.05, 0.13, 0.065, { p: [0, -0.085, z], r: [0.3, 0, 0], part, pal: PAL.DARK });
}

const stapler = { body(b, body) {
  // base plate + staple rail + anvil
  b.box(0.1, 0.03, 0.44, { p: [0, -0.012, -0.14], part: body, pal: PAL.DARK });
  b.box(0.056, 0.03, 0.36, { p: [0, 0.018, -0.16], part: body, pal: PAL.METAL });
  b.box(0.07, 0.012, 0.05, { p: [0, 0.006, -0.335], part: body, pal: PAL.PAPER });
  b.cyl(0.03, 0.03, 0.115, { p: [0, 0.062, 0.07], r: [0, 0, X90], part: body, pal: PAL.DARK, seg: 10 });
  b.box(0.1, 0.07, 0.07, { p: [0, 0.03, 0.075], part: body, pal: PAL.ACCENT });
  grip(b, body);
}, mover(b, mover) {
  // top arm (mover space: hinge at origin, extends toward -Z)
  b.box(0.092, 0.07, 0.4, { p: [0, 0.012, -0.22], taper: [0.8, 0.96], part: mover, pal: PAL.INK });
  b.cyl(0.046, 0.046, 0.07, { p: [0, 0.012, -0.42], r: [0, 0, 0], s: [1, 1, 0.6], part: mover, pal: PAL.INK, seg: 10 });
  b.box(0.05, 0.012, 0.2, { p: [0, 0.05, -0.2], part: mover, pal: PAL.PAPER });
  b.box(0.096, 0.02, 0.06, { p: [0, -0.03, -0.41], part: mover, pal: PAL.DARK });
} };

const punch = { body(b, body) {
  // chad tray + punch block + twin barrels
  b.box(0.23, 0.035, 0.3, { p: [0, -0.03, -0.1], part: body, pal: PAL.DARK });
  b.box(0.21, 0.085, 0.17, { p: [0, 0.03, -0.12], part: body, pal: PAL.INK });
  for (const x of [-0.058, 0.058]) {
    b.cyl(0.04, 0.04, 0.2, { p: [x, 0.03, -0.23], r: [X90, 0, 0], part: body, pal: PAL.METAL, seg: 12 });
    b.cyl(0.027, 0.027, 0.01, { p: [x, 0.03, -0.331], r: [X90, 0, 0], part: body, pal: PAL.DARK, seg: 10 });
    b.cyl(0.012, 0.012, 0.05, { p: [x, 0.09, -0.11], part: body, pal: PAL.METAL, seg: 8 });
  }
  b.box(0.012, 0.03, 0.26, { p: [0.122, -0.01, -0.1], part: body, pal: PAL.PAPER });
  b.box(0.2, 0.03, 0.03, { p: [0, 0.085, -0.2], part: body, pal: PAL.DARK });
  grip(b, body, 0.02);
}, mover(b, mover) {
  // lever (mover space: hinge at origin, handle sweeps back toward +Z)
  b.box(0.17, 0.022, 0.34, { p: [0, 0.008, 0.16], part: mover, pal: PAL.PAPER });
  b.box(0.19, 0.04, 0.09, { p: [0, 0.014, 0.31], part: mover, pal: PAL.ACCENT });
} };

const marker = { body(b, body) {
  // fat barrel with an ink-colour label, rear plug, tapered collar and a chisel felt tip
  b.cyl(0.052, 0.052, 0.44, { p: [0, 0, -0.1], r: [X90, 0, 0], part: body, pal: PAL.PAPER, seg: 14 });
  b.cyl(0.055, 0.055, 0.2, { p: [0, 0, -0.1], r: [X90, 0, 0], part: body, pal: PAL.INK, seg: 14 });
  b.cyl(0.0565, 0.0565, 0.014, { p: [0, 0, 0.005], r: [X90, 0, 0], part: body, pal: PAL.DARK, seg: 14 });
  b.cyl(0.0565, 0.0565, 0.014, { p: [0, 0, -0.205], r: [X90, 0, 0], part: body, pal: PAL.DARK, seg: 14 });
  b.cyl(0.047, 0.047, 0.05, { p: [0, 0, 0.14], r: [X90, 0, 0], part: body, pal: PAL.DARK, seg: 12 });
  b.cyl(0.03, 0.052, 0.08, { p: [0, 0, -0.36], r: [-X90, 0, 0], part: body, pal: PAL.DARK, seg: 12 });
  b.box(0.05, 0.05, 0.075, { p: [0, 0, -0.432], shear: 0.03, r: [0, 0, 0], part: body, pal: PAL.GLOW });
  grip(b, body, 0.0);
}, mover(b, mover) {
  // bead of wet ink that swells at the tip while charging
  b.ball(0.03, { part: mover, pal: PAL.GLOW, seg: 10 });
} };

const blotter = { body(b, body) {
  // launcher tube with a muzzle ring, receiver, and an ink bottle seated on top
  b.cyl(0.062, 0.062, 0.3, { p: [0, 0.01, -0.17], r: [X90, 0, 0], part: body, pal: PAL.DARK, seg: 12 });
  b.cyl(0.072, 0.072, 0.04, { p: [0, 0.01, -0.325], r: [X90, 0, 0], part: body, pal: PAL.METAL, seg: 12 });
  b.cyl(0.05, 0.05, 0.006, { p: [0, 0.01, -0.347], r: [X90, 0, 0], part: body, pal: PAL.GLOW, seg: 12 });
  b.box(0.11, 0.1, 0.18, { p: [0, 0.01, 0.04], part: body, pal: PAL.INK });
  b.box(0.09, 0.02, 0.1, { p: [0, 0.062, -0.1], part: body, pal: PAL.METAL });
  grip(b, body, 0.05);
}, mover(b, mover) {
  // bottle (mover space: seat at origin, upright)
  b.cyl(0.058, 0.058, 0.1, { p: [0, 0.055, 0], part: mover, pal: PAL.PAPER, seg: 12 });
  b.cyl(0.0595, 0.0595, 0.055, { p: [0, 0.035, 0], part: mover, pal: PAL.INK, seg: 12 });
  b.cyl(0.026, 0.04, 0.03, { p: [0, 0.12, 0], part: mover, pal: PAL.PAPER, seg: 10 });
  b.cyl(0.034, 0.034, 0.03, { p: [0, 0.148, 0], part: mover, pal: PAL.DARK, seg: 10 });
} };

const BUILDERS = [stapler, punch, marker, blotter];

/**
 * Adds weapon `id`. The mover is authored relative to its pivot; rigs without a separate mover part
 * (third person: pass the same index twice) get it baked into weapon space at its rest pose.
 */
export function addWeapon(b, id, body, mover) {
  BUILDERS[id].body(b, body);
  const start = b.count;
  BUILDERS[id].mover(b, mover);
  if (mover !== body) return;
  const { pivot, rest } = MOVER[id];
  const c = Math.cos(rest), s = Math.sin(rest);
  for (let i = start; i < b.count; i++) {
    for (const arr of [b.pos, b.nor, b.out]) {
      const y = arr[i * 3 + 1], z = arr[i * 3 + 2];
      arr[i * 3 + 1] = y * c - z * s;
      arr[i * 3 + 2] = y * s + z * c;
    }
    b.pos[i * 3] += pivot[0]; b.pos[i * 3 + 1] += pivot[1]; b.pos[i * 3 + 2] += pivot[2];
  }
}

/** Mitten hand centred on the palm; `side` = +1 right, -1 left (thumb points inward). */
export function addHand(b, part, side) {
  b.ball(0.07, { s: [1, 0.95, 1.2], part, pal: PAL.PAPER, seg: 10 });
  b.ball(0.032, { p: [-side * 0.062, 0.02, -0.03], part, pal: PAL.PAPER, seg: 8 });
  b.cyl(0.06, 0.066, 0.05, { p: [0, 0, 0.09], r: [X90, 0, 0], part, pal: PAL.INK, seg: 10 });
}

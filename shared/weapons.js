// MISPRINT — weapon definitions + damage math shared by server (authority) and client (prediction/UI).
// Everyone carries all four. Infinite reserve ammo; magazines + reloads.

export const WEAPONS = [
  {
    id: 0, key: 'stapler', name: 'STAPLER', blurb: 'Full-auto. Ka-chunk ka-chunk.',
    kind: 'hitscan', auto: true,
    dmg: 14, pellets: 1, rpm: 600, mag: 28, reload: 1.45,
    spread: 0.012, spreadMove: 0.02, bloom: 0.0035, bloomMax: 0.035,
    range: 90, falloff: [16, 42, 0.5], hs: 1.6,
    recoil: 0.007, selfKnock: 0,
  },
  {
    id: 1, key: 'punch', name: 'HOLE PUNCH', blurb: 'Nine holes at once. Kicks you backwards — aim down to punch-jump.',
    kind: 'hitscan', auto: false,
    dmg: 10, pellets: 9, rpm: 70, mag: 4, reload: 1.9,
    spread: 0.07, spreadMove: 0.0, bloom: 0, bloomMax: 0,
    range: 40, falloff: [5, 20, 0.25], hs: 1.25,
    recoil: 0.05, selfKnock: 9.5,
  },
  {
    id: 2, key: 'marker', name: 'MARKER', blurb: 'Hold to charge, release to draw a line through someone.',
    kind: 'charge', auto: false,
    dmg: 34, dmgMax: 96, chargeTime: 0.95, pellets: 1, rpm: 55, mag: 3, reload: 2.1,
    spread: 0, spreadMove: 0, bloom: 0, bloomMax: 0,
    range: 220, falloff: [999, 999, 1], hs: 1.85,
    recoil: 0.03, selfKnock: 0,
  },
  {
    id: 3, key: 'blotter', name: 'BLOTTER', blurb: 'Lobs a bouncing ink bomb. Bursts on contact with players.',
    kind: 'projectile', auto: false,
    dmg: 88, pellets: 1, rpm: 62, mag: 2, reload: 2.2,
    spread: 0, spreadMove: 0, bloom: 0, bloomMax: 0,
    speed: 30, gravity: 15, bounces: 1, fuse: 1.7, radius: 4.6, projRadius: 0.22,
    selfDmg: 0.5, splashKnock: 13, hs: 1,
    recoil: 0.03, selfKnock: 0,
  },
];

export const WEAPON_BY_KEY = Object.fromEntries(WEAPONS.map((w) => [w.key, w]));

export function fireInterval(w, stats) {
  return 60 / (w.rpm * (stats ? stats.fireRate : 1));
}
export function magSize(w, stats) {
  return Math.max(1, Math.round(w.mag * (stats ? stats.mag : 1)));
}
export function reloadTime(w, stats) {
  return w.reload * (stats ? stats.reload : 1);
}
export function chargeTime(w, stats) {
  return (w.chargeTime || 0) * (stats ? stats.charge : 1);
}

// Damage of ONE pellet/shot of a hitscan/charge weapon.
// charge: 0..1 (only for kind 'charge'). attackerHpFrac: attacker hp / maxHp (Deadline card).
export function hitscanDamage(w, dist, headshot, stats, charge = 1, attackerHpFrac = 1) {
  let d = w.kind === 'charge' ? w.dmg + (w.dmgMax - w.dmg) * Math.max(0, Math.min(1, charge)) : w.dmg;
  const [f0, f1, fmin] = w.falloff;
  if (dist > f0) d *= dist >= f1 ? fmin : 1 - (1 - fmin) * ((dist - f0) / (f1 - f0));
  if (headshot) d *= w.hs * (stats ? stats.headshot : 1);
  if (stats) {
    d *= stats.dmg;
    if (stats.deadline && attackerHpFrac <= 0.35) d *= 1 + stats.deadline;
  }
  return d;
}

// Splash damage at `dist` from the explosion center. radiusMult from attacker stats.
export function splashDamage(w, dist, stats, attackerHpFrac = 1) {
  const r = w.radius * (stats ? stats.splashRadius : 1);
  if (dist >= r) return 0;
  const k = 1 - dist / r;
  let d = w.dmg * (0.25 + 0.75 * k);
  if (stats) {
    d *= stats.dmg;
    if (stats.deadline && attackerHpFrac <= 0.35) d *= 1 + stats.deadline;
  }
  return d;
}

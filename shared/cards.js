// MISPRINT — "Errata" cards. After every round, everyone except the round winner drafts one.
// Cards stack across the whole match and mutate the player's stats.
// Server owns each player's card list; everyone derives stats with computeStats(cardIds).

export const BASE_STATS = {
  // body
  maxHp: 100,
  scale: 1,            // body + hitbox + eye-height multiplier
  regen: 0,            // hp/sec after 3s without taking damage
  secondDraft: 0,      // survive lethal damage once per life (server)
  thorns: 0,           // fraction of damage reflected to attacker
  ghost: 0,            // Watermark: nearly invisible while crouched/sliding or standing still
  // movement (multipliers unless noted)
  moveSpeed: 1,
  jump: 1,
  airJumps: 1,         // count (absolute)
  gravity: 1,
  dashCharges: 1,      // count (absolute)
  dashCooldown: 1,
  wallrun: 1,          // wallrun duration multiplier
  rewindCooldown: 1,
  rewindFullHeal: 0,
  // guns (multipliers unless noted)
  dmg: 1,
  fireRate: 1,
  mag: 1,
  reload: 1,           // lower is faster
  spread: 1,
  charge: 1,           // Marker charge time multiplier (lower is faster)
  headshot: 1,
  headScale: 1,        // enemy head hit-sphere + visual size, as seen by THIS player
  bounce: 0,           // hitscan ricochets (count)
  splashRadius: 1,
  selfDmg: 1,          // multiplier on own splash damage
  // on-hit / on-kill
  lifesteal: 0,        // fraction of damage dealt healed
  killHeal: 0,         // hp on kill
  inkBurst: 0,         // victims explode: radius 5, this much damage to others nearby
  jam: 0,              // seconds of slow applied to victims on hit
  deadline: 0,         // bonus damage fraction while attacker <= 35% hp
};

const mul = (k, v) => (s) => { s[k] *= v; };
const add = (k, v) => (s) => { s[k] += v; };
const all = (...fns) => (s) => fns.forEach((f) => f(s));

// rarity: 0 common, 1 rare, 2 misprint (legendary). max = max stacks per player.
export const CARDS = [
  { id: 'double_sided', name: 'DOUBLE-SIDED', rarity: 0, max: 2, icon: 'jump',
    desc: '+1 air jump.', apply: add('airJumps', 1) },
  { id: 'hot_press', name: 'HOT OFF THE PRESS', rarity: 0, max: 3, icon: 'speed',
    desc: '+14% move speed.', apply: mul('moveSpeed', 1.14) },
  { id: 'heavy_stock', name: 'HEAVY STOCK', rarity: 0, max: 2, icon: 'shield',
    desc: '+45 max HP. You are 15% bigger and 6% slower.',
    apply: all(add('maxHp', 45), mul('scale', 1.15), mul('moveSpeed', 0.94)) },
  { id: 'pocket_edition', name: 'POCKET EDITION', rarity: 0, max: 1, icon: 'shrink',
    desc: 'You are 30% smaller. −20 max HP.', apply: all(mul('scale', 0.7), add('maxHp', -20)) },
  { id: 'overprint', name: 'OVERPRINT', rarity: 0, max: 3, icon: 'dmg',
    desc: '+22% damage. −12 max HP.', apply: all(mul('dmg', 1.22), add('maxHp', -12)) },
  { id: 'rapid_proof', name: 'RAPID PROOF', rarity: 0, max: 2, icon: 'rate',
    desc: '+25% fire rate. +20% spread.', apply: all(mul('fireRate', 1.25), mul('spread', 1.2)) },
  { id: 'bulk_order', name: 'BULK ORDER', rarity: 0, max: 2, icon: 'mag',
    desc: '+50% magazine size. 20% faster reload.', apply: all(mul('mag', 1.5), mul('reload', 0.8)) },
  { id: 'margin_of_error', name: 'MARGIN OF ERROR', rarity: 0, max: 1, icon: 'aim',
    desc: '−60% spread. Marker charges 40% faster.', apply: all(mul('spread', 0.4), mul('charge', 0.6)) },
  { id: 'royalties', name: 'ROYALTIES', rarity: 0, max: 2, icon: 'heal',
    desc: 'Heal 35 HP on every kill.', apply: add('killHeal', 35) },
  { id: 'lamination', name: 'LAMINATION', rarity: 0, max: 2, icon: 'regen',
    desc: 'Regenerate 7 HP/sec after 3 seconds out of combat.', apply: add('regen', 7) },
  { id: 'dash_dot_dash', name: 'DASH · DOT · DASH', rarity: 0, max: 2, icon: 'dash',
    desc: '+1 dash charge. Dashes recharge 15% faster.', apply: all(add('dashCharges', 1), mul('dashCooldown', 0.85)) },
  { id: 'wall_text', name: 'WALL TEXT', rarity: 0, max: 1, icon: 'wall',
    desc: 'Wall-run 3× longer.', apply: mul('wallrun', 3) },

  { id: 'bleed', name: 'FULL BLEED', rarity: 1, max: 2, icon: 'steal',
    desc: 'Heal for 20% of the damage you deal.', apply: add('lifesteal', 0.2) },
  { id: 'spot_color', name: 'SPOT COLOR', rarity: 1, max: 2, icon: 'head',
    desc: '+50% headshot damage.', apply: mul('headshot', 1.5) },
  { id: 'carbon_copy', name: 'CARBON COPY', rarity: 1, max: 2, icon: 'bounce',
    desc: 'Your bullets ricochet off one more surface.', apply: add('bounce', 1) },
  { id: 'moon_print', name: 'MOON PRINT', rarity: 1, max: 1, icon: 'moon',
    desc: 'You have 45% less gravity.', apply: mul('gravity', 0.55) },
  { id: 'thermal_paper', name: 'THERMAL PAPER', rarity: 1, max: 2, icon: 'thorns',
    desc: 'Attackers take 25% of the damage they deal to you.', apply: add('thorns', 0.25) },
  { id: 'paper_jam', name: 'PAPER JAM', rarity: 1, max: 1, icon: 'jam',
    desc: 'Your hits slow enemies for 1 second.', apply: add('jam', 1) },
  { id: 'deadline', name: 'DEADLINE', rarity: 1, max: 2, icon: 'clock',
    desc: '+45% damage while you are below 35% HP.', apply: add('deadline', 0.45) },
  { id: 'recall_notice', name: 'RECALL NOTICE', rarity: 1, max: 1, icon: 'rewind',
    desc: 'Rewind recharges twice as fast and heals you to full.',
    apply: all(mul('rewindCooldown', 0.5), add('rewindFullHeal', 1)) },
  { id: 'splash_page', name: 'SPLASH PAGE', rarity: 1, max: 2, icon: 'splash',
    desc: '+40% blast radius. Half self-damage.', apply: all(mul('splashRadius', 1.4), mul('selfDmg', 0.5)) },
  { id: 'big_headline', name: 'BIG HEADLINE', rarity: 1, max: 1, icon: 'bighead',
    desc: 'Enemy heads are 80% bigger — for you only.', apply: mul('headScale', 1.8) },

  { id: 'watermark', name: 'WATERMARK', rarity: 2, max: 1, icon: 'ghost',
    desc: 'Nearly invisible while crouching, sliding, or standing still.', apply: add('ghost', 1) },
  { id: 'ink_burst', name: 'INK BURST', rarity: 2, max: 2, icon: 'burst',
    desc: 'Enemies you kill explode in your ink, hitting others for 45.', apply: add('inkBurst', 45) },
  { id: 'second_draft', name: 'SECOND DRAFT', rarity: 2, max: 1, icon: 'revive',
    desc: 'Once per life, survive a killing blow with 1 HP.', apply: add('secondDraft', 1) },
  { id: 'typo', name: 'TYPO', rarity: 2, max: 1, icon: 'skull',
    desc: '+60% damage. Your max HP is halved.', apply: all(mul('dmg', 1.6), (s) => { s.maxHp *= 0.5; }) },
];

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));
export const RARITY_NAMES = ['COMMON', 'RARE', 'MISPRINT'];

export function computeStats(cardIds = []) {
  const s = { ...BASE_STATS };
  // additive HP first, multiplicative HP (typo) last so order of drafting never matters
  const cards = cardIds.map((id) => CARD_BY_ID[id]).filter(Boolean);
  cards.filter((c) => c.id !== 'typo').forEach((c) => c.apply(s));
  cards.filter((c) => c.id === 'typo').forEach((c) => c.apply(s));
  s.maxHp = Math.max(25, Math.round(s.maxHp));
  s.scale = Math.max(0.5, Math.min(1.6, s.scale));
  return s;
}

// Deterministic draft: `rng` from shared/rng.js. Returns `n` distinct card ids the player can still take.
// Rarity weights: common 62%, rare 30%, misprint 8%. `luck` (0..1) shifts weight toward rarer cards
// (server gives more luck to players further behind).
export function rollDraft(rng, ownedIds = [], n = 3, luck = 0) {
  const count = {};
  ownedIds.forEach((id) => { count[id] = (count[id] || 0) + 1; });
  const pool = CARDS.filter((c) => (count[c.id] || 0) < c.max);
  const weights = [0.62 - 0.3 * luck, 0.30 + 0.18 * luck, 0.08 + 0.12 * luck];
  const out = [];
  while (out.length < n && pool.length) {
    let total = 0;
    for (const c of pool) total += weights[c.rarity];
    let r = rng() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= weights[pool[idx].rarity];
      if (r <= 0) break;
    }
    out.push(pool[idx].id);
    pool.splice(idx, 1);
  }
  return out;
}

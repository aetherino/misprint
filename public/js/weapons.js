// Local weapon handling: switching, magazines, reloads, fire timing, Marker charge, spread/bloom,
// recoil, and firing (hitscan tracing or Blotter launch). Damage is the server's job.
import { MOVE } from '/shared/constants.js';
import { WEAPONS, fireInterval, magSize, reloadTime, chargeTime } from '/shared/weapons.js';
import { traceShot, shotToNet, drawShot } from './combat.js';
import { clamp, netVec, round2, TAU } from './util.js';
import { PITCH_LIMIT } from './camera.js';

const SWAP_TIME = 0.22;
const FIRE_BUFFER = 0.18;        // a semi-auto click this early still fires when the weapon is ready
const BLOOM_RECOVERY = 0.3;      // seconds to shed a full bloom
const AIM_CLIMB = 0.3;           // share of Stapler recoil that really moves the aim
const MAX_SHOTS_PER_FRAME = 3;   // catch-up limit for full-auto at very low frame rates
const AUTO_RELOAD_DELAY = 0.25;

export function createWeapons(G) {
  const w = {
    cur: 0,
    ammo: WEAPONS.map((def) => def.mag),
    cooldown: WEAPONS.map(() => 0),   // per weapon, so swapping away and back cannot skip it
    swapT: 0, reloadT: 0, reloadDur: 0,
    charging: false, charge: 0, bloom: 0,
    fireBuf: 0,          // seconds a quick click stays queued
    triggerLive: false,  // the trigger is still down from a click that has not produced a shot yet
    get reloading() { return w.reloadT > 0; },
  };
  const dir = [0, 0, 0];
  const def = () => WEAPONS[w.cur];

  function setCharging(on) {
    if (w.charging === on) return;
    w.charging = on;
    if (!on) w.charge = 0;
    G.A.loop('charge', on, { pitch: 1 });
    G.R.view.setCharge(0);
  }

  function startReload() {
    const d = def();
    if (w.reloadT > 0 || w.ammo[w.cur] >= magSize(d, G.me.stats)) return;
    setCharging(false);
    w.reloadDur = w.reloadT = reloadTime(d, G.me.stats);
    G.R.view.reload(d.id, w.reloadDur);
    G.A.play('reload_start');
  }

  // Random direction inside a cone of half-angle `spread` around unit vector d (uniform over the disc).
  function spreadDir(d, spread, out) {
    if (spread <= 0) { out[0] = d[0]; out[1] = d[1]; out[2] = d[2]; return out; }
    const a = Math.random() * TAU, r = spread * Math.sqrt(Math.random());
    let rx = -d[2], rz = d[0];                     // right = d × up
    const rl = Math.hypot(rx, rz);
    if (rl < 1e-4) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
    const ux = -rz * d[1], uy = rz * d[0] - rx * d[2], uz = rx * d[1];   // up' = right × d
    const cr = Math.cos(a) * r, sr = Math.sin(a) * r;
    out[0] = d[0] + rx * cr + ux * sr;
    out[1] = d[1] + uy * sr;
    out[2] = d[2] + rz * cr + uz * sr;
    const len = Math.hypot(out[0], out[1], out[2]);
    out[0] /= len; out[1] /= len; out[2] /= len;
    return out;
  }

  function fire(charge) {
    const d = def(), st = G.me.stats, rig = G.rig, m = G.mover, color = G.me.color;
    w.ammo[w.cur]--;
    w.cooldown[w.cur] += fireInterval(d, st);
    G.heat = Math.min(1, G.heat + 0.06);

    if (d.kind === 'projectile') {
      G.projectiles.launch(rig.eye, rig.dir);
    } else {
      const spread = w.spread();
      const from = G.R.muzzleWorldPos();
      const hits = [];
      for (let i = 0; i < d.pellets; i++) {
        const shot = traceShot(G, rig.eye, spreadDir(rig.dir, spread, dir).slice(), d.range, st.bounce);
        drawShot(G, from, shot, color, d.id, true);
        if (i === 0 && shot.n) G.A.play('impact', { pos: shot.e, vol: 0.5 });
        hits.push(shotToNet(shot));
      }
      G.net.send({ t: 'fire', w: d.id, o: netVec(rig.eye), c: round2(charge), hits });
    }

    G.R.view.fire(d.id, charge);
    G.A.play(`fire_${d.key}`, d.kind === 'charge' ? { vol: 0.45 + 0.55 * charge, pitch: 0.92 + 0.16 * charge } : undefined);

    const kick = d.recoil * (d.kind === 'charge' ? 0.5 + charge : 1);
    rig.kick += kick;
    if (d.auto) m.pitch = clamp(m.pitch + kick * AIM_CLIMB, -PITCH_LIMIT, PITCH_LIMIT);
    w.bloom = Math.min(d.bloomMax, w.bloom + d.bloom);

    if (d.selfKnock) {
      // aiming down cancels the fall first, so a punch-jump always lifts
      if (rig.dir[1] < 0 && m.vel[1] < 0) m.vel[1] *= 1 + rig.dir[1];
      m.impulse(-rig.dir[0] * d.selfKnock, -rig.dir[1] * d.selfKnock, -rig.dir[2] * d.selfKnock);
      G.R.fx.shake(0.25);
    }
  }

  /** Current cone half-angle in radians (also drives the dynamic crosshair). */
  w.spread = () => {
    const d = def(), m = G.mover;
    const moving = clamp(m.hSpeed() / (MOVE.speed * m.stats.moveSpeed), 0, 1.5);
    return (d.spread + d.spreadMove * moving + w.bloom) * G.me.stats.spread;
  };

  w.select = (i) => {
    if (i === w.cur || !WEAPONS[i]) return;
    setCharging(false);
    w.reloadT = 0;
    w.bloom = 0;
    w.cur = i;
    w.swapT = SWAP_TIME;
    G.R.view.setWeapon(i);
    G.A.play('switch');
  };

  /** Full magazines, nothing in progress (spawn). */
  w.reset = () => {
    setCharging(false);
    for (let i = 0; i < WEAPONS.length; i++) {
      w.ammo[i] = magSize(WEAPONS[i], G.me.stats);
      w.cooldown[i] = 0;
    }
    w.swapT = w.reloadT = w.bloom = w.fireBuf = 0;
    w.triggerLive = false;
    G.R.view.setWeapon(w.cur);
  };

  /** Drop anything held (death, rewind, round over). */
  w.interrupt = () => {
    setCharging(false);
    w.fireBuf = 0;
    w.triggerLive = false;
  };

  /** inp: this frame's input snapshot; `armed` false while frozen / rewinding. */
  w.update = (dt, inp, armed) => {
    const d = def(), st = G.me.stats;
    // time by which the weapon came off cooldown inside this frame (≤ 0): lets sustained auto fire
    // keep its exact rate even when frames are longer than the fire interval
    const lag = w.cooldown[w.cur] > 0 ? Math.min(0, w.cooldown[w.cur] - dt) : 0;
    for (let i = 0; i < w.cooldown.length; i++) w.cooldown[i] = Math.max(0, w.cooldown[i] - dt);
    w.swapT = Math.max(0, w.swapT - dt);
    w.bloom = Math.max(0, w.bloom - (d.bloomMax / BLOOM_RECOVERY) * dt);
    w.fireBuf -= dt;

    if (inp.select >= 0) w.select(inp.select);
    else if (inp.wheel !== 0) w.select((w.cur + Math.sign(inp.wheel) + WEAPONS.length) % WEAPONS.length);
    if (w.cur !== d.id) return;   // swapped this frame: everything below belongs to the old weapon

    if (w.reloadT > 0) {
      w.reloadT -= dt;
      if (w.reloadT <= 0) {
        w.reloadT = 0;
        w.ammo[w.cur] = magSize(d, st);
        G.A.play('reload_end');
      }
    }
    if (inp.pressed.reload) startReload();
    if (!armed) { w.interrupt(); return; }

    const ready = w.swapT <= 0 && w.reloadT <= 0;
    const loaded = w.ammo[w.cur] > 0;
    if (inp.pressed.fire) {
      w.fireBuf = FIRE_BUFFER;
      w.triggerLive = true;
      if (!loaded && w.reloadT <= 0) G.A.play('dry');
    }
    if (!inp.fire) w.triggerLive = false;
    // semi-autos fire once per click: a click still held (or made moments ago) goes off when ready
    const clicked = w.triggerLive || w.fireBuf > 0;

    if (d.kind === 'charge') {
      if (w.charging) {
        w.charge = Math.min(1, w.charge + dt / Math.max(0.05, chargeTime(d, st)));
        G.A.loop('charge', true, { pitch: 0.5 + 1.5 * w.charge });
        G.R.view.setCharge(w.charge);
        if (!inp.fire) {
          const c = w.charge;
          setCharging(false);
          fire(c);
        }
      } else if (ready && loaded && w.cooldown[w.cur] <= 0 && clicked) {
        w.fireBuf = 0;
        w.triggerLive = false;
        setCharging(true);
        if (!inp.fire) { setCharging(false); fire(0); }   // a tap shorter than one frame
      }
    } else if (ready && loaded && w.cooldown[w.cur] <= 0 && (d.auto ? inp.fire : clicked)) {
      w.fireBuf = 0;
      w.triggerLive = false;
      if (d.auto && !inp.pressed.fire) w.cooldown[w.cur] = lag;
      let shots = 0;
      do { fire(1); shots++; }
      while (d.auto && shots < MAX_SHOTS_PER_FRAME && w.cooldown[w.cur] <= 0 && w.ammo[w.cur] > 0);
      w.cooldown[w.cur] = Math.max(0, w.cooldown[w.cur]);
    }

    // out of ink: reload on its own a beat after the last shot
    if (w.ammo[w.cur] <= 0 && ready && !w.charging &&
        w.cooldown[w.cur] <= Math.max(0, fireInterval(d, st) - AUTO_RELOAD_DELAY)) startReload();
  };

  return w;
}

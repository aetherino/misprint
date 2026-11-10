// `?debug=1`: the window.__mp automation + inspection API used by tools/enginetest.mjs and by hand.
// In debug mode the game never takes pointer lock; drive it with input()/look()/aimAt().
import { PLAYER } from '/shared/constants.js';
import { magSize, WEAPONS } from '/shared/weapons.js';
import { remoteHeight } from './combat.js';
import { PITCH_LIMIT } from './camera.js';
import { clamp, yawTo } from './util.js';

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const vec = (v) => [round(v[0]), round(v[1]), round(v[2])];

export function installDebug(G, clock, actions) {
  const m = G.mover;

  return {
    G, state: G.state, R: G.R, A: G.A, UI: G.UI, net: G.net,
    /** The same callbacks the UI gets (join, start, pickCard, setOption …). */
    actions,

    /** Hold/release virtual keys: { fwd, back, left, right, jump, crouch, dash, fire, rewind, reload }. */
    input(keys) { G.input.setVirtual(keys); },
    look(yaw, pitch) {
      m.yaw = yaw;
      m.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    },
    /** Aim at a remote player's head as currently drawn. False if that player is unknown. */
    aimAt(playerId) {
      const e = G.remotes.get(playerId);
      if (!e) return false;
      const p = e.view.pos, eye = G.rig.eye;
      const head = [p[0], p[1] + remoteHeight(e) - (PLAYER.height - PLAYER.headCenter) * e.scale, p[2]];
      const dy = head[1] - eye[1];
      const len = Math.hypot(head[0] - eye[0], dy, head[2] - eye[2]) || 1;
      m.yaw = yawTo(eye, head);
      m.pitch = clamp(Math.asin(clamp(dy / len, -1, 1)) - G.rig.kick, -PITCH_LIMIT, PITCH_LIMIT);
      return true;
    },
    weapon(i) { G.weapons.select(i); },
    /** Teleport with a fresh body state (velocity, charges, timers), keeping the view direction. */
    tp(pos) {
      const pitch = m.pitch;
      m.spawn(pos, m.yaw);
      m.pitch = pitch;
      G.rewind.clear();
      G.rig.reset();
    },

    /** Take over the clock: frames stop advancing game time until advance() or hold(false). */
    hold(on = true) {
      clock.manual = on;
      G.syncSteps();
    },
    /** Run `frames` game frames of `frameDt` seconds each right now (requires hold()). */
    advance(frameDt, frames = 1) {
      for (let i = 0; i < frames; i++) G.update(frameDt);
    },

    /** JSON-safe summary of the session. Non-finite numbers come out as null and set `nan`. */
    info() {
      const s = G.state, me = G.me, w = G.weapons;
      const nums = [...m.pos, ...m.vel, m.yaw, m.pitch, me.hp, ...G.rig.eye];
      return {
        phase: s.phase, id: s.id, round: s.round, map: s.map ? s.map.name : null, seed: s.seed,
        timeLeft: round(Math.max(0, (s.endsAt - G.net.serverNow()) / 1000)),
        pos: vec(m.pos), vel: vec(m.vel), speed: round(m.hSpeed()), yaw: round(m.yaw), pitch: round(m.pitch),
        hp: round(me.hp), maxHp: me.stats.maxHp, alive: me.alive,
        weapon: w.cur, ammo: w.ammo[w.cur], ammoAll: w.ammo.slice(), mag: magSize(WEAPONS[w.cur], me.stats),
        reloading: w.reloading, charge: round(w.charge),
        flags: G.local.flags, onGround: m.onGround, crouched: m.crouched, sliding: m.sliding,
        wallrun: m.wallOn, wallSide: m.wallSide(), dashing: m.dashT > 0, dashCharges: m.dashCharges,
        airJumps: m.airJumps, rewinding: G.rewind.active, rewindCooldown: round(G.rewind.cooldown),
        apex: round(m.apex - m.airFrom), lastApex: round(m.lastApex), lastDash: round(m.lastDash),
        camera: G.rig.mode, eye: vec(G.rig.eye), projectiles: G.projectiles.count,
        fps: round(clock.fps), ping: round(G.net.ping), time: round(G.time), heat: round(G.heat),
        paused: G.paused, cards: me.cards.slice(),
        kills: G.players.get(s.id)?.kills ?? 0, deaths: G.players.get(s.id)?.deaths ?? 0,
        players: [...G.players.values()].map((p) => {
          const e = G.remotes.get(p.id);
          return {
            id: p.id, name: p.name, isBot: p.isBot, kills: p.kills, deaths: p.deaths, wins: p.wins, cards: p.cards,
            pos: p.id === s.id ? vec(m.pos) : e ? vec(e.view.pos) : null,
            alive: p.id === s.id ? me.alive : !!(e && e.view.alive),
            hp: p.id === s.id ? round(me.hp) : e ? e.hp : null,
          };
        }),
        nan: nums.some((x) => !Number.isFinite(x)),
      };
    },
  };
}

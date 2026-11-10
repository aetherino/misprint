// Server → client message handlers (SPEC §4): authoritative combat and world events turned into
// state changes, effects, sounds and UI calls. Roster / phase / draft live in flow.js.
import { PHASE } from '/shared/constants.js';
import { blast, drawShot, remoteHeight } from './combat.js';
import { clamp, wrapPi, yawTo } from './util.js';

const HEAT_RANGE_SQ = 30 * 30;   // other people's gunfire this close raises the music intensity
const _muzzle = [0, 0, 0];

export function createHandlers(G) {
  const { R, A, UI, state: s, me } = G;
  const flow = G.flow;
  const isMe = (id) => id === s.id;
  const colorOf = (id) => G.players.get(id)?.color ?? 0;

  // Where a player currently is on this screen (body center), or null if unknown.
  function centerOf(id) {
    if (isMe(id)) return [G.mover.pos[0], G.mover.pos[1] + G.mover.height * 0.5, G.mover.pos[2]];
    const e = G.remotes.get(id);
    return e ? [e.view.pos[0], e.view.pos[1] + remoteHeight(e) * 0.5, e.view.pos[2]] : null;
  }

  const feetOf = (id) => (isMe(id) ? G.mover.pos.slice() : G.remotes.get(id).view.pos.slice());

  const near = (p) => {
    const eye = G.rig.eye;
    return (p[0] - eye[0]) ** 2 + (p[1] - eye[1]) ** 2 + (p[2] - eye[2]) ** 2 < HEAT_RANGE_SQ;
  };

  const relayed = {
    dash(msg, e) { R.playerEvent(msg.id, 'dash'); R.fx.ring(msg.p, e.color, 'dash'); A.play('dash', { pos: msg.p }); },
    jump(msg) { R.playerEvent(msg.id, 'jump'); A.play('jump', { pos: msg.p, vol: 0.6 }); },
    walljump(msg) { R.playerEvent(msg.id, 'jump'); A.play('walljump', { pos: msg.p }); },
    land(msg, e) { R.fx.ring(msg.p, e.color, 'land'); A.play('land', { pos: msg.p }); },
    pad(msg, e) { R.fx.ring(msg.p, e.color, 'jumppad'); A.play('jumppad', { pos: msg.p }); },
    emote(msg) { R.playerEvent(msg.id, 'emote', msg); },
    rewind(msg, e) {
      R.fx.ring(e.view.pos.slice(), e.color, 'rewind');
      R.fx.ring(msg.p, e.color, 'rewind');
      R.playerEvent(msg.id, 'rewind');
      A.play('rewind', { pos: msg.p });
      G.remotes.place(msg.id, msg.p);
    },
  };

  return {
    welcome(msg) {
      s.id = msg.id;
      G.players.clear();
    },
    roster: flow.onRoster,
    phase: flow.onPhase,
    draft: flow.onDraft,
    picked: flow.onPicked,
    error(msg) { s.lastError = String(msg.msg || 'Connection refused'); },

    snap(msg) {
      for (const row of msg.ps) {
        if (!isMe(row[0])) G.remotes.onSnap(msg.now, row);
        else if (me.alive) me.hp = row[8];
      }
    },

    spawn(msg) {
      if (isMe(msg.id)) { G.local.spawn(msg); return; }
      G.remotes.place(msg.id, msg.p, msg.yaw);
      G.remotes.setAlive(msg.id, true);
      const e = G.remotes.get(msg.id);
      if (e) e.hp = msg.hp;
      R.playerEvent(msg.id, 'spawn');
      R.fx.ring(msg.p, colorOf(msg.id), 'spawn');
      A.play('spawn', { pos: msg.p, vol: 0.6 });
    },

    fire(msg) {
      const e = G.remotes.get(msg.id);
      if (!e) return;
      const from = G.remotes.muzzle(e, _muzzle);
      for (const hit of msg.hits) drawShot(G, from, hit, e.color, msg.w, false);
      R.playerEvent(msg.id, 'fire', msg);
      const key = ['fire_stapler', 'fire_punch', 'fire_marker'][msg.w];
      if (key) A.play(key, { pos: from });
      if (near(from)) G.heat = Math.min(1, G.heat + 0.05);
    },
    proj(msg) {
      G.projectiles.onProj(msg);
      R.playerEvent(msg.id, 'fire', msg);
      A.play('fire_blotter', { pos: msg.o });
    },
    boom(msg) { G.projectiles.onBoom(msg); },

    hit(msg) {
      const mine = isMe(msg.from), onMe = isMe(msg.to);
      if (onMe) {
        me.hp = msg.hp;
        if (msg.slow > 0) G.local.slow(msg.slow);
        if (!mine) {
          const src = centerOf(msg.from) || msg.p;
          UI.damageFrom(wrapPi(yawTo(G.mover.pos, src) - G.mover.yaw), msg.dmg);
        }
        R.fx.flash('damage');
        R.fx.shake(clamp(msg.dmg / 70, 0.15, 0.8));
        A.play('hurt');
        G.heat = Math.min(1, G.heat + 0.3);
      } else {
        const e = G.remotes.get(msg.to);
        if (e) e.hp = msg.hp;
        R.playerEvent(msg.to, 'hurt');
        if (mine) {
          UI.hitmarker({ dmg: msg.dmg, headshot: !!msg.hs, kill: false });
          A.play(msg.hs ? 'hit_head' : 'hit');
          G.heat = Math.min(1, G.heat + 0.15);
        }
      }
      // my own hitscan hits already burst when I fired (prediction)
      const predicted = mine && !onMe && msg.w >= 0 && msg.w <= 2;
      if (!predicted && msg.p) R.fx.hitPlayer(msg.p, colorOf(msg.from), !!msg.hs);
    },

    kill(msg) {
      const killer = msg.killer === null || msg.killer === undefined ? null : G.players.get(msg.killer) || null;
      const victim = G.players.get(msg.victim);
      if (!victim) return;
      const involved = isMe(msg.victim) || isMe(msg.killer);
      UI.killfeed({
        killerId: killer ? killer.id : null, killerName: killer ? killer.name : '', killerColor: killer ? killer.color : 0,
        victimId: victim.id, victimName: victim.name, victimColor: victim.color,
        weapon: msg.w, headshot: !!msg.hs, self: involved,
      });

      const at = centerOf(msg.victim);
      const ink = killer ? killer.color : victim.color;
      if (at) R.fx.death(feetOf(msg.victim), ink, victim.color);
      if (msg.burst) blast(G, msg.burst.p, msg.burst.r, ink, 0);

      if (isMe(msg.victim)) {
        G.local.die(killer);
      } else {
        G.remotes.setAlive(msg.victim, false);
        R.playerEvent(msg.victim, 'die');
        if (at) A.play('die', { pos: at });
        if (isMe(msg.killer)) {
          UI.hitmarker({ dmg: 0, headshot: !!msg.hs, kill: true });
          R.fx.flash('kill');
          A.play('kill');
          G.heat = Math.min(1, G.heat + 0.3);
        }
      }
      if (s.phase === PHASE.PLAYING) G.announcer.kill(msg, killer, victim);
    },

    heal(msg) {
      if (!isMe(msg.id)) {
        const e = G.remotes.get(msg.id);
        if (e) e.hp = msg.hp;
        return;
      }
      me.hp = msg.hp;
      if (msg.src !== 'rewind') R.fx.flash('heal');
    },

    saved(msg) {
      if (isMe(msg.id)) {
        G.announcer.saved();
        R.fx.flash('heal');
        A.play('second_draft');
      } else {
        const at = centerOf(msg.id);
        if (at) A.play('second_draft', { pos: at, vol: 0.7 });
      }
    },

    pk(msg) {
      const pk = s.pickups.find((p) => p.id === msg.id);
      if (!pk) return;
      pk.active = !!msg.active;
      R.setPickups(s.pickups);
      if (pk.active) {
        A.play('pickup_respawn', { pos: pk.pos });
        return;
      }
      const sound = pk.type === 'overprint' ? 'pickup_overprint' : 'pickup_health';
      R.fx.ring(pk.pos, colorOf(msg.by), 'pickup');
      A.play(sound, isMe(msg.by) ? undefined : { pos: pk.pos });
    },

    buff(msg) {
      if (msg.type !== 'overprint') return;
      const p = G.players.get(msg.id);
      if (p) G.announcer.overprint(p);
      if (!isMe(msg.id)) return;
      me.overprintUntil = msg.until;
      R.fx.flash('overprint');
    },

    ev(msg) {
      const e = G.remotes.get(msg.id);
      if (!e || !relayed[msg.k]) return;
      if (msg.p || msg.k === 'emote') relayed[msg.k](msg, e);
    },

    chat(msg) {
      UI.chat({ fromName: msg.system ? '' : msg.name, color: msg.color ?? 0, text: msg.text, system: !!msg.system });
      A.play('chat');
    },
  };
}

// The hub: owns the shared game context `G`, wires every engine module together, runs the frame.
import { PHASE, PROTOCOL_VERSION, DEFAULT_SETTINGS } from '/shared/constants.js';
import { computeStats } from '/shared/cards.js';
import { createNet } from './net.js';
import { createLocalPlayer } from './player.js';
import { createCameraRig } from './camera.js';
import { createWeapons } from './weapons.js';
import { createProjectiles } from './projectiles.js';
import { createRemotes } from './remote.js';
import { createAnnouncer } from './announcer.js';
import { createFlow } from './flow.js';
import { createHandlers } from './messages.js';
import { createHud } from './hud.js';
import { STEP } from './movement.js';
import { clamp } from './util.js';

// Longest slice of real time simulated in one frame. Below ~4 fps the game slows down instead of
// spiralling; above that it always runs in real time, whatever the frame rate.
const MAX_FRAME = 0.25;
const HEAT_COOLING = 0.25;       // per second
const WIND_FROM = 9;             // m/s where the wind loop fades in

export function createGame({ R, A, UI, input, options, debug, offline }) {
  const G = {
    R, A, UI, input, options, debug,
    time: 0,           // seconds of game time
    alpha: 1,          // how far the render is between the last two fixed steps
    heat: 0,           // recent combat near the player, 0..1 (feeds the music)
    paused: false,
    world: null,       // collision world of the current arena
    state: {
      id: null, phase: 'menu', round: 0, endsAt: 0, hostId: null, settings: { ...DEFAULT_SETTINGS }, joinUrls: [],
      roster: [], map: null, seed: null, mapPlayers: 0, pickups: [], winnerId: null, standings: [], draft: null, lastError: '',
    },
    players: new Map(),   // id → roster row + { stats }
    me: { alive: false, hp: 0, stats: computeStats([]), cards: [], color: -1, name: '', respawnAt: 0, killerName: '', overprintUntil: 0 },
  };
  const s = G.state, me = G.me;

  G.inArena = () => (s.phase === PHASE.COUNTDOWN || s.phase === PHASE.PLAYING) && s.map !== null;

  /** Take the mouse for gameplay (debug runs never lock; they are driven through window.__mp). */
  G.capturePointer = () => {
    G.paused = false;
    UI.setPaused(false);
    UI.setPointerLocked(debug || input.locked);
    if (!debug) input.lock();
  };
  /** Give the mouse back for menus without it counting as a pause. */
  G.releasePointer = () => {
    G.paused = false;
    UI.setPaused(false);
    input.unlock();
  };
  G.setPaused = (paused) => {
    G.paused = paused;
    UI.setPaused(paused);
  };

  G.net = createNet({ offline, onMessage, onClose });
  G.local = createLocalPlayer(G);
  G.rig = createCameraRig(G);
  G.weapons = createWeapons(G);
  G.projectiles = createProjectiles(G);
  G.remotes = createRemotes(G);
  G.announcer = createAnnouncer(G);
  G.flow = createFlow(G);
  const handlers = createHandlers(G);
  const pushHud = createHud(G);

  function onMessage(msg) {
    const handle = handlers[msg.t];
    if (handle) handle(msg);
  }

  // Back to a clean, disconnected state (the last arena stays up as a backdrop).
  function reset() {
    s.id = null;
    s.phase = 'menu';
    s.roster = [];
    G.players.clear();
    G.remotes.sync(G.players);
    G.projectiles.clear();
    me.alive = false;
    me.overprintUntil = 0;
    G.rig.mode = 'orbit';
    R.view.setVisible(false);
    G.weapons.interrupt();
    UI.showScoreboard(false);
    G.releasePointer();
  }

  function onClose() {
    const message = s.lastError || 'Lost connection to the print shop.';
    reset();
    UI.setScreen('error', { message });
    A.music('menu');
  }

  /** Connect and say hello. A failed connection surfaces through the 'error' screen. */
  G.join = async (profile) => {
    s.phase = 'connecting';
    s.lastError = '';
    UI.setScreen('connecting');
    const link = await G.net.connect();
    if (await link.opened) G.net.send({ t: 'hello', v: PROTOCOL_VERSION, name: profile.name, color: profile.color, face: profile.face });
  };

  /** Leave the match on purpose. */
  G.leave = () => {
    G.net.close();
    reset();
  };

  const view = { dt: 0, speed: 0, vel: G.mover.vel, onGround: false, sliding: false, dashing: false, wallSide: 0, lookDelta: [0, 0], hpFrac: 1, overprint: false, rewind: 0, alive: false };
  const loopOn = { slide: false, wallrun: false, wind: false, overprint: false };
  const loopOpts = { vol: 1, pitch: 1 };
  let acc = 0, lastYaw = 0, lastPitch = 0, overprinted = false;

  function loop(name, on, vol, pitch) {
    if (!on && !loopOn[name]) return;
    loopOn[name] = on;
    loopOpts.vol = vol;
    loopOpts.pitch = pitch;
    A.loop(name, on, loopOpts);
  }

  function musicIntensity(dt, hpFrac) {
    G.heat = Math.max(0, G.heat - HEAT_COOLING * dt);
    if (s.phase !== PHASE.PLAYING) return 0;
    let top = 0;
    for (const p of G.players.values()) if (p.kills > top) top = p.kills;
    const race = top / Math.max(1, s.settings.killsToWin);
    return clamp(Math.max(0.15, G.heat, (1 - hpFrac) * 0.7, race * race), 0, 1);
  }

  /** Drop any partial fixed step so a manually driven clock starts from a clean boundary. */
  G.syncSteps = () => { acc = 0; };

  /** One frame of game logic; the caller renders afterwards. */
  G.update = (frameDt) => {
    const dt = Math.min(frameDt, MAX_FRAME);
    G.time += dt;
    const now = G.net.serverNow();
    const control = G.local.control;
    const inp = input.sample(control && !G.paused && !UI.isTyping() && (debug || input.locked));
    const m = G.mover;

    if (control) G.local.begin(inp);
    acc += dt;
    while (acc >= STEP - 1e-9) {
      acc -= STEP;
      if (control) G.local.step(inp);
      if (G.world) G.projectiles.step(STEP);
    }
    G.alpha = clamp(acc / STEP, 0, 1);

    G.remotes.update(dt);
    G.rig.update(dt);
    if (control) G.local.finish(dt, inp);
    G.projectiles.draw();
    G.flow.update(now);

    const speed = control ? m.hSpeed() : 0;
    const hpFrac = me.alive ? clamp(me.hp / me.stats.maxHp, 0, 1) : 1;
    const overprint = me.alive && me.overprintUntil > now;
    if (overprinted && !overprint) A.play('overprint_end');
    overprinted = overprint;

    view.dt = dt;
    view.speed = speed;
    view.onGround = control && m.onGround;
    view.sliding = control && m.sliding;
    view.dashing = control && m.dashT > 0;
    view.wallSide = control ? m.wallSide() : 0;
    view.lookDelta[0] = m.yaw - lastYaw;
    view.lookDelta[1] = m.pitch - lastPitch;
    view.hpFrac = hpFrac;
    view.overprint = overprint;
    view.rewind = G.rewind.active ? G.rewind.progress : 0;
    view.alive = control;
    lastYaw = m.yaw;
    lastPitch = m.pitch;
    R.setView(view);

    A.setListener(G.rig.eye, G.rig.yaw);
    A.setIntensity(musicIntensity(dt, hpFrac));
    loop('slide', view.sliding, clamp(speed / 12, 0.3, 1), speed / 10);
    loop('wallrun', view.wallSide !== 0, 1, 1);
    loop('wind', control && speed > WIND_FROM, clamp((speed - WIND_FROM) / 16, 0, 1), 0.7 + speed / 30);
    loop('overprint', overprint, 1, 1);

    pushHud(now);
  };

  return G;
}

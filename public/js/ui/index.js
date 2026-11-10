// UI MODULE — pure DOM/CSS overlay above the <canvas>. The engine pushes data in through the methods
// returned by createUI and the UI reports user intent through `actions`. Signatures are the team contract.
//
// actions (provided by the engine):
//   join({ name, color, face })          menu "play" button
//   setProfile({ name, color, face })    changed in lobby
//   setMatchSettings(partial)            host only: { killsToWin, roundTime, roundsToWin, bots, botSkill }
//   start()                              host only
//   pickCard(cardId)                     draft
//   chat(text)
//   setOption(key, value)                'sensitivity' | 'fov' | 'master' | 'music' | 'sfx' | 'quality' | 'invertY'
//   resume()                             user clicked "click to play" (engine requests pointer lock)
//   backToMenu()
//
// audio: the audio module instance (the UI only plays ui_* and card_* one-shots).
//
// Layout: index.js (screen switching + overlays) · menu / wait / lobby / draft / results (screens) ·
// hud/* (in-game HUD parts) · scoreboard / pause / chat / tooltip (overlays) · widgets / cards / print /
// icons / faces / dom (shared pieces). Styles live in /css and are injected if the page did not link them.
import { DEFAULT_SETTINGS, PHASE } from '/shared/constants.js';
import { h } from './dom.js';
import { inkHex } from './faces.js';
import { createMenu } from './menu.js';
import { createConnecting, createError } from './wait.js';
import { createLobby } from './lobby.js';
import { createHud } from './hud/index.js';
import { createRoundEnd, createMatchEnd } from './results.js';
import { createDraft } from './draft.js';
import { createScoreboard } from './scoreboard.js';
import { createPause } from './pause.js';
import { createChat } from './chat.js';
import { createTooltip } from './tooltip.js';

const STYLES = ['base', 'menu', 'lobby', 'hud', 'cards', 'pages'];
const IN_MATCH = new Set(['game', 'roundEnd', 'draft', 'matchEnd']);
const CHAT_LOG_MAX = 60;

function ensureStyles() {
  for (const name of STYLES) {
    const href = `/css/${name}.css`;
    if (document.querySelector(`link[href="${href}"]`)) continue;
    document.head.appendChild(h('link', { rel: 'stylesheet', href }));
  }
}

export function createUI({ root, actions, audio }) {
  ensureStyles();
  root.classList.add('mp');

  const state = {
    screen: null,
    lobby: { selfId: null, hostId: null, joinUrls: [], settings: { ...DEFAULT_SETTINGS }, players: [], phase: PHASE.LOBBY },
    scores: [],
    options: { sensitivity: 1, fov: 100, master: 0.8, music: 0.6, sfx: 0.8, quality: 1, invertY: false },
    chatLog: [],
    paused: false,
    locked: true,
    scoreboard: false,
  };

  const app = {
    root,
    actions,
    state,
    sfx(name, opts) { if (audio && audio.play) audio.play(name, opts); },
    /** Score rows if the engine sent any, otherwise the lobby roster. */
    roster: () => (state.scores.length ? state.scores : state.lobby.players),
    player: (id) => state.lobby.players.find((p) => p.id === id) || state.scores.find((p) => p.id === id) || null,
    me: () => app.player(state.lobby.selfId),
    isTyping,
    openSettings: () => pause.open('settings'),
    onOptions() { if (screens.game) screens.game.onOptions(); },
    onPauseClosed() { state.paused = false; syncOverlays(); },
    onTypingChanged: () => syncOverlays(),
  };

  // ---------- layers ----------
  const stage = h('div.stage');
  const chat = createChat(app);
  const scoreboard = createScoreboard(app);
  const pause = createPause(app);
  const tooltip = createTooltip(root);
  const clickToPlay = h('button.overlay.ctp', { type: 'button', hidden: true, 'data-sfx': 'none', onclick: () => actions.resume() },
    h('span.ctp-card.sticker', null,
      h('span.display', null, 'Click to play'),
      h('span.ctp-sub', null, 'Your mouse aims once it is captured. Esc opens the menu.')));
  root.append(stage, chat.el, scoreboard.el, clickToPlay, pause.el, tooltip.el);

  const factories = {
    menu: createMenu, connecting: createConnecting, error: createError, lobby: createLobby,
    game: createHud, roundEnd: createRoundEnd, draft: createDraft, matchEnd: createMatchEnd,
  };
  const screens = {};
  function screen(name) {
    if (!screens[name]) {
      const s = factories[name](app);
      s.el.hidden = true;
      stage.appendChild(s.el);
      screens[name] = s;
    }
    return screens[name];
  }

  function isTyping() {
    const a = document.activeElement;
    return !!a && root.contains(a) && a.tagName === 'INPUT' && a.type === 'text';
  }

  function syncOverlays() {
    const inMatch = IN_MATCH.has(state.screen);
    chat.el.hidden = !inMatch;
    if (!inMatch && chat.isOpen) chat.close();
    scoreboard.setVisible(state.scoreboard && inMatch);
    clickToPlay.hidden = !(state.screen === 'game' && !state.locked && !state.paused && !chat.isOpen);
    root.classList.toggle('is-typing', chat.isOpen);
  }

  // ---------- ui sounds (delegated) ----------
  let hovered = null;
  root.addEventListener('pointerover', (e) => {
    const b = e.target.closest ? e.target.closest('button') : null;
    if (b === hovered) return;
    hovered = b;
    if (b && !b.disabled && b.dataset.sfx !== 'none' && b.dataset.hover !== 'none') app.sfx('ui_hover');
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('button') : null;
    if (b && !b.disabled && b.dataset.sfx !== 'none') app.sfx(b.dataset.sfx || 'ui_click');
  });

  return {
    /**
     * Switch the top-level screen:
     * 'menu' (name/color/face entry) | 'connecting' | 'lobby' | 'game' (HUD) | 'roundEnd' | 'draft' |
     * 'matchEnd' | 'error' (data: { message })
     * data for 'roundEnd': { round, winnerId, standings:[score rows], nextIn }
     * data for 'matchEnd': { winnerId, standings:[score rows] }  (optional: nextIn seconds, default TIMING.matchEnd)
     */
    setScreen(name, data) {
      if (!factories[name]) return;
      const prev = state.screen;
      const entered = prev !== name;
      if (entered && prev) {
        const p = screens[prev];
        p.el.hidden = true;
        if (p.hide) p.hide();
      }
      state.screen = name;
      if (entered) tooltip.hide();
      if (!IN_MATCH.has(name)) { state.paused = false; if (pause.mode === 'pause') pause.close(); }
      const s = screen(name);
      s.el.hidden = false;
      if (s.show) s.show(data, entered);
      syncOverlays();
    },
    /**
     * Lobby + roster state (sent whenever it changes, in every phase):
     * { selfId, hostId, joinUrls:[string], settings:{killsToWin,roundTime,roundsToWin,bots,botSkill},
     *   players:[{ id, name, color, face, isBot, wins, kills, deaths, ping, cards:[cardId] }], phase }
     */
    setLobby(next) {
      state.lobby = { ...state.lobby, ...next, players: next.players || [] };
      const me = app.me();
      if (me) root.style.setProperty('--me', inkHex(me.color));
      const cur = screens[state.screen];
      if (cur && cur.onLobby) cur.onLobby();
      scoreboard.refresh();
    },
    /** Saved local options to show in the settings panel: { sensitivity, fov, master, music, sfx, quality, invertY } */
    setOptions(opts) {
      Object.assign(state.options, opts);
      pause.paint();
      app.onOptions();
    },
    /**
     * Per-frame HUD state (must be cheap; diff before touching the DOM):
     * { alive, hp, maxHp, weapon (0..3), ammo, mag, reload: null | 0..1, charge: 0..1,
     *   dash: { charges, max, frac (0..1 progress to next charge) }, rewind: 0..1 (1 = ready),
     *   overprint: seconds left (0 = none), speed (m/s), spread (radians, for dynamic crosshair),
     *   timeLeft (s), round, kills, killsToWin, leader: { name, kills, color } | null,
     *   respawnIn: seconds | 0, killerName, slowed:boolean, ghost:boolean, cards:[cardId] }
     */
    setHud(hud) { if (state.screen === 'game') screens.game.update(hud); },
    /** Scoreboard rows (same shape as lobby players), sorted by the UI. */
    setScores(players) {
      state.scores = players || [];
      if (screens.game) screens.game.onLobby();
      scoreboard.refresh();
    },
    showScoreboard(visible) { state.scoreboard = !!visible; syncOverlays(); },
    /** { killerId, killerName, killerColor, victimId, victimName, victimColor, weapon (0..3 | -1 env/burst), headshot, self:boolean (local player involved) } */
    killfeed(e) { screen('game').killfeed(e); },
    /** Local player hit someone: { dmg, headshot, kill } */
    hitmarker(e) { if (state.screen === 'game') screens.game.hitmarker(e); },
    /** Local player took damage. angle: radians relative to view direction (0 = front, + = left). */
    damageFrom(angle, amount) { if (state.screen === 'game') screens.game.damageFrom(angle, amount); },
    /** Big zine-style announcement. style: 'kill' | 'streak' | 'round' | 'info' | 'warn' */
    announce(text, sub, style) { screen('game').announce(text, sub, style); },
    /** Countdown number before a round (4,3,2,1,0=GO). mapName shown as "NOW PRINTING: <name>" */
    countdown(n, mapName) { screen('game').countdown(n, mapName); },
    /** { fromName, color, text, system:boolean } */
    chat(msg) {
      state.chatLog.push(msg);
      if (state.chatLog.length > CHAT_LOG_MAX) state.chatLog.shift();
      chat.push(msg);
      if (screens.lobby) screens.lobby.onChat();
    },
    /**
     * Draft screen state: { options:[cardId] (empty if you won the round => "winner prints nothing"),
     *   endsAt (local ms timestamp), picked: cardId|null, isWinner:boolean,
     *   others:[{ id, name, color, picked: cardId|null }] }
     */
    setDraft(d) { screen('draft').setDraft(d); },
    /** Pointer-lock state. When false during 'game', show a "click to play" overlay that calls actions.resume(). */
    setPointerLocked(locked) { state.locked = !!locked; syncOverlays(); },
    /** True while a text field (chat, name) has focus so the engine ignores game keys. */
    isTyping,
    /** Open the chat input (engine calls on Enter). */
    openChat() {
      if (state.screen === 'lobby') screens.lobby.focusChat();
      else if (IN_MATCH.has(state.screen) && !state.paused) chat.open();
    },
    /** Toggle the in-game pause/settings menu (engine calls on Escape / pointer unlock). */
    setPaused(paused) {
      state.paused = !!paused;
      if (state.paused) { chat.close(); pause.open('pause'); } else if (pause.mode === 'pause') pause.close();
      syncOverlays();
    },
  };
}

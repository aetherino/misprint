// Match flow: roster bookkeeping, arena (re)builds, phase transitions, countdown and the draft.
import { PHASE } from '/shared/constants.js';
import { computeStats } from '/shared/cards.js';
import { generateMap } from '/shared/mapgen.js';
import { createWorld } from '/shared/physics.js';

export function createFlow(G) {
  const { R, A, UI, state: s, me } = G;
  let countdownShown = -1;

  const mapName = () => (s.map ? s.map.name : '');

  function freshDraft() {
    return { options: [], isWinner: false, picked: null, picks: new Map() };
  }
  s.draft = freshDraft();

  /** Generate + build the arena for a seed (no-op when it is already the current one). */
  function buildArena(seed, mapPlayers, pickupStates) {
    if (seed !== s.seed || mapPlayers !== s.mapPlayers) {
      s.seed = seed;
      s.mapPlayers = mapPlayers;
      s.map = generateMap(seed, mapPlayers);
      G.world = createWorld(s.map);
      G.mover.setWorld(G.world);
      G.projectiles.clear();
      R.buildWorld(s.map);
    }
    s.pickups = s.map.pickups.map((p) => ({ id: p.id, type: p.type, pos: p.pos, active: true }));
    for (const st of pickupStates || []) {
      const pk = s.pickups.find((p) => p.id === st.id);
      if (pk) pk.active = !!st.active;
    }
    R.setPickups(s.pickups);
  }

  function pushLobby() {
    UI.setLobby({ selfId: s.id, hostId: s.hostId, joinUrls: s.joinUrls, settings: s.settings, players: s.roster, phase: s.phase });
  }

  // Standings as full score rows (roster info + the frozen round numbers).
  function scoreRows(standings) {
    return standings.map((row) => ({ ...(G.players.get(row.id) || { name: '?', color: 0, face: 0, isBot: false, cards: [], ping: 0 }), ...row }));
  }

  function pushDraft() {
    const d = s.draft;
    const others = [];
    for (const p of G.players.values()) {
      if (p.id !== s.id) others.push({ id: p.id, name: p.name, color: p.color, picked: d.picks.get(p.id) ?? null });
    }
    // the UI counts down against the local clock
    const endsAt = Date.now() + (s.endsAt - G.net.serverNow());
    UI.setDraft({ options: d.options, endsAt, picked: d.picked, isWinner: d.isWinner, others });
  }

  // Leave the body behind: overview camera, no viewmodel, nothing held.
  function spectate() {
    G.rig.mode = 'orbit';
    R.view.setVisible(false);
    G.weapons.interrupt();
    UI.showScoreboard(false);
  }

  const enter = {
    [PHASE.LOBBY]() {
      me.alive = false;
      for (const e of G.remotes.list) e.view.alive = false;
      G.projectiles.clear();
      spectate();
      G.releasePointer();
      UI.setScreen('lobby');
      A.music('lobby');
    },
    [PHASE.COUNTDOWN]() {
      countdownShown = -1;
      s.draft = freshDraft();
      G.announcer.newRound();
      G.projectiles.clear();
      G.heat = 0;
      UI.setScreen('game');
      G.capturePointer();
      A.music('combat');
    },
    [PHASE.PLAYING](prev) {
      UI.setScreen('game');
      if (prev === PHASE.COUNTDOWN) {
        UI.countdown(0, mapName());
        A.play('countdown_go');
      } else {
        G.announcer.newRound();
        G.capturePointer();
        A.music('combat');
      }
    },
    [PHASE.ROUND_END]() {
      spectate();
      const nextIn = Math.max(0, (s.endsAt - G.net.serverNow()) / 1000);
      UI.setScreen('roundEnd', { round: s.round, winnerId: s.winnerId, standings: scoreRows(s.standings), nextIn });
      A.play(s.winnerId === s.id ? 'round_win' : 'round_lose');
    },
    [PHASE.DRAFT]() {
      spectate();
      G.releasePointer();
      UI.setScreen('draft');
      pushDraft();
      A.music('draft');
    },
    [PHASE.MATCH_END]() {
      spectate();
      G.releasePointer();
      UI.setScreen('matchEnd', { winnerId: s.winnerId, standings: scoreRows(s.standings) });
      A.music('victory');
      A.play(s.winnerId === s.id ? 'match_win' : 'match_lose');
    },
  };

  return {
    buildArena,

    onRoster(msg) {
      const known = G.players.size > 0;
      s.hostId = msg.hostId;
      s.settings = msg.settings;
      s.joinUrls = msg.joinUrls || [];
      s.roster = msg.players;
      const seen = new Set();
      for (const row of msg.players) {
        seen.add(row.id);
        let p = G.players.get(row.id);
        if (!p) {
          p = { cardsKey: null, stats: null };
          G.players.set(row.id, p);
          if (known && row.id !== s.id) A.play('join');
        }
        Object.assign(p, row);
        const cardsKey = (row.cards || []).join(',');
        if (p.cardsKey !== cardsKey) {
          p.cardsKey = cardsKey;
          p.stats = computeStats(row.cards);
        }
        if (row.id === s.id) {
          me.name = row.name;
          me.cards = row.cards || [];
          if (me.color !== row.color) { me.color = row.color; R.view.setInk(row.color); }
          if (me.stats !== p.stats) { me.stats = p.stats; G.mover.setStats(p.stats); }
        }
      }
      for (const id of [...G.players.keys()]) {
        if (seen.has(id)) continue;
        G.players.delete(id);
        A.play('leave');
      }
      G.remotes.sync(G.players);
      pushLobby();
      UI.setScores(msg.players);
      G.announcer.scores();
      if (s.phase === PHASE.DRAFT) pushDraft();
    },

    onPhase(msg) {
      const prev = s.phase;
      s.phase = msg.phase;
      s.round = msg.round ?? s.round;
      s.endsAt = msg.endsAt || 0;
      s.winnerId = msg.winnerId ?? null;
      s.standings = msg.standings || [];
      if (msg.seed) buildArena(msg.seed, msg.mapPlayers, msg.pickups);   // 0 / absent = no arena (lobby)
      enter[msg.phase]?.(prev);
      pushLobby();
    },

    onDraft(msg) {
      s.draft.options = msg.options || [];
      s.draft.isWinner = !!msg.isWinner;
      A.play('card_reveal');
      if (s.phase === PHASE.DRAFT) pushDraft();
    },

    onPicked(msg) {
      s.draft.picks.set(msg.id, msg.card);
      if (msg.id === s.id) s.draft.picked = msg.card;
      if (s.phase === PHASE.DRAFT) pushDraft();
    },

    /** Per frame: countdown numbers and round-clock announcements. */
    update(serverNow) {
      if (s.phase === PHASE.COUNTDOWN) {
        const n = Math.max(1, Math.ceil((s.endsAt - serverNow) / 1000));
        if (n !== countdownShown) {
          countdownShown = n;
          UI.countdown(n, mapName());
          A.play('countdown_tick');
        }
      } else if (s.phase === PHASE.PLAYING) {
        G.announcer.clock((s.endsAt - serverNow) / 1000);
      }
    },
  };
}

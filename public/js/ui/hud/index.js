// The in-game HUD. setHud arrives every frame: each part diffs its own values and only writes on change.
import { h, classSlot } from '../dom.js';
import { createVitals } from './vitals.js';
import { createGun } from './gun.js';
import { createMove } from './move.js';
import { createTop } from './top.js';
import { createCrosshair } from './crosshair.js';
import { createFeed } from './feed.js';
import { createAnnounce } from './announce.js';
import { createDeath } from './death.js';

export function createHud(app) {
  const vitals = createVitals();
  const gun = createGun();
  const move = createMove();
  const top = createTop(app);
  const crosshair = createCrosshair(app);
  const feed = createFeed();
  const announce = createAnnounce();
  const death = createDeath();
  const parts = [top, vitals, gun, move, crosshair, death];

  const el = h('div.scr.hud', null,
    crosshair.els, death.els, top.els, feed.els, announce.els, vitals.els, move.els, gun.els);
  const setDead = classSlot(el, 'is-dead');

  return {
    el,
    show() { top.onRoster(); crosshair.measure(); },
    hide() { feed.clear(); announce.clear(); },
    update(s) {
      setDead(!s.alive);
      for (let i = 0; i < parts.length; i++) parts[i].update(s);
    },
    onLobby: top.onRoster,
    onOptions: crosshair.measure,
    killfeed: feed.killfeed,
    hitmarker: crosshair.hitmarker,
    damageFrom: crosshair.damageFrom,
    announce: announce.announce,
    countdown: announce.countdown,
  };
}

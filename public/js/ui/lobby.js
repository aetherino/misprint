// Lobby: the PRESS ROOM. Built once; setLobby only patches what changed so focus and typing survive roster updates.
import { DEFAULT_SETTINGS, MAX_PLAYERS } from '/shared/constants.js';
import { WEAPONS } from '/shared/weapons.js';
import { CARD_BY_ID } from '/shared/cards.js';
import { h, svg, replace, fmtTime } from './dom.js';
import { weaponGlyph } from './icons.js';
import { cropMarks, tally, stamp, tape, colorBar } from './print.js';
import { inkHex } from './faces.js';
import { miniCard, miniBack } from './cards.js';
import {
  badge, loadProfile, saveProfile, swatchPicker, facePicker, segmented, stepper, icon, copyText, NAME_MAX,
} from './widgets.js';

const SKILLS = [{ value: 0, label: 'Intern' }, { value: 1, label: 'Staff' }, { value: 2, label: 'Editor-in-chief' }];
const SETTING_ROWS = [
  { key: 'killsToWin', label: 'Kills to win a round', min: 3, max: 30 },
  { key: 'roundTime', label: 'Round time', min: 60, max: 600, step: 30, format: fmtTime },
  { key: 'roundsToWin', label: 'Rounds to win the match', min: 1, max: 7 },
  { key: 'bots', label: 'Bots', min: 0, max: 6 },
];
const TEASER = ['carbon_copy', 'typo', 'double_sided'];

export function createLobby(app) {
  const live = h('span.sr', { 'aria-live': 'polite' });

  // ---------- join address ----------
  const urlText = h('span.join-url-text.mono');
  const copied = stamp('Copied', 'join-copied');
  copied.hidden = true;
  let copiedTimer = 0;
  let mainUrl = '';
  const copy = async (text) => {
    const ok = await copyText(text);
    copied.textContent = ok ? 'Copied' : 'Select + Ctrl C';
    copied.hidden = true;
    requestAnimationFrame(() => { copied.hidden = false; });
    live.textContent = ok ? `Copied ${text}` : 'Could not copy automatically';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.hidden = true; }, 1800);
  };
  const urlBtn = h('button.join-url', { type: 'button', title: 'Copy this address', onclick: () => copy(mainUrl) }, urlText);
  const altUrls = h('div.join-alt');
  const join = h('div.join.on-ink', null,
    h('div.join-row', null,
      h('span.join-label.head', null, 'Tell your friends to open'),
      altUrls),
    h('div.join-row.join-main', null,
      urlBtn,
      h('button.btn.btn-pink.join-copy', { type: 'button', onclick: () => copy(mainUrl) }, icon('copy'), 'Copy'),
      copied));

  // ---------- roster ----------
  const slots = h('ol.roster-slots');
  const count = h('span.mono');
  let rosterSig = '';

  function slot(p, i, st) {
    if (!p) return h('li.slot.is-empty', { 'aria-hidden': 'true' }, h('span.label', null, 'Open slot'));
    const tags = [];
    if (p.id === st.hostId) tags.push(stamp('Host', 'slot-host'));
    if (p.id === st.selfId) tags.push(h('span.tag.tag-pink', null, 'You'));
    if (p.isBot) tags.push(h('span.tag.tag-line', null, 'Bot'));
    return h(`li.slot.is-filled.slot-r${i % 4}`, { style: `--c:${inkHex(p.color)}` },
      badge(p),
      h('div.slot-main', null,
        h('span.slot-name.head', null, p.name),
        h('span.slot-meta', null,
          p.wins > 0 ? tally(p.wins) : h('span.slot-nowins', null, 'no wins yet'),
          p.isBot ? null : h('span.mono.slot-ping', null, `${Math.round(p.ping || 0)}ms`))),
      h('span.slot-tags', null, tags));
  }

  function paintRoster(st) {
    const sig = st.players.map((p) => `${p.id}|${p.name}|${p.color}|${p.face}|${p.isBot ? 1 : 0}|${p.wins}|${Math.round((p.ping || 0) / 5)}`).join(';')
      + `#${st.hostId}#${st.selfId}`;
    if (sig === rosterSig) return;
    rosterSig = sig;
    const rows = [];
    for (let i = 0; i < MAX_PLAYERS; i++) rows.push(slot(st.players[i], i, st));
    replace(slots, rows);
    count.textContent = `${st.players.length}/${MAX_PLAYERS}`;
  }

  // ---------- match settings ----------
  const send = (key, value) => app.actions.setMatchSettings({ [key]: value });
  const steppers = SETTING_ROWS.map((r) => ({ ...r, ctl: stepper(r.label, r, DEFAULT_SETTINGS[r.key], (v) => send(r.key, v)) }));
  const skill = segmented('Bot skill', SKILLS, DEFAULT_SETTINGS.botSkill, (v) => send('botSkill', v));
  const lockNote = h('p.hand.ticket-lock', null, 'only the host can edit');
  const startBtn = h('button.btn.btn-pink.ticket-start', { type: 'button', onclick: () => app.actions.start() },
    h('span.display', null, 'Start match'));
  const waiting = h('p.ticket-wait');
  const ticket = h('section.ticket.sheet.sheet-white', { 'aria-label': 'Match settings' },
    tape('left:38%;top:-.8rem;transform:rotate(-3deg)'),
    h('header.panel-head', null, h('h2.head', null, 'Job ticket'), h('span.label', null, 'Match settings')),
    h('dl.ticket-rows', null,
      steppers.map((r) => h('div.ticket-row', null, h('dt', null, r.label), h('dd', null, r.ctl.el))),
      h('div.ticket-row.ticket-row-skill', null, h('dt', null, 'Bot skill'), h('dd', null, skill.el))),
    lockNote,
    h('div.ticket-go', null, startBtn, waiting));

  function paintSettings(st) {
    const isHost = st.selfId != null && st.selfId === st.hostId;
    const s = { ...DEFAULT_SETTINGS, ...st.settings };
    steppers.forEach((r) => { r.ctl.set(s[r.key]); r.ctl.setDisabled(!isHost); });
    skill.set(s.botSkill);
    skill.setDisabled(!isHost);
    ticket.classList.toggle('is-locked', !isHost);
    lockNote.hidden = isHost;
    startBtn.hidden = !isHost;
    waiting.hidden = isHost;
    if (!isHost) {
      const host = st.players.find((p) => p.id === st.hostId);
      replace(waiting, 'Waiting for ', h('b', null, host ? host.name : 'the host'), ' to start', h('span.dots', { 'aria-hidden': 'true' }, '...'));
    }
  }

  // ---------- own profile ----------
  let profile = loadProfile();
  let nameTimer = 0;
  const pushProfile = () => { saveProfile(profile); app.actions.setProfile({ ...profile }); };
  const name = h('input.field.prof-name', { type: 'text', id: 'mp-lobby-name', maxLength: NAME_MAX, autocomplete: 'off', spellcheck: false });
  name.addEventListener('input', () => {
    profile.name = name.value.slice(0, NAME_MAX);
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => { if (profile.name.trim()) pushProfile(); }, 350);
  });
  const inks = swatchPicker(profile.color, (i) => { profile.color = i; faces.setColor(inkHex(i)); pushProfile(); });
  const faces = facePicker(profile.face, (i) => { profile.face = i; pushProfile(); });
  const me = h('section.prof.sheet', { 'aria-label': 'Your print-head' },
    h('header.panel-head', null, h('h2.head', null, 'Your sticker')),
    h('div.prof-row', null, h('label.label', { for: 'mp-lobby-name' }, 'Name'), name),
    h('div.prof-row', null, h('span.label', null, 'Ink'), inks.el),
    h('div.prof-row', null, h('span.label', null, 'Face'), faces.el));

  function syncProfile(st) {
    const self = st.players.find((p) => p.id === st.selfId);
    profile = loadProfile();
    if (self) { profile.color = self.color; profile.face = self.face; if (!profile.name) profile.name = self.name; }
    if (document.activeElement !== name) name.value = profile.name;
    inks.set(profile.color);
    faces.set(profile.face);
    faces.setColor(inkHex(profile.color));
  }

  // ---------- chat ----------
  const log = h('ol.lchat-log', { 'aria-live': 'polite', 'aria-label': 'Chat' });
  const chatInput = h('input.field.lchat-input', { type: 'text', maxLength: 140, placeholder: 'Say something', autocomplete: 'off', 'aria-label': 'Chat message' });
  const chatForm = h('form.lchat-form', {
    onsubmit: (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (text) app.actions.chat(text);
      chatInput.value = '';
    },
  }, chatInput, h('button.btn.btn-sm', { type: 'submit' }, 'Send'));
  const chat = h('section.lchat.sheet', { 'aria-label': 'Chat' },
    h('header.panel-head', null, h('h2.head', null, 'Letters to the editor')),
    log, chatForm);
  let chatCount = 0;

  function chatLine(m) {
    if (m.system) return h('li.lchat-sys', null, m.text);
    return h('li', null, h('i.lchat-ink', { style: `background:${inkHex(m.color)}` }), h('b', null, m.fromName), ' ', m.text);
  }
  function paintChat() {
    const all = app.state.chatLog;
    if (chatCount > all.length) { replace(log); chatCount = 0; }
    for (; chatCount < all.length; chatCount++) log.appendChild(chatLine(all[chatCount]));
    if (!all.length && !log.firstChild) log.appendChild(h('li.lchat-empty.hand', null, 'nobody has written in yet'));
    else if (all.length && log.firstChild.classList.contains('lchat-empty')) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  // ---------- catalogue + errata teaser (static) ----------
  const catalog = h('section.catalog.sheet', { 'aria-label': 'Weapons' },
    h('h2.catalog-title.head', null, 'Supply closet'),
    h('ul.catalog-items', null, WEAPONS.map((w) => h('li', null,
      h('span.catalog-glyph', null, svg(weaponGlyph(w.id)), h('kbd.kbd', null, String(w.id + 1))),
      h('div', null, h('h3.head', null, w.name), h('p', null, w.blurb))))));
  const errata = h('section.teaser.on-blue', { 'aria-label': 'Errata cards' },
    h('div.teaser-fan', { 'aria-hidden': 'true' }, miniBack(), ...TEASER.slice(0, 2).map((id) => miniCard(CARD_BY_ID[id]))),
    h('div.teaser-copy', null,
      h('h2.display', null, 'Errata'),
      h('p', null, 'After each round, everyone but the winner drafts one card. They stack until the match ends.')));

  const el = h('div.scr.scr-paper.lobby', null,
    cropMarks(),
    h('header.lobby-head', null,
      h('div.lobby-title', null,
        h('h1.display.misreg', null, 'Press room'),
        h('p.lobby-sub', null, colorBar(), h('span.label', null, 'Waiting for the print run'))),
      join),
    h('section.roster.sheet', { 'aria-label': 'Players' },
      h('header.panel-head', null, h('h2.head', null, 'Sticker sheet'), h('span.label', null, 'Players ', count)),
      slots),
    ticket,
    h('div.lobby-side', null, me, chat),
    h('div.lobby-foot', null, catalog, errata),
    live);

  function paintJoin(st) {
    const urls = st.joinUrls && st.joinUrls.length ? st.joinUrls : [location.origin];
    if (urls[0] !== mainUrl) {
      mainUrl = urls[0];
      const [, scheme, rest] = /^(\w+:\/\/)?(.*)$/.exec(mainUrl);
      replace(urlText, scheme ? h('span.dim', null, scheme) : null, rest);
      urlBtn.setAttribute('aria-label', `Copy join address ${mainUrl}`);
      urlBtn.style.setProperty('--len', String(Math.max(20, mainUrl.length)));
    }
    const others = urls.slice(1, 3);
    const sig = others.join(' ');
    if (altUrls.dataset.sig !== sig) {
      altUrls.dataset.sig = sig;
      replace(altUrls, others.length ? h('span.label', null, 'or') : null,
        others.map((u) => h('button.join-alt-url.mono', { type: 'button', title: 'Copy this address', onclick: () => copy(u) }, u.replace(/^http:\/\//, ''))));
    }
  }

  function render() {
    const st = app.state.lobby;
    paintJoin(st);
    paintRoster(st);
    paintSettings(st);
  }

  return {
    el,
    show(_data, entered) {
      render();
      syncProfile(app.state.lobby);
      paintChat();
      if (entered) (startBtn.hidden ? chatInput : startBtn).focus({ preventScroll: true });
    },
    onLobby: render,
    onChat: paintChat,
    focusChat() { chatInput.focus(); },
  };
}

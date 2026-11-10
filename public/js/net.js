// Connection to the game server: JSON over one WebSocket, plus the server-clock estimate.
// With `offline` the same interface is backed by an in-browser fake server (practice range).

const PING_EVERY = 2000;

/** Local wall clock in ms that never jumps backwards (Date.now() can). */
export const localNow = () => performance.timeOrigin + performance.now();

export function createNet({ offline, onMessage, onClose }) {
  let link = null;        // { send(msg), close() } of the live connection
  let pingTimer = 0;
  let offset = 0;         // server clock − local clock, as seen through the fastest packets
  let synced = false;

  const net = {
    ping: 0,
    get connected() { return link !== null; },
    /** Server time (ms) of the freshest data that can have reached us by now. */
    serverNow: () => localNow() + offset,

    async connect() {
      net.close();
      synced = false;
      const mine = offline ? await offlineLink() : socketLink();
      link = mine;
      return mine;
    },
    send(msg) { if (link) link.send(msg); },
    close() {
      if (!link) return;
      const old = link;
      link = null;
      clearInterval(pingTimer);
      old.close();
    },
  };

  // The largest (stamp − arrival) seen belongs to the least delayed packet; leak slowly toward
  // newer samples so clock drift cannot pin the estimate forever.
  function observe(serverMs) {
    const sample = serverMs - localNow();
    offset = !synced || sample > offset ? sample : offset + (sample - offset) * 0.02;
    synced = true;
  }

  function receive(msg) {
    if (typeof msg.now === 'number') observe(msg.now);
    if (msg.t === 'pong') {
      const rtt = Math.max(0, localNow() - msg.c);
      net.ping = net.ping ? net.ping + (rtt - net.ping) * 0.3 : rtt;
      observe(msg.s);
      return;
    }
    onMessage(msg);
  }

  function startPings() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => net.send({ t: 'ping', c: localNow() }), PING_EVERY);
  }

  function socketLink() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    let settle;
    const mine = {
      /** Resolves true once the socket is open, false if it closed first. */
      opened: new Promise((resolve) => { settle = resolve; }),
      send(msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
      close() { ws.close(); },
    };
    ws.onopen = () => { startPings(); settle(true); };
    ws.onmessage = (e) => {
      if (link !== mine) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && typeof msg.t === 'string') receive(msg);
    };
    ws.onclose = () => {
      settle(false);
      if (link !== mine) return;
      link = null;
      clearInterval(pingTimer);
      onClose();
    };
    return mine;
  }

  async function offlineLink() {
    const { createOfflineServer } = await import('./offline.js');
    const mine = { opened: Promise.resolve(true) };
    // JSON round-trip + async, strictly ordered delivery so offline behaves like the wire
    // (independent timers may fire out of order, a socket never does).
    const inbox = [];
    const flush = () => {
      for (const text of inbox.splice(0)) if (link === mine) receive(JSON.parse(text));
    };
    const server = createOfflineServer((msg) => {
      if (inbox.push(JSON.stringify(msg)) === 1) setTimeout(flush, 0);
    });
    mine.send = (msg) => server.receive(JSON.parse(JSON.stringify(msg)));
    mine.close = () => server.stop();
    startPings();
    return mine;
  }

  return net;
}

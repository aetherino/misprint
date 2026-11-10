#!/usr/bin/env node
// MISPRINT server: static files + one WebSocket game room.
//   node server.js [--port N] [--bots N] [--fast]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DEFAULT_PORT, DEFAULT_SETTINGS } from './shared/constants.js';
import { createStaticHandler } from './server/static.js';
import { lanUrls } from './server/util.js';
import { Game, TICK_MS } from './server/game.js';

const HEARTBEAT_MS = 2000;
const SILENCE_MS = 15000;          // drop sockets we have not heard from (frames or pongs) for this long
const HELLO_MS = 10000;            // a socket must introduce itself within this long
const MAX_FRAME = 64 * 1024;
const CONGESTED = 512 * 1024;      // skip snapshots for sockets with this much unsent data

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || DEFAULT_PORT, bots: DEFAULT_SETTINGS.bots, fast: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--port') opts.port = Number(value());
    else if (flag === '--bots') opts.bots = Number(value());
    else if (flag === '--fast') opts.fast = true;
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node server.js [--port N] [--bots N] [--fast]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('Invalid port. Example: node server.js --port 3000');
    process.exit(1);
  }
  if (!Number.isFinite(opts.bots)) opts.bots = DEFAULT_SETTINGS.bots;
  return opts;
}

function banner(port, lan, fast) {
  const line = '─'.repeat(58);
  const out = [
    '', line,
    '  MISPRINT — now printing.',
    line,
    `  You:      http://localhost:${port}`,
  ];
  if (lan.length) {
    lan.forEach((url, i) => out.push(`  ${i === 0 ? 'Friends: ' : '         '} ${url}`));
    out.push('            ↑ share this with friends on your Wi-Fi');
  } else {
    out.push('  Friends:  no LAN address found — are you connected to a network?');
  }
  out.push(
    '',
    '  Friends outside your network need a tunnel, e.g.',
    `    npx cloudflared tunnel --url http://localhost:${port}   (or Tailscale)`,
  );
  if (fast) out.push('', '  --fast: test timings are on (short countdown / draft / respawn).');
  out.push(line, '  Ctrl+C to stop the presses.', '');
  console.log(out.join('\n'));
}

const opts = parseArgs(process.argv.slice(2));
const root = path.dirname(fileURLToPath(import.meta.url));
const lan = lanUrls(opts.port);
const game = new Game({
  joinUrls: lan.length ? lan : [`http://localhost:${opts.port}`],
  bots: opts.bots,
  fast: opts.fast,
});

const server = http.createServer(createStaticHandler(root));
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
const sockets = new Set();

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* handled below */ }
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws._socket?.setNoDelay(true);
  const link = { ws, openedAt: Date.now(), heardAt: Date.now(), pingAt: 0, conn: null };
  link.conn = game.connect({
    send: (data, droppable) => {
      if (ws.readyState !== ws.OPEN) return;
      if (droppable && ws.bufferedAmount > CONGESTED) return;
      ws.send(data);
    },
    close: () => { setTimeout(() => ws.close(1000), 50); },   // let the `error` frame flush first
  });
  sockets.add(link);

  ws.on('message', (data, isBinary) => {
    link.heardAt = Date.now();
    if (isBinary) return;
    game.receive(link.conn, data.toString());
  });
  ws.on('pong', () => {
    const now = Date.now();
    link.heardAt = now;
    if (link.pingAt) game.setPing(link.conn, now - link.pingAt);
    link.pingAt = 0;
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    sockets.delete(link);
    try { game.disconnect(link.conn); } catch (err) { console.error('[misprint] error on disconnect:', err); }
  });
});

const ticker = setInterval(() => game.step(), TICK_MS);

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const link of sockets) {
    const mute = now - link.heardAt > SILENCE_MS;
    const stranger = !link.conn.player && now - link.openedAt > HELLO_MS;
    if (mute || stranger) { link.ws.terminate(); continue; }
    if (link.ws.readyState === link.ws.OPEN) {
      link.pingAt = now;
      try { link.ws.ping(); } catch { /* socket is closing */ }
    }
  }
}, HEARTBEAT_MS);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${opts.port} is already in use — is another MISPRINT server running?`);
    console.error(`Try a different one:  node server.js --port ${opts.port + 1}\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\nNot allowed to listen on port ${opts.port}. Try a port above 1024:  node server.js --port 3000\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(opts.port, () => banner(opts.port, lan, opts.fast));

function shutdown() {
  clearInterval(ticker);
  clearInterval(heartbeat);
  for (const link of sockets) link.ws.close(1001);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => console.error('[misprint] uncaught exception (still running):', err));
process.on('unhandledRejection', (err) => console.error('[misprint] unhandled rejection (still running):', err));

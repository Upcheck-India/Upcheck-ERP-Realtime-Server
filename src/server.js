'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { config, validateConfig } = require('./config');
const db = require('./db');
const { socketAuthMiddleware } = require('./auth');
const presence = require('./presence');
const { registerRoomHandlers, roomFor } = require('./rooms');
const { registerTypingHandlers } = require('./typing');
const { startMessageStreams } = require('./changeStreams/messages');
const { startNotificationStream } = require('./changeStreams/notifications');
const appstoreRoutes = require('./appstore/routes');

validateConfig();

const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: true }));

// App Store upload/download — moved from Vercel/upcheck_admin (see
// appstore/routes.js header comment). No express.json()/express.raw() body
// parser is registered anywhere in this file, which is intentional: the
// upload route needs the raw, unconsumed request stream to pipe directly
// into storage without buffering the whole APK in memory first.
app.use('/appstore', appstoreRoutes);

// Health check for the host's uptime probe. Reports connected socket count and
// DB connectivity so a quick curl tells you the pipe is alive without opening a
// client.
app.get('/health', (req, res) => {
  let dbConnected = false;
  try {
    dbConnected = !!db.getDb();
  } catch {
    dbConnected = false;
  }
  res.json({
    ok: true,
    service: 'upcheck_realtime',
    db: dbConnected ? 'connected' : 'disconnected',
    online: presence.onlineUserIds().length,
    uptimeSec: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
});

// Lightweight liveness/latency probe — does no work (no DB, no presence read),
// so it's cheap to poll frequently for round-trip timing.
app.get('/ping', (req, res) => {
  res.json({ pong: true, ts: Date.now() });
});

const server = http.createServer(app);

// Node 18+ defaults requestTimeout to 300000ms (5 min), which could kill a
// large APK upload over a slow mobile connection mid-transfer. This service
// has no execution-time ceiling to work around (that was the whole Vercel
// problem) — disable Node's own request timeout for App Store transfers.
// headersTimeout stays at a sane default (protects against slow-header DoS);
// only the full-request timeout is relevant here since headers arrive fast.
server.requestTimeout = 0;

const io = new Server(server, {
  cors: { origin: config.corsOrigins, credentials: true },
  // Allow the polling transport as a fallback for clients behind proxies that
  // block WebSocket upgrades (relevant for an enterprise ERP network).
  transports: ['websocket', 'polling'],
  // A hard disconnect (app backgrounded/killed, network drop) has no TCP FIN
  // to react to — Socket.IO only notices via this ping/pong heartbeat. At
  // 25000/20000 that was up to 45s of "still shows online" after a user was
  // actually gone, on top of the presence grace window below. Tightened to
  // bound worst-case detection at ~18s.
  pingInterval: 10000,
  pingTimeout: 8000,
});

io.use(socketAuthMiddleware);

io.on('connection', (socket) => {
  const { userId } = socket.data;

  // Every socket joins its own user room — used for presence targeting and,
  // in a later phase, per-user notification fan-out.
  socket.join(roomFor('user', userId));

  // --- Presence (Phase 1) ---
  const becameOnline = presence.addSocket(userId, socket.id);
  if (becameOnline) {
    // Broadcast to everyone (mirrors /api/online-users returning all online
    // users org-wide). Rooms are used for messaging/typing, not presence.
    io.emit('presence:online', { userId });
  }
  // Send the full current online snapshot to the just-connected client so its
  // UI is correct immediately without waiting for events.
  socket.emit('presence:snapshot', { userIds: presence.onlineUserIds() });

  // Authorized room join/leave for typing & messaging.
  registerRoomHandlers(socket);

  // Typing relay (Phase 2) — in-memory, only for rooms the socket has joined.
  registerTypingHandlers(io, socket);

  socket.on('disconnect', () => {
    presence.removeSocket(userId, socket.id, (goneUserId) => {
      io.emit('presence:offline', { userId: goneUserId });
    });
  });
});

async function start() {
  await db.connect();
  presence.init(io);
  startMessageStreams(io); // Phase 3: fan out inserts/updates to rooms
  startNotificationStream(io); // Phase 4: fan out admin_notifications inserts
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[server] upcheck_realtime listening on :${config.port} (${config.nodeEnv})`
    );
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown so redeploys don't leave sockets half-open.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[server] ${signal} received, shutting down`);
  io.close(() => {
    db.close().finally(() => process.exit(0));
  });
  // Hard cap in case sockets don't drain.
  setTimeout(() => process.exit(0), 8000).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, io };

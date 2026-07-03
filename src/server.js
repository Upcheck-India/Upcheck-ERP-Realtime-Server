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

validateConfig();

const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: true }));

// Health check for the host's uptime probe. Reports connected socket count so
// a quick curl tells you the pipe is alive without opening a client.
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'upcheck_realtime',
    online: presence.onlineUserIds().length,
    uptimeSec: Math.round(process.uptime()),
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: config.corsOrigins, credentials: true },
  // Allow the polling transport as a fallback for clients behind proxies that
  // block WebSocket upgrades (relevant for an enterprise ERP network).
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
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

  // Authorized room join/leave for typing & messaging (later phases).
  registerRoomHandlers(socket);

  socket.on('disconnect', () => {
    presence.removeSocket(userId, socket.id, (goneUserId) => {
      io.emit('presence:offline', { userId: goneUserId });
    });
  });
});

async function start() {
  await db.connect();
  presence.init(io);
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

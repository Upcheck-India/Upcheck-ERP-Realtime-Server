'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('./config');

// Socket.IO handshake auth middleware. The client fetches a short-lived JWT
// from upcheck_admin's POST /api/realtime/token and passes it as
// io(url, { auth: { token } }). We verify the signature/expiry locally with
// the shared secret — NO MongoDB round-trip to authenticate a connection.
// The token payload is { userId, username } (see realtimeToken.js).
//
// Membership authorization for individual rooms is separate (rooms.js) and
// does hit MongoDB once per join.
function socketAuthMiddleware(socket, next) {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      null;
    if (!token) {
      return next(new Error('AUTH_NO_TOKEN'));
    }
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
    });
    if (!payload?.userId) {
      return next(new Error('AUTH_BAD_PAYLOAD'));
    }
    // Attach identity to the socket for the lifetime of the connection.
    socket.data.userId = String(payload.userId);
    socket.data.username = payload.username || null;
    return next();
  } catch (err) {
    // Expired or tampered token — client should re-fetch and reconnect.
    return next(new Error('AUTH_INVALID_TOKEN'));
  }
}

module.exports = { socketAuthMiddleware };

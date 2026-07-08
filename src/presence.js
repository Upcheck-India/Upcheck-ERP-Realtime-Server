'use strict';

const { config } = require('./config');
const { getDb } = require('./db');
const { ObjectId } = require('mongodb');

// In-memory presence registry: userId -> Set<socketId>. A user is "online"
// while they have >=1 connected socket. This is the exact, event-driven
// source of truth for realtime clients; the polling fallback continues to
// read admin_users.lastActive, which we also bump opportunistically so both
// paths agree.
//
// Single-instance only. If this service is ever scaled past one process,
// swap this map for the @socket.io/redis-adapter + a shared presence store
// (called out in the migration plan §8; deliberately not built yet).
const userSockets = new Map(); // userId -> Set<socketId>
const offlineTimers = new Map(); // userId -> NodeJS.Timeout (grace window)

let ioRef = null;

function init(io) {
  ioRef = io;
  // Periodically bump lastActive for everyone currently connected so the
  // /api/online-users polling fallback stays reasonably fresh.
  setInterval(bumpLastActiveForConnected, config.lastActiveBumpMs).unref?.();
}

function onlineUserIds() {
  return Array.from(userSockets.keys());
}

function isOnline(userId) {
  return userSockets.has(String(userId));
}

// Called when a socket connects. Returns true if this made the user newly
// online (i.e. their first socket), so the caller can broadcast presence.
function addSocket(userId, socketId) {
  userId = String(userId);
  // Cancel any pending offline broadcast — they reconnected within grace.
  const pending = offlineTimers.get(userId);
  if (pending) {
    clearTimeout(pending);
    offlineTimers.delete(userId);
  }
  let set = userSockets.get(userId);
  const wasOffline = !set || set.size === 0;
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(socketId);
  bumpLastActive(userId).catch(() => {});
  return wasOffline;
}

// Called on disconnect. Schedules an offline broadcast after the grace
// window unless another socket for the user exists / reconnects. Invokes
// onOffline(userId) if the user is still gone when the window elapses.
function removeSocket(userId, socketId, onOffline) {
  userId = String(userId);
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size > 0) return; // still online via another socket/device

  // Last socket gone — start grace timer before declaring offline.
  userSockets.delete(userId);
  const timer = setTimeout(() => {
    offlineTimers.delete(userId);
    // Re-check: a reconnect during the window would have re-added the user.
    if (!userSockets.has(userId)) {
      onOffline?.(userId);
    }
  }, config.presenceGraceMs);
  timer.unref?.();
  offlineTimers.set(userId, timer);
}

async function bumpLastActive(userId) {
  try {
    const db = getDb();
    const _id = toObjectId(userId);
    if (!_id) return;
    await db
      .collection('admin_users')
      .updateOne({ _id }, { $set: { lastActive: new Date(), lastHeartbeat: new Date() } });
  } catch {
    /* best-effort; presence still works from the in-memory map */
  }
}

async function bumpLastActiveForConnected() {
  const ids = onlineUserIds();
  if (!ids.length) return;
  try {
    const db = getDb();
    const objIds = ids.map(toObjectId).filter(Boolean);
    if (!objIds.length) return;
    await db
      .collection('admin_users')
      .updateMany({ _id: { $in: objIds } }, { $set: { lastActive: new Date(), lastHeartbeat: new Date() } });
  } catch {
    /* best-effort */
  }
}

function toObjectId(id) {
  try {
    return ObjectId.isValid(id) ? new ObjectId(id) : null;
  } catch {
    return null;
  }
}

module.exports = {
  init,
  addSocket,
  removeSocket,
  isOnline,
  onlineUserIds,
};

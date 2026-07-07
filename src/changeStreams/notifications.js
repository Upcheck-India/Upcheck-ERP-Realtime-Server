'use strict';

const { getDb } = require('../db');
const { roomFor } = require('../rooms');

// Phase 4: in-app notification fan-out. Watches admin_notifications (the same
// collection /api/admin/notifications reads — see databaseNotificationHandler
// in upcheck_admin/src/lib/adminNotifications.js) and pushes new documents to
// whoever should see them, instantly, instead of the app's 15s poll.
//
// Targeting mirrors the GET route's own query exactly:
//   - targetUser absent/null -> broadcast to every connected user (org-wide
//     alert; this app's users are all admin_users, so "everyone" is correct).
//   - targetUser present -> a lowercased email; resolved to a userId (cached)
//     and emitted only to that user's own room (auto-joined by every socket
//     on connect, see server.js).
//
// Read-only: never writes. If a targetUser doesn't resolve to a known user,
// the notification is silently skipped for realtime (the poll fallback still
// works since it queries by email directly, not by our cache).

const emailToUserId = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
let cacheLoadedAt = 0;

async function refreshEmailCache() {
  const db = getDb();
  const users = await db
    .collection('admin_users')
    .find({ email: { $exists: true, $ne: null } }, { projection: { email: 1 } })
    .toArray();
  emailToUserId.clear();
  for (const u of users) {
    if (u.email) emailToUserId.set(String(u.email).toLowerCase(), u._id.toString());
  }
  cacheLoadedAt = Date.now();
}

async function resolveUserIdByEmail(email) {
  if (!email) return null;
  const key = String(email).toLowerCase();
  if (emailToUserId.has(key)) return emailToUserId.get(key);
  if (Date.now() - cacheLoadedAt > CACHE_TTL_MS || cacheLoadedAt === 0) {
    await refreshEmailCache().catch(() => {});
  }
  return emailToUserId.get(key) || null;
}

function serialize(doc) {
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch {
    return doc;
  }
}

async function handleInsert(io, doc) {
  try {
    const payload = { notification: serialize(doc) };
    if (!doc.targetUser) {
      io.emit('notification:new', payload);
      return;
    }
    const userId = await resolveUserIdByEmail(doc.targetUser);
    if (userId) {
      io.to(roomFor('user', userId)).emit('notification:new', payload);
    }
    // Unresolved target: skip realtime delivery, poll fallback still applies.
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeStreams:notifications] emit error:', err.message);
  }
}

function watchNotifications(io) {
  const db = getDb();
  let stream;
  try {
    stream = db.collection('admin_notifications').watch([{ $match: { operationType: 'insert' } }]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeStreams:notifications] failed to open stream:', err.message);
    setTimeout(() => watchNotifications(io), 5000).unref?.();
    return;
  }

  stream.on('change', (change) => {
    if (change.fullDocument) handleInsert(io, change.fullDocument);
  });

  stream.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[changeStreams:notifications] stream error, reopening:', err.message);
    try {
      stream.close();
    } catch {
      /* ignore */
    }
    setTimeout(() => watchNotifications(io), 3000).unref?.();
  });

  // eslint-disable-next-line no-console
  console.log('[changeStreams] watching admin_notifications');
}

function startNotificationStream(io) {
  refreshEmailCache().catch(() => {});
  watchNotifications(io);
}

module.exports = { startNotificationStream };

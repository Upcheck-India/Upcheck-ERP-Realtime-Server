'use strict';

const { getDb } = require('../db');
const { roomFor } = require('../rooms');

// Status updates: two independent watches, mirroring the read-only,
// write-nothing pattern of changeStreams/messages.js. All writes stay in
// upcheck_admin's /api/status routes; this just fans out inserts.
//
// - status_updates insert -> tell every connection who has the poster
//   accepted (chat_connections is directional per-row, so this is the
//   reverse of what changeStreams/messages.js looks up) that a new status
//   exists, so their feed/ring indicator can refresh instantly instead of
//   waiting for a poll.
// - status_views insert -> tell the status owner (only if they're the ones
//   who own the viewed status) that someone viewed it, so a "my status"
//   viewer-stats screen open live updates instantly.

function serialize(doc) {
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch {
    return doc;
  }
}

async function handleNewStatus(io, doc) {
  try {
    const db = getDb();
    const posterId = String(doc.userId);
    const watchers = await db.collection('chat_connections')
      .find({ peerId: posterId, status: 'accepted' }, { projection: { userId: 1 } })
      .toArray();

    watchers.forEach(({ userId }) => {
      io.to(roomFor('user', userId)).emit('status:new', { posterId, status: serialize(doc) });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeStreams:status] new-status emit error:', err.message);
  }
}

async function handleNewView(io, doc) {
  try {
    const db = getDb();
    const status = await db.collection('status_updates').findOne(
      { _id: doc.statusId },
      { projection: { userId: 1 } }
    );
    if (!status) return;
    io.to(roomFor('user', status.userId)).emit('status:viewed', {
      statusId: String(doc.statusId),
      viewerId: String(doc.viewerId),
      viewedAt: doc.viewedAt,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeStreams:status] new-view emit error:', err.message);
  }
}

function watchCollection(io, name, handler) {
  const db = getDb();
  let stream;
  try {
    stream = db.collection(name).watch([{ $match: { operationType: 'insert' } }], { fullDocument: 'updateLookup' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[changeStreams:status] failed to open ${name}:`, err.message);
    setTimeout(() => watchCollection(io, name, handler), 5000).unref?.();
    return;
  }

  stream.on('change', (change) => {
    if (change.fullDocument) handler(io, change.fullDocument);
  });

  stream.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[changeStreams:status] ${name} stream error, reopening:`, err.message);
    try {
      stream.close();
    } catch {
      /* ignore */
    }
    setTimeout(() => watchCollection(io, name, handler), 3000).unref?.();
  });

  // eslint-disable-next-line no-console
  console.log(`[changeStreams] watching ${name}`);
}

function startStatusStreams(io) {
  watchCollection(io, 'status_updates', handleNewStatus);
  watchCollection(io, 'status_views', handleNewView);
}

module.exports = { startStatusStreams };

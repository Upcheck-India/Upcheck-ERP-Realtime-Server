'use strict';

const { getDb } = require('../db');

// Phase 3: message fan-out via MongoDB Change Streams. We watch the three
// message collections and, on insert/update, emit to the matching room. This
// is the whole point of the realtime layer — clients in the room get the new
// or updated message instantly, with no "since" cursor to get stale (which is
// what caused the poll-reconciliation bugs the app previously had).
//
// Read-only: we never write. The write path stays entirely in upcheck_admin's
// API routes (chat/send, team-chat/messages, group-chats/[id]/messages).

const WATCHED = [
  { name: 'chat_messages', kind: 'dm', field: 'conversationId' },
  { name: 'team_messages', kind: 'team', field: 'teamId' },
  { name: 'group_chat_messages', kind: 'group', field: 'groupId' },
];

// Convert a Mongo document to the same JSON shape clients already receive from
// the poll endpoints (ObjectId -> hex string, Date -> ISO). ObjectId#toJSON
// and Date#toJSON make JSON.stringify do exactly this.
function serialize(doc) {
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch {
    return doc;
  }
}

function handleChange(io, cfg, change) {
  try {
    const type = change.operationType;
    if (type !== 'insert' && type !== 'update' && type !== 'replace') return;
    const doc = change.fullDocument;
    if (!doc) return; // update with no fullDocument lookup (e.g. already deleted)
    const roomId = doc[cfg.field];
    if (!roomId) return;
    const room = `${cfg.kind}:${roomId}`;
    const event = type === 'insert' ? 'message:new' : 'message:updated';
    io.to(room).emit(event, {
      kind: cfg.kind,
      id: String(roomId),
      message: serialize(doc),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeStreams] emit error:', err.message);
  }
}

function watchCollection(io, cfg) {
  const db = getDb();
  let stream;
  try {
    stream = db.collection(cfg.name).watch([], { fullDocument: 'updateLookup' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[changeStreams] failed to open ${cfg.name}:`, err.message);
    setTimeout(() => watchCollection(io, cfg), 5000).unref?.();
    return;
  }

  stream.on('change', (change) => handleChange(io, cfg, change));

  stream.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[changeStreams] ${cfg.name} stream error, reopening:`, err.message);
    try {
      stream.close();
    } catch {
      /* ignore */
    }
    setTimeout(() => watchCollection(io, cfg), 3000).unref?.();
  });

  // eslint-disable-next-line no-console
  console.log(`[changeStreams] watching ${cfg.name} -> ${cfg.kind} rooms`);
}

function startMessageStreams(io) {
  WATCHED.forEach((cfg) => watchCollection(io, cfg));
}

module.exports = { startMessageStreams };

'use strict';

const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { roomFor } = require('../rooms');

// Phase 3: message fan-out via MongoDB Change Streams. We watch the three
// message collections and, on insert/update, emit to the matching room. This
// is the whole point of the realtime layer — clients in the room get the new
// or updated message instantly, with no "since" cursor to get stale (which is
// what caused the poll-reconciliation bugs the app previously had).
//
// Read-only: we never write. The write path stays entirely in upcheck_admin's
// API routes (chat/send, team-chat/messages, group-chats/[id]/messages).
//
// The room-scoped `message:new`/`message:updated` events only reach clients
// who've explicitly joined that specific conversation/team/group room (i.e.
// have that chat open). That's correct for the open-chat case, but it means
// nothing outside an open chat — the inbox list's previews, the tab-bar
// unread badge — ever heard about new messages except via their own polling.
// So on every insert, ALSO emit a lightweight `inbox:update` to each
// recipient's own personal room (every socket auto-joins `user:<id>` on
// connect, see server.js) — just enough for a list/badge screen to know
// "something changed here, go refetch" without needing to join every room
// the user's a member of.
const WATCHED = [
  { name: 'chat_messages', kind: 'dm', field: 'conversationId' },
  { name: 'team_messages', kind: 'team', field: 'teamId' },
  { name: 'group_chat_messages', kind: 'group', field: 'groupId' },
];

async function resolveRecipients(db, kind, doc) {
  const senderId = doc.senderId ? String(doc.senderId) : null;
  try {
    if (kind === 'dm') {
      return doc.recipientId ? [String(doc.recipientId)] : [];
    }
    if (kind === 'team') {
      // team_messages.teamId is stored as a plain string (see
      // upcheck_admin's team-chat/messages/route.js), but teams._id is an
      // ObjectId — same string/ObjectId mismatch as the group branch below.
      let teamId = doc.teamId;
      try { teamId = ObjectId.isValid(teamId) ? new ObjectId(teamId) : teamId; } catch { /* keep as-is */ }
      const team = await db.collection('teams').findOne(
        { _id: teamId },
        { projection: { members: 1, lead: 1 } }
      );
      if (!team) return [];
      const ids = [...(team.members || []), team.lead].filter(Boolean).map(String);
      return [...new Set(ids)].filter((id) => id !== senderId);
    }
    if (kind === 'group') {
      // group_chat_messages.groupId is likewise a plain string.
      let groupId = doc.groupId;
      try { groupId = ObjectId.isValid(groupId) ? new ObjectId(groupId) : groupId; } catch { /* keep as-is */ }
      const group = await db.collection('group_chats').findOne(
        { _id: groupId },
        { projection: { members: 1 } }
      );
      if (!group) return [];
      return [...new Set((group.members || []).map(String))].filter((id) => id !== senderId);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeStreams] resolveRecipients error:', err.message);
  }
  return [];
}

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

async function handleChange(io, cfg, change) {
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

    // Badge/list screens outside this specific chat only care about new
    // messages (unread counts, last-message preview) — not edits.
    if (type === 'insert') {
      const db = getDb();
      const recipients = await resolveRecipients(db, cfg.kind, doc);
      recipients.forEach((userId) => {
        io.to(roomFor('user', userId)).emit('inbox:update', { kind: cfg.kind, id: String(roomId) });
      });
    }
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

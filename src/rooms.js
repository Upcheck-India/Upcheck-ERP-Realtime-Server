'use strict';

const { getDb } = require('./db');
const { ObjectId } = require('mongodb');

// Room naming convention (shared with clients):
//   dm:{conversationId}   team:{teamId}   group:{groupId}   user:{userId}
// A socket may only join a dm/team/group room after a membership check that
// mirrors the equivalent poll route in upcheck_admin. We must NOT trust
// client-supplied room names blindly (design principle §3.5).
//
// Membership results are cached per-socket for the life of the connection to
// avoid re-querying MongoDB on every message in later phases.

function roomFor(kind, id) {
  return `${kind}:${id}`;
}

function toObjectId(id) {
  try {
    return ObjectId.isValid(id) ? new ObjectId(id) : null;
  } catch {
    return null;
  }
}

// --- membership checks (mirror upcheck_admin poll routes) ---

async function isConversationParticipant(userId, conversationId) {
  const _id = toObjectId(conversationId);
  if (!_id) return false;
  const doc = await getDb()
    .collection('conversations')
    .findOne(
      { _id, participants: String(userId) },
      { projection: { _id: 1 } }
    );
  return !!doc;
}

async function isTeamMember(userId, teamId) {
  const _id = toObjectId(teamId);
  if (!_id) return false;
  const uid = String(userId);
  const doc = await getDb()
    .collection('teams')
    .findOne(
      {
        _id,
        $or: [{ members: uid }, { lead: uid }, { members: userId }, { lead: userId }],
      },
      { projection: { _id: 1 } }
    );
  return !!doc;
}

// NOTE: the existing /api/group-chats/poll route has NO membership check
// (confirmed during migration recon). We deliberately add a real one here
// rather than mirror that gap — socket rooms must be authorized.
async function isGroupMember(userId, groupId) {
  const _id = toObjectId(groupId);
  if (!_id) return false;
  const uid = String(userId);
  const group = await getDb()
    .collection('group_chats')
    .findOne(
      { _id },
      { projection: { members: 1, teams: 1 } }
    );
  if (!group) return false;
  // Direct member?
  if ((group.members || []).some((m) => String(m) === uid)) return true;
  // Member via one of the group's teams (mirrors how group messages fan out
  // to team members in group-chats/[id]/messages).
  if (Array.isArray(group.teams) && group.teams.length) {
    const teamIds = group.teams.map(toObjectId).filter(Boolean);
    if (teamIds.length) {
      const team = await getDb()
        .collection('teams')
        .findOne(
          {
            _id: { $in: teamIds },
            $or: [{ members: uid }, { lead: uid }, { members: userId }, { lead: userId }],
          },
          { projection: { _id: 1 } }
        );
      if (team) return true;
    }
  }
  return false;
}

const CHECKERS = {
  dm: isConversationParticipant,
  team: isTeamMember,
  group: isGroupMember,
};

// Registers join/leave handlers on a connected, authenticated socket. Every
// socket is auto-joined to its own user:{userId} room (used for presence and
// per-user notifications) by the caller.
function registerRoomHandlers(socket) {
  const membershipCache = new Map(); // room -> boolean

  async function handleJoin(kind, id, ack) {
    const checker = CHECKERS[kind];
    if (!checker || !id) {
      return typeof ack === 'function' && ack({ ok: false, error: 'BAD_ROOM' });
    }
    const room = roomFor(kind, id);
    try {
      let allowed = membershipCache.get(room);
      if (allowed === undefined) {
        allowed = await checker(socket.data.userId, id);
        membershipCache.set(room, allowed);
      }
      if (!allowed) {
        return typeof ack === 'function' && ack({ ok: false, error: 'FORBIDDEN' });
      }
      socket.join(room);
      return typeof ack === 'function' && ack({ ok: true, room });
    } catch (err) {
      return typeof ack === 'function' && ack({ ok: false, error: 'SERVER_ERROR' });
    }
  }

  socket.on('join', ({ kind, id } = {}, ack) => handleJoin(kind, id, ack));
  socket.on('leave', ({ kind, id } = {}, ack) => {
    if (kind && id) socket.leave(roomFor(kind, id));
    if (typeof ack === 'function') ack({ ok: true });
  });
}

module.exports = {
  roomFor,
  registerRoomHandlers,
  isConversationParticipant,
  isTeamMember,
  isGroupMember,
};

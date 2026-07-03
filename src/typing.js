'use strict';

// Pure in-memory typing relay (Phase 2). No MongoDB access at all — typing is
// ephemeral. A client emits `typing:start` on each keystroke (throttled
// client-side, same cadence as the old HTTP typing POST); we rebroadcast to
// everyone else in the room and auto-expire after TYPING_TTL_MS so a dropped
// `typing:stop` never leaves a stuck indicator.
//
// Authorization: we only relay for rooms the socket has actually joined
// (socket.rooms), and joining is membership-checked in rooms.js. So a client
// must be an authorized member of the conversation/team/group first.

const TYPING_TTL_MS = 4000;

function roomName(kind, id) {
  return `${kind}:${id}`;
}

function registerTypingHandlers(io, socket) {
  const timers = new Map(); // room -> timeout

  const clearRoom = (room) => {
    const t = timers.get(room);
    if (t) {
      clearTimeout(t);
      timers.delete(room);
    }
  };

  const emit = (room, kind, id, typing) => {
    socket.to(room).emit('typing:update', {
      kind,
      id: String(id),
      room,
      userId: socket.data.userId,
      username: socket.data.username,
      typing,
    });
  };

  socket.on('typing:start', ({ kind, id } = {}) => {
    if (!kind || !id) return;
    const room = roomName(kind, id);
    if (!socket.rooms.has(room)) return; // not joined / not authorized
    emit(room, kind, id, true);
    clearRoom(room);
    const t = setTimeout(() => {
      emit(room, kind, id, false);
      timers.delete(room);
    }, TYPING_TTL_MS);
    if (typeof t.unref === 'function') t.unref();
    timers.set(room, t);
  });

  socket.on('typing:stop', ({ kind, id } = {}) => {
    if (!kind || !id) return;
    const room = roomName(kind, id);
    clearRoom(room);
    if (socket.rooms.has(room)) emit(room, kind, id, false);
  });

  socket.on('disconnect', () => {
    // The socket has already left its rooms by now, so broadcast the stop via
    // io.to(...) rather than socket.to(...).
    for (const room of timers.keys()) {
      io.to(room).emit('typing:update', {
        room,
        userId: socket.data.userId,
        username: socket.data.username,
        typing: false,
      });
    }
    timers.clear();
  });
}

module.exports = { registerTypingHandlers };

# upcheck_realtime

Standalone realtime delivery service for Upcheck (presence, typing, messaging,
notifications), built on **Socket.IO + MongoDB Change Streams**. Companion to
the [`REALTIME_MIGRATION_PLAN.md`](../upcheck_admin/REALTIME_MIGRATION_PLAN.md)
in `upcheck_admin`.

## What it is (and is not)

- **It is** a read-only delivery layer. Clients connect over Socket.IO to
  receive live presence/typing/message events.
- **It is NOT a write path.** Clients still send messages exactly as today —
  HTTP `POST` to `upcheck_admin`'s existing API routes, which write to
  MongoDB. This service observes those writes via Change Streams and fans
  them out. If it goes down, clients silently fall back to polling.

`upcheck_admin` runs serverless on Vercel, so the socket server cannot live
inside its Next.js routes — hence this separate persistent process (same
operational shape as `upcheck_meetings_bot`).

## Status: Phases 0–3

Implemented so far:

- **Phase 0 — foundation:** HTTP server + `/health` + `/ping`, Socket.IO with
  short-lived JWT handshake auth (`src/auth.js`), MongoDB connection
  (`src/db.js`), authorized room join/leave with membership checks mirroring
  the poll routes (`src/rooms.js`).
- **Phase 1 — presence:** in-memory `userId -> Set<socketId>` registry with a
  disconnect grace window, `presence:*` events, opportunistic
  `admin_users.lastActive` bump (`src/presence.js`).
- **Phase 2 — typing:** pure in-memory typing relay over joined rooms with
  server-side auto-expiry (`src/typing.js`).
- **Phase 3 — messaging:** Change Stream watchers on `chat_messages`,
  `team_messages`, `group_chat_messages` that emit `message:new` /
  `message:updated` to the matching room (`src/changeStreams/messages.js`).

Not yet implemented: notification Change Stream (Phase 4).

## Run locally

```bash
npm install
cp .env.example .env    # fill in MONGODB_URI + REALTIME_JWT_SECRET
npm run dev
curl http://localhost:4001/health
```

`REALTIME_JWT_SECRET` **must match** the value configured in `upcheck_admin`
(it signs the token this service verifies). `MONGODB_URI` is the same Atlas
cluster.

## Client handshake

```js
import { io } from 'socket.io-client';
// token comes from POST /api/realtime/token on upcheck_admin
const socket = io(REALTIME_URL, { auth: { token }, transports: ['websocket', 'polling'] });
socket.on('presence:snapshot', ({ userIds }) => { /* seed online set */ });
socket.on('presence:online',  ({ userId }) => { /* mark online */ });
socket.on('presence:offline', ({ userId }) => { /* mark offline */ });
```

## Events

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `presence:snapshot` | server→client | `{ userIds: string[] }` | Sent once on connect |
| `presence:online` | server→client | `{ userId }` | Broadcast org-wide |
| `presence:offline` | server→client | `{ userId }` | After grace window |
| `join` | client→server | `{ kind: 'dm'\|'team'\|'group', id }`, ack | Membership-checked |
| `leave` | client→server | `{ kind, id }`, ack | |
| `typing:start` | client→server | `{ kind, id }` | Relayed to room; auto-expires ~4s |
| `typing:stop` | client→server | `{ kind, id }` | |
| `typing:update` | server→client | `{ kind, id, room, userId, username, typing }` | To others in room |
| `message:new` | server→client | `{ kind, id, message }` | Change Stream insert |
| `message:updated` | server→client | `{ kind, id, message }` | Change Stream update/replace |

Endpoints: `GET /health` (status + DB + online count), `GET /ping` (cheap liveness/latency).

## Deploy

Any host that runs a persistent Node process with outbound MongoDB Atlas
access and one inbound port (Render / Railway / Fly.io / VPS). Set the env
vars from `.env.example`. Single instance only for now — scaling past one
process requires the Socket.IO Redis adapter (see migration plan §8).

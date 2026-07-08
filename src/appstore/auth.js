'use strict';

// Bearer-token-only slice of upcheck_admin/src/lib/auth.js's session lookup.
// The mobile app always sends `Authorization: Bearer <token>` (never relies
// on the admin_token cookie — that's web-console-only), so this service only
// needs that branch, against the same admin_sessions/admin_users collections
// on the same Atlas cluster upcheck_realtime already connects to.
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');

function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7).trim();
  if (!token || token === 'null' || token === 'undefined') return null;
  return token;
}

/** Resolves the current user from a Bearer token, or null. Mirrors
 * upcheck_admin's fallback: a modern admin_sessions record first, then the
 * legacy admin_users.sessionToken field for older sessions. */
async function getAuthUser(req) {
  const token = extractBearerToken(req);
  if (!token) return null;

  const db = getDb();
  let user = null;

  const session = await db.collection('admin_sessions').findOne({ token });
  if (session) {
    user = await db.collection('admin_users').findOne({ _id: session.userId });
    if (user) {
      db.collection('admin_sessions')
        .updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } })
        .catch(() => {});
    }
  } else {
    user = await db.collection('admin_users').findOne({ sessionToken: token });
  }

  if (!user) return null;
  return { user, db };
}

function isAdminRole(role) {
  const r = (role || 'member').toLowerCase();
  return r === 'admin' || r === 'console admin' || r === 'console_admin';
}

module.exports = { getAuthUser, isAdminRole, ObjectId };

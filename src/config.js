'use strict';

require('dotenv').config();

// Central config with fail-fast validation. The two secrets that MUST match
// upcheck_admin are MONGODB_URI (same Atlas cluster) and REALTIME_JWT_SECRET
// (the key upcheck_admin signs the short-lived socket token with — see
// upcheck_admin/src/lib/realtimeToken.js). If they drift, sockets simply
// fail JWT verification and clients fall back to polling, which is safe but
// silent, so we log loudly at boot instead.
// The value used when REALTIME_JWT_SECRET is unset. upcheck_admin's
// realtimeToken.js falls back to the byte-identical string, which is what makes
// local development work with neither side configured.
//
// It is also the failure mode this file used to hide. If exactly ONE side has
// the real secret set, both keep running happily and every single handshake
// fails AUTH_INVALID_TOKEN — forever, silently. Clients then sit on the polling
// fallback showing "Connecting…" for the life of the session. validateConfig()
// below said it fail-fast on a missing secret, but could not: with this default
// applied first, config.jwtSecret is never falsy. It is checked against the raw
// env var now instead.
const DEV_JWT_SECRET = 'default_realtime_jwt_secret_key_for_development';

const config = {
  port: parseInt(process.env.PORT || '4001', 10),
  mongoUri: process.env.MONGODB_URI || '',
  mongoDbName: process.env.MONGODB_DB || 'resources',
  jwtSecret: process.env.REALTIME_JWT_SECRET || DEV_JWT_SECRET,
  // Comma-separated allowlist of web origins for CORS. The RN app sends no
  // Origin header so it is unaffected; this only gates the browser console.
  corsOrigins: (process.env.CORS_ORIGINS || 'https://erp.upcheck.in')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Grace window (ms) before a disconnect is broadcast as offline, to absorb
  // page reloads / app backgrounding blips without a flicker.
  presenceGraceMs: parseInt(process.env.PRESENCE_GRACE_MS || '3000', 10),
  // How often (ms) to opportunistically bump admin_users.lastHeartbeat for
  // connected users so the polling fallback (/api/online-users) stays
  // accurate. Must stay comfortably under that endpoint's freshness cutoff
  // (currently 30s there) — this was 60000 against a 20000 cutoff, meaning a
  // genuinely-connected user was reported offline by that endpoint for ~40 of
  // every 60 seconds.
  lastActiveBumpMs: parseInt(process.env.LAST_ACTIVE_BUMP_MS || '15000', 10),
  nodeEnv: process.env.NODE_ENV || 'production',
};

function validateConfig() {
  const missing = [];
  if (!config.mongoUri) missing.push('MONGODB_URI');
  // Deliberately the raw env var, not config.jwtSecret — see DEV_JWT_SECRET.
  if (!process.env.REALTIME_JWT_SECRET) {
    if (config.nodeEnv === 'development') {
      // eslint-disable-next-line no-console
      console.warn(
        '[config] REALTIME_JWT_SECRET is unset; using the shared development ' +
          'secret. upcheck_admin must be unset too or no socket will authenticate.'
      );
    } else {
      missing.push('REALTIME_JWT_SECRET');
    }
  }
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[config] FATAL: missing required env vars: ${missing.join(', ')}. ` +
        'Refusing to start — sockets would silently fail auth.'
    );
    process.exit(1);
  }
}

// A short, non-reversible fingerprint of the shared JWT secret.
//
// A mismatch between this service and upcheck_admin is invisible from either
// side alone — both start fine, and every handshake just fails. Comparing the
// fingerprint reported by GET /health here against the one in
// POST /api/realtime/token's response over there answers "are these the same
// secret?" in one step, without either service ever printing the secret.
function jwtSecretFingerprint() {
  return require('crypto')
    .createHash('sha256')
    .update(config.jwtSecret)
    .digest('hex')
    .slice(0, 8);
}

module.exports = { config, validateConfig, jwtSecretFingerprint };

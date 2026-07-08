'use strict';

require('dotenv').config();

// Central config with fail-fast validation. The two secrets that MUST match
// upcheck_admin are MONGODB_URI (same Atlas cluster) and REALTIME_JWT_SECRET
// (the key upcheck_admin signs the short-lived socket token with — see
// upcheck_admin/src/lib/realtimeToken.js). If they drift, sockets simply
// fail JWT verification and clients fall back to polling, which is safe but
// silent, so we log loudly at boot instead.
const config = {
  port: parseInt(process.env.PORT || '4001', 10),
  mongoUri: process.env.MONGODB_URI || '',
  mongoDbName: process.env.MONGODB_DB || 'resources',
  jwtSecret: process.env.REALTIME_JWT_SECRET || 'default_realtime_jwt_secret_key_for_development',
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
  if (!config.jwtSecret) missing.push('REALTIME_JWT_SECRET');
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[config] FATAL: missing required env vars: ${missing.join(', ')}. ` +
        'Refusing to start — sockets would silently fail auth.'
    );
    process.exit(1);
  }
}

module.exports = { config, validateConfig };

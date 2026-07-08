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
  presenceGraceMs: parseInt(process.env.PRESENCE_GRACE_MS || '5000', 10),
  // How often (ms) to opportunistically bump admin_users.lastActive for
  // connected users so the polling fallback (/api/online-users) stays roughly
  // accurate too.
  lastActiveBumpMs: parseInt(process.env.LAST_ACTIVE_BUMP_MS || '60000', 10),
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

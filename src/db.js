'use strict';

const { MongoClient } = require('mongodb');
const { config } = require('./config');

// Single shared MongoClient for the process. Mostly a read path (membership
// checks, presence lastActive bump) plus Change Streams; message/business
// data writes stay in upcheck_admin's Next.js API routes. The one exception
// is appstore/ — APK upload/download was moved here from Vercel (see
// APPSTORE_ROOT_CAUSE_INVESTIGATION.md in upcheck_admin), so this service
// does write appstore_apps.versions and appstore_apks GridFS data.
let client = null;
let db = null;

async function connect() {
  if (db) return db;
  client = new MongoClient(config.mongoUri, {
    maxPoolSize: 20,
    // Change Streams need a replica set; Atlas is one by default. No special
    // options required here beyond a healthy pool.
  });
  await client.connect();
  db = client.db(config.mongoDbName);
  // eslint-disable-next-line no-console
  console.log(`[db] connected to ${config.mongoDbName}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('[db] getDb() called before connect()');
  return db;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connect, getDb, close };

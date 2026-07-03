'use strict';

const { MongoClient } = require('mongodb');
const { config } = require('./config');

// Single shared MongoClient for the process. This service only ever READS
// (membership checks, presence lastActive bump) and opens Change Streams;
// it is never a write path for message/business data — that stays in
// upcheck_admin's Next.js API routes.
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

'use strict';

// Validates and stores an uploaded APK, then records the new version on the
// app document. Adapted from upcheck_admin/src/lib/appstore/finalizeUpload.js:
// the original concatenated N on-disk chunk files (a workaround for Vercel's
// ~4.5MB body limit spread across multiple requests/serverless invocations)
// into one logical stream before this same validate+store pipeline. Here the
// incoming HTTP request body IS already one continuous stream — no chunking,
// no temp files, no cross-invocation session state — so this pipes directly
// from `req`.
const { ObjectId } = require('mongodb');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const { sendPushNotification } = require('./pushNotification');
const { getActiveProvider, getProviderForVersion } = require('./storage');

const MAX_APK_SIZE_BYTES = 250 * 1024 * 1024; // 250MB
const VERSION_RE = /^\d{1,4}(\.\d{1,4}){1,3}(-[a-zA-Z0-9.]+)?$/;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

class SizeLimitStream extends Transform {
  constructor(maxBytes, opts) {
    super(opts);
    this.maxBytes = maxBytes;
    this.total = 0;
  }
  _transform(chunk, _enc, cb) {
    this.total += chunk.length;
    if (this.total > this.maxBytes) {
      cb(new Error('FILE_TOO_LARGE'));
      return;
    }
    cb(null, chunk);
  }
}

class ZipMagicCheckStream extends Transform {
  constructor(opts) {
    super(opts);
    this._header = Buffer.alloc(0);
    this._checked = false;
  }
  _transform(chunk, _enc, cb) {
    if (this._checked) {
      cb(null, chunk);
      return;
    }
    this._header = this._header.length ? Buffer.concat([this._header, chunk]) : chunk;
    if (this._header.length < 4) {
      cb();
      return;
    }
    const isZip = ZIP_MAGIC.every((byte, i) => this._header[i] === byte);
    this._checked = true;
    if (!isZip) {
      cb(new Error('INVALID_APK_FORMAT'));
      return;
    }
    cb(null, this._header);
    this._header = null;
  }
  _flush(cb) {
    if (!this._checked) {
      cb(new Error('INVALID_APK_FORMAT'));
      return;
    }
    cb();
  }
}

class HashPassThrough extends Transform {
  constructor(opts) {
    super(opts);
    this._hash = crypto.createHash('sha256');
  }
  _transform(chunk, _enc, cb) {
    this._hash.update(chunk);
    cb(null, chunk);
  }
  get digest() {
    return this._hash.digest('hex');
  }
}

/**
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {object} params.app - the appstore_apps document
 * @param {object} params.meta - { version, changelog, filename, uploadedBy }
 * @param {NodeJS.ReadableStream} params.sourceStream - the raw upload body
 */
async function finalizeApkUpload({ db, app, meta, sourceStream }) {
  const provider = await getActiveProvider(db);
  const { sink, finalize, cleanup } = provider.startUpload(db, {
    filename: meta.filename,
    contentType: 'application/vnd.android.package-archive',
    appId: app._id.toString(),
    version: meta.version,
    uploadedBy: meta.uploadedBy,
  });

  const sizeLimiter = new SizeLimitStream(MAX_APK_SIZE_BYTES);
  const magicCheck = new ZipMagicCheckStream();
  const hasher = new HashPassThrough();

  let storageResult;
  try {
    await pipeline(sourceStream, sizeLimiter, magicCheck, hasher, sink);
    storageResult = await finalize();
  } catch (streamErr) {
    await cleanup(storageResult).catch(() => {});
    throw streamErr;
  }

  const cleanAppName = app.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const packageName = `com.upcheck.internal.${cleanAppName}`;

  const newVersion = {
    _id: new ObjectId(),
    version: meta.version,
    ...storageResult,
    filename: meta.filename,
    sizeBytes: sizeLimiter.total,
    uploadedAt: new Date(),
    changelog: (meta.changelog || 'No release notes.').trim(),
    securityReport: {
      packageName,
      scanType: 'structural',
      signatureStatus: 'Not verified — no code-signing check performed',
      sha256: hasher.digest,
      structurallyValidZip: true,
      isSafe: null,
      scanNotes: 'Automated check confirms this is a well-formed ZIP/APK archive only. No malware, virus, or permission-abuse scan was performed — verify the source before installing.',
      scannedAt: new Date(),
    },
  };

  const versions = app.versions || [];
  let updatedVersions = [...versions, newVersion];

  if (updatedVersions.length > 3) {
    updatedVersions.sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());
    const oldest = updatedVersions[0];
    await getProviderForVersion(oldest).deleteFile(db, oldest).catch(() => {});
    updatedVersions.shift();
  }

  updatedVersions.sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());
  const latestVerStr = updatedVersions[updatedVersions.length - 1]?.version || meta.version;

  await db.collection('appstore_apps').updateOne(
    { _id: app._id },
    { $set: { versions: updatedVersions, latestVersion: latestVerStr, updatedAt: new Date() } }
  );

  const subscribers = app.subscribers || [];
  if (subscribers.length > 0) {
    const subscriberObjectIds = subscribers.map((s) => {
      try { return new ObjectId(s); } catch { return s; }
    });
    const subscriberUsers = await db.collection('admin_users')
      .find({ _id: { $in: subscriberObjectIds } })
      .toArray();

    for (const subUser of subscriberUsers) {
      if (subUser.expoPushToken || (Array.isArray(subUser.expoPushTokens) && subUser.expoPushTokens.length)) {
        sendPushNotification(
          subUser._id.toString(),
          '📲 App Store Update',
          `${app.name} has been updated to version ${meta.version}! Open App Store to download.`,
          { type: 'appstore_update', appId: app._id.toString() }
        ).catch(() => {});
      }
    }
  }

  return { version: newVersion, latestVersion: latestVerStr };
}

module.exports = { finalizeApkUpload, MAX_APK_SIZE_BYTES, VERSION_RE };

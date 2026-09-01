'use strict';

// Binaries whose database record is gone but whose bytes are not.
//
// Every provider's deleteFile() used to swallow its own errors and resolve as
// if it had worked, and every caller then dropped the version from
// appstore_apps.versions regardless. A delete that failed — an expired
// UploadThing token, a blob URL that never got written, provider downtime —
// therefore removed the only reference to the file that existed. The bytes
// stayed, nothing pointed at them, and no amount of looking in the app store
// would ever surface them again. That is the "deleted but still occupying
// storage" report.
//
// deleteFile now throws honestly. A caller that cannot keep the record (the
// user asked to delete the app; refusing would be worse) writes the reference
// here instead, so the file is still addressable and can be retried.

const COLLECTION = 'appstore_orphans';

/** The provider-specific fields that identify a stored binary. */
function storageRef(version) {
  return {
    storageProvider: version.storageProvider || null,
    fileId: version.fileId || null,       // gridfs
    blobUrl: version.blobUrl || null,     // vercel blob
    blobPathname: version.blobPathname || null,
    utKey: version.utKey || null,         // uploadthing
  };
}

/**
 * Delete a version's bytes. Never throws.
 *
 * Returns true when the file is gone (including when it was already gone).
 * On failure the reference is recorded for a later sweep and false is
 * returned, so the caller can carry on removing the record without the file
 * becoming unreachable.
 */
async function deleteVersionFile(db, version, provider, context = {}) {
  try {
    await provider.deleteFile(db, version);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[appstore] delete failed for ${version.storageProvider || 'gridfs'} ` +
        `version ${version.version || '?'}; recorded as orphan:`,
      err && err.message ? err.message : err,
    );
    try {
      await db.collection(COLLECTION).updateOne(
        { ref: storageRef(version) },
        {
          $set: {
            ref: storageRef(version),
            ...context,
            lastError: String((err && err.message) || err).slice(0, 500),
            lastTriedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
          $inc: { attempts: 1 },
        },
        { upsert: true },
      );
    } catch (writeErr) {
      // Nothing left to do but say so — losing the ledger entry is the one
      // case where the file really does become unreachable.
      // eslint-disable-next-line no-console
      console.error('[appstore] could not record orphan:', writeErr && writeErr.message);
    }
    return false;
  }
}

/**
 * Retry previously-failed deletions, oldest first.
 *
 * Called opportunistically rather than on a timer: an upload is exactly when
 * storage pressure matters, and it means no scheduler has to exist. Bounded so
 * it can never turn one upload into hundreds of provider calls.
 */
async function sweepOrphans(db, getProviderForVersion, limit = 10) {
  let swept = 0;
  try {
    const pending = await db
      .collection(COLLECTION)
      .find({})
      .sort({ lastTriedAt: 1 })
      .limit(limit)
      .toArray();

    for (const row of pending) {
      const provider = getProviderForVersion(row.ref || {});
      try {
        await provider.deleteFile(db, row.ref || {});
        await db.collection(COLLECTION).deleteOne({ _id: row._id });
        swept += 1;
      } catch (err) {
        await db.collection(COLLECTION).updateOne(
          { _id: row._id },
          {
            $set: { lastTriedAt: new Date(), lastError: String((err && err.message) || err).slice(0, 500) },
            $inc: { attempts: 1 },
          },
        );
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[appstore] orphan sweep failed:', err && err.message);
  }
  return swept;
}

module.exports = { COLLECTION, storageRef, deleteVersionFile, sweepOrphans };

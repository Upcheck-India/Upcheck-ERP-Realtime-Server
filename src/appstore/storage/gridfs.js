'use strict';

// Original App Store binary storage backend, ported verbatim (ESM ->
// CommonJS) from upcheck_admin/src/lib/storage/gridfs.js.
const { GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');

const PROVIDER_ID = 'gridfs';
const PROVIDER_LABEL = 'MongoDB GridFS (built-in, no extra setup)';

function getBucket(db) {
  // Default GridFS chunk size is 255KB, which turns a 100MB+ APK into 400+
  // separate chunk-document inserts. 1MB chunks cut that overhead.
  return new GridFSBucket(db, { bucketName: 'appstore_apks', chunkSizeBytes: 1024 * 1024 });
}

function startUpload(db, { filename, contentType, appId, version, uploadedBy }) {
  const bucket = getBucket(db);
  const sink = bucket.openUploadStream(filename, {
    contentType,
    metadata: { appId, version, uploadedBy, uploadedAt: new Date() },
  });
  return {
    sink,
    finalize: async () => ({ storageProvider: PROVIDER_ID, fileId: sink.id.toString() }),
    cleanup: async () => {
      if (sink.id) await bucket.delete(sink.id).catch(() => {});
    },
  };
}

async function getDownloadStream(db, version, range) {
  if (!version.fileId || !ObjectId.isValid(version.fileId)) return null;
  const bucket = getBucket(db);
  const files = await bucket.find({ _id: new ObjectId(version.fileId) }).toArray();
  if (files.length === 0) return null;
  const totalSize = files[0].length;

  if (range) {
    const end = Math.min(range.end, totalSize - 1);
    const nodeStream = bucket.openDownloadStream(new ObjectId(version.fileId), { start: range.start, end: end + 1 });
    return {
      webStream: Readable.toWeb(nodeStream),
      size: end - range.start + 1,
      contentType: files[0].contentType,
      range: { start: range.start, end, total: totalSize },
    };
  }

  const nodeStream = bucket.openDownloadStream(new ObjectId(version.fileId));
  return { webStream: Readable.toWeb(nodeStream), size: totalSize, contentType: files[0].contentType, range: null };
}

async function deleteFile(db, version) {
  if (!version.fileId || !ObjectId.isValid(version.fileId)) return;
  const bucket = getBucket(db);
  await bucket.delete(new ObjectId(version.fileId)).catch(() => {});
}

async function getUsage(db) {
  const stats = await db.collection('appstore_apks.files')
    .aggregate([{ $group: { _id: null, totalBytes: { $sum: '$length' }, fileCount: { $sum: 1 } } }])
    .toArray();
  const s = stats[0] || { totalBytes: 0, fileCount: 0 };
  return { provider: PROVIDER_ID, label: PROVIDER_LABEL, totalBytes: s.totalBytes, fileCount: s.fileCount, limitBytes: null, configured: true };
}

module.exports = { PROVIDER_ID, PROVIDER_LABEL, startUpload, getDownloadStream, deleteFile, getUsage };

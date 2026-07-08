'use strict';

// Default App Store binary storage backend, ported verbatim (ESM -> CommonJS)
// from upcheck_admin/src/lib/storage/vercelBlob.js. The @vercel/blob SDK is
// just an HTTP client to Vercel's Blob API — it works fine from any Node
// process, not just Vercel Functions, so this needed no logic changes, only
// a module-syntax conversion.
const { put, get, del, list } = require('@vercel/blob');
const { PassThrough } = require('stream');

const PROVIDER_ID = 'vercel-blob';
const PROVIDER_LABEL = 'Vercel Blob (free tier: 1GB storage / 10GB bandwidth per month)';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

function isConfigured() {
  return !!TOKEN;
}

function pathFor(appId, version, filename) {
  const safeFilename = (filename || 'app.apk').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `appstore/${appId}/${version}-${Date.now()}-${safeFilename}`;
}

function startUpload(_db, { filename, contentType, appId, version }) {
  const pathname = pathFor(appId, version, filename);
  const sink = new PassThrough();
  const putPromise = put(pathname, sink, {
    access: 'private',
    contentType,
    token: TOKEN,
    addRandomSuffix: false,
  });
  return {
    sink,
    finalize: async () => {
      const result = await putPromise;
      return { storageProvider: PROVIDER_ID, blobUrl: result.url, blobPathname: result.pathname };
    },
    cleanup: async (partialResult) => {
      const url = partialResult && partialResult.blobUrl;
      if (url) await del(url, { token: TOKEN }).catch(() => {});
    },
  };
}

/** `range`, if given, is `{ start, end }` byte offsets (both inclusive).
 * Forwarded as a plain Range header to the underlying fetch — the SDK
 * doesn't have first-class range support, so this is best-effort: if the
 * backend honors it we report a real partial range, otherwise we detect the
 * fallback (returned size equals the full file) and just serve the whole
 * thing as a normal 200 response. */
async function getDownloadStream(_db, version, range) {
  if (!version.blobUrl && !version.blobPathname) return null;
  const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
  const result = await get(version.blobUrl || version.blobPathname, { access: 'private', token: TOKEN, headers });
  if (!result || result.statusCode !== 200) return null;

  const total = result.blob.size;
  const contentRange = result.headers && result.headers.get && result.headers.get('content-range');
  if (range && contentRange) {
    return { webStream: result.stream, size: range.end - range.start + 1, contentType: result.blob.contentType, range: { start: range.start, end: range.end, total } };
  }
  return { webStream: result.stream, size: total, contentType: result.blob.contentType, range: null };
}

async function deleteFile(_db, version) {
  const target = version.blobUrl || version.blobPathname;
  if (target) await del(target, { token: TOKEN }).catch(() => {});
}

async function getUsage() {
  if (!isConfigured()) {
    return { provider: PROVIDER_ID, label: PROVIDER_LABEL, totalBytes: 0, fileCount: 0, limitBytes: null, configured: false };
  }
  let totalBytes = 0;
  let fileCount = 0;
  let cursor;
  do {
    const page = await list({ token: TOKEN, prefix: 'appstore/', cursor, limit: 1000 });
    totalBytes += page.blobs.reduce((sum, b) => sum + b.size, 0);
    fileCount += page.blobs.length;
    cursor = page.cursor;
  } while (cursor);
  return { provider: PROVIDER_ID, label: PROVIDER_LABEL, totalBytes, fileCount, limitBytes: 1024 * 1024 * 1024, configured: true };
}

module.exports = { PROVIDER_ID, PROVIDER_LABEL, isConfigured, startUpload, getDownloadStream, deleteFile, getUsage };

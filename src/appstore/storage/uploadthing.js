'use strict';

// Third selectable App Store binary storage backend, ported verbatim (ESM ->
// CommonJS) from upcheck_admin/src/lib/storage/uploadthing.js. UploadThing's
// server SDK takes a whole File/Blob rather than a stream, so unlike the
// other two providers this one buffers the request body in memory before
// uploading — bounded by MAX_APK_SIZE_BYTES (250MB), so worst case is one
// buffer that size, not unbounded.
const { Writable } = require('stream');
const { UTApi, UTFile } = require('uploadthing/server');

const PROVIDER_ID = 'uploadthing';
const PROVIDER_LABEL = 'UploadThing (free tier: 2GB storage)';

let cachedApi = null;
function getApi() {
  if (!cachedApi) cachedApi = new UTApi();
  return cachedApi;
}

function isConfigured() {
  return !!process.env.UPLOADTHING_TOKEN;
}

function startUpload(_db, { filename, contentType, appId, version }) {
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return {
    sink,
    finalize: async () => {
      const buffer = Buffer.concat(chunks);
      const file = new UTFile([buffer], filename, {
        type: contentType,
        customId: `${appId}-${version}-${Date.now()}`,
      });
      const result = await getApi().uploadFiles(file);
      if (result.error) {
        throw new Error(result.error.message || 'UploadThing upload failed');
      }
      return { storageProvider: PROVIDER_ID, utKey: result.data.key, blobUrl: result.data.ufsUrl || result.data.url };
    },
    cleanup: async (partialResult) => {
      if (partialResult && partialResult.utKey) await getApi().deleteFiles(partialResult.utKey).catch(() => {});
    },
  };
}

async function getDownloadStream(_db, version, range) {
  if (!version.blobUrl) return null;
  const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
  const res = await fetch(version.blobUrl, { headers });
  if (!res.ok || !res.body) return null;

  const contentType = res.headers.get('content-type') || 'application/vnd.android.package-archive';
  if (res.status === 206) {
    const contentRange = res.headers.get('content-range');
    const total = contentRange ? Number(contentRange.split('/')[1]) : null;
    return {
      webStream: res.body,
      size: Number(res.headers.get('content-length')) || (range.end - range.start + 1),
      contentType,
      range: { start: range.start, end: range.end, total },
    };
  }
  return { webStream: res.body, size: Number(res.headers.get('content-length')) || null, contentType, range: null };
}

async function deleteFile(_db, version) {
  if (version.utKey) await getApi().deleteFiles(version.utKey).catch(() => {});
}

async function getUsage() {
  if (!isConfigured()) {
    return { provider: PROVIDER_ID, label: PROVIDER_LABEL, totalBytes: 0, fileCount: 0, limitBytes: null, configured: false };
  }
  const info = await getApi().getUsageInfo();
  return { provider: PROVIDER_ID, label: PROVIDER_LABEL, totalBytes: info.appTotalBytes, fileCount: info.filesUploaded, limitBytes: info.limitBytes, configured: true };
}

module.exports = { PROVIDER_ID, PROVIDER_LABEL, isConfigured, startUpload, getDownloadStream, deleteFile, getUsage };

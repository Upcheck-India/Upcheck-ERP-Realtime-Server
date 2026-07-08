'use strict';

// App Store binary storage — pluggable backend, ported verbatim (ESM ->
// CommonJS) from upcheck_admin/src/lib/storage/index.js as part of moving
// APK upload/download off Vercel serverless functions and onto this
// persistent process. See D:\Projects\upcheck_admin\upcheck_admin\APPSTORE_ROOT_CAUSE_INVESTIGATION.md
// for why: Vercel serverless has no shared memory across invocations and no
// guaranteed post-response execution, which broke the old chunked-upload
// protocol's session/temp-file assumptions. None of that applies here.
//
// Every provider module exports the same shape:
//   startUpload(db, { filename, contentType, appId, version, uploadedBy })
//     -> { sink: Writable, finalize: () => Promise<versionStorageFields>, cleanup: (partial) => Promise<void> }
//   getDownloadStream(db, version, range) -> { webStream, size, contentType, range } | null
//   deleteFile(db, version) -> Promise<void>
//   getUsage(db) -> { provider, label, totalBytes, fileCount, limitBytes, configured }
//
// `version` here is a version sub-document from appstore_apps.versions —
// each one is tagged with `storageProvider` at upload time, so deleting or
// downloading an OLD version always uses the provider it was actually
// stored with, even if the active setting has since changed.

const gridfs = require('./gridfs');
const vercelBlob = require('./vercelBlob');
const uploadthing = require('./uploadthing');

const PROVIDERS = {
  [vercelBlob.PROVIDER_ID]: vercelBlob,
  [gridfs.PROVIDER_ID]: gridfs,
  [uploadthing.PROVIDER_ID]: uploadthing,
};

const DEFAULT_PROVIDER_ID = vercelBlob.PROVIDER_ID;

function getProvider(providerId) {
  return PROVIDERS[providerId] || PROVIDERS[DEFAULT_PROVIDER_ID];
}

/** Which provider new uploads should use — the admin-selected setting if
 * valid, else the default. Falls back to GridFS if the selected provider
 * is missing its credentials, so a misconfigured setting never hard-fails
 * an upload. */
async function getActiveProvider(db) {
  const settings = await db.collection('appstore_settings').findOne({});
  const selectedId = settings && settings.storageProvider;
  const selected = selectedId && PROVIDERS[selectedId] ? PROVIDERS[selectedId] : PROVIDERS[DEFAULT_PROVIDER_ID];
  if (selected.isConfigured && !selected.isConfigured()) {
    return gridfs;
  }
  return selected;
}

/** The provider a specific already-uploaded version was stored with —
 * versions predating this feature have no storageProvider field and were
 * always GridFS. */
function getProviderForVersion(version) {
  return getProvider(version.storageProvider || gridfs.PROVIDER_ID);
}

async function getAllProvidersUsage(db) {
  return Promise.all(
    Object.values(PROVIDERS).map(async (mod) => {
      try {
        return await mod.getUsage(db);
      } catch (error) {
        return { provider: mod.PROVIDER_ID, label: mod.PROVIDER_LABEL, error: error.message, configured: false };
      }
    })
  );
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  getProvider,
  getActiveProvider,
  getProviderForVersion,
  getAllProvidersUsage,
};

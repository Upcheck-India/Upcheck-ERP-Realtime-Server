'use strict';

// App Store upload/download — moved here from upcheck_admin's Vercel-hosted
// Next.js API routes. See APPSTORE_ROOT_CAUSE_INVESTIGATION.md in the
// upcheck_admin repo for the full root-cause writeup; short version: Vercel
// serverless functions have no shared memory across invocations and no
// guaranteed execution after the response is sent, both of which the old
// chunked-upload protocol's session/temp-file/background-finalize design
// silently depended on. This service is a persistent process, so those
// assumptions are simply true here — the upload is a single streamed
// request, validated and stored synchronously, no chunking/polling needed.
//
// Everything else App Store-related (app CRUD, review/rollback/subscribe,
// settings, storage-usage stats) stays on upcheck_admin/Vercel — those are
// small metadata-only operations with no large request/response bodies, so
// they were never actually affected by the platform mismatch.
const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { getAuthUser, isAdminRole } = require('./auth');
const { finalizeApkUpload, MAX_APK_SIZE_BYTES, VERSION_RE } = require('./finalizeUpload');
const { getProviderForVersion } = require('./storage');

const router = express.Router();

function decodeHeader(value) {
  if (!value) return '';
  try {
    return Buffer.from(String(value), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// POST /appstore/apps/:id/upload
// Metadata travels as headers (base64-encoded for free-text fields, so
// arbitrary unicode/newlines in a changelog can't break header parsing); the
// raw request body IS the APK bytes, piped straight through validation into
// storage — no multipart parsing, no buffering.
//   X-Appstore-Version        (required, plain ASCII, e.g. "1.2.3")
//   X-Appstore-Filename-B64   (base64; optional, defaults to app-release.apk)
//   X-Appstore-Changelog-B64  (base64; optional)
router.post('/apps/:id/upload', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await getAuthUser(req);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { user, db } = auth;

    if (!id || !ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid app ID' });

    const app = await db.collection('appstore_apps').findOne({ _id: new ObjectId(id) });
    if (!app) return res.status(404).json({ error: 'App not found' });

    const admin = isAdminRole(user.role);
    const isDistributor = app.distributorId === user._id.toString();
    if (!admin && !isDistributor) {
      return res.status(403).json({ error: 'Forbidden: Only admins or the original publisher can upload updates' });
    }

    const versions = app.versions || [];
    const isUpdate = versions.length > 0;
    const settings = await db.collection('appstore_settings').findOne({});
    if (!admin) {
      if (!isUpdate && settings?.uploadsDisabled) {
        return res.status(403).json({ error: 'App uploads are currently disabled by an administrator' });
      }
      if (isUpdate && settings?.updatesDisabled) {
        return res.status(403).json({ error: 'App updates are currently disabled by an administrator' });
      }
    }

    const version = String(req.headers['x-appstore-version'] || '').trim();
    const changelog = decodeHeader(req.headers['x-appstore-changelog-b64']).trim();
    const filename = decodeHeader(req.headers['x-appstore-filename-b64']).trim() || 'app-release.apk';
    const contentLength = Number(req.headers['content-length']);

    if (!version) return res.status(400).json({ error: 'Version is required' });
    if (!VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'Version must look like 1.0 or 1.0.0 (numeric segments, optional -suffix)' });
    }
    if (changelog.length > 2000) return res.status(400).json({ error: 'Release notes must be 2000 characters or fewer' });
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return res.status(411).json({ error: 'A Content-Length header is required' });
    }
    if (contentLength > MAX_APK_SIZE_BYTES) {
      return res.status(413).json({ error: `File is too large. Maximum size is ${MAX_APK_SIZE_BYTES / (1024 * 1024)}MB` });
    }
    if (versions.some((v) => v.version === version)) {
      return res.status(400).json({ error: `Version ${version} already exists` });
    }

    const result = await finalizeApkUpload({
      db,
      app,
      meta: { version, changelog, filename, uploadedBy: user._id.toString() },
      sourceStream: req,
    });

    return res.json({ success: true, version: result.version, latestVersion: result.latestVersion });
  } catch (error) {
    const knownErrors = {
      FILE_TOO_LARGE: [413, `File is too large. Maximum size is ${MAX_APK_SIZE_BYTES / (1024 * 1024)}MB`],
      INVALID_APK_FORMAT: [400, 'That file is not a valid APK/ZIP archive'],
    };
    const known = knownErrors[error.message];
    if (known) return res.status(known[0]).json({ error: known[1] });
    // eslint-disable-next-line no-console
    console.error('[appstore] upload error:', error);
    return res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// GET /appstore/download/:versionId
// Same RBAC and Range/resume support as the original Vercel route — this
// part of the old implementation was never actually broken (true streaming,
// no in-memory buffering), it just lived on the wrong host for a feature
// this size-sensitive.
router.get('/download/:versionId', async (req, res) => {
  try {
    const { versionId } = req.params;
    const auth = await getAuthUser(req);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { user, db } = auth;

    if (!versionId || !ObjectId.isValid(versionId)) return res.status(400).json({ error: 'Invalid version ID' });

    const objectVersionId = new ObjectId(versionId);
    const app = await db.collection('appstore_apps').findOne({ 'versions._id': objectVersionId });
    if (!app) return res.status(404).json({ error: 'App or version file not found' });

    const version = (app.versions || []).find((v) => v._id?.toString() === versionId);
    if (!version) return res.status(404).json({ error: 'App or version file not found' });

    const userRole = (user.role || 'member').toLowerCase();
    const admin = isAdminRole(user.role);
    const isDistributor = app.distributorId === user._id.toString();

    if (!admin && !isDistributor) {
      const settings = await db.collection('appstore_settings').findOne({});
      if (settings?.downloadsDisabled) {
        return res.status(403).json({ error: 'Downloads are currently disabled by an administrator' });
      }

      const access = app.accessSettings;
      const userTeams = await db.collection('teams').find({ members: user._id.toString() }).toArray();
      const teamIds = userTeams.map((t) => t._id.toString());

      if (access) {
        const isExcluded = (access.excludedRoles || []).includes(userRole)
          || (access.excludedUsers || []).includes(user._id.toString())
          || (access.excludedTeams || []).some((tId) => teamIds.includes(tId.toString()));
        if (isExcluded) return res.status(403).json({ error: 'Forbidden: You do not have access to view this app' });

        if (!access.availableToAll) {
          const roleMatch = (access.allowedRoles || []).includes(userRole);
          const userMatch = (access.allowedUsers || []).includes(user._id.toString());
          const teamMatch = (access.allowedTeams || []).some((tId) => teamIds.includes(tId.toString()));
          if (!roleMatch && !userMatch && !teamMatch) {
            return res.status(403).json({ error: 'Forbidden: You do not have access to view this app' });
          }
        }
      }

      const downloadPerms = app.accessSettings?.downloadPermissions;
      const isDownloadExcluded = (downloadPerms?.excludedRoles || []).includes(userRole)
        || (downloadPerms?.excludedUsers || []).includes(user._id.toString())
        || (downloadPerms?.excludedTeams || []).some((tId) => teamIds.includes(tId.toString()));
      if (isDownloadExcluded) {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to download this app' });
      }

      if (downloadPerms?.restricted) {
        const roleMatch = (downloadPerms.allowedRoles || []).includes(userRole);
        const userMatch = (downloadPerms.allowedUsers || []).includes(user._id.toString());
        const teamMatch = (downloadPerms.allowedTeams || []).some((tId) => teamIds.includes(tId.toString()));
        if (!roleMatch && !userMatch && !teamMatch) {
          return res.status(403).json({ error: 'Forbidden: You do not have permission to download this app' });
        }
      }
    }

    let range = null;
    const rangeHeader = req.headers['range'];
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : (version.sizeBytes ? version.sizeBytes - 1 : undefined);
        if (end !== undefined && start <= end) range = { start, end };
      }
    }

    if (!range || range.start === 0) {
      await db.collection('appstore_apps').updateOne({ _id: app._id }, { $inc: { downloadCount: 1 } });
    }

    const provider = getProviderForVersion(version);
    const download = await provider.getDownloadStream(db, version, range);
    if (!download) return res.status(404).json({ error: 'Binary file not found in storage' });

    res.setHeader('Content-Disposition', `attachment; filename="${version.filename || 'app.apk'}"`);
    res.setHeader('Content-Type', download.contentType || 'application/vnd.android.package-archive');
    res.setHeader('Accept-Ranges', 'bytes');
    if (download.size) res.setHeader('Content-Length', String(download.size));

    if (download.range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${download.range.start}-${download.range.end}/${download.range.total ?? '*'}`);
    } else {
      res.status(200);
    }

    // download.webStream is a WHATWG ReadableStream (from the storage
    // providers, ported unchanged) — Node's Readable.fromWeb bridges it to
    // pipe() the same way the rest of this codebase streams responses.
    const { Readable } = require('stream');
    Readable.fromWeb(download.webStream).pipe(res);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[appstore] download error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message || 'Download failed' });
  }
});

module.exports = router;

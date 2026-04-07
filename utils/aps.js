// utils/aps.js  — APS authentication & OSS helpers
const axios = require('axios');
const fs = require('fs');

const APS_BASE = 'https://developer.api.autodesk.com';
const DA_BASE = `${APS_BASE}/da/us-east/v3`;
const MD_BASE = `${APS_BASE}/modelderivative/v2/designdata`;
const INTERNAL_SCOPES = 'data:read data:write data:create bucket:create bucket:read code:all';
const VIEWER_SCOPES = 'viewables:read';

// ─── Auth ────────────────────────────────────────────────────────────────────
const tokenCache = new Map();

async function requestToken(scope) {
  const cached = tokenCache.get(scope);
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached;
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope,
  });
  const res = await axios.post(`${APS_BASE}/authentication/v2/token`, params, {
    auth: {
      username: process.env.APS_CLIENT_ID,
      password: process.env.APS_CLIENT_SECRET,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const token = {
    access_token: res.data.access_token,
    expires_in: res.data.expires_in,
    expires_at: Date.now() + res.data.expires_in * 1000,
  };

  tokenCache.set(scope, token);
  return token;
}

async function getAccessToken(scopes = INTERNAL_SCOPES) {
  const token = await requestToken(scopes);
  return token.access_token;
}

async function getViewerToken() {
  return requestToken(VIEWER_SCOPES);
}

// ─── OSS Bucket ──────────────────────────────────────────────────────────────
async function ensureBucket(token, bucketKey) {
  try {
    await axios.get(`${APS_BASE}/oss/v2/buckets/${bucketKey}/details`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (err.response?.status === 404) {
      await axios.post(
        `${APS_BASE}/oss/v2/buckets`,
        { bucketKey, policyKey: 'transient' },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
    } else {
      throw err;
    }
  }
}

// ─── Upload object to OSS ─────────────────────────────────────────────────────
async function uploadObject(token, bucketKey, objectKey, filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = fs.statSync(filePath).size;

  // Get signed upload URL (Direct-to-S3)
  const initRes = await axios.get(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?minutesExpiration=30`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { urls, uploadKey } = initRes.data;

  // Upload to S3
  await axios.put(urls[0], fileBuffer, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': fileSize },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // Complete upload
  await axios.post(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    { uploadKey },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  // Return urn for the object
  const objectId = `urn:adsk.objects:os.object:${bucketKey}/${objectKey}`;
  return objectId;
}

// ─── Get signed download URL ─────────────────────────────────────────────────
async function getSignedDownloadUrl(token, bucketKey, objectKey) {
  const res = await axios.get(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3download?minutesExpiration=60`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data.url;
}

// ─── Get signed upload URL for output ───────────────────────────────────────
async function getSignedUploadUrl(token, bucketKey, objectKey) {
  const res = await axios.get(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?minutesExpiration=60`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return { uploadUrl: res.data.urls[0], uploadKey: res.data.uploadKey };
}

async function completeUpload(token, bucketKey, objectKey, uploadKey) {
  await axios.post(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    { uploadKey },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

function urnify(objectId) {
  return Buffer.from(objectId).toString('base64').replace(/=/g, '');
}

async function submitTranslation(token, urn) {
  const body = {
    input: { urn },
    output: {
      formats: [
        {
          type: 'svf',
          views: ['2d', '3d'],
        },
      ],
    },
  };

  const res = await axios.post(`${MD_BASE}/job`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  return res.data;
}

async function getManifest(token, urn) {
  try {
    const res = await axios.get(`${MD_BASE}/${encodeURIComponent(urn)}/manifest`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

// ─── Design Automation ───────────────────────────────────────────────────────
async function submitWorkItem(token, inputUrl, outputUrl) {
  const body = {
    activityId: 'AutoCAD.PlotToPDF+prod',
    arguments: {
      HostDwg: {
        url: inputUrl,
        verb: 'get',
      },
      Result: {
        url: outputUrl,
        verb: 'put',
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    },
  };

  const res = await axios.post(`${DA_BASE}/workitems`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data.id;
}

async function getWorkItemStatus(token, workItemId) {
  const res = await axios.get(`${DA_BASE}/workitems/${workItemId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

module.exports = {
  getAccessToken,
  getViewerToken,
  ensureBucket,
  uploadObject,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  completeUpload,
  urnify,
  submitTranslation,
  getManifest,
  submitWorkItem,
  getWorkItemStatus,
};

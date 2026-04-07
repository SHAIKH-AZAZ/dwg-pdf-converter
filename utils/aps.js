// utils/aps.js  — APS authentication & OSS helpers
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const APS_BASE = 'https://developer.api.autodesk.com';

// ─── Auth ────────────────────────────────────────────────────────────────────
let _tokenCache = null;

async function getAccessToken() {
  if (_tokenCache && _tokenCache.expires_at > Date.now() + 60_000) {
    return _tokenCache.access_token;
  }
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'data:read data:write data:create bucket:create bucket:read code:all',
  });
  const res = await axios.post(`${APS_BASE}/authentication/v2/token`, params, {
    auth: {
      username: process.env.APS_CLIENT_ID,
      password: process.env.APS_CLIENT_SECRET,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  _tokenCache = {
    access_token: res.data.access_token,
    expires_at: Date.now() + res.data.expires_in * 1000,
  };
  return _tokenCache.access_token;
}

// ─── OSS Bucket ──────────────────────────────────────────────────────────────
async function ensureBucket(token, bucketKey) {
  try {
    await axios.get(`${APS_BASE}/oss/v2/buckets/${bucketKey}/details`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`✅ Bucket exists: ${bucketKey}`);
  } catch (err) {
    if (err.response?.status === 404) {
      await axios.post(
        `${APS_BASE}/oss/v2/buckets`,
        { bucketKey, policyKey: 'transient' },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      console.log(`🪣 Bucket created: ${bucketKey}`);
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

// ─── Design Automation ───────────────────────────────────────────────────────
const DA_BASE = `${APS_BASE}/da/us-east/v3`;

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

  console.log('[APS] submitWorkItem activityId:', body.activityId);

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
  ensureBucket,
  uploadObject,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  completeUpload,
  submitWorkItem,
  getWorkItemStatus,
};

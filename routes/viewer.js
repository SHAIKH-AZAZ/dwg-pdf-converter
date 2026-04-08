const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  getAccessToken,
  getViewerToken,
  ensureBucket,
  uploadObject,
  urnify,
  submitTranslation,
  getManifest,
} = require('../utils/aps');

const router = express.Router();
const jobs = new Map();
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 80;

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.dwg') {
      cb(null, true);
    } else {
      cb(new Error('Only .dwg files are allowed'));
    }
  },
});

function createJobId() {
  return `viewer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function setJob(jobId, state) {
  jobs.set(jobId, state);
}

function updateJob(jobId, patch) {
  jobs.set(jobId, { ...jobs.get(jobId), ...patch });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJobContext(file) {
  const jobId = createJobId();
  return {
    jobId,
    bucketKey: process.env.OSS_BUCKET_KEY,
    objectKey: `viewer_${jobId}_${file.originalname}`,
    tempFilePath: file.path,
    fileName: file.originalname,
  };
}

function getManifestMessages(manifest) {
  return manifest?.messages?.map(message => message.message).filter(Boolean) || [];
}

async function pollManifest(token, context, urn) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await wait(POLL_INTERVAL_MS);
    const manifest = await getManifest(token, urn);

    if (!manifest) {
      continue;
    }

    updateJob(context.jobId, {
      status: manifest.status === 'success' ? 'complete' : 'translating',
      progress: manifest.status === 'success' ? 100 : Math.min(55 + attempt * 5, 95),
      message: manifest.progress || 'Translating DWG for preview...',
      urn,
      fileName: context.fileName,
    });

    if (manifest.status === 'success') {
      return;
    }

    if (manifest.status === 'failed') {
      setJob(context.jobId, {
        status: 'error',
        progress: 0,
        message: getManifestMessages(manifest).join(' | ') || 'Preview translation failed',
        urn,
        fileName: context.fileName,
      });
      return;
    }
  }

  setJob(context.jobId, {
    status: 'error',
    progress: 0,
    message: 'Preview translation timed out',
    urn,
    fileName: context.fileName,
  });
}

async function runPreview(context) {
  const token = await getAccessToken();
  await ensureBucket(token, context.bucketKey);

  setJob(context.jobId, {
    status: 'uploading',
    progress: 25,
    message: 'Uploading DWG for preview...',
    fileName: context.fileName,
  });

  const objectId = await uploadObject(token, context.bucketKey, context.objectKey, context.tempFilePath);
  const urn = urnify(objectId);

  setJob(context.jobId, {
    status: 'translating',
    progress: 45,
    message: 'Submitting translation job...',
    urn,
    fileName: context.fileName,
  });

  await submitTranslation(token, urn);
  await pollManifest(token, context, urn);
}

function handlePreviewError(jobId, err) {
  console.error(`[${jobId}] Preview failed:`, err.response?.data || err.message);
  setJob(jobId, {
    status: 'error',
    progress: 0,
    message: err.response?.data?.developerMessage || err.response?.data?.message || err.message,
  });
}

router.get('/token', async (req, res, next) => {
  try {
    const token = await getViewerToken();
    res.json({
      access_token: token.access_token,
      expires_in: token.expires_in,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/upload', upload.single('dwgFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No DWG file uploaded' });
  }

  const context = getJobContext(req.file);
  setJob(context.jobId, {
    status: 'uploading',
    progress: 10,
    message: 'Preparing preview upload...',
    fileName: context.fileName,
  });

  res.json({ jobId: context.jobId });

  (async () => {
    try {
      await runPreview(context);
    } catch (err) {
      handlePreviewError(context.jobId, err);
    } finally {
      fs.unlink(context.tempFilePath, () => {});
    }
  })();
});

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Preview job not found' });
  }

  res.json(job);
});

module.exports = router;

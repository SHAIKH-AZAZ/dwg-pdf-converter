// routes/convert.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  getAccessToken,
  ensureBucket,
  uploadObject,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  completeUpload,
  submitWorkItem,
  getWorkItemStatus,
} = require('../utils/aps');

const router = express.Router();
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 5000;

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.dwg') {
      cb(null, true);
    } else {
      cb(new Error('Only .dwg files are allowed'));
    }
  },
});

// In-memory job store (use Redis/DB in production)
const jobs = new Map();

function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJobContext(file) {
  const jobId = createJobId();
  return {
    jobId,
    originalName: file.originalname.replace(/\.dwg$/i, ''),
    inputKey: `input_${jobId}.dwg`,
    outputKey: `output_${jobId}.pdf`,
    bucketKey: process.env.OSS_BUCKET_KEY,
    tempFilePath: file.path,
  };
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

async function prepareStorage(token, context) {
  const { jobId, bucketKey, inputKey, tempFilePath } = context;

  setJob(jobId, { status: 'uploading', progress: 20, message: 'Setting up storage...' });
  await ensureBucket(token, bucketKey);

  setJob(jobId, { status: 'uploading', progress: 35, message: 'Uploading DWG to cloud storage...' });
  await uploadObject(token, bucketKey, inputKey, tempFilePath);

  return getSignedDownloadUrl(token, bucketKey, inputKey);
}

async function prepareOutput(token, context) {
  const { bucketKey, outputKey } = context;
  return getSignedUploadUrl(token, bucketKey, outputKey);
}

async function startWorkItem(token, context, inputUrl, outputUrl) {
  setJob(context.jobId, {
    status: 'processing',
    progress: 50,
    message: 'Starting AutoCAD conversion engine...',
  });

  const workItemId = await submitWorkItem(token, inputUrl, outputUrl);

  setJob(context.jobId, {
    status: 'processing',
    progress: 60,
    message: 'AutoCAD is rendering your drawing...',
    workItemId,
  });

  return workItemId;
}

async function finalizeSuccess(token, context, uploadKey, workItemId, reportUrl) {
  const { jobId, bucketKey, outputKey, originalName } = context;
  await completeUpload(token, bucketKey, outputKey, uploadKey).catch(() => {});
  const downloadUrl = await getSignedDownloadUrl(token, bucketKey, outputKey);

  setJob(jobId, {
    status: 'complete',
    progress: 100,
    message: 'Conversion complete!',
    downloadUrl,
    fileName: `${originalName}.pdf`,
    workItemId,
    reportUrl,
  });
}

function finalizeFailure(jobId, wiStatus) {
  setJob(jobId, {
    status: 'error',
    progress: 0,
    message: `Conversion failed: ${wiStatus.status}`,
    reportUrl: wiStatus.reportUrl,
  });
}

async function pollWorkItem(token, context, workItemId, uploadKey) {
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    await wait(POLL_INTERVAL_MS);
    const wiStatus = await getWorkItemStatus(token, workItemId);
    attempts++;

    const progressMap = { pending: 62, inprogress: 75 };
    const progressBase = progressMap[wiStatus.status] || 75;

    updateJob(context.jobId, {
      progress: progressBase + Math.min(attempts * 2, 15),
      message: `Processing... (${wiStatus.status})`,
      workItemId,
    });

    if (wiStatus.status === 'success') {
      await finalizeSuccess(token, context, uploadKey, workItemId, wiStatus.reportUrl);
      return;
    }

    if (wiStatus.status === 'failed' || wiStatus.status === 'cancelled') {
      finalizeFailure(context.jobId, wiStatus);
      return;
    }
  }

  setJob(context.jobId, {
    status: 'error',
    progress: 0,
    message: 'Conversion timed out after 5 minutes',
  });
}

async function runConversion(context) {
  const token = await getAccessToken();
  const inputUrl = await prepareStorage(token, context);
  const { uploadUrl: outputUrl, uploadKey } = await prepareOutput(token, context);
  const workItemId = await startWorkItem(token, context, inputUrl, outputUrl);
  await pollWorkItem(token, context, workItemId, uploadKey);
}

function handleConversionError(jobId, err) {
  console.error(`[${jobId}] Conversion failed:`, err.response?.data || err.message);
  setJob(jobId, {
    status: 'error',
    progress: 0,
    message: err.response?.data?.developerMessage || err.response?.data?.message || err.message,
  });
}

// POST /api/convert  — Upload DWG and start conversion
router.post('/convert', upload.single('dwgFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No DWG file uploaded' });
  }

  const context = getJobContext(req.file);

  // Start async job
  setJob(context.jobId, { status: 'uploading', progress: 10, message: 'Uploading DWG file...' });
  res.json({ jobId: context.jobId });

  // Run conversion pipeline asynchronously
  ;(async () => {
    try {
      await runConversion(context);
    } catch (err) {
      handleConversionError(context.jobId, err);
    } finally {
      fs.unlink(context.tempFilePath, () => {});
    }
  })();
});

// GET /api/status/:jobId  — Poll job status
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

module.exports = router;

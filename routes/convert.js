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

// POST /api/convert  — Upload DWG and start conversion
router.post('/convert', upload.single('dwgFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No DWG file uploaded' });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const originalName = req.file.originalname.replace(/\.dwg$/i, '');
  const inputKey = `input_${jobId}.dwg`;
  const outputKey = `output_${jobId}.pdf`;
  const bucketKey = process.env.OSS_BUCKET_KEY;

  // Start async job
  jobs.set(jobId, { status: 'uploading', progress: 10, message: 'Uploading DWG file...' });
  res.json({ jobId });

  // Run conversion pipeline asynchronously
  ;(async () => {
    let currentStep = 'initializing';
    try {
      currentStep = 'getAccessToken';
      console.log(`[${jobId}] Step: ${currentStep}`);
      const token = await getAccessToken();
      console.log(`[${jobId}] Step complete: ${currentStep}`);

      // 1. Ensure bucket exists
      jobs.set(jobId, { status: 'uploading', progress: 20, message: 'Setting up storage...' });
      currentStep = 'ensureBucket';
      console.log(`[${jobId}] Step: ${currentStep} (${bucketKey})`);
      await ensureBucket(token, bucketKey);
      console.log(`[${jobId}] Step complete: ${currentStep}`);

      // 2. Upload DWG to OSS
      jobs.set(jobId, { status: 'uploading', progress: 35, message: 'Uploading DWG to cloud storage...' });
      currentStep = 'uploadObject';
      console.log(`[${jobId}] Step: ${currentStep} (${inputKey})`);
      await uploadObject(token, bucketKey, inputKey, req.file.path);
      console.log(`[${jobId}] Step complete: ${currentStep}`);

      // 3. Get signed read URL for input
      currentStep = 'getSignedDownloadUrl(input)';
      console.log(`[${jobId}] Step: ${currentStep}`);
      const inputUrl = await getSignedDownloadUrl(token, bucketKey, inputKey);
      console.log(`[${jobId}] Step complete: ${currentStep}`);

      // 4. Get signed write URL for output
      currentStep = 'getSignedUploadUrl(output)';
      console.log(`[${jobId}] Step: ${currentStep} (${outputKey})`);
      const { uploadUrl: outputUrl, uploadKey } = await getSignedUploadUrl(token, bucketKey, outputKey);
      console.log(`[${jobId}] Step complete: ${currentStep}`);

      // 5. Submit Design Automation WorkItem
      jobs.set(jobId, { status: 'processing', progress: 50, message: 'Starting AutoCAD conversion engine...' });
      currentStep = 'submitWorkItem';
      console.log(`[${jobId}] Step: ${currentStep}`);
      const workItemId = await submitWorkItem(token, inputUrl, outputUrl);
      console.log(`[${jobId}] Step complete: ${currentStep} (${workItemId})`);
      jobs.set(jobId, {
        status: 'processing',
        progress: 60,
        message: 'AutoCAD is rendering your drawing...',
        workItemId,
      });

      // 6. Poll until done
      let attempts = 0;
      const maxAttempts = 60; // 5 min max
      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 5000)); // wait 5s
        const wiStatus = await getWorkItemStatus(token, workItemId);
        attempts++;

        const progressMap = { pending: 62, inprogress: 75 };
        const prog = progressMap[wiStatus.status] || 75;

        jobs.set(jobId, {
          ...jobs.get(jobId),
          progress: prog + Math.min(attempts * 2, 15),
          message: `Processing... (${wiStatus.status})`,
          workItemId,
        });

        if (wiStatus.status === 'success') {
          // Complete the output upload record
          await completeUpload(token, bucketKey, outputKey, uploadKey).catch(() => {});
          // Get download URL for the PDF
          const downloadUrl = await getSignedDownloadUrl(token, bucketKey, outputKey);
          jobs.set(jobId, {
            status: 'complete',
            progress: 100,
            message: 'Conversion complete!',
            downloadUrl,
            fileName: `${originalName}.pdf`,
            workItemId,
            reportUrl: wiStatus.reportUrl,
          });
          break;
        }

        if (wiStatus.status === 'failed' || wiStatus.status === 'cancelled') {
          jobs.set(jobId, {
            status: 'error',
            progress: 0,
            message: `Conversion failed: ${wiStatus.status}`,
            reportUrl: wiStatus.reportUrl,
          });
          break;
        }
      }

      if (attempts >= maxAttempts) {
        jobs.set(jobId, { status: 'error', progress: 0, message: 'Conversion timed out after 5 minutes' });
      }
    } catch (err) {
      console.error(`[${jobId}] Conversion failed at step: ${currentStep}`);
      console.error(`[${jobId}] Conversion error:`, err.response?.data || err.message);
      if (err.response) {
        console.error(`[${jobId}] HTTP status:`, err.response.status);
        console.error(`[${jobId}] Response headers:`, err.response.headers);
      }
      jobs.set(jobId, {
        status: 'error',
        progress: 0,
        message: err.response?.data?.developerMessage || err.response?.data?.message || err.message,
      });
    } finally {
      // Clean up temp upload
      fs.unlink(req.file.path, () => {});
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

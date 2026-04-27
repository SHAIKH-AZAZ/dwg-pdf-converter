const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const btnRemove = document.getElementById('btnRemove');
const btnPreview = document.getElementById('btnPreview');
const btnConvert = document.getElementById('btnConvert');
const progressPanel = document.getElementById('progressPanel');
const progressStatus = document.getElementById('progressStatus');
const progressPct = document.getElementById('progressPct');
const progressBar = document.getElementById('progressBar');
const progressMsg = document.getElementById('progressMsg');
const previewPanel = document.getElementById('previewPanel');
const previewStatus = document.getElementById('previewStatus');
const previewPct = document.getElementById('previewPct');
const previewBar = document.getElementById('previewBar');
const previewMsg = document.getElementById('previewMsg');
const downloadCard = document.getElementById('downloadCard');
const dlFileName = document.getElementById('dlFileName');
const btnDownload = document.getElementById('btnDownload');
const btnNew = document.getElementById('btnNew');
const errorBox = document.getElementById('errorBox');
const errorText = document.getElementById('errorText');
const errorSub = document.getElementById('errorSub');
const viewerFileName = document.getElementById('viewerFileName');
const viewerBadge = document.getElementById('viewerBadge');
const viewerEmpty = document.getElementById('viewerEmpty');
const viewerNote = document.getElementById('viewerNote');
const uploadsCard = document.getElementById('uploadsCard');
const uploadsList = document.getElementById('uploadsList');
const btnRefreshUploads = document.getElementById('btnRefreshUploads');

let selectedFile = null;
let convertPollInterval = null;
let previewPollInterval = null;
let viewerInstance = null;
let currentPreviewUrn = null;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

async function loadUploadedDrawings() {
  try {
    const response = await fetch('/api/uploaded-drawings');
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to load uploads');
    }

    if (!data.drawings || data.drawings.length === 0) {
      uploadsList.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px; font-size: 13px;">No drawings uploaded yet</div>';
      uploadsCard.style.display = 'none';
      return;
    }

    uploadsCard.style.display = 'block';
    uploadsList.innerHTML = data.drawings.map(drawing => {
      const date = new Date(drawing.uploadedAt).toLocaleString();
      const fileName = drawing.fileName.replace('input_', '').replace('.dwg', '');
      return `
        <div style="padding: 12px 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
          <div style="flex: 1; min-width: 0;">
            <div style="color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500;">${fileName}</div>
            <div style="color: var(--muted); margin-top: 4px; font-size: 11px;">${date} · ${formatBytes(drawing.size)}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    uploadsList.innerHTML = `<div style="color: var(--error); padding: 12px; font-size: 12px;">${err.message}</div>`;
  }
}

function showError(message, detail) {
  errorText.textContent = message;
  errorSub.textContent = detail || '';
  errorBox.classList.add('visible');
}

function hideError() {
  errorBox.classList.remove('visible');
}

function setSteps(prefix, activeStep) {
  for (let index = 1; index <= 4; index++) {
    const el = document.getElementById(prefix + index);
    el.className = 'step' + (index < activeStep ? ' done' : index === activeStep ? ' active' : '');
  }
}

function updateConvertProgress(data) {
  progressPct.textContent = data.progress + '%';
  progressBar.style.width = data.progress + '%';
  progressMsg.textContent = data.message;
  progressStatus.className = 'progress-status status-' + data.status;
  progressStatus.textContent = data.status.toUpperCase();

  if (data.progress < 40) setSteps('step', 1);
  else if (data.progress < 60) setSteps('step', 2);
  else if (data.progress < 95) setSteps('step', 3);
  else setSteps('step', 4);
}

function updatePreviewProgress(data) {
  previewPct.textContent = data.progress + '%';
  previewBar.style.width = data.progress + '%';
  previewMsg.textContent = data.message;
  previewStatus.className = 'progress-status status-' + data.status;
  previewStatus.textContent = data.status.toUpperCase();
  viewerBadge.textContent = data.status.toUpperCase();

  if (data.progress < 35) setSteps('previewStep', 1);
  else if (data.progress < 55) setSteps('previewStep', 2);
  else if (data.progress < 100) setSteps('previewStep', 3);
  else setSteps('previewStep', 4);
}

function resetViewer() {
  viewerBadge.textContent = 'IDLE';
  viewerFileName.textContent = selectedFile ? selectedFile.name : 'No file selected';
  viewerNote.textContent = 'Viewer is inactive until a preview job completes.';
  viewerEmpty.classList.remove('hidden');
  currentPreviewUrn = null;

  if (viewerInstance) {
    viewerInstance.finish();
    viewerInstance = null;
    document.getElementById('viewer').innerHTML = '';
  }
}

function setFile(file) {
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileInfo.classList.add('visible');
  btnPreview.disabled = false;
  btnConvert.disabled = false;
  viewerFileName.textContent = file.name;
  viewerBadge.textContent = 'READY';
  viewerNote.textContent = 'Use Preview to upload this DWG and load it through APS Viewer.';
  hideError();
}

function clearFile() {
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.remove('visible');
  btnPreview.disabled = true;
  btnConvert.disabled = true;
  btnPreview.classList.remove('loading');
  btnConvert.classList.remove('loading');
  progressPanel.classList.remove('visible');
  previewPanel.classList.remove('visible');
  downloadCard.classList.remove('visible');
  if (convertPollInterval) clearInterval(convertPollInterval);
  if (previewPollInterval) clearInterval(previewPollInterval);
  resetViewer();
}

async function fetchViewerToken() {
  const response = await fetch('/api/viewer/token');
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to get viewer token');
  }
  return data;
}

async function ensureViewer() {
  if (viewerInstance) {
    return viewerInstance;
  }

  const token = await fetchViewerToken();
  await new Promise((resolve, reject) => {
    Autodesk.Viewing.Initializer({
      env: 'AutodeskProduction',
      accessToken: token.access_token,
    }, () => {
      const viewerElement = document.getElementById('viewer');
      viewerInstance = new Autodesk.Viewing.GuiViewer3D(viewerElement);
      const startCode = viewerInstance.start();
      if (startCode > 0) {
        reject(new Error('Failed to start Autodesk Viewer'));
        return;
      }
      resolve();
    });
  });

  return viewerInstance;
}

async function loadViewerDocument(urn) {
  if (!urn || urn === currentPreviewUrn) {
    return;
  }

  const viewer = await ensureViewer();
  await new Promise((resolve, reject) => {
    Autodesk.Viewing.Document.load('urn:' + urn, doc => {
      const defaultNode = doc.getRoot().getDefaultGeometry();
      if (!defaultNode) {
        reject(new Error('Viewer geometry not found for this DWG'));
        return;
      }

      viewer.loadDocumentNode(doc, defaultNode)
        .then(() => {
          currentPreviewUrn = urn;
          viewerEmpty.classList.add('hidden');
          viewerBadge.textContent = 'LOADED';
          viewerNote.textContent = 'Preview loaded through Autodesk Viewer.';
          resolve();
        })
        .catch(reject);
    }, (code, message) => {
      reject(new Error(message || ('Viewer document load failed: ' + code)));
    });
  });
}

async function startPreview() {
  if (!selectedFile) return;

  hideError();
  downloadCard.classList.remove('visible');
  if (previewPollInterval) clearInterval(previewPollInterval);
  previewPanel.classList.add('visible');
  btnPreview.classList.add('loading');
  btnPreview.disabled = true;
  updatePreviewProgress({ status: 'uploading', progress: 5, message: 'Starting preview upload...' });
  setSteps('previewStep', 1);
  viewerBadge.textContent = 'UPLOADING';
  viewerNote.textContent = 'Uploading DWG and requesting Model Derivative translation.';

  const formData = new FormData();
  formData.append('dwgFile', selectedFile);

  try {
    const response = await fetch('/api/viewer/upload', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok || !data.jobId) {
      throw new Error(data.error || 'Preview upload failed');
    }
    pollPreview(data.jobId);
  } catch (err) {
    btnPreview.classList.remove('loading');
    btnPreview.disabled = false;
    previewPanel.classList.remove('visible');
    viewerBadge.textContent = 'ERROR';
    showError('Preview failed', err.message);
  }
}

function pollPreview(jobId) {
  previewPollInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/viewer/status/' + jobId);
      const status = await response.json();
      if (!response.ok) {
        throw new Error(status.error || 'Preview status failed');
      }

      updatePreviewProgress(status);

      if (status.status === 'complete') {
        clearInterval(previewPollInterval);
        btnPreview.classList.remove('loading');
        btnPreview.disabled = false;
        previewPanel.classList.remove('visible');
        setSteps('previewStep', 4);
        await loadViewerDocument(status.urn);
        loadUploadedDrawings();
      } else if (status.status === 'error') {
        clearInterval(previewPollInterval);
        btnPreview.classList.remove('loading');
        btnPreview.disabled = false;
        previewPanel.classList.remove('visible');
        viewerBadge.textContent = 'ERROR';
        showError('Preview failed', status.message);
      }
    } catch (err) {
      clearInterval(previewPollInterval);
      btnPreview.classList.remove('loading');
      btnPreview.disabled = false;
      previewPanel.classList.remove('visible');
      viewerBadge.textContent = 'ERROR';
      showError('Preview failed', err.message);
    }
  }, 2500);
}

async function startConversion() {
  if (!selectedFile) return;

  hideError();
  if (convertPollInterval) clearInterval(convertPollInterval);
  downloadCard.classList.remove('visible');
  progressPanel.classList.add('visible');
  btnConvert.classList.add('loading');
  btnConvert.disabled = true;
  updateConvertProgress({ status: 'uploading', progress: 5, message: 'Starting upload...' });
  setSteps('step', 1);

  const formData = new FormData();
  formData.append('dwgFile', selectedFile);

  try {
    const response = await fetch('/api/convert', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok || !data.jobId) {
      throw new Error(data.error || 'Upload failed');
    }
    pollConvert(data.jobId);
  } catch (err) {
    btnConvert.classList.remove('loading');
    btnConvert.disabled = false;
    progressPanel.classList.remove('visible');
    showError('Conversion failed', err.message);
  }
}

function pollConvert(jobId) {
  convertPollInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/status/' + jobId);
      const status = await response.json();
      if (!response.ok) {
        throw new Error(status.error || 'Conversion status failed');
      }

      updateConvertProgress(status);

      if (status.status === 'complete') {
        clearInterval(convertPollInterval);
        btnConvert.classList.remove('loading');
        btnConvert.disabled = false;
        progressPanel.classList.remove('visible');
        downloadCard.classList.add('visible');
        dlFileName.textContent = status.fileName || 'result.pdf';
        btnDownload.href = '/api/download/' + jobId;
        btnDownload.download = status.fileName || 'result.pdf';
        loadUploadedDrawings();
      } else if (status.status === 'error') {
        clearInterval(convertPollInterval);
        btnConvert.classList.remove('loading');
        btnConvert.disabled = false;
        progressPanel.classList.remove('visible');
        showError('Conversion failed', status.message);
      }
    } catch (err) {
      clearInterval(convertPollInterval);
      btnConvert.classList.remove('loading');
      btnConvert.disabled = false;
      progressPanel.classList.remove('visible');
      showError('Conversion failed', err.message);
    }
  }, 3000);
}

fileInput.addEventListener('change', event => {
  if (event.target.files[0]) {
    setFile(event.target.files[0]);
  }
});

dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.dwg')) {
    setFile(file);
  } else {
    showError('Only .dwg files are supported.', '');
  }
});

btnRemove.addEventListener('click', clearFile);
btnPreview.addEventListener('click', startPreview);
btnConvert.addEventListener('click', startConversion);
btnRefreshUploads.addEventListener('click', loadUploadedDrawings);

btnNew.addEventListener('click', () => {
  clearFile();
  hideError();
});

// Load uploads on page load
window.addEventListener('load', loadUploadedDrawings);

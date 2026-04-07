# DWG → PDF Converter (APS Design Automation)

A Node.js web app that converts AutoCAD DWG files to PDF using the
**Autodesk Platform Services (APS) Design Automation API** with the
built-in `AutoCAD.PlotToPDF+prod` shared activity.

---

## 📁 Project Structure

```
dwg-pdf-converter/
├── server.js           ← Express entry point
├── .env                ← Your APS credentials (DO NOT commit)
├── package.json
├── routes/
│   └── convert.js      ← /api/convert  and  /api/status/:jobId
├── utils/
│   └── aps.js          ← Auth, OSS upload, WorkItem helpers
├── public/
│   └── index.html      ← UI (drag-drop upload + live progress)
└── uploads/            ← Temp folder (auto-cleaned)
```

---

## ⚙️ Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure your `.env`
```
APS_CLIENT_ID=<CLIENT ID FROM APS >
APS_CLIENT_SECRET=<your_client_secret>
OSS_BUCKET_KEY=dwgpdf-bucket-<any-unique-suffix>
PORT=3000
```

> ⚠️ `OSS_BUCKET_KEY` must be globally unique across all APS users.
> Use something like `dwgpdf-yourname-2024`.

### 3. Verify your APS app has these APIs enabled
- **Data Management API** (for OSS buckets/objects)
- **Design Automation API**

Go to → [APS Developer Portal](https://aps.autodesk.com) → Your App → APIs

### 4. Run
```bash
npm start
# Opens at http://localhost:3000
```

---

## 🔄 How it works

```
Browser                 Server                    APS Cloud
  │                         │                               │
  │──POST /api/convert────▶ │                               │
  │  (DWG file upload)      │──GET token (OAuth 2-leg)─────▶│
  │                         │──Ensure OSS bucket───────────▶│
  │◀──{ jobId }──────────── │──Upload DWG to OSS───────────▶│
  │                         │──Get signed read URL─────────▶│
  │                         │──Get signed write URL──────▶  │
  │                         │──POST /v3/workitems────────▶  │
  │                         │  activityId:                  │
  │                         │  AutoCAD.PlotToPDF+prod       │
  │──GET /api/status/id───▶ │  (polling every 5s)           │
  │◀──{ status, progress }─ │◀──WorkItem complete────────   │
  │                         │──Get signed download URL───▶  │
  │◀──{ downloadUrl }────── │                               │
  │                         │                               │
  ▼ User downloads PDF
```

---

## 📡 API Endpoints

### `POST /api/convert`
- **Body**: `multipart/form-data` with field `dwgFile`
- **Response**: `{ jobId: "job_xxxx" }`

### `GET /api/status/:jobId`
- **Response**:
```json
{
  "status": "uploading | processing | complete | error",
  "progress": 0-100,
  "message": "Human readable status",
  "downloadUrl": "https://...",   // only when complete
  "fileName": "drawing.pdf"       // only when complete
}
```

---

## 🔑 Notes

- The `AutoCAD.PlotToPDF+prod` **shared activity requires no AppBundle** —
  it's a built-in engine provided by Autodesk.
- The PDF will contain **all layouts/sheets** from the DWG.
- OSS bucket policy is `transient` — files expire after 24h automatically.
- For production, replace the in-memory `jobs` Map with Redis or a DB.

// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', require('./routes/convert'));
app.use('/api/viewer', require('./routes/viewer'));

// Catch-all → serve index.html
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 DWG→PDF Converter running at http://localhost:${PORT}`);
  console.log(`   Client ID : ${process.env.APS_CLIENT_ID?.slice(0, 12)}...`);
  console.log(`   Bucket    : ${process.env.OSS_BUCKET_KEY}\n`);
});

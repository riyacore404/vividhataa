const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const multer = require('multer');
const { google } = require('googleapis');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const frontendOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:8001')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const maxFileSize = Number(process.env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024;
const registrationHeaders = [
  'Timestamp', 'Registration ID', 'Event ID', 'Event Name', 'Category',
  'Full Name', 'Email', 'Contact Number', 'College / Institution',
  'Course / Branch', 'Year of Study', 'Team Name', 'Team Size',
  'Team Members', 'Motivation', 'Additional Information',
  'Registration Status', 'File URLs'
];

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || frontendOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed'));
  },
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: maxFileSize }
});

function loadEvents() {
  const sourcePath = path.join(__dirname, '..', 'events-data.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { timeout: 1000 });
  return sandbox.window.VIVIDHATA_EVENTS || [];
}

function getGoogleClients() {
  const required = ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SHEET_NAME'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) {
    const error = new Error('Google registration storage is not configured');
    error.statusCode = 503;
    throw error;
  }

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });

  return {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth })
  };
}

function registrationId() {
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `VIV-${new Date().getFullYear()}-${suffix}`;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePayload(body, event) {
  const required = [
    ['fullName', 'Full name is required'],
    ['email', 'Email is required'],
    ['contact', 'Contact number is required'],
    ['college', 'College / institution is required']
  ];
  const errors = {};
  required.forEach(([key, message]) => {
    if (!String(body[key] || '').trim()) errors[key] = message;
  });
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
    errors.email = 'Enter a valid email address';
  }
  if (body.contact && !/^[+\d][\d\s().-]{6,}$/.test(String(body.contact).trim())) {
    errors.contact = 'Enter a valid contact number';
  }
  if (body.accuracy !== 'true' || body.rules !== 'true') {
    errors.agreement = 'Both agreements are required';
  }
  if (event.status === 'COMPLETED') errors.event = 'Registration is closed';
  return errors;
}

function fileRule(event, fieldname) {
  const fields = event.registration?.fields || [];
  return fields.find(field => field.id === fieldname && field.type === 'file') || null;
}

function matchesContentSignature(file) {
  const bytes = file.buffer;
  if (file.mimetype === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return true;
}

function validateFiles(files, event) {
  const errors = [];
  const configuredFiles = (event.registration?.fields || []).filter(field => field.type === 'file');
  configuredFiles.filter(field => field.required && !files.some(file => file.fieldname === field.id))
    .forEach(field => errors.push(`${field.label} is required`));
  files.forEach(file => {
    const rule = fileRule(event, file.fieldname);
    if (!rule) {
      errors.push(`${file.fieldname} is not accepted for this event`);
      return;
    }
    const maxBytes = Number(rule.maxSizeMb || 10) * 1024 * 1024;
    const allowedTypes = rule.acceptTypes || [];
    const extension = path.extname(file.originalname).toLowerCase();
    const extensionAllowed = !rule.acceptExtensions?.length || rule.acceptExtensions.includes(extension);
    const typeAllowed = !allowedTypes.length || allowedTypes.includes(file.mimetype);
    if (file.size > maxBytes) errors.push(`${rule.label} exceeds the allowed file size`);
    if (!extensionAllowed || !typeAllowed) errors.push(`${rule.label} has an unsupported file type`);
    if (typeAllowed && extensionAllowed && !matchesContentSignature(file)) errors.push(`${rule.label} content does not match its declared file type`);
  });
  return errors;
}

async function ensureSheet(sheets) {
  const range = `${process.env.GOOGLE_SHEET_NAME}!A1:R1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range
  });
  if (!existing.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [registrationHeaders] }
    });
  }
}

async function findDuplicate(sheets, eventId, email) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${process.env.GOOGLE_SHEET_NAME}!A:R`
  });
  const rows = response.data.values || [];
  return rows.slice(1).some(row => row[2] === eventId && normalizeEmail(row[6]) === email);
}

async function uploadFiles(drive, files, event, id) {
  if (!files.length) return [];
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) {
    const error = new Error('File upload storage is not configured');
    error.statusCode = 503;
    throw error;
  }

  const eventFolder = await drive.files.create({
    requestBody: { name: event.id, mimeType: 'application/vnd.google-apps.folder', parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    fields: 'id'
  });
  const registrationFolder = await drive.files.create({
    requestBody: { name: id, mimeType: 'application/vnd.google-apps.folder', parents: [eventFolder.data.id] },
    fields: 'id'
  });

  const urls = [];
  for (const file of files) {
    const safeName = `${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const created = await drive.files.create({
      requestBody: { name: safeName, parents: [registrationFolder.data.id] },
      media: { mimeType: file.mimetype, body: require('node:stream').Readable.from(file.buffer) },
      fields: 'id,webViewLink'
    });
    urls.push(`${file.fieldname}: ${created.data.webViewLink || `https://drive.google.com/open?id=${created.data.id}`}`);
  }
  return urls;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/register', upload.any(), async (req, res) => {
  try {
    const events = loadEvents();
    const event = events.find(item => item.id === String(req.body.eventId || '').trim());
    if (!event) return res.status(400).json({ error: 'Event not found' });

    const validationErrors = validatePayload(req.body, event);
    if (event.registration?.enabled === false) validationErrors.event = 'Registration is not enabled for this event';
    const fileErrors = validateFiles(req.files || [], event);
    if (Object.keys(validationErrors).length || fileErrors.length) {
      return res.status(400).json({ error: 'Please correct the submitted fields', fields: validationErrors, files: fileErrors });
    }

    const { sheets, drive } = getGoogleClients();
    await ensureSheet(sheets);
    const email = normalizeEmail(req.body.email);
    if (await findDuplicate(sheets, event.id, email)) {
      return res.status(409).json({ error: "You're already registered for this event." });
    }

    const id = registrationId();
    const fileUrls = await uploadFiles(drive, req.files || [], event, id);
    const row = [
      new Date().toISOString(), id, event.id, event.name, event.category,
      String(req.body.fullName || '').trim(), email, String(req.body.contact || '').trim(),
      String(req.body.college || '').trim(), String(req.body.course || '').trim(),
      String(req.body.year || '').trim(), String(req.body.teamName || '').trim(),
      String(req.body.teamSize || '').trim(), String(req.body.teamMembers || '').trim(),
      String(req.body.motivation || '').trim(), String(req.body.additional || '').trim(),
      'RECEIVED', fileUrls.join('\n')
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${process.env.GOOGLE_SHEET_NAME}!A:R`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });

    return res.status(201).json({ registrationId: id, status: 'RECEIVED' });
  } catch (error) {
    console.error('Registration API error:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.statusCode === 503 ? error.message : 'Registration could not be completed right now' });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Uploaded file is too large or too many files were provided' });
  if (error.message === 'Origin is not allowed') return res.status(403).json({ error: 'Request origin is not allowed' });
  return res.status(500).json({ error: 'Registration could not be completed right now' });
});

app.listen(port, () => console.log(`VIVIDHATA registration API listening on port ${port}`));

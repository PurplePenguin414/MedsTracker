require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ALERT_LEAD_DAYS_WITH_REFILL = parseInt(process.env.ALERT_LEAD_DAYS_WITH_REFILL || '3', 10);
const ALERT_LEAD_DAYS_NO_REFILL = parseInt(process.env.ALERT_LEAD_DAYS_NO_REFILL || '5', 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const REMINDER_CRON_SCHEDULE = process.env.REMINDER_CRON_SCHEDULE || '0 8 * * *';
const REMINDER_TIMEZONE = process.env.REMINDER_TIMEZONE || 'America/Detroit';
const APP_URL = process.env.APP_URL || '';
const WIDGET_API_KEY = process.env.WIDGET_API_KEY || '';
const APPT_API_KEY = process.env.APPT_API_KEY || '';
const DISCORD_APPT_WEBHOOK_URL = process.env.DISCORD_APPT_WEBHOOK_URL || '';
const APPT_REMINDER_LEAD_DAYS = (process.env.APPT_REMINDER_LEAD_DAYS || '1,3').split(',').map(n => parseInt(n.trim(), 10));

// ---------- DB setup ----------
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const uploadDir = path.join(dataDir, 'appointment-uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const db = new Database(path.join(dataDir, 'meds.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dosage TEXT,
  refill_interval_days INTEGER NOT NULL,
  last_picked_up_date TEXT NOT NULL,
  refills_remaining INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pickup_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL,
  picked_up_date TEXT NOT NULL,
  refills_remaining_after INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (medication_id) REFERENCES medications(id)
);

-- Emergency info card: single row (id=1), blood type/allergies/conditions/
-- notes entered manually. Current medications are NOT duplicated here —
-- pulled live from the medications table itself on every view, so this
-- can never go stale relative to what's actually being taken.
CREATE TABLE IF NOT EXISTS emergency_info (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  blood_type TEXT,
  allergies TEXT,
  conditions TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT,
  sort_order INTEGER DEFAULT 0
);
`);
ensureColumn('emergency_info', 'full_name', 'TEXT');
ensureColumn('emergency_info', 'date_of_birth', 'TEXT');

// ---------- Lightweight migrations (safe to run against existing data) ----------
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('medications', 'as_needed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('medications', 'paused', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('medications', 'cost_per_fill', 'REAL');
ensureColumn('pickup_history', 'cost_paid', 'REAL');
ensureColumn('medications', 'called_in_date', 'TEXT');
ensureColumn('pickup_history', 'called_in_date', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS symptom_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL,
  log_date TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (medication_id) REFERENCES medications(id)
);

CREATE TABLE IF NOT EXISTS dose_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL,
  change_date TEXT NOT NULL,
  new_dosage TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (medication_id) REFERENCES medications(id)
);
`);

// ---------- Appointments module (Therapy/EMDR, Dietitian, Doctor, Other) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('therapy','dietitian','doctor','other')),
  provider_name TEXT,
  appointment_date TEXT NOT NULL,
  appointment_time TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','completed','cancelled')),
  notes TEXT,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_details (
  appointment_id INTEGER PRIMARY KEY,
  topics_covered TEXT,
  homework_assigned TEXT,
  target_memory TEXT,
  meal_plan_changes TEXT,
  goals_discussed TEXT,
  measurements TEXT,
  reason_for_visit TEXT,
  diagnosis_findings TEXT,
  prescriptions_referrals TEXT,
  follow_up_needed TEXT,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appointment_custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL,
  field_label TEXT NOT NULL,
  field_value TEXT,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appointment_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appointment_question_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_question_checks (
  appointment_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (appointment_id, question_id),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES appointment_question_bank(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appointment_reminder_log (
  appointment_id INTEGER NOT NULL,
  lead_days INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (appointment_id, lead_days),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_appointments_type ON appointments(type);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
`);

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ---------- Auth routes ----------
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash) return res.status(500).json({ error: 'Server not configured' });
  if (password && bcrypt.compareSync(password, hash)) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn) });
});

// ---------- Helpers ----------
function daysBetween(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const da = new Date(a + 'T00:00:00');
  const db_ = new Date(b + 'T00:00:00');
  return Math.round((db_ - da) / msPerDay);
}

function todayStr() {
  // Return today's date as experienced in REMINDER_TIMEZONE, not UTC —
  // otherwise the app can think it's tomorrow in the evening (UTC is
  // ahead of US timezones).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(new Date());
}

function computeStatus(med) {
  if (med.paused) {
    return {
      next_call_date: null,
      days_until_call: null,
      status: 'paused',
      next_action: 'Paused — not currently taking'
    };
  }

  if (med.as_needed) {
    const hasPharmacyRefill = med.refills_remaining > 0;
    return {
      next_call_date: null,
      days_until_call: null,
      status: hasPharmacyRefill ? 'as_needed' : 'as_needed_no_refills',
      next_action: hasPharmacyRefill ? 'Take as needed' : 'Call doctor for new prescription'
    };
  }

  const nextCallDate = new Date(med.last_picked_up_date + 'T00:00:00');
  nextCallDate.setDate(nextCallDate.getDate() + med.refill_interval_days);
  const nextCallDateStr = nextCallDate.toISOString().slice(0, 10);

  const today = todayStr();
  const daysUntilCall = daysBetween(today, nextCallDateStr);

  const hasPharmacyRefill = med.refills_remaining > 0;
  const alertLeadDays = hasPharmacyRefill ? ALERT_LEAD_DAYS_WITH_REFILL : ALERT_LEAD_DAYS_NO_REFILL;

  let status = 'ok';
  if (daysUntilCall < 0) status = 'overdue';
  else if (daysUntilCall <= alertLeadDays) status = 'due_soon';

  const nextAction = hasPharmacyRefill
    ? 'Call pharmacy to refill'
    : 'Call doctor for new prescription';

  return {
    next_call_date: nextCallDateStr,
    days_until_call: daysUntilCall,
    status,
    next_action: nextAction
  };
}

function serializeMed(med) {
  const totalSpentRow = db.prepare(
    'SELECT SUM(cost_paid) AS total FROM pickup_history WHERE medication_id = ?'
  ).get(med.id);
  return {
    ...med,
    ...computeStatus(med),
    total_spent: totalSpentRow.total || 0
  };
}

// ---------- Medication routes ----------
app.get('/api/medications', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM medications WHERE archived = 0 ORDER BY name COLLATE NOCASE'
  ).all();
  res.json(rows.map(serializeMed));
});

app.post('/api/medications', requireAuth, (req, res) => {
  const { name, dosage, refill_interval_days, last_picked_up_date, refills_remaining, notes, as_needed, cost_per_fill } = req.body;
  const isAsNeeded = !!as_needed;

  if (!name || !last_picked_up_date || (!isAsNeeded && !refill_interval_days)) {
    return res.status(400).json({ error: 'name, last_picked_up_date, and (unless as-needed) refill_interval_days are required' });
  }
  const stmt = db.prepare(`
    INSERT INTO medications (name, dosage, refill_interval_days, last_picked_up_date, refills_remaining, notes, as_needed, cost_per_fill)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    name.trim(),
    dosage ? dosage.trim() : null,
    isAsNeeded ? 0 : parseInt(refill_interval_days, 10),
    last_picked_up_date,
    refills_remaining != null ? parseInt(refills_remaining, 10) : 0,
    notes ? notes.trim() : null,
    isAsNeeded ? 1 : 0,
    (cost_per_fill !== undefined && cost_per_fill !== null && cost_per_fill !== '') ? parseFloat(cost_per_fill) : null
  );
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(info.lastInsertRowid);
  res.json(serializeMed(med));
});

app.put('/api/medications/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = ['name', 'dosage', 'refill_interval_days', 'last_picked_up_date', 'refills_remaining', 'notes', 'as_needed', 'paused', 'cost_per_fill'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }

  const merged = { ...existing, ...updates };
  const isAsNeeded = !!merged.as_needed;
  const costPerFill = (merged.cost_per_fill !== undefined && merged.cost_per_fill !== null && merged.cost_per_fill !== '')
    ? parseFloat(merged.cost_per_fill)
    : null;
  db.prepare(`
    UPDATE medications SET name=?, dosage=?, refill_interval_days=?, last_picked_up_date=?, refills_remaining=?, notes=?, as_needed=?, paused=?, cost_per_fill=?
    WHERE id=?
  `).run(
    merged.name,
    merged.dosage,
    isAsNeeded ? 0 : parseInt(merged.refill_interval_days, 10),
    merged.last_picked_up_date,
    parseInt(merged.refills_remaining, 10),
    merged.notes,
    isAsNeeded ? 1 : 0,
    merged.paused ? 1 : 0,
    costPerFill,
    id
  );
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  res.json(serializeMed(med));
});

app.post('/api/medications/:id/toggle-paused', requireAuth, (req, res) => {
  const { id } = req.params;
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!med) return res.status(404).json({ error: 'Not found' });

  const newPaused = med.paused ? 0 : 1;
  db.prepare('UPDATE medications SET paused = ? WHERE id = ?').run(newPaused, id);
  const updated = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  res.json(serializeMed(updated));
});

// Log that you called it in — first step of the call -> pickup cycle
app.post('/api/medications/:id/call-in', requireAuth, (req, res) => {
  const { id } = req.params;
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!med) return res.status(404).json({ error: 'Not found' });

  const callInDate = req.body.called_in_date || todayStr();
  db.prepare('UPDATE medications SET called_in_date = ? WHERE id = ?').run(callInDate, id);
  const updated = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  res.json(serializeMed(updated));
});

app.delete('/api/medications/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE medications SET archived = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Mark as picked up: sets last_picked_up_date, decrements refills_remaining, logs history,
// captures the pending call-in date (if any) and resets it for the next cycle
app.post('/api/medications/:id/pickup', requireAuth, (req, res) => {
  const { id } = req.params;
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!med) return res.status(404).json({ error: 'Not found' });

  const pickupDate = req.body.picked_up_date || todayStr();
  const newRefillsRemaining = Math.max(0, med.refills_remaining - 1);
  const costPaid = req.body.cost_paid !== undefined && req.body.cost_paid !== null && req.body.cost_paid !== ''
    ? parseFloat(req.body.cost_paid)
    : med.cost_per_fill;
  const callInDateForThisCycle = med.called_in_date || null;

  db.prepare('UPDATE medications SET last_picked_up_date = ?, refills_remaining = ?, called_in_date = NULL WHERE id = ?')
    .run(pickupDate, newRefillsRemaining, id);

  db.prepare('INSERT INTO pickup_history (medication_id, picked_up_date, refills_remaining_after, cost_paid, called_in_date) VALUES (?, ?, ?, ?, ?)')
    .run(id, pickupDate, newRefillsRemaining, costPaid, callInDateForThisCycle);

  const updated = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  res.json(serializeMed(updated));
});

app.get('/api/medications/:id/history', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM pickup_history WHERE medication_id = ? ORDER BY picked_up_date DESC'
  ).all(req.params.id);
  res.json(rows);
});

// ---------- Symptom / side-effect log ----------
app.get('/api/medications/:id/symptoms', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM symptom_logs WHERE medication_id = ? ORDER BY log_date DESC, id DESC'
  ).all(req.params.id);
  res.json(rows);
});

app.post('/api/medications/:id/symptoms', requireAuth, (req, res) => {
  const { id } = req.params;
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!med) return res.status(404).json({ error: 'Not found' });

  const { log_date, severity, description } = req.body;
  if (!log_date || !severity) {
    return res.status(400).json({ error: 'log_date and severity are required' });
  }
  const info = db.prepare(
    'INSERT INTO symptom_logs (medication_id, log_date, severity, description) VALUES (?, ?, ?, ?)'
  ).run(id, log_date, severity, description ? description.trim() : null);
  const row = db.prepare('SELECT * FROM symptom_logs WHERE id = ?').get(info.lastInsertRowid);
  res.json(row);
});

app.delete('/api/symptoms/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM symptom_logs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Dose change / titration log ----------
app.get('/api/medications/:id/dose-changes', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM dose_changes WHERE medication_id = ? ORDER BY change_date DESC, id DESC'
  ).all(req.params.id);
  res.json(rows);
});

app.post('/api/medications/:id/dose-changes', requireAuth, (req, res) => {
  const { id } = req.params;
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!med) return res.status(404).json({ error: 'Not found' });

  const { change_date, new_dosage, notes } = req.body;
  if (!change_date || !new_dosage) {
    return res.status(400).json({ error: 'change_date and new_dosage are required' });
  }
  const info = db.prepare(
    'INSERT INTO dose_changes (medication_id, change_date, new_dosage, notes) VALUES (?, ?, ?, ?)'
  ).run(id, change_date, new_dosage.trim(), notes ? notes.trim() : null);

  // Keep the medication's current dosage in sync with the latest logged change
  db.prepare('UPDATE medications SET dosage = ? WHERE id = ?').run(new_dosage.trim(), id);

  const row = db.prepare('SELECT * FROM dose_changes WHERE id = ?').get(info.lastInsertRowid);
  const updatedMed = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  res.json({ doseChange: row, medication: serializeMed(updatedMed) });
});

app.delete('/api/dose-changes/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM dose_changes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ================================================================
// ---------- Appointments module ----------
// ================================================================

const APPT_DETAIL_FIELDS = {
  therapy: ['topics_covered', 'homework_assigned', 'target_memory'],
  dietitian: ['meal_plan_changes', 'goals_discussed', 'measurements'],
  doctor: ['reason_for_visit', 'diagnosis_findings', 'prescriptions_referrals', 'follow_up_needed'],
  other: []
};

function getFullAppointment(id) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!appt) return null;

  const detailFields = APPT_DETAIL_FIELDS[appt.type] || [];
  let details = {};
  if (detailFields.length) {
    const row = db.prepare('SELECT * FROM appointment_details WHERE appointment_id = ?').get(id);
    if (row) detailFields.forEach(f => { details[f] = row[f]; });
  }

  const customFields = appt.type === 'other'
    ? db.prepare('SELECT id, field_label, field_value, sort_order FROM appointment_custom_fields WHERE appointment_id = ? ORDER BY sort_order, id').all(id)
    : [];

  const attachments = db.prepare('SELECT id, original_name, mime_type, size_bytes, uploaded_at FROM appointment_attachments WHERE appointment_id = ? ORDER BY uploaded_at').all(id);

  let questionChecks = [];
  if (appt.type === 'therapy') {
    questionChecks = db.prepare(`
      SELECT qb.id AS question_id, qb.question_text, COALESCE(aqc.checked, 0) AS checked
      FROM appointment_question_bank qb
      LEFT JOIN appointment_question_checks aqc ON aqc.question_id = qb.id AND aqc.appointment_id = ?
      WHERE qb.active = 1
      ORDER BY qb.sort_order, qb.id
    `).all(id);
  }

  return { ...appt, details, customFields, attachments, questionChecks };
}

app.get('/api/appointments', requireAuth, (req, res) => {
  const { type, status } = req.query;
  let query = 'SELECT * FROM appointments WHERE 1=1';
  const params = [];
  if (type) { query += ' AND type = ?'; params.push(type); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY appointment_date DESC, appointment_time DESC';
  res.json(db.prepare(query).all(...params));
});

app.get('/api/appointments/history/:type', requireAuth, (req, res) => {
  const { type } = req.params;
  if (!APPT_DETAIL_FIELDS.hasOwnProperty(type)) return res.status(400).json({ error: 'Invalid type' });
  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE type = ? AND status = 'completed'
      AND appointment_date >= date('now', '-5 days') AND appointment_date <= date('now')
    ORDER BY appointment_date DESC, appointment_time DESC
  `).all(type);
  res.json(rows.map(r => getFullAppointment(r.id)));
});

app.get('/api/appointments/:id', requireAuth, (req, res) => {
  const appt = getFullAppointment(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  res.json(appt);
});

app.post('/api/appointments', requireAuth, (req, res) => {
  const { type, provider_name, appointment_date, appointment_time, location, status, notes, reminder_enabled, details, customFields } = req.body;
  if (!type || !APPT_DETAIL_FIELDS.hasOwnProperty(type)) return res.status(400).json({ error: 'Invalid or missing appointment type' });
  if (!appointment_date) return res.status(400).json({ error: 'appointment_date is required' });

  const result = db.prepare(`
    INSERT INTO appointments (type, provider_name, appointment_date, appointment_time, location, status, notes, reminder_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, provider_name || null, appointment_date, appointment_time || null, location || null, status || 'upcoming', notes || null, reminder_enabled === false ? 0 : 1);
  const apptId = result.lastInsertRowid;

  const detailFields = APPT_DETAIL_FIELDS[type];
  if (detailFields.length && details) {
    const cols = detailFields.filter(f => details[f] !== undefined);
    if (cols.length) {
      db.prepare(`INSERT INTO appointment_details (appointment_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
        .run(apptId, ...cols.map(c => details[c]));
    }
  }
  if (type === 'other' && Array.isArray(customFields)) {
    const insertField = db.prepare('INSERT INTO appointment_custom_fields (appointment_id, field_label, field_value, sort_order) VALUES (?, ?, ?, ?)');
    customFields.forEach((f, idx) => insertField.run(apptId, f.field_label, f.field_value || null, idx));
  }
  res.status(201).json(getFullAppointment(apptId));
});

app.put('/api/appointments/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { provider_name, appointment_date, appointment_time, location, status, notes, reminder_enabled, details, customFields } = req.body;
  db.prepare(`
    UPDATE appointments SET provider_name=?, appointment_date=?, appointment_time=?, location=?, status=?, notes=?, reminder_enabled=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    provider_name ?? existing.provider_name,
    appointment_date ?? existing.appointment_date,
    appointment_time ?? existing.appointment_time,
    location ?? existing.location,
    status ?? existing.status,
    notes ?? existing.notes,
    reminder_enabled === false ? 0 : (reminder_enabled === true ? 1 : existing.reminder_enabled),
    id
  );

  const detailFields = APPT_DETAIL_FIELDS[existing.type];
  if (detailFields.length && details) {
    const cols = detailFields.filter(f => details[f] !== undefined);
    if (cols.length) {
      const setClause = cols.map(c => `${c} = ?`).join(', ');
      db.prepare(`
        INSERT INTO appointment_details (appointment_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
        ON CONFLICT(appointment_id) DO UPDATE SET ${setClause}
      `).run(id, ...cols.map(c => details[c]), ...cols.map(c => details[c]));
    }
  }
  if (existing.type === 'other' && Array.isArray(customFields)) {
    db.prepare('DELETE FROM appointment_custom_fields WHERE appointment_id = ?').run(id);
    const insertField = db.prepare('INSERT INTO appointment_custom_fields (appointment_id, field_label, field_value, sort_order) VALUES (?, ?, ?, ?)');
    customFields.forEach((f, idx) => insertField.run(id, f.field_label, f.field_value || null, idx));
  }
  res.json(getFullAppointment(id));
});

app.put('/api/appointments/:id/question-checks', requireAuth, (req, res) => {
  const id = req.params.id;
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (appt.type !== 'therapy') return res.status(400).json({ error: 'Question checks only apply to therapy appointments' });

  const upsert = db.prepare(`
    INSERT INTO appointment_question_checks (appointment_id, question_id, checked) VALUES (?, ?, ?)
    ON CONFLICT(appointment_id, question_id) DO UPDATE SET checked = excluded.checked
  `);
  Object.entries(req.body).forEach(([qId, checked]) => upsert.run(id, qId, checked ? 1 : 0));
  res.json(getFullAppointment(id));
});

app.delete('/api/appointments/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- External read-only appointments API (for Daily Planner sync) ----------
// Separate API key from WIDGET_API_KEY (meds) so the two integrations stay independent.
app.get('/api/external/appointments', (req, res) => {
  if (!APPT_API_KEY) return res.status(503).json({ error: 'APPT_API_KEY not configured on this server' });
  const providedKey = req.query.key || req.headers['x-api-key'];
  if (providedKey !== APPT_API_KEY) return res.status(401).json({ error: 'Invalid or missing API key' });

  const { start, end } = req.query;
  let query = "SELECT id, type, provider_name, appointment_date, appointment_time, location, status FROM appointments WHERE status = 'upcoming'";
  const params = [];
  if (start) { query += ' AND appointment_date >= ?'; params.push(start); }
  if (end) { query += ' AND appointment_date <= ?'; params.push(end); }
  query += ' ORDER BY appointment_date, appointment_time';

  res.json(db.prepare(query).all(...params));
});

// ---------- Appointment question bank (EMDR prep checklist, Therapy only) ----------
app.get('/api/appointment-questions', requireAuth, (req, res) => {
  const includeInactive = req.query.all === 'true';
  const rows = includeInactive
    ? db.prepare('SELECT * FROM appointment_question_bank ORDER BY sort_order, id').all()
    : db.prepare('SELECT * FROM appointment_question_bank WHERE active = 1 ORDER BY sort_order, id').all();
  res.json(rows);
});

app.post('/api/appointment-questions', requireAuth, (req, res) => {
  const { question_text } = req.body;
  if (!question_text || !question_text.trim()) return res.status(400).json({ error: 'question_text is required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM appointment_question_bank').get().m;
  const result = db.prepare('INSERT INTO appointment_question_bank (question_text, sort_order) VALUES (?, ?)').run(question_text.trim(), maxOrder + 1);
  res.status(201).json(db.prepare('SELECT * FROM appointment_question_bank WHERE id = ?').get(result.lastInsertRowid));
});

app.delete('/api/appointment-questions/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM appointment_question_bank WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- Appointment attachments ----------
const ALLOWED_ATTACHMENT_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'text/plain']);
const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`)
});
const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => ALLOWED_ATTACHMENT_MIME.has(file.mimetype) ? cb(null, true) : cb(new Error('Unsupported file type. Allowed: PDF, PNG, JPEG, WEBP, HEIC, TXT'))
});

app.post('/api/appointment-attachments/:appointmentId', requireAuth, (req, res) => {
  attachmentUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const appt = db.prepare('SELECT id FROM appointments WHERE id = ?').get(req.params.appointmentId);
    if (!appt) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Appointment not found' });
    }
    const result = db.prepare(`
      INSERT INTO appointment_attachments (appointment_id, filename, original_name, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(appt.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
    res.status(201).json(db.prepare('SELECT id, original_name, mime_type, size_bytes, uploaded_at FROM appointment_attachments WHERE id = ?').get(result.lastInsertRowid));
  });
});

app.get('/api/appointment-attachments/file/:id', requireAuth, (req, res) => {
  const att = db.prepare('SELECT * FROM appointment_attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(uploadDir, att.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${att.original_name}"`);
  res.sendFile(filePath);
});

app.delete('/api/appointment-attachments/:id', requireAuth, (req, res) => {
  const att = db.prepare('SELECT * FROM appointment_attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(uploadDir, att.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM appointment_attachments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Appointment reminders (separate Discord webhook from meds) ----------
function apptAddDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function apptDaysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + 'T00:00:00');
  const to = new Date(toDateStr + 'T00:00:00');
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}
const APPT_TYPE_LABELS = { therapy: 'Therapy / EMDR', dietitian: 'Dietitian', doctor: 'Doctor', other: 'Other' };

function buildApptReminderEmbed(appt, daysUntil) {
  const label = APPT_TYPE_LABELS[appt.type] || appt.type;
  const dueText = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`;
  return {
    embeds: [{
      title: `Upcoming ${label} Appointment`,
      description: `You have a ${label.toLowerCase()} appointment ${dueText}.`,
      fields: [
        { name: 'Date', value: appt.appointment_date, inline: true },
        { name: 'Time', value: appt.appointment_time || 'Not set', inline: true },
        { name: 'Provider', value: appt.provider_name || 'Not listed', inline: true },
        { name: 'Location', value: appt.location || 'Not listed', inline: false }
      ],
      url: APP_URL || undefined,
      color: 0x3f8f5f,
      timestamp: new Date().toISOString()
    }]
  };
}

async function checkAndSendApptReminders() {
  if (!DISCORD_APPT_WEBHOOK_URL) return;
  const today = todayStr();

  for (const leadDays of APPT_REMINDER_LEAD_DAYS) {
    const targetDate = apptAddDays(today, leadDays);
    const appts = db.prepare(`
      SELECT * FROM appointments
      WHERE appointment_date <= ? AND appointment_date >= ? AND status = 'upcoming' AND reminder_enabled = 1
    `).all(targetDate, today);

    for (const appt of appts) {
      const daysUntil = apptDaysBetween(today, appt.appointment_date);
      const alreadySent = db.prepare('SELECT 1 FROM appointment_reminder_log WHERE appointment_id = ? AND lead_days = ?').get(appt.id, leadDays);
      if (!alreadySent && daysUntil <= leadDays) {
        try {
          const res = await fetch(DISCORD_APPT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildApptReminderEmbed(appt, daysUntil))
          });
          if (!res.ok) console.error(`Appointment Discord webhook returned status ${res.status}`);
        } catch (err) {
          console.error('Appointment Discord webhook error:', err.message);
        }
        db.prepare('INSERT INTO appointment_reminder_log (appointment_id, lead_days, sent_at) VALUES (?, ?, datetime(\'now\'))').run(appt.id, leadDays);
      }
    }
  }
}

if (DISCORD_APPT_WEBHOOK_URL) {
  // Run once on boot (catches anything missed while the app was off) then daily at 8am
  checkAndSendApptReminders();
  cron.schedule('0 8 * * *', checkAndSendApptReminders, { timezone: REMINDER_TIMEZONE });
  console.log(`Appointment reminders scheduled (lead days: ${APPT_REMINDER_LEAD_DAYS.join(', ')}, timezone: ${REMINDER_TIMEZONE})`);
} else {
  console.log('DISCORD_APPT_WEBHOOK_URL not set — appointment reminder schedule disabled');
}

app.post('/api/appointment-test-reminder', requireAuth, async (req, res) => {
  if (!DISCORD_APPT_WEBHOOK_URL) return res.status(400).json({ error: 'DISCORD_APPT_WEBHOOK_URL is not configured in .env' });
  await checkAndSendApptReminders();
  res.json({ ok: true, message: 'Appointment reminder check triggered.' });
});

// ================================================================
// ---------- Discord reminders (medications) ----------
// ================================================================
function getMedsNeedingAttention() {
  const rows = db.prepare(
    'SELECT * FROM medications WHERE archived = 0 ORDER BY name COLLATE NOCASE'
  ).all();
  return rows.map(serializeMed).filter(m =>
    m.status === 'due_soon' || m.status === 'overdue' || m.status === 'as_needed_no_refills'
  );
}

function buildReminderEmbed(meds) {
  const overdue = meds.filter(m => m.status === 'overdue');
  const dueSoon = meds.filter(m => m.status === 'due_soon');
  const asNeededOut = meds.filter(m => m.status === 'as_needed_no_refills');

  const lines = [];
  if (overdue.length) {
    lines.push('**Overdue**');
    overdue.forEach(m => {
      lines.push(`⚠️ **${m.name}** — ${m.next_action} · was due ${m.next_call_date} · ${m.refills_remaining} refill${m.refills_remaining === 1 ? '' : 's'} left`);
    });
  }
  if (dueSoon.length) {
    if (lines.length) lines.push('');
    lines.push('**Due soon**');
    dueSoon.forEach(m => {
      lines.push(`🟡 **${m.name}** — ${m.next_action} · due ${m.next_call_date} · ${m.refills_remaining} refill${m.refills_remaining === 1 ? '' : 's'} left`);
    });
  }
  if (asNeededOut.length) {
    if (lines.length) lines.push('');
    lines.push('**As-needed meds out of refills**');
    asNeededOut.forEach(m => {
      lines.push(`🟠 **${m.name}** — ${m.next_action} · no fixed schedule, but 0 refills left`);
    });
  }

  return {
    embeds: [{
      title: 'Med refill reminder',
      url: APP_URL || undefined,
      description: lines.join('\n'),
      color: overdue.length ? 0xb8483c : 0xb8862c,
      timestamp: new Date().toISOString(),
      footer: APP_URL ? { text: APP_URL } : undefined
    }]
  };
}

async function sendDiscordReminder(meds) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('DISCORD_WEBHOOK_URL not set, skipping reminder send');
    return { sent: false, reason: 'no_webhook_configured' };
  }
  const payload = buildReminderEmbed(meds);
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  }
  return { sent: true };
}

async function runDailyReminderCheck() {
  const meds = getMedsNeedingAttention();
  if (meds.length === 0) {
    console.log('Reminder check: nothing due soon or overdue, skipping send');
    return;
  }
  try {
    await sendDiscordReminder(meds);
    console.log(`Reminder check: sent Discord reminder for ${meds.length} medication(s)`);
  } catch (err) {
    console.error('Reminder check: failed to send Discord reminder', err);
  }
}

if (DISCORD_WEBHOOK_URL) {
  cron.schedule(REMINDER_CRON_SCHEDULE, runDailyReminderCheck, { timezone: REMINDER_TIMEZONE });
  console.log(`Discord reminders scheduled: "${REMINDER_CRON_SCHEDULE}" (${REMINDER_TIMEZONE})`);
} else {
  console.log('DISCORD_WEBHOOK_URL not set — reminder schedule disabled');
}

// Manually trigger a reminder check (also useful to verify webhook connectivity)
app.post('/api/test-reminder', requireAuth, async (req, res) => {
  if (!DISCORD_WEBHOOK_URL) {
    return res.status(400).json({ error: 'DISCORD_WEBHOOK_URL is not configured in .env' });
  }
  const meds = getMedsNeedingAttention();
  try {
    if (meds.length === 0) {
      // Send a lightweight confirmation ping so the button always gives feedback
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `✅ Med Tracker test ping — webhook is working. Nothing is due soon or overdue right now.${APP_URL ? `\n${APP_URL}` : ''}` })
      });
    } else {
      await sendDiscordReminder(meds);
    }
    res.json({ ok: true, medsFlagged: meds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- PDF export: current medication list for doctor visits ----------
app.get('/api/export/pdf', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM medications WHERE archived = 0 ORDER BY name COLLATE NOCASE'
  ).all().map(serializeMed);

  const active = rows.filter(m => m.status !== 'paused');
  const paused = rows.filter(m => m.status === 'paused');

  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="medication-list-${todayStr()}.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).fillColor('#2b2822').text('Current Medication List', { align: 'left' });
  doc.fontSize(10).fillColor('#8a8478').text(`Generated ${todayStr()}`);
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#e4e0d6').lineWidth(1).stroke();
  doc.moveDown(1);

  function renderMed(m) {
    doc.fontSize(13).fillColor('#2b2822').text(m.name + (m.dosage ? `  —  ${m.dosage}` : ''), { continued: false });
    doc.fontSize(9.5).fillColor('#8a8478');

    const scheduleLine = m.as_needed
      ? 'As needed — no fixed schedule'
      : m.paused
        ? 'Paused'
        : `Refill every ${m.refill_interval_days} days · last picked up ${m.last_picked_up_date}`;
    doc.text(scheduleLine);

    doc.text(`Refills remaining at pharmacy: ${m.refills_remaining}`);

    if (m.cost_per_fill != null) {
      doc.text(`Cost per fill: $${m.cost_per_fill.toFixed(2)}  ·  Total spent to date: $${m.total_spent.toFixed(2)}`);
    }

    if (m.notes) {
      doc.text(`Notes: ${m.notes}`);
    }

    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#f1efe9').lineWidth(0.75).stroke();
    doc.moveDown(0.6);
  }

  if (active.length === 0 && paused.length === 0) {
    doc.fontSize(11).fillColor('#8a8478').text('No medications currently tracked.');
  }

  active.forEach(renderMed);

  if (paused.length) {
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor('#8a8478').text('PAUSED (NOT CURRENTLY TAKING)', { characterSpacing: 0.5 });
    doc.moveDown(0.5);
    paused.forEach(renderMed);
  }

  doc.end();
});

// ---------- Full history export: every medication's pickups, symptoms, and dose changes ----------
app.get('/api/export/history/pdf', requireAuth, (req, res) => {
  const meds = db.prepare(
    'SELECT * FROM medications WHERE archived = 0 ORDER BY name COLLATE NOCASE'
  ).all().map(serializeMed);

  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="medication-full-history-${todayStr()}.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).fillColor('#2b2822').text('Medication Full History');
  doc.fontSize(10).fillColor('#8a8478').text(`Generated ${todayStr()}`);
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#e4e0d6').lineWidth(1).stroke();
  doc.moveDown(1);

  if (meds.length === 0) {
    doc.fontSize(11).fillColor('#8a8478').text('No medications currently tracked.');
  }

  meds.forEach((m, idx) => {
    if (idx > 0) doc.moveDown(0.8);

    doc.fontSize(15).fillColor('#2b2822').text(m.name + (m.dosage ? `  —  ${m.dosage}` : ''));
    const statusLine = m.as_needed ? 'As needed' : m.paused ? 'Paused' : `Refill every ${m.refill_interval_days} days`;
    doc.fontSize(9.5).fillColor('#8a8478').text(statusLine);
    doc.moveDown(0.5);

    const pickups = db.prepare('SELECT * FROM pickup_history WHERE medication_id = ? ORDER BY picked_up_date').all(m.id);
    const symptoms = db.prepare('SELECT * FROM symptom_logs WHERE medication_id = ? ORDER BY log_date').all(m.id);
    const doseChanges = db.prepare('SELECT * FROM dose_changes WHERE medication_id = ? ORDER BY change_date').all(m.id);

    doc.fontSize(11).fillColor('#2b2822').text('Pickup history');
    doc.fontSize(9.5).fillColor('#8a8478');
    if (pickups.length === 0) {
      doc.text('  No pickups logged.');
    } else {
      pickups.forEach(p => {
        doc.text(`  ${p.picked_up_date} — ${p.refills_remaining_after} refill${p.refills_remaining_after === 1 ? '' : 's'} left${p.cost_paid != null ? ` · $${p.cost_paid.toFixed(2)}` : ''}`);
      });
    }
    doc.moveDown(0.4);

    doc.fontSize(11).fillColor('#2b2822').text('Symptoms / side effects');
    doc.fontSize(9.5).fillColor('#8a8478');
    if (symptoms.length === 0) {
      doc.text('  None logged.');
    } else {
      symptoms.forEach(s => {
        doc.text(`  ${s.log_date} — ${s.severity}${s.description ? `: ${s.description}` : ''}`);
      });
    }
    doc.moveDown(0.4);

    doc.fontSize(11).fillColor('#2b2822').text('Titration / dose changes');
    doc.fontSize(9.5).fillColor('#8a8478');
    if (doseChanges.length === 0) {
      doc.text('  None logged.');
    } else {
      doseChanges.forEach(d => {
        doc.text(`  ${d.change_date} — ${d.new_dosage}${d.notes ? `: ${d.notes}` : ''}`);
      });
    }

    doc.moveDown(0.6);
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#e4e0d6').lineWidth(1).stroke();
  });

  doc.end();
});

// ---------- Widget endpoint (separate API key auth, for iOS home screen widget) ----------
app.get('/api/widget/summary', (req, res) => {
  if (!WIDGET_API_KEY) {
    return res.status(400).json({ error: 'WIDGET_API_KEY is not configured in .env' });
  }
  const providedKey = req.query.key || req.headers['x-widget-key'];
  if (providedKey !== WIDGET_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing widget key' });
  }

  const rows = db.prepare(
    'SELECT * FROM medications WHERE archived = 0 ORDER BY name COLLATE NOCASE'
  ).all().map(serializeMed);

  const overdue = rows.filter(m => m.status === 'overdue');
  const dueSoon = rows.filter(m => m.status === 'due_soon');
  const asNeededOut = rows.filter(m => m.status === 'as_needed_no_refills');
  const needsAttention = [...overdue, ...dueSoon, ...asNeededOut];

  res.json({
    generated_at: new Date().toISOString(),
    counts: {
      overdue: overdue.length,
      due_soon: dueSoon.length,
      as_needed_no_refills: asNeededOut.length,
      ok: rows.filter(m => m.status === 'ok').length,
      as_needed: rows.filter(m => m.status === 'as_needed').length,
      paused: rows.filter(m => m.status === 'paused').length
    },
    needs_attention: needsAttention.map(m => ({
      name: m.name,
      status: m.status,
      next_action: m.next_action,
      next_call_date: m.next_call_date,
      days_until_call: m.days_until_call,
      refills_remaining: m.refills_remaining
    })),
    app_url: APP_URL || null
  });
});

// ================================================================
// ---------- Emergency Info Card ----------
// ================================================================

const EMERGENCY_SHARE_KEY = process.env.EMERGENCY_SHARE_KEY || '';

function getActiveMedicationsForDisplay() {
  return db.prepare(`
    SELECT name, dosage FROM medications
    WHERE archived = 0 AND paused = 0
    ORDER BY name
  `).all();
}

function getEmergencyInfoPayload() {
  let info = db.prepare('SELECT * FROM emergency_info WHERE id = 1').get();
  if (!info) {
    db.prepare('INSERT INTO emergency_info (id) VALUES (1)').run();
    info = db.prepare('SELECT * FROM emergency_info WHERE id = 1').get();
  }
  const contacts = db.prepare('SELECT * FROM emergency_contacts ORDER BY sort_order, id').all();
  const medications = getActiveMedicationsForDisplay();
  return { ...info, contacts, medications };
}

// Authenticated — normal in-app view/edit
app.get('/api/emergency-info', requireAuth, (req, res) => {
  res.json(getEmergencyInfoPayload());
});

app.put('/api/emergency-info', requireAuth, (req, res) => {
  const { full_name, date_of_birth, blood_type, allergies, conditions, notes } = req.body;
  db.prepare(`
    UPDATE emergency_info SET full_name=?, date_of_birth=?, blood_type=?, allergies=?, conditions=?, notes=?, updated_at=datetime('now') WHERE id=1
  `).run(full_name || null, date_of_birth || null, blood_type || null, allergies || null, conditions || null, notes || null);
  res.json(getEmergencyInfoPayload());
});

app.post('/api/emergency-contacts', requireAuth, (req, res) => {
  const { name, relationship, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM emergency_contacts').get().m;
  const result = db.prepare('INSERT INTO emergency_contacts (name, relationship, phone, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, relationship || null, phone || null, maxOrder + 1);
  res.status(201).json(db.prepare('SELECT * FROM emergency_contacts WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/emergency-contacts/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM emergency_contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, relationship, phone } = req.body;
  db.prepare('UPDATE emergency_contacts SET name=?, relationship=?, phone=? WHERE id=?')
    .run(name ?? existing.name, relationship ?? existing.relationship, phone ?? existing.phone, req.params.id);
  res.json(db.prepare('SELECT * FROM emergency_contacts WHERE id = ?').get(req.params.id));
});

app.delete('/api/emergency-contacts/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM emergency_contacts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Authenticated — get the full shareable URL to copy/display in Settings
app.get('/api/emergency-share-url', requireAuth, (req, res) => {
  if (!EMERGENCY_SHARE_KEY) return res.json({ configured: false });
  res.json({ configured: true, url: `${APP_URL}/emergency.html?key=${EMERGENCY_SHARE_KEY}` });
});

// NOT behind requireAuth — this is the whole point: a specific person (a
// pet-sitter, etc.) can open this without an account. Protected by its own
// dedicated key instead, same pattern as Daily Planner's iCal feed.
app.get('/api/emergency-info/public', (req, res) => {
  if (!EMERGENCY_SHARE_KEY) return res.status(503).json({ error: 'Sharing is not configured' });
  if (req.query.key !== EMERGENCY_SHARE_KEY) return res.status(401).json({ error: 'Invalid or missing key' });
  res.json(getEmergencyInfoPayload());
});

app.listen(PORT, () => {
  console.log(`Med tracker running on port ${PORT}`);
});

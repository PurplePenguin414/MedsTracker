require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const ALERT_LEAD_DAYS_WITH_REFILL = parseInt(process.env.ALERT_LEAD_DAYS_WITH_REFILL || '3', 10);
const ALERT_LEAD_DAYS_NO_REFILL = parseInt(process.env.ALERT_LEAD_DAYS_NO_REFILL || '5', 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const REMINDER_CRON_SCHEDULE = process.env.REMINDER_CRON_SCHEDULE || '0 8 * * *';
const REMINDER_TIMEZONE = process.env.REMINDER_TIMEZONE || 'America/Detroit';
const APP_URL = process.env.APP_URL || '';
const WIDGET_API_KEY = process.env.WIDGET_API_KEY || '';

// ---------- DB setup ----------
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
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
`);

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

app.delete('/api/medications/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE medications SET archived = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Mark as picked up: sets last_picked_up_date, decrements refills_remaining, logs history
app.post('/api/medications/:id/pickup', requireAuth, (req, res) => {
  const { id } = req.params;
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!med) return res.status(404).json({ error: 'Not found' });

  const pickupDate = req.body.picked_up_date || todayStr();
  const newRefillsRemaining = Math.max(0, med.refills_remaining - 1);
  const costPaid = req.body.cost_paid !== undefined && req.body.cost_paid !== null && req.body.cost_paid !== ''
    ? parseFloat(req.body.cost_paid)
    : med.cost_per_fill;

  db.prepare('UPDATE medications SET last_picked_up_date = ?, refills_remaining = ? WHERE id = ?')
    .run(pickupDate, newRefillsRemaining, id);

  db.prepare('INSERT INTO pickup_history (medication_id, picked_up_date, refills_remaining_after, cost_paid) VALUES (?, ?, ?, ?)')
    .run(id, pickupDate, newRefillsRemaining, costPaid);

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

// ---------- Discord reminders ----------
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

app.listen(PORT, () => {
  console.log(`Med tracker running on port ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const ALERT_LEAD_DAYS_WITH_REFILL = parseInt(process.env.ALERT_LEAD_DAYS_WITH_REFILL || '3', 10);
const ALERT_LEAD_DAYS_NO_REFILL = parseInt(process.env.ALERT_LEAD_DAYS_NO_REFILL || '5', 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const REMINDER_CRON_SCHEDULE = process.env.REMINDER_CRON_SCHEDULE || '0 8 * * *';
const REMINDER_TIMEZONE = process.env.REMINDER_TIMEZONE || 'America/Detroit';

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
  return new Date().toISOString().slice(0, 10);
}

function computeStatus(med) {
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
  return { ...med, ...computeStatus(med) };
}

// ---------- Medication routes ----------
app.get('/api/medications', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM medications WHERE archived = 0 ORDER BY name COLLATE NOCASE'
  ).all();
  res.json(rows.map(serializeMed));
});

app.post('/api/medications', requireAuth, (req, res) => {
  const { name, dosage, refill_interval_days, last_picked_up_date, refills_remaining, notes } = req.body;
  if (!name || !refill_interval_days || !last_picked_up_date) {
    return res.status(400).json({ error: 'name, refill_interval_days, and last_picked_up_date are required' });
  }
  const stmt = db.prepare(`
    INSERT INTO medications (name, dosage, refill_interval_days, last_picked_up_date, refills_remaining, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    name.trim(),
    dosage ? dosage.trim() : null,
    parseInt(refill_interval_days, 10),
    last_picked_up_date,
    refills_remaining != null ? parseInt(refills_remaining, 10) : 0,
    notes ? notes.trim() : null
  );
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(info.lastInsertRowid);
  res.json(serializeMed(med));
});

app.put('/api/medications/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = ['name', 'dosage', 'refill_interval_days', 'last_picked_up_date', 'refills_remaining', 'notes'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }

  const merged = { ...existing, ...updates };
  db.prepare(`
    UPDATE medications SET name=?, dosage=?, refill_interval_days=?, last_picked_up_date=?, refills_remaining=?, notes=?
    WHERE id=?
  `).run(
    merged.name,
    merged.dosage,
    parseInt(merged.refill_interval_days, 10),
    merged.last_picked_up_date,
    parseInt(merged.refills_remaining, 10),
    merged.notes,
    id
  );
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  res.json(serializeMed(med));
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

  db.prepare('UPDATE medications SET last_picked_up_date = ?, refills_remaining = ? WHERE id = ?')
    .run(pickupDate, newRefillsRemaining, id);

  db.prepare('INSERT INTO pickup_history (medication_id, picked_up_date, refills_remaining_after) VALUES (?, ?, ?)')
    .run(id, pickupDate, newRefillsRemaining);

  const updated = db.prepare('SELECT * FROM medications WHERE id = ?').get(id);
  res.json(serializeMed(updated));
});

app.get('/api/medications/:id/history', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM pickup_history WHERE medication_id = ? ORDER BY picked_up_date DESC'
  ).all(req.params.id);
  res.json(rows);
});

// ---------- Discord reminders ----------
function getMedsNeedingAttention() {
  const rows = db.prepare(
    'SELECT * FROM medications WHERE archived = 0 ORDER BY name COLLATE NOCASE'
  ).all();
  return rows.map(serializeMed).filter(m => m.status === 'due_soon' || m.status === 'overdue');
}

function buildReminderEmbed(meds) {
  const overdue = meds.filter(m => m.status === 'overdue');
  const dueSoon = meds.filter(m => m.status === 'due_soon');

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

  return {
    embeds: [{
      title: 'Med refill reminder',
      description: lines.join('\n'),
      color: overdue.length ? 0xb8483c : 0xb8862c,
      timestamp: new Date().toISOString()
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
        body: JSON.stringify({ content: '✅ Med Tracker test ping — webhook is working. Nothing is due soon or overdue right now.' })
      });
    } else {
      await sendDiscordReminder(meds);
    }
    res.json({ ok: true, medsFlagged: meds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Med tracker running on port ${PORT}`);
});

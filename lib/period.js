'use strict';

// Period tracker: pure logic (validation, date math, cycle prediction) plus
// table setup. Kept free of Express so it can be unit tested on its own.
//
// All dates are plain 'YYYY-MM-DD' strings with no time zone attached. Date
// math goes through UTC day numbers so DST changes can't shift a day.

const FLOWS = ['spotting', 'light', 'medium', 'heavy'];
const SYMPTOMS = [
  'cramps', 'headache', 'fatigue', 'bloating', 'back pain', 'breast tenderness',
  'nausea', 'mood swings', 'anxiety', 'acne', 'cravings', 'trouble sleeping',
];

const DEFAULT_CYCLE_LENGTH = 28;
const DEFAULT_PERIOD_LENGTH = 5;
const RECENT_CYCLES = 6; // how many recent cycles predictions are based on
const MAX_NOTES = 1000;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Date helpers ----------

function isValidDate(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < MIN_YEAR || y > MAX_YEAR) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dayNumber(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function daysBetween(a, b) {
  return Math.round(dayNumber(b) - dayNumber(a));
}

function addDays(s, n) {
  return new Date((dayNumber(s) + n) * 86400000).toISOString().slice(0, 10);
}

// Today's date in a given IANA time zone, as YYYY-MM-DD. (Avoids the classic
// bug of using the UTC date, which is already "tomorrow" in the evening.)
function todayIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ---------- Prediction ----------

// cycles: [{ start_date, end_date|null }] in any order.
// Predictions use the MEDIAN of recent cycle lengths rather than the mean, so
// one forgotten/late entry (an unusually long "cycle") doesn't skew them.
function computeStats(cycles) {
  const sorted = [...cycles].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  if (sorted.length === 0) {
    return {
      basis: 'none', cycleCount: 0, lastStart: null,
      typicalCycleLength: null, typicalPeriodLength: null, intervals: [],
      predictedNextStart: null, predictedNextEnd: null,
      rangeEarliest: null, rangeLatest: null,
    };
  }

  const allIntervals = [];
  for (let i = 1; i < sorted.length; i++) {
    allIntervals.push(daysBetween(sorted[i - 1].start_date, sorted[i].start_date));
  }
  const intervals = allIntervals.slice(-RECENT_CYCLES);

  const lengths = sorted
    .filter((c) => c.end_date)
    .map((c) => daysBetween(c.start_date, c.end_date) + 1)
    .slice(-RECENT_CYCLES);

  const basis = intervals.length ? 'history' : 'default';
  const typicalCycleLength = intervals.length ? Math.round(median(intervals)) : DEFAULT_CYCLE_LENGTH;
  const typicalPeriodLength = lengths.length ? Math.round(median(lengths)) : DEFAULT_PERIOD_LENGTH;

  const lastStart = sorted[sorted.length - 1].start_date;
  const predictedNextStart = addDays(lastStart, typicalCycleLength);
  const predictedNextEnd = addDays(predictedNextStart, typicalPeriodLength - 1);

  // A "usually between X and Y" range only once there's enough history to mean something.
  let rangeEarliest = null;
  let rangeLatest = null;
  if (intervals.length >= 3) {
    rangeEarliest = addDays(lastStart, Math.min(...intervals));
    rangeLatest = addDays(lastStart, Math.max(...intervals));
  }

  return {
    basis, cycleCount: sorted.length, lastStart,
    typicalCycleLength, typicalPeriodLength, intervals,
    predictedNextStart, predictedNextEnd, rangeEarliest, rangeLatest,
  };
}

// Attach each cycle's length (days until the next period started). The most
// recent cycle has none yet. Returns newest-first, ready to display.
function withCycleLengths(cycles) {
  const asc = [...cycles].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const out = asc.map((c, i) => ({
    ...c,
    period_length: c.end_date ? daysBetween(c.start_date, c.end_date) + 1 : null,
    cycle_length: i < asc.length - 1 ? daysBetween(c.start_date, asc[i + 1].start_date) : null,
  }));
  return out.reverse();
}

// ---------- Validation ----------

// A cycle with no end_date is "ongoing" and treated as open-ended for overlap.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const aE = aEnd || '9999-12-31';
  const bE = bEnd || '9999-12-31';
  return aStart <= bE && bStart <= aE;
}

function findOverlap(existing, start, end, ignoreId = null) {
  return existing.find((c) => c.id !== ignoreId && rangesOverlap(start, end, c.start_date, c.end_date)) || null;
}

// maxDate = latest date allowed (the server's "today", with a day of slack).
function validateCycleInput(body, maxDate) {
  const b = body || {};
  const start = b.start_date;
  const end = b.end_date ? b.end_date : null;
  const notes = b.notes == null ? '' : b.notes;

  if (!isValidDate(start)) return { error: 'First day must be a valid date.' };
  if (start > maxDate) return { error: "First day can't be in the future." };
  if (end !== null) {
    if (!isValidDate(end)) return { error: 'Last day must be a valid date.' };
    if (end < start) return { error: "Last day can't be before the first day." };
    if (end > maxDate) return { error: "Last day can't be in the future." };
  }
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) {
    return { error: `Notes must be text under ${MAX_NOTES} characters.` };
  }
  return { value: { start_date: start, end_date: end, notes: notes.trim() || null } };
}

function validateDayInput(date, body, maxDate) {
  const b = body || {};
  if (!isValidDate(date)) return { error: 'Date must be a valid date.' };
  if (date > maxDate) return { error: "Can't log a day in the future." };

  const flow = b.flow ? b.flow : null;
  if (flow !== null && !FLOWS.includes(flow)) return { error: 'Unknown flow value.' };

  const rawSymptoms = b.symptoms == null ? [] : b.symptoms;
  if (!Array.isArray(rawSymptoms)) return { error: 'Symptoms must be a list.' };
  if (rawSymptoms.some((s) => !SYMPTOMS.includes(s))) return { error: 'Unknown symptom value.' };
  const symptoms = [...new Set(rawSymptoms)];

  const notes = b.notes == null ? '' : b.notes;
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) {
    return { error: `Notes must be text under ${MAX_NOTES} characters.` };
  }
  return { value: { log_date: date, flow, symptoms, notes: notes.trim() || null } };
}

// ---------- Tables ----------

function initPeriodTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS period_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_period_cycles_start ON period_cycles(start_date);

CREATE TABLE IF NOT EXISTS period_day_logs (
  log_date TEXT PRIMARY KEY,
  flow TEXT,
  symptoms TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
}

module.exports = {
  FLOWS, SYMPTOMS, DEFAULT_CYCLE_LENGTH, DEFAULT_PERIOD_LENGTH, RECENT_CYCLES, MAX_NOTES,
  isValidDate, daysBetween, addDays, todayIn, median,
  computeStats, withCycleLengths, rangesOverlap, findOverlap,
  validateCycleInput, validateDayInput, initPeriodTables,
};

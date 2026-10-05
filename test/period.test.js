'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/period');

test('isValidDate accepts real dates and rejects impossible ones', () => {
  assert.equal(P.isValidDate('2026-10-04'), true);
  assert.equal(P.isValidDate('2028-02-29'), true);   // leap year
  assert.equal(P.isValidDate('2027-02-29'), false);  // not a leap year
  assert.equal(P.isValidDate('2026-02-30'), false);
  assert.equal(P.isValidDate('2026-13-01'), false);
  assert.equal(P.isValidDate('2026-1-5'), false);
  assert.equal(P.isValidDate('10/04/2026'), false);
  assert.equal(P.isValidDate('0202-10-04'), false);  // typo'd year
  assert.equal(P.isValidDate('2101-01-01'), false);
  assert.equal(P.isValidDate(null), false);
  assert.equal(P.isValidDate(20261004), false);
});

test('addDays / daysBetween handle month, year, leap-day and DST boundaries', () => {
  assert.equal(P.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(P.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(P.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(P.addDays('2026-03-01', -1), '2026-02-28');
  // US DST start (2026-03-08) and end (2026-11-01) must not lose or gain a day.
  assert.equal(P.addDays('2026-03-07', 2), '2026-03-09');
  assert.equal(P.addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(P.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(P.daysBetween('2026-10-31', '2026-11-02'), 2);
  assert.equal(P.daysBetween('2026-10-04', '2026-10-04'), 0);
  assert.equal(P.daysBetween('2026-10-10', '2026-10-04'), -6);
});

test("todayIn uses the app's time zone, not UTC", () => {
  // 10:30pm on Oct 4 in Detroit (EDT, UTC-4) is already Oct 5 in UTC.
  const now = new Date('2026-10-05T02:30:00Z');
  assert.equal(P.todayIn('America/Detroit', now), '2026-10-04');
  assert.equal(P.todayIn('UTC', now), '2026-10-05');
  // Winter (EST, UTC-5)
  assert.equal(P.todayIn('America/Detroit', new Date('2026-01-01T03:00:00Z')), '2025-12-31');
});

test('median handles odd and even counts', () => {
  assert.equal(P.median([28]), 28);
  assert.equal(P.median([30, 26, 28]), 28);
  assert.equal(P.median([26, 30]), 28);
  assert.equal(P.median([27, 28, 29, 30]), 28.5);
});

test('computeStats: no cycles means no prediction', () => {
  const s = P.computeStats([]);
  assert.equal(s.basis, 'none');
  assert.equal(s.predictedNextStart, null);
  assert.equal(s.cycleCount, 0);
});

test('computeStats: a single cycle falls back to the 28/5 defaults', () => {
  const s = P.computeStats([{ start_date: '2026-09-10', end_date: null }]);
  assert.equal(s.basis, 'default');
  assert.equal(s.typicalCycleLength, 28);
  assert.equal(s.typicalPeriodLength, 5);
  assert.equal(s.predictedNextStart, '2026-10-08');
  assert.equal(s.predictedNextEnd, '2026-10-12');
  assert.equal(s.rangeEarliest, null);
});

test('computeStats: predicts from history, input order does not matter', () => {
  const cycles = [
    { start_date: '2026-09-02', end_date: '2026-09-06' },
    { start_date: '2026-07-08', end_date: '2026-07-12' },
    { start_date: '2026-08-05', end_date: '2026-08-09' },
  ];
  const s = P.computeStats(cycles);
  assert.equal(s.basis, 'history');
  assert.deepEqual(s.intervals, [28, 28]);
  assert.equal(s.typicalCycleLength, 28);
  assert.equal(s.typicalPeriodLength, 5);
  assert.equal(s.lastStart, '2026-09-02');
  assert.equal(s.predictedNextStart, '2026-09-30');
  assert.equal(s.predictedNextEnd, '2026-10-04');
  assert.equal(s.rangeEarliest, null); // only 2 intervals — too little for a range
});

test('computeStats: shows a range once there are 3+ intervals', () => {
  const cycles = ['2026-01-01', '2026-01-29', '2026-02-28', '2026-03-26'].map((d) => ({ start_date: d, end_date: null }));
  const s = P.computeStats(cycles); // intervals 28, 30, 26
  assert.deepEqual(s.intervals, [28, 30, 26]);
  assert.equal(s.typicalCycleLength, 28);
  assert.equal(s.rangeEarliest, P.addDays('2026-03-26', 26));
  assert.equal(s.rangeLatest, P.addDays('2026-03-26', 30));
});

test('computeStats: one forgotten period does not wreck the prediction (median, not mean)', () => {
  // Three normal 28-day cycles, then a missed entry makes one 67-day "cycle".
  const cycles = ['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26', '2026-06-01']
    .map((d) => ({ start_date: d, end_date: null }));
  const s = P.computeStats(cycles); // intervals 28, 28, 28, 67
  assert.deepEqual(s.intervals, [28, 28, 28, 67]);
  assert.equal(s.typicalCycleLength, 28); // a mean would say 37.75 -> 38
});

test('computeStats: only the most recent cycles count', () => {
  const starts = [];
  let d = '2025-01-01';
  for (let i = 0; i < 10; i++) { starts.push(d); d = P.addDays(d, i < 4 ? 35 : 26); }
  const s = P.computeStats(starts.map((x) => ({ start_date: x, end_date: null })));
  assert.equal(s.intervals.length, P.RECENT_CYCLES);
  assert.equal(s.typicalCycleLength, 26); // old 35-day cycles aged out
});

test('computeStats: period length comes from cycles that have an end date', () => {
  const s = P.computeStats([
    { start_date: '2026-08-01', end_date: '2026-08-06' }, // 6 days
    { start_date: '2026-08-29', end_date: '2026-09-01' }, // 4 days
    { start_date: '2026-09-26', end_date: null },         // ongoing, ignored
  ]);
  assert.equal(s.typicalPeriodLength, 5); // median(6, 4)
});

test('withCycleLengths: newest first, each cycle knows its own length', () => {
  const out = P.withCycleLengths([
    { id: 1, start_date: '2026-08-01', end_date: '2026-08-05' },
    { id: 2, start_date: '2026-08-30', end_date: '2026-09-03' },
    { id: 3, start_date: '2026-09-27', end_date: null },
  ]);
  assert.deepEqual(out.map((c) => c.id), [3, 2, 1]);
  assert.equal(out[0].cycle_length, null);  // current cycle, not finished
  assert.equal(out[0].period_length, null); // still ongoing
  assert.equal(out[1].cycle_length, 28);
  assert.equal(out[1].period_length, 5);
  assert.equal(out[2].cycle_length, 29);
});

test('findOverlap: closed ranges, open (ongoing) ranges, and ignoring self', () => {
  const existing = [
    { id: 1, start_date: '2026-08-01', end_date: '2026-08-05' },
    { id: 2, start_date: '2026-09-27', end_date: null }, // ongoing
  ];
  assert.equal(P.findOverlap(existing, '2026-08-10', '2026-08-14'), null);
  assert.equal(P.findOverlap(existing, '2026-08-04', '2026-08-08').id, 1);
  assert.equal(P.findOverlap(existing, '2026-08-05', '2026-08-06').id, 1);   // touching end day counts
  assert.equal(P.findOverlap(existing, '2026-08-06', '2026-08-08'), null);
  assert.equal(P.findOverlap(existing, '2026-10-01', null).id, 2);           // can't start another while one is ongoing
  assert.equal(P.findOverlap(existing, '2026-09-20', '2026-09-30').id, 2);   // ends after ongoing one began
  assert.equal(P.findOverlap(existing, '2026-08-01', '2026-08-05', 1), null); // editing itself is fine
});

test('validateCycleInput', () => {
  const max = '2026-10-05';
  const ok = P.validateCycleInput({ start_date: '2026-10-01', end_date: '', notes: '  heavy day 2 ' }, max);
  assert.deepEqual(ok.value, { start_date: '2026-10-01', end_date: null, notes: 'heavy day 2' });

  assert.match(P.validateCycleInput({}, max).error, /valid date/);
  assert.match(P.validateCycleInput({ start_date: '2026-02-30' }, max).error, /valid date/);
  assert.match(P.validateCycleInput({ start_date: '2026-10-06' }, max).error, /future/);
  assert.match(P.validateCycleInput({ start_date: '2026-10-01', end_date: 'nope' }, max).error, /Last day/);
  assert.match(P.validateCycleInput({ start_date: '2026-10-03', end_date: '2026-10-01' }, max).error, /before/);
  assert.match(P.validateCycleInput({ start_date: '2026-10-01', end_date: '2026-10-09' }, max).error, /future/);
  assert.match(P.validateCycleInput({ start_date: '2026-10-01', notes: 'x'.repeat(1001) }, max).error, /Notes/);
  assert.match(P.validateCycleInput({ start_date: '2026-10-01', notes: 42 }, max).error, /Notes/);
});

test('validateDayInput', () => {
  const max = '2026-10-05';
  const ok = P.validateDayInput('2026-10-02', { flow: 'heavy', symptoms: ['cramps', 'cramps', 'headache'], notes: ' ouch ' }, max);
  assert.deepEqual(ok.value, { log_date: '2026-10-02', flow: 'heavy', symptoms: ['cramps', 'headache'], notes: 'ouch' });

  const empty = P.validateDayInput('2026-10-02', { flow: '', symptoms: [], notes: '' }, max);
  assert.deepEqual(empty.value, { log_date: '2026-10-02', flow: null, symptoms: [], notes: null });

  assert.match(P.validateDayInput('nope', {}, max).error, /valid date/);
  assert.match(P.validateDayInput('2026-10-09', {}, max).error, /future/);
  assert.match(P.validateDayInput('2026-10-02', { flow: 'gushing' }, max).error, /flow/);
  assert.match(P.validateDayInput('2026-10-02', { symptoms: ['cramps', 'made-up'] }, max).error, /symptom/);
  assert.match(P.validateDayInput('2026-10-02', { symptoms: 'cramps' }, max).error, /list/);
});

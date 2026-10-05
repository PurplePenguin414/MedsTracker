'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/period-report');

const cycles = [
  { id: 1, start_date: '2026-05-01', end_date: '2026-05-05', notes: null },
  { id: 2, start_date: '2026-05-29', end_date: '2026-06-02', notes: 'heavy' },
  { id: 3, start_date: '2026-07-01', end_date: '2026-07-06', notes: null },
  { id: 4, start_date: '2026-10-04', end_date: null, notes: null },
];
const logs = [
  { log_date: '2026-10-04', flow: 'medium', symptoms: ['cramps', 'fatigue'], notes: '=cmd, "quoted"' },
  { log_date: '2026-05-02', flow: 'heavy', symptoms: ['cramps'], notes: '' },
];

test('buildReport: range filter keeps cycle lengths from earlier cycles', () => {
  const r = R.buildReport({ cycles, logs, range: '3m', today: '2026-10-04' });
  assert.deepEqual(r.periods.map((c) => c.id), [3, 4]); // period 3 overlaps the cutoff; 1 and 2 are older
  const r6 = R.buildReport({ cycles, logs, range: '6m', today: '2026-10-04' });
  assert.deepEqual(r6.periods.map((c) => c.id), [1, 2, 3, 4]);
  assert.equal(r6.summary.cycleCount, 3);
  assert.equal(r6.summary.cycleMin, 28);
  assert.equal(r6.summary.cycleMax, 95);
  assert.equal(r6.summary.cyclesOutside21to35, 1);
  assert.equal(r6.summary.ongoing, true);
  assert.deepEqual(r6.symptomsRanked[0], ['cramps', 2]);
});

test('buildReport: unknown range falls back to 6 months; all returns everything', () => {
  assert.equal(R.buildReport({ cycles, logs, range: 'bogus', today: '2026-10-04' }).rangeLabel, 'Last 6 months');
  assert.equal(R.buildReport({ cycles, logs, range: 'all', today: '2026-10-04' }).days.length, 2);
});

test('buildReport: empty data does not throw', () => {
  const r = R.buildReport({ cycles: [], logs: [], range: 'all', today: '2026-10-04' });
  assert.equal(r.summary.periodCount, 0);
  assert.equal(r.summary.cycleAvg, null);
});

test('reportCsv: quotes cells and neutralises spreadsheet formulas', () => {
  const csv = R.reportCsv(R.buildReport({ cycles, logs, range: 'all', today: '2026-10-04' }));
  assert.match(csv, /^Type,Date \/ start,End/);
  assert.match(csv, /"'=cmd, ""quoted"""/);
  assert.match(csv, /Day log,2026-05-02,,,,heavy,cramps,/);
  assert.match(csv, /Period,2026-10-04,ongoing/);
});

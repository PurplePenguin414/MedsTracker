'use strict';

const express = require('express');
const PDFDocument = require('pdfkit');
const P = require('../lib/period');
const R = require('../lib/period-report');

// Period tracker API. Everything here requires the normal login session —
// nothing from this module is exposed through the public Emergency link, the
// widget API key, or the external appointments API.
//
// getToday() returns the server's "today" (YYYY-MM-DD) in the app's time zone.
module.exports = function periodRoutes(db, requireAuth, getToday) {
  const router = express.Router();
  router.use(requireAuth);

  // Latest date the client may log. One day of slack so a phone that's already
  // past midnight in a different time zone isn't rejected.
  const maxDate = () => P.addDays(getToday(), 1);

  const listCycles = () => db.prepare(
    'SELECT id, start_date, end_date, notes FROM period_cycles ORDER BY start_date ASC',
  ).all();

  const parseLog = (row) => ({ ...row, symptoms: JSON.parse(row.symptoms || '[]') });

  // Everything the Period tab needs in one request.
  router.get('/', (req, res) => {
    const cycles = listCycles();
    const logs = db.prepare(
      'SELECT log_date, flow, symptoms, notes FROM period_day_logs ORDER BY log_date DESC LIMIT 500',
    ).all().map(parseLog);

    res.json({
      cycles: P.withCycleLengths(cycles),
      logs,
      stats: P.computeStats(cycles),
      options: { flows: P.FLOWS, symptoms: P.SYMPTOMS },
    });
  });

  router.post('/cycles', (req, res) => {
    const { error, value } = P.validateCycleInput(req.body, maxDate());
    if (error) return res.status(400).json({ error });

    const clash = P.findOverlap(listCycles(), value.start_date, value.end_date);
    if (clash) {
      return res.status(400).json({
        error: clash.end_date
          ? `That overlaps a period you already logged (${clash.start_date} to ${clash.end_date}).`
          : 'You still have a period in progress. Mark it as ended first.',
      });
    }

    const info = db.prepare(
      'INSERT INTO period_cycles (start_date, end_date, notes) VALUES (?, ?, ?)',
    ).run(value.start_date, value.end_date, value.notes);
    res.status(201).json({ id: info.lastInsertRowid });
  });

  router.put('/cycles/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM period_cycles WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Period not found.' });

    const { error, value } = P.validateCycleInput(req.body, maxDate());
    if (error) return res.status(400).json({ error });

    const clash = P.findOverlap(listCycles(), value.start_date, value.end_date, id);
    if (clash) {
      return res.status(400).json({
        error: clash.end_date
          ? `That overlaps a period you already logged (${clash.start_date} to ${clash.end_date}).`
          : 'That overlaps your period in progress.',
      });
    }

    db.prepare('UPDATE period_cycles SET start_date = ?, end_date = ?, notes = ? WHERE id = ?')
      .run(value.start_date, value.end_date, value.notes, id);
    res.json({ ok: true });
  });

  // Quick action: "period ended" for the one that's in progress.
  router.post('/cycles/:id/end', (req, res) => {
    const id = Number(req.params.id);
    const cycle = db.prepare('SELECT id, start_date, end_date, notes FROM period_cycles WHERE id = ?').get(id);
    if (!cycle) return res.status(404).json({ error: 'Period not found.' });
    if (cycle.end_date) return res.status(400).json({ error: 'That period already has an end date.' });

    const { error, value } = P.validateCycleInput(
      { start_date: cycle.start_date, end_date: req.body && req.body.end_date, notes: cycle.notes },
      maxDate(),
    );
    if (error) return res.status(400).json({ error });
    if (!value.end_date) return res.status(400).json({ error: 'An end date is required.' });

    db.prepare('UPDATE period_cycles SET end_date = ? WHERE id = ?').run(value.end_date, id);
    res.json({ ok: true });
  });

  router.delete('/cycles/:id', (req, res) => {
    const info = db.prepare('DELETE FROM period_cycles WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return res.status(404).json({ error: 'Period not found.' });
    res.json({ ok: true });
  });

  // Daily log (flow / symptoms / notes). Saving an empty day removes it.
  router.put('/days/:date', (req, res) => {
    const { error, value } = P.validateDayInput(req.params.date, req.body, maxDate());
    if (error) return res.status(400).json({ error });

    const empty = !value.flow && value.symptoms.length === 0 && !value.notes;
    if (empty) {
      db.prepare('DELETE FROM period_day_logs WHERE log_date = ?').run(value.log_date);
      return res.json({ ok: true, deleted: true });
    }

    db.prepare(`
      INSERT INTO period_day_logs (log_date, flow, symptoms, notes, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(log_date) DO UPDATE SET
        flow = excluded.flow, symptoms = excluded.symptoms,
        notes = excluded.notes, updated_at = datetime('now')
    `).run(value.log_date, value.flow, JSON.stringify(value.symptoms), value.notes);
    res.json({ ok: true });
  });

  router.delete('/days/:date', (req, res) => {
    if (!P.isValidDate(req.params.date)) return res.status(400).json({ error: 'Date must be a valid date.' });
    db.prepare('DELETE FROM period_day_logs WHERE log_date = ?').run(req.params.date);
    res.json({ ok: true });
  });

  // ---------- Export for doctors ----------
  const reportFor = (req) => {
    const range = R.RANGES[req.query.range] ? req.query.range : '6m';
    const logs = db.prepare('SELECT log_date, flow, symptoms, notes FROM period_day_logs').all().map(parseLog);
    return { report: R.buildReport({ cycles: listCycles(), logs, range, today: getToday() }), range };
  };

  router.get('/export/pdf', (req, res) => {
    const { report, range } = reportFor(req);
    const today = getToday();
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cycle-report-${range}-${today}.pdf"`);
    doc.pipe(res);
    R.renderPdf(doc, report, today);
    doc.end();
  });

  router.get('/export/csv', (req, res) => {
    const { report, range } = reportFor(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cycle-report-${range}-${getToday()}.csv"`);
    res.send('\uFEFF' + R.reportCsv(report));
  });

  return router;
};

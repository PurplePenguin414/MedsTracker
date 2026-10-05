'use strict';

// Doctor-facing period report: pure data building, CSV, and PDF rendering.
// Only what the user actually logged is included — no predictions.

const P = require('./period');

const RANGES = {
  '3m': { days: 91, label: 'Last 3 months' },
  '6m': { days: 182, label: 'Last 6 months' },
  '12m': { days: 365, label: 'Last 12 months' },
  all: { days: null, label: 'All time' },
};

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function average(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

// cycles: raw rows; logs: [{log_date, flow, symptoms[], notes}]; today: YYYY-MM-DD
function buildReport({ cycles, logs, range, today }) {
  const spec = RANGES[range] || RANGES['6m'];
  const from = spec.days ? P.addDays(today, -spec.days) : null;

  // Lengths are computed on ALL cycles so the first one in range still knows
  // how long it was, then we filter.
  const all = P.withCycleLengths(cycles).reverse(); // oldest first
  const periods = all.filter((c) => !from || (c.end_date || today) >= from);
  const days = logs
    .filter((l) => !from || l.log_date >= from)
    .sort((a, b) => (a.log_date < b.log_date ? -1 : 1));

  const cycleLens = periods.map((c) => c.cycle_length).filter((n) => n != null);
  const periodLens = periods.map((c) => c.period_length).filter((n) => n != null);

  const symptomCounts = {};
  const flowCounts = {};
  for (const d of days) {
    for (const s of d.symptoms) symptomCounts[s] = (symptomCounts[s] || 0) + 1;
    if (d.flow) flowCounts[d.flow] = (flowCounts[d.flow] || 0) + 1;
  }
  const symptomsRanked = Object.entries(symptomCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return {
    rangeLabel: spec.label,
    from, to: today,
    periods, days,
    summary: {
      periodCount: periods.length,
      ongoing: periods.some((c) => !c.end_date),
      lastStart: periods.length ? periods[periods.length - 1].start_date : null,
      cycleCount: cycleLens.length,
      cycleAvg: cycleLens.length ? average(cycleLens) : null,
      cycleMedian: cycleLens.length ? P.median(cycleLens) : null,
      cycleMin: cycleLens.length ? Math.min(...cycleLens) : null,
      cycleMax: cycleLens.length ? Math.max(...cycleLens) : null,
      cyclesOutside21to35: cycleLens.filter((n) => n < 21 || n > 35).length,
      periodAvg: periodLens.length ? average(periodLens) : null,
      periodMin: periodLens.length ? Math.min(...periodLens) : null,
      periodMax: periodLens.length ? Math.max(...periodLens) : null,
    },
    symptomsRanked, flowCounts,
  };
}

// ---------- CSV ----------

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function reportCsv(r) {
  const rows = [['Type', 'Date / start', 'End', 'Period length (days)', 'Cycle length (days)', 'Flow', 'Symptoms', 'Notes']];
  const items = [
    ...r.periods.map((c) => ({ date: c.start_date, order: 0, row: ['Period', c.start_date, c.end_date || 'ongoing', c.period_length, c.cycle_length, '', '', c.notes] })),
    ...r.days.map((d) => ({ date: d.log_date, order: 1, row: ['Day log', d.log_date, '', '', '', d.flow || '', d.symptoms.join('; '), d.notes] })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  for (const it of items) rows.push(it.row);
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------- PDF (pdfkit) ----------

function renderPdf(doc, r, generated) {
  const L = 50, W = 512, BOTTOM = 730;
  const ink = '#2b2822', muted = '#8a8478', line = '#e4e0d6';
  const need = (h) => { if (doc.y + h > BOTTOM) doc.addPage(); };
  const rule = () => { doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(line).lineWidth(1).stroke(); };
  const heading = (t) => { need(60); doc.moveDown(0.8); doc.fontSize(12.5).fillColor(ink).font('Helvetica-Bold').text(t, L); doc.font('Helvetica'); doc.moveDown(0.3); };
  const fmt1 = (n) => (Math.round(n * 10) / 10).toString();

  doc.fontSize(18).fillColor(ink).font('Helvetica-Bold').text('Menstrual Cycle Report', L);
  doc.font('Helvetica').fontSize(10).fillColor(muted)
    .text(`${r.rangeLabel}${r.from ? ` (${r.from} to ${r.to})` : ` (through ${r.to})`}  ·  Generated ${generated}`);
  doc.text('Self-reported from my tracking app. Observed entries only; no predictions are included.');
  doc.moveDown(0.5); rule();

  // Summary
  const s = r.summary;
  heading('Summary');
  doc.fontSize(10.5).fillColor(ink);
  if (s.periodCount === 0) {
    doc.text('No periods were logged in this time range.', L);
  } else {
    const lines = [
      `Periods logged: ${s.periodCount}${s.ongoing ? ' (one still in progress)' : ''}`,
      `Most recent period start: ${s.lastStart}`,
    ];
    if (s.cycleCount) {
      lines.push(`Cycle length (start to next start), ${s.cycleCount} cycle${s.cycleCount === 1 ? '' : 's'}: average ${fmt1(s.cycleAvg)} days, median ${fmt1(s.cycleMedian)}, range ${s.cycleMin}–${s.cycleMax} days`);
      lines.push(`Cycles outside 21–35 days: ${s.cyclesOutside21to35} of ${s.cycleCount}`);
    } else {
      lines.push('Cycle length: need at least two periods logged to calculate.');
    }
    if (s.periodAvg != null) lines.push(`Period length: average ${fmt1(s.periodAvg)} days, range ${s.periodMin}–${s.periodMax} days`);
    for (const t of lines) doc.text(t, L);
  }

  // Periods table
  if (r.periods.length) {
    heading('Periods');
    const cols = [L, L + 105, L + 210, L + 290, L + 385];
    const head = () => {
      doc.fontSize(9).fillColor(muted).font('Helvetica-Bold');
      const y = doc.y;
      ['Start', 'End', 'Length', 'Cycle length', 'Notes'].forEach((h, i) => doc.text(h, cols[i], y, { width: (cols[i + 1] || L + W) - cols[i] - 6, lineBreak: false }));
      doc.font('Helvetica'); doc.y = y + 14;
    };
    head();
    for (const c of r.periods) {
      const noteH = c.notes ? doc.fontSize(9.5).heightOfString(c.notes, { width: L + W - cols[4] }) : 0;
      const h = Math.max(15, noteH + 4);
      if (doc.y + h > BOTTOM) { doc.addPage(); head(); }
      const y = doc.y;
      doc.fontSize(9.5).fillColor(ink);
      doc.text(c.start_date, cols[0], y, { width: 100, lineBreak: false });
      doc.text(c.end_date || 'ongoing', cols[1], y, { width: 100, lineBreak: false });
      doc.text(c.period_length ? `${c.period_length} days` : '—', cols[2], y, { width: 75, lineBreak: false });
      doc.text(c.cycle_length ? `${c.cycle_length} days` : '—', cols[3], y, { width: 90, lineBreak: false });
      if (c.notes) doc.text(c.notes, cols[4], y, { width: L + W - cols[4] });
      doc.y = y + h;
    }
  }

  // Symptoms
  if (r.symptomsRanked.length || Object.keys(r.flowCounts).length) {
    heading('Symptoms and flow (days logged)');
    doc.fontSize(10).fillColor(ink);
    if (r.symptomsRanked.length) {
      doc.text(r.symptomsRanked.map(([k, n]) => `${titleCase(k)}: ${n}`).join('   ·   '), L, doc.y, { width: W });
    }
    const flows = P.FLOWS.filter((f) => r.flowCounts[f]);
    if (flows.length) {
      doc.moveDown(0.3);
      doc.text(`Flow — ${flows.map((f) => `${titleCase(f)}: ${r.flowCounts[f]}`).join('   ·   ')}`, L, doc.y, { width: W });
    }
  }

  // Daily log
  heading('Daily log');
  if (r.days.length === 0) {
    doc.fontSize(10).fillColor(muted).text('No daily entries in this time range.', L);
  } else {
    for (const d of r.days) {
      const body = [d.flow ? `Flow: ${titleCase(d.flow)}` : null, d.symptoms.length ? d.symptoms.map(titleCase).join(', ') : null]
        .filter(Boolean).join('  ·  ');
      doc.fontSize(9.5);
      const h = doc.heightOfString(body || ' ', { width: W - 80 }) + (d.notes ? doc.heightOfString(`Note: ${d.notes}`, { width: W - 80 }) : 0) + 8;
      need(h);
      const y = doc.y;
      doc.font('Helvetica-Bold').fillColor(ink).text(d.log_date, L, y, { width: 75, lineBreak: false });
      doc.font('Helvetica').fillColor(ink).text(body || '—', L + 80, y, { width: W - 80 });
      if (d.notes) doc.fillColor(muted).text(`Note: ${d.notes}`, L + 80, doc.y, { width: W - 80 });
      doc.moveDown(0.35);
    }
  }
}

module.exports = { RANGES, buildReport, reportCsv, renderPdf };

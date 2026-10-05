'use strict';

// Period tracker tab. Self-contained: app.js only calls window.openPeriodTab().
// Dates are plain YYYY-MM-DD strings everywhere; "today" comes from the
// browser's LOCAL date (never toISOString, which is UTC).
(function () {
  const $ = (id) => document.getElementById(id);
  const DAY = 86400000;

  const state = {
    data: null,        // last GET /api/period payload
    viewYear: 0,
    viewMonth: 0,      // 0-11
    cycleEditId: null, // null = adding
    dayDate: null,
    flow: '',
    symptoms: new Set(),
    wired: false,
    exportRange: '6m',
  };

  // ---------- date helpers (UTC day math, DST-safe) ----------
  function localToday() {
    const d = new Date();
    return fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function fmt(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function toDays(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY);
  }
  function fromDays(n) {
    const d = new Date(n * DAY);
    return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  function addDays(s, n) { return fromDays(toDays(s) + n); }
  function diff(a, b) { return toDays(b) - toDays(a); }
  function nice(s, withYear) {
    const [y, m, d] = s.split('-').map(Number);
    const opts = { month: 'short', day: 'numeric' };
    if (withYear) opts.year = 'numeric';
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  }
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  const esc = (s) => escapeHtml(String(s == null ? '' : s));

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw new Error(json.error || `Something went wrong (${res.status}).`);
    return json;
  }

  async function load() {
    const box = $('period-load-error');
    try {
      state.data = await api('GET', '/api/period');
      box.classList.add('hidden');
    } catch (e) {
      box.textContent = e.message;
      box.classList.remove('hidden');
      if (!state.data) return;
    }
    render();
  }

  // ---------- derived data ----------
  function ongoing() {
    return (state.data.cycles || []).find((c) => !c.end_date) || null;
  }

  // Map of date -> kind for the calendar.
  function buildMarks() {
    const marks = {};
    const { cycles, logs, stats } = state.data;
    const today = localToday();

    for (const c of cycles) {
      const end = c.end_date || today; // ongoing: shade through today
      const last = diff(c.start_date, end) < 0 ? c.start_date : end;
      for (let d = c.start_date; diff(d, last) >= 0; d = addDays(d, 1)) marks[d] = 'period';
    }
    if (stats.predictedNextStart) {
      const len = stats.typicalPeriodLength || 5;
      for (let i = 0; i < len; i++) {
        const d = addDays(stats.predictedNextStart, i);
        if (!marks[d] && diff(today, d) >= 0) marks[d] = 'predicted';
      }
    }
    const logged = {};
    for (const l of logs) logged[l.log_date] = l;
    return { marks, logged };
  }

  // ---------- render ----------
  function render() {
    renderSummary();
    renderToday();
    renderCalendar();
    renderHistory();
  }

  function renderSummary() {
    const { stats } = state.data;
    const today = localToday();
    const cur = ongoing();
    let cards;

    if (cur) {
      const day = diff(cur.start_date, today) + 1;
      cards = [
        card(`Day ${Math.max(day, 1)}`, 'Period in progress'),
        card(stats.typicalPeriodLength ? `~${stats.typicalPeriodLength}d` : '—', 'Usual length'),
        card(stats.typicalCycleLength ? `${stats.typicalCycleLength}d` : '—', 'Usual cycle'),
      ];
    } else if (stats.predictedNextStart) {
      const until = diff(today, stats.predictedNextStart);
      let big, label;
      if (until > 0) { big = String(until); label = until === 1 ? 'Day until next' : 'Days until next'; }
      else if (until === 0) { big = 'Today'; label = 'Expected start'; }
      else { big = `${-until}d`; label = 'Past expected date'; }
      cards = [
        card(big, label, until < 0 ? 'late' : ''),
        card(stats.typicalCycleLength ? `${stats.typicalCycleLength}d` : '—', 'Usual cycle'),
        card(stats.typicalPeriodLength ? `~${stats.typicalPeriodLength}d` : '—', 'Usual length'),
      ];
    } else {
      cards = [card('—', 'Days until next'), card('—', 'Usual cycle'), card('—', 'Usual length')];
    }
    $('period-summary').innerHTML = cards.join('');
  }
  function card(num, label, cls) {
    return `<div class="summary-card ${cls || ''}"><div class="num">${esc(num)}</div><div class="label">${esc(label)}</div></div>`;
  }

  function renderToday() {
    const el = $('period-today');
    const { stats, cycles } = state.data;
    const today = localToday();
    const cur = ongoing();
    const parts = [];

    if (cycles.length === 0) {
      parts.push(`<p class="period-hint">Nothing logged yet. Tap <b>Period started today</b> when it begins, or <b>+ Add past period</b> to enter earlier ones. Predictions get better after a few cycles.</p>`);
    }

    if (cur) {
      let line = `Started <b>${esc(nice(cur.start_date))}</b>.`;
      if (stats.predictedNextStart) line += ` Next one expected around <b>${esc(nice(stats.predictedNextStart))}</b>.`;
      parts.push(`<p class="period-line">${line}</p>`);
    } else if (stats.predictedNextStart) {
      let line = `Next period expected around <b>${esc(nice(stats.predictedNextStart))}</b>`;
      if (stats.rangeEarliest && stats.rangeLatest && stats.rangeEarliest !== stats.rangeLatest) {
        line += ` <span class="period-muted">(between ${esc(nice(stats.rangeEarliest))} and ${esc(nice(stats.rangeLatest))})</span>`;
      }
      line += '.';
      if (stats.basis === 'default') line += ` <span class="period-muted">Based on a typical 28-day cycle until you've logged more.</span>`;
      parts.push(`<p class="period-line">${line}</p>`);
    }

    const buttons = [];
    if (cur) {
      buttons.push(`<button type="button" class="btn btn-primary" data-act="end-today" data-id="${cur.id}">Period ended today</button>`);
    } else {
      buttons.push(`<button type="button" class="btn btn-primary" data-act="start-today">Period started today</button>`);
    }
    buttons.push(`<button type="button" class="btn btn-ghost" data-act="log-today">Log today</button>`);
    parts.push(`<div class="period-actions">${buttons.join('')}</div>`);
    parts.push(`<div id="period-today-error" class="period-msg period-msg-error hidden"></div>`);

    el.innerHTML = parts.join('');
    el.dataset.today = today;
  }

  function renderCalendar() {
    const { marks, logged } = buildMarks();
    const today = localToday();
    const y = state.viewYear;
    const m = state.viewMonth;

    $('period-cal-title').textContent = new Date(Date.UTC(y, m, 1, 12)).toLocaleDateString(undefined, {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    });

    const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<span class="period-cell empty"></span>');

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = fmt(y, m + 1, d);
      const future = diff(today, ds) > 0;
      const cls = ['period-cell'];
      if (marks[ds]) cls.push(`is-${marks[ds]}`);
      if (ds === today) cls.push('is-today');
      if (future) cls.push('is-future');
      const log = logged[ds];
      const dot = log ? '<i class="period-logdot"></i>' : '';
      const label = `${nice(ds, true)}${marks[ds] === 'period' ? ', period' : marks[ds] === 'predicted' ? ', expected period' : ''}${log ? ', has a log' : ''}`;
      cells.push(
        `<button type="button" class="${cls.join(' ')}" data-date="${ds}" aria-label="${esc(label)}"${future ? ' disabled' : ''}>${d}${dot}</button>`,
      );
    }
    $('period-cal-grid').innerHTML = cells.join('');
  }

  function renderHistory() {
    const { cycles } = state.data;
    const el = $('period-history');
    if (cycles.length === 0) {
      el.innerHTML = '<p class="period-muted">No periods logged yet.</p>';
      return;
    }
    el.innerHTML = cycles.map((c) => {
      const range = c.end_date
        ? `${esc(nice(c.start_date, true))} – ${esc(nice(c.end_date, true))}`
        : `${esc(nice(c.start_date, true))} – <b>ongoing</b>`;
      const bits = [];
      if (c.period_length) bits.push(`${plural(c.period_length, 'day')} long`);
      if (c.cycle_length) bits.push(`${plural(c.cycle_length, 'day')} cycle`);
      const meta = bits.length ? `<div class="period-muted">${esc(bits.join(' · '))}</div>` : '';
      const notes = c.notes ? `<div class="period-note">${esc(c.notes)}</div>` : '';
      return `<div class="period-row">
        <div class="period-row-main"><div class="period-row-range">${range}</div>${meta}${notes}</div>
        <div class="period-row-btns">
          <button type="button" class="btn btn-ghost btn-small" data-act="edit-cycle" data-id="${c.id}">Edit</button>
          <button type="button" class="btn btn-ghost btn-small" data-act="delete-cycle" data-id="${c.id}">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  // ---------- inline errors (no browser popups) ----------
  function showErr(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
  }

  // ---------- quick actions ----------
  async function startToday() {
    showErr('period-today-error', '');
    try {
      await api('POST', '/api/period/cycles', { start_date: localToday() });
      await load();
    } catch (e) { showErr('period-today-error', e.message); }
  }
  async function endToday(id) {
    showErr('period-today-error', '');
    try {
      await api('POST', `/api/period/cycles/${id}/end`, { end_date: localToday() });
      await load();
    } catch (e) { showErr('period-today-error', e.message); }
  }

  // ---------- cycle modal ----------
  function openCycleModal(cycle) {
    state.cycleEditId = cycle ? cycle.id : null;
    $('period-cycle-title').textContent = cycle ? 'Edit period' : 'Add period';
    $('period-cycle-start').value = cycle ? cycle.start_date : '';
    $('period-cycle-end').value = cycle && cycle.end_date ? cycle.end_date : '';
    $('period-cycle-notes').value = cycle && cycle.notes ? cycle.notes : '';
    const today = localToday();
    $('period-cycle-start').max = today;
    $('period-cycle-end').max = today;
    showErr('period-cycle-error', '');
    $('period-cycle-modal').classList.remove('hidden');
    $('period-cycle-start').focus();
  }
  function closeCycleModal() { $('period-cycle-modal').classList.add('hidden'); }

  async function saveCycle(ev) {
    ev.preventDefault();
    showErr('period-cycle-error', '');
    const body = {
      start_date: $('period-cycle-start').value,
      end_date: $('period-cycle-end').value || null,
      notes: $('period-cycle-notes').value,
    };
    try {
      if (state.cycleEditId) await api('PUT', `/api/period/cycles/${state.cycleEditId}`, body);
      else await api('POST', '/api/period/cycles', body);
      closeCycleModal();
      await load();
    } catch (e) { showErr('period-cycle-error', e.message); }
  }

  async function deleteCycle(id) {
    const row = document.querySelector(`[data-act="delete-cycle"][data-id="${id}"]`);
    if (!row) return;
    // Two-tap confirm instead of a browser confirm() popup.
    if (row.dataset.armed !== '1') {
      row.dataset.armed = '1';
      row.textContent = 'Tap again to delete';
      row.classList.add('is-armed');
      setTimeout(() => {
        if (row.isConnected) { row.dataset.armed = ''; row.textContent = 'Delete'; row.classList.remove('is-armed'); }
      }, 4000);
      return;
    }
    try {
      await api('DELETE', `/api/period/cycles/${id}`);
      await load();
    } catch (e) { showErr('period-load-error', e.message); $('period-load-error').classList.remove('hidden'); }
  }

  // ---------- day modal ----------
  function openDayModal(date) {
    state.dayDate = date;
    const log = (state.data.logs || []).find((l) => l.log_date === date);
    state.flow = log && log.flow ? log.flow : '';
    state.symptoms = new Set(log ? log.symptoms : []);
    $('period-day-title').textContent = nice(date, true);
    $('period-day-notes').value = log && log.notes ? log.notes : '';
    showErr('period-day-error', '');
    renderChips();
    $('period-day-clear').classList.toggle('hidden', !log);
    $('period-day-modal').classList.remove('hidden');
  }
  function closeDayModal() { $('period-day-modal').classList.add('hidden'); }

  function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '); }

  function renderChips() {
    const { flows, symptoms } = state.data.options;
    $('period-flow-options').innerHTML = flows.map((f) =>
      `<button type="button" class="period-chip${state.flow === f ? ' on' : ''}" data-flow="${esc(f)}" aria-pressed="${state.flow === f}">${esc(titleCase(f))}</button>`,
    ).join('');
    $('period-symptom-options').innerHTML = symptoms.map((s) =>
      `<button type="button" class="period-chip${state.symptoms.has(s) ? ' on' : ''}" data-symptom="${esc(s)}" aria-pressed="${state.symptoms.has(s)}">${esc(titleCase(s))}</button>`,
    ).join('');
  }

  async function saveDay(ev) {
    ev.preventDefault();
    showErr('period-day-error', '');
    try {
      await api('PUT', `/api/period/days/${state.dayDate}`, {
        flow: state.flow || null,
        symptoms: Array.from(state.symptoms),
        notes: $('period-day-notes').value,
      });
      closeDayModal();
      await load();
    } catch (e) { showErr('period-day-error', e.message); }
  }
  async function clearDay() {
    try {
      await api('DELETE', `/api/period/days/${state.dayDate}`);
      closeDayModal();
      await load();
    } catch (e) { showErr('period-day-error', e.message); }
  }

  // ---------- wiring ----------
  function shiftMonth(n) {
    let m = state.viewMonth + n;
    let y = state.viewYear;
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    state.viewMonth = m;
    state.viewYear = y;
    renderCalendar();
  }
  function jumpToday() {
    const [y, m] = localToday().split('-').map(Number);
    state.viewYear = y;
    state.viewMonth = m - 1;
    if (state.data) renderCalendar();
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;

    $('period-add-btn').addEventListener('click', () => openCycleModal(null));
    $('period-prev').addEventListener('click', () => shiftMonth(-1));
    $('period-next').addEventListener('click', () => shiftMonth(1));
    $('period-today-btn').addEventListener('click', jumpToday);

    $('period-cal-grid').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-date]');
      if (b && !b.disabled) openDayModal(b.dataset.date);
    });

    $('period-today').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'start-today') startToday();
      else if (b.dataset.act === 'end-today') endToday(b.dataset.id);
      else if (b.dataset.act === 'log-today') openDayModal(localToday());
    });

    $('period-history').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (b.dataset.act === 'edit-cycle') {
        const c = state.data.cycles.find((x) => x.id === id);
        if (c) openCycleModal(c);
      } else if (b.dataset.act === 'delete-cycle') deleteCycle(id);
    });

    $('period-export-btn').addEventListener('click', () => $('period-export-modal').classList.remove('hidden'));
    $('period-export-cancel').addEventListener('click', () => $('period-export-modal').classList.add('hidden'));
    $('period-export-range').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-range]');
      if (!b) return;
      state.exportRange = b.dataset.range;
      document.querySelectorAll('#period-export-range .period-chip').forEach((c) => c.classList.toggle('on', c === b));
    });
    $('period-export-pdf').addEventListener('click', () => { window.location.href = `/api/period/export/pdf?range=${state.exportRange}`; });
    $('period-export-csv').addEventListener('click', () => { window.location.href = `/api/period/export/csv?range=${state.exportRange}`; });

    $('period-cycle-form').addEventListener('submit', saveCycle);
    $('period-cycle-cancel').addEventListener('click', closeCycleModal);
    $('period-day-form').addEventListener('submit', saveDay);
    $('period-day-cancel').addEventListener('click', closeDayModal);
    $('period-day-clear').addEventListener('click', clearDay);

    $('period-flow-options').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-flow]');
      if (!b) return;
      state.flow = state.flow === b.dataset.flow ? '' : b.dataset.flow; // tap again to unset
      renderChips();
    });
    $('period-symptom-options').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-symptom]');
      if (!b) return;
      const s = b.dataset.symptom;
      if (state.symptoms.has(s)) state.symptoms.delete(s); else state.symptoms.add(s);
      renderChips();
    });

    // Click on the dark backdrop closes a modal.
    for (const id of ['period-cycle-modal', 'period-day-modal', 'period-export-modal']) {
      $(id).addEventListener('mousedown', (ev) => { if (ev.target === $(id)) $(id).classList.add('hidden'); });
    }
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { closeCycleModal(); closeDayModal(); $('period-export-modal').classList.add('hidden'); }
    });
  }

  window.openPeriodTab = function () {
    wire();
    jumpToday();
    load();
  };
})();

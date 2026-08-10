const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

const medListEl = document.getElementById('med-list');
const summaryStripEl = document.getElementById('summary-strip');

const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyTitle = document.getElementById('history-title');

let currentHistoryMedId = null;
let currentHistoryTab = 'pickups';

const INTERVAL_PRESETS = [7, 14, 21, 30, 60, 90, 180];

let currentMeds = [];
let editingId = null;     // id of med card currently in edit mode, or 'new'
let confirmingDeleteId = null; // id of med card showing inline delete confirm

// ---------- Auth ----------
async function checkSession() {
  const res = await fetch('/api/session');
  const data = await res.json();
  if (data.loggedIn) {
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.classList.remove('hidden');
  appEl.classList.add('hidden');
}

function showApp() {
  loginScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  loadMeds();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const password = document.getElementById('login-password').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (res.ok) {
    document.getElementById('login-password').value = '';
    showApp();
  } else {
    const data = await res.json();
    loginError.textContent = data.error || 'Login failed';
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

// ---------- Load & render ----------
async function loadMeds() {
  const res = await fetch('/api/medications');
  currentMeds = await res.json();
  renderSummary();
  renderMedList();
}

function renderSummary() {
  const overdue = currentMeds.filter(m => m.status === 'overdue').length;
  const dueSoon = currentMeds.filter(m => m.status === 'due_soon').length;
  const ok = currentMeds.filter(m => m.status === 'ok').length;

  summaryStripEl.innerHTML = `
    <div class="summary-card overdue">
      <div class="num">${overdue}</div>
      <div class="label">Overdue</div>
    </div>
    <div class="summary-card due_soon">
      <div class="num">${dueSoon}</div>
      <div class="label">Due soon</div>
    </div>
    <div class="summary-card ok">
      <div class="num">${ok}</div>
      <div class="label">On track</div>
    </div>
  `;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysLabel(days) {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Due today';
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function statusLabel(status) {
  if (status === 'overdue') return 'Overdue';
  if (status === 'due_soon') return 'Due soon';
  if (status === 'ok') return 'On track';
  if (status === 'as_needed') return 'As needed';
  if (status === 'as_needed_no_refills') return 'Refills needed';
  if (status === 'paused') return 'Paused';
  return status;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function todayStr() {
  // Use the browser's local date components, not toISOString() (which is
  // UTC and can roll over to "tomorrow" in the evening in US timezones).
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------- Render list ----------
function renderMedList() {
  const pieces = [];

  if (editingId === 'new') {
    pieces.push(renderEditCard(null));
  }

  if (currentMeds.length === 0 && editingId !== 'new') {
    medListEl.innerHTML = `<div class="empty-state">No medications tracked yet. Click "+ Add medication" to get started.</div>`;
    return;
  }

  const order = { overdue: 0, due_soon: 1, as_needed_no_refills: 2, ok: 3, as_needed: 4, paused: 5 };
  const sorted = [...currentMeds].sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (a.days_until_call ?? 0) - (b.days_until_call ?? 0);
  });

  sorted.forEach(med => {
    if (editingId === med.id) {
      pieces.push(renderEditCard(med));
    } else {
      pieces.push(renderViewCard(med));
    }
  });

  medListEl.innerHTML = pieces.join('');
}

function renderViewCard(med) {
  const refillsClass = med.refills_remaining === 0 ? 'red' : (med.refills_remaining <= 1 ? 'amber' : 'green');
  const isConfirmingDelete = confirmingDeleteId === med.id;
  const isPaused = med.status === 'paused';
  const isAsNeeded = med.as_needed && !isPaused;

  const nextCallBlock = (isPaused || isAsNeeded)
    ? `
        <div class="med-detail">
          <div class="k">Schedule</div>
          <div class="v strong">${isPaused ? 'Paused — no alerts' : 'As needed — no fixed schedule'}</div>
        </div>
      `
    : `
        <div class="med-detail">
          <div class="k">Next call-in</div>
          <div class="v strong">${fmtDate(med.next_call_date)}</div>
          <div class="v ${med.status === 'overdue' ? 'red' : med.status === 'due_soon' ? 'amber' : 'green'}">${daysLabel(med.days_until_call)}</div>
        </div>
        <div class="med-detail">
          <div class="k">Refill interval</div>
          <div class="v">Every ${med.refill_interval_days} days</div>
        </div>
      `;

  return `
    <div class="med-card status-${med.status}" data-id="${med.id}">
      <div class="med-card-top">
        <div>
          <div class="med-name">${escapeHtml(med.name)}</div>
          ${med.dosage ? `<div class="med-dosage">${escapeHtml(med.dosage)}</div>` : ''}
        </div>
        <span class="status-pill status-${med.status}">${statusLabel(med.status)}</span>
      </div>

      <div class="med-details">
        ${nextCallBlock}
        <div class="med-detail">
          <div class="k">Refills left at pharmacy</div>
          <div class="v strong ${refillsClass}">${med.refills_remaining}</div>
        </div>
        <div class="med-detail">
          <div class="k">Next action</div>
          <div class="v strong">${med.next_action}</div>
        </div>
        <div class="med-detail">
          <div class="k">Last picked up</div>
          <div class="v">${fmtDate(med.last_picked_up_date)}</div>
        </div>
        ${med.cost_per_fill != null ? `
        <div class="med-detail">
          <div class="k">Cost per fill</div>
          <div class="v">$${med.cost_per_fill.toFixed(2)}${med.total_spent ? ` <span class="v-muted">· $${med.total_spent.toFixed(2)} total</span>` : ''}</div>
        </div>
        ` : ''}
      </div>

      ${med.notes ? `<div class="med-notes">${escapeHtml(med.notes)}</div>` : ''}

      <div class="med-actions">
        ${isPaused ? '' : `<button class="btn btn-primary btn-small" onclick="markPickedUp(${med.id})">Mark picked up</button>`}
        <button class="btn btn-ghost btn-small" onclick="startEdit(${med.id})">Edit</button>
        <button class="btn btn-ghost btn-small" onclick="togglePaused(${med.id})">${isPaused ? 'Resume' : 'Pause'}</button>
        <button class="btn btn-ghost btn-small" onclick="openHistory(${med.id})">History</button>
        ${isConfirmingDelete ? '' : `<button class="btn btn-ghost btn-small" onclick="startDeleteConfirm(${med.id})">Delete</button>`}
      </div>

      ${isConfirmingDelete ? `
      <div class="delete-confirm">
        <span>Remove this medication from tracking?</span>
        <button class="btn btn-danger btn-small" onclick="confirmDelete(${med.id})">Yes, delete</button>
        <button class="btn btn-ghost btn-small" onclick="cancelDeleteConfirm()">Cancel</button>
      </div>
      ` : ''}
    </div>
  `;
}

function intervalOptionsHtml(selectedValue) {
  const isPreset = INTERVAL_PRESETS.includes(selectedValue);
  const options = INTERVAL_PRESETS.map(days =>
    `<option value="${days}" ${selectedValue === days ? 'selected' : ''}>Every ${days} days</option>`
  ).join('');
  return `
    ${options}
    <option value="custom" ${!isPreset ? 'selected' : ''}>Custom...</option>
  `;
}

function renderEditCard(med) {
  const isNew = !med;
  const id = isNew ? 'new' : med.id;
  const name = isNew ? '' : med.name;
  const dosage = isNew ? '' : (med.dosage || '');
  const interval = isNew ? 30 : med.refill_interval_days;
  const lastPickedUp = isNew ? todayStr() : med.last_picked_up_date;
  const refillsRemaining = isNew ? 0 : med.refills_remaining;
  const notes = isNew ? '' : (med.notes || '');
  const isAsNeeded = isNew ? false : !!med.as_needed;
  const isPreset = INTERVAL_PRESETS.includes(interval);

  return `
    <div class="med-card editing" data-id="${id}">
      <div class="edit-grid">
        <label class="field field-wide">
          Medication name
          <input type="text" class="ed-name" value="${escapeHtml(name)}" placeholder="e.g. Lisinopril">
        </label>

        <label class="field field-wide">
          Dosage <span class="optional">(optional)</span>
          <input type="text" class="ed-dosage" value="${escapeHtml(dosage)}" placeholder="e.g. 10mg, 1 tablet daily">
        </label>

        <label class="field field-wide checkbox-field">
          <input type="checkbox" class="ed-as-needed" onchange="toggleAsNeeded(this)" ${isAsNeeded ? 'checked' : ''}>
          As needed — no fixed refill schedule
        </label>

        <label class="field ed-interval-wrap" style="${isAsNeeded ? 'display:none' : ''}">
          Refill every
          <select class="ed-interval-select" onchange="toggleCustomInterval(this)">
            ${intervalOptionsHtml(interval)}
          </select>
        </label>

        <label class="field ed-interval-custom-wrap" style="${(isAsNeeded || isPreset) ? 'display:none' : ''}">
          Custom days
          <input type="number" class="ed-interval-custom" min="1" value="${isPreset ? '' : interval}" placeholder="e.g. 45">
        </label>

        <label class="field">
          Last picked up
          <input type="date" class="ed-last-picked-up" value="${lastPickedUp}">
        </label>

        <label class="field">
          Refills remaining at pharmacy
          <input type="number" class="ed-refills-remaining" min="0" value="${refillsRemaining}">
        </label>

        <label class="field">
          Cost per fill <span class="optional">(optional)</span>
          <input type="number" class="ed-cost-per-fill" min="0" step="0.01" value="${isNew ? '' : (med.cost_per_fill != null ? med.cost_per_fill : '')}" placeholder="e.g. 15.00">
        </label>

        <label class="field field-wide">
          Notes <span class="optional">(optional)</span>
          <textarea class="ed-notes" rows="2" placeholder="Pharmacy phone number, doctor, special instructions...">${escapeHtml(notes)}</textarea>
        </label>
      </div>

      <div class="form-error"></div>

      <div class="med-actions">
        <button class="btn btn-primary btn-small" onclick="saveEdit(${isNew ? "'new'" : med.id})">Save</button>
        <button class="btn btn-ghost btn-small" onclick="cancelEdit()">Cancel</button>
      </div>
    </div>
  `;
}

function toggleAsNeeded(checkboxEl) {
  const card = checkboxEl.closest('.med-card');
  const intervalWrap = card.querySelector('.ed-interval-wrap');
  const customWrap = card.querySelector('.ed-interval-custom-wrap');
  if (checkboxEl.checked) {
    intervalWrap.style.display = 'none';
    customWrap.style.display = 'none';
  } else {
    intervalWrap.style.display = '';
    const select = card.querySelector('.ed-interval-select');
    if (select.value === 'custom') customWrap.style.display = '';
  }
}

function toggleCustomInterval(selectEl) {
  const card = selectEl.closest('.med-card');
  const customWrap = card.querySelector('.ed-interval-custom-wrap');
  if (selectEl.value === 'custom') {
    customWrap.style.display = '';
    card.querySelector('.ed-interval-custom').focus();
  } else {
    customWrap.style.display = 'none';
  }
}

// ---------- Edit flow ----------
function startEdit(id) {
  editingId = id;
  confirmingDeleteId = null;
  renderMedList();
}

function startAdd() {
  editingId = 'new';
  confirmingDeleteId = null;
  renderMedList();
}

function cancelEdit() {
  editingId = null;
  renderMedList();
}

async function saveEdit(id) {
  const card = document.querySelector(`.med-card[data-id="${id}"]`);
  const isAsNeeded = card.querySelector('.ed-as-needed').checked;

  let intervalDays = null;
  if (!isAsNeeded) {
    const intervalSelect = card.querySelector('.ed-interval-select');
    intervalDays = intervalSelect.value === 'custom'
      ? parseInt(card.querySelector('.ed-interval-custom').value, 10)
      : parseInt(intervalSelect.value, 10);
  }

  const payload = {
    name: card.querySelector('.ed-name').value.trim(),
    dosage: card.querySelector('.ed-dosage').value.trim(),
    refill_interval_days: isAsNeeded ? 0 : intervalDays,
    last_picked_up_date: card.querySelector('.ed-last-picked-up').value,
    refills_remaining: parseInt(card.querySelector('.ed-refills-remaining').value, 10) || 0,
    notes: card.querySelector('.ed-notes').value.trim(),
    as_needed: isAsNeeded,
    cost_per_fill: card.querySelector('.ed-cost-per-fill').value || null
  };

  if (!payload.name || !payload.last_picked_up_date || (!isAsNeeded && !intervalDays)) {
    const errorEl = card.querySelector('.form-error');
    errorEl.textContent = 'Please fill in medication name, last picked up date, and refill interval (unless marked as needed).';
    return;
  }

  const isNew = id === 'new';
  const url = isNew ? '/api/medications' : `/api/medications/${id}`;
  const method = isNew ? 'POST' : 'PUT';

  await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  editingId = null;
  loadMeds();
}

// ---------- Pause / resume ----------
async function togglePaused(id) {
  await fetch(`/api/medications/${id}/toggle-paused`, { method: 'POST' });
  loadMeds();
}

// ---------- Delete flow ----------
function startDeleteConfirm(id) {
  confirmingDeleteId = id;
  renderMedList();
}

function cancelDeleteConfirm() {
  confirmingDeleteId = null;
  renderMedList();
}

async function confirmDelete(id) {
  await fetch(`/api/medications/${id}`, { method: 'DELETE' });
  confirmingDeleteId = null;
  loadMeds();
}

// ---------- Mark picked up ----------
async function markPickedUp(id) {
  await fetch(`/api/medications/${id}/pickup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ picked_up_date: todayStr() })
  });
  loadMeds();
}

// ---------- History (tabbed: pickups / symptoms / titration) ----------
async function openHistory(id) {
  currentHistoryMedId = id;
  const med = currentMeds.find(m => m.id === id);
  historyTitle.textContent = `History — ${med ? med.name : ''}`;
  switchHistoryTab('pickups');
  historyModal.classList.remove('hidden');
}

function switchHistoryTab(tab) {
  currentHistoryTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tab}`);
  });

  if (tab === 'pickups') loadPickupHistory();
  if (tab === 'symptoms') { document.getElementById('symptom-form-error').textContent = ''; loadSymptoms(); }
  if (tab === 'titration') { document.getElementById('dose-change-form-error').textContent = ''; loadDoseChanges(); }
}

async function loadPickupHistory() {
  const res = await fetch(`/api/medications/${currentHistoryMedId}/history`);
  const rows = await res.json();
  if (rows.length === 0) {
    historyList.innerHTML = `<div class="empty-state">No pickups logged yet.</div>`;
  } else {
    historyList.innerHTML = rows.map(r => `
      <div class="history-row">
        <span>${fmtDate(r.picked_up_date)}</span>
        <span class="muted">
          ${r.refills_remaining_after} refill${r.refills_remaining_after === 1 ? '' : 's'} left after
          ${r.cost_paid != null ? ` · $${r.cost_paid.toFixed(2)}` : ''}
        </span>
      </div>
    `).join('');
  }
}

async function loadSymptoms() {
  const listEl = document.getElementById('symptoms-list');
  document.getElementById('symptom-date').value = todayStr();
  const res = await fetch(`/api/medications/${currentHistoryMedId}/symptoms`);
  const rows = await res.json();
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No symptoms logged yet.</div>`;
  } else {
    listEl.innerHTML = rows.map(r => `
      <div class="history-row history-row-stacked">
        <div class="history-row-top">
          <span><strong>${fmtDate(r.log_date)}</strong> — ${escapeHtml(r.severity)}</span>
          <button class="btn-icon-delete" onclick="deleteSymptomLog(${r.id})" title="Delete">&times;</button>
        </div>
        ${r.description ? `<div class="muted">${escapeHtml(r.description)}</div>` : ''}
      </div>
    `).join('');
  }
}

async function addSymptomLog() {
  const log_date = document.getElementById('symptom-date').value;
  const severity = document.getElementById('symptom-severity').value;
  const description = document.getElementById('symptom-description').value.trim();
  const errorEl = document.getElementById('symptom-form-error');

  if (!log_date) {
    errorEl.textContent = 'Please select a date.';
    return;
  }
  errorEl.textContent = '';

  await fetch(`/api/medications/${currentHistoryMedId}/symptoms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log_date, severity, description })
  });

  document.getElementById('symptom-description').value = '';
  loadSymptoms();
}

async function deleteSymptomLog(id) {
  await fetch(`/api/symptoms/${id}`, { method: 'DELETE' });
  loadSymptoms();
}

async function loadDoseChanges() {
  const listEl = document.getElementById('titration-list');
  document.getElementById('dose-change-date').value = todayStr();
  const res = await fetch(`/api/medications/${currentHistoryMedId}/dose-changes`);
  const rows = await res.json();
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No dose changes logged yet.</div>`;
  } else {
    listEl.innerHTML = rows.map(r => `
      <div class="history-row history-row-stacked">
        <div class="history-row-top">
          <span><strong>${fmtDate(r.change_date)}</strong> — ${escapeHtml(r.new_dosage)}</span>
          <button class="btn-icon-delete" onclick="deleteDoseChange(${r.id})" title="Delete">&times;</button>
        </div>
        ${r.notes ? `<div class="muted">${escapeHtml(r.notes)}</div>` : ''}
      </div>
    `).join('');
  }
}

async function addDoseChange() {
  const change_date = document.getElementById('dose-change-date').value;
  const new_dosage = document.getElementById('dose-change-new-dosage').value.trim();
  const notes = document.getElementById('dose-change-notes').value.trim();
  const errorEl = document.getElementById('dose-change-form-error');

  if (!change_date || !new_dosage) {
    errorEl.textContent = 'Please fill in the date and new dosage.';
    return;
  }
  errorEl.textContent = '';

  await fetch(`/api/medications/${currentHistoryMedId}/dose-changes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ change_date, new_dosage, notes })
  });

  document.getElementById('dose-change-new-dosage').value = '';
  document.getElementById('dose-change-notes').value = '';
  loadDoseChanges();
  loadMeds(); // dosage on the med card may have changed
}

async function deleteDoseChange(id) {
  await fetch(`/api/dose-changes/${id}`, { method: 'DELETE' });
  loadDoseChanges();
}

document.getElementById('history-close-btn').addEventListener('click', () => {
  historyModal.classList.add('hidden');
});

document.getElementById('add-med-btn').addEventListener('click', startAdd);

document.getElementById('export-pdf-btn').addEventListener('click', () => {
  window.location.href = '/api/export/pdf';
});

document.getElementById('test-reminder-btn').addEventListener('click', async () => {
  const btn = document.getElementById('test-reminder-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const res = await fetch('/api/test-reminder', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(data.medsFlagged > 0
        ? `Sent — ${data.medsFlagged} medication(s) flagged in the message.`
        : 'Sent a test ping — nothing is due soon or overdue right now.');
    } else {
      alert(`Failed: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Discord reminder';
  }
});

// Expose functions used by inline onclick handlers
window.markPickedUp = markPickedUp;
window.startEdit = startEdit;
window.cancelEdit = cancelEdit;
window.saveEdit = saveEdit;
window.startDeleteConfirm = startDeleteConfirm;
window.cancelDeleteConfirm = cancelDeleteConfirm;
window.confirmDelete = confirmDelete;
window.openHistory = openHistory;
window.toggleCustomInterval = toggleCustomInterval;
window.toggleAsNeeded = toggleAsNeeded;
window.togglePaused = togglePaused;
window.switchHistoryTab = switchHistoryTab;
window.addSymptomLog = addSymptomLog;
window.deleteSymptomLog = deleteSymptomLog;
window.addDoseChange = addDoseChange;
window.deleteDoseChange = deleteDoseChange;

checkSession();

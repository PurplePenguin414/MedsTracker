const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

// ---------- Theme (light/dark) ----------
const THEME_KEY = 'med-tracker-theme';
const themeCheckbox = document.getElementById('theme-toggle-checkbox');

function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  themeCheckbox.checked = theme === 'dark';
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', theme === 'dark' ? '#121212' : '#2f6f9f');
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

themeCheckbox.addEventListener('change', () => {
  const theme = themeCheckbox.checked ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
});

initTheme();

// ---------- More menu (dropdown for secondary actions) ----------
const moreMenuBtn = document.getElementById('more-menu-btn');
const moreMenuPanel = document.getElementById('more-menu-panel');

moreMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenuPanel.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!moreMenuPanel.classList.contains('hidden') && !moreMenuPanel.contains(e.target) && e.target !== moreMenuBtn) {
    moreMenuPanel.classList.add('hidden');
  }
});

function closeMoreMenu() {
  moreMenuPanel.classList.add('hidden');
}

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
  closeMoreMenu();
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

function renderPrimaryActionButton(med) {
  if (med.called_in_date) {
    return `<button class="btn btn-primary btn-small" onclick="markPickedUp(${med.id})">Log picked up</button>`;
  }
  return `<button class="btn btn-primary btn-small" onclick="logCalledIn(${med.id})">Log called in</button>`;
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
        ${med.called_in_date ? `
        <div class="med-detail">
          <div class="k">Called in</div>
          <div class="v strong">${fmtDate(med.called_in_date)}</div>
        </div>
        ` : ''}
        ${med.cost_per_fill != null ? `
        <div class="med-detail">
          <div class="k">Cost per fill</div>
          <div class="v">$${med.cost_per_fill.toFixed(2)}${med.total_spent ? ` <span class="v-muted">· $${med.total_spent.toFixed(2)} total</span>` : ''}</div>
        </div>
        ` : ''}
      </div>

      ${med.notes ? `<div class="med-notes">${escapeHtml(med.notes)}</div>` : ''}

      <div class="med-actions">
        ${isPaused ? '' : renderPrimaryActionButton(med)}
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
// ---------- Call-in / pickup cycle ----------
async function logCalledIn(id) {
  await fetch(`/api/medications/${id}/call-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ called_in_date: todayStr() })
  });
  loadMeds();
}

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
          ${r.called_in_date ? `called in ${fmtDate(r.called_in_date)} · ` : ''}${r.refills_remaining_after} refill${r.refills_remaining_after === 1 ? '' : 's'} left after
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
  closeMoreMenu();
  window.location.href = '/api/export/pdf';
});

document.getElementById('export-history-pdf-btn').addEventListener('click', () => {
  closeMoreMenu();
  window.location.href = '/api/export/history/pdf';
});

document.getElementById('test-reminder-btn').addEventListener('click', async () => {
  closeMoreMenu();
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
window.logCalledIn = logCalledIn;
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

// ======================================================================
// ---------- Appointments module ----------
// Reuses escapeHtml() and todayStr() defined above; does not redefine them.
// ======================================================================

let apptCurrentType = 'dashboard';
let apptCurrentView = 'upcoming';
let apptPendingAttachments = [];
let apptEditingId = null;

const APPT_TYPE_FIELDS = {
  therapy: [
    { key: 'topics_covered', label: 'Topics Covered', type: 'textarea' },
    { key: 'homework_assigned', label: 'Homework Assigned', type: 'textarea' },
    { key: 'target_memory', label: 'Target Memory', type: 'text' }
  ],
  dietitian: [
    { key: 'meal_plan_changes', label: 'Meal Plan Changes', type: 'textarea' },
    { key: 'goals_discussed', label: 'Goals Discussed', type: 'textarea' },
    { key: 'measurements', label: 'Measurements (optional)', type: 'text' }
  ],
  doctor: [
    { key: 'reason_for_visit', label: 'Reason for Visit', type: 'text' },
    { key: 'diagnosis_findings', label: 'Diagnosis / Findings', type: 'textarea' },
    { key: 'prescriptions_referrals', label: 'Prescriptions / Referrals', type: 'textarea' },
    { key: 'follow_up_needed', label: 'Follow-up Needed', type: 'text' }
  ],
  other: []
};

function apptFormatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function apptFormatTime(timeStr) {
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

// ---------- Mode switcher (Medications / Appointments) ----------
function bindModeSwitcher() {
  document.querySelectorAll('.mode-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;

      document.getElementById('meds-view').classList.toggle('hidden', mode !== 'meds');
      document.getElementById('appointments-view').classList.toggle('hidden', mode !== 'appointments');
      document.getElementById('emergency-view').classList.toggle('hidden', mode !== 'emergency');
      document.querySelectorAll('.mode-only-meds').forEach(el => el.classList.toggle('hidden', mode !== 'meds'));

      if (mode === 'appointments' && !apptModuleInitialized) {
        apptModuleInitialized = true;
        bindApptTabs();
        bindApptViewToggle();
        bindApptModal();
        bindApptQuestionsModal();
        loadApptDashboard();
      }

      if (mode === 'emergency' && !emgModuleInitialized) {
        emgModuleInitialized = true;
        bindEmergencyInfo();
        loadEmergencyInfo();
        loadEmergencyShareLink();
      }
    });
  });
}
let apptModuleInitialized = false;
let emgModuleInitialized = false;

// ---------- Emergency Info ----------
let emgCurrentContacts = [];

function bindEmergencyInfo() {
  document.getElementById('emg-edit-btn').addEventListener('click', openEmgEditModal);
  document.getElementById('emg-close-edit-btn').addEventListener('click', closeEmgEditModal);
  document.getElementById('emg-edit-modal').addEventListener('click', (e) => { if (e.target.id === 'emg-edit-modal') closeEmgEditModal(); });
  document.getElementById('emg-edit-form').addEventListener('submit', saveEmergencyInfo);
  document.getElementById('emg-add-contact-btn').addEventListener('click', addEmgContact);
  document.getElementById('emg-print-btn').addEventListener('click', () => window.print());
  document.getElementById('emg-share-copy-btn').addEventListener('click', () => {
    const field = document.getElementById('emg-share-url-field');
    field.select();
    navigator.clipboard.writeText(field.value).then(() => {
      const btn = document.getElementById('emg-share-copy-btn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  });
}

async function loadEmergencyShareLink() {
  const res = await fetch('/api/emergency-share-url');
  const data = await res.json();
  const statusEl = document.getElementById('emg-share-status');
  const rowEl = document.getElementById('emg-share-url-row');

  if (data.configured) {
    statusEl.textContent = 'Ready to share:';
    document.getElementById('emg-share-url-field').value = data.url;
    rowEl.classList.remove('hidden');
  } else {
    statusEl.textContent = 'Not configured — set EMERGENCY_SHARE_KEY in .env to enable sharing.';
    rowEl.classList.add('hidden');
  }
}

async function loadEmergencyInfo() {
  const res = await fetch('/api/emergency-info');
  const data = await res.json();

  document.getElementById('emg-full-name').textContent = data.full_name || 'Not set';
  document.getElementById('emg-dob').textContent = data.date_of_birth || 'Not set';
  document.getElementById('emg-blood-type').textContent = data.blood_type || 'Not set';
  document.getElementById('emg-allergies').textContent = data.allergies || 'None listed';
  document.getElementById('emg-conditions').textContent = data.conditions || 'None listed';
  document.getElementById('emg-notes').textContent = data.notes || '—';
  document.getElementById('emg-notes-section').classList.toggle('hidden', !data.notes);

  document.getElementById('emg-medications').innerHTML = data.medications.length
    ? data.medications.map(m => `${escapeHtml(m.name)}${m.dosage ? ' — ' + escapeHtml(m.dosage) : ''}`).join('<br>')
    : 'None currently active';

  document.getElementById('emg-contacts').innerHTML = data.contacts.length
    ? data.contacts.map(c => `${escapeHtml(c.name)}${c.relationship ? ' (' + escapeHtml(c.relationship) + ')' : ''}${c.phone ? ' — ' + escapeHtml(c.phone) : ''}`).join('<br>')
    : 'None added';

  emgCurrentContacts = data.contacts;
}

function openEmgEditModal() {
  fetch('/api/emergency-info').then(r => r.json()).then(data => {
    document.getElementById('emg-input-full-name').value = data.full_name || '';
    document.getElementById('emg-input-dob').value = data.date_of_birth || '';
    document.getElementById('emg-input-blood-type').value = data.blood_type || '';
    document.getElementById('emg-input-allergies').value = data.allergies || '';
    document.getElementById('emg-input-conditions').value = data.conditions || '';
    document.getElementById('emg-input-notes').value = data.notes || '';
    emgCurrentContacts = data.contacts;
    renderEmgContactsList();
    document.getElementById('emg-edit-modal').classList.remove('hidden');
  });
}

function closeEmgEditModal() {
  document.getElementById('emg-edit-modal').classList.add('hidden');
}

function renderEmgContactsList() {
  const container = document.getElementById('emg-contacts-list');
  container.innerHTML = emgCurrentContacts.map(c => `
    <div class="week-block-item" style="background:var(--green)" data-id="${c.id}">
      <span>${escapeHtml(c.name)}${c.relationship ? ' — ' + escapeHtml(c.relationship) : ''}${c.phone ? ' — ' + escapeHtml(c.phone) : ''}</span>
      <button type="button" class="week-block-remove" data-id="${c.id}">&times;</button>
    </div>
  `).join('');
  container.querySelectorAll('.week-block-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/emergency-contacts/${btn.dataset.id}`, { method: 'DELETE' });
      emgCurrentContacts = emgCurrentContacts.filter(c => String(c.id) !== btn.dataset.id);
      renderEmgContactsList();
    });
  });
}

async function addEmgContact() {
  const name = document.getElementById('emg-new-contact-name').value.trim();
  const relationship = document.getElementById('emg-new-contact-relationship').value.trim();
  const phone = document.getElementById('emg-new-contact-phone').value.trim();
  if (!name) { alert('Name is required.'); return; }

  const res = await fetch('/api/emergency-contacts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, relationship, phone })
  });
  const contact = await res.json();
  emgCurrentContacts.push(contact);
  renderEmgContactsList();
  document.getElementById('emg-new-contact-name').value = '';
  document.getElementById('emg-new-contact-relationship').value = '';
  document.getElementById('emg-new-contact-phone').value = '';
}

async function saveEmergencyInfo(e) {
  e.preventDefault();
  const payload = {
    full_name: document.getElementById('emg-input-full-name').value,
    date_of_birth: document.getElementById('emg-input-dob').value,
    blood_type: document.getElementById('emg-input-blood-type').value,
    allergies: document.getElementById('emg-input-allergies').value,
    conditions: document.getElementById('emg-input-conditions').value,
    notes: document.getElementById('emg-input-notes').value
  };
  await fetch('/api/emergency-info', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  closeEmgEditModal();
  loadEmergencyInfo();
}

// ---------- Appointment tabs ----------
function bindApptTabs() {
  document.querySelectorAll('.appt-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.appt-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      apptCurrentType = btn.dataset.type;

      if (apptCurrentType === 'dashboard') {
        document.getElementById('appt-dashboard-view').classList.remove('hidden');
        document.getElementById('appt-type-toolbar').classList.add('hidden');
        document.getElementById('appt-upcoming-view').classList.add('hidden');
        document.getElementById('appt-history-view').classList.add('hidden');
        document.getElementById('appt-prep-view').classList.add('hidden');
        loadApptDashboard();
        return;
      }

      document.getElementById('appt-dashboard-view').classList.add('hidden');
      document.getElementById('appt-type-toolbar').classList.remove('hidden');

      const isTherapy = apptCurrentType === 'therapy';
      document.querySelectorAll('.appt-therapy-only').forEach(el => el.classList.toggle('hidden', !isTherapy));
      if (!isTherapy && apptCurrentView === 'prep') apptSwitchView('upcoming');
      else apptSwitchView(apptCurrentView);
    });
  });
}

async function loadApptDashboard() {
  const types = ['therapy', 'dietitian', 'doctor', 'other'];
  const results = await Promise.all(
    types.map(type => fetch(`/api/appointments?type=${type}&status=upcoming`).then(r => r.json()))
  );

  let all = [];
  types.forEach((type, i) => {
    results[i].forEach(a => all.push({ ...a, _type: type }));
  });

  // Closest to furthest away: ascending by date, then time
  all.sort((a, b) => {
    const dateCompare = a.appointment_date.localeCompare(b.appointment_date);
    if (dateCompare !== 0) return dateCompare;
    return (a.appointment_time || '').localeCompare(b.appointment_time || '');
  });

  const container = document.getElementById('appt-dash-all');
  if (!all.length) {
    container.innerHTML = '<div class="appt-empty-state">No upcoming appointments.</div>';
    return;
  }
  container.innerHTML = all.map(a => apptCardHtml(a, true)).join('');
  container.querySelectorAll('.appt-card').forEach(card => {
    card.addEventListener('click', () => openApptModal(card.dataset.id));
  });
}

function apptCardHtml(a, showTypeLabel = false) {
  const typeLabel = showTypeLabel
    ? `<span class="appt-type-badge appt-type-${a._type || a.type}">${APPT_TYPE_LABELS[a._type || a.type]}</span>`
    : '';
  return `
    <div class="appt-card" data-id="${a.id}">
      <div class="appt-card-top">
        <span class="appt-card-date">${apptFormatDate(a.appointment_date)}${a.appointment_time ? ' · ' + apptFormatTime(a.appointment_time) : ''}</span>
        <span class="appt-status appt-status-${a.status}">${a.status}</span>
      </div>
      <div class="appt-card-provider">
        ${typeLabel}${escapeHtml(a.provider_name || 'No provider listed')}${a.location ? ' — ' + escapeHtml(a.location) : ''}
      </div>
    </div>
  `;
}

const APPT_TYPE_LABELS = {
  therapy: 'Therapy / EMDR',
  dietitian: 'Dietitian',
  doctor: 'Doctor',
  other: 'Other'
};

// ---------- View toggle (Upcoming / History / Prep) ----------
function bindApptViewToggle() {
  document.querySelectorAll('.appt-view-btn').forEach(btn => {
    btn.addEventListener('click', () => apptSwitchView(btn.dataset.view));
  });
}

function apptSwitchView(view) {
  apptCurrentView = view;
  document.querySelectorAll('.appt-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('appt-upcoming-view').classList.toggle('hidden', view !== 'upcoming');
  document.getElementById('appt-history-view').classList.toggle('hidden', view !== 'history');
  document.getElementById('appt-prep-view').classList.toggle('hidden', view !== 'prep');

  if (view === 'upcoming') loadApptUpcoming();
  if (view === 'history') loadApptHistory();
  if (view === 'prep') loadApptPrep();
}

async function loadApptUpcoming() {
  const res = await fetch(`/api/appointments?type=${apptCurrentType}&status=upcoming`);
  const appts = await res.json();
  const container = document.getElementById('appt-upcoming-list');
  container.innerHTML = appts.length ? appts.map(apptCardHtml).join('') : '<div class="appt-empty-state">No appointments yet.</div>';
  container.querySelectorAll('.appt-card').forEach(card => card.addEventListener('click', () => openApptModal(card.dataset.id)));
}

async function loadApptHistory() {
  const res = await fetch(`/api/appointments/history/${apptCurrentType}`);
  const appts = await res.json();
  const container = document.getElementById('appt-history-list');
  container.innerHTML = appts.length ? appts.map(apptCardHtml).join('') : '<div class="appt-empty-state">No appointments in the last 5 days.</div>';
  container.querySelectorAll('.appt-card').forEach(card => card.addEventListener('click', () => openApptModal(card.dataset.id)));
}

// ---------- Appointment Modal ----------
function bindApptModal() {
  document.getElementById('add-appt-btn').addEventListener('click', () => openApptModal(null));
  document.getElementById('appt-form').addEventListener('submit', saveAppt);
  document.getElementById('delete-appt-btn').addEventListener('click', deleteAppt);
  document.getElementById('appt-file-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) apptPendingAttachments.push(file);
  });
  document.getElementById('appt-modal').addEventListener('click', (e) => {
    if (e.target.id === 'appt-modal') closeApptModal();
  });
}

async function openApptModal(id) {
  document.getElementById('appt-questions-modal').classList.add('hidden');

  apptEditingId = id;
  apptPendingAttachments = [];
  const form = document.getElementById('appt-form');
  form.reset();
  document.getElementById('appt-type').value = apptCurrentType === 'dashboard' ? 'therapy' : apptCurrentType;
  document.getElementById('delete-appt-btn').classList.toggle('hidden', !id);
  document.getElementById('appt-attachment-list').innerHTML = '';

  renderApptTypeFields(document.getElementById('appt-type').value, {});

  if (id) {
    const res = await fetch(`/api/appointments/${id}`);
    const appt = await res.json();
    document.getElementById('appt-modal-title').textContent = 'Edit Appointment';
    document.getElementById('appt-id').value = appt.id;
    document.getElementById('appt-type').value = appt.type;
    document.getElementById('appt-provider-name').value = appt.provider_name || '';
    document.getElementById('appt-status').value = appt.status;
    document.getElementById('appt-date').value = appt.appointment_date;
    document.getElementById('appt-time').value = appt.appointment_time || '';
    document.getElementById('appt-location').value = appt.location || '';
    document.getElementById('appt-notes').value = appt.notes || '';
    document.getElementById('appt-reminder-enabled').checked = !!appt.reminder_enabled;
    renderApptTypeFields(appt.type, appt.details, appt.customFields);
    renderApptAttachments(appt.attachments);
  } else {
    document.getElementById('appt-modal-title').textContent = 'New Appointment';
    document.getElementById('appt-id').value = '';
    document.getElementById('appt-reminder-enabled').checked = true;
  }

  document.getElementById('appt-modal').classList.remove('hidden');
}

function closeApptModal() {
  document.getElementById('appt-modal').classList.add('hidden');
}

function renderApptTypeFields(type, details = {}, customFields = []) {
  const container = document.getElementById('appt-type-specific-fields');
  if (type === 'other') {
    container.innerHTML = `
      <label style="display:block;font-size:0.85rem;color:var(--muted);margin-bottom:0.4rem;">Custom Fields</label>
      <div id="appt-custom-fields-container"></div>
      <button type="button" class="appt-add-field-btn" id="appt-add-custom-field-btn">+ Add Field</button>
    `;
    const cfContainer = document.getElementById('appt-custom-fields-container');
    (customFields || []).forEach(f => addApptCustomFieldRow(cfContainer, f.field_label, f.field_value));
    document.getElementById('appt-add-custom-field-btn').addEventListener('click', () => addApptCustomFieldRow(cfContainer, '', ''));
    return;
  }
  const fields = APPT_TYPE_FIELDS[type] || [];
  container.innerHTML = fields.map(f => `
    <label class="field field-wide">
      ${f.label}
      ${f.type === 'textarea'
        ? `<textarea id="appt-field-${f.key}" rows="2">${escapeHtml(details[f.key] || '')}</textarea>`
        : `<input type="text" id="appt-field-${f.key}" value="${escapeHtml(details[f.key] || '')}">`}
    </label>
  `).join('');
}

function addApptCustomFieldRow(container, label, value) {
  const row = document.createElement('div');
  row.className = 'appt-custom-field-row';
  row.innerHTML = `
    <input type="text" placeholder="Field name" class="appt-cf-label" value="${escapeHtml(label || '')}">
    <input type="text" placeholder="Value" class="appt-cf-value" value="${escapeHtml(value || '')}">
    <button type="button" class="appt-remove-field-btn">&times;</button>
  `;
  row.querySelector('.appt-remove-field-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function renderApptAttachments(attachments) {
  const list = document.getElementById('appt-attachment-list');
  list.innerHTML = (attachments || []).map(a => `
    <div class="appt-attachment-item" data-id="${a.id}">
      <a href="/api/appointment-attachments/file/${a.id}" target="_blank">${escapeHtml(a.original_name)}</a>
      <button type="button" class="appt-attachment-remove" data-id="${a.id}">Remove</button>
    </div>
  `).join('');
  list.querySelectorAll('.appt-attachment-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/appointment-attachments/${btn.dataset.id}`, { method: 'DELETE' });
      btn.closest('.appt-attachment-item').remove();
    });
  });
}

async function saveAppt(e) {
  e.preventDefault();
  const type = document.getElementById('appt-type').value;
  const id = document.getElementById('appt-id').value;

  const payload = {
    type,
    provider_name: document.getElementById('appt-provider-name').value,
    status: document.getElementById('appt-status').value,
    appointment_date: document.getElementById('appt-date').value,
    appointment_time: document.getElementById('appt-time').value,
    location: document.getElementById('appt-location').value,
    notes: document.getElementById('appt-notes').value,
    reminder_enabled: document.getElementById('appt-reminder-enabled').checked
  };

  if (type === 'other') {
    const rows = document.querySelectorAll('#appt-custom-fields-container .appt-custom-field-row');
    payload.customFields = Array.from(rows).map(row => ({
      field_label: row.querySelector('.appt-cf-label').value,
      field_value: row.querySelector('.appt-cf-value').value
    })).filter(f => f.field_label.trim());
  } else {
    const fields = APPT_TYPE_FIELDS[type] || [];
    payload.details = {};
    fields.forEach(f => {
      const el = document.getElementById(`appt-field-${f.key}`);
      if (el) payload.details[f.key] = el.value;
    });
  }

  let apptId = id;
  if (id) {
    await fetch(`/api/appointments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    const res = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const created = await res.json();
    apptId = created.id;
  }

  for (const file of apptPendingAttachments) {
    const formData = new FormData();
    formData.append('file', file);
    await fetch(`/api/appointment-attachments/${apptId}`, { method: 'POST', body: formData });
  }
  apptPendingAttachments = [];

  closeApptModal();
  apptRefreshCurrentView();
}

async function deleteAppt() {
  const id = document.getElementById('appt-id').value;
  if (!id) return;
  if (!confirm('Delete this appointment? This cannot be undone.')) return;
  await fetch(`/api/appointments/${id}`, { method: 'DELETE' });
  closeApptModal();
  apptRefreshCurrentView();
}

function apptRefreshCurrentView() {
  const activeTab = document.querySelector('.appt-tab-btn.active')?.dataset.type;
  if (activeTab === 'dashboard') {
    loadApptDashboard();
  } else if (apptCurrentView === 'upcoming') {
    loadApptUpcoming();
  } else if (apptCurrentView === 'history') {
    loadApptHistory();
  }
}

// ---------- Prep Checklist (Therapy only) ----------
async function loadApptPrep() {
  const res = await fetch('/api/appointments?type=therapy&status=upcoming');
  const appts = await res.json();
  const select = document.getElementById('appt-prep-select');

  if (!appts.length) {
    select.innerHTML = '<option value="">No upcoming therapy appointments</option>';
    document.getElementById('appt-prep-checklist').innerHTML = '';
    return;
  }
  select.innerHTML = appts.map(a =>
    `<option value="${a.id}">${apptFormatDate(a.appointment_date)}${a.provider_name ? ' — ' + escapeHtml(a.provider_name) : ''}</option>`
  ).join('');
  select.onchange = () => renderApptPrepChecklist(select.value);
  renderApptPrepChecklist(select.value);
}

async function renderApptPrepChecklist(apptId) {
  const container = document.getElementById('appt-prep-checklist');
  if (!apptId) { container.innerHTML = ''; return; }
  const res = await fetch(`/api/appointments/${apptId}`);
  const appt = await res.json();

  if (!appt.questionChecks.length) {
    container.innerHTML = '<div class="appt-empty-state">No questions in your bank yet. Add some via "Manage Questions".</div>';
    return;
  }
  container.innerHTML = appt.questionChecks.map(q => `
    <label class="appt-prep-item">
      <input type="checkbox" data-question-id="${q.question_id}" ${q.checked ? 'checked' : ''}>
      <span>${escapeHtml(q.question_text)}</span>
    </label>
  `).join('');
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const checks = {};
      checks[cb.dataset.questionId] = cb.checked;
      await fetch(`/api/appointments/${apptId}/question-checks`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checks)
      });
    });
  });
}

// ---------- Manage Questions Modal ----------
function bindApptQuestionsModal() {
  document.getElementById('manage-appt-questions-btn').addEventListener('click', openApptQuestionsModal);
  document.getElementById('close-appt-questions-btn').addEventListener('click', closeApptQuestionsModal);
  document.getElementById('appt-questions-modal').addEventListener('click', (e) => {
    if (e.target.id === 'appt-questions-modal') closeApptQuestionsModal();
  });
  document.getElementById('appt-add-question-form').addEventListener('submit', addApptQuestion);
}

function closeApptQuestionsModal() {
  document.getElementById('appt-questions-modal').classList.add('hidden');
  loadApptPrep();
}

async function openApptQuestionsModal() {
  document.getElementById('appt-modal').classList.add('hidden');
  document.getElementById('appt-questions-modal').classList.remove('hidden');
  await renderApptQuestionBank();
}

async function renderApptQuestionBank() {
  const res = await fetch('/api/appointment-questions');
  const questions = await res.json();
  const list = document.getElementById('appt-question-bank-list');
  if (!questions.length) {
    list.innerHTML = '<div class="appt-empty-state">No questions yet — add your first one above.</div>';
    return;
  }
  list.innerHTML = questions.map(q => `
    <div class="appt-question-bank-item" data-id="${q.id}">
      <span>${escapeHtml(q.question_text)}</span>
      <button type="button" class="appt-attachment-remove" data-id="${q.id}">Remove</button>
    </div>
  `).join('');
  list.querySelectorAll('.appt-attachment-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/appointment-questions/${btn.dataset.id}`, { method: 'DELETE' });
      renderApptQuestionBank();
    });
  });
}

async function addApptQuestion(e) {
  e.preventDefault();
  const input = document.getElementById('appt-new-question-text');
  if (!input.value.trim()) return;
  await fetch('/api/appointment-questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_text: input.value.trim() })
  });
  input.value = '';
  renderApptQuestionBank();
}

// ---------- Test appointment reminder (wired into existing more-menu) ----------
document.getElementById('test-appt-reminder-btn')?.addEventListener('click', async () => {
  closeMoreMenu();
  try {
    const res = await fetch('/api/appointment-test-reminder', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    alert(data.message || 'Appointment reminder check triggered.');
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// ---------- Init ----------
bindModeSwitcher();

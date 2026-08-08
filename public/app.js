const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

const medListEl = document.getElementById('med-list');
const summaryStripEl = document.getElementById('summary-strip');

const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyTitle = document.getElementById('history-title');

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
  return 'On track';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

  const order = { overdue: 0, due_soon: 1, ok: 2 };
  const sorted = [...currentMeds].sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return a.days_until_call - b.days_until_call;
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
        <div class="med-detail">
          <div class="k">Next call-in</div>
          <div class="v strong">${fmtDate(med.next_call_date)}</div>
          <div class="v ${med.status === 'overdue' ? 'red' : med.status === 'due_soon' ? 'amber' : 'green'}">${daysLabel(med.days_until_call)}</div>
        </div>
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
        <div class="med-detail">
          <div class="k">Refill interval</div>
          <div class="v">Every ${med.refill_interval_days} days</div>
        </div>
      </div>

      ${med.notes ? `<div class="med-notes">${escapeHtml(med.notes)}</div>` : ''}

      <div class="med-actions">
        <button class="btn btn-primary btn-small" onclick="markPickedUp(${med.id})">Mark picked up</button>
        <button class="btn btn-ghost btn-small" onclick="startEdit(${med.id})">Edit</button>
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

        <label class="field">
          Refill every
          <select class="ed-interval-select" onchange="toggleCustomInterval(this)">
            ${intervalOptionsHtml(interval)}
          </select>
        </label>

        <label class="field ed-interval-custom-wrap" style="${isPreset ? 'display:none' : ''}">
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

        <label class="field field-wide">
          Notes <span class="optional">(optional)</span>
          <textarea class="ed-notes" rows="2" placeholder="Pharmacy phone number, doctor, special instructions...">${escapeHtml(notes)}</textarea>
        </label>
      </div>

      <div class="med-actions">
        <button class="btn btn-primary btn-small" onclick="saveEdit(${isNew ? "'new'" : med.id})">Save</button>
        <button class="btn btn-ghost btn-small" onclick="cancelEdit()">Cancel</button>
      </div>
    </div>
  `;
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
  const intervalSelect = card.querySelector('.ed-interval-select');
  const intervalDays = intervalSelect.value === 'custom'
    ? parseInt(card.querySelector('.ed-interval-custom').value, 10)
    : parseInt(intervalSelect.value, 10);

  const payload = {
    name: card.querySelector('.ed-name').value.trim(),
    dosage: card.querySelector('.ed-dosage').value.trim(),
    refill_interval_days: intervalDays,
    last_picked_up_date: card.querySelector('.ed-last-picked-up').value,
    refills_remaining: parseInt(card.querySelector('.ed-refills-remaining').value, 10) || 0,
    notes: card.querySelector('.ed-notes').value.trim()
  };

  if (!payload.name || !intervalDays || !payload.last_picked_up_date) {
    alert('Please fill in medication name, refill interval, and last picked up date.');
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

// ---------- History (view-only modal) ----------
async function openHistory(id) {
  const med = currentMeds.find(m => m.id === id);
  historyTitle.textContent = `Pickup history — ${med ? med.name : ''}`;
  const res = await fetch(`/api/medications/${id}/history`);
  const rows = await res.json();
  if (rows.length === 0) {
    historyList.innerHTML = `<div class="empty-state">No pickups logged yet.</div>`;
  } else {
    historyList.innerHTML = rows.map(r => `
      <div class="history-row">
        <span>${fmtDate(r.picked_up_date)}</span>
        <span class="muted">${r.refills_remaining_after} refill${r.refills_remaining_after === 1 ? '' : 's'} left after</span>
      </div>
    `).join('');
  }
  historyModal.classList.remove('hidden');
}

document.getElementById('history-close-btn').addEventListener('click', () => {
  historyModal.classList.add('hidden');
});

document.getElementById('add-med-btn').addEventListener('click', startAdd);

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

checkSession();

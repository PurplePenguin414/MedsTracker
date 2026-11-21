// ---------- Therapy Notes (mirrors the Obsidian session template) ----------
const FEELINGS_AFTER = ['Calm','Clearer','Relieved','Sad','Angry','Hopeful','Worried','Frustrated','Uncomfortable','Surprised','Understood','Confused','Emotional','Tired','Encouraged','Unsure'];
const FEELINGS_CAME_UP = FEELINGS_AFTER.filter(f => f !== 'Clearer');
const YMN = ['Yes', 'Maybe', 'Not Right Now'];
const TRY_WHEN = ['Today', 'This Week', 'Before Next Session', 'When it feels relevant', "I'm Not Making a Decision Now"];
const NOTICE = ['A reoccurring thought','A feeling that keeps coming up','A situation that affects me','How I responded to something','A relationship or interaction','A Habit or pattern','Something that helps me','A boundary','A need I notice','Nothing specific right now'];

// type: text | mood | chips (multi) | choice (single)
const THERAPY_SECTIONS = [
  { title: 'Before the session', hint: 'What matters for today’s session.', fields: [
    { k: 'pre_mood', label: 'Current mood (0–10)', type: 'mood' },
    { k: 'pre_talk', label: 'What I want to talk about today', type: 'text' },
    { k: 'pre_focus', label: 'If we only have time for one thing, I’d like to focus on…', type: 'text' },
    { k: 'pre_difficult', label: 'What’s been difficult since my last session?', type: 'text' },
    { k: 'pre_good', label: 'What’s been going well?', type: 'text' },
  ]},
  { title: 'After: how I’m feeling', hint: 'A session doesn’t have to leave me feeling better to be meaningful.', fields: [
    { k: 'post_feelings', label: 'Right now I notice…', type: 'chips', options: FEELINGS_AFTER },
    { k: 'post_mood', label: 'Current mood (0–10)', type: 'mood' },
  ]},
  { title: 'What we talked about', fields: [
    { k: 'topics', label: 'Main topics from today', type: 'text' },
    { k: 'stood_out', label: 'Something that stood out', type: 'text' },
    { k: 'stood_out_why', label: 'Why did it stand out to me?', type: 'text' },
    { k: 'feelings_came_up', label: 'Feelings that came up', type: 'chips', options: FEELINGS_CAME_UP },
    { k: 'saw_differently', label: 'Something I saw differently', type: 'text' },
    { k: 'saw_differently_what', label: 'What feels different about it?', type: 'text' },
  ]},
  { title: 'Unsaid & still thinking', fields: [
    { k: 'didnt_say', label: 'Something I didn’t get to say', type: 'text' },
    { k: 'didnt_say_back', label: 'Bring it back up next time?', type: 'choice', options: YMN },
    { k: 'still_thinking', label: 'What am I still thinking about?', type: 'text' },
    { k: 'still_thinking_why', label: 'What about it is staying with me?', type: 'text' },
  ]},
  { title: 'Takeaways', fields: [
    { k: 'take_remember', label: 'Something I want to remember', type: 'text' },
    { k: 'take_learned', label: 'Something I learned or noticed about myself', type: 'text' },
    { k: 'take_think', label: 'Something I want to think about more', type: 'text' },
  ]},
  { title: 'Practice & between sessions', fields: [
    { k: 'practice', label: 'Something I want to practice or try', type: 'text' },
    { k: 'practice_when', label: 'I might try this…', type: 'choice', options: TRY_WHEN },
    { k: 'notice_between', label: 'Something I want to notice between sessions', type: 'chips', options: NOTICE },
    { k: 'notice_text', label: 'I might want to pay attention to…', type: 'text' },
    { k: 'questions', label: 'Questions I still have', type: 'text' },
    { k: 'questions_bring', label: 'Bring this to my next session?', type: 'choice', options: YMN },
    { k: 'make_space', label: 'What I want to make space for', type: 'text' },
    { k: 'be_mindful', label: 'What I want to be mindful of', type: 'text' },
  ]},
  { title: 'Next session', fields: [
    { k: 'next_talk', label: 'Next time I may want to talk about…', type: 'text' },
    { k: 'next_followup', label: 'Something to follow up on', type: 'text' },
    { k: 'next_question', label: 'A question to ask', type: 'text' },
    { k: 'next_new', label: 'Something new to bring up', type: 'text' },
  ]},
  { title: 'Note to myself & quick capture', fields: [
    { k: 'note_self', label: 'What would I like to remind myself after today’s session?', type: 'text' },
    { k: 'q_one_thing', label: 'One thing I want to remember', type: 'line' },
    { k: 'q_question', label: 'One question I still have', type: 'line' },
    { k: 'q_revisit', label: 'One thing I want to revisit', type: 'line' },
    { k: 'q_word', label: 'One word for today’s session', type: 'line' },
    { k: 'q_taking', label: 'One thing I’m taking with me', type: 'line' },
    { k: 'q_leave', label: 'One thing I can leave here for now', type: 'line' },
  ]},
];

let therapyInitialized = false;
let therapyNotes = [];
let therapyEditing = null; // null = list view, 'new' or id = form
let therapyOpenId = null;

function thLocalToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function thFmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function thHasValue(v) { return Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && String(v).trim() !== ''); }

async function initTherapyNotes() {
  if (!therapyInitialized) {
    therapyInitialized = true;
    document.getElementById('therapy-root').addEventListener('click', onTherapyClick);
  }
  await loadTherapyNotes();
}

async function loadTherapyNotes() {
  const res = await fetch('/api/therapy-notes');
  if (!res.ok) { document.getElementById('therapy-root').innerHTML = '<p class="form-error">Could not load notes.</p>'; return; }
  therapyNotes = await res.json();
  renderTherapy();
}

function renderTherapy() {
  const root = document.getElementById('therapy-root');
  if (therapyEditing !== null) { root.innerHTML = renderTherapyForm(); return; }
  const head = `<div class="emg-toolbar">
      <h2 class="emg-heading">Therapy Notes</h2>
      <div class="emg-toolbar-actions">
        ${therapyNotes.length ? '<button type="button" class="btn btn-ghost" data-th="export-all">⬇ Export all (.md)</button>' : ''}
        <button type="button" class="btn btn-primary" data-th="new">+ New session</button>
      </div></div>`;
  if (!therapyNotes.length) {
    root.innerHTML = head + '<p class="th-empty">No session notes yet. Tap “New session” — you can fill in the “before” part ahead of time and come back for the rest.</p>';
    return;
  }
  root.innerHTML = head + therapyNotes.map(renderTherapyCard).join('');
}

function renderTherapyCard(n) {
  const d = n.data;
  const open = therapyOpenId === n.id;
  const pills = [];
  if (thHasValue(d.pre_mood)) pills.push(`Before ${escapeHtml(d.pre_mood)}/10`);
  if (thHasValue(d.post_mood)) pills.push(`After ${escapeHtml(d.post_mood)}/10`);
  if (thHasValue(d.q_word)) pills.push(`“${escapeHtml(d.q_word)}”`);
  const snippet = d.topics || d.pre_talk || '';
  return `<div class="th-card">
    <div class="th-card-head" data-th="toggle" data-id="${n.id}">
      <div><strong>${escapeHtml(thFmtDate(n.session_date))}</strong>
        <div class="th-pills">${pills.map(p => `<span class="th-pill">${p}</span>`).join('')}</div>
        ${!open && snippet ? `<div class="th-snippet">${escapeHtml(snippet.slice(0, 140))}${snippet.length > 140 ? '…' : ''}</div>` : ''}
      </div>
      <span class="th-chevron">${open ? '▾' : '▸'}</span>
    </div>
    ${open ? renderTherapyDetail(n) : ''}
  </div>`;
}

function renderTherapyDetail(n) {
  const d = n.data;
  const sections = THERAPY_SECTIONS.map(sec => {
    const rows = sec.fields.filter(f => thHasValue(d[f.k])).map(f => {
      const v = Array.isArray(d[f.k]) ? d[f.k].join(', ') : d[f.k];
      return `<div class="th-row"><div class="th-label">${escapeHtml(f.label)}</div><div class="th-value">${escapeHtml(v)}</div></div>`;
    }).join('');
    return rows ? `<div class="th-section"><h4>${escapeHtml(sec.title)}</h4>${rows}</div>` : '';
  }).join('');
  return `<div class="th-detail">${sections || '<p class="th-empty">Nothing filled in yet.</p>'}
    <div class="th-actions">
      <button type="button" class="btn btn-primary" data-th="edit" data-id="${n.id}">Edit</button>
      <button type="button" class="btn btn-ghost" data-th="export" data-id="${n.id}">⬇ Export (.md)</button>
      <button type="button" class="btn btn-ghost th-delete" data-th="delete" data-id="${n.id}">Delete</button>
    </div>
    <div class="form-error" id="th-del-msg-${n.id}"></div>
  </div>`;
}

function renderTherapyForm() {
  const note = therapyEditing === 'new' ? null : therapyNotes.find(n => n.id === therapyEditing);
  const d = note ? note.data : {};
  const date = note ? note.session_date : thLocalToday();
  const secs = THERAPY_SECTIONS.map((sec, i) => `
    <details class="th-form-section" ${i < 2 || sec.fields.some(f => thHasValue(d[f.k])) ? 'open' : ''}>
      <summary>${escapeHtml(sec.title)}</summary>
      ${sec.hint ? `<p class="th-hint">${escapeHtml(sec.hint)}</p>` : ''}
      ${sec.fields.map(f => renderTherapyField(f, d[f.k])).join('')}
    </details>`).join('');
  return `<div class="emg-toolbar"><h2 class="emg-heading">${note ? 'Edit session' : 'New session'}</h2></div>
    <div class="th-form">
      <label class="field">Session date
        <input type="date" id="th-date" value="${escapeHtml(date)}">
      </label>
      ${secs}
      <div class="form-error" id="th-form-error"></div>
      <div class="th-actions">
        <button type="button" class="btn btn-primary" data-th="save">Save</button>
        <button type="button" class="btn btn-ghost" data-th="cancel">Cancel</button>
      </div>
    </div>`;
}

function renderTherapyField(f, val) {
  const label = escapeHtml(f.label);
  if (f.type === 'mood') {
    const opts = ['<option value="">—</option>'].concat(Array.from({ length: 11 }, (_, i) =>
      `<option value="${i}" ${String(val) === String(i) ? 'selected' : ''}>${i}</option>`)).join('');
    return `<label class="field">${label}<select data-k="${f.k}">${opts}</select></label>`;
  }
  if (f.type === 'line') return `<label class="field">${label}<input type="text" data-k="${f.k}" value="${escapeHtml(val || '')}"></label>`;
  if (f.type === 'text') return `<label class="field">${label}<textarea rows="3" data-k="${f.k}">${escapeHtml(val || '')}</textarea></label>`;
  if (f.type === 'chips') {
    const sel = Array.isArray(val) ? val : [];
    return `<div class="field"><div>${label}</div><div class="th-chips" data-k="${f.k}" data-type="chips">${f.options.map(o =>
      `<button type="button" class="th-chip ${sel.includes(o) ? 'on' : ''}" data-th="chip" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div></div>`;
  }
  // single choice
  return `<div class="field"><div>${label}</div><div class="th-chips" data-k="${f.k}" data-type="choice">${f.options.map(o =>
    `<button type="button" class="th-chip ${val === o ? 'on' : ''}" data-th="choice" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div></div>`;
}

function collectTherapyForm() {
  const data = {};
  document.querySelectorAll('#th-form-root [data-k], .th-form [data-k]').forEach(el => {
    const k = el.dataset.k;
    if (el.dataset.type === 'chips') {
      const v = [...el.querySelectorAll('.th-chip.on')].map(c => c.dataset.v);
      if (v.length) data[k] = v;
    } else if (el.dataset.type === 'choice') {
      const on = el.querySelector('.th-chip.on');
      if (on) data[k] = on.dataset.v;
    } else if (el.value && el.value.trim() !== '') {
      data[k] = el.value.trim();
    }
  });
  return data;
}

async function onTherapyClick(e) {
  const el = e.target.closest('[data-th]');
  if (!el) return;
  const act = el.dataset.th;
  const id = el.dataset.id ? Number(el.dataset.id) : null;

  if (act === 'new') { therapyEditing = 'new'; renderTherapy(); window.scrollTo(0, 0); }
  else if (act === 'cancel') { therapyEditing = null; renderTherapy(); }
  else if (act === 'toggle') { therapyOpenId = therapyOpenId === id ? null : id; renderTherapy(); }
  else if (act === 'edit') { therapyEditing = id; renderTherapy(); window.scrollTo(0, 0); }
  else if (act === 'chip') { el.classList.toggle('on'); }
  else if (act === 'choice') {
    const was = el.classList.contains('on');
    el.parentElement.querySelectorAll('.th-chip').forEach(c => c.classList.remove('on'));
    if (!was) el.classList.add('on');
  }
  else if (act === 'save') await saveTherapyNote();
  else if (act === 'export') { const n = therapyNotes.find(x => x.id === id); if (n) downloadTherapyMd([n], `therapy-${n.session_date}.md`); }
  else if (act === 'export-all') downloadTherapyMd(therapyNotes.slice().reverse(), `therapy-notes-${thLocalToday()}.md`);
  else if (act === 'delete') {
    // Inline two-step confirm (no browser popups)
    if (el.dataset.armed !== '1') {
      el.dataset.armed = '1'; el.textContent = 'Tap again to confirm delete';
      setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; el.textContent = 'Delete'; } }, 4000);
      return;
    }
    const res = await fetch(`/api/therapy-notes/${id}`, { method: 'DELETE' });
    if (res.ok) { therapyOpenId = null; await loadTherapyNotes(); }
    else document.getElementById(`th-del-msg-${id}`).textContent = 'Could not delete. Try again.';
  }
}

async function saveTherapyNote() {
  const errEl = document.getElementById('th-form-error');
  const date = document.getElementById('th-date').value;
  if (!date) { errEl.textContent = 'Pick a session date.'; return; }
  const data = collectTherapyForm();
  const isNew = therapyEditing === 'new';
  const res = await fetch(isNew ? '/api/therapy-notes' : `/api/therapy-notes/${therapyEditing}`, {
    method: isNew ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_date: date, data })
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); errEl.textContent = b.error || 'Could not save. Try again.'; return; }
  const saved = await res.json();
  therapyEditing = null;
  therapyOpenId = saved.id;
  await loadTherapyNotes();
}

function therapyToMarkdown(n) {
  const out = [`# Therapy Session — ${thFmtDate(n.session_date)}`, ''];
  THERAPY_SECTIONS.forEach(sec => {
    const rows = sec.fields.filter(f => thHasValue(n.data[f.k]));
    if (!rows.length) return;
    out.push(`## ${sec.title}`, '');
    rows.forEach(f => {
      const v = n.data[f.k];
      out.push(`**${f.label}**`, Array.isArray(v) ? v.map(x => `- ${x}`).join('\n') : v, '');
    });
  });
  return out.join('\n');
}

function downloadTherapyMd(notes, filename) {
  const text = notes.map(therapyToMarkdown).join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

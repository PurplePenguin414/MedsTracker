// ---------- Journal prompts ----------
// The app ships with no prompts. Everything here is added by the user and stored
// on the server (/api/journal), so it syncs across devices.
//   Part 1: tap a feeling to see every prompt saved under it.
//   Part 2: tap any theme or feeling to get one random prompt ("Random" draws from every saved prompt).
//   Part 3: add a prompt to any section. Remove any prompt (tap twice).
(function () {
  const $ = (id) => document.getElementById(id);
  const feelingsEl = $('journal-feelings');
  const feelingPromptsEl = $('journal-feeling-prompts');
  const themesEl = $('journal-themes');
  const themeCardEl = $('journal-theme-card');
  const formEl = $('journal-add-form');
  const catSelect = $('journal-add-category');
  const textInput = $('journal-add-text');
  const msgEl = $('journal-msg');
  if (!feelingsEl || !feelingPromptsEl || !themesEl || !themeCardEl || !formEl) return;

  const RANDOM = { key: 'random', label: 'Random' };
  const state = {
    feelings: [], themes: [], prompts: [],
    activeFeeling: null, activeTheme: null, shown: null, // shown = the prompt on the theme card
  };

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

  function showMsg(text, isError) {
    msgEl.textContent = text || '';
    msgEl.className = 'jr-msg' + (text ? (isError ? ' jr-msg-error' : ' jr-msg-ok') : ' hidden');
  }

  async function load() {
    try {
      const data = await api('GET', '/api/journal');
      state.feelings = data.feelings;
      state.themes = data.themes;
      state.prompts = data.prompts;
      showMsg('');
    } catch (e) { showMsg(e.message, true); }
    renderAll();
  }

  const promptsIn = (key) => state.prompts.filter(p => p.category === key);
  const poolFor = (key) => (key === 'random' ? state.prompts : promptsIn(key));

  function makeChip(label, count, isOn, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jr-chip' + (isOn ? ' on' : '');
    b.textContent = count === null ? label : `${label} (${count})`;
    b.addEventListener('click', onClick);
    return b;
  }

  // Two-tap remove, same as the Period tab (no browser popups).
  function makeRemoveBtn(id, afterRemove) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-small jr-remove';
    b.textContent = 'Remove';
    b.addEventListener('click', async () => {
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1';
        b.textContent = 'Tap again to remove';
        b.classList.add('is-armed');
        setTimeout(() => {
          if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Remove'; b.classList.remove('is-armed'); }
        }, 4000);
        return;
      }
      try {
        await api('DELETE', `/api/journal/${id}`);
        state.prompts = state.prompts.filter(p => p.id !== id);
        showMsg('');
        afterRemove();
        renderAll();
      } catch (e) { showMsg(e.message, true); }
    });
    return b;
  }

  function renderFeelings() {
    feelingsEl.replaceChildren();
    state.feelings.forEach(f => {
      feelingsEl.appendChild(makeChip(f.label, promptsIn(f.key).length, state.activeFeeling === f.key, () => {
        state.activeFeeling = state.activeFeeling === f.key ? null : f.key; // tap again to close
        renderFeelings();
      }));
    });

    feelingPromptsEl.replaceChildren();
    const f = state.feelings.find(x => x.key === state.activeFeeling);
    if (!f) { feelingPromptsEl.classList.add('hidden'); return; }
    feelingPromptsEl.classList.remove('hidden');

    const list = promptsIn(f.key);
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'jr-empty';
      empty.textContent = `Nothing saved under “${f.label}” yet. Add one below.`;
      feelingPromptsEl.appendChild(empty);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'jr-list';
    list.forEach(p => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'jr-list-text';
      span.textContent = p.text;
      li.append(span, makeRemoveBtn(p.id, () => {}));
      ul.appendChild(li);
    });
    feelingPromptsEl.appendChild(ul);
  }

  function pickPrompt(key) {
    const pool = poolFor(key);
    if (!pool.length) return null;
    if (pool.length === 1) return pool[0];
    let p;
    do { p = pool[Math.floor(Math.random() * pool.length)]; } while (state.shown && p.id === state.shown.id);
    return p;
  }

  function renderThemes(newPick) {
    themesEl.replaceChildren();
    // Themes in the order they were asked for (Random fifth), then every feeling too.
    [...state.themes.slice(0, 4), RANDOM, ...state.themes.slice(4), ...state.feelings].forEach(t => {
      themesEl.appendChild(makeChip(t.label, null, state.activeTheme === t.key, () => {
        state.activeTheme = t.key;
        state.shown = null;
        renderThemes(true);
      }));
    });

    themeCardEl.replaceChildren();
    const t = [...state.themes, RANDOM, ...state.feelings].find(x => x.key === state.activeTheme);
    if (!t) { themeCardEl.classList.add('hidden'); return; }
    themeCardEl.classList.remove('hidden');

    if (newPick) state.shown = pickPrompt(t.key);
    // If the shown prompt was removed elsewhere, pick again.
    if (state.shown && !state.prompts.some(p => p.id === state.shown.id)) state.shown = pickPrompt(t.key);

    const tag = document.createElement('div');
    tag.className = 'jr-card-tag';
    tag.textContent = t.label;
    themeCardEl.appendChild(tag);

    if (!state.shown) {
      const empty = document.createElement('p');
      empty.className = 'jr-empty';
      empty.textContent = t.key === 'random'
        ? 'You haven’t saved any prompts yet. Add one below.'
        : `Nothing saved under “${t.label}” yet. Add one below.`;
      themeCardEl.appendChild(empty);
      return;
    }

    const text = document.createElement('p');
    text.className = 'jr-card-text';
    text.textContent = state.shown.text;
    const actions = document.createElement('div');
    actions.className = 'jr-card-actions';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-ghost';
    again.textContent = 'Another one';
    again.addEventListener('click', () => renderThemes(true));
    actions.append(again, makeRemoveBtn(state.shown.id, () => { state.shown = null; }));
    themeCardEl.append(text, actions);
  }

  function renderAddForm() {
    const keep = catSelect.value;
    catSelect.replaceChildren();
    const group = (label, items) => {
      const g = document.createElement('optgroup');
      g.label = label;
      items.forEach(c => {
        const o = document.createElement('option');
        o.value = c.key;
        o.textContent = c.label;
        g.appendChild(o);
      });
      catSelect.appendChild(g);
    };
    group('When you’re feeling…', state.feelings);
    group('Themes', state.themes);
    if (keep) catSelect.value = keep;
  }

  function renderAll() {
    renderFeelings();
    renderThemes(false);
    renderAddForm();
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = catSelect.value;
    const text = textInput.value;
    try {
      await api('POST', '/api/journal', { category, text });
      textInput.value = '';
      await load();
      // Show where it landed so it's obvious the add worked.
      if (state.feelings.some(f => f.key === category)) { state.activeFeeling = category; renderFeelings(); }
      showMsg('Added.', false);
    } catch (err) { showMsg(err.message, true); }
  });

  window.openJournalTab = load;
})();

'use strict';

// Journal prompts. The app ships with NO prompts: every one is added by the user.
// "Random" is not a stored category; it draws from every stored prompt.

const FEELINGS = [
  { key: 'angry', label: 'Angry' },
  { key: 'sad', label: 'Sad' },
  { key: 'anxious', label: 'Anxious' },
  { key: 'reflecting', label: 'Reflecting' },
  { key: 'lonely', label: 'Lonely' },
  { key: 'selfesteem', label: 'Low Self-Esteem' },
  { key: 'unstuck', label: 'Getting Unstuck' },
];

const THEMES = [
  { key: 'happy', label: 'Happy' },
  { key: 'letters', label: 'Letters' },
  { key: 'past', label: 'Past' },
  { key: 'present', label: 'Present' },
  { key: 'luck', label: 'The Luck Log' },
  { key: 'looking-back', label: 'Looking Back' },
];

const CATEGORY_KEYS = new Set([...FEELINGS, ...THEMES].map(c => c.key));
const MAX_TEXT = 500;

function validatePromptInput(body) {
  const category = body && typeof body.category === 'string' ? body.category : '';
  const text = body && typeof body.text === 'string' ? body.text.trim().replace(/\s+/g, ' ') : '';
  if (!CATEGORY_KEYS.has(category)) return { error: 'Pick a section for this prompt.' };
  if (!text) return { error: 'Type the prompt first.' };
  if (text.length > MAX_TEXT) return { error: `Prompts can be up to ${MAX_TEXT} characters.` };
  return { value: { category, text } };
}

function initJournalTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS journal_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (category, text)
);
`);
}

module.exports = { FEELINGS, THEMES, CATEGORY_KEYS, MAX_TEXT, validatePromptInput, initJournalTables };

'use strict';

const express = require('express');
const J = require('../lib/journal');

// Journal prompts API. Login required; not exposed through the public Emergency
// link, the widget API key, or the external appointments API.
module.exports = function journalRoutes(db, requireAuth) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    const prompts = db.prepare(
      'SELECT id, category, text FROM journal_prompts ORDER BY id ASC',
    ).all();
    res.json({ feelings: J.FEELINGS, themes: J.THEMES, prompts });
  });

  router.post('/', (req, res) => {
    const { error, value } = J.validatePromptInput(req.body);
    if (error) return res.status(400).json({ error });
    const dupe = db.prepare('SELECT id FROM journal_prompts WHERE category = ? AND text = ?')
      .get(value.category, value.text);
    if (dupe) return res.status(400).json({ error: 'You already have that prompt in this section.' });
    const info = db.prepare('INSERT INTO journal_prompts (category, text) VALUES (?, ?)')
      .run(value.category, value.text);
    res.status(201).json({ id: info.lastInsertRowid });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
    const info = db.prepare('DELETE FROM journal_prompts WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'Prompt not found' });
    res.json({ ok: true });
  });

  return router;
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../lib/journal');

test('validatePromptInput accepts a real section and trims/collapses the text', () => {
  const r = J.validatePromptInput({ category: 'angry', text: '  What   do I\nneed?  ' });
  assert.deepEqual(r.value, { category: 'angry', text: 'What do I need?' });
});

test('validatePromptInput rejects unknown sections, including random', () => {
  assert.ok(J.validatePromptInput({ category: 'random', text: 'x' }).error);
  assert.ok(J.validatePromptInput({ category: 'nope', text: 'x' }).error);
  assert.ok(J.validatePromptInput({ text: 'x' }).error);
  assert.ok(J.validatePromptInput(null).error);
});

test('validatePromptInput rejects empty, whitespace-only, non-string and over-long text', () => {
  assert.ok(J.validatePromptInput({ category: 'sad', text: '' }).error);
  assert.ok(J.validatePromptInput({ category: 'sad', text: '   \n ' }).error);
  assert.ok(J.validatePromptInput({ category: 'sad', text: 42 }).error);
  assert.ok(J.validatePromptInput({ category: 'sad', text: 'a'.repeat(J.MAX_TEXT + 1) }).error);
  assert.equal(J.validatePromptInput({ category: 'sad', text: 'a'.repeat(J.MAX_TEXT) }).error, undefined);
});

test('the section list has the 7 feelings and 7 stored themes, including Other (Random is not stored)', () => {
  assert.equal(J.FEELINGS.length, 7);
  assert.ok(J.CATEGORY_KEYS.has('anxious'));
  assert.equal(J.FEELINGS.find(f => f.key === 'lonely').label, 'Lonely');
  assert.equal(J.THEMES.length, 7);
  assert.ok(J.CATEGORY_KEYS.has('other'));
  assert.ok(!J.CATEGORY_KEYS.has('random'));
});

test('routes: ships empty, add, duplicate, remove (in-memory db)', async () => {
  const Database = require('better-sqlite3');
  const express = require('express');
  const db = new Database(':memory:');
  J.initJournalTables(db);
  const app = express();
  app.use(express.json());
  app.use('/api/journal', require('../routes/journal')(db, (req, res, next) => next()));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/journal`;
  const call = async (method, url, body) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    let r = await call('GET', base);
    assert.equal(r.json.prompts.length, 0, 'no built-in prompts');

    r = await call('POST', base, { category: 'luck', text: 'Mine' });
    assert.equal(r.status, 201);
    const id = r.json.id;
    r = await call('POST', base, { category: 'luck', text: 'Mine' });
    assert.equal(r.status, 400, 'duplicate in same section');
    r = await call('POST', base, { category: 'happy', text: 'Mine' });
    assert.equal(r.status, 201, 'same text in another section is fine');
    r = await call('GET', base);
    assert.equal(r.json.prompts.length, 2);

    r = await call('DELETE', `${base}/${id}`);
    assert.equal(r.status, 200);
    r = await call('DELETE', `${base}/${id}`);
    assert.equal(r.status, 404);
    r = await call('DELETE', `${base}/abc`);
    assert.equal(r.status, 400);
    r = await call('GET', base);
    assert.deepEqual(r.json.prompts.map(p => p.category), ['happy']);
  } finally { server.close(); db.close(); }
});

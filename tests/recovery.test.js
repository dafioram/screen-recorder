import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  META_NAME,
  addFile,
  canDelete,
  createSessionMeta,
  parseMeta,
  pendingFiles,
  scanSessions,
  serializeMeta,
  synthesizeMeta,
  updateFile,
} from '../src/recovery.js';

test('metadata round trip', () => {
  const meta = createSessionMeta({ id: 'screen-recording-2026-10-22-193000', mimeType: 'video/webm', extension: 'webm', splitSeconds: 30 });
  addFile(meta, { name: 'a-part01.webm', part: 1 });
  addFile(meta, { name: 'a-part02.webm', part: 2 });
  updateFile(meta, 'a-part01.webm', { activeMs: 30_000, finalized: true });
  const back = parseMeta(serializeMeta(meta));
  assert.equal(back.id, meta.id);
  assert.equal(back.files.length, 2);
  assert.equal(back.files[0].activeMs, 30_000);
  assert.equal(back.files[0].finalized, true);
  assert.equal(back.files[1].finalized, false);
});

test('invalid metadata is rejected', () => {
  assert.equal(parseMeta('nope'), null);
  assert.equal(parseMeta(JSON.stringify({ version: 99, id: 'x', files: [] })), null);
  assert.equal(parseMeta(JSON.stringify({ version: 1, files: [] })), null);
});

test('pending files and cleanup decisions', () => {
  const meta = createSessionMeta({ id: 's' });
  addFile(meta, { name: 'a.webm', part: 1 });
  addFile(meta, { name: 'b.webm', part: 2 });
  assert.equal(pendingFiles(meta).length, 2);
  updateFile(meta, 'a.webm', { downloaded: true });
  updateFile(meta, 'b.webm', { discarded: true });
  assert.equal(canDelete(meta), true);

  const empty = createSessionMeta({ id: 'e' });
  addFile(empty, { name: 'c.webm', part: 1 });
  assert.equal(canDelete(empty, { 'c.webm': 0 }), true, 'zero-byte files are not worth recovering');
});

test('folders without metadata are rebuilt from their files', () => {
  const meta = synthesizeMeta('s', [
    { name: 'rec-part02.mkv', size: 10 },
    { name: 'rec-part01.mkv', size: 10 },
  ]);
  assert.deepEqual(meta.files.map((f) => f.part), [1, 2]);
  assert.equal(meta.mimeType, 'video/x-matroska');
  assert.equal(meta.files[0].incomplete, true);
});

test('scanSessions reads metadata and sizes from storage', async () => {
  const meta = createSessionMeta({ id: 'one', mimeType: 'video/webm' });
  addFile(meta, { name: 'one.webm', part: 1 });
  const storage = {
    listSessions: async () => ['one', 'two'],
    listFiles: async (id) => (id === 'one' ? [{ name: 'one.webm', size: 500 }, { name: META_NAME, size: 80 }] : [{ name: 'two-part01.webm', size: 9 }]),
    readText: async (id) => (id === 'one' ? serializeMeta(meta) : null),
  };
  const sessions = await scanSessions(storage);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sizes['one.webm'], 500);
  assert.equal(sessions[0].meta.mimeType, 'video/webm');
  assert.equal(sessions[1].meta.files[0].name, 'two-part01.webm');
});

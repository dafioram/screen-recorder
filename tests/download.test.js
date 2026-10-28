import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UrlRegistry, fileNameFor, formatBytes, sessionBaseName } from '../src/download.js';

test('filenames use local date and time', () => {
  const base = sessionBaseName(new Date(2026, 9, 22, 19, 30, 0));
  assert.equal(base, 'screen-recording-2026-10-22-193000');
  assert.equal(fileNameFor(base, 1, 'webm', false), 'screen-recording-2026-10-22-193000.webm');
  assert.equal(fileNameFor(base, 1, 'webm', true), 'screen-recording-2026-10-22-193000-part01.webm');
  assert.equal(fileNameFor(base, 12, 'mkv', true), 'screen-recording-2026-10-22-193000-part12.mkv');
  assert.equal(fileNameFor(base, 100, 'mp4', true), 'screen-recording-2026-10-22-193000-part100.mp4');
});

test('byte formatting', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(60e6), '57.2 MB');
  assert.equal(formatBytes(3.6e9), '3.4 GB');
});

test('url registry revokes replaced and removed urls', () => {
  const revoked = [];
  let n = 0;
  const api = { createObjectURL: () => `blob:${++n}`, revokeObjectURL: (u) => revoked.push(u) };
  const reg = new UrlRegistry(api);
  assert.equal(reg.set('player', {}), 'blob:1');
  assert.equal(reg.set('player', {}), 'blob:2');
  assert.deepEqual(revoked, ['blob:1']);
  reg.set('other', {});
  reg.revokeAll();
  assert.deepEqual(revoked.sort(), ['blob:1', 'blob:2', 'blob:3']);
  assert.equal(reg.get('player'), null);
});

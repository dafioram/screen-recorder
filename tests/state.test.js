import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDo, createStore, isBusy, nextStatus, restStatus } from '../src/state.js';

const SOURCE = { surface: 'monitor' };
const FILE = { name: 'a.webm' };

test('happy path: record, stop, keep the source, record again, then discard', () => {
  const s = createStore();
  const path = [
    ['select', undefined, 'selectingSource'],
    ['granted', { source: SOURCE }, 'previewing'],
    ['record', undefined, 'countdown'],
    ['done', undefined, 'recording'],
    ['pause', undefined, 'paused'],
    ['resume', undefined, 'recording'],
    ['stop', undefined, 'finalizing'],
    ['finalized', { files: [FILE] }, 'review'],
    ['record', undefined, 'countdown'],
    ['done', undefined, 'recording'],
    ['stop', undefined, 'finalizing'],
    ['finalized', { files: [FILE, { name: 'b.webm' }] }, 'review'],
    ['discard', { files: [FILE] }, 'review'],
    ['discard', { files: [] }, 'previewing'],
  ];
  for (const [event, patch, to] of path) {
    assert.equal(s.dispatch(event, patch), true, event);
    assert.equal(s.get().status, to, `${event} -> ${to}`);
  }
});

test('after stopping with no source left, recordings rest in review and the app can select again', () => {
  const s = createStore({ status: 'finalizing', source: null });
  assert.equal(s.dispatch('finalized', { files: [FILE] }), true);
  assert.equal(s.get().status, 'review');
  assert.equal(canDo('review', 'select', s.get()), true);
  assert.equal(canDo('review', 'record', s.get()), true, 'the app checks the source before recording');
  assert.equal(s.dispatch('granted', { source: SOURCE }), false, 'granted only happens from selecting');
  assert.equal(nextStatus('selectingSource', 'granted', { files: [FILE], source: SOURCE }), 'review');
  assert.equal(nextStatus('selectingSource', 'granted', { source: SOURCE }), 'previewing');
});

test('invalid events change nothing', () => {
  const s = createStore();
  assert.equal(s.dispatch('stop'), false);
  assert.equal(s.dispatch('record'), false);
  assert.equal(s.get().status, 'ready');
});

test('a second recording cannot start while one is active', () => {
  assert.equal(canDo('recording', 'select'), false);
  assert.equal(canDo('recording', 'record'), false);
  assert.equal(canDo('paused', 'record'), false);
  assert.equal(canDo('finalizing', 'select'), false);
});

test('cancel and source-ended paths rest in the right place', () => {
  assert.equal(nextStatus('selectingSource', 'cancel'), 'ready');
  assert.equal(nextStatus('countdown', 'cancel', { source: SOURCE }), 'previewing');
  assert.equal(nextStatus('countdown', 'cancel', { source: SOURCE, files: [FILE] }), 'review');
  assert.equal(nextStatus('countdown', 'sourceEnded'), 'ready');
  assert.equal(nextStatus('recording', 'sourceEnded'), 'finalizing');
  assert.equal(nextStatus('paused', 'sourceEnded'), 'finalizing');
  assert.equal(nextStatus('finalizing', 'fail'), 'error');
  assert.equal(nextStatus('error', 'reset'), 'ready');
  assert.equal(nextStatus('ready', 'recover'), 'review');
});

test('restStatus prefers review, then a live source, then ready', () => {
  assert.equal(restStatus({}), 'ready');
  assert.equal(restStatus({ source: SOURCE }), 'previewing');
  assert.equal(restStatus({ source: SOURCE, files: [FILE] }), 'review');
  assert.equal(restStatus({ files: [] }), 'ready');
});

test('set keeps status and notifies listeners', () => {
  const s = createStore({ files: [] });
  const seen = [];
  s.subscribe((state, prev) => seen.push([prev.status, state.status, state.files.length]));
  s.set({ files: [1], status: 'recording' });
  assert.equal(s.get().status, 'ready');
  assert.deepEqual(seen, [['ready', 'ready', 1]]);
});

test('busy states lock settings', () => {
  for (const st of ['countdown', 'recording', 'paused', 'finalizing']) assert.equal(isBusy(st), true);
  for (const st of ['ready', 'previewing', 'review', 'error']) assert.equal(isBusy(st), false);
});

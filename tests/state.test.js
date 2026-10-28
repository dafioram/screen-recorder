import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDo, createStore, isBusy, nextStatus } from '../src/state.js';

test('happy path through every state', () => {
  const s = createStore();
  const path = [
    ['select', 'selectingSource'],
    ['granted', 'previewing'],
    ['record', 'countdown'],
    ['done', 'recording'],
    ['pause', 'paused'],
    ['resume', 'recording'],
    ['stop', 'finalizing'],
    ['finalized', 'review'],
    ['newRecording', 'ready'],
  ];
  for (const [event, to] of path) {
    assert.equal(s.dispatch(event), true, event);
    assert.equal(s.get().status, to);
  }
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

test('cancel and source-ended paths', () => {
  assert.equal(nextStatus('selectingSource', 'cancel'), 'ready');
  assert.equal(nextStatus('countdown', 'cancel'), 'previewing');
  assert.equal(nextStatus('countdown', 'sourceEnded'), 'ready');
  assert.equal(nextStatus('recording', 'sourceEnded'), 'finalizing');
  assert.equal(nextStatus('paused', 'sourceEnded'), 'finalizing');
  assert.equal(nextStatus('finalizing', 'fail'), 'error');
  assert.equal(nextStatus('error', 'reset'), 'ready');
  assert.equal(nextStatus('ready', 'recover'), 'review');
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

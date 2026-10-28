import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActiveTimer, formatClock, formatElapsed, overlayText } from '../src/time.js';
import { overlayLabel } from '../src/overlay.js';

test('elapsed time shows MM:SS, then H:MM:SS from one hour', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59_999), '00:59');
  assert.equal(formatElapsed(61_000), '01:01');
  assert.equal(formatElapsed(3_599_000), '59:59');
  assert.equal(formatElapsed(3_600_000), '1:00:00');
  assert.equal(formatElapsed(3_725_000), '1:02:05');
});

test('clock and overlay formats', () => {
  const d = new Date(2026, 0, 1, 9, 5, 7);
  assert.equal(formatClock(d), '09:05:07');
  assert.equal(overlayText('elapsed', 65_000, d), '01:05');
  assert.equal(overlayText('clock', 65_000, d), '09:05:07');
  assert.equal(overlayText('both', 65_000, d), '01:05  ·  09:05:07');
});

test('active timer excludes paused time', () => {
  const t = new ActiveTimer();
  t.start(1000);
  assert.equal(t.elapsed(4000), 3000);
  t.pause(5000);
  assert.equal(t.elapsed(9000), 4000, 'frozen while paused');
  t.resume(10_000);
  assert.equal(t.elapsed(12_000), 6000);
});

test('overlay label freezes during pause and restarts per file', () => {
  const t = new ActiveTimer();
  t.start(0);
  t.pause(70_000);
  const state = { format: 'elapsed', timer: t.snapshot(), fileOffset: 0 };
  assert.equal(overlayLabel(state, 999_999), '01:10');
  assert.equal(overlayLabel({ ...state, fileOffset: 60_000 }, 999_999), '00:10');
});

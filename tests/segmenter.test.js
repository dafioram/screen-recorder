import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SplitSchedule, partLabel, rollover } from '../src/segmenter.js';

test('part labels are zero padded to two digits', () => {
  assert.equal(partLabel(1), 'part01');
  assert.equal(partLabel(42), 'part42');
  assert.equal(partLabel(100), 'part100');
});

test('3 min 10 s with a 30 s split gives 7 files: six of 30 s and one of 10 s', () => {
  const total = 190_000;
  const schedule = new SplitSchedule(30);
  const durations = [];
  let start = 0;
  for (let t = 0; t <= total; t += 250) {
    if (schedule.due(t)) {
      durations.push(t - start);
      start = t;
      schedule.advance();
    }
  }
  durations.push(total - start);
  assert.equal(durations.length, 7);
  assert.deepEqual(durations.slice(0, 6), Array(6).fill(30_000));
  assert.equal(durations[6], 10_000);
  assert.equal(SplitSchedule.expectedParts(total, 30), 7);
  assert.equal(SplitSchedule.expectedParts(180_000, 30), 6);
});

test('disabled schedule is never due', () => {
  const s = new SplitSchedule(0);
  assert.equal(s.enabled, false);
  assert.equal(s.due(10 ** 9), false);
  assert.equal(s.timeToNextMs(5000), null);
  assert.equal(new SplitSchedule(60).timeToNextMs(45_000), 15_000);
});

test('rollover starts the next file before finishing the current one', async () => {
  const order = [];
  const result = await rollover(
    async () => order.push('finish'),
    () => {
      order.push('start');
      return 'next';
    },
  );
  await result.finishing;
  assert.deepEqual(order, ['start', 'finish']);
  assert.equal(result.next, 'next');
  assert.equal(result.gap, false);
});

test('rollover falls back to stop-then-start and reports the gap', async () => {
  const order = [];
  let attempts = 0;
  const result = await rollover(
    async () => order.push('finish'),
    () => {
      attempts += 1;
      if (attempts === 1) throw new Error('second recorder not allowed');
      order.push('start');
      return 'next';
    },
  );
  assert.deepEqual(order, ['finish', 'start']);
  assert.equal(result.gap, true);
  assert.equal(result.next, 'next');
});

test('rollover propagates a second failure', async () => {
  await assert.rejects(
    rollover(async () => {}, () => {
      throw new Error('nope');
    }),
    /nope/,
  );
});

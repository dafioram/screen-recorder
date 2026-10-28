import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, WorkerSink } from '../src/storage.js';

test('memory storage keeps chunks in order and can delete them', async () => {
  const storage = new MemoryStorage();
  const sink = storage.createSink('s1', 'a.webm');
  sink.write(new Blob(['abc']));
  sink.write(new Blob(['def']));
  const blob = await sink.close();
  assert.equal(await blob.text(), 'abcdef');
  assert.equal(sink.bytes, 6);
  assert.equal(await (await storage.getFile('s1', 'a.webm')).text(), 'abcdef');
  assert.deepEqual(await storage.listFiles('s1'), [{ name: 'a.webm', size: 6 }]);
  await storage.deleteSession('s1');
  await assert.rejects(storage.getFile('s1', 'a.webm'));
});

/** A fake worker client that records calls and can fail on demand. */
function fakeStorage({ failOnWrite = 0 } = {}) {
  const calls = [];
  const data = [];
  let writes = 0;
  return {
    calls,
    data,
    client: {
      async call(op, args) {
        calls.push(op);
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        if (op === 'open') return { key: 7 };
        if (op === 'write') {
          writes += 1;
          if (writes === failOnWrite) {
            const err = new Error('full');
            err.name = 'QuotaExceededError';
            throw err;
          }
          data.push(new TextDecoder().decode(args.buffer));
        }
        return null;
      },
    },
    async getFile() {
      return new Blob(data);
    },
  };
}

test('worker sink writes sequentially after opening', async () => {
  const storage = fakeStorage();
  const sink = new WorkerSink(storage, 's', 'a.webm');
  for (const s of ['1', '2', '3', '4']) sink.write(new Blob([s]));
  const file = await sink.close();
  assert.equal(await file.text(), '1234');
  assert.deepEqual(storage.calls, ['open', 'write', 'write', 'write', 'write', 'close']);
});

test('worker sink stops after the first write error and reports it once', async () => {
  const storage = fakeStorage({ failOnWrite: 2 });
  const sink = new WorkerSink(storage, 's', 'a.webm');
  const errors = [];
  sink.onError = (e) => errors.push(e.name);
  for (const s of ['1', '2', '3']) sink.write(new Blob([s]));
  const file = await sink.close();
  assert.deepEqual(errors, ['QuotaExceededError']);
  assert.equal(await file.text(), '1', 'what was written before the error is kept');
  assert.equal(storage.calls.filter((c) => c === 'write').length, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, encodeId, encodeSize, fixDuration, patchWebmDuration, readElement, readWebmDuration } from '../src/webm-duration.js';

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
};
const el = (id, payload) => concat(encodeId(id), encodeSize(payload.length), payload);
const uint = (n, len) => {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return out;
};
const ascii = (s) => new TextEncoder().encode(s);
const UNKNOWN = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

/** A MediaRecorder-like WebM: unknown-size Segment, Info without Duration, Tracks, one Cluster. */
function makeWebm({ withDuration = false, seekHead = false, scale = 1_000_000 } = {}) {
  const header = el(IDS.EBML, concat(el(0x4282, ascii('webm'))));
  const infoChildren = [el(IDS.TimecodeScale, uint(scale, 3)), el(0x4d80, ascii('Chrome')), el(0x5741, ascii('Chrome'))];
  if (withDuration) {
    const d = new Uint8Array(8);
    new DataView(d.buffer).setFloat64(0, 0);
    infoChildren.push(el(IDS.Duration, d));
  }
  const info = el(IDS.Info, concat(...infoChildren));
  const tracks = el(IDS.Tracks, concat(el(0xae, concat(el(0xd7, uint(1, 1)), el(0x86, ascii('V_VP9'))))));
  const cluster = el(IDS.Cluster, concat(el(0xe7, uint(0, 1)), el(0xa3, Uint8Array.of(0x81, 0, 0, 0x80, 1, 2, 3, 4, 5))));
  const seek = seekHead ? [el(IDS.SeekHead, el(0x4dbb, concat(el(0x53ab, encodeId(IDS.Info)), el(0x53ac, uint(42, 2)))))] : [];
  return { bytes: concat(header, encodeId(IDS.Segment), UNKNOWN, ...seek, info, tracks, cluster), tracks, cluster };
}

const apply = (bytes, result) => concat(result.header, bytes.subarray(result.replacedLength));

test('adds a Duration to a header without one', () => {
  const { bytes, tracks, cluster } = makeWebm();
  assert.equal(readWebmDuration(bytes), null);
  const result = patchWebmDuration(bytes, 12_345);
  assert.ok(result);
  const out = apply(bytes, result);
  assert.equal(readWebmDuration(out), 12_345);
  // Everything after Info is byte-for-byte unchanged.
  const tail = concat(tracks, cluster);
  assert.deepEqual(out.subarray(out.length - tail.length), tail);
});

test('respects a non-default TimecodeScale', () => {
  const { bytes } = makeWebm({ scale: 500_000 });
  const out = apply(bytes, patchWebmDuration(bytes, 9_000));
  assert.equal(readWebmDuration(out), 9_000);
});

test('overwrites an existing Duration in place', () => {
  const { bytes } = makeWebm({ withDuration: true });
  const result = patchWebmDuration(bytes, 61_000);
  assert.equal(result.header.length, result.replacedLength);
  assert.equal(readWebmDuration(apply(bytes, result)), 61_000);
});

test('turns a SeekHead into a Void of the same length', () => {
  const { bytes } = makeWebm({ seekHead: true });
  const out = apply(bytes, patchWebmDuration(bytes, 5_000));
  assert.equal(readWebmDuration(out), 5_000);
  const ebml = readElement(out, 0);
  const segment = readElement(out, ebml.end);
  const first = readElement(out, segment.dataStart);
  assert.equal(first.id, IDS.Void);
});

test('returns null for data that is not WebM or is truncated', () => {
  assert.equal(patchWebmDuration(ascii('not a video at all'), 1000), null);
  const { bytes } = makeWebm();
  assert.equal(patchWebmDuration(bytes.subarray(0, 30), 1000), null);
});

test('fixDuration works on Blobs and leaves unpatchable ones alone', async () => {
  const { bytes } = makeWebm();
  const blob = new Blob([bytes], { type: 'video/webm' });
  const fixed = await fixDuration(blob, 3_000);
  assert.equal(fixed.type, 'video/webm');
  assert.equal(readWebmDuration(new Uint8Array(await fixed.arrayBuffer())), 3_000);

  const mp4 = new Blob([ascii('....ftypisom')], { type: 'video/mp4' });
  assert.equal(await fixDuration(mp4, 3_000), mp4);
  assert.equal(await fixDuration(blob, 0), blob);
});

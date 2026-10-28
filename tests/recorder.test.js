import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureVideoConstraints,
  candidateList,
  extensionForMime,
  formatLabel,
  needsDurationFix,
  pickMimeType,
  resolveQuality,
  scaledBitrate,
  sizePerMinuteBytes,
  suggestedCustomBitrateMbps,
  supportedFormats,
  videoBitrateFor,
} from '../src/recorder.js';

const chrome = (m) =>
  /^video\/webm(;codecs=(vp9|vp8)(,opus)?)?$/.test(m) ||
  /^video\/mp4(;codecs=avc1(,opus)?)?$/.test(m) ||
  /^video\/x-matroska;codecs=avc1(,opus)?$/.test(m);
const firefox = (m) => /^video\/webm(;codecs=(vp9|vp8)(,opus)?)?$/.test(m);
const safari = (m) => /^video\/mp4(;codecs=avc1(,mp4a\.40\.2)?)?$/.test(m);

test('automatic prefers WebM VP9 + Opus, then VP8, then MP4', () => {
  assert.equal(pickMimeType('auto', true, chrome), 'video/webm;codecs=vp9,opus');
  assert.equal(pickMimeType('auto', true, (m) => m.includes('vp8') || m === 'video/mp4'), 'video/webm;codecs=vp8,opus');
  assert.equal(pickMimeType('auto', true, safari), 'video/mp4;codecs=avc1,mp4a.40.2');
  assert.equal(pickMimeType('auto', true, () => false), '', 'falls back to the browser default');
});

test('video-only recordings prefer codec strings without audio', () => {
  assert.equal(pickMimeType('auto', false, chrome), 'video/webm;codecs=vp9');
  assert.ok(candidateList('auto', false).indexOf('video/webm;codecs=vp9') < candidateList('auto', false).indexOf('video/webm;codecs=vp9,opus'));
});

test('explicit formats never fall back to another container', () => {
  assert.equal(pickMimeType('mkv', true, chrome), 'video/x-matroska;codecs=avc1,opus');
  assert.equal(pickMimeType('mkv', true, firefox), null);
  assert.equal(pickMimeType('mp4', true, firefox), null);
  assert.equal(pickMimeType('webm', true, safari), null);
});

test('supported formats per browser', () => {
  assert.deepEqual(supportedFormats(chrome), ['webm', 'mp4', 'mkv']);
  assert.deepEqual(supportedFormats(firefox), ['webm']);
  assert.deepEqual(supportedFormats(safari), ['mp4']);
  assert.deepEqual(supportedFormats(() => { throw new Error('x'); }), []);
});

test('extension always matches the container', () => {
  assert.equal(extensionForMime('video/webm;codecs=vp9,opus'), 'webm');
  assert.equal(extensionForMime('video/x-matroska;codecs=avc1'), 'mkv');
  assert.equal(extensionForMime('video/mp4'), 'mp4');
  assert.equal(extensionForMime(''), 'bin');
  assert.equal(needsDurationFix('video/x-matroska;codecs=avc1'), true);
  assert.equal(needsDurationFix('video/webm'), true);
  assert.equal(needsDurationFix('video/mp4'), false);
  assert.equal(formatLabel('video/x-matroska;codecs=avc1,opus'), 'MKV · H.264');
  assert.equal(formatLabel('video/webm;codecs=vp9,opus'), 'WEBM · VP9');
});

test('presets map to capture constraints', () => {
  const std = resolveQuality({ quality: 'standard' });
  assert.deepEqual(captureVideoConstraints(std), { frameRate: { ideal: 30, max: 30 }, height: { max: 1080 }, width: { max: 1920 } });
  const high = resolveQuality({ quality: 'high' });
  assert.equal(high.fps, 60);
  assert.equal(captureVideoConstraints(high).height.max, 2160);
  const native = resolveQuality({ quality: 'custom', customResolution: 'native', customFps: 15, customBitrateMbps: 5 });
  assert.equal(captureVideoConstraints(native).height, undefined);
  assert.equal(native.fixedBitrate, 5e6);
});

test('bitrates scale with delivered size and are clamped', () => {
  assert.equal(videoBitrateFor({ quality: 'standard' }, null), 8e6);
  assert.equal(videoBitrateFor({ quality: 'standard' }, { width: 1920, height: 1080, frameRate: 30 }), 8e6);
  assert.equal(videoBitrateFor({ quality: 'standard' }, { width: 1280, height: 720, frameRate: 30 }), Math.round(8e6 * (1280 * 720) / (1920 * 1080)));
  assert.equal(videoBitrateFor({ quality: 'low' }, null), 3e6);
  assert.equal(videoBitrateFor({ quality: 'high' }, { width: 3840, height: 2160, frameRate: 60 }), 40e6);
  assert.equal(scaledBitrate(8e6, { w: 1920, h: 1080, fps: 30 }, 100, 100, 5), 1e6);
  assert.equal(videoBitrateFor({ quality: 'custom', customResolution: '1080', customFps: 30, customBitrateMbps: 12 }, { width: 1920, height: 1080 }), 12e6);
});

test('custom bitrate suggestions and size estimates', () => {
  assert.equal(suggestedCustomBitrateMbps('1080', 30), 8);
  assert.equal(suggestedCustomBitrateMbps('1080', 60), 16);
  assert.equal(suggestedCustomBitrateMbps('720', 30), 3.5);
  assert.equal(sizePerMinuteBytes(8e6), 60e6);
});

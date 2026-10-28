import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, sanitizeSettings, saveSettings } from '../src/settings.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

test('missing or broken storage gives defaults', () => {
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
  const s = memoryStorage();
  s.setItem(SETTINGS_KEY, '{not json');
  assert.deepEqual(loadSettings(s), DEFAULT_SETTINGS);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadSettings(throwing), DEFAULT_SETTINGS);
  assert.equal(saveSettings(DEFAULT_SETTINGS, throwing), false);
});

test('save and load round trip', () => {
  const s = memoryStorage();
  const custom = { ...DEFAULT_SETTINGS, quality: 'high', format: 'mkv', splitSeconds: 300, overlayEnabled: true, overlayCorner: 'top-left', micEnabled: true, micDeviceId: 'abc' };
  assert.equal(saveSettings(custom, s), true);
  assert.deepEqual(loadSettings(s), custom);
});

test('sanitize rejects bad values and clamps numbers', () => {
  const s = sanitizeSettings({
    quality: 'ultra',
    format: 'avi',
    customFps: 45,
    customBitrateMbps: 99,
    splitSeconds: 3,
    overlayEnabled: 'yes',
    overlayCorner: 'middle',
  });
  assert.equal(s.quality, 'standard');
  assert.equal(s.format, 'auto');
  assert.equal(s.customFps, 30);
  assert.equal(s.customBitrateMbps, 40);
  assert.equal(s.splitSeconds, 10);
  assert.equal(s.overlayEnabled, false);
  assert.equal(s.overlayCorner, 'bottom-right');
  assert.equal(sanitizeSettings({ splitSeconds: 99999 }).splitSeconds, 3600);
  assert.equal(sanitizeSettings({ splitSeconds: 0 }).splitSeconds, 0);
  assert.equal(sanitizeSettings({ customBitrateMbps: 7.3 }).customBitrateMbps, 7.5);
});

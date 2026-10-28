// User preferences, remembered between visits in localStorage.
// Recordings are never stored here.

export const SETTINGS_KEY = 'screen-recorder.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'standard',
  customResolution: '1080',
  customFps: 30,
  customBitrateMbps: 8,
  format: 'auto',
  splitSeconds: 0,
  splitDelivery: 'keep',
  overlayEnabled: false,
  overlayCorner: 'bottom-right',
  overlayFormat: 'elapsed',
  overlayRestartEachFile: false,
  hidePreview: false,
  micEnabled: false,
  micDeviceId: '',
  systemAudio: false,
});

const ENUMS = {
  quality: ['low', 'standard', 'high', 'custom'],
  customResolution: ['720', '1080', '1440', 'native'],
  format: ['auto', 'webm', 'mp4', 'mkv'],
  splitDelivery: ['keep', 'download'],
  overlayCorner: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  overlayFormat: ['elapsed', 'clock', 'both'],
};
const FPS_OPTIONS = [15, 30, 60];
const BOOLEANS = ['overlayEnabled', 'overlayRestartEachFile', 'hidePreview', 'micEnabled', 'systemAudio'];

export const SPLIT_MIN_SECONDS = 10;
export const SPLIT_MAX_SECONDS = 3600;
export const BITRATE_MIN_MBPS = 1;
export const BITRATE_MAX_MBPS = 40;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SETTINGS };

  for (const [key, allowed] of Object.entries(ENUMS)) {
    const v = src[key] === undefined ? undefined : String(src[key]);
    if (allowed.includes(v)) out[key] = v;
  }
  for (const key of BOOLEANS) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }

  const fps = Number(src.customFps);
  if (FPS_OPTIONS.includes(fps)) out.customFps = fps;

  const mbps = Number(src.customBitrateMbps);
  if (Number.isFinite(mbps)) {
    out.customBitrateMbps = Math.round(clamp(mbps, BITRATE_MIN_MBPS, BITRATE_MAX_MBPS) * 2) / 2;
  }

  const split = Number(src.splitSeconds);
  if (Number.isFinite(split) && split > 0) {
    out.splitSeconds = Math.round(clamp(split, SPLIT_MIN_SECONDS, SPLIT_MAX_SECONDS));
  } else {
    out.splitSeconds = 0;
  }

  if (typeof src.micDeviceId === 'string' && src.micDeviceId.length <= 512) {
    out.micDeviceId = src.micDeviceId;
  }
  return out;
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access can throw when storage is blocked
  }
}

export function loadSettings(storage) {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    const raw = store?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings, storage) {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (!store) return false;
    store.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

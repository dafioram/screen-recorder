// Display and microphone acquisition, error descriptions and cleanup.
import { captureVideoConstraints } from './recorder.js';

export function checkSupport() {
  if (globalThis.__recorderUnsupported) return { ok: false, reason: globalThis.__recorderUnsupported };
  if (!globalThis.isSecureContext) {
    return { ok: false, reason: 'Screen capture needs a secure page. Open this app over https, or from http://localhost.' };
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return { ok: false, reason: 'This browser can’t capture the screen. Use a current desktop version of Chrome, Edge, Firefox or Safari.' };
  }
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, reason: 'This browser can’t record video (MediaRecorder is missing).' };
  }
  return { ok: true };
}

/**
 * Opens the browser's sharing picker. Must be called directly from a click handler.
 * Capture hints are suggestions; the user's choice in the picker is authoritative.
 */
export async function acquireDisplay({ quality, systemAudio }) {
  const options = {
    video: captureVideoConstraints(quality),
    audio: systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: systemAudio ? 'include' : 'exclude',
  };
  let controller = null;
  if (typeof CaptureController === 'function') {
    try {
      controller = new CaptureController();
      options.controller = controller;
    } catch {
      controller = null;
    }
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (err) {
    // Some browsers reject constraint shapes they don't know; retry with the basics.
    if (err?.name !== 'TypeError' && err?.name !== 'OverconstrainedError') throw err;
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: !!systemAudio });
  }

  // Keep focus here so the user can press Record. Must run right after capture starts.
  try {
    controller?.setFocusBehavior?.('no-focus-change');
  } catch {
    /* not supported for this surface */
  }
  return stream;
}

/** cancelled | denied-system | no-source | unreadable | error */
export function classifyDisplayError(err) {
  const name = err?.name;
  if (name === 'NotAllowedError') return /system/i.test(err?.message || '') ? 'denied-system' : 'cancelled';
  if (name === 'AbortError') return 'cancelled';
  if (name === 'NotFoundError') return 'no-source';
  if (name === 'NotReadableError') return 'unreadable';
  return 'error';
}

export function describeDisplayError(err) {
  switch (classifyDisplayError(err)) {
    case 'denied-system':
      return 'Your operating system blocked screen capture, and screen access is required to record. On macOS, allow your browser under System Settings → Privacy & Security → Screen & System Audio Recording, then restart the browser.';
    case 'no-source':
      return 'No screens, windows or tabs were available to share.';
    case 'unreadable':
      return 'The selected source couldn’t be captured. Another app may be using it, or the system blocked it.';
    default:
      return `Screen capture failed: ${err?.message || err?.name || 'unknown error'}.`;
  }
}

export async function acquireMic(deviceId) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    if (deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
      delete audio.deviceId; // the saved device is gone; use the default one
      return navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
    throw err;
  }
}

export function describeMicError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Microphone access was blocked. Allow it in your browser’s site settings and retry, or record without the microphone.';
    case 'NotFoundError':
      return 'No microphone was found. Connect one and retry, or record without it.';
    case 'NotReadableError':
      return 'The microphone couldn’t be opened. Another app may be using it.';
    default:
      return `The microphone couldn’t start: ${err?.message || err?.name || 'unknown error'}.`;
  }
}

/** Audio inputs. Labels are blank until microphone permission has been granted. */
export async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId)
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

export function describeSource(track) {
  const s = track?.getSettings?.() ?? {};
  return {
    surface: s.displaySurface || null,
    width: s.width || 0,
    height: s.height || 0,
    frameRate: s.frameRate || 0,
  };
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  });
}

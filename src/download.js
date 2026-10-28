// Filenames, object URLs and downloads.
import { partLabel } from './segmenter.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** screen-recording-2026-10-22-193000 (local time) */
export function sessionBaseName(date = new Date()) {
  const d = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const t = `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `screen-recording-${d}-${t}`;
}

export function fileNameFor(base, part, extension, split) {
  return split ? `${base}-${partLabel(part)}.${extension}` : `${base}.${extension}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

/**
 * Hands a Blob or File to the browser as a download. The URL is revoked after a
 * delay, because revoking at once can cancel the download.
 */
export function triggerDownload(blob, filename, revokeAfterMs = 60_000) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

/** Keeps at most one object URL per key and revokes replaced ones. */
export class UrlRegistry {
  constructor(api = globalThis.URL) {
    this.api = api;
    this.urls = new Map();
  }

  set(key, blob) {
    this.revoke(key);
    const url = this.api.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }

  get(key) {
    return this.urls.get(key) ?? null;
  }

  revoke(key) {
    const url = this.urls.get(key);
    if (url) {
      this.api.revokeObjectURL(url);
      this.urls.delete(key);
    }
  }

  revokeAll() {
    for (const key of [...this.urls.keys()]) this.revoke(key);
  }
}

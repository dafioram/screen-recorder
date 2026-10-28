// Quality, format negotiation and the MediaRecorder lifecycle for one output file.

export const AUDIO_BITRATE = 128_000;
export const MIN_VIDEO_BITRATE = 1_000_000;
export const MAX_VIDEO_BITRATE = 40_000_000;
export const TIMESLICE_MS = 1000;

export const QUALITY_PRESETS = Object.freeze({
  low: { label: 'Low', heightCap: 720, fps: 30, refBitrate: 3_000_000, ref: { w: 1280, h: 720, fps: 30 } },
  standard: { label: 'Standard', heightCap: 1080, fps: 30, refBitrate: 8_000_000, ref: { w: 1920, h: 1080, fps: 30 } },
  high: { label: 'High', heightCap: 2160, fps: 60, refBitrate: 16_000_000, ref: { w: 1920, h: 1080, fps: 60 } },
});

// Bits per pixel per frame of the Standard preset, used to suggest custom bitrates.
const STANDARD_DENSITY = 8_000_000 / (1920 * 1080 * 30);
const NOMINAL_SIZES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], native: [2560, 1440] };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** The capture targets and bitrate rule for the current settings. */
export function resolveQuality(settings) {
  if (settings?.quality === 'custom') {
    const res = settings.customResolution;
    return {
      heightCap: res === 'native' ? null : Number(res),
      fps: Number(settings.customFps) || 30,
      fixedBitrate: clamp(Number(settings.customBitrateMbps) * 1e6 || 8e6, MIN_VIDEO_BITRATE, MAX_VIDEO_BITRATE),
    };
  }
  const p = QUALITY_PRESETS[settings?.quality] ?? QUALITY_PRESETS.standard;
  return { heightCap: p.heightCap, fps: p.fps, refBitrate: p.refBitrate, ref: p.ref };
}

/** Video constraints for getDisplayMedia(). Targets only: the browser may deliver less. */
export function captureVideoConstraints(quality) {
  const video = { frameRate: { ideal: quality.fps, max: quality.fps } };
  if (quality.heightCap) {
    video.height = { max: quality.heightCap };
    video.width = { max: Math.round((quality.heightCap * 16) / 9) };
  }
  return video;
}

export function scaledBitrate(refBitrate, ref, width, height, fps) {
  const ratio = (width * height * fps) / (ref.w * ref.h * ref.fps);
  return Math.round(clamp(refBitrate * ratio, MIN_VIDEO_BITRATE, MAX_VIDEO_BITRATE));
}

/** Video bitrate for the settings, scaled to what the source actually delivers. */
export function videoBitrateFor(settings, delivered) {
  const q = resolveQuality(settings);
  if (q.fixedBitrate) return Math.round(q.fixedBitrate);
  const width = delivered?.width || q.ref.w;
  const height = delivered?.height || q.ref.h;
  const fps = Math.min(delivered?.frameRate || q.fps, q.fps);
  return scaledBitrate(q.refBitrate, q.ref, width, height, fps);
}

/** Starting value for the custom bitrate slider, in Mbps (0.5 steps). */
export function suggestedCustomBitrateMbps(resolution, fps) {
  const [w, h] = NOMINAL_SIZES[resolution] ?? NOMINAL_SIZES[1080];
  const bps = STANDARD_DENSITY * w * h * (Number(fps) || 30);
  return Math.round(clamp(bps / 1e6, 1, 40) * 2) / 2;
}

export function sizePerMinuteBytes(bitsPerSecond) {
  return (bitsPerSecond * 60) / 8;
}

// ---------- Formats ----------

export const MIME_CANDIDATES = Object.freeze({
  webm: [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ],
  mp4: [
    'video/mp4;codecs=avc1,opus',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ],
  mkv: ['video/x-matroska;codecs=avc1,opus', 'video/x-matroska;codecs=avc1'],
});

const hasAudioCodec = (mime) => /opus|mp4a/i.test(mime);

function safeSupported(isTypeSupported, mime) {
  try {
    return !!isTypeSupported(mime);
  } catch {
    return false;
  }
}

/** Candidate MIME types in preference order. Automatic tries WebM, then MP4. */
export function candidateList(format, hasAudio) {
  const containers = format === 'auto' || !MIME_CANDIDATES[format] ? ['webm', 'mp4'] : [format];
  const list = containers.flatMap((c) => MIME_CANDIDATES[c]);
  if (hasAudio) return list;
  // Without audio, prefer video-only codec strings, keeping container order.
  return [...list.filter((m) => !hasAudioCodec(m)), ...list.filter(hasAudioCodec)];
}

/**
 * Returns the MIME type to request.
 * '' means "let the browser choose" (Automatic only); null means the chosen format is unsupported.
 */
export function pickMimeType(format, hasAudio, isTypeSupported) {
  for (const mime of candidateList(format, hasAudio)) {
    if (safeSupported(isTypeSupported, mime)) return mime;
  }
  return format === 'auto' ? '' : null;
}

/** Containers this browser can record, for the format picker. */
export function supportedFormats(isTypeSupported) {
  return Object.keys(MIME_CANDIDATES).filter((c) =>
    MIME_CANDIDATES[c].some((m) => safeSupported(isTypeSupported, m)),
  );
}

export function containerOf(mime) {
  if (!mime) return null;
  if (/webm/i.test(mime)) return 'webm';
  if (/matroska/i.test(mime)) return 'mkv';
  if (/mp4/i.test(mime)) return 'mp4';
  return null;
}

export function extensionForMime(mime) {
  return containerOf(mime) ?? 'bin';
}

/** WebM and MKV (both Matroska) need the duration header patched after recording. */
export function needsDurationFix(mime) {
  const c = containerOf(mime);
  return c === 'webm' || c === 'mkv';
}

export function baseMime(mime) {
  return (mime || '').split(';')[0].trim();
}

export function formatLabel(mime) {
  const c = containerOf(mime);
  if (!c) return 'Video';
  const codecs = /codecs=([^;]+)/i.exec(mime || '')?.[1];
  const video = codecs?.split(',')[0]?.trim();
  const name = { vp9: 'VP9', vp8: 'VP8', avc1: 'H.264' }[video?.split('.')[0]?.toLowerCase()];
  return name ? `${c.toUpperCase()} · ${name}` : c.toUpperCase();
}

export function pauseSupported() {
  return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.prototype.pause === 'function';
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One MediaRecorder producing one standalone file. Chunks are buffered until a
 * sink is attached, then forwarded to it as they arrive.
 */
export class FileRecorder {
  constructor(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond, timeslice = TIMESLICE_MS, onError } = {}) {
    const options = {};
    if (mimeType) options.mimeType = mimeType;
    if (videoBitsPerSecond) options.videoBitsPerSecond = videoBitsPerSecond;
    if (audioBitsPerSecond && stream.getAudioTracks().length) options.audioBitsPerSecond = audioBitsPerSecond;

    this.requestedMime = mimeType || '';
    this.timeslice = timeslice;
    this.recorder = new MediaRecorder(stream, options);
    this._buffer = [];
    this._sink = null;

    this.recorder.addEventListener('dataavailable', (event) => {
      if (!event.data || !event.data.size) return;
      if (this._sink) this._sink.write(event.data);
      else this._buffer.push(event.data);
    });
    this.recorder.addEventListener('error', (event) => onError?.(event.error || event));
    this.stopped = new Promise((resolve) => this.recorder.addEventListener('stop', resolve, { once: true }));
  }

  get mimeType() {
    return this.recorder.mimeType || this.requestedMime;
  }

  get state() {
    return this.recorder.state;
  }

  start() {
    this.recorder.start(this.timeslice);
  }

  attach(sink) {
    this._sink = sink;
    for (const chunk of this._buffer) sink.write(chunk);
    this._buffer = [];
  }

  pause() {
    if (this.recorder.state === 'recording') this.recorder.pause();
  }

  resume() {
    if (this.recorder.state === 'paused') this.recorder.resume();
  }

  /** Stops and waits for the final dataavailable and stop events (with a safety timeout). */
  async stop() {
    if (this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* already stopping */
      }
    }
    await Promise.race([this.stopped, delay(8000)]);
  }
}

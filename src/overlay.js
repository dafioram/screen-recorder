// Timer overlay: burns a running time count into a corner of the video.
// Preferred path: frames are read, drawn and re-emitted inside a worker
// (MediaStreamTrackProcessor + MediaStreamTrackGenerator, Chromium).
// Fallback: a hidden <video> drawn to a canvas exposed with captureStream(),
// with draws driven by worker ticks because requestAnimationFrame stops in hidden tabs.
import { overlayText, elapsedFromSnapshot, nowAbs } from './time.js';

/** Draws one composited frame. Shared by the worker and the main-thread fallback. */
export function drawComposite(ctx, source, sourceWidth, sourceHeight, width, height, text, corner) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  if (source && sourceWidth && sourceHeight) {
    // Letterbox so a resized source never changes the encoded size.
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const dw = sourceWidth * scale;
    const dh = sourceHeight * scale;
    ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
  }
  if (!text) return;

  const fontPx = Math.max(14, Math.round(height * 0.03));
  ctx.font = `600 ${fontPx}px ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;
  ctx.textBaseline = 'middle';
  const padX = Math.round(fontPx * 0.6);
  const padY = Math.round(fontPx * 0.35);
  const boxW = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const boxH = fontPx + padY * 2;
  const inset = Math.round(width * 0.02);
  const x = corner.endsWith('left') ? inset : width - inset - boxW;
  const y = corner.startsWith('top') ? inset : height - inset - boxH;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, boxW, boxH, boxH / 2);
  else ctx.rect(x, y, boxW, boxH);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + padX, y + boxH / 2);
}

export function overlayLabel(state, now = nowAbs(), date = new Date()) {
  const elapsed = Math.max(0, elapsedFromSnapshot(state.timer, now) - (state.fileOffset || 0));
  return overlayText(state.format, elapsed, date);
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function canComposite() {
  const breakout = 'MediaStreamTrackProcessor' in globalThis && 'MediaStreamTrackGenerator' in globalThis;
  const canvas = typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  return { breakout, canvas, any: breakout || canvas };
}

export class OverlayCompositor {
  /**
   * @param {MediaStreamTrack} track  the display video track
   * @param {{fps:number, corner:string, format:string, onStats?:Function}} options
   */
  constructor(track, { fps, corner, format, onStats }) {
    this.track = track;
    this.fps = fps;
    this.onStats = onStats;
    this.state = { corner, format, timer: { accumulated: 0, runningSince: null }, fileOffset: 0 };
    this.mode = null;
    this.output = null;
    this.worker = null;
  }

  async start() {
    const s = this.track.getSettings?.() ?? {};
    this.width = even(s.width || 1920);
    this.height = even(s.height || 1080);

    this.worker = new Worker(new URL('./overlay.worker.js', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (e) => this._onWorkerMessage(e.data));
    this.worker.addEventListener('error', (e) => {
      e.preventDefault?.();
      this.onStats?.({ error: true });
    });

    const support = canComposite();
    if (support.breakout) {
      try {
        this._startBreakout();
      } catch {
        this.output = null;
      }
    }
    if (!this.output && support.canvas) await this._startCanvas();
    if (!this.output) throw new Error('No compositor is available in this browser');
    try {
      this.output.contentHint = 'detail';
    } catch {
      /* hint not supported */
    }
    return this.output;
  }

  _startBreakout() {
    /* global MediaStreamTrackProcessor, MediaStreamTrackGenerator */
    const processor = new MediaStreamTrackProcessor({ track: this.track });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.worker.postMessage(
      {
        type: 'composite-start',
        readable: processor.readable,
        writable: generator.writable,
        width: this.width,
        height: this.height,
        fps: this.fps,
        state: this.state,
      },
      [processor.readable, generator.writable],
    );
    this.mode = 'worker';
    this.output = generator;
  }

  async _startCanvas() {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([this.track]);
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.frames = 0;
    this.output = canvas.captureStream(this.fps).getVideoTracks()[0];
    this.mode = 'canvas';
    this._render();
    this.worker.postMessage({ type: 'tick-start', intervalMs: 1000 / this.fps });
    this.statsTimer = setInterval(() => {
      this.onStats?.({ fps: this.frames, target: this.fps });
      this.frames = 0;
    }, 1000);
  }

  _onWorkerMessage(msg) {
    if (msg?.type === 'tick' && this.mode === 'canvas') this._render();
    else if (msg?.type === 'stats') this.onStats?.({ fps: msg.fps, target: this.fps });
  }

  _render() {
    if (!this.ctx) return;
    const v = this.video;
    drawComposite(this.ctx, v, v.videoWidth, v.videoHeight, this.width, this.height, overlayLabel(this.state), this.state.corner);
    this.frames += 1;
  }

  _update(patch) {
    Object.assign(this.state, patch);
    if (this.mode === 'worker') this.worker?.postMessage({ type: 'composite-update', state: patch });
  }

  /** Timer snapshot from ActiveTimer.snapshot(); fileOffset in ms when the count restarts per file. */
  setTimer(timer, fileOffset = 0) {
    this._update({ timer, fileOffset });
  }

  setStyle({ corner, format }) {
    this._update({ corner, format });
  }

  stop() {
    clearInterval(this.statsTimer);
    try {
      this.worker?.postMessage({ type: this.mode === 'worker' ? 'composite-stop' : 'tick-stop' });
    } catch {
      /* worker gone */
    }
    // Give the worker a moment to release frames before terminating it.
    const worker = this.worker;
    setTimeout(() => worker?.terminate(), 200);
    this.worker = null;
    try {
      this.output?.stop();
    } catch {
      /* already stopped */
    }
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.output = null;
  }
}

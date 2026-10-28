// Initialization and orchestration: wires capture, audio, overlay, recording,
// splitting, storage and recovery to the state machine and the UI.
import { createStore, isBusy, isCapturing } from './state.js';
import { loadSettings, saveSettings, sanitizeSettings } from './settings.js';
import * as capture from './capture.js';
import { AudioMixer } from './audio.js';
import { OverlayCompositor } from './overlay.js';
import {
  AUDIO_BITRATE,
  FileRecorder,
  baseMime,
  captureVideoConstraints,
  extensionForMime,
  needsDurationFix,
  pauseSupported,
  pickMimeType,
  resolveQuality,
  sizePerMinuteBytes,
  suggestedCustomBitrateMbps,
  supportedFormats,
  videoBitrateFor,
} from './recorder.js';
import { SplitSchedule, rollover } from './segmenter.js';
import { createStorage } from './storage.js';
import * as recovery from './recovery.js';
import { fixDuration } from './webm-duration.js';
import { UrlRegistry, fileNameFor, formatBytes, sessionBaseName, triggerDownload } from './download.js';
import { ActiveTimer, formatElapsed, nowAbs } from './time.js';
import { UI } from './ui.js';

const TICK_MS = 250;
const MEMORY_WARN_BYTES = 1024 ** 3;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isTypeSupported = (mime) => {
  try {
    return MediaRecorder.isTypeSupported(mime);
  } catch {
    return false;
  }
};

let store;
let ui;

// Runtime resources (streams, recorders, workers). Application state lives in the store.
const rt = {
  storage: null,
  mixer: new AudioMixer(),
  display: null,
  videoTrack: null,
  recordTrack: null,
  mic: null,
  compositor: null,
  recStream: null,
  timer: null,
  schedule: null,
  session: null,
  files: new Map(), // name -> { part, name, mimeType, blob, size, ... }
  urls: new UrlRegistry(),
  countdownTimer: null,
  rolling: false,
  lastMetaSave: 0,
  stallSeconds: 0,
  memoryWarned: false,
  stopping: false,
  pendingRecovery: [],
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  ui = new UI(handlers);
  const support = capture.checkSupport();
  if (!support.ok) {
    ui.showUnsupported(support.reason);
    return;
  }

  const formats = supportedFormats(isTypeSupported);
  const settings = loadSettings();
  if (settings.format !== 'auto' && !formats.includes(settings.format)) settings.format = 'auto';

  store = createStore({
    settings,
    supportedFormats: formats,
    canPause: pauseSupported(),
    source: null,
    hasSystemAudio: false,
    micActive: false,
    micMuted: false,
    files: [],
    storageKind: 'pending',
  });
  store.subscribe((state, prev) => {
    ui.render(state);
    if (state.settings !== prev.settings || state.source !== prev.source) updateQualityInfo();
    // Recovery is only offered from Ready, so refresh its buttons when that changes.
    if (rt.pendingRecovery.length && (state.status === 'ready') !== (prev.status === 'ready')) renderRecovery();
  });
  ui.render(store.get());
  updateQualityInfo();
  ui.setSelectHint('System audio is mainly available in Chrome and Edge, and sharing a tab is the most reliable way to get it.');
  ui.startMeters(() => ({ mic: rt.mixer.level('mic'), system: rt.mixer.level('system') }));

  startTicker();
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  navigator.mediaDevices.addEventListener?.('devicechange', refreshMics);
  refreshMics();

  rt.storage = await createStorage();
  store.set({ storageKind: rt.storage.kind });
  if (rt.storage.kind === 'memory') {
    ui.notice(
      'storage',
      'info',
      'Browser storage isn’t available here (private browsing can cause this), so recordings are kept in memory until you download them. Long recordings can use a lot of RAM.',
    );
  }
  await checkRecovery();
}

function startTicker() {
  try {
    const worker = new Worker(new URL('./overlay.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e) => {
      if (e.data?.type === 'tick') onTick();
    });
    worker.postMessage({ type: 'tick-start', intervalMs: TICK_MS });
    rt.ticker = worker;
  } catch {
    rt.ticker = setInterval(onTick, TICK_MS);
  }
}

async function refreshMics() {
  const devices = await capture.listMics();
  ui.setMicDevices(devices, store?.get().settings.micDeviceId ?? '');
}

// ---------------------------------------------------------------------------
// Source selection and preview
// ---------------------------------------------------------------------------

async function onSelectSource() {
  const st = store.get();
  if (st.status !== 'ready') return;
  const settings = st.settings;
  // Create the AudioContext inside the click so browsers allow it to run.
  if (settings.micEnabled || settings.systemAudio) rt.mixer.ensureContext();
  store.dispatch('select');
  ui.dismiss('capture');
  ui.dismiss('ended');

  let display;
  try {
    display = await capture.acquireDisplay({ quality: resolveQuality(settings), systemAudio: settings.systemAudio });
  } catch (err) {
    const kind = capture.classifyDisplayError(err);
    store.dispatch(kind === 'cancelled' ? 'cancel' : 'fail');
    if (kind !== 'cancelled') ui.notice('capture', 'error', capture.describeDisplayError(err));
    rt.mixer.close();
    return;
  }

  // The user may have reloaded or navigated mid-picker; make sure we still want it.
  if (store.get().status !== 'selectingSource') {
    capture.stopStream(display);
    return;
  }

  rt.display = display;
  rt.videoTrack = display.getVideoTracks()[0];
  try {
    rt.videoTrack.contentHint = 'detail';
  } catch {
    /* hint unsupported */
  }
  rt.videoTrack.addEventListener('ended', onSourceEnded);

  const sysTrack = display.getAudioTracks()[0] ?? null;
  if (sysTrack) {
    rt.mixer.addSource('system', new MediaStream([sysTrack]));
    sysTrack.addEventListener('ended', () => {
      rt.mixer.removeSource('system');
      store.set({ hasSystemAudio: false });
      if (isCapturing(store.get().status)) ui.notice('sys-lost', 'warning', 'System audio stopped. Recording continues without it.');
    });
  } else if (settings.systemAudio) {
    ui.notice(
      'no-system-audio',
      'warning',
      'No system audio was shared. You can continue without it, or choose the source again and tick “Share audio” in the browser’s dialog (sharing a tab works best).',
      [{ label: 'Choose another source', action: onChangeSource }],
    );
  }

  if (settings.micEnabled) await enableMic();
  await setupVideoPipeline();

  // Sharing may have been stopped from the browser's own bar while we were setting up.
  if (!rt.videoTrack || rt.videoTrack.readyState === 'ended') {
    releaseCapture();
    store.dispatch('cancel');
    return;
  }

  store.dispatch('granted', { source: capture.describeSource(rt.videoTrack), hasSystemAudio: !!sysTrack });
  showLivePreview();
  checkQuota();
}

function onChangeSource() {
  const s = store.get().status;
  if (s !== 'previewing' && s !== 'ready') return;
  if (s === 'previewing') {
    releaseCapture();
    store.dispatch('cancelSource');
  }
  onSelectSource(); // still inside the click, so the picker is allowed to open
}

function onStopSharing() {
  if (store.get().status !== 'previewing') return;
  releaseCapture();
  store.dispatch('cancelSource');
}

async function enableMic() {
  ui.dismiss('mic-error');
  try {
    rt.mixer.ensureContext();
    const stream = await capture.acquireMic(store.get().settings.micDeviceId);
    // The session may have ended while the permission prompt was open.
    if (!rt.display) {
      capture.stopStream(stream);
      return;
    }
    releaseMic();
    rt.mic = stream;
    rt.mixer.addSource('mic', stream);
    const track = stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => {
      if (rt.mic !== stream) return;
      rt.mixer.removeSource('mic');
      store.set({ micActive: false });
      ui.notice('mic-lost', 'warning', 'The microphone was disconnected. Recording continues without it.');
    });
    store.set({ micActive: true, micMuted: false });
    refreshMics(); // labels become available after the first grant
  } catch (err) {
    store.set({ micActive: false });
    ui.notice('mic-error', 'warning', capture.describeMicError(err), [
      { label: 'Retry', action: enableMic },
      { label: 'Continue without microphone', action: () => {} },
    ]);
  }
}

function releaseMic() {
  rt.mixer.removeSource('mic');
  capture.stopStream(rt.mic);
  rt.mic = null;
  if (store.get().micActive) store.set({ micActive: false, micMuted: false });
}

function onToggleMute() {
  const st = store.get();
  if (!st.micActive) return;
  const muted = !st.micMuted;
  rt.mixer.setMuted('mic', muted);
  store.set({ micMuted: muted });
}

async function setupVideoPipeline() {
  stopCompositor();
  const s = store.get().settings;
  rt.recordTrack = rt.videoTrack;
  if (!s.overlayEnabled || !rt.videoTrack) return;
  try {
    const q = resolveQuality(s);
    const comp = new OverlayCompositor(rt.videoTrack, {
      fps: q.fps,
      corner: s.overlayCorner,
      format: s.overlayFormat,
      onStats: onOverlayStats,
    });
    rt.recordTrack = await comp.start();
    rt.compositor = comp;
    syncOverlayTimer();
  } catch {
    rt.compositor = null;
    rt.recordTrack = rt.videoTrack;
    ui.notice('overlay', 'warning', 'The timer overlay couldn’t start in this browser, so the video will be recorded without it.');
  }
}

function stopCompositor() {
  rt.compositor?.stop();
  rt.compositor = null;
}

function showLivePreview() {
  ui.setPreview(rt.recordTrack);
}

function releaseCapture() {
  stopCompositor();
  if (rt.videoTrack) rt.videoTrack.removeEventListener('ended', onSourceEnded);
  capture.stopStream(rt.display);
  releaseMic();
  rt.mixer.close();
  rt.display = null;
  rt.videoTrack = null;
  rt.recordTrack = null;
  rt.recStream = null;
  ui.setPreview(null);
  store.set({ source: null, hasSystemAudio: false, micActive: false, micMuted: false });
}

function onSourceEnded() {
  const s = store.get().status;
  if (s === 'previewing') {
    releaseCapture();
    store.dispatch('sourceEnded');
    ui.notice('ended', 'info', 'Sharing stopped.');
  } else if (s === 'countdown') {
    clearCountdown();
    releaseCapture();
    store.dispatch('sourceEnded');
    ui.notice('ended', 'info', 'Sharing stopped before recording started.');
  } else if (isCapturing(s)) {
    ui.notice('ended', 'warning', 'Sharing ended, so the recording was stopped and saved.');
    finalizeSession('sourceEnded');
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function onSettingsChange(patch) {
  const st = store.get();
  if (isBusy(st.status)) return;
  const prev = st.settings;
  const merged = { ...prev, ...patch };
  if ('customResolution' in patch || 'customFps' in patch || (patch.quality === 'custom' && prev.quality !== 'custom')) {
    merged.customBitrateMbps = suggestedCustomBitrateMbps(merged.customResolution, merged.customFps);
  }
  const settings = sanitizeSettings(merged);
  store.set({ settings });
  saveSettings(settings);
  if (st.status === 'previewing') applyLiveChanges(prev, settings);
}

async function applyLiveChanges(prev, next) {
  const qualityChanged = ['quality', 'customResolution', 'customFps'].some((k) => prev[k] !== next[k]);
  const overlayToggled = prev.overlayEnabled !== next.overlayEnabled;
  const styleChanged = prev.overlayCorner !== next.overlayCorner || prev.overlayFormat !== next.overlayFormat;

  if (qualityChanged && rt.videoTrack) {
    try {
      await rt.videoTrack.applyConstraints(captureVideoConstraints(resolveQuality(next)));
      store.set({ source: capture.describeSource(rt.videoTrack) });
    } catch {
      ui.notice('quality', 'warning', 'The new quality couldn’t be applied to this source. Choose the source again to use it.', [
        { label: 'Choose source again', action: onChangeSource },
      ]);
    }
  }
  if (overlayToggled || (qualityChanged && next.overlayEnabled)) {
    await setupVideoPipeline();
    showLivePreview();
  } else if (styleChanged) {
    rt.compositor?.setStyle({ corner: next.overlayCorner, format: next.overlayFormat });
  }

  if (prev.micEnabled !== next.micEnabled) {
    if (next.micEnabled) await enableMic();
    else {
      releaseMic();
      ui.dismiss('mic-error');
    }
  } else if (prev.micDeviceId !== next.micDeviceId && next.micEnabled) {
    await enableMic();
  }

  if (prev.systemAudio !== next.systemAudio) {
    ui.notice('sys-change', 'info', 'The system audio setting applies the next time you choose a source.', [
      { label: 'Choose source again', action: onChangeSource },
    ]);
  }
  if (qualityChanged) checkQuota();
}

function wouldRecordAudio() {
  const st = store.get();
  if (st.status === 'previewing') return rt.mixer.hasSources;
  return st.settings.micEnabled || st.settings.systemAudio;
}

function currentBitrate() {
  const st = store.get();
  return videoBitrateFor(st.settings, st.source) + (wouldRecordAudio() ? AUDIO_BITRATE : 0);
}

function updateQualityInfo() {
  if (!store) return;
  const st = store.get();
  const bps = currentBitrate();
  ui.setEstimate(`About ${formatBytes(sizePerMinuteBytes(bps))} per minute (${(bps / 1e6).toFixed(1)} Mbps).`);
  const src = st.source;
  if (src?.width) {
    const target = resolveQuality(st.settings).fps;
    const fps = Math.round(src.frameRate || 0);
    let text = `Getting ${src.width} × ${src.height}${fps ? ` at ${fps} FPS` : ''}.`;
    const low = fps && fps < target * 0.9;
    if (low) text += ` That’s below the ${target} FPS requested; the browser or source can’t deliver more.`;
    ui.setDelivered(text, low);
  } else {
    ui.setDelivered('');
  }
}

async function checkQuota() {
  if (rt.storage?.kind !== 'opfs') return;
  const est = await rt.storage.estimate();
  if (!est || !est.quota) return;
  const bytesPerSecond = currentBitrate() / 8;
  if (est.free < bytesPerSecond * 3600) {
    const minutes = Math.floor(est.free / bytesPerSecond / 60);
    ui.notice(
      'quota',
      'warning',
      `Free browser storage covers about ${minutes} minute${minutes === 1 ? '' : 's'} at this quality. Lower the quality, free up disk space, or split and download files as you go.`,
    );
  } else {
    ui.dismiss('quota');
  }
}

// ---------------------------------------------------------------------------
// Countdown and recording
// ---------------------------------------------------------------------------

function onRecord() {
  if (store.get().status !== 'previewing') return;
  if (!store.dispatch('record')) return;
  let n = 3;
  ui.showCountdown(n);
  rt.countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) finishCountdown();
    else ui.showCountdown(n);
  }, 1000);
}

function clearCountdown() {
  clearInterval(rt.countdownTimer);
  rt.countdownTimer = null;
  ui.hideCountdown();
}

function finishCountdown() {
  clearCountdown();
  if (store.get().status === 'countdown') startRecording();
}

function onCancelCountdown() {
  if (store.get().status !== 'countdown') return;
  clearCountdown();
  store.dispatch('cancel');
}

function startRecording() {
  const settings = store.get().settings;
  const hasAudio = rt.mixer.hasSources && !!rt.mixer.outputTrack;
  const tracks = [rt.recordTrack];
  if (hasAudio) tracks.push(rt.mixer.outputTrack);
  rt.recStream = new MediaStream(tracks);

  const mime = pickMimeType(settings.format, hasAudio, isTypeSupported);
  if (mime === null) {
    ui.notice('format', 'error', `This browser can’t record ${settings.format.toUpperCase()}. Choose another format.`);
    store.dispatch('cancel');
    return;
  }

  const base = sessionBaseName(new Date());
  rt.timer = new ActiveTimer();
  rt.schedule = new SplitSchedule(settings.splitSeconds);
  rt.session = {
    id: base,
    base,
    split: rt.schedule.enabled,
    delivery: settings.splitDelivery,
    restartOverlay: settings.overlayRestartEachFile,
    requestedMime: mime,
    videoBps: videoBitrateFor(settings, capture.describeSource(rt.videoTrack)),
    meta: recovery.createSessionMeta({ id: base, mimeType: mime, splitSeconds: settings.splitSeconds }),
    current: null,
    finishing: new Set(),
    writeFailed: false,
  };
  rt.files.clear();
  rt.urls.revokeAll();
  rt.stopping = false;
  rt.stallSeconds = 0;
  rt.memoryWarned = false;

  rt.timer.start();
  let first;
  try {
    first = createFile(1);
  } catch (err) {
    rt.session = null;
    rt.timer = null;
    ui.notice('recorder', 'error', `Recording couldn’t start in this browser: ${err?.message || err?.name || 'unknown error'}.`);
    store.dispatch('cancel');
    return;
  }
  rt.session.meta.mimeType = first.mimeType;
  rt.session.meta.extension = first.ext;

  store.dispatch('done');
  syncOverlayTimer();
  if (settings.hidePreview) ui.setPreview(null, true);
  saveMeta();
  publishFiles();
}

/** Creates and starts the recorder for one output file. Throws if it can't start. */
function createFile(part) {
  const ses = rt.session;
  const file = { part, status: 'recording', incomplete: false, downloaded: false, startElapsed: rt.timer.elapsed() };
  const rec = new FileRecorder(rt.recStream, {
    mimeType: ses.requestedMime,
    videoBitsPerSecond: ses.videoBps,
    audioBitsPerSecond: AUDIO_BITRATE,
    onError: (err) => onRecorderError(file, err),
  });
  rec.start();
  file.rec = rec;
  file.mimeType = rec.mimeType || ses.requestedMime;
  file.ext = extensionForMime(file.mimeType);
  file.name = fileNameFor(ses.base, part, file.ext, ses.split);
  file.sink = rt.storage.createSink(ses.id, file.name);
  file.sink.onError = (err) => onWriteError(file, err);
  rec.attach(file.sink);

  ses.current = file;
  rt.files.set(file.name, file);
  recovery.addFile(ses.meta, { name: file.name, part });
  return file;
}

async function finishFile(file, endElapsed) {
  const ses = rt.session;
  file.status = 'finalizing';
  file.durationMs = Math.max(0, endElapsed - file.startElapsed);
  publishFiles();

  await file.rec.stop();
  let blob = null;
  try {
    const stored = await file.sink.close();
    blob = new Blob([stored], { type: baseMime(file.mimeType) }); // references the disk file, no copy
    if (file.sink.error) file.incomplete = true;
  } catch {
    file.incomplete = true;
  }
  if (blob && blob.size && needsDurationFix(file.mimeType)) {
    try {
      blob = await fixDuration(blob, file.durationMs, baseMime(file.mimeType));
    } catch {
      /* keep the unpatched file */
    }
  }
  file.blob = blob && blob.size ? blob : null;
  file.size = blob?.size ?? file.sink.bytes;
  file.status = file.blob ? 'ready' : 'failed';
  file.rec = null;

  recovery.updateFile(ses.meta, file.name, {
    activeMs: file.durationMs,
    finalized: !!file.blob,
    incomplete: file.incomplete,
  });
  saveMeta();
  publishFiles();

  if (file.blob && ses.split && ses.delivery === 'download') await downloadFile(file.name);
}

async function doRollover() {
  const ses = rt.session;
  const old = ses.current;
  if (!old || rt.rolling) return;
  rt.rolling = true;
  const part = rt.schedule.advance();
  const boundary = rt.timer.elapsed();
  try {
    const result = await rollover(
      () => finishFile(old, boundary),
      () => createFile(part),
    );
    if (result.gap) result.next.gapBefore = true;
    const p = result.finishing.catch(() => {});
    ses.finishing.add(p);
    p.finally(() => ses.finishing.delete(p));
    syncOverlayTimer();
    publishFiles();
  } catch (err) {
    ui.notice('rollover', 'error', `Couldn’t start the next file (${err?.message || 'unknown error'}). The recording was stopped.`);
    ses.current = null;
    finalizeSession('stop');
  } finally {
    rt.rolling = false;
  }
}

function onPauseToggle() {
  const s = store.get().status;
  if (s === 'recording') pauseRecording();
  else if (s === 'paused') resumeRecording();
}

function pauseRecording() {
  if (!store.get().canPause) return;
  rt.session?.current?.rec?.pause();
  rt.timer.pause();
  store.dispatch('pause');
  syncOverlayTimer();
  saveMeta();
}

function resumeRecording() {
  rt.session?.current?.rec?.resume();
  rt.timer.resume();
  store.dispatch('resume');
  syncOverlayTimer();
}

function onStop() {
  if (isCapturing(store.get().status)) finalizeSession('stop');
}

async function finalizeSession(event) {
  if (rt.stopping) return;
  rt.stopping = true;
  const ses = rt.session;
  rt.timer.pause();
  const endElapsed = rt.timer.elapsed();
  store.dispatch(event);
  ui.setPreview(null);

  try {
    const last = ses.current;
    ses.current = null;
    const work = [...ses.finishing];
    if (last) work.push(finishFile(last, endElapsed));
    await Promise.allSettled(work);
  } finally {
    releaseCapture();
  }

  ses.meta.status = 'finalized';
  await saveMeta();
  const files = [...rt.files.values()];
  if (!files.some((f) => f.blob)) {
    ui.notice('finalize', 'error', 'The recording couldn’t be saved. Nothing usable was written.', [
      { label: 'Start over', action: resetAfterError },
    ]);
    store.dispatch('fail');
    rt.storage.deleteSession(ses.id).catch(() => {});
    return;
  }
  store.dispatch('finalized');
  const first = files.sort((a, b) => a.part - b.part).find((f) => f.blob);
  if (first) onPlay(first.name);
}

function resetAfterError() {
  rt.files.clear();
  rt.session = null;
  rt.urls.revokeAll();
  publishFiles();
  store.dispatch('reset');
}

function onRecorderError(file, err) {
  file.incomplete = true;
  const ses = rt.session;
  ui.notice('rec-error', 'error', `The recorder reported an error (${err?.name || 'unknown'}). The current file may be incomplete.`);
  if (!ses || file !== ses.current || !isCapturing(store.get().status)) return;
  if (ses.split) doRollover();
  else finalizeSession('stop');
}

function onWriteError(file, err) {
  file.incomplete = true;
  const ses = rt.session;
  if (!ses || ses.writeFailed) return;
  ses.writeFailed = true;
  const full = err?.name === 'QuotaExceededError';
  ui.notice(
    'write',
    'error',
    full
      ? 'Browser storage is full, so the recording was stopped. Everything written before that is kept.'
      : `Saving to disk failed (${err?.message || 'unknown error'}), so the recording was stopped. Everything written before that is kept.`,
  );
  if (isCapturing(store.get().status)) finalizeSession('stop');
}

// ---------------------------------------------------------------------------
// Overlay timing
// ---------------------------------------------------------------------------

function syncOverlayTimer() {
  if (!rt.compositor) return;
  const snapshot = rt.timer ? rt.timer.snapshot() : { accumulated: 0, runningSince: null };
  const ses = rt.session;
  const offset = ses?.restartOverlay && ses.current ? ses.current.startElapsed : 0;
  rt.compositor.setTimer(snapshot, offset);
}

function onOverlayStats(stats) {
  if (stats?.error) {
    ui.notice('overlay', 'warning', 'The timer overlay stopped working. Turn it off if the video looks frozen.');
    return;
  }
  if (!isCapturing(store.get().status) || store.get().status === 'paused') {
    rt.stallSeconds = 0;
    return;
  }
  if (stats.fps < stats.target * 0.5) {
    rt.stallSeconds += 1;
    if (rt.stallSeconds === 3) {
      ui.notice(
        'overlay-stall',
        'warning',
        'The timer overlay is falling behind, so the video may stutter. Keep this tab visible, lower the quality, or record without the overlay.',
        [{ label: 'Stop recording', action: onStop }],
      );
    }
  } else {
    rt.stallSeconds = 0;
  }
}

// ---------------------------------------------------------------------------
// Tick: timer display, split boundaries, metadata and memory checks
// ---------------------------------------------------------------------------

function onTick() {
  if (!store) return;
  const s = store.get().status;
  if (!isCapturing(s) || !rt.timer || !rt.session) return;
  const elapsed = rt.timer.elapsed();
  ui.setTimer(elapsed);

  if (s === 'recording' && rt.schedule.due(elapsed) && !rt.rolling && !rt.stopping) doRollover();

  if (nowAbs() - rt.lastMetaSave >= 1000) saveMeta();

  let bytes = 0;
  for (const f of rt.files.values()) bytes += f.sink?.bytes ?? f.size ?? 0;
  const bits = [];
  if (rt.session.split) {
    bits.push(`File ${rt.schedule.part}`);
    bits.push(`next split in ${formatElapsed(rt.schedule.timeToNextMs(elapsed) + 999)}`);
  }
  bits.push(formatBytes(bytes));
  ui.setRecMeta(bits.join(' · '));

  if (rt.storage.kind === 'memory' && !rt.memoryWarned) {
    let held = 0;
    for (const f of rt.files.values()) if (!f.downloaded) held += f.sink?.bytes ?? f.size ?? 0;
    if (held > MEMORY_WARN_BYTES) {
      rt.memoryWarned = true;
      ui.notice('memory', 'warning', `This recording is holding ${formatBytes(held)} in memory. Stop soon, or use splitting with “Download it right away” next time.`);
    }
  }
}

async function saveMeta() {
  const ses = rt.session;
  rt.lastMetaSave = nowAbs();
  if (!ses?.meta || rt.storage?.kind !== 'opfs') return;
  if (ses.metaSaving) {
    ses.metaDirty = true;
    return;
  }
  ses.metaSaving = true;
  try {
    const cur = ses.current;
    if (cur && rt.timer) {
      recovery.updateFile(ses.meta, cur.name, { activeMs: Math.max(0, rt.timer.elapsed() - cur.startElapsed) });
    }
    await rt.storage.writeText(ses.id, recovery.META_NAME, recovery.serializeMeta(ses.meta));
  } catch {
    /* metadata is best effort */
  } finally {
    ses.metaSaving = false;
    if (ses.metaDirty) {
      ses.metaDirty = false;
      saveMeta();
    }
  }
}

// ---------------------------------------------------------------------------
// Review: play, download, discard
// ---------------------------------------------------------------------------

function publishFiles() {
  const files = [...rt.files.values()]
    .sort((a, b) => a.part - b.part)
    .map((f) => ({
      name: f.name,
      part: f.part,
      status: f.status,
      durationMs: f.durationMs ?? null,
      size: f.size ?? f.sink?.bytes ?? 0,
      mimeType: f.mimeType,
      downloaded: !!f.downloaded,
      incomplete: !!f.incomplete,
      gapBefore: !!f.gapBefore,
    }));
  store.set({ files });
}

function onPlay(name) {
  const f = rt.files.get(name);
  if (!f?.blob) return;
  const url = rt.urls.set('player', f.blob);
  ui.setPlayer(name, url);
}

async function downloadFile(name) {
  const f = rt.files.get(name);
  if (!f?.blob) return false;
  try {
    triggerDownload(f.blob, name);
  } catch {
    ui.notice('download', 'error', `Downloading ${name} failed. It’s still here, so you can try again.`);
    return false;
  }
  f.downloaded = true;
  if (rt.session?.meta) recovery.updateFile(rt.session.meta, name, { downloaded: true });
  saveMeta();
  publishFiles();
  return true;
}

async function onDownloadAll() {
  const pending = [...rt.files.values()].filter((f) => f.blob && !f.downloaded).sort((a, b) => a.part - b.part);
  for (let i = 0; i < pending.length; i += 1) {
    await downloadFile(pending[i].name);
    if (i < pending.length - 1) await delay(400); // spacing helps browsers accept several downloads
  }
}

async function onDiscard(name) {
  const f = rt.files.get(name);
  if (!f) return;
  const ok = await ui.confirm(
    f.downloaded ? `Remove ${name} from this list? Your downloaded copy is not affected.` : `Discard ${name}? It hasn’t been downloaded and can’t be recovered.`,
  );
  if (!ok) return;
  await removeFile(name);
  if (rt.files.size === 0) {
    finishSessionCleanup();
    store.dispatch('discard');
  }
}

async function removeFile(name) {
  const ses = rt.session;
  if (ui.selectedFile === name) {
    rt.urls.revoke('player');
    ui.setPlayer(null, null);
  }
  rt.files.delete(name);
  if (ses?.meta) recovery.updateFile(ses.meta, name, { discarded: true });
  publishFiles();
  if (ses) {
    await rt.storage.deleteFile(ses.id, name).catch(() => {});
    await saveMeta();
  }
}

async function onNewRecording() {
  if (store.get().status !== 'review') return;
  const undownloaded = [...rt.files.values()].filter((f) => f.blob && !f.downloaded);
  if (undownloaded.length) {
    const n = undownloaded.length;
    const ok = await ui.confirm(
      n === 1
        ? 'One file hasn’t been downloaded. Discard it and start a new recording?'
        : `${n} files haven’t been downloaded. Discard them and start a new recording?`,
    );
    if (!ok) return;
    for (const f of undownloaded) await removeFile(f.name);
  }
  finishSessionCleanup();
  store.dispatch('newRecording');
}

/** Clears the review. Downloaded files are deleted from storage on the next app start. */
function finishSessionCleanup() {
  const ses = rt.session;
  rt.urls.revokeAll();
  ui.setPlayer(null, null);
  rt.files.clear();
  rt.session = null;
  rt.timer = null;
  publishFiles();
  if (ses && rt.storage.kind === 'memory') rt.storage.deleteSession(ses.id).catch(() => {});
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

async function checkRecovery() {
  if (rt.storage.kind !== 'opfs') return;
  const sessions = await recovery.scanSessions(rt.storage);
  const pending = [];
  for (const s of sessions) {
    if (recovery.canDelete(s.meta, s.sizes)) await rt.storage.deleteSession(s.meta.id).catch(() => {});
    else pending.push(s);
  }
  rt.pendingRecovery = pending;
  renderRecovery();
}

function renderRecovery() {
  const items = rt.pendingRecovery.map(({ meta, sizes }) => {
    const files = recovery.pendingFiles(meta, sizes);
    const bytes = files.reduce((n, f) => n + (sizes[f.name] || 0), 0);
    const when = meta.startedAt ? new Date(meta.startedAt).toLocaleString() : meta.id;
    const interrupted = meta.status !== 'finalized';
    return {
      id: meta.id,
      title: `Recording from ${when}`,
      detail: `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(bytes)}${interrupted ? ' · interrupted while recording' : ' · not downloaded'}`,
      canRecover: store.get().status === 'ready',
    };
  });
  ui.showRecovery(items);
}

function takePending(id) {
  const i = rt.pendingRecovery.findIndex((s) => s.meta.id === id);
  if (i < 0) return null;
  return rt.pendingRecovery[i];
}

function dropPending(id) {
  rt.pendingRecovery = rt.pendingRecovery.filter((s) => s.meta.id !== id);
  renderRecovery();
}

async function onRecover(id) {
  const entry = takePending(id);
  if (!entry || store.get().status !== 'ready') return;
  const { meta, sizes } = entry;
  const mime = meta.mimeType || '';
  rt.files.clear();
  rt.urls.revokeAll();
  for (const f of recovery.pendingFiles(meta, sizes)) {
    let blob = null;
    try {
      const stored = await rt.storage.getFile(meta.id, f.name);
      blob = new Blob([stored], { type: baseMime(mime) });
      if (needsDurationFix(mime) && f.activeMs > 0) blob = await fixDuration(blob, f.activeMs, baseMime(mime));
    } catch {
      blob = null;
    }
    rt.files.set(f.name, {
      name: f.name,
      part: f.part,
      mimeType: mime,
      ext: extensionForMime(mime),
      blob,
      size: blob?.size ?? 0,
      durationMs: f.activeMs || null,
      status: blob && blob.size ? 'ready' : 'failed',
      incomplete: f.incomplete || !f.finalized,
      downloaded: false,
    });
  }
  rt.session = { id: meta.id, base: meta.id, meta, split: meta.files.length > 1, recovered: true, finishing: new Set() };
  dropPending(id);
  publishFiles();
  store.dispatch('recover');
  const first = [...rt.files.values()].sort((a, b) => a.part - b.part).find((f) => f.blob);
  if (first) onPlay(first.name);
}

async function onRecoverDownload(id) {
  const entry = takePending(id);
  if (!entry) return;
  const { meta, sizes } = entry;
  const files = recovery.pendingFiles(meta, sizes);
  for (let i = 0; i < files.length; i += 1) {
    try {
      const stored = await rt.storage.getFile(meta.id, files[i].name);
      triggerDownload(stored, files[i].name);
      recovery.updateFile(meta, files[i].name, { downloaded: true });
    } catch {
      ui.notice('recover-dl', 'error', `Couldn’t read ${files[i].name} from browser storage.`);
    }
    if (i < files.length - 1) await delay(400);
  }
  await rt.storage.writeText(meta.id, recovery.META_NAME, recovery.serializeMeta(meta)).catch(() => {});
  dropPending(id);
}

async function onRecoverDelete(id) {
  const entry = takePending(id);
  if (!entry) return;
  const ok = await ui.confirm('Delete this recording from browser storage? It can’t be recovered afterwards.', 'Delete');
  if (!ok) return;
  await rt.storage.deleteSession(id).catch(() => {});
  dropPending(id);
}

// ---------------------------------------------------------------------------
// Page-level events
// ---------------------------------------------------------------------------

function onBeforeUnload(e) {
  const st = store?.get();
  if (!st) return;
  const unsaved = isBusy(st.status) || st.files.some((f) => f.status === 'ready' && !f.downloaded);
  if (unsaved) {
    e.preventDefault();
    e.returnValue = '';
  }
}

function shortcutTarget(e) {
  const t = e.target;
  const tag = t?.tagName;
  return !(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t?.isContentEditable);
}

function onKeyDown(e) {
  if (!store || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (!shortcutTarget(e)) return;
  const s = store.get().status;
  const key = e.key.toLowerCase();
  if (key === 'r' && s === 'previewing') {
    e.preventDefault();
    onRecord();
  } else if (e.code === 'Space' && isCapturing(s)) {
    e.preventDefault();
    onPauseToggle();
  } else if (key === 's' && isCapturing(s)) {
    e.preventDefault();
    onStop();
  } else if (key === 'escape' && s === 'countdown') {
    e.preventDefault();
    onCancelCountdown();
  }
}

function onKeyUp(e) {
  // Stop Space from also "clicking" a focused button after we handled it.
  if (e.code === 'Space' && e.target?.tagName === 'BUTTON' && store && isCapturing(store.get().status)) e.preventDefault();
}

const handlers = {
  onSelectSource,
  onChangeSource,
  onStopSharing,
  onRecord,
  onPauseToggle,
  onStop,
  onToggleMute,
  onSkipCountdown: finishCountdown,
  onCancelCountdown,
  onSettingsChange,
  onPlay,
  onDownload: (name) => downloadFile(name),
  onDiscard,
  onDownloadAll,
  onNewRecording,
  onRecover,
  onRecoverDownload,
  onRecoverDelete,
};

init().catch((err) => {
  console.error('Screen Recorder failed to start', err);
});

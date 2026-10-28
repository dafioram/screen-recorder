// Rendering and DOM events. Holds no application state of its own: it renders
// what the store says and reports user actions to the handlers from app.js.
import { isBusy, isCapturing } from './state.js';
import { formatElapsed } from './time.js';
import { formatBytes } from './download.js';
import { formatLabel } from './recorder.js';

const STATUS_LABELS = {
  ready: 'Ready',
  selectingSource: 'Choosing source…',
  previewing: 'Previewing',
  countdown: 'Starting…',
  recording: 'Recording',
  paused: 'Paused',
  finalizing: 'Saving…',
  review: 'Recording ready',
  error: 'Error',
};

const SURFACE_LABELS = { monitor: 'Entire screen', window: 'Window', browser: 'Browser tab' };
const SPLIT_PRESETS = ['0', '30', '60', '300', '900'];

const FILE_STATUS = {
  recording: 'Recording…',
  finalizing: 'Saving…',
  ready: '',
  failed: 'Couldn’t be saved',
};

export class UI {
  constructor(handlers) {
    this.h = handlers;
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.lastSettings = null;
    this.lastFiles = null;
    this.lastFormats = null;
    this.meterSource = null;
    this.selectedFile = null;
    this._bind();
  }

  // ---------- events ----------

  _bind() {
    const $ = this.$;
    const h = this.h;
    $('select-source').addEventListener('click', () => h.onSelectSource());
    $('change-source').addEventListener('click', () => h.onChangeSource());
    $('stop-sharing').addEventListener('click', () => h.onStopSharing());
    $('record').addEventListener('click', () => h.onRecord());
    $('pause').addEventListener('click', () => h.onPauseToggle());
    $('stop').addEventListener('click', () => h.onStop());
    $('mute-mic').addEventListener('click', () => h.onToggleMute());
    $('countdown-skip').addEventListener('click', () => h.onSkipCountdown());
    $('countdown-cancel').addEventListener('click', () => h.onCancelCountdown());
    $('download-all').addEventListener('click', () => h.onDownloadAll());
    $('new-recording').addEventListener('click', () => h.onNewRecording());

    const form = $('settings');
    form.addEventListener('change', (e) => this._onSettingChange(e));
    $('bitrate-range').addEventListener('input', (e) => {
      $('bitrate-output').textContent = `${Number(e.target.value)} Mbps`;
    });

    $('file-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const name = btn.closest('[data-name]')?.dataset.name;
      if (!name) return;
      const action = btn.dataset.action;
      if (action === 'play') h.onPlay(name);
      else if (action === 'download') h.onDownload(name);
      else if (action === 'discard') h.onDiscard(name);
    });

    $('recovery-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.closest('[data-id]')?.dataset.id;
      if (!id) return;
      const action = btn.dataset.action;
      if (action === 'recover') h.onRecover(id);
      else if (action === 'download') h.onRecoverDownload(id);
      else if (action === 'delete') h.onRecoverDelete(id);
    });

    $('notices').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const notice = btn.closest('.notice');
      if (btn.dataset.dismiss !== undefined) {
        notice?.remove();
        return;
      }
      const fn = notice?._actions?.[Number(btn.dataset.index)];
      if (fn) {
        notice.remove();
        fn();
      }
    });
  }

  _onSettingChange(e) {
    const el = e.target;
    const $ = this.$;
    if (el.id === 'split-preset') {
      if (el.value === 'custom') {
        $('split-custom-wrap').hidden = false;
        const seconds = Number($('split-custom').value) || 120;
        $('split-custom').value = String(seconds);
        this.h.onSettingsChange({ splitSeconds: seconds });
        $('split-custom').focus();
      } else {
        this.h.onSettingsChange({ splitSeconds: Number(el.value) });
      }
      return;
    }
    if (el.id === 'split-custom') {
      this.h.onSettingsChange({ splitSeconds: Number(el.value) || 0 });
      return;
    }
    const key = el.dataset.setting;
    if (!key) return;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.dataset.type === 'number') value = Number(el.value);
    else value = el.value;
    this.h.onSettingsChange({ [key]: value });
  }

  // ---------- rendering ----------

  render(state) {
    const $ = this.$;
    const s = state.status;
    const busy = isBusy(s);

    $('status').dataset.state = s;
    $('status-text').textContent = STATUS_LABELS[s] ?? s;

    // Stage
    const hasSource = s === 'previewing' || s === 'countdown' || isCapturing(s);
    $('preview-empty').hidden = hasSource || s === 'finalizing';
    $('select-source').disabled = s !== 'ready';
    $('source-bar').hidden = !hasSource;
    $('change-source').disabled = s !== 'previewing';
    $('stop-sharing').disabled = s !== 'previewing';
    $('source-info').textContent = this._sourceText(state);

    // Controls
    $('record').disabled = s !== 'previewing';
    $('pause').disabled = !isCapturing(s) || !state.canPause;
    $('pause').textContent = s === 'paused' ? 'Resume' : 'Pause';
    $('pause').title = state.canPause ? '' : 'This browser can’t pause recordings';
    $('stop').disabled = !isCapturing(s);
    const showMute = state.micActive && (s === 'previewing' || isCapturing(s));
    $('mute-mic').hidden = !showMute;
    $('mute-mic').textContent = state.micMuted ? 'Unmute mic' : 'Mute mic';
    $('mute-mic').setAttribute('aria-pressed', String(!!state.micMuted));
    $('mic-badge').hidden = !state.micActive;
    $('mic-badge').textContent = state.micMuted ? 'Muted' : 'Active';
    $('sys-badge').hidden = !state.hasSystemAudio;
    $('mic-meter-row').hidden = !state.micActive;
    $('sys-meter-row').hidden = !state.hasSystemAudio;
    $('timer').classList.toggle('live', s === 'recording');
    if (!isCapturing(s) && s !== 'finalizing') {
      $('timer').textContent = '00:00';
      $('rec-meta').textContent = '';
    }

    // Settings lock while a recording is starting, running or saving.
    $('settings').disabled = busy;
    this._renderSettings(state);

    // Review
    const inReview = s === 'review';
    $('empty-title').textContent = inReview ? 'Recording finished' : 'Choose what to record';
    $('empty-text').textContent = inReview
      ? 'Play, download or discard it above, then choose New recording to start again.'
      : 'Select a screen, window or browser tab using your browser’s sharing dialog.';
    $('select-source').hidden = inReview;
    $('select-hint').hidden = inReview;
    const wasHidden = $('review').hidden;
    $('review').hidden = !inReview;
    if (inReview && wasHidden) $('review').scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (state.files !== this.lastFiles) {
      this.lastFiles = state.files;
      this._renderFiles(state.files);
    }
  }

  _sourceText(state) {
    const src = state.source;
    if (!src) return '';
    const parts = [SURFACE_LABELS[src.surface] ?? 'Shared source'];
    if (src.width && src.height) parts.push(`${src.width} × ${src.height}`);
    if (state.hasSystemAudio) parts.push('with system audio');
    return parts.join(' · ');
  }

  _renderSettings(state) {
    const st = state.settings;
    const $ = this.$;
    if (state.supportedFormats !== this.lastFormats) {
      this.lastFormats = state.supportedFormats;
      const sel = $('format-select');
      sel.replaceChildren(new Option('Automatic', 'auto'));
      const names = { webm: 'WebM', mp4: 'MP4', mkv: 'MKV (H.264)' };
      for (const f of state.supportedFormats) sel.append(new Option(names[f] ?? f.toUpperCase(), f));
    }
    if (st === this.lastSettings) return;
    this.lastSettings = st;

    for (const el of $('settings').querySelectorAll('[data-setting]')) {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!st[key];
      else if (key !== 'micDeviceId') el.value = String(st[key]);
    }
    this._selectMicValue(st.micDeviceId);
    $('bitrate-output').textContent = `${st.customBitrateMbps} Mbps`;
    $('custom-quality').hidden = st.quality !== 'custom';

    const preset = SPLIT_PRESETS.includes(String(st.splitSeconds)) ? String(st.splitSeconds) : 'custom';
    if (!($('split-preset').value === 'custom' && preset === 'custom')) $('split-preset').value = preset;
    $('split-custom-wrap').hidden = preset !== 'custom';
    if (preset === 'custom') $('split-custom').value = String(st.splitSeconds);
    $('split-delivery-wrap').hidden = st.splitSeconds <= 0;

    const overlayOpts = $('overlay-options');
    overlayOpts.classList.toggle('dimmed', !st.overlayEnabled);
    for (const el of overlayOpts.querySelectorAll('select, input')) el.disabled = !st.overlayEnabled;
  }

  _selectMicValue(deviceId) {
    const sel = this.$('mic-device');
    const exists = [...sel.options].some((o) => o.value === deviceId);
    sel.value = exists ? deviceId : '';
  }

  setMicDevices(devices, selectedId) {
    const sel = this.$('mic-device');
    sel.replaceChildren(new Option('Default microphone', ''));
    for (const d of devices) {
      if (d.deviceId === 'default') continue;
      sel.append(new Option(d.label, d.deviceId));
    }
    this._selectMicValue(selectedId);
  }

  setSelectHint(text) {
    this.$('select-hint').textContent = text;
  }

  setTimer(ms) {
    this.$('timer').textContent = formatElapsed(ms);
  }

  setRecMeta(text) {
    this.$('rec-meta').textContent = text;
  }

  setEstimate(text) {
    this.$('quality-estimate').textContent = text;
  }

  setDelivered(text, warn = false) {
    const el = this.$('quality-delivered');
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }

  /** track: MediaStreamTrack to show, or null. hiddenNote shows the "preview hidden" label. */
  setPreview(track, hiddenNote = false) {
    const video = this.$('preview');
    this.$('preview-hidden').hidden = !hiddenNote;
    if (!track) {
      video.srcObject = null;
      video.hidden = true;
      return;
    }
    video.hidden = false;
    const current = video.srcObject?.getVideoTracks?.()[0];
    if (current !== track) video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
  }

  // ---------- meters ----------

  startMeters(getLevels) {
    this.meterSource = getLevels;
    if (this.meterLoop) return;
    const mic = this.$('mic-meter');
    const sys = this.$('sys-meter');
    const loop = () => {
      const levels = this.meterSource?.() ?? {};
      mic.style.setProperty('width', `${Math.round((levels.mic ?? 0) * 100)}%`);
      sys.style.setProperty('width', `${Math.round((levels.system ?? 0) * 100)}%`);
      this.meterLoop = requestAnimationFrame(loop);
    };
    this.meterLoop = requestAnimationFrame(loop);
  }

  // ---------- countdown ----------

  showCountdown(n) {
    this.$('countdown').hidden = false;
    this.$('countdown-number').textContent = String(n);
  }

  hideCountdown() {
    this.$('countdown').hidden = true;
  }

  // ---------- notices ----------

  /** kind: info | warning | error. actions: [{label, action}] */
  notice(id, kind, text, actions = []) {
    this.dismiss(id);
    const el = document.createElement('div');
    el.className = `notice ${kind}`;
    el.dataset.id = id;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const p = document.createElement('p');
    p.textContent = text;
    el.append(p);
    const bar = document.createElement('div');
    bar.className = 'notice-actions';
    el._actions = actions.map((a) => a.action);
    actions.forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.dataset.index = String(i);
      b.textContent = a.label;
      bar.append(b);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn ghost small';
    close.dataset.dismiss = '';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = 'Dismiss';
    bar.append(close);
    el.append(bar);
    this.$('notices').append(el);
  }

  dismiss(id) {
    for (const el of this.$('notices').querySelectorAll('.notice')) {
      if (el.dataset.id === id) el.remove();
    }
  }

  // ---------- review ----------

  _renderFiles(files) {
    const list = this.$('file-list');
    list.replaceChildren();
    const multi = files.length > 1;
    let totalBytes = 0;
    let totalMs = 0;
    for (const f of files) {
      totalBytes += f.size || 0;
      totalMs += f.durationMs || 0;
      const li = document.createElement('li');
      li.className = 'file';
      li.dataset.name = f.name;
      if (f.name === this.selectedFile) li.classList.add('selected');

      const info = document.createElement('div');
      info.className = 'file-info';
      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = f.name;
      const meta = document.createElement('div');
      meta.className = 'file-meta';
      const bits = [];
      if (f.durationMs) bits.push(formatElapsed(f.durationMs));
      bits.push(formatLabel(f.mimeType));
      if (f.size) bits.push(formatBytes(f.size));
      if (FILE_STATUS[f.status]) bits.push(FILE_STATUS[f.status]);
      if (f.incomplete) bits.push('may be incomplete');
      if (f.gapBefore) bits.push('short gap before this file');
      meta.textContent = bits.join(' · ');
      info.append(name, meta);

      const tags = document.createElement('div');
      tags.className = 'file-tags';
      if (f.downloaded) {
        const tag = document.createElement('span');
        tag.className = 'badge ok';
        tag.textContent = 'Downloaded';
        tags.append(tag);
      }

      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const ready = f.status === 'ready';
      actions.append(
        this._button('Play', 'play', !ready),
        this._button(f.downloaded ? 'Download again' : 'Download', 'download', !ready, ready && !f.downloaded ? 'primary' : ''),
        this._button('Discard', 'discard', f.status === 'recording' || f.status === 'finalizing', 'ghost danger-text'),
      );
      li.append(info, tags, actions);
      list.append(li);
    }

    const pending = files.filter((f) => f.status === 'ready' && !f.downloaded).length;
    const summary = [];
    summary.push(multi ? `${files.length} files` : files.length === 1 ? '1 file' : 'No files');
    if (totalMs) summary.push(formatElapsed(totalMs));
    if (totalBytes) summary.push(formatBytes(totalBytes));
    if (files.length && pending === 0) summary.push('all downloaded');
    this.$('review-summary').textContent = summary.join(' · ');
    const dl = this.$('download-all');
    dl.textContent = multi ? `Download all (${pending})` : 'Download';
    dl.disabled = pending === 0;
  }

  _button(label, action, disabled, extra = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small ${extra}`.trim();
    b.dataset.action = action;
    b.textContent = label;
    b.disabled = !!disabled;
    return b;
  }

  /** Shows a file in the review player. url null clears it. */
  setPlayer(name, url) {
    const player = this.$('player');
    this.selectedFile = name;
    for (const li of this.$('file-list').querySelectorAll('.file')) {
      li.classList.toggle('selected', li.dataset.name === name);
    }
    if (!url) {
      player.removeAttribute('src');
      player.load();
      player.hidden = true;
      return;
    }
    player.hidden = false;
    if (player.src !== url) player.src = url;
  }

  // ---------- recovery ----------

  /** items: [{ id, title, detail }] */
  showRecovery(items) {
    const list = this.$('recovery-list');
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      li.dataset.id = item.id;
      const text = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = item.detail;
      text.append(title, detail);
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      actions.append(
        this._button('Recover', 'recover', !item.canRecover, 'primary'),
        this._button('Download as is', 'download', false),
        this._button('Delete', 'delete', false, 'ghost danger-text'),
      );
      li.append(text, actions);
      list.append(li);
    }
    this.$('recovery').hidden = items.length === 0;
  }

  // ---------- misc ----------

  confirm(message, okLabel = 'Discard') {
    const dialog = this.$('confirm-dialog');
    if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(message));
    this.$('confirm-message').textContent = message;
    this.$('confirm-ok').textContent = okLabel;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
  }

  showUnsupported(message) {
    const box = this.$('unsupported');
    box.querySelector('p').textContent = message;
    box.hidden = false;
    this.$('app').hidden = true;
  }
}

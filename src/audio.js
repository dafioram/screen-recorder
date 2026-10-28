// Mixes every audio source into one stable output track, and measures levels.
// The output track exists for the whole session, so muting the mic or losing a
// source never changes the tracks MediaRecorder is recording.

export class AudioMixer {
  constructor() {
    this.ctx = null;
    this.dest = null;
    this.sources = new Map();
  }

  /** Create (or resume) the AudioContext. Call from a user gesture. */
  ensureContext() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.dest = this.ctx.createMediaStreamDestination();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** kind: 'mic' | 'system'. Replaces any existing source of the same kind. */
  addSource(kind, stream) {
    this.removeSource(kind);
    const ctx = this.ensureContext();
    if (!ctx) return false;
    const node = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(gain);
    gain.connect(analyser);
    gain.connect(this.dest); // never to ctx.destination: no monitoring, no feedback
    this.sources.set(kind, { stream, node, gain, analyser, buffer: new Float32Array(analyser.fftSize), muted: false });
    return true;
  }

  removeSource(kind) {
    const s = this.sources.get(kind);
    if (!s) return;
    for (const n of [s.node, s.gain, s.analyser]) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.sources.delete(kind);
  }

  has(kind) {
    return this.sources.has(kind);
  }

  get hasSources() {
    return this.sources.size > 0;
  }

  setMuted(kind, muted) {
    const s = this.sources.get(kind);
    if (!s || !this.ctx) return;
    s.muted = muted;
    s.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.015);
  }

  /** 0..1 level on a -60..0 dBFS scale, or null if the source isn't present. */
  level(kind) {
    const s = this.sources.get(kind);
    if (!s) return null;
    s.analyser.getFloatTimeDomainData(s.buffer);
    let sum = 0;
    for (let i = 0; i < s.buffer.length; i += 1) sum += s.buffer[i] * s.buffer[i];
    const rms = Math.sqrt(sum / s.buffer.length);
    if (rms <= 0) return 0;
    const db = 20 * Math.log10(rms);
    return Math.min(1, Math.max(0, (db + 60) / 60));
  }

  get outputTrack() {
    return this.dest?.stream.getAudioTracks()[0] ?? null;
  }

  close() {
    for (const kind of [...this.sources.keys()]) this.removeSource(kind);
    const ctx = this.ctx;
    this.ctx = null;
    this.dest = null;
    if (ctx && ctx.state !== 'closed') return ctx.close().catch(() => {});
    return Promise.resolve();
  }
}

// Time helpers shared by the main thread and workers.
// Absolute time = performance.timeOrigin + performance.now(), which is
// monotonic within a context and comparable across the page and its workers.

export function nowAbs() {
  return performance.timeOrigin + performance.now();
}

/** Counts active (unpaused) time using a monotonic clock. */
export class ActiveTimer {
  constructor() {
    this.accumulated = 0;
    this.runningSince = null;
  }

  start(now = nowAbs()) {
    this.accumulated = 0;
    this.runningSince = now;
  }

  pause(now = nowAbs()) {
    if (this.runningSince !== null) {
      this.accumulated += now - this.runningSince;
      this.runningSince = null;
    }
  }

  resume(now = nowAbs()) {
    if (this.runningSince === null) this.runningSince = now;
  }

  get running() {
    return this.runningSince !== null;
  }

  elapsed(now = nowAbs()) {
    return elapsedFromSnapshot(this.snapshot(), now);
  }

  snapshot() {
    return { accumulated: this.accumulated, runningSince: this.runningSince };
  }
}

export function elapsedFromSnapshot(snapshot, now = nowAbs()) {
  if (!snapshot) return 0;
  const running = snapshot.runningSince !== null && snapshot.runningSince !== undefined;
  return snapshot.accumulated + (running ? Math.max(0, now - snapshot.runningSince) : 0);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** MM:SS, switching to H:MM:SS from one hour. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** Local clock time, 24-hour HH:MM:SS. */
export function formatClock(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Text drawn by the timer overlay. format: elapsed | clock | both */
export function overlayText(format, elapsedMs, date = new Date()) {
  if (format === 'clock') return formatClock(date);
  if (format === 'both') return `${formatElapsed(elapsedMs)}  ·  ${formatClock(date)}`;
  return formatElapsed(elapsedMs);
}

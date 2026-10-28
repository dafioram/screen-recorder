// Interval splitting: when to roll over to a new file, and how.

export function partLabel(part) {
  return `part${String(part).padStart(2, '0')}`;
}

/** Tracks split boundaries in active (unpaused) recording time. */
export class SplitSchedule {
  constructor(intervalSeconds) {
    this.intervalMs = intervalSeconds > 0 ? intervalSeconds * 1000 : 0;
    this.part = 1;
  }

  get enabled() {
    return this.intervalMs > 0;
  }

  nextBoundaryMs() {
    return this.part * this.intervalMs;
  }

  due(elapsedMs) {
    return this.enabled && elapsedMs >= this.nextBoundaryMs();
  }

  /** Moves to the next part and returns its number. */
  advance() {
    this.part += 1;
    return this.part;
  }

  timeToNextMs(elapsedMs) {
    return this.enabled ? Math.max(0, this.nextBoundaryMs() - elapsedMs) : null;
  }

  static expectedParts(totalMs, intervalSeconds) {
    if (!(intervalSeconds > 0)) return 1;
    return Math.max(1, Math.ceil(totalMs / (intervalSeconds * 1000)));
  }
}

/**
 * Starts the next file, then finishes the current one, so the files overlap by a
 * few frames instead of leaving a gap. If a second concurrent recorder cannot
 * start, falls back to stop-then-start and reports the gap.
 *
 * @param {() => Promise<void>} finishCurrent
 * @param {() => any} startNext  synchronous; throws if the recorder can't start
 */
export async function rollover(finishCurrent, startNext) {
  try {
    const next = startNext();
    return { next, finishing: finishCurrent(), gap: false };
  } catch (error) {
    await finishCurrent();
    const next = startNext(); // a second failure propagates to the caller
    return { next, finishing: Promise.resolve(), gap: true, error };
  }
}

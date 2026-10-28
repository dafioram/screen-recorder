// The single source of application state and its valid transitions.

export const STATES = Object.freeze({
  READY: 'ready',
  SELECTING: 'selectingSource',
  PREVIEWING: 'previewing',
  COUNTDOWN: 'countdown',
  RECORDING: 'recording',
  PAUSED: 'paused',
  FINALIZING: 'finalizing',
  REVIEW: 'review',
  ERROR: 'error',
});

// status -> event -> next status
const TRANSITIONS = Object.freeze({
  ready: { select: 'selectingSource', recover: 'review' },
  selectingSource: { cancel: 'ready', fail: 'ready', granted: 'previewing' },
  previewing: { record: 'countdown', cancelSource: 'ready', sourceEnded: 'ready' },
  countdown: { done: 'recording', cancel: 'previewing', sourceEnded: 'ready' },
  recording: { pause: 'paused', stop: 'finalizing', sourceEnded: 'finalizing' },
  paused: { resume: 'recording', stop: 'finalizing', sourceEnded: 'finalizing' },
  finalizing: { finalized: 'review', fail: 'error' },
  review: { discard: 'ready', newRecording: 'ready' },
  error: { reset: 'ready' },
});

export function nextStatus(status, event) {
  return TRANSITIONS[status]?.[event] ?? null;
}

export function canDo(status, event) {
  return nextStatus(status, event) !== null;
}

const BUSY = new Set(['countdown', 'recording', 'paused', 'finalizing']);

/** True while a recording is starting, running or being saved. Settings are locked. */
export function isBusy(status) {
  return BUSY.has(status);
}

export function isCapturing(status) {
  return status === 'recording' || status === 'paused';
}

export function createStore(initial = {}) {
  let state = { status: STATES.READY, ...initial };
  const listeners = new Set();
  const emit = (prev) => {
    for (const fn of listeners) fn(state, prev);
  };

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Update data without changing status. */
    set(patch) {
      const prev = state;
      state = { ...state, ...patch, status: prev.status };
      emit(prev);
    },
    /** Apply a state-machine event. Returns false (and changes nothing) if not allowed. */
    dispatch(event, patch = {}) {
      const to = nextStatus(state.status, event);
      if (!to) return false;
      const prev = state;
      state = { ...state, ...patch, status: to };
      emit(prev);
      return true;
    },
  };
}

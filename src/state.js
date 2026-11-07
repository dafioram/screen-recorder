// The single source of application state and its valid transitions.

export const STATES = Object.freeze({
  READY: 'ready',
  SELECT: 'selectingSource',
  PREVIEWING: 'previewing',
  COUNTDOWN: 'countdown',
  RECORDING: 'recording',
  PAUSED: 'paused',
  FINALIZING: 'finalizing',
  REVIEW: 'review',
  ERROR: 'error',
});

/**
 * Where the app rests when no capture is running. Recordings waiting for download or
 * discard keep the app in review. A still-attached source keeps the preview and the
 * Record button available, so the user can record again without choosing the source.
 */
export function restStatus(state = {}) {
  if (state.files?.length) return STATES.REVIEW;
  return state.source ? STATES.PREVIEWING : STATES.READY;
}

const REST = Symbol('rest');

// status -> event -> next status (or REST, resolved from the state by restStatus)
const TRANSITIONS = Object.freeze({
  ready: { select: 'selectingSource', recover: 'review' },
  selectingSource: { cancel: REST, fail: REST, granted: REST },
  previewing: { record: 'countdown', cancelSource: REST, sourceEnded: REST },
  countdown: { done: 'recording', cancel: REST, sourceEnded: REST },
  recording: { pause: 'paused', stop: 'finalizing', sourceEnded: 'finalizing' },
  paused: { resume: 'recording', stop: 'finalizing', sourceEnded: 'finalizing' },
  finalizing: { finalized: REST, fail: 'error' },
  review: { record: 'countdown', select: 'selectingSource', cancelSource: REST, sourceEnded: REST, discard: REST },
  error: { reset: REST },
});

/** state is the data after any patch from the same event, so a granted source is already included. */
export function nextStatus(status, event, state = {}) {
  const to = TRANSITIONS[status]?.[event];
  if (to === undefined) return null;
  return to === REST ? restStatus(state) : to;
}

export function canDo(status, event, state = {}) {
  return nextStatus(status, event, state) !== null;
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
      const merged = { ...state, ...patch };
      const to = nextStatus(state.status, event, merged);
      if (!to) return false;
      const prev = state;
      state = { ...merged, status: to };
      emit(prev);
      return true;
    },
  };
}

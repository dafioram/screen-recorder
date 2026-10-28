// Worker for the tick clock and the timer-overlay compositor.
// Worker timers keep running at full rate when the page is in a background tab.
import { drawComposite, overlayLabel } from './overlay.js';

let tickTimer = null;
let comp = null;

function startTicks(intervalMs) {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => self.postMessage({ type: 'tick' }), Math.max(4, intervalMs));
}

function stopTicks() {
  clearInterval(tickTimer);
  tickTimer = null;
}

function startComposite({ readable, writable, width, height, fps, state }) {
  stopComposite();
  const canvas = new OffscreenCanvas(width, height);
  const c = {
    canvas,
    ctx: canvas.getContext('2d', { alpha: false }),
    reader: readable.getReader(),
    writer: writable.getWriter(),
    width,
    height,
    state: { ...state },
    last: null,
    writing: false,
    frames: 0,
    stopped: false,
  };
  comp = c;

  // Keep only the newest source frame. Screen capture sends frames only when the
  // screen changes, so output frames are produced on our own clock instead.
  (async () => {
    try {
      for (;;) {
        const { value, done } = await c.reader.read();
        if (done || c.stopped) {
          value?.close();
          break;
        }
        c.last?.close();
        c.last = value;
      }
    } catch {
      /* stream closed */
    }
  })();

  c.drawTimer = setInterval(() => render(c), 1000 / fps);
  c.statsTimer = setInterval(() => {
    self.postMessage({ type: 'stats', fps: c.frames });
    c.frames = 0;
  }, 1000);
}

function render(c) {
  if (c.stopped || c.writing) return; // skip a frame rather than queue them
  const f = c.last;
  drawComposite(c.ctx, f, f?.displayWidth, f?.displayHeight, c.width, c.height, overlayLabel(c.state), c.state.corner);
  let frame;
  try {
    frame = new VideoFrame(c.canvas, { timestamp: Math.round(performance.now() * 1000) });
  } catch {
    return;
  }
  c.writing = true;
  c.writer
    .write(frame)
    .then(() => {
      c.frames += 1;
    })
    .catch(() => {
      try {
        frame.close();
      } catch {
        /* already closed */
      }
    })
    .finally(() => {
      c.writing = false;
    });
}

function stopComposite() {
  const c = comp;
  if (!c) return;
  comp = null;
  c.stopped = true;
  clearInterval(c.drawTimer);
  clearInterval(c.statsTimer);
  c.reader.cancel().catch(() => {});
  c.writer.close().catch(() => {});
  c.last?.close();
  c.last = null;
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'tick-start':
      startTicks(msg.intervalMs);
      break;
    case 'tick-stop':
      stopTicks();
      break;
    case 'composite-start':
      startComposite(msg);
      break;
    case 'composite-update':
      if (comp) Object.assign(comp.state, msg.state);
      break;
    case 'composite-stop':
      stopComposite();
      break;
    default:
      break;
  }
});

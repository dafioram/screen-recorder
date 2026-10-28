// Writes recording chunks to OPFS with sync access handles, off the main thread.
// The page serialises writes per file, so each handle sees one operation at a time.

const handles = new Map();
let nextKey = 1;

async function sessionDir(dir, id) {
  const top = await navigator.storage.getDirectory();
  const root = await top.getDirectoryHandle(dir, { create: true });
  return root.getDirectoryHandle(id, { create: true });
}

const ops = {
  async probe() {
    const top = await navigator.storage.getDirectory();
    const fh = await top.getFileHandle('.probe-sync', { create: true });
    const h = await fh.createSyncAccessHandle();
    try {
      await h.write(new Uint8Array([1]), { at: 0 });
      await h.flush();
    } finally {
      await h.close();
    }
    await top.removeEntry('.probe-sync');
    return true;
  },

  async open({ dir, id, name }) {
    const d = await sessionDir(dir, id);
    const fh = await d.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    await h.truncate(0);
    const key = nextKey++;
    handles.set(key, { h, at: 0 });
    return { key };
  },

  async write({ key, buffer }) {
    const entry = handles.get(key);
    if (!entry) throw new Error('File is not open');
    const data = new Uint8Array(buffer);
    const written = await entry.h.write(data, { at: entry.at });
    entry.at += written;
    if (written !== data.byteLength) {
      const err = new Error('The disk write was incomplete');
      err.name = 'QuotaExceededError';
      throw err;
    }
    await entry.h.flush(); // keep data on disk so a crash loses at most one chunk
    return written;
  },

  async close({ key }) {
    const entry = handles.get(key);
    if (!entry) return;
    handles.delete(key);
    try {
      await entry.h.flush();
    } finally {
      await entry.h.close();
    }
  },

  async writeText({ dir, id, name, text }) {
    const d = await sessionDir(dir, id);
    const fh = await d.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode(text);
      await h.truncate(0);
      await h.write(bytes, { at: 0 });
      await h.flush();
    } finally {
      await h.close();
    }
  },
};

self.addEventListener('message', async (event) => {
  const { id, op, args } = event.data || {};
  try {
    if (!ops[op]) throw new Error(`Unknown operation: ${op}`);
    const result = await ops[op](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: { name: err?.name || 'Error', message: err?.message || String(err) } });
  }
});

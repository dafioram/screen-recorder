// Streaming to disk. Each recorded chunk is written to the Origin Private File
// System (OPFS) as it arrives, from a worker with a sync access handle. Falls back
// to main-thread writable streams, then to in-memory Blobs.

export const ROOT_DIR = 'recordings';
const WORKER_TIMEOUT_MS = 4000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toError(e) {
  const err = new Error(e?.message || 'Storage error');
  err.name = e?.name || 'Error';
  return err;
}

/** Request/response wrapper around the storage worker. */
export class WorkerClient {
  constructor(worker) {
    this.worker = worker;
    this.nextId = 1;
    this.pending = new Map();
    worker.addEventListener('message', (event) => {
      const { id, ok, result, error } = event.data || {};
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(toError(error));
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      for (const p of this.pending.values()) p.reject(new Error('Storage worker failed'));
      this.pending.clear();
    });
  }

  call(op, args = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args }, transfer);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

/** Base for sinks: serialises writes, counts bytes and stops after the first error. */
class ChainedSink {
  constructor() {
    this.bytes = 0;
    this.error = null;
    this.onError = null;
    this.chain = Promise.resolve();
  }

  _enqueue(task) {
    this.chain = this.chain
      .then(() => (this.error ? undefined : task()))
      .catch((err) => {
        if (!this.error) {
          this.error = err;
          this.onError?.(err);
        }
      });
    return this.chain;
  }

  write(blob) {
    this.bytes += blob.size;
    return this._enqueue(() => this._write(blob));
  }
}

export class WorkerSink extends ChainedSink {
  constructor(storage, sessionId, name) {
    super();
    this.storage = storage;
    this.sessionId = sessionId;
    this.name = name;
    this.key = null;
    this._enqueue(async () => {
      const r = await storage.client.call('open', { dir: ROOT_DIR, id: sessionId, name });
      this.key = r.key;
    });
  }

  async _write(blob) {
    const buffer = await blob.arrayBuffer();
    await this.storage.client.call('write', { key: this.key, buffer }, [buffer]);
  }

  async close() {
    await this.chain;
    if (this.key !== null) {
      await this.storage.client.call('close', { key: this.key }).catch(() => {});
      this.key = null;
    }
    return this.storage.getFile(this.sessionId, this.name);
  }
}

export class WritableSink extends ChainedSink {
  constructor(storage, sessionId, name) {
    super();
    this.storage = storage;
    this.sessionId = sessionId;
    this.name = name;
    this.writable = null;
    this._enqueue(async () => {
      const dir = await storage.dir(sessionId, true);
      const fh = await dir.getFileHandle(name, { create: true });
      this.writable = await fh.createWritable({ keepExistingData: false });
    });
  }

  async _write(blob) {
    await this.writable.write(blob);
  }

  async close() {
    await this.chain;
    if (this.writable) {
      await this.writable.close().catch(() => {});
      this.writable = null;
    }
    return this.storage.getFile(this.sessionId, this.name);
  }
}

export class MemorySink extends ChainedSink {
  constructor(storage, key) {
    super();
    this.storage = storage;
    this.key = key;
    this.chunks = [];
  }

  async _write(blob) {
    this.chunks.push(blob);
  }

  async close() {
    await this.chain;
    const blob = new Blob(this.chunks);
    this.chunks = [];
    this.storage.files.set(this.key, blob);
    return blob;
  }
}

async function iterateDir(dir) {
  const out = [];
  if (typeof dir.values === 'function') {
    for await (const handle of dir.values()) out.push(handle);
  } else if (typeof dir.entries === 'function') {
    for await (const [, handle] of dir.entries()) out.push(handle);
  }
  return out;
}

export class OpfsStorage {
  constructor(root, client) {
    this.kind = 'opfs';
    this.root = root;
    this.client = client;
  }

  dir(id, create = false) {
    return this.root.getDirectoryHandle(id, { create });
  }

  createSink(id, name) {
    return this.client ? new WorkerSink(this, id, name) : new WritableSink(this, id, name);
  }

  async getFile(id, name) {
    const dir = await this.dir(id);
    const fh = await dir.getFileHandle(name);
    return fh.getFile();
  }

  async writeText(id, name, text) {
    if (this.client) {
      await this.client.call('writeText', { dir: ROOT_DIR, id, name, text });
      return;
    }
    const dir = await this.dir(id, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(text);
    await w.close();
  }

  async readText(id, name) {
    try {
      return await (await this.getFile(id, name)).text();
    } catch {
      return null;
    }
  }

  async listSessions() {
    const handles = await iterateDir(this.root);
    return handles.filter((h) => h.kind === 'directory').map((h) => h.name);
  }

  async listFiles(id) {
    const handles = await iterateDir(await this.dir(id));
    const out = [];
    for (const h of handles) {
      if (h.kind !== 'file') continue;
      try {
        out.push({ name: h.name, size: (await h.getFile()).size });
      } catch {
        out.push({ name: h.name, size: 0 }); // locked or unreadable
      }
    }
    return out;
  }

  async deleteFile(id, name) {
    const dir = await this.dir(id);
    await dir.removeEntry(name);
  }

  async deleteSession(id) {
    await this.root.removeEntry(id, { recursive: true });
  }

  async estimate() {
    try {
      const e = await navigator.storage.estimate();
      return { quota: e.quota ?? 0, usage: e.usage ?? 0, free: Math.max(0, (e.quota ?? 0) - (e.usage ?? 0)) };
    } catch {
      return null;
    }
  }
}

/** Fallback when OPFS is unavailable: recordings live in RAM until downloaded. */
export class MemoryStorage {
  constructor() {
    this.kind = 'memory';
    this.files = new Map();
  }

  createSink(id, name) {
    return new MemorySink(this, `${id}/${name}`);
  }

  async getFile(id, name) {
    const blob = this.files.get(`${id}/${name}`);
    if (!blob) throw new Error('File not found');
    return blob;
  }

  async writeText() {}

  async readText() {
    return null;
  }

  async listSessions() {
    return [];
  }

  async listFiles(id) {
    const prefix = `${id}/`;
    return [...this.files.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, b]) => ({ name: k.slice(prefix.length), size: b.size }));
  }

  async deleteFile(id, name) {
    this.files.delete(`${id}/${name}`);
  }

  async deleteSession(id) {
    for (const k of [...this.files.keys()]) if (k.startsWith(`${id}/`)) this.files.delete(k);
  }

  async estimate() {
    return null;
  }
}

async function startWorkerClient() {
  let worker;
  try {
    worker = new Worker(new URL('./storage.worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  const client = new WorkerClient(worker);
  try {
    await withTimeout(client.call('probe'), WORKER_TIMEOUT_MS);
    return client;
  } catch {
    client.terminate();
    return null;
  }
}

async function probeWritable(root) {
  try {
    const fh = await root.getFileHandle('.probe-writable', { create: true });
    if (typeof fh.createWritable !== 'function') return false;
    const w = await fh.createWritable();
    await w.write(new Uint8Array([1]));
    await w.close();
    await root.removeEntry('.probe-writable');
    return true;
  } catch {
    return false;
  }
}

/** Picks the best storage available: OPFS via worker, OPFS on main thread, or memory. */
export async function createStorage() {
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    try {
      const top = await navigator.storage.getDirectory();
      const root = await top.getDirectoryHandle(ROOT_DIR, { create: true });
      const client = await startWorkerClient();
      if (client) return new OpfsStorage(root, client);
      if (await probeWritable(root)) return new OpfsStorage(root, null);
    } catch {
      /* fall through to memory */
    }
  }
  return new MemoryStorage();
}

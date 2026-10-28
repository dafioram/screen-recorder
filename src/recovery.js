// Session metadata kept beside the recorded files, so recordings survive a crash
// or a closed tab and can be recovered on the next visit.

export const META_NAME = 'session.json';
export const META_VERSION = 1;

const MIME_BY_EXTENSION = { webm: 'video/webm', mkv: 'video/x-matroska', mp4: 'video/mp4' };

export function createSessionMeta({ id, startedAt = Date.now(), mimeType = '', extension = '', splitSeconds = 0 }) {
  return {
    version: META_VERSION,
    id,
    startedAt,
    updatedAt: startedAt,
    mimeType,
    extension,
    splitSeconds,
    status: 'recording',
    files: [],
  };
}

export function addFile(meta, { name, part }) {
  const file = { name, part, activeMs: 0, finalized: false, downloaded: false, discarded: false, incomplete: false };
  meta.files.push(file);
  return file;
}

export function updateFile(meta, name, patch) {
  const file = meta.files.find((f) => f.name === name);
  if (file) Object.assign(file, patch);
  return file ?? null;
}

export function serializeMeta(meta) {
  return JSON.stringify({ ...meta, updatedAt: Date.now() });
}

export function parseMeta(text) {
  try {
    const m = JSON.parse(text);
    if (!m || m.version !== META_VERSION || typeof m.id !== 'string' || !Array.isArray(m.files)) return null;
    m.files = m.files
      .filter((f) => f && typeof f.name === 'string')
      .map((f) => ({
        name: f.name,
        part: Number(f.part) || 1,
        activeMs: Math.max(0, Number(f.activeMs) || 0),
        finalized: !!f.finalized,
        downloaded: !!f.downloaded,
        discarded: !!f.discarded,
        incomplete: !!f.incomplete,
      }));
    m.mimeType = typeof m.mimeType === 'string' ? m.mimeType : '';
    m.startedAt = Number(m.startedAt) || 0;
    return m;
  } catch {
    return null;
  }
}

/** Builds metadata for a session folder whose session.json is missing or unreadable. */
export function synthesizeMeta(id, mediaFiles) {
  const files = mediaFiles
    .map((f) => {
      const part = Number(/-part(\d+)\./.exec(f.name)?.[1]) || 1;
      return { name: f.name, part, activeMs: 0, finalized: false, downloaded: false, discarded: false, incomplete: true };
    })
    .sort((a, b) => a.part - b.part);
  const ext = /\.([a-z0-9]+)$/i.exec(files[0]?.name ?? '')?.[1]?.toLowerCase() ?? '';
  return {
    version: META_VERSION,
    id,
    startedAt: 0,
    updatedAt: 0,
    mimeType: MIME_BY_EXTENSION[ext] ?? '',
    extension: ext,
    splitSeconds: files.length > 1 ? 1 : 0,
    status: 'recording',
    files,
  };
}

/** Files that still need the user's attention: not downloaded, not discarded, not empty. */
export function pendingFiles(meta, sizes = {}) {
  return meta.files.filter((f) => !f.downloaded && !f.discarded && (sizes[f.name] ?? 1) > 0);
}

export function canDelete(meta, sizes = {}) {
  return pendingFiles(meta, sizes).length === 0;
}

/** Reads every session folder in storage. Returns [{ meta, sizes }]. */
export async function scanSessions(storage) {
  const out = [];
  let ids = [];
  try {
    ids = await storage.listSessions();
  } catch {
    return out;
  }
  for (const id of ids) {
    let files;
    try {
      files = await storage.listFiles(id);
    } catch {
      continue;
    }
    const media = files.filter((f) => f.name !== META_NAME);
    const text = await storage.readText(id, META_NAME);
    const meta = (text && parseMeta(text)) || synthesizeMeta(id, media);
    const sizes = Object.fromEntries(media.map((f) => [f.name, f.size]));
    // Files listed in metadata but missing on disk count as empty.
    for (const f of meta.files) if (!(f.name in sizes)) sizes[f.name] = 0;
    out.push({ meta, sizes });
  }
  return out;
}

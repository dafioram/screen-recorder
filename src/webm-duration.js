// Patches the Duration element into WebM/MKV (Matroska) files from MediaRecorder,
// which are written without one, so players show the length and can seek.
// Only the header (everything up to the end of the Info element) is rebuilt in
// memory; the rest of the file is reused as a Blob slice and never copied.

export const IDS = Object.freeze({
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  Void: 0xec,
});

const UNKNOWN_SIZE_8 = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

function vintLength(firstByte) {
  for (let i = 0; i < 8; i += 1) if (firstByte & (0x80 >> i)) return i + 1;
  return 0;
}

export function readId(bytes, pos) {
  if (pos >= bytes.length) return null;
  const length = vintLength(bytes[pos]);
  if (!length || length > 4 || pos + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + bytes[pos + i];
  return { id, length };
}

export function readSize(bytes, pos) {
  if (pos >= bytes.length) return null;
  const length = vintLength(bytes[pos]);
  if (!length || pos + length > bytes.length) return null;
  const mask = 0xff >> length;
  let value = bytes[pos] & mask;
  let allOnes = value === mask;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

export function readElement(bytes, pos) {
  const id = readId(bytes, pos);
  if (!id) return null;
  const size = readSize(bytes, pos + id.length);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  return {
    id: id.id,
    start: pos,
    idLength: id.length,
    sizeLength: size.length,
    size: size.unknown ? Infinity : size.value,
    unknown: size.unknown,
    dataStart,
    end: size.unknown ? Infinity : dataStart + size.value,
  };
}

export function encodeId(id) {
  const out = [];
  let v = id;
  do {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Uint8Array.from(out);
}

/** Encodes an element size as a vint. length = number of bytes (1-8), or minimal if omitted. */
export function encodeSize(value, length) {
  let len = length;
  if (!len) {
    len = 1;
    while (len < 8 && value >= 2 ** (7 * len) - 1) len += 1;
  }
  if (value >= 2 ** (7 * len) - 1) throw new RangeError('Size does not fit');
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function readUint(bytes, pos, size) {
  let v = 0;
  for (let i = 0; i < size; i += 1) v = v * 256 + bytes[pos + i];
  return v;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Overwrites an element in place with a Void element of exactly the same length. */
function voidInPlace(buf, el) {
  const total = el.end - el.start;
  for (let sizeLen = 1; sizeLen <= 8; sizeLen += 1) {
    const dataSize = total - 1 - sizeLen;
    if (dataSize < 0) break;
    if (dataSize >= 2 ** (7 * sizeLen) - 1) continue;
    buf[el.start] = IDS.Void;
    buf.set(encodeSize(dataSize, sizeLen), el.start + 1);
    buf.fill(0, el.start + 1 + sizeLen, el.end);
    return true;
  }
  return false;
}

/** Walks the header and returns the parts the patcher needs, or null. */
function parseHeader(bytes) {
  const ebml = readElement(bytes, 0);
  if (!ebml || ebml.id !== IDS.EBML || ebml.unknown || ebml.end > bytes.length) return null;
  const segment = readElement(bytes, ebml.end);
  if (!segment || segment.id !== IDS.Segment) return null;

  const seekHeads = [];
  let info = null;
  let pos = segment.dataStart;
  while (pos < bytes.length) {
    const el = readElement(bytes, pos);
    if (!el || el.id === IDS.Cluster) return null; // no Info before media data
    if (el.unknown || el.end > bytes.length) return null; // header not fully in this prefix
    if (el.id === IDS.SeekHead) seekHeads.push(el);
    if (el.id === IDS.Info) {
      info = el;
      break;
    }
    pos = el.end;
  }
  if (!info) return null;

  let timecodeScale = 1_000_000;
  let duration = null;
  const children = [];
  for (let p = info.dataStart; p < info.end; ) {
    const child = readElement(bytes, p);
    if (!child || child.unknown || child.end > info.end) return null;
    if (child.id === IDS.TimecodeScale) timecodeScale = readUint(bytes, child.dataStart, child.size) || 1_000_000;
    if (child.id === IDS.Duration) duration = child;
    children.push(child);
    p = child.end;
  }
  return { ebml, segment, seekHeads, info, children, duration, timecodeScale };
}

/** Reads the Duration from a header, in milliseconds, or null if absent. */
export function readWebmDuration(bytes) {
  const h = parseHeader(bytes);
  if (!h || !h.duration) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + h.duration.dataStart, h.duration.size);
  const value = h.duration.size === 8 ? view.getFloat64(0) : view.getFloat32(0);
  return (value * h.timecodeScale) / 1e6;
}

/**
 * Returns { header, replacedLength }: write `header` in place of the first
 * `replacedLength` bytes of the file. Returns null if the file can't be patched
 * from this prefix (too short or not a recognised layout).
 */
export function patchWebmDuration(bytes, durationMs) {
  const h = parseHeader(bytes);
  if (!h) return null;
  const value = (durationMs * 1e6) / h.timecodeScale;
  const out = bytes.slice(0, h.info.end);

  // SeekHead positions would be invalidated by a resized Info. MediaRecorder files
  // play fine without one, so it is turned into a Void of the same length.
  for (const el of h.seekHeads) if (!voidInPlace(out, el)) return null;

  const d = h.duration;
  if (d && (d.size === 8 || d.size === 4)) {
    const view = new DataView(out.buffer, out.byteOffset + d.dataStart, d.size);
    if (d.size === 8) view.setFloat64(0, value);
    else view.setFloat32(0, value);
    return { header: out, replacedLength: h.info.end };
  }

  const kept = h.children
    .filter((c) => c.id !== IDS.Duration)
    .map((c) => out.subarray(c.start, c.end));
  const durationEl = new Uint8Array(11);
  durationEl.set([0x44, 0x89, 0x88], 0);
  new DataView(durationEl.buffer).setFloat64(3, value);
  const infoBody = concat([...kept, durationEl]);

  const header = concat([
    out.subarray(0, h.ebml.end),
    encodeId(IDS.Segment),
    UNKNOWN_SIZE_8, // segment size changes; unknown size is valid and what MediaRecorder writes
    out.subarray(h.segment.dataStart, h.info.start),
    encodeId(IDS.Info),
    encodeSize(infoBody.length),
    infoBody,
  ]);
  return { header, replacedLength: h.info.end };
}

const PREFIX_SIZES = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];

/**
 * Returns a new Blob with the duration set, or the original Blob if it can't be
 * patched. The body is a slice of the original, so a disk-backed File stays on disk.
 */
export async function fixDuration(blob, durationMs, type = blob.type) {
  if (!(durationMs > 0) || !blob || !blob.size) return blob;
  for (const size of PREFIX_SIZES) {
    const length = Math.min(size, blob.size);
    const bytes = new Uint8Array(await blob.slice(0, length).arrayBuffer());
    const result = patchWebmDuration(bytes, durationMs);
    if (result) return new Blob([result.header, blob.slice(result.replacedLength)], { type });
    if (length === blob.size) break;
  }
  return blob;
}

// gitobj.ts — pure git object, pkt-line, tree/commit/tag and packfile primitives.
// Standard library only. No state, no I/O.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX_PAYLOAD = 65516;

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `<type> <len>\0<data>`. */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([header, data]));
}

export function encodeLooseObject(type: ObjType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return Buffer.concat([header, data]);
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Decode a whole buffer of pkt-lines. Throws on truncation or garbage. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      // response-end; treat as flush for our purposes
      out.push({ kind: 'flush' });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Decode pkt-lines from the start of a buffer, stopping just past the first flush packet.
 *  Returns the packets and the byte offset after the flush. Throws on truncation or garbage
 *  before the flush. Bytes after the flush (e.g. a raw packfile) are left untouched. */
export function parsePktLinesPrefix(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      return { packets, consumed: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'flush' });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  throw new Error('pkt-line stream ended without a flush');
}
export function demuxSideband(packets: Pkt[]): { band1: Buffer[]; band2: string; band3: string } {
  const band1: Buffer[] = [];
  let band2 = '';
  let band3 = '';
  for (const p of packets) {
    if (p.kind !== 'data' || p.payload.length < 1) continue;
    const band = p.payload[0];
    const data = p.payload.subarray(1);
    if (band === 1) band1.push(Buffer.from(data));
    else if (band === 2) band2 += data.toString('utf8');
    else if (band === 3) band3 += data.toString('utf8');
  }
  return { band1, band2, band3 };
}

/** Wrap arbitrary bytes as sideband band-1 pkt-lines (chunked to fit the pkt-line limit). */
export function sidebandWrap(band: 1 | 2 | 3, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65000;
  if (data.length === 0) return Buffer.alloc(0);
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    const framed = Buffer.concat([Buffer.from([band]), slice]);
    parts.push(pktLine(framed));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// trees / commits / tags
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree sort: entries sorted by name, directories as if suffixed with '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('bad tree entry');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const mode = data.subarray(off, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    off = nul + 21;
  }
  return out;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  // The message is stored verbatim: the REST surface reads it back exactly as submitted.
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\ncommitter ${fields.committer}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  let out = `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`;
  if (!fields.message.endsWith('\n')) out += '\n';
  return Buffer.from(out, 'utf8');
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

function readVarintSize(buf: Buffer, start: number): { size: number; next: number } {
  let byte = buf[start];
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next: off };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[off++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return result;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) copyOffset |= delta[off++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) copySize |= delta[off++] << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of base');
      if (written + copySize > targetSize) throw new Error('delta writes past target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (off + op > delta.length) throw new Error('delta insert truncated');
      if (written + op > targetSize) throw new Error('delta writes past target');
      delta.copy(out, written, off, off + op);
      off += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA against earlier entries and REF_DELTA against
 * earlier entries or `lookup` (objects the peer already holds). Returns objects keyed by oid.
 */
export function readPack(
  pack: Buffer,
  lookup?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = off;
    const { size, next } = readVarintSize(pack, off);
    off = next;
    // The object type is bits 4-6 of the first size byte.
    const typeNum = (pack[entryStart]! >> 4) & 0x07;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint follows the size header.
      let byte = pack[off++];
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseEntryOffset = entryStart - baseOffset;
      const inflated = inflateAt(pack, off, size);
      off = inflated.next;
      const base = byOffset.get(baseEntryOffset);
      if (!base) throw new Error('ofs-delta base not in pack');
      const data = applyDelta(base.data, inflated.data);
      const obj: GitObject = { type: base.type, data };
      const oid = objectId(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid follows the size header.
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const inflated = inflateAt(pack, off, size);
      off = inflated.next;
      const base = objects.get(baseOid) ?? lookup?.(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} unknown`);
      const data = applyDelta(base.data, inflated.data);
      const obj: GitObject = { type: base.type, data };
      const oid = objectId(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    } else {
      const type = PACK_TYPES[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      const inflated = inflateAt(pack, off, size);
      off = inflated.next;
      const obj: GitObject = { type, data: inflated.data };
      const oid = objectId(type, inflated.data);
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    }
  }
  return objects;
}

function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  // One inflation: inflateSync ignores trailing bytes, and with {info:true} the engine
  // reports exactly how many input bytes the stream consumed (bytesWritten).
  const tail = buf.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(tail, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch {
    throw new Error('cannot inflate pack entry');
  }
  if (result.buffer.length !== expectedSize) throw new Error('inflated pack entry size mismatch');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

const PACK_TYPE_NUMS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum = PACK_TYPE_NUMS[type];
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). Entries sorted by oid for determinism. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  // Deduplicate by oid, keeping first.
  const seen = new Map<string, GitObject>();
  for (const obj of list) seen.set(objectId(obj.type, obj.data), obj);
  const entries = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const [, obj] of entries) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  return sha1hex(pack.subarray(0, pack.length - 20)) === expected;
}

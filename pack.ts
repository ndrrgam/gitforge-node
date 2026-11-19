// Packfile reader/writer. v2 packs, ofs-delta + ref-delta resolution, sync zlib.
// Stream-end location: inflateSync succeeds on any slice containing a complete zlib
// stream and fails on truncation, so the consumed length is binary-searchable.
import { inflateSync, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { ObjType, GitObj } from "./gitstore.ts";

const TYPE_IDS: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1(type: ObjType, data: Buffer): string {
  const h = createHash("sha1");
  h.update(type + " " + data.length + "\0");
  h.update(data);
  return h.digest("hex");
}

// Inflate one zlib stream at buf[off..], returning data and bytes consumed.
// inflateSync({info:true}) reports the compressed bytes it consumed and throws
// on a truncated stream, so no probing/binary search is needed.
export function inflateAt(buf: Buffer, off: number): { data: Buffer; consumed: number } {
  const r = inflateSync(buf.subarray(off), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = r.engine.bytesWritten;
  if (!written || written <= 0) throw new Error("zlib stream at " + off + " consumed no bytes");
  return { data: r.buffer, consumed: written };
}

function readObjHeader(buf: Buffer, off: number): { typeNum: number; size: number; next: number } {
  let c = buf[off++];
  const typeNum = (c >> 4) & 7;
  let size = c & 15;
  let shift = 4;
  while (c & 0x80) { c = buf[off++]; size |= (c & 0x7f) << shift; shift += 7; }
  return { typeNum, size, next: off };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const varint = (): number => {
    let v = 0, shift = 0;
    for (;;) {
      const c = delta[p++];
      v |= (c & 0x7f) << shift;
      shift += 7;
      if (!(c & 0x80)) return v;
    }
  };
  const baseSize = varint();
  const resSize = varint();
  if (baseSize !== base.length) throw new Error("delta base size mismatch");
  const out = Buffer.allocUnsafe(resSize);
  let w = 0;
  while (p < delta.length) {
    const cmd = delta[p++];
    if (cmd & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (cmd & 0x01) cpOff = delta[p++];
      if (cmd & 0x02) cpOff |= delta[p++] << 8;
      if (cmd & 0x04) cpOff |= delta[p++] << 16;
      if (cmd & 0x08) cpOff |= delta[p++] << 24;
      if (cmd & 0x10) cpSize = delta[p++];
      if (cmd & 0x20) cpSize |= delta[p++] << 8;
      if (cmd & 0x40) cpSize |= delta[p++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, w, cpOff, cpOff + cpSize);
      w += cpSize;
    } else if (cmd > 0) {
      delta.copy(out, w, p, p + cmd);
      p += cmd;
      w += cmd;
    } else throw new Error("bad delta op 0");
  }
  if (w !== resSize) throw new Error("delta result size mismatch");
  return out;
}

// Parse a full pack buffer into resolved objects. lookup resolves thin-pack ref-delta bases.
export function parsePack(
  buf: Buffer,
  lookup?: (sha: string) => GitObj | undefined
): Array<{ sha: string; type: ObjType; data: Buffer }> {
  if (buf.readUInt32BE(0) !== 0x5041434b) throw new Error("not a PACK");
  const count = buf.readUInt32BE(8);
  const out: Array<{ sha: string; type: ObjType; data: Buffer }> = [];
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  let off = 12; // 4 magic + 4 version + 4 count
  for (let i = 0; i < count; i++) {
    const start = off;
    const h = readObjHeader(buf, off);
    off = h.next;
    let rec: { type: ObjType; data: Buffer };
    if (h.typeNum === 6) {
      let c = buf[off++];
      let rel = c & 0x7f;
      while (c & 0x80) { c = buf[off++]; rel = ((rel + 1) << 7) | (c & 0x7f); }
      const base = byOffset.get(start - rel); // rel is measured from this object's own header start
      if (!base) throw new Error("ofs-delta base not found");
      const d = inflateAt(buf, off);
      off += d.consumed;
      const data = applyDelta(base.data, d.data);
      rec = { type: base.type, data };
    } else if (h.typeNum === 7) {
      const baseSha = buf.toString("hex", off, off + 20);
      off += 20;
      const base = out.find((o) => o.sha === baseSha) ?? (lookup ? lookup(baseSha) : undefined);
      if (!base) throw new Error("ref-delta base missing " + baseSha);
      const d = inflateAt(buf, off);
      off += d.consumed;
      const data = applyDelta(base.data, d.data);
      rec = { type: base.type, data };
    } else {
      const t = TYPE_IDS[h.typeNum];
      if (!t) throw new Error("bad pack type " + h.typeNum);
      const d = inflateAt(buf, off);
      off += d.consumed;
      if (d.data.length !== h.size) throw new Error("object size mismatch");
      rec = { type: t, data: d.data };
    }
    byOffset.set(start, rec);
    const sha = sha1(rec.type, rec.data);
    out.push({ sha, type: rec.type, data: rec.data });
  }
  return out;
}

// Build a v2 pack from full objects (no deltas emitted). Returns the pack buffer.
export function buildPack(objs: Array<{ type: ObjType; data: Buffer }>, level = 1): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "ascii");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.length, 8);
  parts.push(head);
  const hash = createHash("sha1");
  hash.update(head);
  for (const o of objs) {
    const t = TYPE_NUM[o.type];
    let size = o.data.length;
    const first = Buffer.alloc(1);
    first[0] = (t << 4) | (size & 15);
    size >>>= 4;
    const cont: number[] = [];
    while (size > 0) {
      cont.push(size & 0x7f);
      size >>>= 7;
    }
    let hdr = Buffer.from(first);
    if (cont.length > 0) {
      first[0] |= 0x80;
      const cb = Buffer.alloc(cont.length);
      for (let i = 0; i < cont.length; i++) cb[i] = cont[i] | (i + 1 < cont.length ? 0x80 : 0);
      hdr = Buffer.concat([first, cb]);
    }
    const body = deflateSync(o.data, { level });
    const chunk = Buffer.concat([hdr, body]);
    parts.push(chunk);
    hash.update(chunk);
  }
  parts.push(hash.digest());
  return Buffer.concat(parts);
}

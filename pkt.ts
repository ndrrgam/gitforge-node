// pkt-line codec for git smart HTTP. Zero-dependency, buffer-based.
export function pkt(data: Uint8Array | string): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const out = Buffer.alloc(4 + payload.length);
  out.writeUIntBE(4 + payload.length, 0, 4);
  out.write((4 + payload.length).toString(16).padStart(4, "0"), 0, 4, "ascii");
  payload.copy(out, 4);
  return out;
}
export const FLUSH = Buffer.from("0000", "ascii");
export const DELIM = Buffer.from("0001", "ascii");
export const ENDpk = Buffer.from("0002", "ascii");

// Iterate pkt-lines from a buffer; returns array of {data: Buffer|null} (null=flush/delim/end).
export function readPkts(buf: Buffer): Array<{ kind: number; data: Buffer | null }> {
  const out: Array<{ kind: number; data: Buffer | null }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.toString("ascii", off, off + 4), 16);
    if (!Number.isFinite(len)) throw new Error("bad pkt length at " + off);
    if (len === 0) { out.push({ kind: 0, data: null }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 1, data: null }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 2, data: null }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error("truncated pkt at " + off);
    out.push({ kind: 3, data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// Convenience: encode many lines then flush.
export function pktLines(lines: Array<string | Uint8Array>, flush = true): Buffer {
  const parts = lines.map((l) => pkt(l));
  if (flush) parts.push(FLUSH);
  return Buffer.concat(parts);
}
// Strip trailing NUL-free string content to a JS string (drops the trailing \n if present).
export function pktStr(b: Buffer): string {
  let s = b.toString("utf8");
  if (s.endsWith("\n")) s = s.slice(0, -1);
  return s;
}

// Minimal raw HTTP/1.1 server on net.Server. Hand-rolled for speed:
// one buffer per response, keep-alive, pipelining, 100-continue, chunked bodies.
import * as net from "node:net";

export interface Req {
  method: string;
  path: string;            // decoded path, no query
  rawPath: string;         // original path string
  query: URLSearchParams;
  headers: Map<string, string>; // lowercased names
  body: Buffer;
  version: string;
}
export interface Res {
  status: number;
  headers?: Array<[string, string]>;
  body?: Buffer | string;
  /** A fully encoded response: when set, encodeRes emits these bytes as-is. */
  raw?: Buffer;
}

const MAX_HEAD = 1 << 20; // 1 MiB header cap
const MAX_BODY = 512 << 20; // 512 MiB body cap

function statusText(code: number): string {
  const m: Record<number, string> = {
    100: "Continue", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request",
    401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    409: "Conflict", 422: "Unprocessable Entity", 500: "Internal Server Error",
    501: "Not Implemented", 503: "Service Unavailable",
  };
  return m[code] ?? "Status";
}

export function encodeRes(res: Res, keepAlive: boolean): Buffer {
  if (res.raw !== undefined) return res.raw;
  const status = res.status;
  const body = res.body === undefined ? Buffer.alloc(0)
    : typeof res.body === "string" ? Buffer.from(res.body, "utf8") : res.body;
  const lines: string[] = ["HTTP/1.1 " + status + " " + statusText(status)];
  let hasLen = false, hasType = false;
  if (res.headers) {
    for (const [k, v] of res.headers) {
      if (k.toLowerCase() === "content-length") hasLen = true;
      if (k.toLowerCase() === "content-type") hasType = true;
      lines.push(k + ": " + v);
    }
  }
  if (!hasLen && status !== 204 && status !== 304) lines.push("Content-Length: " + body.length);
  if (!hasType && body.length > 0) lines.push("Content-Type: application/octet-stream");
  lines.push("Connection: " + (keepAlive ? "keep-alive" : "close"));
  lines.push("");
  lines.push("");
  const head = Buffer.from(lines.join("\r\n"), "ascii");
  return Buffer.concat([head, body]);
}

interface ConnState { buf: Buffer; expecting: null | { remaining: number }; }

export function createServer(
  handler: (req: Req) => Res | Promise<Res>,
  opts: { onError?: (e: unknown, req?: Req) => Res | void } = {}
): net.Server {
  return net.createServer((sock) => {
    sock.setNoDelay(true);
    const st: ConnState = { buf: Buffer.alloc(0), expecting: null };
    let closed = false;

    const close = () => { if (!closed) { closed = true; sock.destroy(); } };

    const dispatch = async (req: Req) => {
      let res: Res;
      try {
        const r = handler(req);
        res = r instanceof Promise ? await r : r;
      } catch (e) {
        const or = opts.onError ? opts.onError(e, req) : undefined;
        res = or ?? { status: 500, body: "internal error" };
      }
      if (sock.writable && !closed) {
        try { sock.write(encodeRes(res, true)); } catch { close(); }
      }
      pump();
    };

    const pump = () => {
      // loop while complete requests are buffered
      for (;;) {
        const done = tryOne();
        if (!done) break;
      }
    };

    const tryOne = (): boolean => {
      if (st.expecting) {
        if (st.buf.length < st.expecting.remaining) return false;
        const body = st.buf.subarray(0, st.expecting.remaining);
        const req = st.expecting as unknown as { __req: Req } & { remaining: number } as never as Req;
        void req;
        // handled below via stored partial
        const partial = (st.expecting as unknown as { __partial: Req }).__partial;
        partial.body = Buffer.from(body);
        st.buf = st.buf.subarray(st.expecting.remaining);
        st.expecting = null;
        dispatch(partial);
        return true;
      }
      const idx = st.buf.indexOf("\r\n\r\n");
      if (idx < 0) {
        if (st.buf.length > MAX_HEAD) { send400(); }
        return false;
      }
      const head = st.buf.subarray(0, idx).toString("latin1");
      const rest = st.buf.subarray(idx + 4);
      const lines = head.split("\r\n");
      const reqLine = lines[0].split(" ");
      if (reqLine.length !== 3) { send400(); return false; }
      const method = reqLine[0].toUpperCase();
      const target = reqLine[1];
      const version = reqLine[2];
      const headers = new Map<string, string>();
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(":");
        if (c <= 0) continue;
        headers.set(lines[i].slice(0, c).trim().toLowerCase(), lines[i].slice(c + 1).trim());
      }
      const sp = target.indexOf("?");
      const rawPath = sp >= 0 ? target.slice(0, sp) : target;
      const query = new URLSearchParams(sp >= 0 ? target.slice(sp + 1) : "");
      let path = rawPath;
      try { path = decodeURIComponent(rawPath); } catch { /* keep raw */ }
      const req: Req = { method, path, rawPath, query, headers, body: Buffer.alloc(0), version };
      const te = (headers.get("transfer-encoding") || "").toLowerCase();
      if (te.includes("chunked")) {
        const r = readChunked(rest);
        if (!r) return false;
        req.body = r.data;
        st.buf = r.rest;
        dispatch(req);
        return true;
      }
      const cl = headers.get("content-length");
      if (cl !== undefined && method !== "GET" && method !== "HEAD") {
        const n = parseInt(cl, 10);
        if (!Number.isFinite(n) || n < 0 || n > MAX_BODY) { send400(); return false; }
        if (rest.length < n) {
          const expect = headers.get("expect");
          if (expect && expect.toLowerCase().includes("100-continue") && !st.expecting && sock.writable) {
            try { sock.write(Buffer.from("HTTP/1.1 100 Continue\r\n\r\n", "ascii")); } catch { close(); }
          }
          st.expecting = { remaining: n, __partial: req } as never;
          st.buf = Buffer.from(rest);
          return false;
        }
        req.body = Buffer.from(rest.subarray(0, n));
        st.buf = rest.subarray(n);
        dispatch(req);
        return true;
      }
      req.body = Buffer.from(rest.subarray(0, 0));
      st.buf = rest;
      dispatch(req);
      return true;
    };

    const send400 = () => {
      if (sock.writable && !closed) {
        try { sock.write(encodeRes({ status: 400, body: "bad request" }, false)); } catch { /* ignore */ }
      }
      close();
    };

    const readChunked = (rest: Buffer): { data: Buffer; rest: Buffer } | null => {
      const chunks: Buffer[] = [];
      let pos = 0;
      let total = 0;
      for (;;) {
        const nl = rest.indexOf("\r\n", pos);
        if (nl < 0) return null;
        const sizeLine = rest.toString("latin1", pos, nl).trim();
        const semi = sizeLine.indexOf(";");
        const size = parseInt(semi >= 0 ? sizeLine.slice(0, semi) : sizeLine, 16);
        if (!Number.isFinite(size) || size < 0) return null;
        pos = nl + 2;
        if (size === 0) {
          // trailer: require final CRLF (or trailer headers ending with blank line)
          const end = rest.indexOf("\r\n", pos);
          if (end < 0) return null;
          if (end === pos) {
            return { data: Buffer.concat(chunks), rest: rest.subarray(pos + 2) };
          }
          pos = end + 2;
          // skip trailer headers until blank line — handled by loop above
          continue;
        }
        if (pos + size + 2 > rest.length) return null;
        chunks.push(Buffer.from(rest.subarray(pos, pos + size)));
        total += size;
        if (total > MAX_BODY) return null;
        pos += size + 2;
      }
    };

    sock.on("data", (chunk: Buffer) => {
      st.buf = st.buf.length === 0 ? chunk : Buffer.concat([st.buf, chunk]);
      pump();
    });
    sock.on("error", close);
    sock.on("close", close);
  });
}

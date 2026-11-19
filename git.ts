// bot/git.ts — git smart HTTP surface, driven byte-for-byte by the suite's
// git-client.ts (the oracle): info/refs advertisements (v0 + v2), upload-pack
// (ls-refs / fetch, protocol v2 and v0), receive-pack push with report-status
// demuxed from side-band-64k band 1. Node built-ins + bot/* only, erasable TS
// (run directly by Node's type stripper), fully deterministic: timestamps
// come from ctx.now() alone. Handlers never throw out; errors become 4xx/5xx.
import type { Req, Res } from "./http.ts";
import type { Ctx, Repo } from "./db.ts";
import { getRepo } from "./db.ts";
import type { Store } from "./gitstore.ts";
import { pkt, FLUSH, DELIM, readPkts, pktStr, pktLines } from "./pkt.ts";
import { parsePack, buildPack } from "./pack.ts";

const ZERO_OID = "0".repeat(40);
// PKT_LINE_MAX payload 65516 minus the 1-byte sideband band byte.
const SIDE_CHUNK = 65515;
const BAND1 = Buffer.from([1]);

// v0 upload-pack caps: side-band-64k + shallow are mandatory for the client's
// v0 path; symref lets a v0 advertisement carry HEAD's target.
const UP_CAPS =
  "side-band-64k shallow multi_ack_detailed thin-pack ofs-delta no-progress " +
  "symref=HEAD:refs/heads/main agent=makefun-forge/1.0";
// v0 receive-pack caps: report-status, side-band-64k, delete-refs are checked.
const RC_CAPS = "report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0";

// The v2 capability advertisement is repo-independent: build the bytes once.
const V2_ADV = Buffer.concat([
  pkt("version 2\n"),
  pkt("agent=makefun-forge/1.0\n"),
  pkt("ls-refs=unborn\n"),
  pkt("fetch=shallow filter\n"),
  pkt("object-format=sha1\n"),
  FLUSH,
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function notFound(): Res {
  return { status: 404, body: "not found" };
}

function gitRes(status: number, contentType: string, body: Buffer): Res {
  return { status, headers: [["Content-Type", contentType]], body };
}

/** Peel an annotated-tag chain to its first non-tag target; null if `sha` is not a tag. */
function peelTag(store: Store, sha: string): string | null {
  let cur = sha;
  for (let i = 0; i < 16; i++) {
    const obj = store.get(cur);
    if (!obj) return null;
    if (obj.type !== "tag") return cur === sha ? null : cur;
    const m = /object ([0-9a-f]{40})/.exec(obj.data.toString("latin1"));
    if (!m) return null;
    cur = m[1];
  }
  return null;
}

/** Every object reachable from `roots`: commits (depth-limited, optionally
 *  stopped at `stopAt` shallow boundaries), their trees/blobs fully, tag
 *  roots followed to their target. `boundary` = commits whose parents exist
 *  but were not traversed (the shallow cut). */
function closure(
  store: Store,
  roots: string[],
  depth: number | null,
  stopAt: Set<string> | null,
): { objs: Set<string>; boundary: Set<string> } {
  const objs = new Set<string>();
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const stack: Array<{ sha: string; level: number }> = [];
  for (const r of roots) {
    const o = store.get(r);
    if (!o) continue;
    if (o.type === "commit") {
      if (!seen.has(r)) stack.push({ sha: r, level: 0 });
    } else if (o.type === "tag") {
      objs.add(r);
      const m = /object ([0-9a-f]{40})/.exec(o.data.toString("latin1"));
      if (m && !seen.has(m[1])) {
        const t = store.get(m[1]);
        if (t && t.type === "commit") stack.push({ sha: m[1], level: 0 });
        else if (t) objs.add(m[1]);
      }
    } else {
      objs.add(r); // a raw blob/tree want: include as-is
    }
  }
  while (stack.length) {
    const { sha, level } = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const co = store.readCommit(sha);
    if (!co) continue; // never advertise an object we do not hold
    objs.add(sha);
    walkTree(store, co.tree, objs);
    const parents = co.parents;
    if (!parents.length) continue;
    const blocked = stopAt !== null && stopAt.has(sha);
    const goDeeper = !blocked && (depth === null || level + 1 < depth);
    if (goDeeper) {
      for (const p of parents) {
        if (!seen.has(p) && store.has(p)) stack.push({ sha: p, level: level + 1 });
      }
    } else {
      boundary.add(sha);
    }
  }
  return { objs, boundary };
}

function walkTree(store: Store, treeSha: string, objs: Set<string>): void {
  const tstack = [treeSha];
  while (tstack.length) {
    const ts = tstack.pop()!;
    if (objs.has(ts)) continue;
    const to = store.get(ts);
    if (!to || to.type !== "tree") continue;
    objs.add(ts);
    for (const e of store.readTree(ts)) {
      if (e.mode === "160000") continue; // gitlink: not our object
      if (e.mode === "40000" || e.mode === "040000") tstack.push(e.sha);
      else if (store.has(e.sha)) objs.add(e.sha);
    }
  }
}

/** True when `baseSha` is an ancestor of (or equal to) `newSha` in the commit graph. */
function isAncestor(store: Store, baseSha: string, newSha: string): boolean {
  if (baseSha === newSha) return true;
  const seen = new Set<string>();
  const stack = [newSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (sha === baseSha) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const co = store.readCommit(sha);
    if (!co) continue;
    for (const p of co.parents) if (!seen.has(p)) stack.push(p);
  }
  return false;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v0Advertisement(ctx: Ctx, repo: Repo, service: "git-upload-pack" | "git-receive-pack"): Buffer {
  const caps = service === "git-receive-pack" ? RC_CAPS : UP_CAPS;
  const parts: Buffer[] = [pkt("# service=" + service + "\n"), FLUSH];
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    // Empty repo: the capabilities^{} pseudo-ref line (the client drops the ref
    // itself and marks HEAD unborn).
    parts.push(pkt(ZERO_OID + " capabilities^{}\0" + caps + "\n"));
  } else {
    const mainOid = repo.refs.get("refs/heads/" + repo.defaultBranch);
    let first = true;
    if (mainOid !== undefined) {
      // HEAD first; the FIRST ref line carries the capability list after NUL.
      parts.push(pkt(mainOid + " HEAD\0" + caps + "\n"));
      first = false;
    }
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(pkt(first ? oid + " " + name + "\0" + caps + "\n" : oid + " " + name + "\n"));
      first = false;
      const peeled = peelTag(ctx.store, oid);
      if (peeled !== null) parts.push(pkt(peeled + " " + name + "^{}\n"));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack: ls-refs (v2) and fetch (v2 + v0)
// ---------------------------------------------------------------------------

function lsRefsResponse(ctx: Ctx, repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === "peel") peel = true;
    else if (a === "symrefs") symrefs = true;
    else if (a === "unborn") unborn = true;
    else if (a.startsWith("ref-prefix ")) prefixes.push(a.slice(11));
  }
  // ref-prefix is a SERVER-side filter: nothing outside the prefixes is sent.
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const mainRef = "refs/heads/" + repo.defaultBranch;
  const mainOid = repo.refs.get(mainRef);
  if (mainOid !== undefined) {
    if (keep("HEAD")) {
      lines.push(mainOid + " HEAD" + (symrefs ? " symref-target:" + mainRef : "") + "\n");
    }
  } else if (unborn && keep("HEAD")) {
    lines.push("unborn HEAD" + (symrefs ? " symref-target:" + mainRef : "") + "\n");
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = oid + " " + name;
    if (peel) {
      const p = peelTag(ctx.store, oid);
      if (p !== null) line += " peeled:" + p;
    }
    lines.push(line + "\n");
  }
  return pktLines(lines, true);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const a of lines) {
    if (a.startsWith("want ")) wants.push(a.slice(5).split(" ")[0]); // v0 caps ride on the first want
    else if (a.startsWith("have ")) haves.push(a.slice(5));
    else if (a.startsWith("shallow ")) shallow.push(a.slice(8));
    else if (a.startsWith("deepen ")) depth = parseInt(a.slice(7), 10) || 0;
    // thin-pack / no-progress / ofs-delta / filter / done carry no server state
  }
  return { wants: [...new Set(wants)], haves, shallow, depth };
}

/** Objects to send = closure(wants, depth) minus what the client already holds
 *  (haves, truncated at the client's own shallow boundaries). */
function computeSend(
  store: Store,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): { objs: string[]; shallows: string[]; unshallows: string[] } {
  const shallowSet = new Set(clientShallow);
  const haveObjs = haves.length
    ? closure(store, haves, null, shallowSet.size ? shallowSet : null).objs
    : new Set<string>();
  const send = closure(store, wants, depth, null);
  const objs: string[] = [];
  for (const sha of send.objs) if (!haveObjs.has(sha)) objs.push(sha);
  const shallows: string[] = [];
  const unshallows: string[] = [];
  if (depth !== null) {
    for (const b of send.boundary) if (!shallowSet.has(b)) shallows.push(b);
    for (const s of shallowSet) {
      if (send.objs.has(s) && !send.boundary.has(s)) unshallows.push(s);
    }
  }
  return { objs, shallows, unshallows };
}

function sidebandParts(pack: Buffer, parts: Buffer[]): void {
  for (let off = 0; off < pack.length; off += SIDE_CHUNK) {
    parts.push(pkt(Buffer.concat([BAND1, pack.subarray(off, off + SIDE_CHUNK)])));
  }
}

function v2FetchResponse(store: Store, plan: { objs: string[]; shallows: string[]; unshallows: string[] }): Buffer {
  const parts: Buffer[] = [pkt("acknowledgments\n"), pkt("NAK\n")];
  if (plan.shallows.length || plan.unshallows.length) {
    parts.push(DELIM, pkt("shallow-info\n"));
    for (const s of plan.shallows) parts.push(pkt("shallow " + s + "\n"));
    for (const s of plan.unshallows) parts.push(pkt("unshallow " + s + "\n"));
  }
  if (plan.objs.length) {
    const pack = buildPack(
      plan.objs.map((sha) => {
        const o = store.get(sha)!;
        return { type: o.type, data: o.data };
      }),
    );
    parts.push(DELIM, pkt("packfile\n"));
    sidebandParts(pack, parts);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(store: Store, plan: { objs: string[]; shallows: string[]; unshallows: string[] }): Buffer {
  const parts: Buffer[] = [];
  for (const s of plan.shallows) parts.push(pkt("shallow " + s + "\n"));
  for (const s of plan.unshallows) parts.push(pkt("unshallow " + s + "\n"));
  parts.push(pkt("NAK\n"));
  if (plan.objs.length) {
    const pack = buildPack(
      plan.objs.map((sha) => {
        const o = store.get(sha)!;
        return { type: o.type, data: o.data };
      }),
    );
    sidebandParts(pack, parts);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(ctx: Ctx, repo: Repo, req: Req): Res {
  const ct = "application/x-git-upload-pack-result";
  let pkts: Array<{ kind: number; data: Buffer | null }>;
  try {
    pkts = readPkts(req.body);
  } catch {
    return { status: 400, body: "malformed pkt-line body" };
  }
  // v2: command/agent/object-format before the delim, args after it.
  // v0: no command=, no delim — every data line is request content.
  const head: string[] = [];
  const args: string[] = [];
  let command = "";
  let sawDelim = false;
  for (const p of pkts) {
    if (p.kind === 1) {
      sawDelim = true;
      continue;
    }
    if (p.kind !== 3 || p.data === null) continue;
    const line = pktStr(p.data);
    if (sawDelim) args.push(line);
    else if (line.startsWith("command=")) command = line.slice(8);
    else if (command !== "") head.push(line); // agent= / object-format= (ignored)
    else args.push(line); // protocol v0 want/have/... lines
  }
  try {
    if (command === "ls-refs") return gitRes(200, ct, lsRefsResponse(ctx, repo, args));
    const lines = command === "" && !sawDelim ? [...head, ...args] : args;
    const f = parseFetchArgs(lines);
    const plan = computeSend(ctx.store, f.wants, f.haves, f.shallow, f.depth);
    return gitRes(200, ct, command === "" ? v0FetchResponse(ctx.store, plan) : v2FetchResponse(ctx.store, plan));
  } catch (e) {
    return { status: 500, body: "upload-pack error: " + String(e) };
  }
}

// ---------------------------------------------------------------------------
// receive-pack: push
// ---------------------------------------------------------------------------

interface PushCmd {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Command list pkt-lines up to the flush; the raw pack bytes follow it. */
function parsePushBody(body: Buffer): { cmds: PushCmd[]; caps: string; pack: Buffer } {
  const cmds: PushCmd[] = [];
  let caps = "";
  let off = 0;
  while (off + 4 <= body.length) {
    const len = parseInt(body.toString("ascii", off, off + 4), 16);
    if (!Number.isFinite(len)) throw new Error("bad pkt length at " + off);
    if (len === 0) {
      off += 4;
      break; // flush: the pack (if any) starts here
    }
    if (len < 4 || off + len > body.length) throw new Error("truncated pkt at " + off);
    let line = body.toString("utf8", off + 4, off + len);
    off += len;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    const nul = line.indexOf("\0");
    let capPart = "";
    if (nul >= 0) {
      capPart = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const sp1 = line.indexOf(" ");
    const sp2 = line.indexOf(" ", sp1 + 1);
    if (sp1 < 0 || sp2 < 0) throw new Error("bad push command line");
    cmds.push({ oldOid: line.slice(0, sp1), newOid: line.slice(sp1 + 1, sp2), ref: line.slice(sp2 + 1) });
    if (capPart) caps = capPart;
  }
  const pack = off < body.length ? body.subarray(off) : Buffer.alloc(0);
  return { cmds, caps, pack };
}

function handleReceivePack(ctx: Ctx, repo: Repo, req: Req): Res {
  let parsed: { cmds: PushCmd[]; caps: string; pack: Buffer };
  try {
    parsed = parsePushBody(req.body);
  } catch {
    return { status: 400, body: "malformed receive-pack body" };
  }
  const { cmds, caps, pack } = parsed;
  // Unpack first: a refused (non-ff) update still must report "unpack ok".
  let unpackOk = true;
  let unpackDetail = "ok";
  if (pack.length > 0) {
    try {
      const objs = parsePack(pack, (sha) => ctx.store.get(sha)); // thin-pack bases
      for (const o of objs) {
        if (!ctx.store.has(o.sha)) ctx.store.objs.set(o.sha, { type: o.type, data: o.data });
      }
    } catch {
      unpackOk = false;
      unpackDetail = "index-pack failed";
    }
  }
  const sideband = caps.split(" ").includes("side-band-64k");
  const report: string[] = [unpackOk ? "unpack ok\n" : "unpack " + unpackDetail + "\n"];
  // Verdicts are computed against the pre-push ref state, applied afterwards,
  // so one command list can mix ok and ng and only the ok refs move.
  const updates: Array<[string, string]> = [];
  const deletes: string[] = [];
  for (const cmd of cmds) {
    let ok = false;
    let reason = "non-fast-forward";
    if (!unpackOk) {
      reason = "unpacker error";
    } else if (cmd.newOid === ZERO_OID) {
      // delete (delete-refs advertised; the suite has no force mechanism)
      const cur = repo.refs.get(cmd.ref);
      if (cur !== undefined && (cmd.oldOid === ZERO_OID || cmd.oldOid === cur)) {
        ok = true;
        deletes.push(cmd.ref);
      }
    } else if (!ctx.store.has(cmd.newOid)) {
      reason = "missing objects";
    } else if (!repo.refs.has(cmd.ref)) {
      ok = true; // create: unborn branch, new branch, new tag
      updates.push([cmd.ref, cmd.newOid]);
    } else {
      const cur = repo.refs.get(cmd.ref)!;
      // compare-and-swap: a stale old value never moves the ref.
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cur) {
        reason = "non-fast-forward";
      } else if (isAncestor(ctx.store, cur, cmd.newOid)) {
        ok = true; // fast-forward
        updates.push([cmd.ref, cmd.newOid]);
      }
    }
    report.push(ok ? "ok " + cmd.ref + "\n" : "ng " + cmd.ref + " " + reason + "\n");
  }
  for (const d of deletes) repo.refs.delete(d);
  for (const [ref, oid] of updates) repo.refs.set(ref, oid);
  if (cmds.length > 0) repo.pushedAt = ctx.now();
  // report-status pkt-lines, framed in sideband band 1 when requested.
  const inner = Buffer.concat([...report.map((l) => pkt(l)), FLUSH]);
  const body = sideband ? Buffer.concat([pkt(Buffer.concat([BAND1, inner])), FLUSH]) : inner;
  return gitRes(200, "application/x-git-receive-pack-result", body);
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** The git smart HTTP surface. Returns undefined when the path is not ours
 *  (app.ts then answers 404); never throws. */
export function routeGit(req: Req, ctx: Ctx): Res | undefined {
  try {
    const m = GIT_PATH.exec(req.path);
    if (!m) return undefined;
    const owner = m[1];
    const name = m[2];
    const tail = m[3];
    if (tail === "info/refs") {
      if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, body: "method not allowed" };
      const service = req.query.get("service") ?? "";
      if (service !== "git-upload-pack" && service !== "git-receive-pack") return notFound();
      const repo = getRepo(ctx, owner, name);
      if (!repo) return notFound();
      if (service === "git-receive-pack") {
        // receive-pack is v0 only, Git-Protocol header or not.
        return gitRes(200, "application/x-git-receive-pack-advertisement", v0Advertisement(ctx, repo, "git-receive-pack"));
      }
      const proto = req.headers.get("git-protocol") ?? "";
      if (proto.includes("version=2")) {
        return gitRes(200, "application/x-git-upload-pack-advertisement", V2_ADV);
      }
      return gitRes(200, "application/x-git-upload-pack-advertisement", v0Advertisement(ctx, repo, "git-upload-pack"));
    }
    if (req.method !== "POST") return { status: 405, body: "method not allowed" };
    const repo = getRepo(ctx, owner, name);
    if (!repo) return notFound();
    if (tail === "git-upload-pack") return handleUploadPack(ctx, repo, req);
    return handleReceivePack(ctx, repo, req);
  } catch (e) {
    return { status: 500, body: "git route error: " + String(e) };
  }
}

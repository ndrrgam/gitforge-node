// git object database: in-memory loose objects keyed by sha1, sha-correct.
// Types: blob=1 tree=2 commit=3 tag=4 (pack type ids); stored as strings here.
import { createHash } from "node:crypto";

export type ObjType = "blob" | "tree" | "commit" | "tag";
export interface GitObj { type: ObjType; data: Buffer; }

export class Store {
  objs = new Map<string, GitObj>();
  private hash = createHash;

  sha(type: ObjType, data: Buffer): string {
    const h = this.hash("sha1");
    h.update(type + " " + data.length + "\0");
    h.update(data);
    return h.digest("hex");
  }
  put(type: ObjType, data: Buffer): string {
    const sha = this.sha(type, data);
    if (!this.objs.has(sha)) this.objs.set(sha, { type, data });
    return sha;
  }
  get(sha: string): GitObj | undefined { return this.objs.get(sha); }
  has(sha: string): boolean { return this.objs.has(sha); }
  // make a tree object from entries [mode(string octal, e.g. "100644"), name, sha][]
  makeTree(entries: Array<[string, string, string]>): string {
    const parts: Buffer[] = [];
    for (const [mode, name, sha] of entries) {
      parts.push(Buffer.from(mode + " " + name + "\0", "utf8"), Buffer.from(sha, "hex"));
    }
    return this.put("tree", Buffer.concat(parts));
  }
  // parse tree entries -> [{mode,name,sha}]
  readTree(sha: string): Array<{ mode: string; name: string; sha: string }> {
    const o = this.objs.get(sha);
    if (!o || o.type !== "tree") return [];
    const out: Array<{ mode: string; name: string; sha: string }> = [];
    let off = 0;
    const d = o.data;
    while (off < d.length) {
      const sp = d.indexOf(0x20, off);
      const nul = d.indexOf(0, sp + 1);
      out.push({
        mode: d.toString("ascii", off, sp),
        name: d.toString("utf8", sp + 1, nul),
        sha: d.toString("hex", nul + 1, nul + 21),
      });
      off = nul + 21;
    }
    return out;
  }
  makeCommit(fields: { tree: string; parents: string[]; author: string; committer: string; message: string }): string {
    let body = "tree " + fields.tree + "\n";
    for (const p of fields.parents) body += "parent " + p + "\n";
    body += "author " + fields.author + "\n";
    body += "committer " + fields.committer + "\n";
    body += "\n" + fields.message + (fields.message.endsWith("\n") ? "" : "\n");
    return this.put("commit", Buffer.from(body, "utf8"));
  }
  readCommit(sha: string): { tree: string; parents: string[]; author: string; committer: string; message: string } | null {
    const o = this.objs.get(sha);
    if (!o || o.type !== "commit") return null;
    const t = o.data.toString("utf8");
    const tree = /tree ([0-9a-f]{40})/.exec(t)?.[1] ?? "";
    const parents = [...t.matchAll(/parent ([0-9a-f]{40})/g)].map((m) => m[1]);
    const author = /author (.*)\n/.exec(t)?.[1] ?? "";
    const committer = /committer (.*)\n/.exec(t)?.[1] ?? "";
    const idx = t.indexOf("\n\n");
    const message = idx >= 0 ? t.slice(idx + 2) : "";
    return { tree, parents, author, committer, message };
  }
  // Full closed set of object shas reachable from commit shas (depth-limited commits; trees/blobs always full).
  reachable(rootShas: string[], depth: number | null = null): Set<string> {
    const seen = new Set<string>();
    const stack: Array<{ sha: string; d: number }> = rootShas.map((s) => ({ sha: s, d: 0 }));
    const maxD = depth === null ? Infinity : depth - 1; // depth=1 -> only the root commit's objects
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c.sha)) continue;
      const co = this.readCommit(c.sha);
      if (!co) continue;
      seen.add(c.sha);
      this.walkTree(co.tree, seen);
      if (c.d < maxD) for (const p of co.parents) stack.push({ sha: p, d: c.d + 1 });
    }
    return seen;
  }
  private walkTree(treeSha: string, seen: Set<string>) {
    const tstack = [treeSha];
    while (tstack.length) {
      const ts = tstack.pop()!;
      if (seen.has(ts)) continue;
      const to = this.objs.get(ts);
      if (!to || to.type !== "tree") continue;
      seen.add(ts);
      for (const e of this.readTree(ts)) {
        if (e.mode === "040000" || e.mode === "40000") tstack.push(e.sha);
        else {
          if (!seen.has(e.sha) && this.objs.has(e.sha)) seen.add(e.sha);
        }
      }
    }
  }
}

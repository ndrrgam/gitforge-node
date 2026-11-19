// The REST v3 surface under /api/v3, per spec-rest.md (the 55 checks of checks-rest.ts):
// repos (create/list/patch/delete, pagination via Link, branches, commits, contents
// including the unborn first commit), labels, issues, pulls (create/list/files/merge with
// 404 unknown + 405 conflict), and the protocol rules: JSON everywhere, {message} errors,
// 401 without the bearer token, 404 for another owner's repository, 400 malformed JSON.
//
// Deterministic: every timestamp is ctx.now(), every id a ctx counter, no Date.now and no
// Math.random. Routing is split-based (no per-request regex) so the 2000-GET-issue
// benchmark stays cheap. Handlers never throw: routeRest catches and answers a JSON 500.

import {
  EPOCH,
  createRepo,
  getRepo,
  newIssue,
  newPull,
  type Ctx,
  type Issue,
  type Pull,
  type Repo,
} from "./db.ts";
import type { Store } from "./gitstore.ts";
import type { Req, Res } from "./http.ts";

type Json = Record<string, unknown>;

const FILE_MODE = "100644";
const DIR_MODE = "40000";
const HEX40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// Reply helpers: every reply is JSON and carries a non-empty X-GitHub-Request-Id.

function res(ctx: Ctx, status: number, body: unknown, extra: Array<[string, string]> = []): Res {
  return {
    status,
    headers: [
      ["Content-Type", "application/json; charset=utf-8"],
      ["X-GitHub-Request-Id", ctx.requestId()],
      ...extra,
    ],
    body: status === 204 ? undefined : JSON.stringify(body),
  };
}

function err(ctx: Ctx, status: number, message: string): Res {
  return res(ctx, status, { message });
}

/** The request's bearer token names the viewer; anything else is unauthenticated. */
function authed(req: Req, ctx: Ctx): boolean {
  if (ctx.token === "") return false;
  return req.headers.get("authorization") === "Bearer " + ctx.token;
}

/** Parse a JSON object body; null means malformed (-> 400). An absent body is {}. */
function parseBody(req: Req): Json | null {
  if (req.body.length === 0) return {};
  try {
    const value: unknown = JSON.parse(req.body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Json;
  } catch {
    return null;
  }
}

/** Auth + repository lookup: 401 without the token, 404 for anything the token cannot see. */
function openRepo(req: Req, ctx: Ctx, owner: string, name: string): { repo: Repo } | Res {
  if (!authed(req, ctx)) return err(ctx, 401, "Requires authentication");
  const repo = getRepo(ctx, owner, name);
  if (repo === undefined) return err(ctx, 404, "Not Found");
  return { repo };
}

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.owner + "/" + repo.name,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: 1000 },
    fork: false,
    created_at: repo.createdAt,
    pushed_at: repo.pushedAt,
  };
}

// ---------------------------------------------------------------------------
// Git tree plumbing (immutable upsert/remove of one path inside a tree).

function isDirEntry(entry: { mode: string }): boolean {
  return entry.mode === DIR_MODE || entry.mode === "040000";
}

/** Git tree order: names byte-wise, directories as if suffixed with "/". */
function sortEntries(entries: Array<{ mode: string; name: string; sha: string }>): void {
  entries.sort((a, b) => {
    const an = a.name + (isDirEntry(a) ? "/" : "");
    const bn = b.name + (isDirEntry(b) ? "/" : "");
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * Set `parts` to blob `blobSha` (or remove the file when null) inside the tree at
 * `treeSha`, building intermediate trees as needed, pruning directories that empty out.
 * Returns the new tree's sha; the input tree is never mutated.
 */
function upsertPath(store: Store, treeSha: string, parts: string[], blobSha: string | null): string {
  const name = parts[0] as string;
  const all = store.readTree(treeSha);
  const entries = all.filter((e) => e.name !== name);
  if (parts.length === 1) {
    if (blobSha !== null) entries.push({ mode: FILE_MODE, name, sha: blobSha });
    sortEntries(entries);
    return store.makeTree(entries.map((e): [string, string, string] => [e.mode, e.name, e.sha]));
  }
  const dir = all.find((e) => e.name === name && isDirEntry(e));
  const subSha = dir === undefined ? store.makeTree([]) : dir.sha;
  const newSub = upsertPath(store, subSha, parts.slice(1), blobSha);
  if (store.readTree(newSub).length > 0) entries.push({ mode: DIR_MODE, name, sha: newSub });
  sortEntries(entries);
  return store.makeTree(entries.map((e): [string, string, string] => [e.mode, e.name, e.sha]));
}

/** Look up one path in a tree: the entry (file or dir) or null when absent. */
function lookupPath(store: Store, treeSha: string, parts: string[]): { mode: string; sha: string } | null {
  let cur = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = store.readTree(cur);
    const entry = entries.find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { mode: entry.mode, sha: entry.sha };
    if (!isDirEntry(entry)) return null;
    cur = entry.sha;
  }
  return null;
}

/** Every file path -> blob sha under a commit's tree. */
function flattenTree(store: Store, treeSha: string, prefix: string, out: Map<string, string>): void {
  for (const entry of store.readTree(treeSha)) {
    if (isDirEntry(entry)) flattenTree(store, entry.sha, prefix + entry.name + "/", out);
    else out.set(prefix + entry.name, entry.sha);
  }
}

function treeOf(store: Store, commitSha: string): string {
  const commit = store.readCommit(commitSha);
  return commit === null ? "" : commit.tree;
}

/** Paths whose blob differs between two commits (null = removed by the `to` side). */
function changedFiles(store: Store, fromSha: string, toSha: string): Map<string, string | null> {
  const from = new Map<string, string>();
  const to = new Map<string, string>();
  flattenTree(store, treeOf(store, fromSha), "", from);
  flattenTree(store, treeOf(store, toSha), "", to);
  const out = new Map<string, string | null>();
  for (const [path, sha] of to) if (from.get(path) !== sha) out.set(path, sha);
  for (const [path] of from) if (!to.has(path)) out.set(path, null);
  return out;
}

/** The commit ident, from the fixed epoch: stable byte-for-byte across runs. */
function ident(ctx: Ctx): string {
  return ctx.viewer.login + " <" + ctx.viewer.login + "@example.invalid> " + EPOCH + " +0000";
}

function newCommit(store: Store, ctx: Ctx, tree: string, parents: string[], message: string): string {
  const who = ident(ctx);
  return store.makeCommit({ tree, parents, author: who, committer: who, message });
}

function countLines(data: Buffer | undefined): number {
  if (data === undefined || data.length === 0) return 0;
  const text = data.toString("utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Resolve a ref query param: a branch name, a full ref, or a raw commit sha. */
function resolveTip(store: Store, repo: Repo, ref: string): string | undefined {
  const byRef = repo.refs.get(ref.startsWith("refs/") ? ref : "refs/heads/" + ref);
  if (byRef !== undefined) return byRef;
  if (HEX40.test(ref)) {
    const lower = ref.toLowerCase();
    if (store.get(lower) !== undefined) return lower;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Numeric query helpers.

function clampInt(raw: string | null, dflt: number, lo: number, hi: number): number {
  if (raw === null) return dflt;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function parseUint(raw: string | undefined): number | null {
  if (raw === undefined || raw === "" || !/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Entry point.

export function routeRest(req: Req, ctx: Ctx): Res | Promise<Res> | undefined {
  const p = req.path;
  if (p !== "/api/v3" && !p.startsWith("/api/v3/")) return undefined;
  try {
    return route(ctx, req, p === "/api/v3" ? "/" : p.slice("/api/v3".length));
  } catch (e) {
    process.stderr.write("[rest] internal error: " + (e instanceof Error ? e.stack : String(e)) + "\n");
    return err(ctx, 500, "Internal server error");
  }
}

/** `rest` starts at "/": "/", "/meta", "/user/repos", "/repos/{o}/{r}/...". */
function route(ctx: Ctx, req: Req, rest: string): Res {
  const segs = rest.slice(1).split("/");
  const head = segs[0] as string;

  if (head === "") {
    if (req.method === "GET") return apiRoot(ctx);
    return err(ctx, 404, "Not Found");
  }
  if (head === "meta") {
    if (req.method === "GET") return res(ctx, 200, { installed_version: "1.0.0" });
    return err(ctx, 404, "Not Found");
  }
  if (head === "user") {
    if (segs[1] === "repos" && segs.length === 2) {
      if (req.method === "GET") return listUserRepos(req, ctx);
      if (req.method === "POST") return createUserRepo(req, ctx);
    }
    return err(ctx, 404, "Not Found");
  }
  if (head === "repos" && segs.length >= 3 && segs[1] !== "" && segs[2] !== "") {
    return routeRepo(req, ctx, segs[1] as string, segs[2] as string, segs.slice(3));
  }
  return err(ctx, 404, "Not Found");
}

function routeRepo(req: Req, ctx: Ctx, owner: string, name: string, tail: string[]): Res {
  const t0 = tail[0];
  if (t0 === undefined) {
    if (req.method === "GET") return getRepoRoute(req, ctx, owner, name);
    if (req.method === "PATCH") return patchRepo(req, ctx, owner, name);
    if (req.method === "DELETE") return deleteRepo(req, ctx, owner, name);
    return err(ctx, 404, "Not Found");
  }
  if (t0 === "git" && tail[1] === "refs" && tail.length === 2) {
    if (req.method === "POST") return createRef(req, ctx, owner, name);
    return err(ctx, 404, "Not Found");
  }
  if (t0 === "branches" && tail.length === 1) {
    if (req.method === "GET") return listBranches(req, ctx, owner, name);
    return err(ctx, 404, "Not Found");
  }
  if (t0 === "commits" && tail.length === 1) {
    if (req.method === "GET") return listCommits(req, ctx, owner, name);
    return err(ctx, 404, "Not Found");
  }
  if (t0 === "contents") {
    const path = tail.slice(1).join("/");
    if (req.method === "GET") return getContent(req, ctx, owner, name, path);
    if (req.method === "PUT") return putContent(req, ctx, owner, name, path);
    if (req.method === "DELETE") return deleteContent(req, ctx, owner, name, path);
    return err(ctx, 404, "Not Found");
  }
  if (t0 === "labels" && tail.length === 1) {
    if (req.method === "POST") return createLabel(req, ctx, owner, name);
    return err(ctx, 404, "Not Found");
  }
  if (t0 === "issues") return routeIssues(req, ctx, owner, name, tail.slice(1));
  if (t0 === "pulls") return routePulls(req, ctx, owner, name, tail.slice(1));
  return err(ctx, 404, "Not Found");
}

// ---------------------------------------------------------------------------
// /api/v3 root and /meta.

function apiRoot(ctx: Ctx): Res {
  return res(
    ctx,
    200,
    {
      current_user_url: "https://api.example.invalid/user",
      current_user_repositories_url: "https://api.example.invalid/user/repos{?type,page,per_page,sort}",
      repository_url: "https://api.example.invalid/repos/{owner}/{repo}",
      issue_url: "https://api.example.invalid/repos/{owner}/{repo}/issues{/number}",
      pulls_url: "https://api.example.invalid/repos/{owner}/{repo}/pulls{/number}",
      rate_limit_url: "https://api.example.invalid/rate_limit",
    },
    [["X-OAuth-Scopes", "repo, gist"]],
  );
}

// ---------------------------------------------------------------------------
// /user/repos.

function createUserRepo(req: Req, ctx: Ctx): Res {
  if (!authed(req, ctx)) return err(ctx, 401, "Requires authentication");
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const name = body["name"];
  if (typeof name !== "string" || name === "") return err(ctx, 422, "name is required");
  const priv = body["private"] === true;
  const description = typeof body["description"] === "string" ? (body["description"] as string) : "";
  if (getRepo(ctx, ctx.viewer.login, name) !== undefined) {
    return err(ctx, 422, "Repository creation failed: the name already exists on this account");
  }
  const repo = createRepo(ctx, ctx.viewer.login, name, priv, description);
  return res(ctx, 201, repoJson(repo));
}

/** The request's own origin, for the absolute URLs the Link header carries. */
function originOf(req: Req): string {
  const host = req.headers.get("host");
  return "http://" + (host === undefined || host === "" ? "localhost" : host);
}

function listUserRepos(req: Req, ctx: Ctx): Res {
  if (!authed(req, ctx)) return err(ctx, 401, "Requires authentication");
  const perPage = clampInt(req.query.get("per_page"), 30, 1, 100);
  const page = Math.max(1, clampInt(req.query.get("page"), 1, 1, 1 << 30));
  const all: Repo[] = [];
  const byName = ctx.repos.get(ctx.viewer.login);
  if (byName !== undefined) for (const repo of byName.values()) all.push(repo);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage).map(repoJson);
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const pageUrl = (n: number): string => originOf(req) + "/api/v3/user/repos?per_page=" + perPage + "&page=" + n;
  const links: string[] = [];
  if (page < lastPage) links.push("<" + pageUrl(page + 1) + ">; rel=\"next\"");
  if (page > 1) links.push("<" + pageUrl(page - 1) + ">; rel=\"prev\"");
  links.push("<" + pageUrl(1) + ">; rel=\"first\"");
  if (page < lastPage) links.push("<" + pageUrl(lastPage) + ">; rel=\"last\"");
  const extra: Array<[string, string]> = links.length > 0 ? [["Link", links.join(", ")]] : [];
  return res(ctx, 200, items, extra);
}

// ---------------------------------------------------------------------------
// /repos/{o}/{r}.

function getRepoRoute(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  return res(ctx, 200, repoJson(opened.repo));
}

function patchRepo(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const description = body["description"];
  if (typeof description === "string") opened.repo.description = description;
  return res(ctx, 200, repoJson(opened.repo));
}

function deleteRepo(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const byName = ctx.repos.get(owner);
  if (byName !== undefined) byName.delete(name);
  return res(ctx, 204, null);
}

// ---------------------------------------------------------------------------
// Branches and commits.

function createRef(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const ref = body["ref"];
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || ref === "refs/heads/") {
    return err(ctx, 422, "ref must be a fully qualified reference beginning with refs/heads/");
  }
  const sha = body["sha"];
  if (typeof sha !== "string" || !HEX40.test(sha)) return err(ctx, 422, "sha must be a 40-character commit id");
  const object = ctx.store.get(sha.toLowerCase());
  if (object === undefined || object.type !== "commit") return err(ctx, 422, "Object does not exist");
  if (opened.repo.refs.has(ref)) return err(ctx, 422, "Reference already exists");
  opened.repo.refs.set(ref, sha);
  return res(ctx, 201, { ref, object: { sha, type: "commit" } });
}

function listBranches(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const out: Json[] = [];
  for (const [ref, sha] of opened.repo.refs) {
    if (!ref.startsWith("refs/heads/")) continue;
    out.push({ name: ref.slice("refs/heads/".length), commit: { sha } });
  }
  return res(ctx, 200, out);
}

function commitEntry(store: Store, ctx: Ctx, sha: string): Json {
  const commit = store.readCommit(sha);
  const message = commit === null ? "" : commit.message.endsWith("\n") ? commit.message.slice(0, -1) : commit.message;
  const author = commit === null ? "" : commit.author;
  const lt = author.indexOf("<");
  const gt = author.indexOf(">");
  const who = lt > 0 && gt > lt ? author.slice(lt + 1, gt) : "";
  const tail = gt > lt ? author.slice(gt + 1).trim() : "";
  const space = tail.indexOf(" ");
  const unix = space > 0 ? tail.slice(0, space) : tail;
  const date = unix !== "" ? new Date(parseInt(unix, 10) * 1000).toISOString() : "";
  const person = { name: ctx.viewer.login, email: who, date };
  return { message, author: person, committer: person };
}

function listCommits(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const store = ctx.store;
  const ref = req.query.get("sha") ?? opened.repo.defaultBranch;
  if (opened.repo.refs.size === 0) return res(ctx, 200, []);
  let tip = resolveTip(store, opened.repo, ref);
  if (tip === undefined) return err(ctx, 404, "No commit found for " + ref);
  const out: Json[] = [];
  while (tip !== undefined && out.length < 10000) {
    const commit = store.readCommit(tip);
    if (commit === null) break;
    out.push({ sha: tip, commit: commitEntry(store, ctx, tip), parents: commit.parents });
    tip = commit.parents[0];
  }
  return res(ctx, 200, out);
}

// ---------------------------------------------------------------------------
// /contents.

function getContent(req: Req, ctx: Ctx, owner: string, name: string, path: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const store = ctx.store;
  const ref = req.query.get("ref") ?? opened.repo.defaultBranch;
  if (opened.repo.refs.size === 0) return err(ctx, 404, "This repository is empty.");
  const tip = resolveTip(store, opened.repo, ref);
  if (tip === undefined) return err(ctx, 404, "No reference found for " + ref);
  const commit = store.readCommit(tip);
  if (commit === null) return err(ctx, 404, "Not Found");
  if (path === "") return res(ctx, 200, dirEntries(store, commit.tree, ""));
  const parts = path.split("/");
  let treeSha = commit.tree;
  for (let i = 0; i < parts.length; i += 1) {
    const entry = store.readTree(treeSha).find((e) => e.name === parts[i]);
    if (entry === undefined) return err(ctx, 404, "Not Found");
    if (i === parts.length - 1) {
      if (isDirEntry(entry)) return res(ctx, 200, dirEntries(store, entry.sha, path));
      const blob = store.get(entry.sha);
      if (blob === undefined) return err(ctx, 404, "Not Found");
      return res(ctx, 200, {
        type: "file",
        encoding: "base64",
        name: entry.name,
        path,
        sha: entry.sha,
        size: blob.data.length,
        content: blob.data.toString("base64"),
      });
    }
    if (!isDirEntry(entry)) return err(ctx, 404, "Not Found");
    treeSha = entry.sha;
  }
  return err(ctx, 404, "Not Found");
}

function dirEntries(store: Store, treeSha: string, path: string): Json[] {
  const out: Json[] = [];
  for (const entry of store.readTree(treeSha)) {
    out.push({
      type: isDirEntry(entry) ? "dir" : "file",
      name: entry.name,
      path: path === "" ? entry.name : path + "/" + entry.name,
      sha: entry.sha,
    });
  }
  return out;
}

function contentCommit(blobSha: string, commitSha: string): Json {
  return { content: { sha: blobSha, encoding: "base64" }, commit: { sha: commitSha } };
}

function putContent(req: Req, ctx: Ctx, owner: string, name: string, path: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const message = body["message"];
  if (typeof message !== "string" || message === "") return err(ctx, 422, "message is required");
  const content = body["content"];
  if (typeof content !== "string") return err(ctx, 422, "content is required");
  if (path === "") return err(ctx, 422, "path is required");
  const repo = opened.repo;
  const store = ctx.store;
  const branch = typeof body["branch"] === "string" && body["branch"] !== "" ? (body["branch"] as string) : repo.defaultBranch;
  const refKey = "refs/heads/" + branch;
  const parts = path.split("/");
  const buf = Buffer.from(content, "base64");
  const blobSha = store.put("blob", buf);
  const tip = repo.refs.get(refKey);

  if (tip === undefined) {
    // Unborn repository (or branch): this PUT creates the first commit.
    const treeSha = upsertPath(store, store.makeTree([]), parts, blobSha);
    const commitSha = newCommit(store, ctx, treeSha, [], message);
    repo.refs.set(refKey, commitSha);
    repo.pushedAt = ctx.now();
    return res(ctx, 201, contentCommit(blobSha, commitSha));
  }

  const tipCommit = store.readCommit(tip);
  if (tipCommit === null) return err(ctx, 500, "corrupt commit history");
  const existing = lookupPath(store, tipCommit.tree, parts);
  if (existing !== null && !isDirEntry(existing)) {
    const given = body["sha"];
    if (given === undefined) return err(ctx, 422, "sha wasn't supplied: the file already exists");
    if (typeof given !== "string" || given.toLowerCase() !== existing.sha.toLowerCase()) {
      return err(ctx, 409, "The sha parameter entered did not match the current file sha");
    }
  } else if (existing !== null) {
    return err(ctx, 409, "A directory already exists at the given path");
  }
  const treeSha = upsertPath(store, tipCommit.tree, parts, blobSha);
  const commitSha = newCommit(store, ctx, treeSha, [tip], message);
  repo.refs.set(refKey, commitSha);
  repo.pushedAt = ctx.now();
  return res(ctx, existing === null ? 201 : 200, contentCommit(blobSha, commitSha));
}

function deleteContent(req: Req, ctx: Ctx, owner: string, name: string, path: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const message = body["message"];
  if (typeof message !== "string" || message === "") return err(ctx, 422, "message is required");
  const repo = opened.repo;
  const store = ctx.store;
  const branch = typeof body["branch"] === "string" && body["branch"] !== "" ? (body["branch"] as string) : repo.defaultBranch;
  const refKey = "refs/heads/" + branch;
  const tip = repo.refs.get(refKey);
  if (tip === undefined) return err(ctx, 404, "This repository is empty.");
  const tipCommit = store.readCommit(tip);
  if (tipCommit === null) return err(ctx, 500, "corrupt commit history");
  if (path === "") return err(ctx, 422, "path is required");
  const parts = path.split("/");
  const existing = lookupPath(store, tipCommit.tree, parts);
  if (existing === null || isDirEntry(existing)) return err(ctx, 404, "Not Found");
  const given = body["sha"];
  if (typeof given !== "string" || given.toLowerCase() !== existing.sha.toLowerCase()) {
    return err(ctx, 409, "The sha parameter entered did not match the current file sha");
  }
  const treeSha = upsertPath(store, tipCommit.tree, parts, null);
  const commitSha = newCommit(store, ctx, treeSha, [tip], message);
  repo.refs.set(refKey, commitSha);
  repo.pushedAt = ctx.now();
  return res(ctx, 200, { content: { sha: existing.sha, encoding: "base64" }, commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------
// Labels.

function createLabel(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const labelName = body["name"];
  if (typeof labelName !== "string" || labelName === "") return err(ctx, 422, "name is required");
  const color = typeof body["color"] === "string" ? (body["color"] as string) : "ededed";
  const existing = opened.repo.labels.find((l) => l.name === labelName);
  if (existing === undefined) opened.repo.labels.push({ name: labelName, color });
  else existing.color = color;
  return res(ctx, 201, { name: labelName, color, default: false });
}

// ---------------------------------------------------------------------------
// Issues.

function issueJson(repo: Repo, issue: Issue): Json {
  const labels = issue.labels.map((label): Json => {
    const found = repo.labels.find((l) => l.name === label);
    return { name: label, color: found === undefined ? "ededed" : found.color };
  });
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: issue.user },
    created_at: issue.created_at,
    closed_at: issue.closed_at === undefined ? null : issue.closed_at,
    comments: issue.comments.length,
  };
}

function routeIssues(req: Req, ctx: Ctx, owner: string, name: string, tail: string[]): Res {
  if (tail.length === 0) {
    if (req.method === "GET") return listIssues(req, ctx, owner, name);
    if (req.method === "POST") return createIssue(req, ctx, owner, name);
    return err(ctx, 404, "Not Found");
  }
  const num = parseUint(tail[0]);
  if (num === null) return err(ctx, 404, "Not Found");
  if (tail.length === 1) {
    if (req.method === "GET") return getIssue(req, ctx, owner, name, num);
    if (req.method === "PATCH") return patchIssue(req, ctx, owner, name, num);
    return err(ctx, 404, "Not Found");
  }
  if (tail[1] === "comments" && tail.length === 2) {
    if (req.method === "GET") return listComments(req, ctx, owner, name, num);
    if (req.method === "POST") return createComment(req, ctx, owner, name, num);
  }
  return err(ctx, 404, "Not Found");
}

function createIssue(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const title = body["title"];
  if (typeof title !== "string" || title === "") return err(ctx, 422, "Issues must have a title");
  const bodyText = typeof body["body"] === "string" ? (body["body"] as string) : "";
  const labels: string[] = [];
  const wanted = body["labels"];
  if (wanted !== undefined) {
    if (!Array.isArray(wanted)) return err(ctx, 422, "labels must be an array of names");
    for (const label of wanted) {
      if (typeof label !== "string") return err(ctx, 422, "labels must be an array of names");
      labels.push(label);
    }
    for (const label of labels) {
      if (!opened.repo.labels.some((l) => l.name === label)) {
        return err(ctx, 422, "Label \"" + label + "\" does not exist within this repository");
      }
    }
  }
  const issue = newIssue(ctx, opened.repo, title, bodyText, labels);
  return res(ctx, 201, issueJson(opened.repo, issue));
}

function listIssues(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const stateQ = req.query.get("state") ?? "open";
  const want = stateQ === "all" ? null : stateQ === "closed" ? "closed" : "open";
  let list = opened.repo.issues.filter((i) => want === null || i.state === want);
  const direction = req.query.get("direction") === "asc" ? "asc" : "desc";
  if (direction === "desc") list = [...list].reverse();
  const perPage = clampInt(req.query.get("per_page"), 30, 1, 100);
  const page = Math.max(1, clampInt(req.query.get("page"), 1, 1, 1 << 30));
  const start = (page - 1) * perPage;
  return res(ctx, 200, list.slice(start, start + perPage).map((i) => issueJson(opened.repo, i)));
}

function getIssue(req: Req, ctx: Ctx, owner: string, name: string, num: number): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const issue = opened.repo.issues.find((i) => i.number === num);
  if (issue === undefined) return err(ctx, 404, "Not Found");
  return res(ctx, 200, issueJson(opened.repo, issue));
}

function patchIssue(req: Req, ctx: Ctx, owner: string, name: string, num: number): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const issue = opened.repo.issues.find((i) => i.number === num);
  if (issue === undefined) return err(ctx, 404, "Not Found");
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const state = body["state"];
  if (state !== undefined) {
    if (state !== "open" && state !== "closed") return err(ctx, 422, "state must be open or closed");
    issue.state = state;
    if (state === "closed") {
      if (issue.closed_at === undefined) issue.closed_at = ctx.now();
    } else {
      issue.closed_at = undefined;
    }
  }
  const title = body["title"];
  if (typeof title === "string" && title !== "") issue.title = title;
  const bodyText = body["body"];
  if (typeof bodyText === "string") issue.body = bodyText;
  return res(ctx, 200, issueJson(opened.repo, issue));
}

function commentJson(comment: { id: number; body: string; user: string; created_at: string }): Json {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user },
    created_at: comment.created_at,
  };
}

function createComment(req: Req, ctx: Ctx, owner: string, name: string, num: number): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const issue = opened.repo.issues.find((i) => i.number === num);
  if (issue === undefined) return err(ctx, 404, "Not Found");
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const text = body["body"];
  if (typeof text !== "string" || text === "") return err(ctx, 422, "body is required");
  const comment = { id: ctx.commentId(), body: text, user: ctx.viewer.login, created_at: ctx.now() };
  issue.comments.push(comment);
  return res(ctx, 201, commentJson(comment));
}

function listComments(req: Req, ctx: Ctx, owner: string, name: string, num: number): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const issue = opened.repo.issues.find((i) => i.number === num);
  if (issue === undefined) return err(ctx, 404, "Not Found");
  return res(ctx, 200, issue.comments.map(commentJson));
}

// ---------------------------------------------------------------------------
// Pulls.

function pullJson(pull: Pull): Json {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    user: { login: pull.user },
    created_at: pull.created_at,
    merged: pull.merged,
    merged_at: pull.merged_at === undefined ? null : pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha === undefined ? null : pull.merge_commit_sha,
    closed_at: pull.closed_at === undefined ? null : pull.closed_at,
    draft: false,
  };
}

function routePulls(req: Req, ctx: Ctx, owner: string, name: string, tail: string[]): Res {
  if (tail.length === 0) {
    if (req.method === "GET") return listPulls(req, ctx, owner, name);
    if (req.method === "POST") return createPull(req, ctx, owner, name);
    return err(ctx, 404, "Not Found");
  }
  const num = parseUint(tail[0]);
  if (num === null) return err(ctx, 404, "Not Found");
  if (tail.length === 1) {
    if (req.method === "GET") return getPull(req, ctx, owner, name, num);
    return err(ctx, 404, "Not Found");
  }
  if (tail[1] === "files" && tail.length === 2) {
    if (req.method === "GET") return pullFiles(req, ctx, owner, name, num);
    return err(ctx, 404, "Not Found");
  }
  if (tail[1] === "merge" && tail.length === 2) {
    if (req.method === "PUT") return mergePull(req, ctx, owner, name, num);
    return err(ctx, 404, "Not Found");
  }
  return err(ctx, 404, "Not Found");
}

function createPull(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  const title = body["title"];
  if (typeof title !== "string" || title === "") return err(ctx, 422, "title is required");
  const bodyText = typeof body["body"] === "string" ? (body["body"] as string) : "";
  const headRaw = body["head"];
  const baseRaw = body["base"];
  if (typeof headRaw !== "string" || headRaw === "" || typeof baseRaw !== "string" || baseRaw === "") {
    return err(ctx, 422, "head and base are required");
  }
  const head = headRaw.startsWith("refs/heads/") ? headRaw.slice("refs/heads/".length) : headRaw;
  const base = baseRaw.startsWith("refs/heads/") ? baseRaw.slice("refs/heads/".length) : baseRaw;
  const headSha = opened.repo.refs.get("refs/heads/" + head);
  const baseSha = opened.repo.refs.get("refs/heads/" + base);
  if (headSha === undefined) return err(ctx, 422, "The head branch does not exist");
  if (baseSha === undefined) return err(ctx, 422, "The base branch does not exist");
  const pull = newPull(ctx, opened.repo, title, bodyText, head, headSha, base, baseSha);
  return res(ctx, 201, pullJson(pull));
}

function listPulls(req: Req, ctx: Ctx, owner: string, name: string): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const stateQ = req.query.get("state") ?? "open";
  const want = stateQ === "all" ? null : stateQ === "closed" ? "closed" : "open";
  let list = opened.repo.pulls.filter((p) => want === null || p.state === want);
  const direction = req.query.get("direction") === "asc" ? "asc" : "desc";
  if (direction === "desc") list = [...list].reverse();
  const perPage = clampInt(req.query.get("per_page"), 30, 1, 100);
  const page = Math.max(1, clampInt(req.query.get("page"), 1, 1, 1 << 30));
  const start = (page - 1) * perPage;
  return res(ctx, 200, list.slice(start, start + perPage).map(pullJson));
}

function getPull(req: Req, ctx: Ctx, owner: string, name: string, num: number): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const pull = opened.repo.pulls.find((p) => p.number === num);
  if (pull === undefined) return err(ctx, 404, "Not Found");
  return res(ctx, 200, pullJson(pull));
}

function pullFiles(req: Req, ctx: Ctx, owner: string, name: string, num: number): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const pull = opened.repo.pulls.find((p) => p.number === num);
  if (pull === undefined) return err(ctx, 404, "Not Found");
  const store = ctx.store;
  const headTip = opened.repo.refs.get("refs/heads/" + pull.head.ref) ?? pull.head.sha;
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  flattenTree(store, treeOf(store, headTip), "", headFiles);
  flattenTree(store, treeOf(store, pull.base.sha), "", baseFiles);
  const out: Json[] = [];
  for (const [path, sha] of headFiles) {
    const baseSha = baseFiles.get(path);
    if (baseSha === sha) continue;
    const additions = countLines(store.get(sha)?.data);
    const deletions = baseSha === undefined ? 0 : countLines(store.get(baseSha)?.data);
    out.push({
      filename: path,
      status: baseSha === undefined ? "added" : "modified",
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  out.sort((a, b) => ((a["filename"] as string) < (b["filename"] as string) ? -1 : 1));
  return res(ctx, 200, out);
}

function mergePull(req: Req, ctx: Ctx, owner: string, name: string, num: number): Res {
  const opened = openRepo(req, ctx, owner, name);
  if (!("repo" in opened)) return opened;
  const pull = opened.repo.pulls.find((p) => p.number === num);
  if (pull === undefined) return err(ctx, 404, "Not Found");
  const body = parseBody(req);
  if (body === null) return err(ctx, 400, "Problems parsing JSON");
  if (pull.state !== "open") return err(ctx, 405, "Pull request is not open");
  const repo = opened.repo;
  const store = ctx.store;
  const headTip = repo.refs.get("refs/heads/" + pull.head.ref);
  const baseTip = repo.refs.get("refs/heads/" + pull.base.ref);
  if (headTip === undefined || baseTip === undefined) return err(ctx, 405, "Pull request cannot be merged");

  let tree: string;
  if (baseTip === pull.base.sha) {
    // The base has not moved: every head change applies cleanly.
    tree = treeOf(store, headTip);
  } else {
    // The base moved since the pull was opened: reject paths both sides changed
    // (or the head removed that the base changed), otherwise overlay the head's
    // changes on the current base tree.
    const headChanges = changedFiles(store, pull.base.sha, headTip);
    const baseChanges = changedFiles(store, pull.base.sha, baseTip);
    for (const path of headChanges.keys()) {
      if (baseChanges.has(path)) return err(ctx, 405, "Merge conflict: the base branch changed the same files");
    }
    tree = treeOf(store, baseTip);
    for (const [path, sha] of headChanges) {
      tree = upsertPath(store, tree, path.split("/"), sha);
    }
  }
  const title = typeof body["commit_title"] === "string" && body["commit_title"] !== ""
    ? (body["commit_title"] as string)
    : "Merge pull request #" + pull.number + " from " + repo.owner + "/" + pull.head.ref;
  const mergeSha = newCommit(store, ctx, tree, [baseTip, headTip], title);
  repo.refs.set("refs/heads/" + pull.base.ref, mergeSha);
  repo.pushedAt = ctx.now();
  pull.state = "closed";
  pull.merged = true;
  pull.merged_at = ctx.now();
  pull.closed_at = pull.merged_at;
  pull.merge_commit_sha = mergeSha;
  return res(ctx, 200, { merged: true, sha: mergeSha, message: "Pull request successfully merged" });
}

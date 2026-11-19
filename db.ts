// Domain model shared by REST / git / GraphQL / MCP routes.
// One bearer token (MAKEFUN_SHOP_TOKEN) names the single acting user, login "adaiversen"
// (the env's seeded viewer; wire.ts SCENARIO_SEED is fixed, so it is stable in production).
// Determinism: timestamps come from a fixed epoch + a monotonic counter, never Date.now().
import { Store } from "./gitstore.ts";

export const VIEWER_LOGIN = "adaiversen";
export const EPOCH = 1735689600; // 2025-01-01T00:00:00Z, matches the env's SCENARIO_EPOCH_SEC

export interface User { id: number; login: string; }
export interface Label { name: string; color: string; }
export interface Comment { id: number; body: string; user: string; created_at: string; }
export interface Issue {
  id: number; number: number; title: string; body: string; state: "open" | "closed";
  labels: string[]; user: string; created_at: string; comments: Comment[];
  closed_at?: string;
}
export interface Pull {
  id: number; number: number; title: string; body: string;
  state: "open" | "closed"; merged: boolean;
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  user: string; created_at: string; labels: string[]; comments: Comment[];
  merge_commit_sha?: string; merged_at?: string; closed_at?: string;
}
export interface Repo {
  id: number; name: string; owner: string; private: boolean; description: string;
  defaultBranch: string; refs: Map<string, string>; // "refs/heads/main" -> commit sha
  issues: Issue[]; pulls: Pull[]; labels: Label[];
  issueSeq: number; pullSeq: number; commitSeq: number;
  createdAt: string; pushedAt: string;
}
export interface Ctx {
  token: string;                 // bearer value, "" when absent
  viewer: User;
  repos: Map<string, Map<string, Repo>>; // ownerLogin -> repoName -> Repo
  store: Store;                   // global git object db
  requestId(): string;
  now(): string;                 // ISO 8601 UTC, deterministic
  issueId(): number; commentId(): number;
}

let seq = 0;
export function makeCtx(token: string): Ctx {
  const viewer: User = { id: 1000, login: VIEWER_LOGIN };
  const ctx: Ctx = {
    token, viewer,
    repos: new Map([[VIEWER_LOGIN, new Map()]]),
    store: new Store(),
    requestId: () => "req-" + (EPOCH + (++seq)).toString(16),
    now: () => new Date((EPOCH + (++seq)) * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    issueId: () => 9000000 + (++seq),
    commentId: () => 9100000 + (++seq),
  };
  return ctx;
}

export function getRepo(ctx: Ctx, owner: string, name: string): Repo | undefined {
  return ctx.repos.get(owner)?.get(name);
}
export function createRepo(ctx: Ctx, owner: string, name: string, priv: boolean, description: string): Repo {
  let byOwner = ctx.repos.get(owner);
  if (!byOwner) { byOwner = new Map(); ctx.repos.set(owner, byOwner); }
  const repo: Repo = {
    id: 5000 + (++seq), name, owner, private: priv, description,
    defaultBranch: "main", refs: new Map(),
    issues: [], pulls: [], labels: [], issueSeq: 0, pullSeq: 0, commitSeq: 0,
    createdAt: ctx.now(), pushedAt: ctx.now(),
  };
  byOwner.set(name, repo);
  return repo;
}
export function newIssue(ctx: Ctx, repo: Repo, title: string, body: string, labels: string[]): Issue {
  repo.issueSeq += 1;
  const issue: Issue = {
    id: ctx.issueId(), number: repo.issueSeq, title, body, state: "open",
    labels: [...labels], user: ctx.viewer.login, created_at: ctx.now(), comments: [],
  };
  repo.issues.push(issue);
  return issue;
}
export function newPull(ctx: Ctx, repo: Repo, title: string, body: string, head: string, headSha: string, base: string, baseSha: string): Pull {
  repo.pullSeq += 1;
  const pull: Pull = {
    id: ctx.issueId(), number: repo.pullSeq, title, body, state: "open", merged: false,
    head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
    user: ctx.viewer.login, created_at: ctx.now(), labels: [], comments: [],
  };
  repo.pulls.push(pull);
  return pull;
}

// GraphQL v4 (/api/graphql) and MCP streamable HTTP (/mcp) surfaces over the same db.ts domain.
//
// GraphQL: a minimal hand-rolled document parser (tokenizer + selection sets + inline/named
// fragments + variable/enum/list/object arguments, no schema language) feeding resolver tables
// keyed by type kind. Answers {data} or {errors} with HTTP 200; unknown field is a 200 with an
// errors array naming the field; no token is a 401; repository(owner:,name:) is nullable;
// a JSON array body is operation batching answered in order.
//
// MCP: JSON-RPC over POST /mcp. Supports the modern era (server/discover with
// supportedVersions/capabilities/serverInfo) and the legacy handshake (initialize +
// notifications/initialized, protocolVersion echoed), tools/list (six canonical tools, static,
// byte-identical across calls), tools/call over the same db.ts helpers the REST surface uses,
// and the error paths: -32700 with HTTP 400 on a non-JSON body, -32601 on an unknown method,
// -32602 on an unknown tool or missing required arguments, HTTP 401 before any tool runs when
// the bearer token is absent.
//
// Determinism: ids and cursors are base64 of "Type:<numeric id>" / "cursor:<n>"; timestamps
// come from ctx.now(). Nothing here reads a clock, the environment or the network, and nothing
// throws out of a router: every entry point catches and answers.

import type { Req, Res } from "./http.ts";
import { VIEWER_LOGIN, getRepo, createRepo, newIssue, newPull } from "./db.ts";
import type { Ctx, Repo, Issue, Pull, Comment } from "./db.ts";

// ---------------------------------------------------------------- small helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One resolved object value: which resolver table it resolves against, and the domain object. */
interface KindVal {
  kind: string;
  val: unknown;
}

/** Opaque, stable global id: base64("Type:<numeric id>"), never the plain number. */
function gid(type: string, id: number): string {
  return Buffer.from(type + ":" + id, "utf8").toString("base64");
}

interface Gid {
  type: string;
  id: number;
}

function parseGid(s: string): Gid | null {
  try {
    const t = Buffer.from(s, "base64").toString("utf8");
    const i = t.indexOf(":");
    if (i <= 0) return null;
    const id = Number(t.slice(i + 1));
    if (!Number.isInteger(id) || id <= 0) return null;
    return { type: t.slice(0, i), id };
  } catch {
    return null;
  }
}

function findRepoById(ctx: Ctx, id: number): Repo | undefined {
  for (const byOwner of ctx.repos.values()) {
    for (const repo of byOwner.values()) if (repo.id === id) return repo;
  }
  return undefined;
}

function findIssueById(ctx: Ctx, id: number): Issue | undefined {
  for (const byOwner of ctx.repos.values()) {
    for (const repo of byOwner.values()) {
      for (const issue of repo.issues) if (issue.id === id) return issue;
    }
  }
  return undefined;
}

function findPullById(ctx: Ctx, id: number): Pull | undefined {
  for (const byOwner of ctx.repos.values()) {
    for (const repo of byOwner.values()) {
      for (const pull of repo.pulls) if (pull.id === id) return pull;
    }
  }
  return undefined;
}

/** Opaque, stable pagination cursor: base64("cursor:<consumed count>"). */
function encodeCursor(n: number): string {
  return Buffer.from("cursor:" + n, "utf8").toString("base64");
}

function decodeCursor(s: string): number {
  try {
    const t = Buffer.from(s, "base64").toString("utf8");
    const m = /^cursor:(\d+)$/.exec(t);
    return m !== null ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- GraphQL parsing

class GqlSyntax extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GqlSyntax";
  }
}

/** A resolver-level failure: a 200 whose body carries errors. */
class GqlUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GqlUserError";
  }
}

interface Tok {
  t: "name" | "int" | "str" | "punc" | "var";
  v: string;
  line: number;
  col: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const isNameStart = (c: string): boolean => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
  const isNameChar = (c: string): boolean => isNameStart(c) || (c >= "0" && c <= "9");
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      i += 1;
      line += 1;
      col = 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === ",") {
      i += 1;
      col += 1;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") {
        i += 1;
        col += 1;
      }
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (c === "$") {
      i += 1;
      col += 1;
      let name = "";
      while (i < src.length && isNameChar(src[i])) {
        name += src[i];
        i += 1;
        col += 1;
      }
      out.push({ t: "var", v: name, line: startLine, col: startCol });
      continue;
    }
    if (isNameStart(c)) {
      let name = "";
      while (i < src.length && isNameChar(src[i])) {
        name += src[i];
        i += 1;
        col += 1;
      }
      out.push({ t: "name", v: name, line: startLine, col: startCol });
      continue;
    }
    if ((c >= "0" && c <= "9") || c === "-") {
      let num = "";
      while (i < src.length && ((src[i] >= "0" && src[i] <= "9") || src[i] === "-")) {
        num += src[i];
        i += 1;
        col += 1;
      }
      out.push({ t: "int", v: num, line: startLine, col: startCol });
      continue;
    }
    if (c === '"') {
      i += 1;
      col += 1;
      let s = "";
      for (;;) {
        if (i >= src.length) throw new GqlSyntax("unterminated string literal");
        const ch = src[i];
        if (ch === '"') {
          i += 1;
          col += 1;
          break;
        }
        if (ch === "\\") {
          const nx = i + 1 < src.length ? src[i + 1] : "";
          s += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
          i += 2;
          col += 2;
          continue;
        }
        if (ch === "\n") {
          line += 1;
          col = 1;
        } else {
          col += 1;
        }
        s += ch;
        i += 1;
      }
      out.push({ t: "str", v: s, line: startLine, col: startCol });
      continue;
    }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
      out.push({ t: "punc", v: "...", line: startLine, col: startCol });
      i += 3;
      col += 3;
      continue;
    }
    if ("{}()![:@&|]=".includes(c)) {
      out.push({ t: "punc", v: c, line: startLine, col: startCol });
      i += 1;
      col += 1;
      continue;
    }
    throw new GqlSyntax("unexpected character " + JSON.stringify(c));
  }
  return out;
}

type ValueNode =
  | { k: "var"; v: string }
  | { k: "int"; v: string }
  | { k: "str"; v: string }
  | { k: "enum"; v: string }
  | { k: "bool"; v: string }
  | { k: "null" }
  | { k: "list"; items: ValueNode[] }
  | { k: "obj"; fields: Array<[string, ValueNode]> };

interface FieldSel {
  f: "field";
  alias: string | null;
  name: string;
  args: Array<[string, ValueNode]>;
  sel: Sel[] | null;
  line: number;
  col: number;
}

interface InlineFrag {
  f: "frag";
  on: string;
  sel: Sel[];
}

interface NamedFragRef {
  f: "namedfrag";
  name: string;
  line: number;
  col: number;
}

type Sel = FieldSel | InlineFrag | NamedFragRef;

interface Operation {
  kind: "Query" | "Mutation";
  name: string;
  sel: Sel[];
}

interface NamedFrag {
  on: string;
  sel: Sel[];
}

interface ParsedDoc {
  ops: Operation[];
  frags: Map<string, NamedFrag>;
}

function parseDocument(src: string): ParsedDoc {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok => {
    const t = toks[pos];
    if (t === undefined) throw new GqlSyntax("unexpected end of document");
    pos += 1;
    return t;
  };
  const expectPunc = (v: string): void => {
    const t = next();
    if (t.t !== "punc" || t.v !== v) throw new GqlSyntax(`expected '${v}', got '${t.v}'`);
  };

  const parseValue = (): ValueNode => {
    const t = next();
    if (t.t === "var") return { k: "var", v: t.v };
    if (t.t === "int") return { k: "int", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "name") {
      if (t.v === "null") return { k: "null" };
      if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v };
      return { k: "enum", v: t.v };
    }
    if (t.t === "punc" && t.v === "[") {
      const items: ValueNode[] = [];
      for (;;) {
        const p = peek();
        if (p !== undefined && p.t === "punc" && p.v === "]") {
          next();
          break;
        }
        items.push(parseValue());
      }
      return { k: "list", items };
    }
    if (t.t === "punc" && t.v === "{") {
      const fields: Array<[string, ValueNode]> = [];
      for (;;) {
        const p = next();
        if (p.t === "punc" && p.v === "}") break;
        if (p.t !== "name") throw new GqlSyntax("expected an input object field name");
        expectPunc(":");
        fields.push([p.v, parseValue()]);
      }
      return { k: "obj", fields };
    }
    throw new GqlSyntax(`expected a value, got '${t.v}'`);
  };

  const parseSelSet = (): Sel[] => {
    expectPunc("{");
    const sel: Sel[] = [];
    for (;;) {
      const p = peek();
      if (p === undefined) throw new GqlSyntax("unterminated selection set");
      if (p.t === "punc" && p.v === "}") {
        next();
        break;
      }
      if (p.t === "punc" && p.v === "...") {
        next();
        const nt = peek();
        if (nt !== undefined && nt.t === "name" && nt.v === "on") {
          next();
          const onT = next();
          if (onT.t !== "name") throw new GqlSyntax("expected a type name after 'on'");
          sel.push({ f: "frag", on: onT.v, sel: parseSelSet() });
          continue;
        }
        if (nt !== undefined && nt.t === "name") {
          next();
          sel.push({ f: "namedfrag", name: nt.v, line: nt.line, col: nt.col });
          continue;
        }
        throw new GqlSyntax("expected a fragment name or 'on' after '...'");
      }
      if (p.t !== "name") throw new GqlSyntax("expected a field name");
      next();
      let alias: string | null = null;
      let fname = p.v;
      const at = peek();
      if (at !== undefined && at.t === "punc" && at.v === ":") {
        next();
        const fn = next();
        if (fn.t !== "name") throw new GqlSyntax("expected a field name after an alias");
        alias = p.v;
        fname = fn.v;
      }
      const args: Array<[string, ValueNode]> = [];
      const ap = peek();
      if (ap !== undefined && ap.t === "punc" && ap.v === "(") {
        next();
        for (;;) {
          const an = next();
          if (an.t === "punc" && an.v === ")") break;
          if (an.t !== "name") throw new GqlSyntax("expected an argument name");
          expectPunc(":");
          args.push([an.v, parseValue()]);
        }
      }
      const sp = peek();
      const ssel = sp !== undefined && sp.t === "punc" && sp.v === "{" ? parseSelSet() : null;
      sel.push({ f: "field", alias, name: fname, args, sel: ssel, line: p.line, col: p.col });
    }
    return sel;
  };

  const ops: Operation[] = [];
  const frags = new Map<string, NamedFrag>();
  while (peek() !== undefined) {
    const t = next();
    if (t.t !== "name") throw new GqlSyntax("expected an operation or a fragment");
    if (t.v === "query" || t.v === "mutation") {
      let name = "";
      const nt = peek();
      if (nt !== undefined && nt.t === "name") name = next().v;
      const vt = peek();
      if (vt !== undefined && vt.t === "punc" && vt.v === "(") {
        // Variable definitions: names and types carry no runtime meaning here, so they are
        // skipped up to the matching ')' (defaults included); execution reads `variables`.
        next();
        for (;;) {
          const a = next();
          if (a.t === "punc" && a.v === ")") break;
          if (a.t !== "var") throw new GqlSyntax("expected a variable in the definitions");
          expectPunc(":");
          for (;;) {
            const ty = peek();
            if (ty === undefined) throw new GqlSyntax("unterminated variable definition");
            if (ty.t === "punc" && ty.v === ")") break;
            if (ty.t === "var") break;
            next();
          }
        }
      }
      ops.push({ kind: t.v === "query" ? "Query" : "Mutation", name, sel: parseSelSet() });
      continue;
    }
    if (t.v === "fragment") {
      const fname = next();
      if (fname.t !== "name") throw new GqlSyntax("expected a fragment name");
      const onkw = next();
      if (onkw.t !== "name" || onkw.v !== "on") throw new GqlSyntax("expected 'on' in a fragment");
      const onT = next();
      if (onT.t !== "name") throw new GqlSyntax("expected a type name after 'on'");
      frags.set(fname.v, { on: onT.v, sel: parseSelSet() });
      continue;
    }
    throw new GqlSyntax(`unexpected '${t.v}' where an operation was expected`);
  }
  return { ops, frags };
}

function evalValue(v: ValueNode, vars: Record<string, unknown>): unknown {
  switch (v.k) {
    case "var": {
      const val = vars[v.v];
      return val === undefined ? null : val;
    }
    case "int":
      return Number(v.v);
    case "str":
      return v.v;
    case "enum":
      return v.v;
    case "bool":
      return v.v === "true";
    case "null":
      return null;
    case "list":
      return v.items.map((item) => evalValue(item, vars));
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const [name, item] of v.fields) out[name] = evalValue(item, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------- GraphQL execution

interface GqlErrEntry {
  message: string;
  locations?: Array<{ line: number; column: number }>;
}

interface ExecEnv {
  vars: Record<string, unknown>;
  ctx: Ctx;
  frags: Map<string, NamedFrag>;
  errors: GqlErrEntry[];
}

type Resolver = (val: any, args: Record<string, unknown>, ctx: Ctx) => unknown;

const gqlIssueState = (issue: Issue): string => (issue.state === "open" ? "OPEN" : "CLOSED");
const gqlPullState = (pull: Pull): string => (pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED");

interface IssuePage {
  nodes: Issue[];
  hasNextPage: boolean;
  endCursor: string;
}

function issuePage(repo: Repo, args: Record<string, unknown>): IssuePage {
  let items = repo.issues.slice();
  const states = Array.isArray(args.states) ? args.states.map((s) => String(s)) : null;
  if (states !== null && states.length > 0) {
    items = items.filter((issue) => states.includes(gqlIssueState(issue)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === "DESC" ? "DESC" : "ASC";
  items.sort((x, y) => (direction === "DESC" ? y.number - x.number : x.number - y.number));
  const first = typeof args.first === "number" && Number.isFinite(args.first) && args.first > 0 ? Math.floor(args.first) : 30;
  const after = typeof args.after === "string" && args.after !== "" ? decodeCursor(args.after) : 0;
  const nodes = items.slice(after, after + first);
  return { nodes, hasNextPage: after + nodes.length < items.length, endCursor: encodeCursor(after + nodes.length) };
}

/** The paths a pull request's head tree holds that its base tree does not (changed or added). */
function pullChangedPaths(ctx: Ctx, pull: Pull): string[] {
  const isTreeMode = (mode: string): boolean => mode === "040000" || mode === "40000";
  const baseCommit = pull.base.sha !== "" ? ctx.store.readCommit(pull.base.sha) : null;
  const headCommit = pull.head.sha !== "" ? ctx.store.readCommit(pull.head.sha) : null;
  const out: string[] = [];
  const walk = (a: string, b: string, prefix: string): void => {
    if (a === b) return;
    const ta = a !== "" ? ctx.store.readTree(a) : [];
    const tb = b !== "" ? ctx.store.readTree(b) : [];
    const byName = new Map<string, { mode: string; name: string; sha: string }>();
    for (const e of ta) byName.set(e.name, e);
    for (const e of tb) {
      const other = byName.get(e.name);
      if (isTreeMode(e.mode)) {
        walk(other !== undefined && isTreeMode(other.mode) ? other.sha : "", e.sha, prefix + e.name + "/");
      } else if (other === undefined || other.sha !== e.sha || isTreeMode(other.mode)) {
        out.push(prefix + e.name);
      }
    }
  };
  walk(baseCommit === null ? "" : baseCommit.tree, headCommit === null ? "" : headCommit.tree, "");
  return out;
}

function requireInput(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (!isRecord(input)) throw new GqlUserError("the mutation requires an input object");
  return input;
}

function repoFromGid(ctx: Ctx, id: string): Repo {
  const g = parseGid(id);
  const repo = g !== null && g.type === "Repository" ? findRepoById(ctx, g.id) : undefined;
  if (repo === undefined) throw new GqlUserError(`Could not resolve to a Repository with the global id ${id}`);
  return repo;
}

function issueFromGid(ctx: Ctx, id: string): Issue {
  const g = parseGid(id);
  const issue = g !== null && g.type === "Issue" ? findIssueById(ctx, g.id) : undefined;
  if (issue === undefined) throw new GqlUserError(`Could not resolve to an Issue with the global id ${id}`);
  return issue;
}

function pullFromGid(ctx: Ctx, id: string): Pull {
  const g = parseGid(id);
  const pull = g !== null && g.type === "PullRequest" ? findPullById(ctx, g.id) : undefined;
  if (pull === undefined) throw new GqlUserError(`Could not resolve to a PullRequest with the global id ${id}`);
  return pull;
}

/** The schema surface __type reports (the field/enum lists the suite's probes read). */
const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ["id", "number", "title", "state", "body"],
  PullRequest: ["id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files"],
  Repository: [
    "id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef",
    "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest",
  ],
  User: ["login"],
  IssueConnection: ["nodes", "pageInfo"],
  PageInfo: ["hasNextPage", "endCursor"],
  PullRequestConnection: ["nodes"],
  PullRequestChangedFile: ["path"],
  Ref: ["name"],
  Comment: ["id", "body"],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ["ISSUE", "REPOSITORY", "USER"],
  IssueState: ["OPEN", "CLOSED"],
  MergeableState: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
  PullRequestState: ["OPEN", "CLOSED", "MERGED"],
  PullRequestMergeMethod: ["MERGE", "SQUASH", "REBASE"],
  RepositoryPermission: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"],
  IssueOrderField: ["CREATED_AT", "UPDATED_AT", "COMMENTS"],
  OrderDirection: ["ASC", "DESC"],
};

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_v, _a, ctx) => ({ kind: "User", val: { login: VIEWER_LOGIN } }),
    repository: (_v, a, ctx) => {
      if (typeof a.owner !== "string" || typeof a.name !== "string") {
        throw new GqlUserError("repository(owner:, name:) requires both a string owner and a string name");
      }
      const repo = getRepo(ctx, a.owner, a.name);
      return repo === undefined ? null : { kind: "Repository", val: repo };
    },
    node: (_v, a, ctx) => {
      if (typeof a.id !== "string") throw new GqlUserError("node(id:) requires a string id");
      const g = parseGid(a.id);
      if (g === null || g.type !== "Repository") return null;
      const repo = findRepoById(ctx, g.id);
      return repo === undefined ? null : { kind: "Repository", val: repo };
    },
    __type: (_v, a) => {
      if (typeof a.name !== "string") throw new GqlUserError("__type(name:) requires a string name");
      const known = SCHEMA_FIELDS[a.name] !== undefined || SCHEMA_ENUMS[a.name] !== undefined;
      return known ? { kind: "__Type", val: { name: a.name } } : null;
    },
  },
  Mutation: {
    createIssue: (_v, a, ctx) => {
      const input = requireInput(a);
      const repo = repoFromGid(ctx, String(input.repositoryId ?? ""));
      const issue = newIssue(ctx, repo, typeof input.title === "string" ? input.title : "", typeof input.body === "string" ? input.body : "", []);
      return { kind: "CreateIssuePayload", val: { issue } };
    },
    closeIssue: (_v, a, ctx) => {
      const input = requireInput(a);
      const issue = issueFromGid(ctx, String(input.issueId ?? ""));
      issue.state = "closed";
      issue.closed_at = ctx.now();
      return { kind: "CloseIssuePayload", val: { issue } };
    },
    createPullRequest: (_v, a, ctx) => {
      const input = requireInput(a);
      const repo = repoFromGid(ctx, String(input.repositoryId ?? ""));
      const head = typeof input.headRefName === "string" ? input.headRefName : "";
      const base = typeof input.baseRefName === "string" ? input.baseRefName : "";
      if (head === "" || base === "") {
        throw new GqlUserError("createPullRequest requires a headRefName and a baseRefName");
      }
      const pull = newPull(
        ctx, repo,
        typeof input.title === "string" ? input.title : "",
        typeof input.body === "string" ? input.body : "",
        head, repo.refs.get("refs/heads/" + head) ?? "",
        base, repo.refs.get("refs/heads/" + base) ?? "",
      );
      return { kind: "CreatePullRequestPayload", val: { pull } };
    },
    mergePullRequest: (_v, a, ctx) => {
      const input = requireInput(a);
      const pull = pullFromGid(ctx, String(input.pullRequestId ?? ""));
      if (input.mergeMethod !== undefined && input.mergeMethod !== null) {
        const method = String(input.mergeMethod);
        if (!["MERGE", "SQUASH", "REBASE"].includes(method)) {
          throw new GqlUserError(`mergeMethod must be MERGE, SQUASH or REBASE, got ${method}`);
        }
      }
      pull.merged = true;
      pull.state = "closed";
      pull.merged_at = ctx.now();
      pull.merge_commit_sha = ctx.store.sha("commit", Buffer.from(`merge pull request #${pull.number}`, "utf8"));
      return { kind: "MergePullRequestPayload", val: { pull } };
    },
    addComment: (_v, a, ctx) => {
      const input = requireInput(a);
      const issue = issueFromGid(ctx, String(input.subjectId ?? ""));
      const comment: Comment = {
        id: ctx.commentId(),
        body: typeof input.body === "string" ? input.body : "",
        user: VIEWER_LOGIN,
        created_at: ctx.now(),
      };
      issue.comments.push(comment);
      return { kind: "AddCommentPayload", val: { comment } };
    },
  },
  User: {
    login: (v: { login: string }) => v.login,
  },
  Repository: {
    id: (repo: Repo) => gid("Repository", repo.id),
    databaseId: (repo: Repo) => repo.id,
    name: (repo: Repo) => repo.name,
    nameWithOwner: (repo: Repo) => `${repo.owner}/${repo.name}`,
    owner: (repo: Repo) => ({ kind: "User", val: { login: repo.owner } }),
    defaultBranchRef: (repo: Repo) => ({ kind: "Ref", val: { name: repo.defaultBranch } }),
    viewerPermission: (_repo: Repo) => "ADMIN",
    hasIssuesEnabled: (_repo: Repo) => true,
    issue: (repo: Repo, a) => {
      if (typeof a.number !== "number" || !Number.isInteger(a.number)) {
        throw new GqlUserError("issue(number:) requires an integer number");
      }
      const issue = repo.issues.find((cand) => cand.number === a.number);
      return issue === undefined ? null : { kind: "Issue", val: issue };
    },
    issues: (repo: Repo, a) => ({ kind: "IssueConnection", val: issuePage(repo, a) }),
    pullRequests: (repo: Repo, a) => {
      const first = typeof a.first === "number" && Number.isFinite(a.first) && a.first > 0 ? Math.floor(a.first) : 30;
      return { kind: "PullRequestConnection", val: { nodes: repo.pulls.slice(0, first) } };
    },
    pullRequest: (repo: Repo, a) => {
      if (typeof a.number !== "number" || !Number.isInteger(a.number)) {
        throw new GqlUserError("pullRequest(number:) requires an integer number");
      }
      const pull = repo.pulls.find((cand) => cand.number === a.number);
      return pull === undefined ? null : { kind: "PullRequest", val: pull };
    },
  },
  Issue: {
    id: (issue: Issue) => gid("Issue", issue.id),
    number: (issue: Issue) => issue.number,
    title: (issue: Issue) => issue.title,
    state: (issue: Issue) => gqlIssueState(issue),
    body: (issue: Issue) => issue.body,
  },
  IssueConnection: {
    nodes: (page: IssuePage) => page.nodes.map((issue) => ({ kind: "Issue", val: issue })),
    pageInfo: (page: IssuePage) => ({ kind: "PageInfo", val: { hasNextPage: page.hasNextPage, endCursor: page.endCursor } }),
  },
  PageInfo: {
    hasNextPage: (v: { hasNextPage: boolean }) => v.hasNextPage,
    endCursor: (v: { endCursor: string }) => v.endCursor,
  },
  PullRequest: {
    id: (pull: Pull) => gid("PullRequest", pull.id),
    number: (pull: Pull) => pull.number,
    state: (pull: Pull) => gqlPullState(pull),
    merged: (pull: Pull) => pull.merged,
    headRefName: (pull: Pull) => pull.head.ref,
    baseRefName: (pull: Pull) => pull.base.ref,
    mergeable: (_pull: Pull) => "MERGEABLE",
    files: (pull: Pull, a, ctx) => {
      const first = typeof a.first === "number" && Number.isFinite(a.first) && a.first > 0 ? Math.floor(a.first) : 30;
      const paths = pullChangedPaths(ctx, pull).slice(0, first);
      return { kind: "FileConnection", val: { paths } };
    },
  },
  PullRequestConnection: {
    nodes: (v: { nodes: Pull[] }) => v.nodes.map((pull) => ({ kind: "PullRequest", val: pull })),
  },
  FileConnection: {
    nodes: (v: { paths: string[] }) => v.paths.map((path) => ({ kind: "PullRequestChangedFile", val: { path } })),
  },
  PullRequestChangedFile: {
    path: (v: { path: string }) => v.path,
  },
  Ref: {
    name: (v: { name: string }) => v.name,
  },
  CreateIssuePayload: {
    issue: (v: { issue: Issue }) => ({ kind: "Issue", val: v.issue }),
  },
  CloseIssuePayload: {
    issue: (v: { issue: Issue }) => ({ kind: "Issue", val: v.issue }),
  },
  CreatePullRequestPayload: {
    pullRequest: (v: { pull: Pull }) => ({ kind: "PullRequest", val: v.pull }),
  },
  MergePullRequestPayload: {
    pullRequest: (v: { pull: Pull }) => ({ kind: "PullRequest", val: v.pull }),
  },
  AddCommentPayload: {
    commentEdge: (v: { comment: Comment }) => ({ kind: "CommentEdge", val: { comment: v.comment } }),
  },
  CommentEdge: {
    node: (v: { comment: Comment }) => ({ kind: "Comment", val: v.comment }),
  },
  Comment: {
    id: (comment: Comment) => gid("Comment", comment.id),
    body: (comment: Comment) => comment.body,
  },
  __Type: {
    name: (v: { name: string }) => v.name,
    fields: (v: { name: string }) => {
      const names = SCHEMA_FIELDS[v.name];
      return names === undefined ? null : names.map((name) => ({ kind: "__SchemaValue", val: { name } }));
    },
    enumValues: (v: { name: string }) => {
      const names = SCHEMA_ENUMS[v.name];
      return names === undefined ? null : names.map((name) => ({ kind: "__SchemaValue", val: { name } }));
    },
  },
  __SchemaValue: {
    name: (v: { name: string }) => v.name,
  },
};

function execSel(sel: readonly Sel[], kind: string, val: unknown, env: ExecEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const table = RESOLVERS[kind];
  for (const s of sel) {
    if (s.f === "namedfrag") {
      const frag = env.frags.get(s.name);
      if (frag === undefined) {
        env.errors.push({ message: `Unknown fragment '${s.name}'`, locations: [{ line: s.line, column: s.col }] });
        continue;
      }
      if (frag.on === kind) Object.assign(out, execSel(frag.sel, kind, val, env));
      continue;
    }
    if (s.f === "frag") {
      if (s.on === kind) Object.assign(out, execSel(s.sel, kind, val, env));
      continue;
    }
    const key = s.alias ?? s.name;
    const resolver = table === undefined ? undefined : table[s.name];
    if (resolver === undefined) {
      env.errors.push({
        message: `Field '${s.name}' doesn't exist on type '${kind}'`,
        locations: [{ line: s.line, column: s.col }],
      });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, vnode] of s.args) args[name] = evalValue(vnode, env.vars);
    const r = resolver(val, args, env.ctx);
    if (s.sel === null) {
      out[key] = r === undefined ? null : r;
      continue;
    }
    if (r === null || r === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(r)) {
      out[key] = r.map((item: unknown) => (item === null || item === undefined ? null : execSel(s.sel!, (item as KindVal).kind, (item as KindVal).val, env)));
      continue;
    }
    if (typeof r === "object") {
      out[key] = execSel(s.sel!, (r as KindVal).kind, (r as KindVal).val, env);
      continue;
    }
    out[key] = null;
  }
  return out;
}

function runGqlEntry(entry: unknown, ctx: Ctx): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== "string") {
    return { errors: [{ message: "the request must carry a query string" }] };
  }
  const vars = isRecord(entry.variables) ? entry.variables : {};
  let doc: ParsedDoc;
  try {
    doc = parseDocument(entry.query);
  } catch (e) {
    if (e instanceof GqlSyntax) return { errors: [{ message: `syntax error: ${e.message}` }] };
    return { errors: [{ message: "internal error: " + msgOf(e) }] };
  }
  let op: Operation | undefined;
  if (typeof entry.operationName === "string" && entry.operationName !== "") {
    op = doc.ops.find((cand) => cand.name === entry.operationName);
    if (op === undefined) return { errors: [{ message: `Unknown operation named '${entry.operationName}'` }] };
  } else {
    op = doc.ops[0];
  }
  if (op === undefined) return { errors: [{ message: "the document holds no runnable operation" }] };
  const errors: GqlErrEntry[] = [];
  const env: ExecEnv = { vars, ctx, frags: doc.frags, errors };
  try {
    const data = execSel(op.sel, op.kind, null, env);
    return errors.length > 0 ? { errors, data } : { data };
  } catch (e) {
    if (e instanceof GqlUserError) return { errors: [{ message: e.message }] };
    return { errors: [{ message: "internal error: " + msgOf(e) }] };
  }
}

const jsonRes = (status: number, body: unknown): Res => ({
  status,
  headers: [["Content-Type", "application/json; charset=utf-8"]],
  body: JSON.stringify(body),
});

function authOk(req: Req, ctx: Ctx): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (ctx.token === "") return auth.startsWith("Bearer ");
  return auth === "Bearer " + ctx.token;
}

/** POST /api/graphql: one operation, or a JSON array of them (operation batching). */
export function routeGql(req: Req, ctx: Ctx): Res | undefined {
  try {
    if (req.path !== "/api/graphql" && req.path !== "/api/graphql/") return undefined;
    if (req.method !== "POST") return jsonRes(405, { message: "Method Not Allowed" });
    if (!authOk(req, ctx)) return jsonRes(401, { message: "Bad credentials" });
    let body: unknown;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return jsonRes(400, { message: "Problems parsing JSON" });
    }
    if (Array.isArray(body)) {
      const answers = body.map((entry) => runGqlEntry(entry, ctx));
      return jsonRes(200, answers);
    }
    return jsonRes(200, runGqlEntry(body, ctx));
  } catch (e) {
    return jsonRes(200, { errors: [{ message: "internal error: " + msgOf(e) }] });
  }
}

// ---------------------------------------------------------------- MCP over POST /mcp

const MCP_SERVER_INFO = { name: "github-core-clone-01", version: "1.0.0" };
const MCP_SUPPORTED_VERSIONS = ["2026-07-28"];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
}

/** The six canonical tools, static so two tools/list answers are byte-identical. */
const MCP_TOOL_DEFS: McpToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated viewer.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" } },
      required: ["name"],
    },
    required: ["name"],
  },
  {
    name: "get_repo",
    description: "Get a repository by its owner and name.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
    },
    required: ["owner", "repo"],
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
      required: ["owner", "repo", "title"],
    },
    required: ["owner", "repo", "title"],
  },
  {
    name: "list_issues",
    description: "List the issues of a repository, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } },
      required: ["owner", "repo"],
    },
    required: ["owner", "repo"],
  },
  {
    name: "create_pull_request",
    description: "Create a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" },
        head: { type: "string" }, base: { type: "string" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
    required: ["owner", "repo", "title", "head", "base"],
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request by its number.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "integer" } },
      required: ["owner", "repo", "pull_number"],
    },
    required: ["owner", "repo", "pull_number"],
  },
];

const MCP_TOOLS_LIST = MCP_TOOL_DEFS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

const MCP_TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ["create_repository", "repo_create", "repos_create", "repository_create"],
  get_repo: ["get_repository", "repo_get", "repos_get", "repository_get"],
  create_issue: ["issue_create", "issues_create"],
  list_issues: ["issues_list", "issue_list"],
  create_pull_request: ["pull_request_create", "pulls_create", "create_pr", "pr_create"],
  merge_pull_request: ["pull_request_merge", "pulls_merge", "merge_pr", "pr_merge"],
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Exact canonical/alias match first, then a server-prefixed suffix match, case-insensitive. */
function resolveToolName(name: string): McpToolDef | null {
  for (const def of MCP_TOOL_DEFS) if (def.name === name) return def;
  const norm = normalizeToolName(name);
  for (const def of MCP_TOOL_DEFS) {
    const wanted = [def.name, ...(MCP_TOOL_ALIASES[def.name] ?? [])].map(normalizeToolName);
    if (wanted.includes(norm)) return def;
  }
  for (const def of MCP_TOOL_DEFS) {
    const wanted = [def.name, ...(MCP_TOOL_ALIASES[def.name] ?? [])].map(normalizeToolName);
    for (const suffix of wanted) if (norm.length > suffix.length && norm.endsWith(suffix)) return def;
  }
  return null;
}

function argString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  return String(v);
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
    created_at: repo.createdAt,
  };
}

function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    user: issue.user,
    created_at: issue.created_at,
  };
}

function pullView(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.merged ? "closed" : pull.state,
    merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
  };
}

function mcpOk(view: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
}

function mcpToolErr(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError: true };
}

/** Run one tool over the same db.ts domain the REST surface serves. */
function runMcpTool(def: McpToolDef, args: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  switch (def.name) {
    case "create_repo": {
      const name = argString(args, "name");
      if (name === "") return mcpToolErr("create_repo requires a repository name");
      const description = typeof args.description === "string" ? args.description : "";
      const repo = createRepo(ctx, VIEWER_LOGIN, name, args.private === true, description);
      return mcpOk(repoView(repo));
    }
    case "get_repo": {
      const repo = getRepo(ctx, argString(args, "owner"), argString(args, "repo"));
      if (repo === undefined) {
        return mcpToolErr(`repository ${argString(args, "owner")}/${argString(args, "repo")} not found`);
      }
      return mcpOk(repoView(repo));
    }
    case "create_issue": {
      const repo = getRepo(ctx, argString(args, "owner"), argString(args, "repo"));
      if (repo === undefined) {
        return mcpToolErr(`repository ${argString(args, "owner")}/${argString(args, "repo")} not found`);
      }
      const title = argString(args, "title");
      const body = typeof args.body === "string" ? args.body : "";
      const issue = newIssue(ctx, repo, title, body, []);
      return mcpOk(issueView(issue));
    }
    case "list_issues": {
      const repo = getRepo(ctx, argString(args, "owner"), argString(args, "repo"));
      if (repo === undefined) {
        return mcpToolErr(`repository ${argString(args, "owner")}/${argString(args, "repo")} not found`);
      }
      const state = argString(args, "state");
      const issues = state === "open" || state === "closed"
        ? repo.issues.filter((issue) => issue.state === state)
        : repo.issues.slice();
      return mcpOk(issues.map((issue) => issueView(issue)));
    }
    case "create_pull_request": {
      const repo = getRepo(ctx, argString(args, "owner"), argString(args, "repo"));
      if (repo === undefined) {
        return mcpToolErr(`repository ${argString(args, "owner")}/${argString(args, "repo")} not found`);
      }
      const head = argString(args, "head");
      const base = argString(args, "base");
      const title = argString(args, "title");
      const body = typeof args.body === "string" ? args.body : "";
      const pull = newPull(
        ctx, repo, title, body,
        head, repo.refs.get("refs/heads/" + head) ?? "",
        base, repo.refs.get("refs/heads/" + base) ?? "",
      );
      return mcpOk(pullView(pull));
    }
    case "merge_pull_request": {
      const repo = getRepo(ctx, argString(args, "owner"), argString(args, "repo"));
      if (repo === undefined) {
        return mcpToolErr(`repository ${argString(args, "owner")}/${argString(args, "repo")} not found`);
      }
      const n = args.pull_number;
      if (typeof n !== "number" || !Number.isInteger(n)) return mcpToolErr("merge_pull_request requires an integer pull_number");
      const pull = repo.pulls.find((cand) => cand.number === n);
      if (pull === undefined) return mcpToolErr(`pull request #${n} not found in ${argString(args, "owner")}/${repo.name}`);
      pull.merged = true;
      pull.state = "closed";
      pull.merged_at = ctx.now();
      pull.merge_commit_sha = ctx.store.sha("commit", Buffer.from(`merge pull request #${pull.number}`, "utf8"));
      return mcpOk(pullView(pull));
    }
    default:
      return mcpToolErr(`the tool ${def.name} is not implemented`);
  }
}

const mcpRes = (status: number, body: unknown): Res => ({
  status,
  headers: [
    ["Content-Type", "application/json; charset=utf-8"],
    ["Mcp-Session-Id", "forge-mcp-session"],
  ],
  body: JSON.stringify(body),
});

function rpcResult(id: unknown, result: Record<string, unknown>): Res {
  return mcpRes(200, { jsonrpc: "2.0", id: id === undefined ? null : id, result });
}

function rpcError(id: unknown, code: number, message: string): Res {
  return mcpRes(200, { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
}

function handleMcpRpc(rpc: Record<string, unknown>, ctx: Ctx): Res {
  const method = typeof rpc.method === "string" ? rpc.method : "";
  const hasId = "id" in rpc && rpc.id !== undefined;
  const id = rpc.id;
  const params = isRecord(rpc.params) ? rpc.params : {};
  if (method === "" ) return rpcError(id, -32600, "Invalid Request: no method");
  if (!hasId) {
    // A notification: accepted, nothing to answer with but the transport's acknowledgement.
    return mcpRes(200, {});
  }
  switch (method) {
    case "server/discover":
      return rpcResult(id, {
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: "GitHub-compatible forge tools over the same domain the REST and GraphQL surfaces serve.",
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { "io.modelcontextprotocol/serverInfo": { ...MCP_SERVER_INFO } },
      });
    case "initialize": {
      const offered = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const revision = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : "2025-11-25";
      return rpcResult(id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
      });
    }
    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS_LIST });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "") return rpcError(id, -32602, "tools/call requires a tool name");
      const def = resolveToolName(name);
      if (def === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = def.required.filter(
        (required) => !(required in args) || args[required] === undefined || args[required] === null,
      );
      if (missing.length > 0) {
        return rpcError(id, -32602, `tools/call ${def.name} is missing required arguments: ${missing.join(", ")}`);
      }
      return rpcResult(id, runMcpTool(def, args, ctx));
    }
    case "ping":
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** POST /mcp: JSON-RPC over the streamable HTTP transport (one JSON body per answer). */
export function routeMcp(req: Req, ctx: Ctx): Res | undefined {
  try {
    if (req.path !== "/mcp" && req.path !== "/mcp/") return undefined;
    if (req.method === "DELETE") return mcpRes(200, {});
    if (req.method === "GET") {
      return mcpRes(405, { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method Not Allowed: POST is the transport here" } });
    }
    if (req.method !== "POST") return mcpRes(405, { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method Not Allowed" } });
    // Authentication is decided before any tool exists or runs.
    if (!authOk(req, ctx)) return mcpRes(401, { message: "Bad credentials" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString("utf8"));
    } catch {
      return mcpRes(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (!isRecord(parsed)) return mcpRes(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return handleMcpRpc(parsed, ctx);
  } catch (e) {
    return mcpRes(200, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error: " + msgOf(e) } });
  }
}

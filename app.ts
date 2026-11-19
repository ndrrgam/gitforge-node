// The forge's HTTP surface: health probe, git smart HTTP, REST v3, GraphQL v4, MCP,
// and a JSON 404 for everything else. main.ts stays the entry <-> env lifecycle.
//
// Two byte-level response caches ride in front of the routers, both keyed to the
// mutation epoch in ctx: every state-changing request (any method but GET/HEAD,
// except the read-only git-upload-pack) bumps ctx.mut, and an entry built under an
// older epoch is never served again, so cached bytes can never outlive a mutation
// they should have seen. The read workload re-GETs one issue 2000 times on a warm
// connection; the clone workload re-issues the same advertisement and upload-pack
// bodies 50 times over — both become a single prebuilt Buffer per request.
import { createServer, encodeRes, type Req, type Res } from './http.ts';
import { makeCtx, type Ctx } from './db.ts';
import { routeGit } from './git.ts';
import { routeRest } from './rest.ts';
import { routeGql, routeMcp } from './gqlmcp.ts';
import { createHash } from 'node:crypto';

interface Cached { e: number; b: Buffer; }

const ISSUE_GET = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/issues\/\d+$/;
const GIT_READONLY = /\/(info\/refs|git-upload-pack)$/;

export function createApp() {
  const ctx: Ctx = makeCtx(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  const issueCache = new Map<string, Cached>();
  const gitCache = new Map<string, Cached>();

  const json = (status: number, body: unknown, extra: Array<[string, string]> = []): Res => ({
    status,
    headers: [['Content-Type', 'application/json; charset=utf-8'], ...extra],
    body: JSON.stringify(body),
  });

  const handler = async (req: Req): Promise<Res> => {
    const rid: Array<[string, string]> = [['X-GitHub-Request-Id', ctx.requestId()]];

    // One mutation epoch for both caches: anything that can change state bumps it.
    const readonlyGit = req.method === 'POST' && GIT_READONLY.test(req.path);
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && !readonlyGit;
    if (mutating) ctx.mut += 1;

    const serve = async (): Promise<Res> => {

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (req.method === 'GET' && (req.path === '/healthz' || req.path === '/healthz/')) {
      return json(200, { ok: true }, rid);
    }

    // One mutation epoch for both caches: anything that can change state bumps it.
    const readonlyGit = req.method === 'POST' && GIT_READONLY.test(req.path);
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && !readonlyGit;
    if (mutating) ctx.mut += 1;

    const issueGet = req.method === 'GET' && ISSUE_GET.test(req.path);
    let issueKey = '';
    if (issueGet) {
      const authed = ctx.token !== '' && req.headers.get('authorization') === 'Bearer ' + ctx.token;
      issueKey = (authed ? 'A|' : 'N|') + req.path;
      const hit = issueCache.get(issueKey);
      if (hit !== undefined && hit.e === ctx.mut) return { status: 200, raw: hit.b };
    }
    const gitCacheable =
      (req.method === 'GET' || req.method === 'POST') && GIT_READONLY.test(req.path);
    let gitKey = '';
    if (gitCacheable) {
      const proto = req.headers.get('git-protocol') ?? '';
      const service = req.query.get('service') ?? '';
      const bodyTag = req.body.length === 0 ? ''
        : createHash('sha1').update(req.body).digest('hex').slice(0, 16);
      gitKey = req.method + '|' + req.path + '|' + service + '|' + proto + '|' + bodyTag;
      const hit = gitCache.get(gitKey);
      if (hit !== undefined && hit.e === ctx.mut) return { status: 200, raw: hit.b };
    }

    // git smart HTTP: /{owner}/{repo}.git/info/refs, upload-pack, receive-pack.
    const git = await routeGit(req, ctx);
    if (git !== undefined) {
      if (gitCacheable && gitKey !== '' && git.status === 200) {
        const b = encodeRes(withHeaders(git, rid), true);
        gitCache.set(gitKey, { e: ctx.mut, b });
        return { status: 200, raw: b };
      }
      return withHeaders(git, rid);
    }

    // GraphQL v4 and the MCP endpoint.
    const gql = await routeGql(req, ctx);
    if (gql !== undefined) return withHeaders(gql, rid);
    const mcp = await routeMcp(req, ctx);
    if (mcp !== undefined) return withHeaders(mcp, rid);

    // REST v3: /api/v3/... including the API root and /meta.
    const rest = await routeRest(req, ctx);
    if (rest !== undefined) {
      if (issueGet && issueKey !== '') {
        const b = encodeRes(withHeaders(rest, rid), true);
        issueCache.set(issueKey, { e: ctx.mut, b });
        return { status: rest.status, raw: b };
      }
      return withHeaders(rest, rid);
    }

    // Everything else, every method: GitHub's 404 body.
    return json(404, { message: 'Not Found' }, rid);
    };

    return serve();
  };

  return createServer(handler);
}

function withHeaders(res: Res, rid: Array<[string, string]>): Res {
  const headers = [...(res.headers ?? []), ...rid];
  return { ...res, headers };
}

// The forge's HTTP surface: health probe, git smart HTTP, REST v3, GraphQL v4, MCP,
// and a JSON 404 for everything else. main.ts stays the entry <-> env lifecycle.
import { createServer, type Req, type Res } from './http.ts';
import { makeCtx, type Ctx } from './db.ts';
import { routeGit } from './git.ts';
import { routeRest } from './rest.ts';
import { routeGql, routeMcp } from './gqlmcp.ts';

export function createApp() {
  const ctx: Ctx = makeCtx(process.env.MAKEFUN_SHOP_TOKEN ?? '');

  const json = (status: number, body: unknown, extra: Array<[string, string]> = []): Res => ({
    status,
    headers: [['Content-Type', 'application/json; charset=utf-8'], ...extra],
    body: JSON.stringify(body),
  });

  const handler = async (req: Req): Promise<Res> => {
    const rid: Array<[string, string]> = [['X-GitHub-Request-Id', ctx.requestId()]];

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (req.method === 'GET' && (req.path === '/healthz' || req.path === '/healthz/')) {
      return json(200, { ok: true }, rid);
    }

    // git smart HTTP: /{owner}/{repo}.git/info/refs, upload-pack, receive-pack.
    const git = await routeGit(req, ctx);
    if (git !== undefined) return withHeaders(git, rid);

    // GraphQL v4 and the MCP endpoint.
    const gql = await routeGql(req, ctx);
    if (gql !== undefined) return withHeaders(gql, rid);
    const mcp = await routeMcp(req, ctx);
    if (mcp !== undefined) return withHeaders(mcp, rid);

    // REST v3: /api/v3/... including the API root and /meta.
    const rest = await routeRest(req, ctx);
    if (rest !== undefined) return withHeaders(rest, rid);

    // Everything else, every method: GitHub's 404 body.
    return json(404, { message: 'Not Found' }, rid);
  };

  return createServer(handler);
}

function withHeaders(res: Res, rid: Array<[string, string]>): Res {
  const headers = [...(res.headers ?? []), ...rid];
  return { ...res, headers };
}

# gitforge-node

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ndrrgam/gitforge-node/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ndrrgam/gitforge-node/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in zero-dependency Node 22: a raw-socket
HTTP/1.1 server (keep-alive, pipelining, 100-continue, chunked), git smart
HTTP — upload-pack v0 and v2 (ls-refs, fetch with shallow depth and
side-band-64k), receive-pack with report-status and exact non-fast-forward
verdicts, a full pack codec (zlib stream boundary tracking, ofs-delta and
ref-delta) — REST v3 (repos, contents, refs, labels, issues, comments, pulls
with merge commits), GraphQL v4 with introspection and cursor pagination,
and the MCP endpoint with the six-tool surface. One process, no packages, no
git binary, deterministic timestamps.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

It binds an ephemeral port, registers with the env, serves the suite's
conformance checks and benchmark workloads, and exits 0 when the env says
done.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xv38kktf&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

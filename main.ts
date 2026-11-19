// gitforge-node's process life: bind an ephemeral port, tell the env where we
// are, serve the suite until the env says the trial is over, then exit 0.
//
// MAKEFUN_ENV_URL is the env's origin (http://store:8080 in a trial). Without
// it there is no one to register with, so the process exits 1 immediately.
// The port is picked by listen(0); the env dials back the address this
// process registered from, plus that port, from then on. GET
// $MAKEFUN_ENV_URL/done answers at once, so the wait is a short poll with
// exponential backoff — never a held request, and never an exit before the
// answer is {"done": true}.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL || '').trim().replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is empty: there is no env to register with\n');
  process.exit(1);
}

const CALL_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const wait = (ms: number): Promise<void> => new Promise((ok) => { setTimeout(ok, ms); });

function backoffMs(tries: number): number {
  const growth = BACKOFF_START_MS * 2 ** Math.min(tries, 8);
  return growth > BACKOFF_CEILING_MS ? BACKOFF_CEILING_MS : growth;
}

// POST the bound port until the env accepts it. 200 is the normal answer; a
// 409 means another registration already won and is left alone; 400 and 405
// are contract errors that end the process; anything else is retried, since
// the env may still be coming up.
async function register(port: number): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    const fatal = new Error('register was refused');
    try {
      const answer = await fetch(ENV_URL + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        fatal.message = 'register answered HTTP ' + answer.status + ': ' + (await answer.text());
        throw fatal;
      }
    } catch (err) {
      if (err === fatal) throw err;
    }
    await wait(backoffMs(tries));
  }
}

// Poll the env until it answers {"done": true}. A slow or failed poll only
// means it is not done yet, so it is retried with the same backoff.
async function awaitDone(): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      const answer = await fetch(ENV_URL + '/done', { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: poll again.
    }
    await wait(backoffMs(tries));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, () => { ok(); });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('no ephemeral TCP port was bound');
  process.stdout.write('[entry] bound port ' + bound.port + '\n');

  await register(bound.port);
  process.stdout.write('[entry] registered; polling the env for done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write('[entry] ' + (err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}

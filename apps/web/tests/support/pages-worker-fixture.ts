import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import page from '../../src/kernel/recorded/subject-page.json';
import missing from '../../src/kernel/recorded/missing-subject-page.json';
import active from '../../src/kernel/recorded/definitions-active.json';
import release from '../../src/kernel/recorded/definitions-release.json';
import reactions from '../../src/kernel/recorded/subject-reactions.json';

export { page };
export const definitionPath = `/v1/definitions/releases/${encodeURIComponent(active.digest)}`;
export const missingId = '00000000-0000-4000-8000-000000000000';

type Call = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
  cookie: string | null;
  language: string | null;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Recorded public HTTP responses only: this network fixture proves no kernel/Auth behavior. */
export async function startPagesWorker() {
  const calls: Call[] = [];
  // This upstream-only canary is deliberately never included in a public response.
  const privateSentinel = 'upstream-only-private-pages-canary';
  const state = await mkdtemp(join(tmpdir(), 'rezics-pages-worker-'));
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-12_000);
  };
  const json = (recording: { status: number }, status = recording.status) => {
    const { status: _status, ...body } = recording;
    return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  };
  let network: ReturnType<typeof Bun.serve>;
  try {
    network = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body: unknown = request.method === 'POST' ? await request.json() : null;
        calls.push({
          method: request.method,
          path,
          body,
          authorization: request.headers.get('authorization'),
          cookie: request.headers.get('cookie'),
          language: request.headers.get('accept-language'),
        });
        if (request.method === 'POST' && path === '/v1/pages:read') {
          // Preserve the default overview target; never invent named-view documents.
          if (JSON.stringify(body) === JSON.stringify({ target: { subject: page.subject }, languages: ['en'] }))
            return json(page);
          return json(missing);
        }
        if (request.method === 'GET') {
          if (path === '/v1/definitions/active') return json(active);
          if (path === definitionPath) return json(release);
          if (path === `/v1/subjects/${page.subject}`) return Response.json(page.reads.r0.body);
          if (path === `/v1/subjects/${page.subject}/reactions`) return json(reactions);
          if (path === `/v1/subjects/${page.subject}/ratings`) {
            const populations = new URL(request.url).searchParams.getAll('population');
            return Response.json({
              question: new URL(request.url).searchParams.get('question'),
              subject: page.subject,
              figures: populations.map((population) => ({
                population,
                count: 0,
                freshness: { asOf: null, updating: false },
              })),
            });
          }
          if (path === `/v1/subjects/${page.subject}/source-statistics`) return Response.json([]);
        }
        return json(missing);
      },
    });
  } catch (cause) {
    await rm(state, { recursive: true });
    throw cause;
  }
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  let ended = false;
  let exit = 'not started';
  let stopped: Promise<void> | undefined;
  const diagnostics = () =>
    `app process: ${exit}\nVite/Cloudflare output (tail):\n${output}\nNetwork fixture calls:\n${JSON.stringify(calls.slice(-40))}`;
  const groupAlive = () => {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const signal = (name: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const waitForGroup = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    while (!ended || groupAlive()) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(50);
    }
    await closed;
    return true;
  };
  const stop = () =>
    (stopped ??= (async () => {
      let failure: Error | undefined;
      if (child && closed) {
        if (exit !== 'running') failure = new Error(`app exited before teardown\n${diagnostics()}`);
        signal('SIGTERM');
        if (!(await waitForGroup(10_000))) {
          signal('SIGKILL');
          // Forced termination is a failure, even when all owned processes are subsequently reaped.
          failure = new Error(`app did not stop gracefully\n${diagnostics()}`);
          if (!(await waitForGroup(10_000))) {
            await network.stop(true);
            throw new Error(`app process group remains alive; retaining owned state ${state}\n${diagnostics()}`);
          }
        }
      }
      await network.stop(true);
      await rm(state, { recursive: true });
      if (failure) throw failure;
    })());
  try {
    const origin = `http://127.0.0.1:${await freePort()}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KERNEL_ORIGIN: network.url.origin,
      REZICS_TEST_RUNTIME: '1',
      WEB_TEST_STATE_DIR: state,
      WEB_TEST_STATE_INSTANCE_DIR: state,
      PUBLIC_ORIGIN: 'https://rezics.com',
    };
    // Auth text bindings come from process.env in cloudflare.config.ts, not .dev.vars.
    // Removing them disables Auth even when .dev.vars contains development Auth values.
    for (const name of ['AUTH_ISSUER', 'WEBSITE_CLIENT_ID', 'API_RESOURCE', 'WEBSITE_SCOPES', 'WORKER_INSPECTOR_PORT'])
      delete env[name];
    // The client key is server configuration, never a visitor credential. The local .dev.vars
    // secret takes precedence; this generated development key also covers an absent vars file.
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    env.WEBSITE_CLIENT_KEY = JSON.stringify({
      ...(await exportJWK(privateKey)),
      kid: 'anonymous-pages-worker',
      alg: 'ES256',
      use: 'sig',
    });
    // This is the same app command/config as auth-binding.host.test.ts. Its Cloudflare plugin runs
    // the ssr environment in workerd; the real route also imports cloudflare:workers bindings.
    child = spawn(
      'bun',
      ['--no-env-file', 'run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'],
      {
        cwd: join(import.meta.dir, '../..'),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      },
    );
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    exit = 'running';
    child.once('exit', (code, signal) => {
      exit = `code=${code}, signal=${signal}`;
    });
    child.once('error', (error) => {
      exit = error.message;
    });
    closed = new Promise((resolve) =>
      child!.once('close', () => {
        ended = true;
        resolve();
      }),
    );
    const assertRunning = () => {
      if (output.includes('Missing required secrets'))
        throw new Error(`app is missing local Worker configuration\n${diagnostics()}`);
      if (ended || child!.exitCode !== null || child!.signalCode !== null || exit !== 'running')
        throw new Error(`app exited unexpectedly\n${diagnostics()}`);
    };
    const deadline = Date.now() + 150_000;
    for (;;) {
      assertRunning();
      try {
        // A missing page warms the actual SSR graph without consuming the subject-page proof read.
        const response = await fetch(`${origin}/en/subjects/${missingId}`, { signal: AbortSignal.timeout(10_000) });
        await response.text();
        if (response.status === 404) break;
      } catch {}
      if (Date.now() >= deadline) throw new Error(`app startup deadline exceeded\n${diagnostics()}`);
      await Bun.sleep(250);
    }
    // Exercise the real Worker boundary: local vars must not re-enable issuer discovery.
    const signIn = await fetch(`${origin}/auth/sign-in?return_to=/en`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await signIn.text();
    assertRunning();
    if (
      signIn.status !== 503 ||
      signIn.headers.has('location') ||
      signIn.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-rezics_session='))
    )
      throw new Error(`anonymous fixture unexpectedly enabled Auth\n${diagnostics()}`);
    return {
      calls,
      privateSentinel,
      stop,
      async request(id: string) {
        try {
          assertRunning();
          const response = await fetch(`${origin}/en/subjects/${id}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(30_000),
          });
          const html = await response.text();
          assertRunning();
          return { response, html };
        } catch (cause) {
          throw new Error(`Workers request failed\n${diagnostics()}`, { cause });
        }
      },
      async verify(assertions: () => Promise<void>) {
        try {
          await assertions();
          assertRunning();
        } catch (cause) {
          throw new Error(`Workers SSR assertion failed\n${diagnostics()}`, { cause });
        }
      },
    };
  } catch (cause) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], `Workers startup and cleanup failed\n${diagnostics()}`);
    }
    throw cause;
  }
}

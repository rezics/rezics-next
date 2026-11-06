import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDevServer } from './dev-server.ts';
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

/** Recorded public HTTP responses only: this network fixture proves no kernel/Auth behavior. */
export async function startPagesWorker() {
  const calls: Call[] = [];
  // This upstream-only canary is deliberately never included in a public response.
  const privateSentinel = 'upstream-only-private-pages-canary';
  const state = await mkdtemp(join(tmpdir(), 'rezics-pages-worker-'));
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
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let stopped: Promise<void> | undefined;
  const diagnostics = () =>
    `Vite/Cloudflare output (tail):\n${server?.diagnostics() ?? '(not started)'}\nNetwork fixture calls:\n${JSON.stringify(calls.slice(-40))}`;
  const stop = () =>
    (stopped ??= (async () => {
      await server?.stop();
      await network.stop(true);
      await rm(state, { recursive: true });
    })());
  try {
    const env: NodeJS.ProcessEnv = {
      KERNEL_ORIGIN: network.url.origin,
      REZICS_TEST_RUNTIME: '1',
      WEB_TEST_STATE_DIR: state,
      WEB_TEST_STATE_INSTANCE_DIR: state,
      PUBLIC_ORIGIN: 'https://rezics.com',
      AUTH_ISSUER: '',
      WEBSITE_CLIENT_ID: '',
      API_RESOURCE: '',
      WEBSITE_SCOPES: '',
      WORKER_INSPECTOR_PORT: '',
    };
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    env.WEBSITE_CLIENT_KEY = JSON.stringify({
      ...(await exportJWK(privateKey)),
      kid: 'anonymous-pages-worker',
      alg: 'ES256',
      use: 'sig',
    });
    server = await startDevServer({
      exclusive: true,
      cwd: join(import.meta.dir, '../..'),
      command: ({ port }) => [
        'bun',
        '--no-env-file',
        'run',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      env,
      warmUpPaths: [],
      firstPath: `/en/subjects/${missingId}`,
    });
    const origin = server.origin;
    const signIn = await fetch(`${origin}/auth/sign-in?return_to=/en`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await signIn.text();
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
          const response = await fetch(`${origin}/en/subjects/${id}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(30_000),
          });
          const html = await response.text();
          return { response, html };
        } catch (cause) {
          throw new Error(`Workers request failed\n${diagnostics()}`, { cause });
        }
      },
      async verify(assertions: () => Promise<void>) {
        try {
          await assertions();
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

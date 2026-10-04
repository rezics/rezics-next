import { Elysia } from 'elysia';
import { httpTelemetry } from '../src/elysia.ts';
import { shutdownTelemetry, startTelemetry } from '../src/runtime.ts';
import { postgresPeer } from './postgres-fixture.ts';

const real = process.env.WORK_PROFILE_REAL === '1';
let handleAccount: (request: Request) => Response | Promise<Response> = () =>
  new Response(null, { status: 503 });
const account = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return handleAccount(request);
  },
});
const fuseki = real
  ? undefined
  : Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        Response.json(
          { results: { bindings: [{ value: { value: '1' } }] } },
          { headers: { 'server-timing': 'jena;dur=7.5;desc="PRIVATE_QUERY"' } },
        ),
    });
const fusekiUrl = real ? process.env.FUSEKI_URL! : `${fuseki!.url.origin}/rezics/`;
startTelemetry('main', {
  ...process.env,
  FUSEKI_URL: fusekiUrl,
  ACCOUNT_INTROSPECT_URL: `${account.url.origin}/introspect`,
});
const accountApp = new Elysia()
  .use(httpTelemetry())
  .get('/introspect', ({ request }) =>
    Response.json({ traceparent: request.headers.get('traceparent') }),
  );
handleAccount = (request) => accountApp.handle(request);
const pgPeer = real ? undefined : postgresPeer();
// The SDK must initialize before importing pg; otherwise a zero SQL count is meaningless.
const { Pool } = await import('pg');
const pool = real
  ? new Pool({ connectionString: process.env.ACCESS_DATABASE_URL })
  : new Pool({
      host: '127.0.0.1',
      port: pgPeer!.port,
      user: 'telemetry',
      database: 'telemetry',
      ssl: false,
    });
let phase = 'startup';
const app = new Elysia()
  .use(httpTelemetry())
  .error(({ error }) =>
    Response.json(
      {
        phase,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
      { status: 500 },
    ),
  )
  .get('/profile/:id', async () => {
    const loops = Number(process.env.WORK_PROFILE_LOOPS);
    const rows: string[] = [];
    for (let index = 0; index < loops; index++) {
      phase = 'Fuseki calibration';
      const response = await fetch(
        new URL('query', fusekiUrl.endsWith('/') ? fusekiUrl : `${fusekiUrl}/`),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/sparql-query',
            accept: 'application/sparql-results+json',
          },
          body: 'SELECT (1 AS ?value) WHERE {} # PRIVATE_SPARQL_LITERAL',
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) throw new Error(`Fuseki returned HTTP ${response.status}`);
      const data = (await response.json()) as {
        results: { bindings: { value: { value: string } }[] };
      };
      rows.push(data.results.bindings[0]!.value.value);
      phase = 'PostgreSQL calibration';
      await pool.query('SELECT 1 AS value /* PRIVATE_SQL_LITERAL */');
    }
    phase = 'Account calibration';
    const response = await fetch(`${account.url.origin}/introspect?token=PRIVATE_QUERY`, {
      headers: { authorization: 'Bearer PRIVATE_TOKEN' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Account calibration returned HTTP ${response.status}`);
    return { rows, account: await response.json() };
  })
  .listen({ hostname: '127.0.0.1', port: 0, idleTimeout: 60 });
try {
  const started = performance.now();
  const response = await fetch(`${app.server!.url.origin}/profile/PRIVATE_ID?query=PRIVATE_QUERY`, {
    headers: { traceparent: process.env.WORK_PROFILE_TRACEPARENT! },
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`Profile probe returned HTTP ${response.status}: ${JSON.stringify(result)}`);
  console.log(
    JSON.stringify({
      ...(result as Record<string, unknown>),
      totalLatencyMs: performance.now() - started,
    }),
  );
} finally {
  await app.stop();
  await pool.end();
  pgPeer?.stop(true);
  await account.stop(true);
  await fuseki?.stop(true);
  await shutdownTelemetry();
}

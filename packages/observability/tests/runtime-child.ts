import { Elysia } from 'elysia';
import { context, trace } from '@opentelemetry/api';
import { httpTelemetry } from '../src/elysia.ts';
import { shutdownTelemetry, startTelemetry, withTelemetrySpan } from '../src/runtime.ts';
import { telemetryLog } from '../src/log.ts';
import { postgresPeer } from './postgres-fixture.ts';

const remote = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return Response.json({
      traceparent: request.headers.get('traceparent'),
      authorization: request.headers.get('authorization'),
    });
  },
});
startTelemetry('rezics-telemetry-test', {
  ...process.env,
  OTEL_PROPAGATION_ORIGINS: remote.url.origin,
});
const pgPeer = postgresPeer();
const { Pool } = await import('pg');
const pool = new Pool({
  host: '127.0.0.1',
  port: pgPeer.port,
  user: 'telemetry',
  database: 'telemetry',
  ssl: false,
});
await withTelemetrySpan('database.operation', () => pool.query("SELECT 'PRIVATE_SQL_LITERAL'"));
await pool.end();
pgPeer.stop(true);
const app = new Elysia()
  .use(httpTelemetry())
  .mapResponse(({ path }) =>
    path === '/mapped' ? new Response('recovered', { status: 200 }) : undefined,
  )
  .get('/ok/:id', async () => {
    const before = trace.getSpan(context.active())!.spanContext().traceId;
    await Bun.sleep(15);
    const after = trace.getSpan(context.active())!.spanContext().traceId;
    telemetryLog('request_completed', 'info', { authorization: 'PRIVATE_LOG_SECRET' });
    return { before, after };
  })
  .get('/response', () => new Response('unavailable', { status: 503 }))
  .get('/mapped', () => new Response('replaced', { status: 503 }))
  .get('/set', ({ set }) => {
    set.status = 503;
    return 'unavailable';
  })
  .get('/throw', () => {
    throw new Error('PRIVATE_ERROR_LITERAL');
  })
  .get('/redirect', () => Response.redirect('https://example.org', 302))
  .get(
    '/stream',
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: ok\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  )
  .mount('/auth', () => new Response('unauthorized', { status: 401 }))
  .listen({ hostname: '127.0.0.1', port: 0 });
const base = app.server!.url.origin;
const ids = ['11111111111111111111111111111111', '22222222222222222222222222222222'];
const result = await Promise.all(
  ids.map(async (id) => {
    const r = await fetch(`${base}/ok/PRIVATE_PATH?search=PRIVATE_QUERY`, {
      headers: {
        traceparent: `00-${id}-3333333333333333-01`,
        authorization: 'Bearer PRIVATE_TOKEN',
        cookie: 'session=PRIVATE_COOKIE',
      },
    });
    return r.json();
  }),
);
const responses: Record<string, number> = {};
for (const path of [
  '/response',
  '/mapped',
  '/set',
  '/throw',
  '/redirect',
  '/stream',
  '/auth/path',
  '/missing/PRIVATE_UNMATCHED',
]) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' });
  responses[path] = response.status;
  await response.text();
}
const outbound = await withTelemetrySpan('public.operation', async () => {
  const response = await fetch(`${remote.url.origin}/PRIVATE_PATH?token=PRIVATE_TOKEN`, {
    headers: { authorization: 'Bearer PRIVATE_TOKEN' },
  });
  return response.json();
});
await app.stop();
await remote.stop(true);
await shutdownTelemetry();
await shutdownTelemetry();
console.log(JSON.stringify({ result, outbound, responses }));

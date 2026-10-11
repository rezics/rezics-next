import { expect, test } from 'bun:test';
import { context, trace } from '@opentelemetry/api';
import { opentelemetry } from '@elysia/opentelemetry';
import { Elysia } from 'elysia';
import { httpTelemetry } from './elysia.ts';
import { telemetryEnabled } from './runtime.ts';

test('HTTP telemetry keeps the live socket and separate incoming trace IDs', async () => {
  expect(telemetryEnabled()).toBe(false);
  const traceIds = [
    '0123456789abcdef0123456789abcdef',
    'fedcba9876543210fedcba9876543210',
  ];
  const observed: Array<{ server: unknown; traceId: string | undefined }> = [];
  const app = new Elysia()
    .use(httpTelemetry())
    .get('/identity', ({ request, server }) => {
      const traceId = trace.getSpan(context.active())?.spanContext().traceId;
      observed.push({ server, traceId });
      return Response.json({
        address: server?.requestIP(request)?.address ?? null,
        traceId: traceId ?? null,
      });
    })
    .listen({ hostname: '127.0.0.1', port: 0 });

  try {
    const results = await Promise.all(traceIds.map(async (traceId) => {
      const response = await fetch(`${app.server!.url.origin}/identity`, {
        headers: { traceparent: `00-${traceId}-0123456789abcdef-01` },
      });
      expect(response.status).toBe(200);
      return response.json();
    }));

    expect(results).toEqual(traceIds.map((traceId) => ({ address: '127.0.0.1', traceId })));
    expect(observed).toHaveLength(traceIds.length);
    expect(observed.every(({ server }) => server === app.server)).toBe(true);
    expect(observed.map(({ traceId }) => traceId).sort()).toEqual([...traceIds].sort());
  } finally {
    await app.stop(true);
  }
});

test('HTTP telemetry bypass keeps the live socket argument', async () => {
  expect(telemetryEnabled()).toBe(false);
  // Establish the no-exporter request provider before exercising the plugin's
  // direct bypass branch, so the plugin does not initialize a default SDK.
  httpTelemetry();
  let traceChecks = 0;
  const observed: Array<{ server: unknown; address: string | null }> = [];
  const app = new Elysia()
    .use(opentelemetry({ checkIfShouldTrace: () => { traceChecks++; return false; } }))
    .get('/identity', ({ request, server }) => {
      const address = server?.requestIP(request)?.address ?? null;
      observed.push({ server, address });
      return Response.json({ address });
    })
    .listen({ hostname: '127.0.0.1', port: 0 });

  try {
    const response = await fetch(`${app.server!.url.origin}/identity`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ address: '127.0.0.1' });
    expect(traceChecks).toBe(1);
    expect(observed).toEqual([{ server: app.server, address: '127.0.0.1' }]);
  } finally {
    await app.stop(true);
  }
});

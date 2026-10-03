import { expect, test } from 'bun:test';
import {
  assertWorkCost,
  assertWorkCostAtScales,
  summarizeWorkProfile,
  startWorkProfileSink,
  type WorkProfile,
  type WorkSpan,
} from '../support/work-profile.ts';
import { workProfileProbe } from '../support/work-profile-probe.ts';
import { aspireWorkProfileSource } from '../support/work-profile-aspire.ts';
import { fusekiEngineTime } from '../../../packages/observability/src/http-measurement.ts';
import { startFusekiMeter } from '../../../scripts/load/measurement.ts';

test('G1024: exported counters detect repeated Fuseki and PostgreSQL work before their zeros are trusted', async () => {
  const profiles: WorkProfile[] = [];
  for (const loops of [1, 4, 9]) {
    const { result, profile } = await workProfileProbe(loops);
    expect(result.rows).toEqual(Array.from({ length: loops }, () => '1'));
    expect(result.account.traceparent.split('-')[1]).toBe(profile.traceId);
    expect(profile.request).toEqual({ service: 'main', route: '/profile/:id', status: 200 });
    expect(profile.fusekiRequests).toBe(loops);
    expect(profile.postgresStatements).toBe(loops);
    expect(profile.fusekiCalls).toHaveLength(loops);
    expect(
      profile.fusekiCalls.every(
        (call) => call.durationMs > 0 && call.headersMs !== null && call.bodyReadMs !== null,
      ),
    ).toBe(true);
    expect(profile.postgres).toHaveLength(loops);
    expect(profile.postgres.every((statement) => statement.durationMs > 0)).toBe(true);
    expect(profile.accountCalls).toBe(1);
    expect(profile.fusekiSentBytes).toBe(
      loops * Buffer.byteLength('SELECT (1 AS ?value) WHERE {} # PRIVATE_SPARQL_LITERAL'),
    );
    expect(profile.fusekiReceivedBytes).toBeGreaterThan(loops * 30);
    expect(profile.fusekiEngineMs).toBe(loops * 7.5);
    expect(profile.serverLatencyMs).toBeGreaterThan(0);
    expect(profile.totalLatencyMs).toBeGreaterThan(0);
    expect(JSON.stringify(profile)).not.toContain('PRIVATE_');
    profiles.push(profile);
  }
  expect(() =>
    assertWorkCostAtScales(profiles, { fusekiRequests: 3, postgresStatements: 3 }),
  ).toThrow('Request cost contract failed');
  assertWorkCostAtScales(profiles, { fusekiRequests: 9, postgresStatements: 9, accountCalls: 1 });
}, 30_000);

const traceId = '1'.repeat(32),
  parent = '2'.repeat(16);
function span(
  id: string,
  parentSpanId: string,
  attributes: Record<string, unknown> = {},
  kind = 2,
): WorkSpan {
  return {
    traceId,
    spanId: id.repeat(16),
    parentSpanId,
    service: 'main',
    name: 'safe',
    kind,
    startMs: 100,
    endMs: 150,
    attributes,
  };
}
const root = span('3', parent, { 'http.route': '/v1/feed', 'http.response.status_code': 503 }, 1);

test('G1024: deduplication, sibling traces and missing/cancelled byte observations cannot pass a cost bound', () => {
  const fetch = span('4', root.spanId, {
    'http.request.method': 'POST',
    'rezics.peer.service': 'fuseki',
    'http.response.body.size': 0,
    'rezics.http.body.complete': false,
  });
  const unrelated = span('5', '6'.repeat(16), fetch.attributes);
  const profile = summarizeWorkProfile([root, fetch, fetch, unrelated], traceId, parent, 60);
  expect(profile.fusekiRequests).toBe(1);
  expect(profile.fusekiReceivedBytes).toBeNull();
  expect(profile.fusekiEngineMs).toBeNull();
  expect(() => assertWorkCost(profile, { fusekiReceivedBytes: 10 })).toThrow('unobserved');
  expect(() => summarizeWorkProfile([], traceId, parent, 0)).toThrow('server span');
  expect(() => assertWorkCostAtScales([profile], {})).toThrow('three scales');
  expect(() => assertWorkCost(profile, { fusekiRequests: -1 })).toThrow('Invalid');
});

test('G1024: missing OTLP export fails collection rather than returning a zero profile; sink requires authentication', async () => {
  const sink = startWorkProfileSink({ timeoutMs: 100, settleMs: 0 });
  try {
    expect((await fetch(`${sink.url}/v1/traces`, { method: 'POST' })).status).toBe(401);
    await expect(sink.collect(traceId, parent)).rejects.toThrow('telemetry is missing');
  } finally {
    await sink.stop();
  }
});

test('G1024: unclassified fetches and missing Account server spans cannot impersonate zero storage work', () => {
  const successful = { ...root, attributes: { 'http.response.status_code': 200 } };
  const outbound = span('4', root.spanId, {
    'http.request.method': 'GET',
    'server.address': '127.0.0.1',
    'server.port': 3030,
  });
  const unknown = summarizeWorkProfile([successful, outbound], traceId, parent, 60);
  expect(unknown.unclassifiedFetches).toBe(1);
  expect(unknown.fusekiRequests).toBeNull();
  expect(unknown.fusekiEngineMs).toBeNull();
  const missingOrigin = summarizeWorkProfile([successful, outbound], traceId, parent, 60, {
    peers: { fuseki: undefined },
  });
  expect(missingOrigin.unclassifiedFetches).toBe(1);
  expect(() => assertWorkCost(unknown, { fusekiRequests: 0 })).toThrow('peer classification');
  const recognized = summarizeWorkProfile([successful, outbound], traceId, parent, 60, {
    peers: { fuseki: 'http://127.0.0.1:3030' },
  });
  expect(recognized.fusekiRequests).toBe(1);
  const account = {
    ...outbound,
    attributes: { ...outbound.attributes, 'rezics.peer.service': 'account' },
  };
  const incomplete = summarizeWorkProfile([successful, account], traceId, parent, 60);
  expect(incomplete.postgresStatements).toBeNull();
  expect(() => assertWorkCost(incomplete, { postgresStatements: 0 })).toThrow(
    'owner SQL descendants',
  );
  const remote = { ...span('5', account.spanId, {}, 1), service: 'account' };
  const statement = {
    ...span('6', remote.spanId, { 'db.system.name': 'postgresql' }),
    service: 'account',
  };
  const complete = summarizeWorkProfile(
    [successful, account, remote, statement],
    traceId,
    parent,
    60,
  );
  expect(complete.postgresStatements).toBe(1);
  expect(complete.postgres[0]!.service).toBe('account');
  assertWorkCost(complete, { postgresStatements: 1, accountCalls: 1 });
});

test('G1024: Aspire collects a whole trace and refuses truncation and authentication errors', async () => {
  let mode: 'valid' | 'truncated' | 'denied' = 'valid';
  const dashboard = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      expect(request.headers.get('x-api-key')).toBe('local-test');
      expect(new URL(request.url).pathname).toBe(`/api/telemetry/traces/${traceId}`);
      if (mode === 'denied') return new Response(null, { status: 401 });
      return Response.json({
        totalCount: mode === 'truncated' ? 2 : 1,
        returnedCount: 1,
        data: {
          resourceSpans: [
            {
              resource: { attributes: [{ key: 'service.name', value: { stringValue: 'main' } }] },
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId,
                      spanId: root.spanId,
                      parentSpanId: parent,
                      name: 'GET /v1/feed',
                      kind: 2,
                      startTimeUnixNano: '100000000',
                      endTimeUnixNano: '150000000',
                      attributes: [
                        { key: 'http.response.status_code', value: { intValue: '200' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    },
  });
  const source = aspireWorkProfileSource({
    dashboardOrigin: dashboard.url.origin,
    apiKey: 'local-test',
    settleMs: 0,
  });
  try {
    expect((await source.collect(traceId, parent))[0]!.endMs).toBe(150);
    mode = 'truncated';
    await expect(source.collect(traceId, parent)).rejects.toThrow('truncated');
    mode = 'denied';
    await expect(source.collect(traceId, parent)).rejects.toThrow('HTTP 401');
  } finally {
    await dashboard.stop(true);
  }
});

test('G1024: native timer is numeric, and absent or malformed timers remain unobserved', () => {
  expect(fusekiEngineTime(new Headers({ 'server-timing': 'jena;dur=0' }))).toBe(0);
  expect(
    fusekiEngineTime(new Headers({ 'server-timing': 'cache;dur=9, jena;dur=2.25;desc="private"' })),
  ).toBe(2.25);
  for (const timer of ['', 'jena;dur=-1', 'jena;dur=NaN', 'network;dur=7', 'jena;dur=5oops'])
    expect(fusekiEngineTime(new Headers({ 'server-timing': timer }))).toBeUndefined();
});

test('G1024: streaming consumption and cancellation export partial bytes and preserve an empty response', async () => {
  const sink = startWorkProfileSink({ settleMs: 0 });
  try {
    // A finite child gives SDK providers independent lifetime and exercises actual Bun fetch.
    const child = Bun.spawn(
      [process.execPath, 'packages/observability/tests/work-profile-stream-child.ts'],
      {
        env: { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout) as { pulls: number; cancellations: number };
    expect(result.pulls).toBeGreaterThan(0);
    expect(result.pulls).toBeLessThan(20);
    expect(result.cancellations).toBe(1);
    const fetches = sink
      .snapshot()
      .filter((span) => span.attributes['rezics.peer.service'] === 'fuseki');
    expect(fetches).toHaveLength(3);
    const cancelled = fetches.find(
      (span) => span.attributes['rezics.http.body.complete'] === false,
    )!;
    expect(cancelled.attributes['rezics.http.body.complete']).toBe(false);
    expect(cancelled.attributes['http.response.body.size']).toBeGreaterThan(0);
    const empty = fetches.find((span) => span.attributes['http.response.status_code'] === 204)!;
    expect(empty.attributes['rezics.http.body.complete']).toBe(true);
    expect(empty.attributes['http.response.body.size']).toBe(0);
  } finally {
    await sink.stop();
  }
}, 10_000);

test('G1024: Fuseki meter keeps HTTP latency separate, groups W3C requests and refuses an unknown engine total', async () => {
  let nativeTimer = true;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('payload', {
        headers: nativeTimer ? { 'server-timing': 'jena;dur=2.5' } : {},
      }),
  });
  const meter = startFusekiMeter(`${upstream.url.origin}/rezics/`);
  try {
    meter.beginTraceCapture();
    const headers = { traceparent: `00-${traceId}-${parent}-01` };
    await (await fetch(`${meter.url}query`, { method: 'POST', headers, body: 'ASK {}' })).text();
    expect(meter.timingSnapshot()).toMatchObject({
      engineMs: 2.5,
      measuredCalls: 1,
      unobservedCalls: 0,
    });
    nativeTimer = false;
    await (await fetch(`${meter.url}query`, { method: 'POST', headers, body: 'ASK {}' })).text();
    const captured = meter.endTraceCapture();
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      traceId,
      spanId: parent,
      sentBytes: 6,
      receivedBytes: 7,
      engineMs: 2.5,
    });
    expect(captured[1]!.engineMs).toBeNull();
    expect(meter.timingSnapshot().engineMs).toBeNull();
    expect(meter.snapshot().calls).toBe(2);
  } finally {
    await meter.stop();
    await upstream.stop(true);
  }
});

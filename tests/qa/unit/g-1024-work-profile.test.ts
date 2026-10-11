import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import protobuf from 'protobufjs';
import {
  assertWorkCost,
  assertWorkCostAtScales,
  summarizeWorkProfile,
  profileRequest,
  startWorkProfileSink,
  type WorkProfile,
  type WorkSpan,
  type WorkCostContract,
  type WorkCostGrowthClass,
} from '../support/work-profile.ts';
import { workProfileProbe } from '../support/work-profile-probe.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import { aspireWorkProfileSource } from '../support/work-profile-aspire.ts';
import { fusekiEngineTime } from '../../../packages/observability/src/http-measurement.ts';
import { startFusekiMeter } from '../../../scripts/load/measurement.ts';

for (const mode of ['success', 'failure', 'deadline'] as const) {
  test(`work profile child retains complete stdout and stderr after ${mode}`, async () => {
    const directory = mkdtempSync(join(process.cwd(), '.temp', 'work-profile-child-'));
    const infoPath = join(directory, 'info.json');
    const entry = join(directory, 'child.ts');
    const stdout = `stdout-start\n${'o'.repeat(8192)}\nstdout-end\n`;
    const stderr = `stderr-start\n${'e'.repeat(8192)}\nstderr-end\n`;
    let resultPath: string | undefined;
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.WORK_PROFILE_TEST_INFO!, JSON.stringify({
  pid: process.pid,
  resultPath: process.env.REZICS_WORK_PROFILE_RESULT,
}));
await Bun.write(Bun.stdout, ${JSON.stringify(stdout)});
await Bun.write(Bun.stderr, ${JSON.stringify(stderr)});
if (process.env.WORK_PROFILE_TEST_MODE === 'failure') process.exit(7);
if (process.env.WORK_PROFILE_TEST_MODE === 'deadline') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 100);
}
`,
    );
    try {
      let message = '';
      let result: Awaited<ReturnType<typeof runWorkProfileChild>> | undefined;
      try {
        result = await runWorkProfileChild(entry, {
          timeoutMs: mode === 'deadline' ? 1000 : 5000,
          env: { WORK_PROFILE_TEST_INFO: infoPath, WORK_PROFILE_TEST_MODE: mode },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      const info = JSON.parse(readFileSync(infoPath, 'utf8')) as {
        pid: number;
        resultPath: string;
      };
      resultPath = info.resultPath;
      expect(readFileSync(`${resultPath}.stdout.log`, 'utf8')).toBe(stdout);
      expect(readFileSync(`${resultPath}.stderr.log`, 'utf8')).toBe(stderr);
      expect(() => process.kill(info.pid, 0)).toThrow();
      if (mode === 'success') {
        expect(message).toBe('');
        expect(result).toEqual({ stdout, resultPath });
      } else {
        expect(result).toBeUndefined();
        expect(message).toContain(mode === 'failure' ? 'failed (7)' : 'exceeded 1000ms');
        expect(message).toContain(`stdout retained at ${resultPath}.stdout.log`);
        expect(message).toContain(`stderr retained at ${resultPath}.stderr.log`);
        expect(message).toContain('stdout-end');
        expect(message).toContain('stderr-end');
        expect(message).not.toContain('stdout-start');
        expect(message).not.toContain('stderr-start');
        expect(message.length).toBeLessThan(5000);
      }
    } finally {
      if (resultPath) {
        rmSync(`${resultPath}.stdout.log`, { force: true });
        rmSync(`${resultPath}.stderr.log`, { force: true });
        rmSync(resultPath, { force: true });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
}

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

const successfulRoot = {
  ...root,
  attributes: { ...root.attributes, 'http.response.status_code': 200 },
};

function costProfiles(values: (number | null)[], scales = [4, 16, 64]): WorkProfile[] {
  return values.map((value, index) => ({
    ...summarizeWorkProfile([successfulRoot], traceId, parent, 60),
    mainCalls: scales[index]!,
    fusekiRequests: value,
  }));
}

function growthContract(growthClass: WorkCostGrowthClass, maximum = 10_000): WorkCostContract {
  return {
    fusekiRequests: maximum,
    growth: { fusekiRequests: { class: growthClass, dimension: 'mainCalls' } },
  };
}

function assertGrowth(
  values: (number | null)[],
  growthClass: WorkCostGrowthClass,
  label: string,
): void {
  assertWorkCostAtScales(costProfiles(values), growthContract(growthClass), label);
}

test('work cost contracts enforce declared counter growth and retain absolute-only bounds', () => {
  expect(() => assertGrowth([7, 7, 7], 'constant', 'constant-growth')).not.toThrow();
  expect(() => assertGrowth([4, 16, 64], 'linear', 'linear-growth')).not.toThrow();
  expect(() => assertGrowth([4, 16, 64], 'constant', 'linear-as-constant')).toThrow(
    'Cost growth contract failed',
  );
  expect(() => assertGrowth([4, 16, 64], 'logarithmic', 'linear-as-logarithmic')).toThrow(
    'Cost growth contract failed',
  );

  expect(() => assertGrowth([16, 256, 4096], 'linear', 'quadratic-as-linear')).toThrow(
    'Cost growth contract failed',
  );
  expect(() => assertGrowth([16, 256, 4096], 'linearithmic', 'quadratic-as-linearithmic')).toThrow(
    'Cost growth contract failed',
  );
  expect(() => assertGrowth([12, 80, 448], 'linearithmic', 'nlogn-growth')).not.toThrow();
  expect(() => assertGrowth([12, 80, 448], 'linear', 'nlogn-as-linear')).toThrow(
    'Cost growth contract failed',
  );

  expect(() => assertGrowth([0, 1, 2], 'linear', 'zero-to-positive')).toThrow(
    'Cost growth contract failed',
  );
  expect(() => assertGrowth([4, null, 64], 'linear', 'unobserved-growth')).toThrow(
    'fusekiRequests: unobserved',
  );
  expect(() =>
    assertWorkCostAtScales(costProfiles([4, 16, 64]), { fusekiRequests: 64 }, 'absolute-only'),
  ).not.toThrow();
  expect(() =>
    assertWorkCostAtScales(costProfiles([4, 16, 65]), { fusekiRequests: 64 }, 'absolute-cap'),
  ).toThrow('fusekiRequests: 65 > 64');
});

test('growth-only work cost contracts compare counters across the declared dimension', () => {
  const growthOnly: WorkCostContract = {
    growth: { fusekiRequests: { class: 'linear', dimension: 'mainCalls' } },
  };
  expect(() =>
    assertWorkCostAtScales(costProfiles([4, 16, 64]), growthOnly, 'growth-only-pass'),
  ).not.toThrow();
  expect(() =>
    assertWorkCostAtScales(costProfiles([4, 20, 64]), growthOnly, 'growth-only-fail'),
  ).toThrow('Cost growth contract failed');
});

test('work cost growth breaches report and write their comparison facts', () => {
  const directory = mkdtempSync(join(process.cwd(), '.temp', 'work-cost-growth-'));
  const previousArtifactDir = process.env.REZICS_QA_ARTIFACT_DIR;
  try {
    process.env.REZICS_QA_ARTIFACT_DIR = directory;
    let message = '';
    try {
      assertGrowth([4, 16, 64], 'constant', 'constant-growth-breach');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('fusekiRequests (constant) by mainCalls');
    expect(message).toContain('scales 4 and 16, values 4 and 16');
    expect(message).toContain('allowed ratio 1.2, observed ratio 4');
    expect(
      JSON.parse(readFileSync(join(directory, 'constant-growth-breach.json'), 'utf8')),
    ).toEqual({
      counter: 'fusekiRequests',
      dimension: 'mainCalls',
      growthClass: 'constant',
      smallerScale: 4,
      largerScale: 16,
      smallerValue: 4,
      largerValue: 16,
      allowedRatio: 1.2,
      observedRatio: 4,
    });
  } finally {
    if (previousArtifactDir === undefined) delete process.env.REZICS_QA_ARTIFACT_DIR;
    else process.env.REZICS_QA_ARTIFACT_DIR = previousArtifactDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

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

const traceMessage = protobuf
  .parse(`syntax = "proto3";
  message Value { string stringValue=1; int64 intValue=3; }
  message Attribute { string key=1; Value value=2; }
  message Resource { repeated Attribute attributes=1; }
  message Span { bytes traceId=1; bytes spanId=2; bytes parentSpanId=4; string name=5;
    int32 kind=6; fixed64 startTimeUnixNano=7; fixed64 endTimeUnixNano=8;
    repeated Attribute attributes=9; }
  message ScopeSpans { repeated Span spans=2; }
  message ResourceSpans { Resource resource=1; repeated ScopeSpans scopeSpans=2; }
  message Traces { repeated ResourceSpans resourceSpans=1; }
`)
  .root.lookupType('Traces');

async function exportSpans(sink: ReturnType<typeof startWorkProfileSink>, spans: WorkSpan[]) {
  const body = traceMessage
    .encode({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'main' } }] },
          scopeSpans: [
            {
              spans: spans.map((span) => ({
                ...span,
                traceId: Buffer.from(span.traceId, 'hex'),
                spanId: Buffer.from(span.spanId, 'hex'),
                parentSpanId: Buffer.from(span.parentSpanId, 'hex'),
                kind: span.kind + 1,
                startTimeUnixNano: span.startMs * 1e6,
                endTimeUnixNano: span.endMs * 1e6,
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value:
                    typeof value === 'number'
                      ? { intValue: value }
                      : { stringValue: String(value) },
                })),
              })),
            },
          ],
        },
      ],
    })
    .finish();
  return fetch(`${sink.url}/v1/traces`, {
    method: 'POST',
    headers: {
      authorization: decodeURIComponent(
        sink.env.OTEL_EXPORTER_OTLP_HEADERS.slice('authorization='.length),
      ),
      'content-type': 'application/x-protobuf',
    },
    body,
  });
}

function requestSpans(headers: Headers): WorkSpan[] {
  const [, requestTrace, requestParent] = headers.get('traceparent')!.split('-');
  const server = { ...successfulRoot, traceId: requestTrace!, parentSpanId: requestParent! };
  const sql = {
    ...span('4', server.spanId, { 'db.system.name': 'postgresql' }),
    traceId: requestTrace!,
  };
  return [server, sql];
}

test('completed profiles release sink capacity while concurrent traces and returned evidence remain complete', async () => {
  const sink = startWorkProfileSink({ maxSpans: 4, settleMs: 0 });
  const concurrent = [successfulRoot, span('4', root.spanId, { 'db.system.name': 'postgresql' })];
  const profiles: WorkProfile[] = [];
  try {
    expect((await exportSpans(sink, concurrent)).status).toBe(200);
    for (let request = 0; request < 10; request++) {
      const measured = await profileRequest(sink, async (headers) => {
        const active = requestSpans(headers);
        // Exporter retries do not consume another slot, even at capacity.
        const response = await exportSpans(sink, [...active, ...active]);
        expect(response.status).toBe(200);
        await response.text();
        return request;
      });
      expect(measured.result).toBe(request);
      expect(measured.profile.postgresStatements).toBe(1);
      expect(measured.profile.spans).toHaveLength(2);
      profiles.push(measured.profile);
      expect(sink.snapshot()).toHaveLength(2);
      expect(sink.snapshot().every((span) => span.traceId === traceId)).toBe(true);
    }
    expect(await sink.collect(traceId, parent)).toHaveLength(2);
    expect(
      profiles.every((profile) => profile.postgresStatements === 1 && profile.spans.length === 2),
    ).toBe(true);
  } finally {
    await sink.stop();
  }
});

test('failed profile summarization keeps the raw trace for diagnosis', async () => {
  const sink = startWorkProfileSink({ maxSpans: 4, settleMs: 0 });
  try {
    await expect(
      profileRequest(sink, async (headers) => {
        const active = requestSpans(headers);
        const secondRoot = { ...active[0]!, spanId: '5'.repeat(16) };
        const response = await exportSpans(sink, [...active, secondRoot]);
        expect(response.status).toBe(200);
        await response.text();
      }),
    ).rejects.toThrow('exactly one completed request server span');
    expect(sink.snapshot()).toHaveLength(3);
  } finally {
    await sink.stop();
  }
});

test('sink overflow exposes its first concrete cause and clearing records cannot make incomplete counts pass', async () => {
  const sink = startWorkProfileSink({ maxSpans: 1, settleMs: 0 });
  try {
    const response = await exportSpans(sink, [successfulRoot, span('4', root.spanId)]);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Work profile sink capacity exhausted (1/1 retained spans)');
    expect(sink.snapshot()).toHaveLength(1);
    await expect(sink.collect(traceId, parent)).rejects.toThrow('capacity exhausted');
    sink.clear();
    const malformed = await exportSpans(sink, [{ ...successfulRoot, traceId: '01' }]);
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe('Malformed OTLP span');
    await expect(sink.collect(traceId, parent)).rejects.toThrow('capacity exhausted');
  } finally {
    await sink.stop();
  }
});

test('malformed telemetry is distinguishable from sink capacity and remains a failed collection after clear', async () => {
  const sink = startWorkProfileSink({ maxSpans: 4, settleMs: 0 });
  try {
    const response = await exportSpans(sink, [{ ...successfulRoot, traceId: '01' }]);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Malformed OTLP span');
    sink.clear();
    await expect(sink.collect(traceId, parent)).rejects.toThrow(
      'counts are incomplete: Malformed OTLP span',
    );
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

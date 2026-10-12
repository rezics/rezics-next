import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clearVerifiedImmutableObjectCache, rememberVerifiedImmutableObject, S3ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import type { CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { summarizeWorkProfile, type WorkSpan } from '../support/work-profile.ts';
import {
  assertZoneGrowthProfiles, bindRestoreSignal, measureZoneSite, type RestoredMeasurement,
  type ScaledProfile, type ZoneGrowthSink, withRestoredZoneCut, withZoneGrowthTelemetry,
  ZONE_GROWTH_COVERAGE, zoneSiteReadCost,
} from '../support/zone-navigation-growth.ts';

const owner = { maxGraphReads: 2048, maxGraphBytes: 8 * 1024 * 1024, deadlineMs: 10_000 };
function spans(traceId: string, parentSpanId: string): WorkSpan[] {
  const server: WorkSpan = { traceId, parentSpanId, spanId: '3'.repeat(16), service: 'main', name: 'GET zone',
    kind: 1, startMs: 100, endMs: 110, attributes: { 'http.response.status_code': 200 } };
  return [server, { ...server, spanId: '4'.repeat(16), parentSpanId: server.spanId, kind: 2,
    attributes: { 'db.system.name': 'postgresql' } },
  { ...server, spanId: '5'.repeat(16), parentSpanId: server.spanId, kind: 2,
    attributes: { 'http.request.method': 'POST', 'rezics.peer.service': 'fuseki',
      'http.request.body.size': 100, 'http.response.body.size': 100, 'rezics.http.body.complete': true,
      'rezics.fuseki.public_name_heads_visited': 1 } }];
}
function profile(unrelatedWorks: number): ScaledProfile {
  return { ...summarizeWorkProfile(spans('1'.repeat(32), '2'.repeat(16)), '1'.repeat(32), '2'.repeat(16), 10),
    unrelatedWorks };
}
function profiles(): Record<'census' | 'route' | 'presentation', ScaledProfile[]> {
  return { census: [4, 16, 64].map(profile), route: [4, 16, 64].map(profile), presentation: [4, 16, 64].map(profile) };
}

test('all three operations hold absolute caps at the middle cut without claiming confounded growth', () => {
  expect(() => assertZoneGrowthProfiles(profiles(), owner)).not.toThrow();
  for (const operation of ['census', 'route', 'presentation'] as const) {
    const measured = profiles();
    measured[operation][1]!.fusekiRequests = owner.maxGraphReads + 1;
    expect(() => assertZoneGrowthProfiles(measured, owner)).toThrow('fusekiRequests');
  }
  const ownGrowth = profiles();
  ownGrowth.route[1]!.fusekiRequests = 4;
  ownGrowth.presentation[2]!.fusekiRequests = 16;
  expect(() => assertZoneGrowthProfiles(ownGrowth, owner)).not.toThrow();
  ownGrowth.census[1]!.fusekiRequests = 4;
  expect(() => assertZoneGrowthProfiles(ownGrowth, owner)).toThrow('constant');
  expect(zoneSiteReadCost(owner, 'route').growth).toEqual({});
  expect(zoneSiteReadCost(owner, 'presentation').growth).toEqual({});
  expect(ZONE_GROWTH_COVERAGE.route.unrelatedWorks).toContain('NOT COVERED');
  expect(ZONE_GROWTH_COVERAGE.presentation.unrelatedWorks).toContain('NOT COVERED');
  expect(ZONE_GROWTH_COVERAGE.unrelatedPosts).toContain('NOT COVERED');
});

test('a native visit spike at cut 16 reaches the shared breach artifact for every operation', () => {
  const parent = resolve('.temp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'zone-growth-verdict-'));
  const previous = process.env.REZICS_QA_ARTIFACT_DIR;
  process.env.REZICS_QA_ARTIFACT_DIR = directory;
  try {
    for (const operation of ['census', 'route', 'presentation'] as const) {
      const measured = profiles();
      measured[operation][1]!.nativeVisits.public_name_heads_visited = 3;
      measured[operation][1]!.nativeVisitTotal = 3;
      expect(() => assertZoneGrowthProfiles(measured, owner)).toThrow('nativeVisitTotal');
      expect(JSON.parse(readFileSync(join(directory, 'zone-' + operation + '-growth.json'), 'utf8')))
        .toMatchObject({ counter: 'nativeVisitTotal', smallerValue: 1, largerValue: 3, allowedRatio: 1.2 });
    }
  } finally {
    if (previous === undefined) delete process.env.REZICS_QA_ARTIFACT_DIR;
    else process.env.REZICS_QA_ARTIFACT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a blind meter at any cut refuses each operation through the shared checker', () => {
  for (const operation of ['census', 'route', 'presentation'] as const) {
    const measured = profiles();
    measured[operation][1]!.postgresStatements = 0;
    measured[operation][1]!.fusekiRequests = 0;
    expect(() => assertZoneGrowthProfiles(measured, owner)).toThrow('attributed backend calls');
  }
});

const sink: ZoneGrowthSink = { clear() {}, release() {}, collect: async (traceId, parent) => spans(traceId, parent) };
function restored(handle: (request: Request) => Promise<Response>): RestoredMeasurement {
  return { stack: { main: { handle } }, fusekiUrl: 'http://fuseki.test' } as unknown as RestoredMeasurement;
}
function presentationPage(after: string | null) {
  return { zone: 'zone', revision: 'published', navigationRevision: 'navigation',
    navigation: [{ occurrence: after ? 'first' : 'last', segment: after ? 'first' : 'last', target: 'work', kind: 'index' }],
    navigationComplete: after === null, navigationNext: after };
}

test('measured presentation includes every continuation and rejects a failed tail', async () => {
  for (const tailStatus of [200, 503]) {
    const paths: string[] = [];
    const context = restored(async request => {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      if (url.pathname.endsWith('/routes')) return Response.json({ kind: 'index', items: [] });
      const tail = url.searchParams.get('after');
      return tail ? Response.json(presentationPage(null), { status: tailStatus }) : Response.json(presentationPage('tail /&'));
    });
    const measurement = measureZoneSite(sink, context, 'zone', 'entry', 64);
    if (tailStatus === 200) {
      const result = await measurement;
      expect(result.presentation.result.navigation).toHaveLength(2);
      expect(result.presentation.result.navigationComplete).toBe(true);
      expect(result.presentation.profile.postgresStatements).toBe(2);
      expect(result.presentation.profile.fusekiRequests).toBe(2);
      expect(result.presentation.profile.nativeVisitTotal).toBe(2);
    } else await expect(measurement).rejects.toThrow();
    expect(paths).toEqual(['/v1/zones/zone/routes?path=%2Fentry', '/v1/zones/zone/presentation',
      '/v1/zones/zone/presentation?after=tail+%2F%26']);
  }
});

test('both measured site reads bypass bytes warmed by census verification', async () => {
  const bytes = Buffer.from('retained immutable manifest');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let gets = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { gets++; return new Response(bytes); } });
  const objects = new S3ImmutableObjects({ endpoint: server.url.origin, bucket: 'test', prefix: 'semantic/',
    accessKeyId: 'test', secretAccessKey: 'test' });
  clearVerifiedImmutableObjectCache();
  rememberVerifiedImmutableObject(digest, bytes);
  try {
    await objects.get(digest);
    expect(gets).toBe(0);
    const context = restored(async request => {
      await objects.get(digest);
      return request.url.includes('/routes') ? Response.json({ kind: 'index', items: [] })
        : Response.json(presentationPage(null));
    });
    await measureZoneSite(sink, context, 'zone', 'entry', 4);
    expect(gets).toBe(2);
  } finally {
    clearVerifiedImmutableObjectCache();
    await server.stop(true);
  }
});

test('restore cancellation reaches in-flight census requests and prevents the next read or command', async () => {
  const controller = new AbortController();
  const observed: AbortSignal[] = [];
  const api: CorpusApi = {
    async command<T>(): Promise<T> { throw new Error('Cancelled command must not start'); },
    async read<T>(_path, signal) {
      observed.push(signal!);
      controller.abort(new Error('restore deadline'));
      return {} as T;
    },
  };
  const bound = bindRestoreSignal(api, controller.signal);
  await expect(bound.read('/v1/zones/zone')).rejects.toThrow('restore deadline');
  expect(observed).toEqual([controller.signal]);
  await expect(bound.read('/v1/zones/zone')).rejects.toThrow('restore deadline');
  await expect(bound.command('key', { method: 'POST', path: '/v1/agents', body: {} })).rejects.toThrow('restore deadline');
  expect(observed).toHaveLength(1);
});

test('a restore wrapper rejection after readiness still stops its registered copy', async () => {
  const events: string[] = [];
  await expect(withRestoredZoneCut('zone-cut', async () => {
    events.push('registered'); throw new Error('final deadline check');
  }, async () => { events.push('measure'); }, async target => { events.push('stop ' + target); }))
    .rejects.toThrow('final deadline check');
  expect(events).toEqual(['registered', 'stop zone-cut']);
});

test('seed setup and shutdown failures still close the telemetry sink', async () => {
  for (const shutdownFails of [false, true]) {
    const events: string[] = [];
    const runtime = {
      createSink: () => ({ ...sink, env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://test' }, url: 'http://test', snapshot: () => [],
        stop: () => { events.push('stop'); } }),
      start: () => { events.push('start'); },
      shutdown: async () => { events.push('shutdown'); if (shutdownFails) throw new Error('shutdown'); },
    };
    await expect(withZoneGrowthTelemetry(async () => { throw new Error('invalid retained seed'); }, runtime)).rejects.toThrow();
    expect(events).toEqual(['start', 'shutdown', 'stop']);
  }
});

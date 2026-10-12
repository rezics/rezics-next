import { expect } from 'bun:test';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { completePublicNavigation } from '../../../apps/web/features/realm/public-navigation.ts';
import type { ZonePresentationRead } from '../../../apps/web/features/realm/types.ts';
import { flushTelemetryTraces, shutdownTelemetry, startTelemetry } from '../../../packages/observability/src/runtime.ts';
import { withoutVerifiedImmutableObjectCache } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { dockerEnvironment, root, stream } from '../../../scripts/fixture/stack.ts';
import type { CorpusRestoreSmokeInput } from '../../../scripts/load/corpus-backup-driver.ts';
import type { CorpusApi, CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import type { MediaStack } from '../integration/media-support.ts';
import type { RetainedSeed, RetainedSeedCut } from './seed-checkpoints.ts';
import {
  profileRequest,
  assertWorkCostAtScales,
  assertWorkMeterObserved,
  type WorkCostContract,
  type WorkCostField,
  type WorkProfile,
  startWorkProfileSink,
} from './work-profile.ts';

export type ZoneGrowthSink = Pick<ReturnType<typeof startWorkProfileSink>, 'collect' | 'clear' | 'release'>;
export type ScaledProfile = WorkProfile & { unrelatedWorks: number };

export async function withZoneGrowthTelemetry<T>(measure: (sink: ZoneGrowthSink) => Promise<T>, runtime: {
  createSink: () => ZoneGrowthSink & { env: Record<string, string>; stop(): unknown };
  start: (service: string, env: Record<string, string | undefined>) => unknown;
  shutdown: () => Promise<void>;
} = {
  createSink: startWorkProfileSink,
  start: startTelemetry,
  shutdown: shutdownTelemetry,
}): Promise<T> {
  const sink = runtime.createSink();
  try {
    // pg must load after the SDK installs its instrumentation hooks.
    runtime.start('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main', OTEL_TRACES_SAMPLER_ARG: '1' });
    return await measure(sink);
  } finally {
    try { await runtime.shutdown(); }
    finally { await sink.stop(); }
  }
}

/** The wrapper can reject after registering a live restored copy. */
export async function withRestoredZoneCut<T>(target: string, restore: () => Promise<unknown>,
  measure: () => Promise<T>, stop: (target: string) => Promise<void>): Promise<T> {
  try {
    await restore();
    return await measure();
  } finally {
    await stop(target);
  }
}

export type RestoredMeasurement = {
  stack: MediaStack;
  fusekiUrl: string;
  apps: Record<string, string>;
  api: CorpusApi;
  member: Awaited<ReturnType<MediaStack['member']>>;
};

const short = (id: string) => id.slice(-36);
const corpusAxis = 'unrelatedWorks' as WorkCostField;

export function routePathFor(zoneId: string, segment: string): string {
  return '/v1/zones/' + short(zoneId) + '/routes?path=' + encodeURIComponent('/' + segment);
}

export function presentationPathFor(zoneId: string): string {
  return '/v1/zones/' + short(zoneId) + '/presentation';
}

export const ZONE_GROWTH_COVERAGE = {
  census: { unrelatedWorks: 'constant at 4/16/64; admission per distinct mounted target' },
  route: { unrelatedWorks: 'NOT COVERED: retained cuts co-grow own entries; absolute caps only' },
  presentation: { unrelatedWorks: 'NOT COVERED: retained cuts co-grow own entries; absolute caps only' },
  unrelatedPosts: 'NOT COVERED: retained cuts contain zero Posts; summaries include the rv:Post UNION',
  requiredSeedAxes: {
    unrelatedWorks: { sizes: [4, 16, 64], unit: 'public Work outside the measured Zone and mounted Collection',
      fixed: '4 Zone navigation entries and 4 mounted Collection resources', expected: 'constant', owner: 'kernel class B' },
    unrelatedPosts: { sizes: [4, 16, 64], unit: 'public Post outside the measured Zone',
      fixed: '4 Zone navigation entries, 4 mounted Collection resources and unrelated Works', expected: 'constant', owner: 'kernel class B' },
    zoneNavigationEntries: { sizes: [4, 16, 64], unit: 'public mount with a route segment and Work or Collection target',
      expected: 'keyed lookup logarithmic; complete presentation linear because every mount is returned' },
    mountedCollectionResources: { sizes: [4, 16, 64], unit: 'public Work in the mounted Collection',
      expected: 'linear up to the 24-item route page cap, then bounded' },
  },
} as const;

export function zoneSiteReadCost(owner: {
  maxGraphReads: number;
  maxGraphBytes: number;
  deadlineMs: number;
}, operation: 'census' | 'route' | 'presentation'): WorkCostContract {
  return {
    fusekiRequests: owner.maxGraphReads,
    fusekiSentBytes: owner.maxGraphBytes,
    fusekiReceivedBytes: owner.maxGraphBytes,
    postgresStatements: 512,
    accountCalls: 0,
    mainCalls: 0,
    otherFetches: 100,
    unclassifiedFetches: 0,
    serverLatencyMs: owner.deadlineMs,
    totalLatencyMs: owner.deadlineMs,
    minimumObserved: { postgresStatements: 1, fusekiRequests: 1 },
    // The census admits distinct targets once. Other reads enumerate their own
    // growing entries on these cuts, which cannot isolate unrelated population.
    growth: operation === 'census' ? {
      fusekiRequests: { class: 'constant', dimension: corpusAxis },
      fusekiSentBytes: { class: 'constant', dimension: corpusAxis },
      fusekiReceivedBytes: { class: 'constant', dimension: corpusAxis },
      postgresStatements: { class: 'constant', dimension: corpusAxis },
      accountCalls: { class: 'constant', dimension: corpusAxis },
      mainCalls: { class: 'constant', dimension: corpusAxis },
      otherFetches: { class: 'constant', dimension: corpusAxis },
      unclassifiedFetches: { class: 'constant', dimension: corpusAxis },
    } : {},
  };
}

export function assertZoneGrowthProfiles(profiles: Record<'census' | 'route' | 'presentation', ScaledProfile[]>,
  owner: Parameters<typeof zoneSiteReadCost>[0]): void {
  for (const operation of ['census', 'route', 'presentation'] as const)
    assertWorkCostAtScales(profiles[operation], zoneSiteReadCost(owner, operation), 'zone-' + operation + '-growth');
}

/** The census does not pass a signal itself, so bind the restore deadline here. */
export function bindRestoreSignal(api: CorpusApi, signal: AbortSignal): CorpusApi {
  const bound = (other?: AbortSignal) => other ? AbortSignal.any([signal, other]) : signal;
  return {
    async command<T>(key, command, other) {
      signal.throwIfAborted();
      const result = await api.command<T>(key, command, bound(other));
      signal.throwIfAborted();
      return result;
    },
    async read<T>(path, other) {
      signal.throwIfAborted();
      const result = await api.read<T>(path, bound(other));
      signal.throwIfAborted();
      return result;
    },
  };
}

/** Use the site's traversal, so a failed or inconsistent tail refuses the read. */
export async function readCompletePresentation(read: (after?: string) => Promise<ZonePresentationRead>) {
  const result = await completePublicNavigation(async after => ({ ok: true, data: await read(after) }));
  if (!result.ok) throw new Error('Zone presentation continuation failed: ' + result.failure);
  return result.data;
}

export function measuredCounters(profile: ScaledProfile) {
  return {
    unrelatedWorks: profile.unrelatedWorks,
    status: profile.request.status,
    mainCalls: profile.mainCalls,
    fusekiRequests: profile.fusekiRequests,
    fusekiSentBytes: profile.fusekiSentBytes,
    fusekiReceivedBytes: profile.fusekiReceivedBytes,
    fusekiEngineMs: profile.fusekiEngineMs,
    postgresStatements: profile.postgresStatements,
    accountCalls: profile.accountCalls,
    otherFetches: profile.otherFetches,
    unclassifiedFetches: profile.unclassifiedFetches,
    nativeVisitTotal: profile.nativeVisitTotal,
    nativeVisits: profile.nativeVisits,
    serverLatencyMs: profile.serverLatencyMs,
    totalLatencyMs: profile.totalLatencyMs,
  };
}

function censusStages(profile: WorkProfile) {
  const stages = ['zone-census.zone-admission', 'zone-census.mounted-target-admission'] as const;
  const byId = new Map(profile.spans.map(span => [span.spanId, span]));
  const stageFor = (spanId: string): string => {
    let span = byId.get(spanId);
    while (span) {
      if (stages.some(stage => stage === span!.name)) return span.name;
      span = byId.get(span.parentSpanId);
    }
    return 'zone-census.setup-and-traversal';
  };
  const coveredMs = (intervals: Array<[number, number]>) => {
    let total = 0, end = -Infinity;
    for (const [start, stop] of intervals.sort((left, right) => left[0] - right[0])) {
      total += Math.max(0, stop - Math.max(start, end));
      end = Math.max(end, stop);
    }
    return total;
  };
  const admissionSpans = profile.spans.filter(span => stages.some(stage => stage === span.name));
  return [...stages, 'zone-census.setup-and-traversal'].map(stage => {
    const spans = admissionSpans.filter(span => span.name === stage);
    const fuseki = profile.fusekiCalls.filter(call => stageFor(call.spanId) === stage);
    const sql = profile.postgres.filter(call => stageFor(call.spanId) === stage);
    return {
      stage,
      invocations: spans.length,
      serverMs: stage === 'zone-census.setup-and-traversal'
        ? Math.max(0, profile.serverLatencyMs - coveredMs(admissionSpans.map(span => [span.startMs, span.endMs])))
        : coveredMs(spans.map(span => [span.startMs, span.endMs])),
      postgresStatements: sql.length,
      postgresMs: sql.reduce((total, call) => total + call.durationMs, 0),
      fusekiRequests: fuseki.length,
      fusekiMs: fuseki.reduce((total, call) => total + call.durationMs, 0),
      fusekiSentBytes: fuseki.some(call => call.sentBytes === null) ? null
        : fuseki.reduce((total, call) => total + call.sentBytes!, 0),
      fusekiReceivedBytes: fuseki.some(call => call.receivedBytes === null) ? null
        : fuseki.reduce((total, call) => total + call.receivedBytes!, 0),
    };
  });
}

async function openRestoredStack(input: CorpusRestoreSmokeInput, label: string): Promise<MediaStack> {
  const env = {
    ...input.apps,
    REZICS_QA_RUN_ID: input.runId,
    REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration',
    REZICS_STACK_PROFILE: 'qa',
  };
  const previous = new Map(Object.keys(env).map((key) => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
    const { startMediaStack } = await import('../integration/media-support.ts');
    return await startMediaStack(label + '-' + input.target, {
      library: true,
      ownerUrls: {
        access: input.apps.ACCESS_DATABASE_URL!,
        content: input.apps.CONTENT_DATABASE_URL!,
        relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
      },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

export async function profileRead(sink: ZoneGrowthSink, restored: RestoredMeasurement, path: string,
  unrelatedWorks: number) {
  sink.clear();
  const { result, profile } = await profileRequest(
    sink,
    headers => withoutVerifiedImmutableObjectCache(async () => {
      const response = await restored.stack.main.handle(new Request(new URL(path, 'http://main.local'), { headers }));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(body) as Record<string, unknown>;
    }),
    {
      service: 'main',
      peers: { fuseki: restored.fusekiUrl },
      flush: flushTelemetryTraces,
    },
  );

  // A number (including zero) is a measured counter; null means the field was not observed.
  expect(profile.postgresStatements).not.toBeNull();
  expect(profile.fusekiRequests).not.toBeNull();
  assertWorkMeterObserved(profile, { minimumObserved: { postgresStatements: 1, fusekiRequests: 1 } });
  return {
    result,
    profile: { ...profile, unrelatedWorks } satisfies ScaledProfile,
  };
}

/** Warms the route with one read whose counters are logged but not compared. */
export async function wiringProbe(sink: ZoneGrowthSink, restored: RestoredMeasurement, path: string,
  scale: number, scaleLabel: string) {
  const probe = await profileRead(sink, restored, path, scale);
  console.log('Zone navigation meter wiring probe', JSON.stringify({
    scale: scaleLabel,
    path,
    counters: measuredCounters(probe.profile),
  }));
  if ((probe.profile.postgresStatements ?? 0) <= 0 || (probe.profile.fusekiRequests ?? 0) <= 0) {
    throw new Error(
      'Work profile meter wiring probe failed: the known Zone page read must report positive postgresStatements and fusekiRequests',
    );
  }
}

export async function measureZoneSite(sink: ZoneGrowthSink, restored: RestoredMeasurement, zoneId: string,
  segment: string, scale: number) {
  const routePath = routePathFor(zoneId, segment);
  const presentationPath = presentationPathFor(zoneId);
  const route = await profileRead(sink, restored, routePath, scale);
  const pages: ScaledProfile[] = [];
  const result = await readCompletePresentation(async after => {
    const url = new URL(presentationPath, 'http://main.local');
    if (after) url.searchParams.set('after', after);
    const page = await profileRead(sink, restored, url.pathname + url.search, scale);
    pages.push(page.profile);
    return page.result as ZonePresentationRead;
  });
  // Each HTTP request owns one trace. Compose their measured work after the
  // site's traversal succeeds; the shared verdict still owns all comparisons.
  const profile = { ...pages[0]! };
  for (const field of ['mainCalls', 'fusekiRequests', 'fusekiSentBytes', 'fusekiReceivedBytes', 'fusekiEngineMs',
    'postgresStatements', 'accountCalls', 'otherFetches'] as const)
    profile[field] = pages.some(page => page[field] === null) ? null
      : pages.reduce((sum, page) => sum + page[field]!, 0);
  for (const field of ['nativeVisitTotal', 'unclassifiedFetches', 'serverLatencyMs', 'totalLatencyMs'] as const)
    profile[field] = pages.reduce((sum, page) => sum + page[field], 0);
  profile.nativeVisits = {};
  for (const page of pages)
    for (const [counter, visits] of Object.entries(page.nativeVisits))
      profile.nativeVisits[counter] = (profile.nativeVisits[counter] ?? 0) + visits;
  profile.fusekiCalls = pages.flatMap(page => page.fusekiCalls);
  profile.postgres = pages.flatMap(page => page.postgres);
  profile.spans = pages.flatMap(page => page.spans);
  profile.unobserved = [...new Set(pages.flatMap(page => page.unobserved))];
  const presentation = { result, profile };
  return { routePath, presentationPath, route, presentation };
}

/** Per-statement and per-fetch records of one measured read. Only this artifact keeps them after the run. */
export function profileDump(operation: string, cut: string, path: string, profile: ScaledProfile,
  apps: Record<string, string>) {
  const serviceByOrigin = new Map(Object.entries(apps)
    .filter(([, value]) => /^https?:\/\//.test(value))
    .map(([name, value]) => [new URL(value).origin, name]));
  return {
    operation,
    cut,
    path,
    traceIds: [...new Set(profile.spans.map(span => span.traceId))],
    counters: measuredCounters(profile),
    postgres: profile.spans.filter(span => span.attributes['db.system.name'] === 'postgresql').map(span => ({
      spanName: span.name,
      namespace: String(span.attributes['db.namespace'] ?? ''),
      server: String(span.attributes['server.address']) + ':' + String(span.attributes['server.port']),
      durationMs: span.endMs - span.startMs,
      // This instrumentation records no statement text; a prefix is kept only where a span carries one.
      textPrefix: typeof span.attributes['db.query.text'] === 'string'
        ? span.attributes['db.query.text'].slice(0, 80) : null,
    })),
    fetches: profile.spans.filter(span => span.kind === 2 && span.attributes['http.request.method']).map(span => {
      const origin = String(span.attributes['url.scheme'] ?? 'http') + '://'
        + String(span.attributes['server.address']) + ':' + String(span.attributes['server.port']);
      const attribute = (name: string) => typeof span.attributes[name] === 'string' ? span.attributes[name] : null;
      return {
        spanName: span.name,
        method: attribute('http.request.method'),
        origin,
        service: serviceByOrigin.get(origin) ?? null,
        peer: attribute('rezics.peer.service'),
        path: attribute('url.path') ?? attribute('url.full'),
        durationMs: span.endMs - span.startMs,
      };
    }),
  };
}

export function writeProfileDump(label: string, dump: ReturnType<typeof profileDump>): void {
  const directory = Bun.env.REZICS_QA_ARTIFACT_DIR;
  if (!directory) throw new Error('Zone profile dumps need REZICS_QA_ARTIFACT_DIR');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, label + '.json'), JSON.stringify(dump, null, 2) + '\n');
}

/** Restores the given retained cuts one at a time, runs the census read of each, then hands the restored stack to `measure`. */
export async function restoreZoneCuts(options: {
  sink: ZoneGrowthSink;
  qaRunId: string;
  retained: RetainedSeed;
  label: string;
  cuts: readonly RetainedSeedCut[];
  measure: (cut: RetainedSeedCut, restored: RestoredMeasurement) => Promise<void>;
  censusProfiles: ScaledProfile[];
}): Promise<void> {
  const { sink, qaRunId, retained, label, cuts, measure, censusProfiles } = options;
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { restoreWorkProfileCorpus } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { seedApi, seedAuthorName, seedCensus, seedDirectory } = await import('./seed-checkpoints.ts');
  const smokeCopies = new Map<string, RestoredMeasurement>();
  let verifying: RetainedSeedCut | undefined;

  const driver = createCorpusBackupDriver({
    sourceRunId: retained.sourceRunId,
    directory: seedDirectory,
    resumeSource: false,
    restoreResourceClass: 'ordinary',
    quiesce: async () => {
      throw new Error('Routine Zone growth TEST only restores retained checkpoints');
    },
    smokeRead: async (input) => {
      input.signal.throwIfAborted();
      const cut = verifying;
      if (!cut) throw new Error('A retained checkpoint restore started without its expected cut');
      const stack = await openRestoredStack(input, label);
      try {
        input.signal.throwIfAborted();
        const member = await stack.member(seedAuthorName, { stable: true, verified: true });
        input.signal.throwIfAborted();
        const api = bindRestoreSignal(seedApi(stack, member.token), input.signal);
        const censusApi: typeof api = {
          ...api,
          async read<T>(path: `/v1/${string}`, signal?: AbortSignal): Promise<T> {
            input.signal.throwIfAborted();
            const requestSignal = signal ? AbortSignal.any([input.signal, signal]) : input.signal;
            if (new URL(path, 'http://main.local').pathname !== '/v1/zones/' + short(cut.population.zone.id))
              return api.read<T>(path, signal);
            // Stage spans annotate the existing read and meter, without altering
            // admission decisions, page limits, deadlines or the seed census.
            const original = stack.access.canReadSemanticResource;
            const mountedTargets = new Set<string>();
            stack.access.canReadSemanticResource = async (...args) => {
              const stage = args[2] === cut.population.zone.id
                ? 'zone-census.zone-admission' : 'zone-census.mounted-target-admission';
              if (stage === 'zone-census.mounted-target-admission') mountedTargets.add(args[2]);
              return trace.getTracer('zone-census').startActiveSpan(stage, async span => {
                try { return await original.apply(stack.access, args); }
                finally { span.end(); }
              });
            };
            // The Zone page admits its mounted targets in one batch read.
            const originalBatch = stack.access.canReadZoneNavigationTargets;
            stack.access.canReadZoneNavigationTargets = async (...args) => {
              const targets = args[3];
              return trace.getTracer('zone-census').startActiveSpan('zone-census.mounted-target-admission', async span => {
                try {
                  for (const target of targets) mountedTargets.add(target);
                  return await originalBatch.apply(stack.access, args);
                } finally { span.end(); }
              });
            };
            try {
              sink.clear();
              const { result, profile } = await profileRequest(sink, headers => withoutVerifiedImmutableObjectCache(async () => {
                headers.set('authorization', 'Bearer ' + member.token);
                const response = await stack.main.handle(new Request('http://main.local' + path, { headers, signal: requestSignal }));
                return { status: response.status, body: await response.text() };
              }), { service: 'main', peers: { fuseki: input.apps.FUSEKI_URL! }, flush: flushTelemetryTraces });
              input.signal.throwIfAborted();
              censusProfiles.push({ ...profile, unrelatedWorks: cut.manifest.dimensions.unrelatedWorks });
              const visibleMounts = result.status === 200
                ? (JSON.parse(result.body) as { mounts: unknown[] }).mounts.length : null;
              const evidence = { scale: cut.manifest.scale, dimensions: cut.manifest.dimensions,
                path, distinctMountedTargets: mountedTargets.size, visibleMounts, stages: censusStages(profile), profile };
              const artifact = join(root, '.temp', label + '-census-' + qaRunId + '-' + cut.manifest.scale + '.json');
              writeFileSync(artifact, JSON.stringify(evidence, null, 2) + '\n');
              console.log('Zone census read counters', JSON.stringify({ scale: evidence.scale, artifact,
                path, distinctMountedTargets: mountedTargets.size, visibleMounts, stages: evidence.stages,
                counters: measuredCounters({ ...profile, unrelatedWorks: cut.manifest.dimensions.unrelatedWorks }) }));
              if (result.status !== 200)
                throw new Error('Corpus verification returned HTTP ' + result.status + ' for ' + path + ': ' + result.body);
              // The page lists every Zone navigation entry up to its page limit.
              const pageLimit = Number(new URL(path, 'http://main.local').searchParams.get('limit'));
              expect(visibleMounts).toBe(Math.min(cut.manifest.dimensions.zoneNavigationEntries!, pageLimit));
              return JSON.parse(result.body) as T;
            } finally {
              stack.access.canReadSemanticResource = original;
              stack.access.canReadZoneNavigationTargets = originalBatch;
            }
          },
        };
        expect(await seedCensus(censusApi, cut)).toEqual(cut.manifest.dimensions as Required<CorpusDimensions>);
        input.signal.throwIfAborted();
        smokeCopies.set(input.target, { stack, fusekiUrl: input.apps.FUSEKI_URL!, apps: input.apps, api, member });
        return async () => {
          smokeCopies.delete(input.target);
          await stack.stop();
        };
      } catch (error) {
        await stack.stop();
        throw error;
      }
    },
  });

  await stream(
    'task',
    ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'],
    dockerEnvironment(),
  );

  for (const cut of cuts) {
    verifying = cut;
    const target = label + '-' + qaRunId + '-' + cut.manifest.scale;

    // Published backups are read-only. Restore metadata and object bytes from
    // a local copy; the driver copies the retained owner volumes independently.
    const localBackup = join(root, '.temp', label + '-backups', qaRunId, cut.manifest.id);
    mkdirSync(dirname(localBackup), { recursive: true });
    cpSync(dirname(cut.manifest.backup), localBackup, { recursive: true });
    await withRestoredZoneCut(target, () => restoreWorkProfileCorpus({
      ...cut.manifest,
      backup: join(localBackup, basename(cut.manifest.backup)),
    }, target, driver), async () => {
      const restored = smokeCopies.get(target);
      if (!restored) throw new Error('The retained checkpoint smoke read did not keep its restored stack open');
      await measure(cut, restored);
    }, target => driver.stop(target));
  }
}

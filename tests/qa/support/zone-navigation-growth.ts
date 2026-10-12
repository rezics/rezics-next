import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { flushTelemetryTraces } from '../../../packages/observability/src/runtime.ts';
import { dockerEnvironment, root, stream } from '../../../scripts/fixture/stack.ts';
import type { CorpusRestoreSmokeInput } from '../../../scripts/load/corpus-backup-driver.ts';
import type { CorpusApi, CorpusCommand, CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import type { MediaStack } from '../integration/media-support.ts';
import type { RetainedSeed, RetainedSeedCut } from './seed-checkpoints.ts';
import {
  profileRequest,
  type WorkCostContract,
  type WorkCostField,
  type WorkProfile,
  startWorkProfileSink,
} from './work-profile.ts';

export type ZoneGrowthSink = ReturnType<typeof startWorkProfileSink>;
export type ScaledProfile = WorkProfile & { unrelatedWorks: number };

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

export function zoneSiteReadCost(owner: {
  maxGraphReads: number;
  maxGraphBytes: number;
  deadlineMs: number;
}): WorkCostContract {
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
    growth: {
      fusekiRequests: { class: 'constant', dimension: corpusAxis },
      fusekiSentBytes: { class: 'constant', dimension: corpusAxis },
      fusekiReceivedBytes: { class: 'constant', dimension: corpusAxis },
      postgresStatements: { class: 'constant', dimension: corpusAxis },
      accountCalls: { class: 'constant', dimension: corpusAxis },
      mainCalls: { class: 'constant', dimension: corpusAxis },
      otherFetches: { class: 'constant', dimension: corpusAxis },
      unclassifiedFetches: { class: 'constant', dimension: corpusAxis },
    },
  };
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
    async (headers) => {
      const response = await restored.stack.main.handle(
        new Request('http://main.local' + path, { headers }),
      );
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(body) as Record<string, unknown>;
    },
    {
      service: 'main',
      peers: { fuseki: restored.fusekiUrl },
      flush: flushTelemetryTraces,
    },
  );

  // A number (including zero) is a measured counter; null means the field was not observed.
  expect(profile.postgresStatements).not.toBeNull();
  expect(profile.fusekiRequests).not.toBeNull();
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
  const presentation = await profileRead(sink, restored, presentationPath, scale);
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

export function logWorkCostRatios(label: string, profiles: readonly ScaledProfile[], cost: WorkCostContract) {
  console.log('Zone navigation checkpoint ratios', JSON.stringify({
    operation: label,
    pairs: profiles.flatMap((smaller, index) => profiles.slice(index + 1).map(larger => ({
      from: smaller.unrelatedWorks,
      to: larger.unrelatedWorks,
      counters: Object.fromEntries(Object.keys(cost.growth!).map(counter => {
        const field = counter as WorkCostField;
        const before = smaller[field];
        const after = larger[field];
        return [counter, before === null || after === null ? null
          : before === 0 ? (after === 0 ? 'both zero' : 'Infinity') : after / before];
      })),
    }))),
  }));
}

/** Restores the given retained cuts one at a time, runs the census read of each, then hands the restored stack to `measure`. */
export async function restoreZoneCuts(options: {
  sink: ZoneGrowthSink;
  qaRunId: string;
  retained: RetainedSeed;
  label: string;
  cuts: readonly RetainedSeedCut[];
  measure: (cut: RetainedSeedCut, restored: RestoredMeasurement) => Promise<void>;
}): Promise<void> {
  const { sink, qaRunId, retained, label, cuts, measure } = options;
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { restoreWorkProfileCorpus } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { seedApi, seedAuthorName, seedCensus, seedDirectory } = await import('./seed-checkpoints.ts');
  const smokeCopies = new Map<string, RestoredMeasurement>();
  const targets: string[] = [];
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
      const cut = verifying;
      if (!cut) throw new Error('A retained checkpoint restore started without its expected cut');
      const stack = await openRestoredStack(input, label);
      try {
        const member = await stack.member(seedAuthorName, { stable: true, verified: true });
        const api = seedApi(stack, member.token);
        const censusApi: typeof api = {
          ...api,
          async read<T>(path: `/v1/${string}`, signal?: AbortSignal): Promise<T> {
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
              const { result, profile } = await profileRequest(sink, async headers => {
                headers.set('authorization', 'Bearer ' + member.token);
                const response = await stack.main.handle(new Request('http://main.local' + path, { headers, signal }));
                return { status: response.status, body: await response.text() };
              }, { service: 'main', peers: { fuseki: input.apps.FUSEKI_URL! }, flush: flushTelemetryTraces });
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

  try {
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
      await restoreWorkProfileCorpus({
        ...cut.manifest,
        backup: join(localBackup, basename(cut.manifest.backup)),
      }, target, driver);
      targets.push(target);
      const restored = smokeCopies.get(target);
      if (!restored) throw new Error('The retained checkpoint smoke read did not keep its restored stack open');
      await measure(cut, restored);
      await driver.stop(target);
      targets.splice(targets.indexOf(target), 1);
    }
  } finally {
    for (const target of targets.reverse()) await driver.stop(target);
  }
}

/**
 * Within-cut control: a second Zone with the small cut's shape, built through the API in a restored stack.
 * It has its own Agent, so its reader shelf reads back the same four entries the small cut's does.
 * Its preceding reads match the small cut's: the census verification (which ends with the mounted route
 * read), then one wiring probe of the same route, then the measured route and presentation reads.
 */
export async function measureControlZone(sink: ZoneGrowthSink, restored: RestoredMeasurement, input: {
  small: RetainedSeedCut;
  large: RetainedSeedCut;
  scale: number;
}) {
  const { grantFixtureAuthority } = await import('../../../services/main/src/modules/access/fixture-authority.ts');
  const { initializeSeedCheckpointPopulation, growSeedCheckpointPopulation } =
    await import('./seed-checkpoint-population.ts');
  const { seedCensus } = await import('./seed-checkpoints.ts');
  // Command keys are idempotency keys the restored backup already holds, so the control gets its own namespace.
  const keyspace = 'control:' + randomUUID() + ':';
  const api: CorpusApi = {
    command: <T>(key: string, command: CorpusCommand, signal?: AbortSignal) =>
      restored.api.command<T>(keyspace + key, command, signal),
    read: <T>(path: `/v1/${string}`, signal?: AbortSignal) => restored.api.read<T>(path, signal),
  };
  const agent = await api.command<{ agent: string }>('author', { method: 'POST', path: '/v1/agents', body: {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Zone growth control author' } });
  const actor = agent.agent;
  const population = await initializeSeedCheckpointPopulation(api, { actor,
    grant: (scope, action) => grantFixtureAuthority(restored.stack.accessPool, { scope, requireDispatch: true,
      representations: [{ principalId: restored.member.principalId, actor, action, lifetime: '7 days' }],
      grant: { actor, action, lifetime: '7 days' } }) });
  // The small cut's manifest records every population dimension, so the control gets the same shape.
  const shape = input.small.manifest.dimensions;
  await growSeedCheckpointPopulation(api, population, input.large.works, {
    recipeOccurrences: shape.recipeOccurrences!,
    readerShelfEntries: shape.readerShelfEntries!,
    mountedCollectionResources: shape.mountedCollectionResources!,
    zoneNavigationEntries: shape.zoneNavigationEntries!,
  });
  // The census read the small cut performs before its route read, with the same works and the control's population.
  await seedCensus(api, { works: input.small.works, population });
  const segment = population.zone.mounts[0]!.segment;
  const routePath = routePathFor(population.zone.id, segment);
  await wiringProbe(sink, restored, routePath, input.scale, 'control');
  const reads = await measureZoneSite(sink, restored, population.zone.id, segment, input.scale);
  console.log('Zone navigation control counters', JSON.stringify({
    built: {
      recipeOccurrences: population.recipe.occurrences.length,
      readerShelfEntries: population.shelfWorks.length,
      mountedCollectionResources: population.collection.members.length,
      zoneNavigationEntries: population.zone.mounts.length,
    },
    routes: measuredCounters(reads.route.profile),
    presentation: measuredCounters(reads.presentation.profile),
  }));
  writeProfileDump('zone-control-check-route-control',
    profileDump('route', 'control', reads.routePath, reads.route.profile, restored.apps));
  writeProfileDump('zone-control-check-presentation-control',
    profileDump('presentation', 'control', reads.presentationPath, reads.presentation.profile, restored.apps));
  return reads;
}

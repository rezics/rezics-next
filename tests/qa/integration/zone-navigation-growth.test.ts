import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { flushTelemetryTraces, shutdownTelemetry, startTelemetry }
  from '../../../packages/observability/src/runtime.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root, dockerEnvironment, stream } from '../../../scripts/fixture/stack.ts';
import type { CorpusRestoreSmokeInput }
  from '../../../scripts/load/corpus-backup-driver.ts';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkCostField,
  type WorkProfile,
} from '../support/work-profile.ts';
import type { RetainedSeedCut } from '../support/seed-checkpoints.ts';
import type { CorpusApi, CorpusCommand, CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import type { MediaStack } from './media-support.ts';

type ScaledProfile = WorkProfile & { unrelatedWorks: number };

type RestoredMeasurement = {
  stack: MediaStack;
  fusekiUrl: string;
  apps: Record<string, string>;
  api: CorpusApi;
  member: Awaited<ReturnType<MediaStack['member']>>;
};

const short = (id: string) => id.slice(-36);
const corpusAxis = 'unrelatedWorks' as WorkCostField;

function zoneSiteReadCost(owner: {
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

function measuredCounters(profile: ScaledProfile) {
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

async function openRestoredStack(input: CorpusRestoreSmokeInput): Promise<MediaStack> {
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
    const { startMediaStack } = await import('./media-support.ts');
    return await startMediaStack('zone-navigation-' + input.target, {
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

async function profileRead(
  sink: ReturnType<typeof startWorkProfileSink>,
  restored: RestoredMeasurement,
  path: string,
  unrelatedWorks: number,
) {
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

/** Per-statement and per-fetch records of one measured read. Only this artifact keeps them after the run. */
function profileDump(operation: string, cut: string, path: string, profile: ScaledProfile,
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

function writeProfileDump(label: string, dump: ReturnType<typeof profileDump>): void {
  const directory = Bun.env.REZICS_QA_ARTIFACT_DIR;
  if (!directory) throw new Error('Zone profile dumps need REZICS_QA_ARTIFACT_DIR');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, label + '.json'), JSON.stringify(dump, null, 2) + '\n');
}

/** Within-cut control: a second Zone built with the small cut's shape through the API, in the restored large stack. */
async function measureControlZone(
  sink: ReturnType<typeof startWorkProfileSink>,
  restored: RestoredMeasurement,
  cut: RetainedSeedCut,
  shape: RetainedSeedCut['manifest']['dimensions'],
  actor: string,
  scale: number,
) {
  const { grantFixtureAuthority } = await import('../../../services/main/src/modules/access/fixture-authority.ts');
  const { initializeSeedCheckpointPopulation, growSeedCheckpointPopulation }
    = await import('../support/seed-checkpoint-population.ts');
  // Command keys are idempotency keys the restored backup already holds, so the control gets its own namespace.
  const keyspace = 'control:' + randomUUID() + ':';
  const api: CorpusApi = {
    command: <T>(key: string, command: CorpusCommand, signal?: AbortSignal) =>
      restored.api.command<T>(keyspace + key, command, signal),
    read: <T>(path: `/v1/${string}`, signal?: AbortSignal) => restored.api.read<T>(path, signal),
  };
  const population = await initializeSeedCheckpointPopulation(api, { actor,
    grant: (scope, action) => grantFixtureAuthority(restored.stack.accessPool, { scope, requireDispatch: true,
      representations: [{ principalId: restored.member.principalId, actor, action, lifetime: '7 days' }],
      grant: { actor, action, lifetime: '7 days' } }) });
  // The large cut's works already hold this actor's reader status, so the control adds no shelf entries.
  // The small cut's manifest always records every other population dimension.
  await growSeedCheckpointPopulation(api, population, cut.works, {
    recipeOccurrences: shape.recipeOccurrences!,
    readerShelfEntries: 0,
    mountedCollectionResources: shape.mountedCollectionResources!,
    zoneNavigationEntries: shape.zoneNavigationEntries!,
  });
  const zone = short(population.zone.id);
  const routePath = '/v1/zones/' + zone + '/routes?path=' + encodeURIComponent('/' + population.zone.mounts[0]!.segment);
  const presentationPath = '/v1/zones/' + zone + '/presentation';
  const route = await profileRead(sink, restored, routePath, scale);
  const presentation = await profileRead(sink, restored, presentationPath, scale);
  console.log('Zone navigation control counters', JSON.stringify({
    built: {
      recipeOccurrences: population.recipe.occurrences.length,
      readerShelfEntries: population.shelfWorks.length,
      mountedCollectionResources: population.collection.members.length,
      zoneNavigationEntries: population.zone.mounts.length,
    },
    routes: measuredCounters(route.profile),
    presentation: measuredCounters(presentation.profile),
  }));
  writeProfileDump('zone-control-route-profile', profileDump('route', 'control', routePath, route.profile, restored.apps));
  writeProfileDump('zone-control-presentation-profile',
    profileDump('presentation', 'control', presentationPath, presentation.profile, restored.apps));
  return { route: route.profile, presentation: presentation.profile };
}

test('Zone navigation reads stay within their cost class as unrelated Works grow', async () => {
  const sink = startWorkProfileSink();
  // pg must load after the SDK installs its instrumentation hooks.
  startTelemetry('main', {
    ...process.env,
    ...sink.env,
    OTEL_SERVICE_NAME: 'main',
    OTEL_TRACES_SAMPLER_ARG: '1',
  });
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { restoreWorkProfileCorpus } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { readRetainedSeed, seedApi, seedAuthorName, seedCensus, seedDirectory } =
    await import('../support/seed-checkpoints.ts');
  const { ZONE_ROUTE_COST } = await import('../../../services/main/src/modules/zone/route-cost.ts');
  const retained = readRetainedSeed();
  expect(retained.cuts.map((cut) => cut.manifest.dimensions.unrelatedWorks)).toEqual([4, 16, 64]);

  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Zone navigation growth requires task goal QA run metadata');

  const qaStackDir = join(root, '.temp', 'stack', 'rezics-qa-' + qaRunId);
  expect(readEnv(join(qaStackDir, 'compose.env')).REZICS_STACK_STORAGE).toBe('persistent');

  const smokeCopies = new Map<string, RestoredMeasurement>();
  const targets: string[] = [];
  const routeProfiles: ScaledProfile[] = [];
  const presentationProfiles: ScaledProfile[] = [];
  let verifying: RetainedSeedCut | undefined;
  let control: Awaited<ReturnType<typeof measureControlZone>> | undefined;

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
      const stack = await openRestoredStack(input);
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
              const artifact = join(root, '.temp', 'zone-navigation-census-' + qaRunId + '-' + cut.manifest.scale + '.json');
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

    for (const [index, cut] of retained.cuts.entries()) {
      verifying = cut;
      const scale = cut.manifest.dimensions.unrelatedWorks;
      const target = 'zone-navigation-' + qaRunId + '-' + cut.manifest.scale;

      // Published backups are read-only. Restore metadata and object bytes from
      // a local copy; the driver copies the retained owner volumes independently.
      const localBackup = join(root, '.temp', 'zone-navigation-backups', qaRunId, cut.manifest.id);
      mkdirSync(dirname(localBackup), { recursive: true });
      cpSync(dirname(cut.manifest.backup), localBackup, { recursive: true });
      await restoreWorkProfileCorpus({
        ...cut.manifest,
        backup: join(localBackup, basename(cut.manifest.backup)),
      }, target, driver);
      targets.push(target);
      const restored = smokeCopies.get(target);
      if (!restored) throw new Error('The retained checkpoint smoke read did not keep its restored stack open');

      if (index === 0) {
        const knownReadPath = '/v1/zones/' + short(cut.population.zone.id)
          + '/routes?path=' + encodeURIComponent('/' + cut.population.zone.mounts[0]!.segment);
        const probe = await profileRead(sink, restored, knownReadPath, scale);
        const wiring = measuredCounters(probe.profile);
        console.log('Zone navigation meter wiring probe', JSON.stringify({
          scale: cut.manifest.scale,
          path: knownReadPath,
          counters: wiring,
        }));
        if ((probe.profile.postgresStatements ?? 0) <= 0 || (probe.profile.fusekiRequests ?? 0) <= 0) {
          throw new Error(
            'Work profile meter wiring probe failed: the known Zone page read must report positive postgresStatements and fusekiRequests',
          );
        }
      }

      const segment = cut.population.zone.mounts[0]!.segment;
      const routePath = '/v1/zones/' + short(cut.population.zone.id) + '/routes?path=' + encodeURIComponent('/' + segment);
      const presentationPath = '/v1/zones/' + short(cut.population.zone.id) + '/presentation';
      const route = await profileRead(sink, restored, routePath, scale);
      const presentation = await profileRead(sink, restored, presentationPath, scale);

      const routePage = route.result as {
        kind: string;
        items: Array<{ id: string; inZone: boolean }>;
      };
      expect(routePage.kind).toBe('index');
      expect(routePage.items.map((item) => ({ id: item.id, inZone: item.inZone }))).toEqual(
        cut.population.collection.members.slice(0, 24).map((member) => ({
          id: member.work,
          inZone: true,
        })),
      );
      if (cut.manifest.scale === 'large') {
        // Own entries: the route pages at most pageSize items and stays within the Zone site's graph caps.
        expect(routePage.items).toHaveLength(
          Math.min(cut.manifest.dimensions.zoneNavigationEntries!, ZONE_ROUTE_COST.pageSize),
        );
        expect(route.profile.fusekiRequests).toBeLessThanOrEqual(ZONE_ROUTE_COST.maxGraphReads);
        expect(route.profile.fusekiSentBytes).toBeLessThanOrEqual(ZONE_ROUTE_COST.maxGraphBytes);
        expect(route.profile.fusekiReceivedBytes).toBeLessThanOrEqual(ZONE_ROUTE_COST.maxGraphBytes);
      }

      const zonePresentation = presentation.result as {
        navigation: Array<{ segment: string; target: string; kind: string }>;
      };
      expect(zonePresentation.navigation.map(({ segment: itemSegment, target: itemTarget, kind }) => ({
        segment: itemSegment,
        target: itemTarget,
        kind,
      }))).toEqual(cut.population.zone.mounts.slice(0, ZONE_ROUTE_COST.maxNavigation).map((mount) => ({
        segment: mount.segment,
        target: mount.target,
        kind: 'index',
      })));

      writeProfileDump('zone-route-profile-' + cut.manifest.scale,
        profileDump('route', cut.manifest.scale, routePath, route.profile, restored.apps));
      writeProfileDump('zone-presentation-profile-' + cut.manifest.scale,
        profileDump('presentation', cut.manifest.scale, presentationPath, presentation.profile, restored.apps));
      // The control runs after the large cut's reads, so its writes cannot change those counters.
      if (cut.manifest.scale === 'large')
        control = await measureControlZone(sink, restored, cut, retained.cuts[0]!.manifest.dimensions, retained.actor, scale);
      routeProfiles.push(route.profile);
      presentationProfiles.push(presentation.profile);
      console.log('Zone navigation checkpoint counters', JSON.stringify({
        scale: cut.manifest.scale,
        dimensions: {
          unrelatedWorks: cut.manifest.dimensions.unrelatedWorks,
          recipeOccurrences: cut.manifest.dimensions.recipeOccurrences,
          zoneNavigationEntries: cut.manifest.dimensions.zoneNavigationEntries,
          mountedCollectionResources: cut.manifest.dimensions.mountedCollectionResources,
          readerShelfEntries: cut.manifest.dimensions.readerShelfEntries,
        },
        routes: measuredCounters(route.profile),
        presentation: measuredCounters(presentation.profile),
      }));

      await driver.stop(target);
      targets.splice(targets.indexOf(target), 1);
    }

    const cost = zoneSiteReadCost(ZONE_ROUTE_COST);
    const failures: unknown[] = [];
    if (!control) throw new Error('The within-cut control Zone was not measured');
    // The cuts co-grow the Zone's own entries with unrelated Works, so only the control, which keeps the
    // small cut's 4 own entries among 64 unrelated Works, isolates the unrelated axis for the route.
    const routeAgainstControl = [routeProfiles[0]!, control.route];
    for (const [label, profiles] of [
      ['zone-route-growth', routeAgainstControl],
      ['zone-presentation-growth', presentationProfiles],
    ] as const) {
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
      try {
        assertWorkCostAtScales(profiles, cost, label);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Zone navigation growth contracts failed');
  } finally {
    for (const target of targets.reverse()) await driver.stop(target);
    await shutdownTelemetry();
    await sink.stop();
  }
}, 600_000);

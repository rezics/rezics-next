import { expect, test } from 'bun:test';
import { cpSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { flushTelemetryTraces, shutdownTelemetry, startTelemetry }
  from '../../../packages/observability/src/runtime.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root, dockerEnvironment, stream } from '../../../scripts/fixture/stack.ts';
import { createCorpusBackupDriver, type CorpusRestoreSmokeInput }
  from '../../../scripts/load/corpus-backup-driver.ts';
import { restoreWorkProfileCorpus } from '../../../scripts/load/work-profile-corpus.ts';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkCostField,
  type WorkProfile,
} from '../support/work-profile.ts';
import {
  readRetainedSeed,
  seedApi,
  seedAuthorName,
  seedCensus,
  seedDirectory,
  seedSelection,
  type RetainedSeedCut,
} from '../support/seed-checkpoints.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { ZONE_ROUTE_COST } from '../../../services/main/src/modules/zone/route-cost.ts';

type ScaledProfile = WorkProfile & { unrelatedWorks: number };

type RestoredMeasurement = {
  stack: MediaStack;
  fusekiUrl: string;
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

test('Zone navigation reads stay within their cost class as unrelated Works grow', async () => {
  const retained = readRetainedSeed();
  expect(retained.cuts.map((cut) => cut.manifest.dimensions.unrelatedWorks)).toEqual([4, 16, 64]);

  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Zone navigation growth requires task goal QA run metadata');

  const qaStackDir = join(root, '.temp', 'stack', 'rezics-qa-' + qaRunId);
  expect(readEnv(join(qaStackDir, 'compose.env')).REZICS_STACK_STORAGE).toBe('persistent');

  const sink = startWorkProfileSink();
  const smokeCopies = new Map<string, RestoredMeasurement>();
  const targets: string[] = [];
  const routeProfiles: ScaledProfile[] = [];
  const presentationProfiles: ScaledProfile[] = [];
  let verifying: RetainedSeedCut | undefined;

  startTelemetry('main', {
    ...process.env,
    ...sink.env,
    OTEL_SERVICE_NAME: 'main',
    OTEL_TRACES_SAMPLER_ARG: '1',
  });

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
        expect(await seedCensus(api, cut)).toEqual(cut.manifest.dimensions);
        smokeCopies.set(input.target, { stack, fusekiUrl: input.apps.FUSEKI_URL! });
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
        const knownReadPath = seedSelection(cut.works[0]!.mainVersion);
        const probe = await profileRead(sink, restored, knownReadPath, scale);
        const wiring = measuredCounters(probe.profile);
        console.log('Zone navigation meter wiring probe', JSON.stringify({
          scale: cut.manifest.scale,
          path: knownReadPath,
          counters: wiring,
        }));
        if ((probe.profile.postgresStatements ?? 0) <= 0 || (probe.profile.fusekiRequests ?? 0) <= 0) {
          throw new Error(
            'Work profile meter wiring probe failed: the known public Work selection read must report positive postgresStatements and fusekiRequests',
          );
        }
      }

      const segment = cut.population.zone.mounts[0]!.segment;
      const route = await profileRead(
        sink,
        restored,
        '/v1/zones/' + short(cut.population.zone.id) + '/routes?path=' + encodeURIComponent('/' + segment),
        scale,
      );
      const presentation = await profileRead(
        sink,
        restored,
        '/v1/zones/' + short(cut.population.zone.id) + '/presentation',
        scale,
      );

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
    for (const [label, profiles] of [
      ['zone-route-growth', routeProfiles],
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

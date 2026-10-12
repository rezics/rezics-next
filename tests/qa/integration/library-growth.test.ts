import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { dockerEnvironment, root, stream } from '../../../scripts/fixture/stack.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import {
  createCorpusBackupDriver,
  type CorpusRestoreSmokeInput,
} from '../../../scripts/load/corpus-backup-driver.ts';
import { restoreWorkProfileCorpus, type CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import { READER_LIBRARY_COST } from '../../../services/main/src/modules/library/read.ts';
import { STATUS_SHELF_COST } from '../../../services/main/src/modules/library/status.ts';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkProfile,
} from '../support/work-profile.ts';
import {
  readRetainedSeed,
  seedApi,
  seedAuthorName,
  seedSelection,
  seedDirectory,
  type RetainedSeedCut,
} from '../support/seed-checkpoints.ts';
import type { MediaStack } from './media-support.ts';
type MediaStackStarter = typeof import('./media-support.ts').startMediaStack;

const workAxis = 'unrelatedWorks' satisfies keyof CorpusDimensions;
const scales = [4, 16, 64] as const;
const serviceName = 'library-growth-cost';
const readerName = 'Library growth measurement reader';

type RestoredContext = {
  stack: MediaStack;
  readerToken: string;
  readerAgent: string;
  targetWork: string;
  fusekiUrl: string;
};

async function openRestoredStack(input: CorpusRestoreSmokeInput, startMediaStack: MediaStackStarter) {
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
    return await startMediaStack(`library-growth-${input.target}`, {
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

function actorCommand() {
  return {
    method: 'POST' as const,
    path: '/v1/agents' as const,
    body: {
      profile: 'agent-provision-v1',
      kind: 'person',
      displayName: readerName,
    },
  };
}

async function profileRead(
  context: RestoredContext,
  sink: ReturnType<typeof startWorkProfileSink>,
  path: string,
  token?: string,
) {
  const { result, profile } = await profileRequest(
    sink,
    async (headers) => {
      if (token) headers.set('authorization', `Bearer ${token}`);
      const response = await context.stack.main.handle(
        new Request(`http://main.local${path}`, { headers }),
      );
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(body) as Record<string, unknown>;
    },
    {
      service: serviceName,
      peers: { fuseki: context.fusekiUrl },
      flush: flushTelemetryTraces,
    },
  );
  expect(profile.mainCalls).toBe(0);
  expect(profile.unclassifiedFetches).toBe(0);
  return { result, profile };
}

const readerCost = {
  fusekiRequests: READER_LIBRARY_COST.graphCalls,
  fusekiReceivedBytes: READER_LIBRARY_COST.responseBytes,
  postgresStatements: READER_LIBRARY_COST.sqlReads,
  accountCalls: 0,
  otherFetches: 0,
  unclassifiedFetches: 0,
} satisfies Omit<WorkCostContract, 'growth'>;

// The shelf's SQL budget composes the reader read budget with its indexed candidate batches.
const shelfCost = {
  fusekiRequests: READER_LIBRARY_COST.graphCalls,
  fusekiReceivedBytes: READER_LIBRARY_COST.responseBytes,
  postgresStatements: READER_LIBRARY_COST.sqlReads + STATUS_SHELF_COST.candidateBatches,
  accountCalls: 0,
  otherFetches: 0,
  unclassifiedFetches: 0,
} satisfies Omit<WorkCostContract, 'growth'>;

function costContract(maxima: Omit<WorkCostContract, 'growth'>): WorkCostContract {
  return {
    ...maxima,
    growth: {
      fusekiRequests: { class: 'constant', dimension: 'mainCalls' },
      fusekiSentBytes: { class: 'constant', dimension: 'mainCalls' },
      fusekiReceivedBytes: { class: 'constant', dimension: 'mainCalls' },
      postgresStatements: { class: 'constant', dimension: 'mainCalls' },
    },
  };
}

test('Reader library shelf and Work status reads stay constant as unrelated Works grow', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through goalctl integration QA');
  }
  const sourceDirectory = join(root, '.temp/stack', `rezics-qa-${runId}`);
  if (readEnv(join(sourceDirectory, 'compose.env')).REZICS_STACK_STORAGE !== 'persistent') {
    throw new Error('Library growth checkpoints require the persistent catalogue-disk QA project');
  }

  const retained = readRetainedSeed();
  expect(retained.cuts.map((cut) => cut.manifest.dimensions[workAxis])).toEqual(scales);
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry(serviceName, {
    ...process.env,
    ...sink.env,
    OTEL_TRACES_SAMPLER_ARG: '1',
  });
  // Telemetry must initialize before the in-process product composition imports pg.
  const { startMediaStack } = await import('./media-support.ts');
  let activeCut: RetainedSeedCut | undefined;
  const restored = new Map<string, RestoredContext>();
  const targets: string[] = [];
  const profiles: Array<{
    scale: number;
    operation: 'status-shelf' | 'reader-state';
    profile: WorkProfile;
  }> = [];
  const driver = createCorpusBackupDriver({
    sourceRunId: retained.sourceRunId,
    directory: seedDirectory,
    resumeSource: false,
    restoreResourceClass: 'ordinary',
    quiesce: async () => {
      throw new Error('Routine growth measurement only restores retained checkpoints');
    },
    async smokeRead(input) {
      const stack = await openRestoredStack(input, startMediaStack);
      try {
        if (!activeCut) throw new Error('No active retained Work-profile checkpoint');
        const target = activeCut.works[0]!;
        const author = await stack.member(seedAuthorName, { stable: true, verified: true });
        const authorApi = seedApi(stack, author.token);
        const selected = await authorApi.read(seedSelection(target.mainVersion));
        expect(selected).toMatchObject({
          work: target.work,
          mainVersion: target.mainVersion,
          body: 'Checkpoint selected text 0',
        });

        const reader = await stack.member(`library-growth-${input.target}`, {
          stable: true,
          verified: true,
        });
        const readerApi = seedApi(stack, reader.token);
        const agent = await readerApi.command<{ agent: string }>(
          `library-growth:${input.target}:agent`,
          actorCommand(),
        );
        await readerApi.command(`library-growth:${input.target}:status`, {
          method: 'PUT',
          path: `/v1/works/${target.work.slice(-36)}/reader-status`,
          body: {
            actingSubject: agent.agent,
            expectedVersion: 0,
            status: 'reading',
            startedOn: null,
            finishedOn: null,
          },
        });

        restored.set(input.target, {
          stack,
          readerToken: reader.token,
          readerAgent: agent.agent,
          targetWork: target.work,
          fusekiUrl: input.apps.FUSEKI_URL!,
        });
        return async () => {
          restored.delete(input.target);
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
      ['stack:down', '--', '--profile', 'qa', '--run-id', runId, '--persistent'],
      dockerEnvironment(),
    );

    for (const cut of retained.cuts) {
      activeCut = cut;
      const scale = cut.manifest.dimensions[workAxis];
      const target = `lib-growth-${cut.manifest.scale}-${runId}`;
      targets.push(target);
      const restoreStarted = performance.now();
      const elapsedMs = await restoreWorkProfileCorpus(cut.manifest, target, driver, restoreStarted);
      expect(elapsedMs).toBeLessThan(600_000);
      const context = restored.get(target);
      if (!context) throw new Error(`Restored library checkpoint ${target} is unavailable`);

      // A public Work-page request must prove both meters in this same harness before
      // a zero from either library endpoint can be interpreted as a measured zero.
      const calibration = await profileRead(
        context,
        sink,
        `/v1/works/${context.targetWork.slice(-36)}?language=en`,
      );
      console.log('Library growth meter calibration', {
        dimension: workAxis,
        size: scale,
        postgresStatements: calibration.profile.postgresStatements,
        fusekiRequests: calibration.profile.fusekiRequests,
      });
      if (
        (calibration.profile.postgresStatements ?? 0) <= 0 ||
        (calibration.profile.fusekiRequests ?? 0) <= 0
      ) {
        throw new Error(
          `Library growth meter wiring failed at ${scale} Works: known public Work read must have nonzero postgresStatements and fusekiRequests`,
        );
      }
      expect(calibration.result).toMatchObject({ profile: 'work-read-v1', id: context.targetWork });
      sink.clear();

      const actingSubject = encodeURIComponent(context.readerAgent);
      const requests = [
        {
          operation: 'status-shelf' as const,
          path: `/v1/me/shelves/status/reading/works?actingSubject=${actingSubject}&sort=added&order=desc&limit=${STATUS_SHELF_COST.pageSize}`,
        },
        {
          operation: 'reader-state' as const,
          path: `/v1/works/${context.targetWork.slice(-36)}/reader-state?actingSubject=${actingSubject}`,
        },
      ];
      for (const request of requests) {
        const { result, profile } = await profileRead(
          context,
          sink,
          request.path,
          context.readerToken,
        );
        if (request.operation === 'status-shelf') {
          const shelf = result as { items: Array<{ work: string; status: string }> };
          expect(shelf.items).toHaveLength(1);
          expect(shelf.items[0]).toMatchObject({ work: context.targetWork, status: 'reading' });
        } else {
          expect(result).toMatchObject({
            work: context.targetWork,
            status: { status: 'reading' },
          });
        }

        // assertWorkCostAtScales consumes a WorkProfile dimension. Use its marker
        // for the retained checkpoint size; mainCalls itself was checked above.
        profiles.push({
          scale,
          operation: request.operation,
          profile: { ...profile, mainCalls: scale },
        });
        console.log('Library growth counters', {
          dimension: workAxis,
          size: scale,
          operation: request.operation,
          fusekiRequests: profile.fusekiRequests,
          fusekiSentBytes: profile.fusekiSentBytes,
          fusekiReceivedBytes: profile.fusekiReceivedBytes,
          postgresStatements: profile.postgresStatements,
        });
        sink.clear();
      }
      await driver.stop(target);
    }

    const failures: string[] = [];
    for (const operation of ['status-shelf', 'reader-state'] as const) {
      const maxima = operation === 'status-shelf' ? shelfCost : readerCost;
      const group = profiles
        .filter((item) => item.operation === operation)
        .sort((a, b) => a.scale - b.scale)
        .map((item) => item.profile);
      try {
        assertWorkCostAtScales(group, costContract(maxima), `library-${operation}-unrelated-works`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const target of targets) {
      try {
        await driver.stop(target);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const context of restored.values()) {
      try {
        await context.stack.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await shutdownTelemetry();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await sink.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Library growth cleanup failed');
  }
}, 600_000);

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { fromPlainText } from '@rezics/document';
import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { COLLECTION_BOUNDS } from '../../src/content/collection-job.ts';
import { CONTENT_COLLECTION_SCHEDULE } from '../../src/content/work.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthReport,
} from '../support/growth.ts';
import {
  composeNativeCollectionRuntime,
  contentHttp,
  createHttpMedia,
  createMediaObjectStore,
  databaseUrlForSystem,
  MEDIA_NATIVE_GROWTH_BASE,
  MEDIA_NATIVE_GROWTH_CUT,
  type HttpMedia,
  type NativeCollectionRuntime,
} from './media-native-collection-fixture.ts';
import {
  EMPTY_COLLECTION_FRESH_AT,
  EMPTY_COLLECTION_GROWTH_PREFIX,
  emptyCollectionPopulationCounts,
  seedEmptyCollectionHistory,
  type EmptyCollectionAxis,
} from './support/growth-media-empty-collection-fixture.ts';
import { createContentSystem, type ContentSystem } from './support/system.ts';
import { provisionMediaContainers } from './support/media-fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const SCALE = [256, 1024, 4096] as const;
const REPETITIONS = 2;
const MAX_EXPECTED_BATCH = 100;

type PageOutcome = {
  readonly partition: number;
  readonly examined: number;
  readonly collected: number;
  readonly complete: boolean;
};

type ScheduleEvidence = {
  readonly workflowId: string;
  readonly partitionWorkflowId: string;
  readonly result: unknown;
  readonly replayResult: unknown;
  readonly workflowStatus: string | undefined;
  readonly partitionStatus: string | undefined;
  readonly steps: readonly unknown[];
  readonly pageOutcomes: readonly PageOutcome[];
};

type Guard = {
  readonly claimed: HttpMedia;
  readonly fresh: HttpMedia;
  readonly claimedPostId: string;
};

function reportRelations(report: GrowthReport): string[] {
  return [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
}

function assertMeasuredReport(report: GrowthReport) {
  expect(report.samples.map((sample) => sample.scale)).toEqual([...SCALE]);
  expect(report.samples.every((sample) => sample.repetitions.length === REPETITIONS)).toBe(true);
  expect(
    report.samples.every(
      ({ cost }) =>
        cost.statements > 0 &&
        cost.rows > 0 &&
        Number.isFinite(cost.blocks) &&
        Number.isFinite(cost.sharedHit) &&
        Number.isFinite(cost.sharedRead),
    ),
  ).toBe(true);
  const relations = reportRelations(report);
  expect(relations.length).toBeGreaterThan(0);
  assertGrowthAccessPaths(report.name, report.samples, relations);
}

async function pngFixture() {
  return sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 71, g: 126, b: 52 },
    },
  })
    .png()
    .toBuffer();
}

async function makeHttpMedia(
  system: ContentSystem,
  runtime: NativeCollectionRuntime,
  store: ReturnType<typeof createMediaObjectStore>,
  containerId: string,
  bytes: Uint8Array,
  keyPrefix: string,
) {
  const media = await createHttpMedia({
    system,
    store,
    runtime,
    actor: system.actors.author,
    uploader: system.actors.worker,
    containerId,
    bytes,
    keyPrefix,
  });
  expect(media.image.state).toBe('available');
  expect(media.image.variants.length).toBeGreaterThan(0);
  expect(store.inspect(`m/${media.id}/`).length).toBe(media.image.variants.length + 1);
  return media;
}

async function createClaimedAndFreshGuards(options: {
  readonly system: ContentSystem;
  readonly runtime: NativeCollectionRuntime;
  readonly store: ReturnType<typeof createMediaObjectStore>;
  readonly container: { readonly id: string; readonly route: number };
  readonly bytes: Uint8Array;
}) {
  await options.system.clock.setCommandTime(MEDIA_NATIVE_GROWTH_BASE);
  const claimed = await makeHttpMedia(
    options.system,
    options.runtime,
    options.store,
    options.container.id,
    options.bytes,
    'empty-collection-claimed',
  );
  const posted = await contentHttp(
    options.system,
    options.system.actors.author,
    'POST',
    `/v1/threads/${options.container.id}/posts`,
    {
      body: fromPlainText('Claimed media remains protected during collection.'),
      licence: 'MIT',
      mediaIds: [claimed.id],
    },
  );
  expect(posted.response.status).toBe(201);
  const post = posted.body?.post as { readonly id?: unknown; readonly mediaIds?: unknown } | undefined;
  expect(typeof post?.id).toBe('string');
  expect(post?.mediaIds).toEqual([claimed.id]);

  await options.system.clock.setCommandTime(EMPTY_COLLECTION_FRESH_AT);
  const fresh = await makeHttpMedia(
    options.system,
    options.runtime,
    options.store,
    options.container.id,
    options.bytes,
    'empty-collection-fresh',
  );
  return { claimed, fresh, claimedPostId: post!.id as string } satisfies Guard;
}

async function readGuardState(options: {
  readonly system: ContentSystem;
  readonly database: GrowthDatabase;
  readonly store: ReturnType<typeof createMediaObjectStore>;
  readonly partition: number;
  readonly guard: Guard;
}) {
  const ids = [options.guard.claimed.id, options.guard.fresh.id].sort();
  const rows = await options.system.database.pool.query<{
    media_id: string;
    state: string;
    created_at: string;
    claimed_item_id: string | null;
    claimed_at: string | null;
    erased: boolean;
    taken_down: boolean;
    collection_pending: boolean;
  }>(
    `SELECT media_id::text,state,created_at::text,claimed_item_id::text,claimed_at::text,
            erased,taken_down,collection_pending
       FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[]) ORDER BY media_id`,
    [routeOf(options.guard.claimed.id), ids],
  );
  const receipts = await options.database.admin.query<{ command_kind: string; idempotency_key: string }>(
    `SELECT command_kind,idempotency_key FROM core.receipt
      WHERE partition_no=$1 AND command_kind IN ('content.media.collection.fence','content.media.collection.finish')
        AND idempotency_key=ANY($2::text[]) ORDER BY idempotency_key,command_kind`,
    [options.partition, ids],
  );
  const events = await options.database.admin.query<{ subject: string; type: string }>(
    `SELECT subject,type FROM core.outbox WHERE partition_no=$1 AND subject=ANY($2::text[])
      AND type IN ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1')
      ORDER BY subject,type`,
    [options.partition, ids],
  );
  return {
    rows: rows.rows,
    physical: [options.guard.claimed, options.guard.fresh].map((media) => ({
      mediaId: media.id,
      objects: options.store
        .inspect(`m/${media.id}/`)
        .sort((left, right) => left.key.localeCompare(right.key)),
    })),
    collectionReceipts: receipts.rows,
    collectionEvents: events.rows,
  };
}

async function assertGuardState(options: {
  readonly system: ContentSystem;
  readonly database: GrowthDatabase;
  readonly store: ReturnType<typeof createMediaObjectStore>;
  readonly partition: number;
  readonly guard: Guard;
  readonly baseline: Awaited<ReturnType<typeof readGuardState>>;
}) {
  const current = await readGuardState(options);
  expect(current).toEqual(options.baseline);
  expect(current.collectionReceipts).toEqual([]);
  expect(current.collectionEvents).toEqual([]);
  expect(current.rows).toHaveLength(2);
  expect(current.rows.find(({ media_id }) => media_id === options.guard.claimed.id)).toMatchObject({
    state: 'available',
    claimed_item_id: options.guard.claimedPostId,
    erased: false,
    collection_pending: false,
  });
  expect(current.rows.find(({ media_id }) => media_id === options.guard.fresh.id)).toMatchObject({
    state: 'available',
    claimed_item_id: null,
    claimed_at: null,
    erased: false,
    collection_pending: false,
  });
}

async function runRegisteredSweep(options: {
  readonly runtime: NativeCollectionRuntime;
  readonly partition: number;
  readonly setWorkerTime: (at: string) => void;
}): Promise<ScheduleEvidence> {
  options.setWorkerTime(MEDIA_NATIVE_GROWTH_CUT);
  const schedule = await options.runtime.client.triggerSchedule(CONTENT_COLLECTION_SCHEDULE);
  const result = await schedule.getResult();
  const partitionWorkflowId = `${schedule.workflowID}:partition:${options.partition}`;
  const [root, child, steps] = await Promise.all([
    options.runtime.client.getWorkflow(schedule.workflowID),
    options.runtime.client.getWorkflow(partitionWorkflowId),
    options.runtime.client.listWorkflowSteps(partitionWorkflowId),
  ]);
  const registeredSteps = steps ?? [];
  const pageOutcomes = registeredSteps
    .filter((step) => step.name === 'content.collect.step')
    .map((step) => step.output as PageOutcome);
  const replayResult = await options.runtime.client.retrieveWorkflow(schedule.workflowID).getResult();
  expect(replayResult).toEqual(result);
  expect(root?.status).toBe('SUCCESS');
  expect(child?.status).toBe('SUCCESS');
  expect(registeredSteps.map((step) => step.name)).toContain('content.collect.step');
  return {
    workflowId: schedule.workflowID,
    partitionWorkflowId,
    result,
    replayResult,
    workflowStatus: root?.status,
    partitionStatus: child?.status,
    steps: registeredSteps,
    pageOutcomes,
  };
}

function assertEmptySelection(evidence: ScheduleEvidence, partition: number) {
  expect(evidence.pageOutcomes).toEqual([{ partition, examined: 0, collected: 0, complete: true }]);
}

function assertSingleTargetSelection(evidence: ScheduleEvidence, partition: number) {
  expect(evidence.pageOutcomes).toEqual([{ partition, examined: 1, collected: 1, complete: true }]);
}

function assertFullBatchAndTerminalPage(evidence: ScheduleEvidence, partition: number) {
  expect(evidence.pageOutcomes).toEqual([
    { partition, examined: COLLECTION_BOUNDS.batch, collected: COLLECTION_BOUNDS.batch, complete: false },
    { partition, examined: 0, collected: 0, complete: true },
  ]);
}

async function assertCollectedBatch(options: {
  readonly system: ContentSystem;
  readonly database: GrowthDatabase;
  readonly store: ReturnType<typeof createMediaObjectStore>;
  readonly partition: number;
  readonly targets: readonly HttpMedia[];
}) {
  const ids = options.targets.map(({ id }) => id).sort();
  const remaining = await options.system.database.pool.query<{ media_id: string }>(
    'SELECT media_id::text FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[]) ORDER BY media_id',
    [routeOf(ids[0]!), ids],
  );
  expect(remaining.rows).toEqual([]);
  const receipts = await options.database.admin.query<{ idempotency_key: string; command_kind: string }>(
    `SELECT idempotency_key,command_kind FROM core.receipt
      WHERE partition_no=$1 AND idempotency_key=ANY($2::text[])
        AND command_kind IN ('content.media.collection.fence','content.media.collection.finish')
      ORDER BY idempotency_key,command_kind`,
    [options.partition, ids],
  );
  expect(receipts.rows).toHaveLength(2 * options.targets.length);
  for (const media of options.targets) {
    expect(receipts.rows.filter(({ idempotency_key }) => idempotency_key === media.id).map(({ command_kind }) =>
      command_kind,
    ).sort()).toEqual(['content.media.collection.fence', 'content.media.collection.finish']);
    expect(options.store.inspect(`m/${media.id}/`)).toEqual([]);
  }
  const eventCounts = await options.database.admin.query<{ subject: string; count: number }>(
    `SELECT subject,count(*)::integer AS count FROM core.outbox
      WHERE partition_no=$1 AND subject=ANY($2::text[])
        AND type IN ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1')
      GROUP BY subject ORDER BY subject`,
    [options.partition, ids],
  );
  expect(eventCounts.rows).toEqual(ids.map((subject) => ({ subject, count: 2 })));
}

test(
  'Empty eligible selection and the post-batch empty page stay bounded through the registered native collector.',
  async () => {
    const store = createMediaObjectStore();
    let system: ContentSystem | undefined;
    let database: GrowthDatabase | undefined;
    let runtime: NativeCollectionRuntime | undefined;
    const reports: { readonly operation: string; readonly report: GrowthReport }[] = [];
    const populations: unknown[] = [];
    const operations: unknown[] = [];
    let workerTime = '2031-01-02T00:00:00.000Z';
    try {
      expect(COLLECTION_BOUNDS.batch).toBe(MAX_EXPECTED_BATCH);
      system = await createContentSystem({
        databaseUrl,
        namespace: `media_empty_collection_${crypto.randomUUID().replaceAll('-', '')}`,
      });
      const { containers } = await provisionMediaContainers(system, { namespace: crypto.randomUUID() });
      const thread = containers.thread;
      const systemUrl = await databaseUrlForSystem(system, databaseUrl);
      database = await openGrowthDatabase(systemUrl);
      if (!DBOS.isInitialized()) throw new Error('Native Auth did not retain its setup executor');
      await DBOS.shutdown({ deregister: true });
      if (DBOS.isInitialized()) throw new Error('Native Auth executor remained registered before content work');
      runtime = await composeNativeCollectionRuntime({
        databaseUrl: systemUrl,
        routeKey: system.routeKey,
        partitions: [thread.partition],
        store,
        clock: () => new Date(workerTime),
        pool: database.pool,
      });
      const bytes = await pngFixture();
      const guard = await createClaimedAndFreshGuards({ system, runtime, store, container: thread, bytes });
      const guardBaseline = await readGuardState({ system, database, store, partition: thread.partition, guard });
      expect(guardBaseline.rows.find(({ media_id }) => media_id === guard.claimed.id)).toMatchObject({
        state: 'available',
        claimed_item_id: guard.claimedPostId,
        collection_pending: false,
      });
      expect(guardBaseline.rows.find(({ media_id }) => media_id === guard.fresh.id)).toMatchObject({
        state: 'available',
        claimed_item_id: null,
        claimed_at: null,
        collection_pending: false,
      });
      expect(guardBaseline.collectionReceipts).toEqual([]);
      expect(guardBaseline.collectionEvents).toEqual([]);

      async function growAxis(axis: EmptyCollectionAxis, prefix: string, scale: number, previous: number) {
        if (axis === 'other-routes' && previous === 0) {
          await seedEmptyCollectionHistory(database!, {
            axis: 'same-route',
            prefix,
            partition: thread.partition,
            hotRoute: thread.route,
            hotContainerId: thread.id,
            scale: 4096,
            previous: 0,
          });
        }
        await seedEmptyCollectionHistory(database!, {
          axis,
          prefix,
          partition: thread.partition,
          hotRoute: thread.route,
          hotContainerId: thread.id,
          scale,
          previous,
        });
        const counts = await emptyCollectionPopulationCounts(database!, {
          prefix: `${prefix}%`,
          partition: thread.partition,
          hotRoute: thread.route,
          hotContainerId: thread.id,
          eligibleBefore: '2031-01-01T00:00:00.000Z',
        });
        const expectedHot = axis === 'same-route' ? scale : 4096;
        const expectedOther = axis === 'same-route' ? 0 : scale;
        expect(counts).toEqual({
          hot: expectedHot,
          other: expectedOther,
          total: expectedHot + expectedOther,
          variants: 2 * (expectedHot + expectedOther),
          receipts: expectedHot + expectedOther,
          events: expectedHot + expectedOther,
          writeBasis: expectedHot + expectedOther,
          eligible: 0,
        });
        populations.push({ prefix, axis, scale, ...counts });
      }

      async function measureEmptySelection(axis: EmptyCollectionAxis) {
        const prefix = `${EMPTY_COLLECTION_GROWTH_PREFIX}${axis}-empty:`;
        const report = await checkGrowth(database!, {
          name: `native registered empty selection ${axis}`,
          scales: SCALE,
          repetitions: REPETITIONS,
          warmups: 1,
          rule: 'series',
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          grow: async (_db, scale, previous) => growAxis(axis, prefix, scale, previous),
          async warmup(_db, scale, repetition) {
            const run = await runRegisteredSweep({
              runtime: runtime!,
              partition: thread.partition,
              setWorkerTime: (at) => (workerTime = at),
            });
            assertEmptySelection(run, thread.partition);
            await assertGuardState({
              system: system!,
              database: database!,
              store,
              partition: thread.partition,
              guard,
              baseline: guardBaseline,
            });
            operations.push({ operation: 'initially empty eligible selection', axis, scale, repetition, warmup: true, ...run });
          },
          async prepare() {
            await assertGuardState({
              system: system!,
              database: database!,
              store,
              partition: thread.partition,
              guard,
              baseline: guardBaseline,
            });
          },
          async operation(_db, scale, repetition) {
            const run = await runRegisteredSweep({
              runtime: runtime!,
              partition: thread.partition,
              setWorkerTime: (at) => (workerTime = at),
            });
            assertEmptySelection(run, thread.partition);
            operations.push({
              operation: 'initially empty eligible selection',
              axis,
              scale,
              repetition,
              warmup: false,
              ...run,
            });
            return run;
          },
        });
        assertMeasuredReport(report);
        reports.push({ operation: `initially empty eligible selection ${axis}`, report });
      }

      async function createTargetBatch(scale: number, repetition: number) {
        const targets: HttpMedia[] = [];
        for (let index = 0; index < COLLECTION_BOUNDS.batch; index++) {
          targets.push(
            await makeHttpMedia(
              system!,
              runtime!,
              store,
              thread.id,
              bytes,
              `empty-collection-batch-${scale}-${repetition}-${index}`,
            ),
          );
        }
        const ids = targets.map(({ id }) => id);
        expect(new Set(ids).size).toBe(COLLECTION_BOUNDS.batch);
        const selected = await system!.database.pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM content.media
            WHERE route=$1 AND container_id=$2 AND media_id=ANY($3::uuid[])
              AND claimed_at IS NULL AND NOT erased AND NOT collection_pending
              AND created_at <= $4::timestamptz`,
          [thread.route, thread.id, ids, MEDIA_NATIVE_GROWTH_BASE],
        );
        expect(selected.rows[0]?.count).toBe(COLLECTION_BOUNDS.batch);
        return targets;
      }

      async function measureTerminalPage(axis: EmptyCollectionAxis) {
        const prefix = `${EMPTY_COLLECTION_GROWTH_PREFIX}${axis}-terminal:`;
        let prepared: readonly HttpMedia[] | undefined;
        const report = await checkGrowth(database!, {
          name: `native registered terminal empty page ${axis}`,
          scales: SCALE,
          repetitions: REPETITIONS,
          warmups: 1,
          rule: 'series',
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          grow: async (_db, scale, previous) => growAxis(axis, prefix, scale, previous),
          async warmup(_db, scale, repetition) {
            await system!.clock.setCommandTime(MEDIA_NATIVE_GROWTH_BASE);
            const target = await makeHttpMedia(
              system!,
              runtime!,
              store,
              thread.id,
              bytes,
              `empty-collection-warmup-${axis}-${scale}-${repetition}`,
            );
            const run = await runRegisteredSweep({
              runtime: runtime!,
              partition: thread.partition,
              setWorkerTime: (at) => (workerTime = at),
            });
            assertSingleTargetSelection(run, thread.partition);
            await assertCollectedBatch({
              system: system!,
              database: database!,
              store,
              partition: thread.partition,
              targets: [target],
            });
            await assertGuardState({
              system: system!,
              database: database!,
              store,
              partition: thread.partition,
              guard,
              baseline: guardBaseline,
            });
            operations.push({
              operation: 'bounded selection warmup',
              axis,
              scale,
              repetition,
              warmup: true,
              targetId: target.id,
              ...run,
            });
          },
          async prepare(_db, scale, repetition) {
            if (prepared) {
              await assertCollectedBatch({
                system: system!,
                database: database!,
                store,
                partition: thread.partition,
                targets: prepared,
              });
              prepared = undefined;
            }
            await assertGuardState({
              system: system!,
              database: database!,
              store,
              partition: thread.partition,
              guard,
              baseline: guardBaseline,
            });
            await system!.clock.setCommandTime(MEDIA_NATIVE_GROWTH_BASE);
            prepared = await createTargetBatch(scale, repetition);
          },
          async operation(_db, scale, repetition) {
            const targets = prepared;
            if (!targets || targets.length !== COLLECTION_BOUNDS.batch)
              throw new Error('The measured terminal page lacks one full native media batch');
            const run = await runRegisteredSweep({
              runtime: runtime!,
              partition: thread.partition,
              setWorkerTime: (at) => (workerTime = at),
            });
            assertFullBatchAndTerminalPage(run, thread.partition);
            operations.push({
              operation: 'final empty page after bounded batch',
              axis,
              scale,
              repetition,
              batchSize: targets.length,
              targetIds: targets.map(({ id }) => id),
              pageOutcomes: run.pageOutcomes,
              workflowId: run.workflowId,
              partitionWorkflowId: run.partitionWorkflowId,
              replayResult: run.replayResult,
              workflowStatus: run.workflowStatus,
              partitionStatus: run.partitionStatus,
              steps: run.steps,
            });
            return run;
          },
        });
        if (prepared)
          await assertCollectedBatch({
            system,
            database,
            store,
            partition: thread.partition,
            targets: prepared,
          });
        prepared = undefined;
        assertMeasuredReport(report);
        reports.push({ operation: `final empty page after bounded batch ${axis}`, report });
      }

      await measureEmptySelection('same-route');
      await measureEmptySelection('other-routes');
      await measureTerminalPage('same-route');
      await measureTerminalPage('other-routes');
      await assertGuardState({ system, database, store, partition: thread.partition, guard, baseline: guardBaseline });

      const repo = resolve(import.meta.dir, '../../../..');
      const evidencePath = join(repo, '.temp', 'goal', 'content-empty-media-collection-growth.json');
      mkdirSync(resolve(evidencePath, '..'), { recursive: true });
      writeFileSync(
        evidencePath,
        `${JSON.stringify(
          {
            source: 'registered content.collection.hourly with isolated media storage',
            revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
            command: 'bun run --cwd services/kernel check test/content/growth-media-empty-collection.test.ts',
            fixtures: [
              'media-native-collection-fixture.ts: native Auth, Access, HTTP, registered effects, Sharp, and isolated R2-compatible storage',
              'growth-media-empty-collection-fixture.ts: seeded unrelated same-route and other-route retained histories',
            ],
            partition: thread.partition,
            targetRoute: thread.route,
            targetContainerId: thread.id,
            scheduledPartitions: [thread.partition],
            batchBound: COLLECTION_BOUNDS.batch,
            guardMediaIds: { claimed: guard.claimed.id, fresh: guard.fresh.id },
            growthScales: SCALE,
            repetitions: REPETITIONS,
            populations,
            operations,
            reports,
            executionLimits: ['isolated R2-compatible storage only; no live provider configuration was exercised'],
          },
          (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
          2,
        )}\n`,
      );
    } finally {
      if (runtime) {
        try {
          await runtime.client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
        } finally {
          await runtime.close();
        }
      }
      try {
        await database?.close();
      } finally {
        try {
          await system?.close();
        } finally {
          store.close();
        }
      }
    }
  },
  1_800_000,
);

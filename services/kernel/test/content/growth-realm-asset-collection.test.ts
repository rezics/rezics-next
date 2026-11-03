import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { newId, routeOf } from '../../src/route/route.ts';
import { CONTENT_COLLECTION_SCHEDULE } from '../../src/content/work.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthReport,
} from '../support/growth.ts';
import {
  composeNativeCollectionRuntime,
  createMediaObjectStore,
  databaseUrlForSystem,
  type MediaObjectStore,
  type NativeCollectionRuntime,
} from './media-native-collection-fixture.ts';
import { createContentSystem, type ContentSystem } from './support/system.ts';
import {
  clearRealmMediaPressure,
  createRealmAssetHome as createNativeRealmAssetHome,
  createRealmAsset,
  nativeContentRequest,
  REALM_COLLECTION_BASE,
  REALM_COLLECTION_CUT,
  REALM_COLLECTION_SCALES,
  realmMediaSnapshot,
  realmRevisionPresentation,
  seedRealmMediaPressure,
  seedRetainedClaimHistory,
  setRealmPresentation,
  type RealmAsset,
  type RealmAssetHome,
} from './support/growth-realm-asset-collection-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const AXES = ['same-home', 'other-home', 'retained-history'] as const;
type Axis = (typeof AXES)[number];
type SelectedPage = readonly [RealmAsset, RealmAsset];

function reportRelations(report: GrowthReport): string[] {
  return [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
}

function targetSignature(targets: SelectedPage) {
  return [...targets]
    .sort((left, right) => left.purpose.localeCompare(right.purpose))
    .map((target) => ({
      purpose: target.purpose,
      sourceByteCount: target.sourceBytes.byteLength,
      sourceDigest: target.sourceDigest,
      variants: target.image.variants.map(({ format, width, height, mediaType, byteCount, sha256 }) => ({
        format,
        width,
        height,
        mediaType,
        byteCount,
        sha256,
      })),
      prefix: `m/{mediaId}/`,
      keys: ['m/{mediaId}/avif-320', 'm/{mediaId}/original', 'm/{mediaId}/webp-320'],
    }));
}

async function candidateCount(database: GrowthDatabase, home: RealmAssetHome) {
  const result = await database.admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM content.media
      WHERE route=$1 AND container_id=$2 AND claimed_at IS NULL AND NOT erased AND NOT collection_pending
        AND created_at <= $3::timestamptz`,
    [home.route, home.id, REALM_COLLECTION_BASE],
  );
  return result.rows[0]?.count ?? -1;
}

async function historyCounts(database: GrowthDatabase, route: number, prefix: string) {
  const result = await database.admin.query<{ media: number; claimed: number; revisions: number }>(
    `SELECT
       (SELECT count(*)::integer FROM content.media WHERE reservation_request_id LIKE $1) AS media,
       (SELECT count(*)::integer FROM content.media
         WHERE reservation_request_id LIKE $1 AND claimed_at IS NOT NULL AND claimed_realm_id=container_id) AS claimed,
       (SELECT count(*)::integer FROM community.realm_revision
         WHERE route=$2 AND title='Retained claim history fixture') AS revisions`,
    [`${prefix}:history:%`, route],
  );
  return result.rows[0] ?? { media: -1, claimed: -1, revisions: -1 };
}

async function withObservedKernelPool<T>(
  system: ContentSystem,
  database: GrowthDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const pool = system.database.pool as unknown as Record<string, unknown>;
  const query = Object.getOwnPropertyDescriptor(pool, 'query');
  const connect = Object.getOwnPropertyDescriptor(pool, 'connect');
  Object.defineProperty(pool, 'query', { configurable: true, value: database.pool.query.bind(database.pool) });
  Object.defineProperty(pool, 'connect', { configurable: true, value: database.pool.connect.bind(database.pool) });
  try {
    return await operation();
  } finally {
    if (query) Object.defineProperty(pool, 'query', query);
    else Reflect.deleteProperty(pool, 'query');
    if (connect) Object.defineProperty(pool, 'connect', connect);
    else Reflect.deleteProperty(pool, 'connect');
  }
}

async function mediaCollectionEvidence(
  database: GrowthDatabase,
  targets: SelectedPage,
  partition: number,
  uploaderId: string,
) {
  const evidence = [];
  for (const target of targets) {
    const row = await realmMediaSnapshot(database, routeOf(target.id)!, target.id);
    expect(row).toBeNull();
    const events = await database.admin.query<{ type: string; position: string }>(
      `SELECT type,position::text FROM core.outbox WHERE partition_no=$1 AND subject=$2
        AND type IN ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1')
        ORDER BY position,event_seq`,
      [partition, target.id],
    );
    expect(events.rows.map(({ type }) => type)).toEqual([
      'com.rezics.content.media.collection-pending.v1',
      'com.rezics.content.media.collected.v1',
    ]);
    expect(BigInt(events.rows[0]!.position)).toBeLessThan(BigInt(events.rows[1]!.position));
    const receipts = await database.admin.query<{ command_kind: string; count: number }>(
      `SELECT command_kind,count(*)::integer AS count FROM core.receipt
        WHERE partition_no=$1 AND principal_id=$2 AND idempotency_key=$3
          AND command_kind IN ('content.media.collection.fence','content.media.collection.finish')
        GROUP BY command_kind ORDER BY command_kind`,
      [partition, uploaderId, target.id],
    );
    expect(receipts.rows).toEqual([
      { command_kind: 'content.media.collection.fence', count: 1 },
      { command_kind: 'content.media.collection.finish', count: 1 },
    ]);
    evidence.push({
      id: target.id,
      purpose: target.purpose,
      events: events.rows,
      receipts: receipts.rows,
    });
  }
  return evidence;
}

test('Native Realm abandoned icon and banner collection stays bounded across homes and retained claim history.', async () => {
  const store = createMediaObjectStore();
  let system: ContentSystem | undefined;
  let database: GrowthDatabase | undefined;
  let runtime: NativeCollectionRuntime | undefined;
  const reports: GrowthReport[] = [];
  const populations: unknown[] = [];
  const selectedPages: unknown[] = [];
  const retryEvidence: unknown[] = [];
  let home: RealmAssetHome | undefined;
  let claimAsset: RealmAsset | undefined;
  let claimRevisionId = '';
  let clearedRevisionId = '';
  let claimPhysical: ReturnType<MediaObjectStore['inspect']> = [];
  let fixedShape: ReturnType<typeof targetSignature> | undefined;
  let workerTime = REALM_COLLECTION_CUT;
  let serial = 0;
  try {
    system = await createContentSystem({
      databaseUrl,
      namespace: `realm_asset_collection_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await system.clock.setCommandTime(REALM_COLLECTION_BASE);
    home = await createNativeRealmAssetHome(system);
    const url = await databaseUrlForSystem(system, databaseUrl);
    database = await openGrowthDatabase(url);
    if (!DBOS.isInitialized()) throw new Error('Native Auth did not retain its setup executor');
    await DBOS.shutdown({ deregister: true });
    if (DBOS.isInitialized()) throw new Error('Native Auth executor remained registered before content work');
    runtime = await composeNativeCollectionRuntime({
      databaseUrl: url,
      routeKey: system.routeKey,
      partitions: [home.partition],
      store,
      clock: () => new Date(workerTime),
      pool: database.pool,
    });

    claimAsset = await createRealmAsset(system, store, runtime, home, 'realm-icon', 'retained-claim');
    claimRevisionId = await setRealmPresentation(
      system,
      home,
      home.headRevisionId,
      claimAsset.id,
      null,
      `realm-asset-claim-${crypto.randomUUID()}`,
    );
    const oldPresentation = await realmRevisionPresentation(database, home, claimRevisionId);
    expect(oldPresentation).toEqual({ avatarMediaId: claimAsset.id, bannerMediaId: null, rules: null });
    clearedRevisionId = await setRealmPresentation(
      system,
      home,
      claimRevisionId,
      null,
      null,
      `realm-asset-clear-${crypto.randomUUID()}`,
    );
    expect(await realmRevisionPresentation(database, home, claimRevisionId)).toEqual(oldPresentation);
    expect(await realmRevisionPresentation(database, home, clearedRevisionId)).toEqual({
      avatarMediaId: null,
      bannerMediaId: null,
      rules: null,
    });
    expect(await realmMediaSnapshot(database, home.route, claimAsset.id)).toMatchObject({
      purpose: 'realm-icon',
      state: 'available',
      container_id: home.id,
      claimed_realm_id: home.id,
      collection_pending: false,
    });
    claimPhysical = store.inspect(`m/${claimAsset.id}/`);
    expect(claimPhysical).toHaveLength(claimAsset.image.variants.length + 1);
    const pressurePrefix = `realm-collection-${crypto.randomUUID()}`;
    const uploaderId = system.actors.author.actor.accountId;
    async function selectedPage(axis: Axis, scale: number, repetition: number): Promise<SelectedPage> {
      const targets = [
        await createRealmAsset(
          system!,
          store,
          runtime!,
          home!,
          'realm-icon',
          `${axis}-${scale}-${repetition}-icon-${serial++}`,
        ),
        await createRealmAsset(
          system!,
          store,
          runtime!,
          home!,
          'realm-banner',
          `${axis}-${scale}-${repetition}-banner-${serial++}`,
        ),
      ] as const;
      expect(targets.map(({ purpose }) => purpose).sort()).toEqual(['realm-banner', 'realm-icon']);
      expect(await candidateCount(database!, home!)).toBe(2);
      const ordered = await database!.admin.query<{ media_id: string }>(
        `SELECT media_id::text FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[])
          ORDER BY created_at,media_id`,
        [home!.route, targets.map(({ id }) => id)],
      );
      expect(ordered.rows).toHaveLength(2);
      const byId = new Map(targets.map((target) => [target.id, target]));
      const first = byId.get(ordered.rows[0]!.media_id);
      const second = byId.get(ordered.rows[1]!.media_id);
      if (!first || !second) throw new Error('Native Realm collector page order lost a selected asset');
      const signature = targetSignature(targets);
      if (fixedShape) expect(signature).toEqual(fixedShape);
      else fixedShape = signature;
      const physical = targets.map((target) => store.inspect(`m/${target.id}/`));
      expect(physical.map((objects) => objects.length)).toEqual(
        targets.map((target) => target.image.variants.length + 1),
      );
      selectedPages.push({
        axis,
        scale,
        repetition,
        partition: home!.partition,
        route: home!.route,
        pageSize: targets.length,
        objectPrefixes: targets.map(() => 'm/{mediaId}/'),
        signature,
        physical,
      });
      return [first, second];
    }

    async function collectPage(axis: Axis, scale: number, targets: SelectedPage) {
      const beforeFailedDeletes = store.failedDeletes.length;
      const [first, second] = targets;
      const firstPrefix = `m/${first.id}/`;
      const firstObjects = store.inspect(firstPrefix);
      const secondObjects = store.inspect(`m/${second.id}/`);
      const failedPrefix = await store.failDeleteOnce(firstPrefix);
      const scheduled = await runtime!.client.triggerSchedule(CONTENT_COLLECTION_SCHEDULE);
      await failedPrefix.entered;

      let refused: Awaited<ReturnType<typeof nativeContentRequest>>;
      try {
        expect(await realmMediaSnapshot(database!, home!.route, first.id)).toMatchObject({
          purpose: first.purpose,
          state: 'available',
          collection_pending: true,
          claimed_at: null,
        });
        expect(store.inspect(firstPrefix)).toEqual(firstObjects);
        const pendingEvents = await database!.admin.query<{ type: string }>(
          `SELECT type FROM core.outbox WHERE partition_no=$1 AND subject=$2
            AND type IN ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1')
            ORDER BY position,event_seq`,
          [home!.partition, first.id],
        );
        expect(pendingEvents.rows.map(({ type }) => type)).toEqual(['com.rezics.content.media.collection-pending.v1']);
        const unfinished = await database!.admin.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM core.receipt
            WHERE partition_no=$1 AND principal_id=$2 AND command_kind='content.media.collection.finish'
              AND idempotency_key=$3`,
          [home!.partition, uploaderId, first.id],
        );
        expect(unfinished.rows[0]?.count).toBe(0);
        refused = await withObservedKernelPool(system!, database!, () =>
          nativeContentRequest(
            system!,
            system!.actors.worker,
            'POST',
            `/v1/media/${first.id}:complete`,
            {
              containerId: home!.id,
              reservationRequestId: first.reservationKey,
              byteCount: first.sourceBytes.byteLength,
              sha256: first.sourceDigest,
            },
            `${first.reservationKey}-complete`,
          ),
        );
      } finally {
        failedPrefix.release();
      }
      expect(refused.response.status).toBe(403);
      expect(refused.body).toMatchObject({ status: 403, code: 'forbidden' });

      await scheduled.getResult();
      const childId = `${scheduled.workflowID}:partition:${home!.partition}`;
      const root = await runtime!.client.getWorkflow(scheduled.workflowID);
      const child = await runtime!.client.getWorkflow(childId);
      const steps = (await runtime!.client.listWorkflowSteps(childId)) ?? [];
      const collectSteps = steps.filter((step) => step.name === 'content.collect.step');
      const lastCollect = collectSteps.at(-1);
      expect(root?.status).toBe('SUCCESS');
      expect(child?.status).toBe('SUCCESS');
      expect(collectSteps.length).toBeGreaterThan(0);
      expect(lastCollect?.output).toEqual({ partition: home!.partition, examined: 2, collected: 2, complete: true });
      const failedKeys = store.failedDeletes.slice(beforeFailedDeletes);
      expect(failedKeys).toHaveLength(1);
      expect(failedKeys[0]?.startsWith(firstPrefix)).toBe(true);
      expect(store.listPrefixes.filter((prefix) => prefix === firstPrefix)).toHaveLength(2);
      expect(store.listPrefixes.filter((prefix) => prefix === `m/${second.id}/`)).toHaveLength(1);
      for (const target of targets) expect(store.inspect(`m/${target.id}/`)).toEqual([]);

      const terminal = await mediaCollectionEvidence(database!, targets, home!.partition, uploaderId);
      expect(await realmRevisionPresentation(database!, home!, claimRevisionId)).toEqual({
        avatarMediaId: claimAsset!.id,
        bannerMediaId: null,
        rules: null,
      });
      expect(await realmRevisionPresentation(database!, home!, clearedRevisionId)).toEqual({
        avatarMediaId: null,
        bannerMediaId: null,
        rules: null,
      });
      expect(await realmMediaSnapshot(database!, home!.route, claimAsset!.id)).toMatchObject({
        purpose: 'realm-icon',
        state: 'available',
        container_id: home!.id,
        claimed_realm_id: home!.id,
        collection_pending: false,
      });
      expect(store.inspect(`m/${claimAsset!.id}/`)).toEqual(claimPhysical);
      retryEvidence.push({
        axis,
        scale,
        failedPrefix: firstPrefix,
        refused: { status: refused.response.status, code: refused.body?.code },
        firstObjectsBeforeRetry: firstObjects,
        secondObjectsBeforeCollection: secondObjects,
        failedDeletes: store.failedDeletes.slice(beforeFailedDeletes),
        listPrefixes: store.listPrefixes.filter((prefix) => prefix === firstPrefix || prefix === `m/${second.id}/`),
        terminal,
        workflowId: scheduled.workflowID,
        partitionWorkflowId: childId,
        workflowStatus: root?.status,
        partitionStatus: child?.status,
        steps,
      });
    }

    async function measureAxis(axis: Axis) {
      let prepared: SelectedPage | undefined;
      const report = await checkGrowth(database!, {
        name: `native Realm collection ${axis}`,
        scales: REALM_COLLECTION_SCALES,
        repetitions: 2,
        warmups: 1,
        rule: 'series',
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_db, scale, previous) {
          if (axis === 'retained-history') {
            await seedRetainedClaimHistory(database!, {
              partition: home!.partition,
              route: home!.route,
              uploaderId,
              prefix: pressurePrefix,
              from: previous,
              to: scale,
            });
            expect(await historyCounts(database!, home!.route, pressurePrefix)).toEqual({
              media: scale,
              claimed: scale,
              revisions: 2 * scale,
            });
          } else {
            await seedRealmMediaPressure(database!, {
              axis,
              partition: home!.partition,
              hotRoute: home!.route,
              homeId: home!.id,
              uploaderId,
              prefix: pressurePrefix,
              from: previous,
              to: scale,
            });
            const count = await database!.admin.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM content.media WHERE reservation_request_id LIKE $1',
              [`${pressurePrefix}:${axis}:%`],
            );
            expect(count.rows[0]?.count).toBe(scale);
          }
          expect(await candidateCount(database!, home!)).toBe(0);
          populations.push({ axis, scale, partition: home!.partition, selectedEligible: 0 });
        },
        async warmup(_db, scale, repetition) {
          await collectPage(axis, scale, await selectedPage(axis, scale, repetition));
        },
        async prepare(_db, scale, repetition) {
          prepared = await selectedPage(axis, scale, repetition);
        },
        async operation(_db, scale) {
          workerTime = REALM_COLLECTION_CUT;
          if (!prepared) throw new Error('The measured Realm collection has no prepared native page');
          await collectPage(axis, scale, prepared);
        },
      });
      reports.push(report);
      expect(report.samples.map((sample) => sample.scale)).toEqual([...REALM_COLLECTION_SCALES]);
      expect(report.samples.every((sample) => sample.repetitions.length === 2)).toBe(true);
      expect(report.samples.every((sample) => sample.cost.statements > 0 && sample.cost.rows > 0)).toBe(true);
      expect(report.samples.every((sample) => sample.cost.blocks > 0)).toBe(true);
      const relations = reportRelations(report);
      expect(relations.length).toBeGreaterThan(0);
      assertGrowthAccessPaths(report.name, report.samples, relations);
    }

    for (const axis of AXES) {
      await measureAxis(axis);
      if (axis !== 'retained-history') await clearRealmMediaPressure(database!, pressurePrefix);
    }

    expect(await realmRevisionPresentation(database!, home, claimRevisionId)).toEqual({
      avatarMediaId: claimAsset.id,
      bannerMediaId: null,
      rules: null,
    });
    const repo = resolve(import.meta.dir, '../../../..');
    const evidencePath = join(repo, '.temp', 'goal', 'content-realm-asset-collection-growth.json');
    mkdirSync(resolve(evidencePath, '..'), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          source: 'production registered content.collection.hourly work',
          baseRevision: 'c968558f1f20e21ca88ac8e7b26754a3fd642d7a',
          command: 'bun run --cwd services/kernel check test/content/growth-realm-asset-collection.test.ts',
          fixture: {
            realmId: home.id,
            route: home.route,
            partition: home.partition,
            partitionSet: [home.partition],
            claimedMediaId: claimAsset.id,
            claimRevisionId,
            clearedRevisionId,
            scales: REALM_COLLECTION_SCALES,
            populations,
            selectedPages,
            retryEvidence,
          },
          reports,
          accessPathRelations: reports.map((report) => ({ name: report.name, relations: reportRelations(report) })),
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
}, 600_000);

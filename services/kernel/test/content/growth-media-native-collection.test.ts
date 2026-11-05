import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { CONTENT_COLLECTION_SCHEDULE } from '../../src/content/work.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type GrowthReport,
} from '../support/growth.ts';
import {
  MEDIA_NATIVE_GROWTH_BASE,
  MEDIA_NATIVE_GROWTH_CUT,
  composeNativeCollectionRuntime,
  createHttpMedia,
  createMediaObjectStore,
  databaseUrlForSystem,
  type HttpMedia,
  type MediaObjectStore,
} from './media-native-collection-fixture.ts';
import { createContentSystem, type ContentSystem } from './support/system.ts';
import { provisionMediaContainers } from './support/media-fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const GROWTH_PREFIX = 'media-native-growth:';
const SCALE = [256, 1024, 4096] as const;
const VARIANT_DIGESTS = [
  createHash('sha256').update('production-shaped-avif-320').digest('hex'),
  createHash('sha256').update('production-shaped-webp-320').digest('hex'),
];
const GROWTH_YOUNG = new Date(Date.parse(MEDIA_NATIVE_GROWTH_BASE) + 2 * 60 * 60 * 1000).toISOString();

type Axis = 'same-route' | 'other-routes';
type PopulationCounts = {
  readonly hot: number;
  readonly other: number;
  readonly total: number;
  readonly variants: number;
  readonly receipts: number;
  readonly events: number;
  readonly writeBasis: number;
  readonly eligible: number;
};

async function populationCounts(
  database: GrowthDatabase,
  partition: number,
  route: number,
  containerId: string,
): Promise<PopulationCounts> {
  const pattern = `${GROWTH_PREFIX}%`;
  const result = await database.admin.query<PopulationCounts>(
    `WITH media AS MATERIALIZED (
       SELECT route,media_id,container_id,transaction_id
         FROM content.media WHERE reservation_request_id LIKE $1
     ), receipts AS MATERIALIZED (
       SELECT transaction_id FROM core.receipt
        WHERE partition_no=$2 AND idempotency_key LIKE $1 AND command_kind='content.media.reserve'
     )
     SELECT count(*) FILTER (WHERE m.route=$3 AND m.container_id=$4)::integer AS hot,
            count(*) FILTER (WHERE m.route<>$3)::integer AS other,
            count(*)::integer AS total,
            (SELECT count(*)::integer FROM content.media_variant v
              JOIN media x ON x.route=v.route AND x.media_id=v.media_id) AS variants,
            (SELECT count(*)::integer FROM receipts) AS receipts,
            (SELECT count(*)::integer FROM core.outbox o JOIN media x ON x.media_id::text=o.subject
              WHERE o.partition_no=$2 AND o.type='com.rezics.content.media.reserved.v1') AS events,
            (SELECT count(*)::integer FROM editorial.write_basis b JOIN receipts r USING(transaction_id)
              WHERE b.partition_no=$2) AS "writeBasis",
            (SELECT count(*)::integer FROM content.media e
              WHERE e.route=$3 AND e.container_id=$4 AND e.claimed_at IS NULL AND NOT e.erased
                AND NOT e.collection_pending AND e.created_at <= $5::timestamptz) AS eligible
       FROM media m`,
    [pattern, partition, route, containerId, MEDIA_NATIVE_GROWTH_BASE],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Native media growth population query returned no row');
  return row;
}

function nativeGrowthPopulation(options: {
  readonly axis: Axis;
  readonly partition: number;
  readonly hotRoute: number;
  readonly hotContainerId: string;
  readonly positionBase: bigint;
  readonly from: number;
  readonly epoch: number;
}) {
  return {
    name: `media-native-collection-${options.axis}`,
    hotPartition: options.partition,
    hotShare: 1,
    rows(placement: { readonly ordinal: number }) {
      const ordinal = placement.ordinal;
      const hotOffset = options.hotRoute - options.partition * 16;
      const route =
        options.axis === 'same-route'
          ? options.hotRoute
          : options.partition * 16 + ((hotOffset + 1 + (ordinal % 15)) % 16);
      if (partitionOf(route) !== options.partition || routeOf(newId(route)) !== route)
        throw new Error('Growth media escaped its native collection partition');
      const mediaId = newId(route);
      const containerId = options.axis === 'same-route' ? options.hotContainerId : newId(route);
      const uploaderId = crypto.randomUUID();
      const transactionId = crypto.randomUUID();
      const reservationKey = `${GROWTH_PREFIX}${options.axis}:${ordinal}:${crypto.randomUUID()}`;
      const position = options.positionBase + BigInt(ordinal - options.from + 1);
      const sourceDigest = createHash('sha256').update(`${reservationKey}:source`).digest('hex');
      const response = { mediaId };
      const variants = ['avif', 'webp'] as const;
      return {
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: containerId,
            uploader_id: uploaderId,
            reservation_request_id: reservationKey,
            purpose: 'post-image',
            media_type: 'image/png',
            byte_count: 512,
            declared_sha256: sourceDigest,
            actual_byte_count: 512,
            sha256: sourceDigest,
            state: 'available',
            decision: null,
            key: `m/${mediaId}/original`,
            created_at: GROWTH_YOUNG,
            transaction_id: transactionId,
          },
        ],
        'content.media_variant': variants.map((format, index) => ({
          route,
          media_id: mediaId,
          format,
          width: 320,
          height: 240,
          media_type: `image/${format}`,
          byte_count: 96 + index,
          sha256: VARIANT_DIGESTS[index],
          key: `m/${mediaId}/${format}-320`,
          transaction_id: transactionId,
        })),
        'core.receipt': [
          {
            partition_no: options.partition,
            principal_id: uploaderId,
            command_kind: 'content.media.reserve',
            idempotency_key: reservationKey,
            request_digest: Buffer.from(createHash('sha256').update(reservationKey).digest()),
            epoch: options.epoch,
            position,
            transaction_id: transactionId,
            response,
            principal_kind: 'account',
          },
        ],
        'core.outbox': [
          {
            partition_no: options.partition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: options.epoch,
            id: newId(route),
            type: 'com.rezics.content.media.reserved.v1',
            subject: mediaId,
            data: { mediaId, containerId, actorId: uploaderId },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: options.partition,
            transaction_id: transactionId,
            epoch: options.epoch,
            position,
            principal_id: uploaderId,
            client_id: 'rezics-website',
            requested_by: null,
            principal_kind: 'account',
          },
        ],
      };
    },
    async finish(admin: GrowthDatabase['admin'], range: { readonly from: number; readonly to: number }) {
      const count = range.to - range.from;
      if (count < 1) return;
      await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
        options.partition,
        (options.positionBase + BigInt(count)).toString(),
      ]);
    },
  };
}

async function seedPopulation(
  database: GrowthDatabase,
  axis: Axis,
  partition: number,
  hotRoute: number,
  hotContainerId: string,
  scale: number,
  previous: number,
) {
  const current = await database.admin.query<{
    epoch: number;
    position: string;
  }>('SELECT epoch,position::text FROM core.partition WHERE partition_no=$1', [partition]);
  const row = current.rows[0];
  if (!row) throw new Error(`Collection partition ${partition} is not provisioned`);
  const population = nativeGrowthPopulation({
    axis,
    partition,
    hotRoute,
    hotContainerId,
    positionBase: BigInt(row.position),
    from: previous,
    epoch: row.epoch,
  });
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: previous,
    to: scale,
  });
}

function reportRelations(report: GrowthReport): string[] {
  return [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
}

async function eligibleTarget(
  system: ContentSystem,
  store: MediaObjectStore,
  runtime: Parameters<typeof createHttpMedia>[0]['runtime'],
  thread: { readonly id: string; readonly route: number },
  label: string,
): Promise<HttpMedia> {
  const source = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 61, g: 138, b: 47 },
    },
  })
    .png()
    .toBuffer();
  const media = await createHttpMedia({
    system,
    store,
    runtime,
    actor: system.actors.author,
    uploader: system.actors.worker,
    containerId: thread.id,
    bytes: source,
    keyPrefix: label,
  });
  if (media.image.state !== 'available' || media.image.variants.length === 0)
    throw new Error('The production Sharp worker did not publish the growth target variants');
  const row = await system.database.pool.query<{
    state: string;
    created_at: string;
    collection_pending: boolean;
  }>(`SELECT state,created_at::text,collection_pending FROM content.media WHERE route=$1 AND media_id=$2`, [
    thread.route,
    media.id,
  ]);
  expect(row.rows).toHaveLength(1);
  expect(row.rows[0]).toMatchObject({
    state: 'available',
    collection_pending: false,
  });
  expect(Date.parse(row.rows[0]!.created_at)).toBe(Date.parse(MEDIA_NATIVE_GROWTH_BASE));
  if (row.rows[0]?.collection_pending) throw new Error('A fresh growth target was unexpectedly collection-pending');
  const eligible = await system.database.pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM content.media
      WHERE route=$1 AND container_id=$2 AND claimed_at IS NULL AND NOT erased AND NOT collection_pending
        AND created_at <= $3::timestamptz`,
    [thread.route, thread.id, MEDIA_NATIVE_GROWTH_BASE],
  );
  expect(eligible.rows[0]?.count).toBe(1);
  expect(store.inspect(`m/${media.id}/`)).toEqual(
    [
      { key: `m/${media.id}/original`, sha256: media.sourceDigest },
      ...media.image.variants.map(({ key, sha256: digest }) => ({
        key,
        sha256: digest,
      })),
    ].sort((left, right) => left.key.localeCompare(right.key)),
  );
  return media;
}

async function collectTarget(
  database: GrowthDatabase,
  media: HttpMedia,
  partition: number,
  runtime: Awaited<ReturnType<typeof composeNativeCollectionRuntime>>,
  store: MediaObjectStore,
  uploaderId: string,
  observations: unknown[],
  series: string,
  scale: number,
) {
  const prefixesBefore = store.inspect(`m/${media.id}/`);
  if (prefixesBefore.length !== media.image.variants.length + 1)
    throw new Error('Growth target does not have its real source and Sharp variant objects');
  const schedule = await runtime.client.triggerSchedule(CONTENT_COLLECTION_SCHEDULE);
  await schedule.getResult();
  const childId = `${schedule.workflowID}:partition:${partition}`;
  const root = await runtime.client.getWorkflow(schedule.workflowID);
  const child = await runtime.client.getWorkflow(childId);
  const steps = (await runtime.client.listWorkflowSteps(childId)) ?? [];
  const collectStep = steps.find((step) => step.name === 'content.collect.step');
  expect(root?.status).toBe('SUCCESS');
  expect(child?.status).toBe('SUCCESS');
  expect(steps.map((step) => step.name)).toContain('content.collect.step');
  expect(collectStep?.output).toEqual({
    partition,
    examined: 1,
    collected: 1,
    complete: true,
  });
  const row = await database.admin.query('SELECT 1 FROM content.media WHERE route=$1 AND media_id=$2', [
    routeOf(media.id),
    media.id,
  ]);
  expect(row.rows).toEqual([]);
  expect(store.inspect(`m/${media.id}/`)).toEqual([]);
  const events = await database.admin.query<{ type: string }>(
    `SELECT type FROM core.outbox WHERE partition_no=$1 AND subject=$2
      AND type IN ('com.rezics.content.media.collection-pending.v1','com.rezics.content.media.collected.v1')
      ORDER BY position,event_seq`,
    [partition, media.id],
  );
  expect(events.rows.map(({ type }) => type)).toEqual([
    'com.rezics.content.media.collection-pending.v1',
    'com.rezics.content.media.collected.v1',
  ]);
  const counts = await database.admin.query<{
    fences: number;
    finishes: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
         AND command_kind='content.media.collection.fence' AND idempotency_key=$3) AS fences,
       (SELECT count(*)::integer FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
         AND command_kind='content.media.collection.finish' AND idempotency_key=$3) AS finishes`,
    [partition, uploaderId, media.id],
  );
  expect(counts.rows[0]).toEqual({ fences: 1, finishes: 1 });
  observations.push({
    series,
    scale,
    mediaId: media.id,
    sourceDigest: media.sourceDigest,
    sourceBytes: media.sourceBytes.byteLength,
    variants: media.image.variants,
    physicalBefore: prefixesBefore,
    physicalAfter: store.inspect(`m/${media.id}/`),
    workflowId: schedule.workflowID,
    partitionWorkflowId: childId,
    workflowResult: await schedule.getResult(),
    workflowStatus: root?.status,
    partitionStatus: child?.status,
    steps,
    collectionEvents: events.rows,
    receiptCounts: counts.rows[0],
  });
}

test('Joined collection, deletion retry and strict three-scale physical growth preserve all original media contracts.', async () => {
  const store = createMediaObjectStore();
  let system: ContentSystem | undefined;
  let database: GrowthDatabase | undefined;
  let runtime: Awaited<ReturnType<typeof composeNativeCollectionRuntime>> | undefined;
  let actorId = '';
  const reports: GrowthReport[] = [];
  const populationEvidence: unknown[] = [];
  const targetEvidence: unknown[] = [];
  try {
    system = await createContentSystem({
      databaseUrl,
      namespace: `media_growth_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const { containers } = await provisionMediaContainers(system, {
      namespace: crypto.randomUUID(),
    });
    const thread = containers.thread;
    actorId = system.actors.author.actor.accountId;
    await system.clock.setCommandTime(MEDIA_NATIVE_GROWTH_BASE);
    const systemUrl = await databaseUrlForSystem(system, databaseUrl);
    database = await openGrowthDatabase(systemUrl);
    // Auth setup, including the native identities and website credentials used below, is complete.
    // The measured operations authenticate those existing bearers locally and make no later Auth call.
    if (!DBOS.isInitialized()) throw new Error('Native Auth did not retain its setup executor');
    await DBOS.shutdown({ deregister: true });
    if (DBOS.isInitialized()) throw new Error('Native Auth executor remained registered before content work');
    let workerTime = MEDIA_NATIVE_GROWTH_CUT;
    runtime = await composeNativeCollectionRuntime({
      databaseUrl: systemUrl,
      routeKey: system.routeKey,
      partitions: [thread.partition],
      store,
      clock: () => new Date(workerTime),
      pool: database.pool,
    });
    const runtimePorts = runtime;
    let serial = 0;
    let fixedObjectShape:
      | {
          readonly sourceByteCount: number;
          readonly sourceDigest: string;
          readonly variants: readonly {
            readonly format: string;
            readonly width: number;
            readonly height: number;
            readonly mediaType: string;
            readonly byteCount: number;
            readonly sha256: string;
          }[];
          readonly keys: readonly string[];
          readonly objectDigests: readonly string[];
        }
      | undefined;

    async function growAxis(axis: Axis, scale: number, previous: number) {
      if (axis === 'other-routes' && previous === 0) {
        const hot = await populationCounts(database!, thread.partition, thread.route, thread.id);
        if (hot.hot !== 4096 || hot.other !== 0 || hot.total !== 4096)
          throw new Error('The independently grown same-container history is not fixed at 4096 rows');
        populationEvidence.push({ series: axis, scale: 0, ...hot });
      }
      await seedPopulation(database!, axis, thread.partition, thread.route, thread.id, scale, previous);
      const counts = await populationCounts(database!, thread.partition, thread.route, thread.id);
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
      populationEvidence.push({ series: axis, scale, ...counts });
    }

    async function makeTarget(axis: Axis, scale: number, repetition: number) {
      const current = await populationCounts(database!, thread.partition, thread.route, thread.id);
      const expectedHot = axis === 'same-route' ? scale : 4096;
      const expectedOther = axis === 'same-route' ? 0 : scale;
      expect(current).toMatchObject({
        hot: expectedHot,
        other: expectedOther,
        total: expectedHot + expectedOther,
        variants: 2 * (expectedHot + expectedOther),
        receipts: expectedHot + expectedOther,
        events: expectedHot + expectedOther,
        writeBasis: expectedHot + expectedOther,
        eligible: 0,
      });
      const media = await eligibleTarget(
        system!,
        store,
        runtimePorts,
        thread,
        `${axis}-${scale}-${repetition}-${serial++}`,
      );
      const targetCounts = await populationCounts(database!, thread.partition, thread.route, thread.id);
      expect(targetCounts).toEqual({ ...current, eligible: 1 });
      const physical = store.inspect(`m/${media.id}/`);
      const objectShape = {
        sourceByteCount: media.sourceBytes.byteLength,
        sourceDigest: media.sourceDigest,
        variants: media.image.variants.map(({ format, width, height, mediaType, byteCount, sha256 }) => ({
          format,
          width,
          height,
          mediaType,
          byteCount,
          sha256,
        })),
        keys: physical.map(({ key }) => key.replace(media.id, '{mediaId}')),
        objectDigests: physical.map(({ sha256 }) => sha256).sort(),
      };
      if (fixedObjectShape) expect(JSON.stringify(objectShape)).toBe(JSON.stringify(fixedObjectShape));
      else fixedObjectShape = objectShape;
      targetEvidence.push({
        series: axis,
        scale,
        repetition,
        id: media.id,
        original: {
          bytes: media.sourceBytes.byteLength,
          sha256: media.sourceDigest,
        },
        variants: media.image.variants,
        physical,
        counts: targetCounts,
      });
      return media;
    }

    async function measureAxis(axis: Axis) {
      let prepared: HttpMedia | undefined;
      const report = await checkGrowth(database!, {
        name: `native registered collection ${axis}`,
        scales: SCALE,
        repetitions: 2,
        warmups: 1,
        rule: 'series',
        bounds: {
          rows: 'constant',
          statements: 'constant',
          blocks: 'logarithmic',
        },
        grow: (db, scale, previous) => growAxis(axis, scale, previous),
        async warmup(_db, scale, repetition) {
          const target = await makeTarget(axis, scale, repetition);
          await collectTarget(
            database!,
            target,
            thread.partition,
            runtimePorts,
            store,
            actorId,
            targetEvidence,
            axis,
            scale,
          );
        },
        async prepare(_db, scale, repetition) {
          prepared = await makeTarget(axis, scale, repetition);
        },
        async operation(db, scale) {
          workerTime = MEDIA_NATIVE_GROWTH_CUT;
          const target = prepared;
          if (!target) throw new Error('The measured collection operation has no native HTTP target');
          await collectTarget(db, target, thread.partition, runtimePorts, store, actorId, targetEvidence, axis, scale);
        },
      });
      reports.push(report);
      expect(report.samples.map((sample) => sample.scale)).toEqual([...SCALE]);
      expect(report.samples.every((sample) => sample.repetitions.length === 2)).toBe(true);
      const relations = reportRelations(report);
      expect(relations.length).toBeGreaterThan(0);
      assertGrowthAccessPaths(report.name, report.samples, relations);
      expect(report.samples.every((sample) => sample.cost.statements > 0 && sample.cost.rows > 0)).toBe(true);
    }

    await measureAxis('same-route');
    await measureAxis('other-routes');

    const repo = resolve(import.meta.dir, '../../../..');
    const evidencePath = join(repo, '.temp', 'goal', 'content-media-native-collection-growth.json');
    mkdirSync(resolve(evidencePath, '..'), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          source: 'production registered content.collection.hourly work',
          partition: thread.partition,
          targetRoute: thread.route,
          targetContainerId: thread.id,
          eligibleAtCutPerRun: 1,
          fixedSourceBytes: targetEvidence[0],
          growthScales: SCALE,
          populations: populationEvidence,
          targets: targetEvidence,
          reports,
          accessPathRelations: reports.map((report) => ({
            name: report.name,
            relations: reportRelations(report),
          })),
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

import { expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ImageJobOutcome } from '../../src/content/image-job.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  seed,
  type GrowthDatabase,
  type GrowthReport,
  type Population,
} from '../support/growth.ts';
import { imageWorkflowIds, uploadedEvent } from './media-native-collection-fixture.ts';
import { growthRealmAssetPublicationFixture } from './support/growth-realm-asset-publication-fixture.ts';

setDefaultTimeout(600_000);

const scales = [256, 1024, 4096] as const;
const sourceByteLimit = 20 * 1024 * 1024;
const sourcePixelsLimit = 40_000_000;

type Fixture = Awaited<ReturnType<typeof growthRealmAssetPublicationFixture>>;
type VariantShape = Pick<
  ImageJobOutcome['variants'][number],
  'format' | 'width' | 'height' | 'mediaType' | 'byteCount' | 'sha256'
>;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function variantShape(outcome: ImageJobOutcome): VariantShape[] {
  return outcome.variants
    .map(({ format, width, height, mediaType, byteCount, sha256 }) => ({
      format,
      width,
      height,
      mediaType,
      byteCount,
      sha256,
    }))
    .sort((left, right) => left.format.localeCompare(right.format) || left.width - right.width);
}

async function drainSetupEvents(fixture: Fixture): Promise<void> {
  const result = await fixture.native.db.admin.query<{ position: string }>(
    'SELECT position::text FROM core.partition WHERE partition_no=$1',
    [fixture.partition],
  );
  const position = result.rows[0]?.position;
  if (position === undefined) throw new Error('Growth Realm partition is absent');
  await fixture.runtime.relayThrough(fixture.partition, BigInt(position));
}

async function publishThroughNativeRealm(
  fixture: Fixture,
  bytes: Uint8Array,
  sourceDigest: string,
  key: string,
): Promise<ImageJobOutcome> {
  const body = {
    purpose: 'realm-icon',
    mediaType: 'image/png',
    byteCount: bytes.byteLength,
    sha256: sourceDigest,
  };
  const reservationPath = `/v1/realms/${fixture.realmId}/media`;
  const refused = await fixture.native.call('POST', reservationPath, {
    bearer: fixture.native.alice.bearer,
    key: `${key}-refused`,
    body,
  });
  expect(refused.response.status).toBe(403);

  const reserved = await fixture.native.checked('POST', reservationPath, body, 201, {
    bearer: fixture.native.governor.bearer,
    key,
  });
  const media = reserved.media as { id?: unknown } | undefined;
  if (typeof media?.id !== 'string') throw new Error('Native Realm reservation omitted its media identity');
  const mediaId = media.id;
  expect(routeOf(mediaId)).toBe(fixture.route);

  await fixture.store.putOriginal(mediaId, bytes);
  const completionPath = `/v1/media/${mediaId}:complete`;
  const completionBody = {
    containerId: fixture.realmId,
    reservationRequestId: key,
    byteCount: bytes.byteLength,
    sha256: sourceDigest,
  };
  const completed = await fixture.native.checked('POST', completionPath, completionBody, 200, {
    bearer: fixture.native.governor.websiteBearer,
    key: `${key}-complete`,
  });

  const source = await uploadedEvent(fixture.native.db.pool, mediaId);
  expect(source.partition).toBe(fixture.partition);
  expect(source.type).toBe('com.rezics.content.media.uploaded.v1');
  const sourceRows = await fixture.native.db.admin.query<{
    subject: string;
    type: string;
    mediaId: string;
    containerId: string;
  }>(
    `SELECT subject,type,data->>'mediaId' AS "mediaId",data->>'containerId' AS "containerId"
       FROM core.outbox WHERE partition_no=$1 AND position=$2::bigint AND event_seq=$3`,
    [source.partition, source.position.toString(), source.eventSeq],
  );
  expect(sourceRows.rows).toEqual([
    {
      subject: mediaId,
      type: source.type,
      mediaId,
      containerId: fixture.realmId,
    },
  ]);

  const ids = imageWorkflowIds(source);
  await fixture.runtime.relayThrough(source.partition, source.position);
  await fixture.runtime.client.retrieveWorkflow(ids.effect).getResult();
  const outcome = (await fixture.runtime.client.retrieveWorkflow(ids.image).getResult()) as ImageJobOutcome;
  expect((await fixture.runtime.client.getWorkflow(ids.image))?.status).toBe('SUCCESS');
  expect(outcome).toMatchObject({ mediaId, state: 'available' });
  expect(outcome.variants.length).toBeGreaterThan(0);
  expect(outcome.variants.length).toBeLessThanOrEqual(12);

  const replay = await fixture.native.checked('POST', completionPath, completionBody, 200, {
    bearer: fixture.native.governor.websiteBearer,
    key: `${key}-complete`,
  });
  expect(replay.media).toEqual(completed.media);
  await fixture.runtime.relayThrough(source.partition, source.position);
  expect(await fixture.runtime.client.retrieveWorkflow(ids.image).getResult()).toEqual(outcome);

  const mediaRows = await fixture.native.db.admin.query<{
    route: number;
    media_id: string;
    container_id: string;
    uploader_id: string;
    reservation_request_id: string;
    byte_count: string;
    declared_sha256: string;
    actual_byte_count: string;
    sha256: string;
    state: string;
  }>(
    `SELECT route,media_id,container_id,uploader_id,reservation_request_id,byte_count::text,
            declared_sha256,actual_byte_count::text,sha256,state
       FROM content.media WHERE route=$1 AND media_id=$2`,
    [fixture.route, mediaId],
  );
  expect(mediaRows.rows).toEqual([
    {
      route: fixture.route,
      media_id: mediaId,
      container_id: fixture.realmId,
      uploader_id: fixture.native.governor.accountId,
      reservation_request_id: key,
      byte_count: String(bytes.byteLength),
      declared_sha256: sourceDigest,
      actual_byte_count: String(bytes.byteLength),
      sha256: sourceDigest,
      state: 'available',
    },
  ]);

  const variants = await fixture.native.db.admin.query<{
    format: string;
    width: number;
    height: number;
    media_type: string;
    byte_count: string;
    sha256: string;
    key: string;
  }>(
    `SELECT format,width,height,media_type,byte_count::text,sha256,key
       FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width`,
    [fixture.route, mediaId],
  );
  expect(variants.rows).toEqual(
    [...outcome.variants]
      .sort((left, right) => left.format.localeCompare(right.format) || left.width - right.width)
      .map(({ format, width, height, mediaType, byteCount, sha256: variantDigest, key: objectKey }) => ({
        format,
        width,
        height,
        media_type: mediaType,
        byte_count: String(byteCount),
        sha256: variantDigest,
        key: objectKey,
      })),
  );
  expect(
    new Set(variants.rows.map((row: { format: string; width: number }) => `${row.format}:${row.width}`)).size,
  ).toBe(variants.rows.length);
  expect(variants.rows.length).toBe(outcome.variants.length);
  expect(fixture.store.inspect(`m/${mediaId}/`)).toEqual(
    [
      { key: `m/${mediaId}/original`, sha256: sourceDigest },
      ...outcome.variants.map(({ key: objectKey, sha256: variantDigest }) => ({
        key: objectKey,
        sha256: variantDigest,
      })),
    ].sort((left, right) => left.key.localeCompare(right.key)),
  );
  const uploadEvents = await fixture.native.db.admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM core.outbox
      WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.media.uploaded.v1'`,
    [fixture.partition, mediaId],
  );
  expect(uploadEvents.rows[0]?.count).toBe(1);
  expect(sourceDigest).toBe(digest(bytes));
  expect(bytes.byteLength).toBeLessThanOrEqual(sourceByteLimit);
  return outcome;
}

function mediaPopulation(fixture: Fixture, sourceDigest: string, sourceBytes: number): Population {
  const routes = Array.from({ length: 16 }, (_, offset) => fixture.partition * 16 + offset).filter(
    (route) => route !== fixture.route,
  );
  return {
    name: 'growth-realm-asset-publication-unrelated-media',
    hotPartition: fixture.partition,
    hotShare: 1,
    rows({ ordinal }) {
      const route = routes[ordinal % routes.length]!;
      const mediaId = newId(route);
      const containerId = newId(route);
      const uploaderId = newId(route);
      const transactionId = newId(route);
      const variants = ['avif', 'webp'] as const;
      return {
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: containerId,
            uploader_id: uploaderId,
            reservation_request_id: `growth-realm-population-${ordinal}`,
            purpose: 'post-image',
            media_type: 'image/png',
            byte_count: sourceBytes,
            declared_sha256: sourceDigest,
            actual_byte_count: sourceBytes,
            sha256: sourceDigest,
            state: 'available',
            decision: null,
            key: `m/${mediaId}/original`,
            created_at: '2030-01-01T00:00:00.000Z',
            transaction_id: transactionId,
          },
        ],
        'content.media_variant': variants.map((format, index) => ({
          route,
          media_id: mediaId,
          format,
          width: 96,
          height: 64,
          media_type: `image/${format}`,
          byte_count: 100 + index,
          sha256: digest(Buffer.from(`growth-realm-variant:${ordinal}:${format}`)),
          key: `m/${mediaId}/${format}-96`,
          transaction_id: transactionId,
        })),
      };
    },
  };
}

function imageHistoryPopulation(
  fixture: Fixture,
  from: number,
  positionBase: bigint,
  epoch: number,
): Population {
  return {
    name: 'growth-realm-asset-publication-retained-image-history',
    hotPartition: fixture.partition,
    hotShare: 1,
    rows({ ordinal }) {
      const route = fixture.route;
      const mediaId = newId(route);
      const containerId = newId(route);
      const transactionId = newId(route);
      const position = positionBase + BigInt(ordinal - from + 1);
      const key = `growth-realm-history-${ordinal}`;
      return {
        'core.outbox': [
          {
            partition_no: fixture.partition,
            position,
            epoch,
            event_seq: 0,
            event_count: 1,
            id: newId(route),
            type: 'com.rezics.content.media.available.v1',
            subject: mediaId,
            data: { mediaId, containerId },
          },
        ],
        'core.receipt': [
          {
            partition_no: fixture.partition,
            position,
            epoch,
            principal_kind: 'account',
            principal_id: fixture.native.governor.accountId,
            command_kind: 'content.media.complete',
            idempotency_key: key,
            request_digest: createHash('sha256').update(key).digest(),
            transaction_id: transactionId,
            response: { mediaId, state: 'available' },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: fixture.partition,
            position,
            epoch,
            transaction_id: transactionId,
            principal_kind: 'account',
            principal_id: fixture.native.governor.accountId,
            client_id: 'rezics-website',
            requested_by: null,
          },
        ],
      };
    },
    async finish(admin, range) {
      const position = positionBase + BigInt(range.to - range.from);
      await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
        fixture.partition,
        position.toString(),
      ]);
    },
  };
}

function assertGrowthEvidence(report: GrowthReport): void {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.every(({ repetitions }) => repetitions.length === 1)).toBe(true);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBe(sample.cost.sharedHit + sample.cost.sharedRead);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(Object.keys(sample.cost.relations).length).toBeGreaterThan(0);
  }
  const relations = [
    ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations)))),
  ].sort();
  expect(relations.length).toBeGreaterThan(0);
  assertGrowthAccessPaths(report.name, report.samples, relations);
}

test('Registered Realm image publication stays within its Cost bounds across independent growth axes', async () => {
  const fixture = await growthRealmAssetPublicationFixture();
  const sourceBytes = new Uint8Array(
    await sharp({ create: { width: 96, height: 64, channels: 3, background: '#2c7891' } }).png().toBuffer(),
  );
  const sourceDigest = digest(sourceBytes);
  expect(sourceBytes.byteLength).toBeGreaterThan(0);
  expect(96 * 64).toBeLessThanOrEqual(sourcePixelsLimit);
  let fixedVariants: VariantShape[] | undefined;

  async function checkAxis(
    name: string,
    grow: (database: GrowthDatabase, scale: number, previous: number) => Promise<void>,
  ): Promise<void> {
    const report = await checkGrowth(fixture.native.db, {
      name,
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      rule: 'series',
      repetitions: 1,
      warmups: 1,
      async grow(database, scale, previous) {
        await grow(database, scale, previous);
        await drainSetupEvents(fixture);
      },
      async warmup(_database, scale) {
        const outcome = await publishThroughNativeRealm(
          fixture,
          sourceBytes,
          sourceDigest,
          `growth-realm-${name}-${scale}-warmup`,
        );
        if (fixedVariants) expect(variantShape(outcome)).toEqual(fixedVariants);
        else fixedVariants = variantShape(outcome);
        await drainSetupEvents(fixture);
      },
      async operation(_database, scale) {
        if (!fixedVariants) throw new Error('Growth warmup did not establish the selected output shape');
        const outcome = await publishThroughNativeRealm(
          fixture,
          sourceBytes,
          sourceDigest,
          `growth-realm-${name}-${scale}-selected`,
        );
        expect(variantShape(outcome)).toEqual(fixedVariants);
        return outcome;
      },
    });
    assertGrowthEvidence(report);
  }

  try {
    await checkAxis('Realm asset publication as unrelated media grows', async (database, scale, previous) => {
      await seed(
        { pool: database.pool, admin: database.admin },
        mediaPopulation(fixture, sourceDigest, sourceBytes.byteLength),
        { from: previous, to: scale },
      );
    });

    await checkAxis('Realm asset publication as retained image history grows', async (database, scale, previous) => {
      const result = await database.admin.query<{ position: string; epoch: number }>(
        'SELECT position::text,epoch FROM core.partition WHERE partition_no=$1',
        [fixture.partition],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Growth Realm partition is absent');
      await seed(
        { pool: database.pool, admin: database.admin },
        imageHistoryPopulation(fixture, previous, BigInt(row.position), row.epoch),
        { from: previous, to: scale },
      );
    });
  } finally {
    await fixture.close();
  }
}, 600_000);

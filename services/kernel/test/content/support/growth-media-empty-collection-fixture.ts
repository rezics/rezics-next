import { createHash } from 'node:crypto';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { seed, type GrowthDatabase } from '../../support/growth.ts';

export const EMPTY_COLLECTION_FRESH_AT = '2031-01-01T02:00:00.000Z';
export const EMPTY_COLLECTION_GROWTH_PREFIX = 'media-empty-collection-growth:';

export type EmptyCollectionAxis = 'same-route' | 'other-routes';

export type EmptyCollectionPopulationCounts = {
  readonly hot: number;
  readonly other: number;
  readonly total: number;
  readonly variants: number;
  readonly receipts: number;
  readonly events: number;
  readonly writeBasis: number;
  readonly eligible: number;
};

export function emptyCollectionPopulation(options: {
  readonly axis: EmptyCollectionAxis;
  readonly prefix: string;
  readonly partition: number;
  readonly hotRoute: number;
  readonly hotContainerId: string;
  readonly positionBase: bigint;
  readonly from: number;
  readonly epoch: number;
}) {
  return {
    name: `media-empty-collection-${options.axis}`,
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
        throw new Error('Empty collection history escaped its fixed partition');
      const mediaId = newId(route);
      const containerId = options.axis === 'same-route' ? options.hotContainerId : newId(route);
      const uploaderId = crypto.randomUUID();
      const transactionId = crypto.randomUUID();
      const reservationKey = `${options.prefix}${options.axis}:${ordinal}:${crypto.randomUUID()}`;
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
            created_at: EMPTY_COLLECTION_FRESH_AT,
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
          sha256: createHash('sha256').update(`${reservationKey}:${format}`).digest('hex'),
          key: `m/${mediaId}/${format}-320`,
          transaction_id: transactionId,
        })),
        'core.receipt': [
          {
            partition_no: options.partition,
            principal_id: uploaderId,
            command_kind: 'content.media.reserve',
            idempotency_key: reservationKey,
            request_digest: createHash('sha256').update(reservationKey).digest(),
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

export async function seedEmptyCollectionHistory(
  database: GrowthDatabase,
  options: {
    readonly axis: EmptyCollectionAxis;
    readonly prefix: string;
    readonly partition: number;
    readonly hotRoute: number;
    readonly hotContainerId: string;
    readonly scale: number;
    readonly previous: number;
  },
) {
  const current = await database.admin.query<{ epoch: number; position: string }>(
    'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
    [options.partition],
  );
  const row = current.rows[0];
  if (!row) throw new Error(`Empty collection partition ${options.partition} is not provisioned`);
  const population = emptyCollectionPopulation({
    ...options,
    positionBase: BigInt(row.position),
    from: options.previous,
    epoch: row.epoch,
  });
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: options.previous,
    to: options.scale,
  });
}

export async function emptyCollectionPopulationCounts(
  database: GrowthDatabase,
  options: {
    readonly prefix: string;
    readonly partition: number;
    readonly hotRoute: number;
    readonly hotContainerId: string;
    readonly eligibleBefore: string;
  },
): Promise<EmptyCollectionPopulationCounts> {
  const result = await database.admin.query<EmptyCollectionPopulationCounts>(
    `WITH media AS MATERIALIZED (
       SELECT route,media_id,container_id,transaction_id,created_at
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
            (SELECT count(*)::integer FROM media e
              WHERE e.route=$3 AND e.container_id=$4 AND e.created_at <= $5::timestamptz) AS eligible
       FROM media m`,
    [options.prefix, options.partition, options.hotRoute, options.hotContainerId, options.eligibleBefore],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Empty collection history query returned no row');
  return row;
}

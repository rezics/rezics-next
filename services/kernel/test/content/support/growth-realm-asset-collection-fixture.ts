import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import {
  MEDIA_NATIVE_GROWTH_BASE,
  composeNativeCollectionRuntime,
  imageWorkflowIds,
  uploadedEvent,
  type MediaObjectStore,
  type NativeCollectionRuntime,
} from '../media-native-collection-fixture.ts';
import type { ContentCredential, ContentSystem } from './system.ts';
import { seed, type GrowthDatabase } from '../../support/growth.ts';

export const REALM_COLLECTION_SCALES = [256, 1024, 4096] as const;
export const REALM_COLLECTION_BASE = MEDIA_NATIVE_GROWTH_BASE;
export const REALM_COLLECTION_CUT = '2031-01-02T00:00:00.000Z';
const REALM_COLLECTION_YOUNG = new Date(Date.parse(REALM_COLLECTION_BASE) + 2 * 60 * 60 * 1000).toISOString();
const VARIANT_DIGESTS = [
  createHash('sha256').update('realm-asset-collection-avif-320').digest('hex'),
  createHash('sha256').update('realm-asset-collection-webp-320').digest('hex'),
];

export type RealmAssetHome = Readonly<{
  id: string;
  route: number;
  partition: number;
  headRevisionId: string;
}>;

export type RealmAsset = Readonly<{
  id: string;
  purpose: 'realm-icon' | 'realm-banner';
  reservationKey: string;
  sourceBytes: Uint8Array;
  sourceDigest: string;
  image: {
    readonly mediaId: string;
    readonly state: 'available' | 'rejected' | 'already_terminal';
    readonly variants: readonly {
      readonly format: 'webp' | 'avif';
      readonly width: number;
      readonly height: number;
      readonly mediaType: string;
      readonly byteCount: number;
      readonly sha256: string;
      readonly key: string;
    }[];
  };
}>;

type HttpReply = Readonly<{ response: Response; body?: Record<string, unknown> }>;
type Credential = ContentCredential | null;

export async function nativeContentRequest(
  system: ContentSystem,
  actor: Credential,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  key?: string,
  ifMatch?: string,
): Promise<HttpReply> {
  const headers = new Headers();
  if (actor) headers.set('authorization', `Bearer ${actor.bearer}`);
  if (body) headers.set('content-type', 'application/json');
  if (key) headers.set('idempotency-key', JSON.stringify(key));
  if (ifMatch) headers.set('if-match', JSON.stringify(ifMatch));
  const { response } = await system.transport.capture(
    new Request(`https://content.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  return {
    response,
    ...(value && typeof value === 'object' && !Array.isArray(value)
      ? { body: value as Record<string, unknown> }
      : {}),
  };
}

export async function createRealmAssetHome(system: ContentSystem): Promise<RealmAssetHome> {
  await bootstrapRelease(system.database.pool, bundledRelease);
  const suffix = crypto.randomUUID();
  const spaceResponse = await nativeContentRequest(
    system,
    system.actors.author,
    'POST',
    '/v1/spaces',
    { title: `Realm asset collection ${suffix}` },
    `realm-asset-space-${suffix}`,
  );
  const space = spaceResponse.body?.space as { spaceId?: unknown } | undefined;
  if (spaceResponse.response.status !== 201 || typeof space?.spaceId !== 'string')
    throw new Error(`Native Realm collection Space setup failed (${spaceResponse.response.status})`);
  const realmResponse = await nativeContentRequest(
    system,
    system.actors.author,
    'POST',
    '/v1/realms',
    {
      spaceId: space.spaceId,
      title: `Realm asset collection ${suffix}`,
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
    `realm-asset-home-${suffix}`,
  );
  const realm = realmResponse.body?.realm as { realmId?: unknown; headRevisionId?: unknown } | undefined;
  if (
    realmResponse.response.status !== 201 ||
    typeof realm?.realmId !== 'string' ||
    typeof realm.headRevisionId !== 'string'
  )
    throw new Error(`Native Realm collection Realm setup failed (${realmResponse.response.status})`);
  const route = routeOf(realm.realmId);
  if (route === null) throw new Error('Native Realm collection Realm has no route');
  return { id: realm.realmId, route, partition: partitionOf(route), headRevisionId: realm.headRevisionId };
}

export async function createRealmAsset(
  system: ContentSystem,
  store: MediaObjectStore,
  runtime: Pick<NativeCollectionRuntime, 'client' | 'relayThrough'>,
  home: RealmAssetHome,
  purpose: RealmAsset['purpose'],
  label: string,
): Promise<RealmAsset> {
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 61, g: 138, b: 47 } },
  })
    .png()
    .toBuffer();
  const sourceDigest = createHash('sha256').update(bytes).digest('hex');
  const reservationKey = `realm-asset-${label}-${crypto.randomUUID()}`;
  const reservation = await nativeContentRequest(
    system,
    system.actors.author,
    'POST',
    `/v1/realms/${home.id}/media`,
    { purpose, mediaType: 'image/png', byteCount: bytes.byteLength, sha256: sourceDigest },
    reservationKey,
  );
  const media = reservation.body?.media as { id?: unknown; key?: unknown } | undefined;
  if (reservation.response.status !== 201 || typeof media?.id !== 'string' || media.key !== `m/${media.id}/original`)
    throw new Error(`Native Realm ${purpose} reservation failed (${reservation.response.status})`);
  const mediaId = media.id;
  if (routeOf(mediaId) !== home.route) throw new Error('Native Realm asset escaped its home route');

  await store.putOriginal(mediaId, bytes);
  const completion = await nativeContentRequest(
    system,
    system.actors.worker,
    'POST',
    `/v1/media/${mediaId}:complete`,
    {
      containerId: home.id,
      reservationRequestId: reservationKey,
      byteCount: bytes.byteLength,
      sha256: sourceDigest,
    },
    `${reservationKey}-complete`,
  );
  if (completion.response.status !== 200 || completion.body?.media === undefined)
    throw new Error(`Native Realm ${purpose} completion failed (${completion.response.status})`);

  const source = await uploadedEvent(system.database.pool, mediaId);
  const workflows = imageWorkflowIds(source);
  await runtime.relayThrough(source.partition, source.position);
  await runtime.client.retrieveWorkflow(workflows.effect).getResult();
  const image = (await runtime.client.retrieveWorkflow(workflows.image).getResult()) as RealmAsset['image'];
  if (image.mediaId !== mediaId || image.state !== 'available' || image.variants.length === 0)
    throw new Error('Registered image effect did not publish the native Realm asset');
  return { id: mediaId, purpose, reservationKey, sourceBytes: bytes, sourceDigest, image };
}

export async function setRealmPresentation(
  system: ContentSystem,
  home: RealmAssetHome,
  headRevisionId: string,
  iconMediaId: string | null,
  bannerMediaId: string | null,
  key: string,
) {
  const result = await nativeContentRequest(
    system,
    system.actors.author,
    'PATCH',
    `/v1/realms/${home.id}`,
    { presentation: { avatarMediaId: iconMediaId, bannerMediaId, rules: null } },
    key,
    headRevisionId,
  );
  const realm = result.body?.realm as { headRevisionId?: unknown } | undefined;
  if (result.response.status !== 200 || typeof realm?.headRevisionId !== 'string')
    throw new Error(`Native Realm presentation update failed (${result.response.status})`);
  return realm.headRevisionId;
}

export async function realmRevisionPresentation(
  database: GrowthDatabase,
  home: RealmAssetHome,
  revisionId: string,
): Promise<Record<string, unknown> | null> {
  const result = await database.admin.query<{ presentation: Record<string, unknown> }>(
    `SELECT presentation FROM community.realm_revision WHERE route=$1 AND realm_id=$2 AND revision_id=$3`,
    [home.route, home.id, revisionId],
  );
  return result.rows[0]?.presentation ?? null;
}

export async function seedRealmMediaPressure(
  database: GrowthDatabase,
  options: {
    readonly axis: 'same-home' | 'other-home';
    readonly partition: number;
    readonly hotRoute: number;
    readonly homeId: string;
    readonly uploaderId: string;
    readonly prefix: string;
    readonly from: number;
    readonly to: number;
  },
) {
  const population = {
    name: `realm-asset-collection-${options.axis}`,
    hotPartition: options.partition,
    hotShare: 1,
    rows({ ordinal }: { readonly ordinal: number }) {
      const hotOffset = options.hotRoute - options.partition * 16;
      const route =
        options.axis === 'same-home'
          ? options.hotRoute
          : options.partition * 16 + ((hotOffset + 1 + (ordinal % 15)) % 16);
      const mediaId = newId(route);
      const containerId = options.axis === 'same-home' ? options.homeId : newId(route);
      if (partitionOf(route) !== options.partition || routeOf(mediaId) !== route || routeOf(containerId) !== route)
        throw new Error('Realm collection pressure escaped its fixed partition');
      const transactionId = crypto.randomUUID();
      const reservationRequestId = `${options.prefix}:${options.axis}:${ordinal}:${crypto.randomUUID()}`;
      const digest = createHash('sha256').update(`${reservationRequestId}:source`).digest('hex');
      return {
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: containerId,
            uploader_id: options.uploaderId,
            reservation_request_id: reservationRequestId,
            purpose: 'realm-icon',
            media_type: 'image/png',
            byte_count: 512,
            declared_sha256: digest,
            actual_byte_count: 512,
            sha256: digest,
            state: 'available',
            decision: null,
            key: `m/${mediaId}/original`,
            created_at: REALM_COLLECTION_YOUNG,
            transaction_id: transactionId,
            claimed_at: null,
            claimed_realm_id: null,
          },
        ],
        'content.media_variant': ['avif', 'webp'].map((format, index) => ({
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
      };
    },
  };
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: options.from,
    to: options.to,
  });
}

type HistoryRecord = Readonly<{
  route: number;
  realmId: string;
  spaceId: string;
  spaceRevisionId: string;
  claimRevisionId: string;
  clearRevisionId: string;
  mediaId: string;
}>;

export async function seedRetainedClaimHistory(
  database: GrowthDatabase,
  options: {
    readonly partition: number;
    readonly route: number;
    readonly uploaderId: string;
    readonly prefix: string;
    readonly from: number;
    readonly to: number;
  },
) {
  const records = new Map<number, HistoryRecord>();
  const claims = {
    name: 'realm-asset-collection-retained-claim-history',
    hotPartition: options.partition,
    hotShare: 1,
    rows({ ordinal }: { readonly ordinal: number }) {
      const realmId = newId(options.route);
      let spaceId = newId(options.route);
      while (spaceId === realmId) spaceId = newId(options.route);
      const record: HistoryRecord = {
        route: options.route,
        realmId,
        spaceId,
        spaceRevisionId: newId(options.route),
        claimRevisionId: newId(options.route),
        clearRevisionId: newId(options.route),
        mediaId: newId(options.route),
      };
      records.set(ordinal, record);
      const transactionId = crypto.randomUUID();
      const reservationRequestId = `${options.prefix}:history:${ordinal}:${crypto.randomUUID()}`;
      const digest = createHash('sha256').update(`${reservationRequestId}:source`).digest('hex');
      return {
        'community.space': [
          {
            route: options.route,
            space_id: record.spaceId,
            state: 'active',
            head_revision_id: record.spaceRevisionId,
            created_at: REALM_COLLECTION_BASE,
            creator: options.uploaderId,
          },
        ],
        'community.space_revision': [
          {
            route: options.route,
            space_id: record.spaceId,
            revision_id: record.spaceRevisionId,
            predecessor: null,
            address: null,
            title: 'Retained claim history fixture',
            summary: '',
            created_at: REALM_COLLECTION_BASE,
            author: options.uploaderId,
          },
        ],
        'community.realm': [
          {
            route: options.route,
            realm_id: record.realmId,
            space_id: record.spaceId,
            state: 'active',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: record.claimRevisionId,
            created_at: REALM_COLLECTION_BASE,
            creator: options.uploaderId,
          },
        ],
        'community.realm_revision': [
          {
            route: options.route,
            realm_id: record.realmId,
            revision_id: record.claimRevisionId,
            predecessor: null,
            title: 'Retained claim history fixture',
            summary: '',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            created_at: REALM_COLLECTION_BASE,
            author: options.uploaderId,
            presentation: { avatarMediaId: record.mediaId, bannerMediaId: null, rules: null },
          },
        ],
        'content.media': [
          {
            route: options.route,
            media_id: record.mediaId,
            container_id: record.realmId,
            uploader_id: options.uploaderId,
            reservation_request_id: reservationRequestId,
            purpose: 'realm-icon',
            media_type: 'image/png',
            byte_count: 512,
            declared_sha256: digest,
            actual_byte_count: 512,
            sha256: digest,
            state: 'available',
            decision: null,
            key: `m/${record.mediaId}/original`,
            claimed_at: REALM_COLLECTION_BASE,
            created_at: REALM_COLLECTION_YOUNG,
            transaction_id: transactionId,
            claimed_realm_id: record.realmId,
          },
        ],
        'content.media_variant': ['avif', 'webp'].map((format, index) => ({
          route: options.route,
          media_id: record.mediaId,
          format,
          width: 320,
          height: 240,
          media_type: `image/${format}`,
          byte_count: 96 + index,
          sha256: VARIANT_DIGESTS[index],
          key: `m/${record.mediaId}/${format}-320`,
          transaction_id: transactionId,
        })),
      };
    },
  };
  await seed({ pool: database.pool, admin: database.admin }, claims, { from: options.from, to: options.to });

  const clearHistory = {
    name: 'realm-asset-collection-retained-settings-history',
    hotPartition: options.partition,
    hotShare: 1,
    rows({ ordinal }: { readonly ordinal: number }) {
      const record = records.get(ordinal);
      if (!record) throw new Error(`Missing synthetic Realm history row ${ordinal}`);
      return {
        'community.realm_revision': [
          {
            route: options.route,
            realm_id: record.realmId,
            revision_id: record.clearRevisionId,
            predecessor: record.claimRevisionId,
            title: 'Retained claim history fixture',
            summary: '',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            created_at: REALM_COLLECTION_BASE,
            author: options.uploaderId,
            presentation: { avatarMediaId: null, bannerMediaId: null, rules: null },
          },
        ],
      };
    },
  };
  await seed({ pool: database.pool, admin: database.admin }, clearHistory, {
    from: options.from,
    to: options.to,
  });
  if (records.size > 0) {
    await database.admin.query(
      `UPDATE community.realm AS realm
          SET head_revision_id = history.clear_revision_id
         FROM jsonb_to_recordset($1::jsonb) AS history(route integer, realm_id uuid, clear_revision_id uuid)
        WHERE realm.route = history.route AND realm.realm_id = history.realm_id`,
      [JSON.stringify(
        [...records.values()].map((record) => ({
          route: record.route,
          realm_id: record.realmId,
          clear_revision_id: record.clearRevisionId,
        })),
      )],
    );
  }
}

export async function clearRealmMediaPressure(database: GrowthDatabase, prefix: string) {
  await database.admin.query('DELETE FROM content.media WHERE reservation_request_id LIKE $1', [`${prefix}:%`]);
  await database.admin.query('VACUUM (ANALYZE) content.media');
}

export async function realmMediaSnapshot(database: GrowthDatabase, route: number, mediaId: string) {
  const result = await database.admin.query<{
    purpose: string;
    state: string;
    container_id: string;
    claimed_at: string | null;
    claimed_realm_id: string | null;
    collection_pending: boolean;
  }>(
    `SELECT purpose,state,container_id,claimed_at::text,claimed_realm_id,collection_pending
       FROM content.media WHERE route=$1 AND media_id=$2`,
    [route, mediaId],
  );
  return result.rows[0] ?? null;
}

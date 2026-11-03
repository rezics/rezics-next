import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createImageJob } from '../../../src/content/image-job.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { updateRealm, type RealmUpdate } from '../../../src/community/realm.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { type MediaRealmPerson, mediaRealmDownloadFixture } from '../media-realm-download-fixture.ts';
import { testAccess, testRouteKey } from '../../support/test-kernel.ts';
import { seed, type Population } from '../../support/growth.ts';

export const emptyRealmPresentation = {
  avatarMediaId: null,
  bannerMediaId: null,
  rules: null,
} as const;

export type RealmPresentationInput = Readonly<{
  avatarMediaId: string | null;
  bannerMediaId: string | null;
  rules: null;
}>;

export type GrowthRealm = Readonly<{
  realmId: string;
  headRevisionId: string;
  title: string;
  visibility: 'public' | 'protected';
  contextId: string;
  presentation: RealmPresentationInput;
  predecessor: string | null;
  author: string;
}>;

export type RealmPresentationAsset = Readonly<{
  id: string;
  realmId: string;
  purpose: 'realm-icon' | 'realm-banner';
  uploader: MediaRealmPerson;
  sha256: string;
  byteCount: number;
  published: boolean;
}>;

export async function growthRealmPresentationClaimFixture() {
  const base = await mediaRealmDownloadFixture();
  const auth = {
    ...base.auth.host.service.verifier,
    fetch: (url: string | URL, init?: RequestInit) => base.auth.host.service.handler(new Request(url, init)),
  };
  const access = testAccess({ pool: base.db.pool, actions: actionCatalogue(base.kernel), auth });
  const actor = await access.authenticate(base.governor.bearer, {
    pool: base.db.pool,
    deadline: Date.now() + 30_000,
  });
  if (actor.kind !== 'account') throw new Error('Realm claim fixture actor must be an account');
  const admittedScopes = [...actionCatalogue(base.kernel).keys()].filter((scope) => scope !== 'media:complete').sort();
  if ([...actor.scopes].sort().join('\n') !== admittedScopes.join('\n'))
    throw new Error('Realm claim fixture bearer did not retain its admitted API scopes');
  const routeKey = testRouteKey();
  const imageJob = createImageJob(base.db.pool, base.storage.storage);
  const bytes = Uint8Array.from(
    await sharp({ create: { width: 96, height: 48, channels: 3, background: '#215a87' } })
      .png()
      .toBuffer(),
  );
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  async function createRealm(label: string, visibility: 'public' | 'protected' = 'public'): Promise<GrowthRealm> {
    const host = await base.checked('POST', '/v1/spaces', {
      title: `${label} host`,
      summary: `${label} host`,
    });
    const created = await base.checked('POST', '/v1/realms', {
      spaceId: host.space.spaceId,
      title: label,
      summary: `${label} settings`,
      visibility,
      contextId: GLOBAL_CONTEXT,
    });
    return created.realm as GrowthRealm;
  }

  async function upload(
    realmId: string,
    purpose: RealmPresentationAsset['purpose'],
    uploader: MediaRealmPerson = base.governor,
    publish = true,
  ): Promise<RealmPresentationAsset> {
    const reservationKey = randomUUID();
    const created = await base.checked(
      'POST',
      `/v1/realms/${realmId}/media`,
      { purpose, mediaType: 'image/png', byteCount: bytes.length, sha256 },
      201,
      { bearer: uploader.bearer, key: reservationKey },
    );
    const mediaId = created.media.id as string;
    await base.storage.storage.put(`m/${mediaId}/original`, bytes, { mediaType: 'image/png' });
    await base.checked(
      'POST',
      `/v1/media/${mediaId}:complete`,
      {
        containerId: realmId,
        reservationRequestId: reservationKey,
        byteCount: bytes.length,
        sha256,
      },
      200,
      { bearer: uploader.websiteBearer },
    );
    if (publish) {
      const result = await imageJob.process(mediaId);
      if (result.state !== 'available') throw new Error(`Realm image job did not publish ${mediaId}`);
    }
    return { id: mediaId, realmId, purpose, uploader, sha256, byteCount: bytes.length, published: publish };
  }

  async function read(realmId: string, bearer = base.governor.bearer): Promise<GrowthRealm> {
    const result = await base.readRealm(realmId, bearer);
    if (result.response.status !== 200) throw new Error(`Realm read failed (${result.response.status})`);
    return result.value.realm as GrowthRealm;
  }

  function patch(
    realmId: string,
    expectedHead: string,
    presentation: RealmPresentationInput,
    key: string,
    bearer = base.governor.bearer,
  ) {
    return base.call('PATCH', `/v1/realms/${realmId}`, {
      bearer,
      key,
      headers: { 'if-match': JSON.stringify(expectedHead) },
      body: { presentation },
    });
  }

  async function update(
    realmId: string,
    input: Omit<RealmUpdate, 'realmId' | 'expectedHead'>,
    key = randomUUID(),
  ): Promise<string> {
    const current = await read(realmId);
    const result = await updateRealm(
      { pool: base.db.pool, access, routeKey },
      actor,
      { realmId, expectedHead: current.headRevisionId, ...input },
      { idempotencyKey: key, deadline: Date.now() + 30_000 },
    );
    return result.value.revisionId;
  }

  async function revisionCount(realmId: string): Promise<number> {
    const route = routeOf(realmId)!;
    const result = await base.db.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM community.realm_revision WHERE route=$1 AND realm_id=$2',
      [route, realmId],
    );
    return result.rows[0]!.count;
  }

  async function receiptCount(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const result = await base.db.admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM core.receipt
       WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
         AND command_kind='community.realm.update' AND idempotency_key=ANY($3::text[])`,
      [partitionOf(routeOf(base.governor.accountId)!), actor.accountId, [...keys]],
    );
    return result.rows[0]!.count;
  }

  async function mediaRows(ids: readonly string[]) {
    if (ids.length === 0) return [];
    const route = routeOf(ids[0]!);
    const result = await base.db.admin.query<{
      media_id: string;
      container_id: string;
      uploader_id: string;
      purpose: string;
      state: string;
      claimed_realm_id: string | null;
      claimed_at: string | null;
      variants: number;
    }>(
      `SELECT m.media_id::text, m.container_id::text, m.uploader_id::text, m.purpose, m.state,
              m.claimed_realm_id::text, m.claimed_at::text,
              (SELECT count(*)::integer FROM content.media_variant v
               WHERE v.route=m.route AND v.media_id=m.media_id) AS variants
       FROM content.media m WHERE m.route=$1 AND m.media_id=ANY($2::uuid[]) ORDER BY m.media_id`,
      [route, [...ids]],
    );
    return result.rows;
  }

  async function commandBinding(realmId: string, key: string, revisionId: string) {
    const route = routeOf(realmId)!;
    const result = await base.db.admin.query(
      `SELECT r.principal_kind, r.principal_id::text AS principal_id, r.command_kind, r.idempotency_key,
              b.client_id, b.requested_by,
              v.revision_id::text AS revision_id, v.predecessor::text, v.author::text,
              v.presentation->>'avatarMediaId' AS avatar_media_id,
              v.presentation->>'bannerMediaId' AS banner_media_id
       FROM core.receipt r
       JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
       JOIN community.realm_revision v ON v.route=$1 AND v.realm_id=$2 AND v.revision_id=$3
       WHERE r.partition_no=$4 AND r.principal_kind='account' AND r.principal_id=$5
         AND r.command_kind='community.realm.update' AND r.idempotency_key=$6`,
      [route, realmId, revisionId, partitionOf(route), actor.accountId, key],
    );
    return result.rows[0];
  }

  async function keyExists(key: string): Promise<boolean> {
    const result = await base.db.admin.query(
      `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
       AND principal_id=$2 AND command_kind='community.realm.update' AND idempotency_key=$3`,
      [partitionOf(routeOf(base.governor.accountId)!), actor.accountId, key],
    );
    return result.rowCount === 1;
  }

  async function unrelatedPopulation(name: string, targetRealmId: string): Promise<Population> {
    const route = routeOf(targetRealmId)!;
    const hotPartition = partitionOf(route);
    const positionResult = await base.db.admin.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no=$1',
      [hotPartition],
    );
    const positionBase = Number(positionResult.rows[0]!.position);
    return {
      name,
      hotPartition,
      hotShare: 1,
      rows({ route: placementRoute, ordinal }) {
        const spaceId = newId(placementRoute);
        const realmId = newId(placementRoute);
        const spaceRevisionId = newId(placementRoute);
        const realmRevisionId = newId(placementRoute);
        const mediaId = newId(placementRoute);
        const transactionId = randomUUID();
        const at = '2026-10-25T00:00:00.000Z';
        const position = positionBase + ordinal + 1;
        const response = { realmId, revisionId: realmRevisionId };
        return {
          'community.space': [
            {
              route: placementRoute,
              space_id: spaceId,
              state: 'active',
              head_revision_id: spaceRevisionId,
              created_at: at,
              creator: actor.accountId,
            },
          ],
          'community.space_revision': [
            {
              route: placementRoute,
              space_id: spaceId,
              revision_id: spaceRevisionId,
              predecessor: null,
              title: name,
              summary: '',
              created_at: at,
              author: actor.accountId,
            },
          ],
          'community.realm': [
            {
              route: placementRoute,
              realm_id: realmId,
              space_id: spaceId,
              state: 'active',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              head_revision_id: realmRevisionId,
              created_at: at,
              creator: actor.accountId,
            },
          ],
          'community.realm_revision': [
            {
              route: placementRoute,
              realm_id: realmId,
              revision_id: realmRevisionId,
              predecessor: null,
              title: name,
              summary: '',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              created_at: at,
              author: actor.accountId,
              presentation: emptyRealmPresentation,
            },
          ],
          'content.media': [
            {
              route: placementRoute,
              media_id: mediaId,
              container_id: realmId,
              uploader_id: actor.accountId,
              reservation_request_id: `${name}-${ordinal}`,
              purpose: 'realm-icon',
              media_type: 'image/png',
              byte_count: 10,
              actual_byte_count: 10,
              sha256: 'a'.repeat(64),
              state: 'available',
              key: `m/${mediaId}/original`,
              created_at: at,
              transaction_id: transactionId,
              claimed_at: null,
              claimed_realm_id: null,
              erased: false,
              collection_pending: false,
              taken_down: false,
            },
          ],
          'access.resource_initialization': [
            {
              route: placementRoute,
              resource_id: realmId,
              resource_type: 'community.realm',
              creator_id: actor.accountId,
              initialized_at: at,
            },
          ],
          'core.receipt': [
            {
              partition_no: hotPartition,
              principal_kind: 'account',
              principal_id: actor.accountId,
              command_kind: 'community.realm.create',
              idempotency_key: `${name}-${ordinal}`,
              request_digest: Buffer.alloc(32),
              epoch: 1,
              position,
              transaction_id: transactionId,
              response,
            },
          ],
          'core.outbox': [
            {
              partition_no: hotPartition,
              position,
              event_seq: 0,
              event_count: 1,
              epoch: 1,
              id: randomUUID(),
              type: 'com.rezics.community.realm.created.v1',
              subject: realmId,
              data: response,
            },
          ],
          'editorial.write_basis': [
            {
              partition_no: hotPartition,
              transaction_id: transactionId,
              epoch: 1,
              position,
              principal_kind: 'account',
              principal_id: actor.accountId,
              client_id: actor.clientId,
              requested_by: actor.requestedBy,
              recorded_at: at,
            },
          ],
          'access.resource_role_grant': [
            {
              route: placementRoute,
              resource_id: realmId,
              subject_kind: 'identity',
              subject_id: actor.accountId,
              grant_role: 'community.realm.owner',
              valid: '(,)',
              transaction_id: transactionId,
            },
          ],
        };
      },
      async finish(admin) {
        await admin.query(
          `UPDATE core.partition p SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1)
           WHERE p.partition_no=$1`,
          [hotPartition],
        );
      },
    };
  }

  async function populationCounts(name: string) {
    const result = await base.db.admin.query<{ realms: number; media: number }>(
      `SELECT (SELECT count(*)::integer FROM community.realm_revision WHERE title=$1) AS realms,
              (SELECT count(*)::integer FROM content.media WHERE reservation_request_id LIKE $2) AS media`,
      [name, `${name}-%`],
    );
    return result.rows[0]!;
  }

  async function appendHistory(realmId: string, prefix: string, from: number, to: number): Promise<string[]> {
    if (to <= from) return [];
    const route = routeOf(realmId)!;
    const hotPartition = partitionOf(route);
    const current = await read(realmId);
    const positionResult = await base.db.admin.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no=$1',
      [hotPartition],
    );
    const positionBase = Number(positionResult.rows[0]!.position);
    const entries = new Map<
      number,
      { revisionId: string; predecessor: string; transactionId: string; position: number; key: string }
    >();
    let predecessor = current.headRevisionId;
    for (let ordinal = from; ordinal < to; ordinal++) {
      const entry = {
        revisionId: newId(route),
        predecessor,
        transactionId: randomUUID(),
        position: positionBase + ordinal - from + 1,
        key: `${prefix}-${ordinal}`,
      };
      entries.set(ordinal, entry);
      predecessor = entry.revisionId;
    }
    const population: Population = {
      name: `${prefix}-${from}-${to}`,
      hotPartition,
      hotShare: 1,
      rows({ ordinal }) {
        const entry = entries.get(ordinal)!;
        const at = '2026-10-25T00:00:00.000Z';
        const response = { realmId, revisionId: entry.revisionId };
        return {
          'community.realm_revision': [
            {
              route,
              realm_id: realmId,
              revision_id: entry.revisionId,
              predecessor: entry.predecessor,
              title: current.title,
              summary: `retained ${ordinal}`,
              visibility: current.visibility,
              context_id: current.contextId,
              created_at: at,
              author: actor.accountId,
              presentation: emptyRealmPresentation,
            },
          ],
          'core.receipt': [
            {
              partition_no: hotPartition,
              principal_kind: 'account',
              principal_id: actor.accountId,
              command_kind: 'community.realm.update',
              idempotency_key: entry.key,
              request_digest: Buffer.alloc(32),
              epoch: 1,
              position: entry.position,
              transaction_id: entry.transactionId,
              response,
            },
          ],
          'core.outbox': [
            {
              partition_no: hotPartition,
              position: entry.position,
              event_seq: 0,
              event_count: 1,
              epoch: 1,
              id: randomUUID(),
              type: 'com.rezics.community.realm.updated.v1',
              subject: realmId,
              data: response,
            },
          ],
          'editorial.write_basis': [
            {
              partition_no: hotPartition,
              transaction_id: entry.transactionId,
              epoch: 1,
              position: entry.position,
              principal_kind: 'account',
              principal_id: actor.accountId,
              client_id: actor.clientId,
              requested_by: actor.requestedBy,
              recorded_at: at,
            },
          ],
        };
      },
      async finish(admin) {
        const last = entries.get(to - 1)!;
        await admin.query('UPDATE community.realm SET head_revision_id=$3 WHERE route=$1 AND realm_id=$2', [
          route,
          realmId,
          last.revisionId,
        ]);
        await admin.query(
          `UPDATE core.partition p SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1)
           WHERE p.partition_no=$1`,
          [hotPartition],
        );
      },
    };
    await seed({ pool: base.db.pool, admin: base.db.admin }, population, { from, to });
    return [...entries.values()].map((entry) => entry.key);
  }

  return {
    base,
    actor,
    admittedScopes,
    access,
    routeKey,
    bytes,
    sha256,
    createRealm,
    upload,
    read,
    patch,
    update,
    revisionCount,
    receiptCount,
    mediaRows,
    commandBinding,
    keyExists,
    unrelatedPopulation,
    populationCounts,
    appendHistory,
    async close() {
      await base.close();
    },
  };
}

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Population, Row } from '../../support/growth.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { mediaRealmDownloadFixture, type MediaRealmPerson } from '../media-realm-download-fixture.ts';

export const realmReservationScales = [256, 1024, 4096] as const;
export type RealmMediaPurpose = 'realm-icon' | 'realm-banner';

type PopulationFixture = Readonly<{
  readonly selectedRealmId: string;
  readonly manager: MediaRealmPerson;
}>;

function requiredRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new Error(`Expected a routable identifier: ${id}`);
  return route;
}

function baseRealmRows(route: number, ordinal: number, creatorId: string) {
  const spaceId = newId(route);
  const spaceRevisionId = newId(route);
  const realmId = newId(route);
  const realmRevisionId = newId(route);
  const transactionId = newId(route);
  return {
    spaceId,
    spaceRevisionId,
    realmId,
    realmRevisionId,
    transactionId,
    rows: {
      'community.space': [
        {
          route,
          space_id: spaceId,
          state: 'active',
          head_revision_id: spaceRevisionId,
          created_at: '2025-01-01T00:00:00.000Z',
          creator: creatorId,
        },
      ],
      'community.space_revision': [
        {
          route,
          space_id: spaceId,
          revision_id: spaceRevisionId,
          predecessor: null,
          title: `Unrelated Realm reservation space ${ordinal}`,
          summary: 'Realm media reservation growth fixture',
          created_at: '2025-01-01T00:00:00.000Z',
          author: creatorId,
        },
      ],
      'community.realm': [
        {
          route,
          realm_id: realmId,
          space_id: spaceId,
          state: 'active',
          visibility: 'protected',
          context_id: GLOBAL_CONTEXT,
          head_revision_id: realmRevisionId,
          created_at: '2025-01-01T00:00:00.000Z',
          creator: creatorId,
          board_scheme_id: null,
          votes: { upvote: 1, downvote: -1 },
        },
      ],
      'community.realm_revision': [
        {
          route,
          realm_id: realmId,
          revision_id: realmRevisionId,
          predecessor: null,
          title: `Unrelated Realm reservation history ${ordinal}`,
          summary: 'Realm media reservation growth fixture',
          visibility: 'protected',
          context_id: GLOBAL_CONTEXT,
          created_at: '2025-01-01T00:00:00.000Z',
          author: creatorId,
          board_scheme_id: null,
          votes: { upvote: 1, downvote: -1 },
        },
      ],
    } satisfies Readonly<Record<string, readonly Row[]>>,
  };
}

function receiptRow(
  partition: number,
  route: number,
  ordinal: number,
  key: string,
  response: unknown,
  principalId: string,
): Row {
  return {
    partition_no: partition,
    principal_kind: 'account',
    principal_id: principalId,
    command_kind: 'content.media.reserve',
    idempotency_key: key,
    request_digest: new Uint8Array(32).fill(ordinal % 256),
    epoch: 1,
    position: 0,
    transaction_id: newId(route),
    response,
  };
}

export function sameHomeRealmMediaPopulation(fixture: PopulationFixture, name: string): Population {
  const hotPartition = partitionOf(requiredRoute(fixture.selectedRealmId));
  return {
    name,
    hotPartition,
    hotShare: 1,
    rows({ ordinal, route, partition }) {
      const realm = baseRealmRows(route, ordinal, fixture.manager.accountId);
      const mediaId = newId(route);
      const requestId = `unrelated-${name}-${ordinal}`;
      const digest = 'a'.repeat(64);
      return {
        ...realm.rows,
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: realm.realmId,
            uploader_id: fixture.manager.accountId,
            reservation_request_id: requestId,
            purpose: ordinal % 2 === 0 ? 'realm-icon' : 'realm-banner',
            media_type: 'image/png',
            byte_count: 96,
            declared_sha256: digest,
            actual_byte_count: null,
            sha256: null,
            state: 'reserved',
            decision: null,
            key: `m/${mediaId}/original`,
            claimed_at: null,
            created_at: '2025-01-01T00:00:00.000Z',
            transaction_id: realm.transactionId,
            erased: false,
            collection_pending: false,
            taken_down: false,
            security_revision: 0,
          },
        ],
        'core.receipt': [receiptRow(partition, route, ordinal, requestId, { mediaId }, fixture.manager.accountId)],
      };
    },
  };
}

export function retainedRealmGrantCommandPopulation(fixture: PopulationFixture, name: string): Population {
  const hotPartition = partitionOf(requiredRoute(fixture.selectedRealmId));
  return {
    name,
    hotPartition,
    hotShare: 1,
    rows({ ordinal, route, partition }) {
      const realm = baseRealmRows(route, ordinal, fixture.manager.accountId);
      const requestId = `retained-${name}-${ordinal}`;
      return {
        ...realm.rows,
        'access.resource_grant': [
          {
            route,
            resource_id: realm.realmId,
            subject_id: fixture.manager.accountId,
            subject_role: '',
            action: 'realm:manage',
            valid: '[2020-01-01 00:00:00+00,2020-01-02 00:00:00+00)',
            transaction_id: realm.transactionId,
            subject_kind: 'identity',
          },
        ],
        'core.receipt': [
          receiptRow(partition, route, ordinal, requestId, { realmId: realm.realmId }, fixture.manager.accountId),
        ],
      };
    },
  };
}

export async function growthRealmMediaReservationFixture() {
  const native = await mediaRealmDownloadFixture();
  const selectedRealmId = native.protectedRealm.realmId;
  const manager = native.alice;
  const wrongPrincipal = native.bob;
  const bytes = Uint8Array.from(
    await sharp({ create: { width: 32, height: 24, channels: 3, background: '#354a62' } })
      .png()
      .toBuffer(),
  );
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await native.grant(manager.accountId, selectedRealmId, ['realm:manage']);

  return {
    db: native.db,
    native,
    selectedRealmId,
    manager,
    wrongPrincipal,
    bytes,
    sha256,
    byteCount: bytes.byteLength,
    async reserve(key: string, purpose: RealmMediaPurpose = 'realm-icon', bearer = manager.bearer) {
      return native.call('POST', `/v1/realms/${selectedRealmId}/media`, {
        bearer,
        key,
        body: { purpose, mediaType: 'image/png', byteCount: bytes.byteLength, sha256 },
      });
    },
    grant: native.grant,
    revoke: native.revoke,
    close: native.close,
  };
}

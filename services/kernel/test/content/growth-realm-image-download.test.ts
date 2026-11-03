import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readRealmPresentationImages } from '../../src/content/realm-media.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { assertGrowthAccessPaths, checkGrowth, seed, type Population } from '../support/growth.ts';
import { assertAbsentMetadata, normalizedProblem } from './media-realm-download-fixture.ts';
import {
  growthRealmImageDownloadFixture,
  type GrowthRealmImageDownloadFixture,
} from './support/growth-realm-image-download-fixture.ts';

const scales = [256, 1024, 4096] as const;
const relations = [
  'community.space',
  'community.realm',
  'community.realm_revision',
  'community.realm_ban',
  'access.resource_grant',
  'content.media',
  'content.media_variant',
] as const;
setDefaultTimeout(600_000);

let fixture: GrowthRealmImageDownloadFixture;

beforeAll(async () => {
  fixture = await growthRealmImageDownloadFixture();
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

function requiredRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new Error(`Expected a routable identifier: ${id}`);
  return route;
}

function mediaRow(route: number, realmId: string, uploaderId: string) {
  const mediaId = newId(route);
  const transactionId = newId(route);
  const reservationRequestId = newId(route);
  return {
    route,
    media_id: mediaId,
    container_id: realmId,
    uploader_id: uploaderId,
    reservation_request_id: reservationRequestId,
    purpose: 'realm-icon',
    media_type: 'image/png',
    byte_count: 1,
    declared_sha256: '0'.repeat(64),
    actual_byte_count: null,
    sha256: null,
    state: 'reserved',
    decision: null,
    key: `m/${mediaId}/original`,
    claimed_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    transaction_id: transactionId,
    erased: false,
    collection_pending: false,
    taken_down: false,
    security_revision: 0,
  };
}

function realmMediaPopulation(fixture: GrowthRealmImageDownloadFixture): Population {
  const hotPartition = partitionOf(fixture.route);
  return {
    name: 'unrelated-realm-media-population',
    hotPartition,
    hotShare: 1,
    rows({ ordinal, route }) {
      const spaceId = newId(route);
      const spaceRevisionId = newId(route);
      const realmId = newId(route);
      const realmRevisionId = newId(route);
      const transactionId = newId(route);
      const media = mediaRow(route, realmId, fixture.alice.accountId);
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: '2025-01-01T00:00:00.000Z',
            creator: fixture.governor.accountId,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: `Unrelated image growth Space ${ordinal}`,
            summary: 'Isolated Realm image download growth fixture',
            created_at: '2025-01-01T00:00:00.000Z',
            author: fixture.governor.accountId,
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
            creator: fixture.governor.accountId,
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
            title: `Unrelated protected Realm ${ordinal}`,
            summary: 'Isolated Realm image download growth fixture',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            created_at: '2025-01-01T00:00:00.000Z',
            author: fixture.governor.accountId,
            board_scheme_id: null,
            votes: { upvote: 1, downvote: -1 },
          },
        ],
        'content.media': [media],
      };
    },
  };
}

function expiredRange(ordinal: number): string {
  const start = new Date(Date.UTC(2000, 0, 1 + ordinal * 2)).toISOString();
  const end = new Date(Date.UTC(2000, 0, 2 + ordinal * 2)).toISOString();
  return `[${start},${end})`;
}

function retainedHistoryPopulation(fixture: GrowthRealmImageDownloadFixture): Population {
  const hotPartition = partitionOf(fixture.route);
  const lane = ((fixture.route & 0x0f) + 1) & 0x0f;
  const route = (hotPartition << 4) | lane;
  const spaceId = newId(route);
  const spaceRevisionId = newId(route);
  const realmId = newId(route);
  const realmRevisionId = newId(route);

  return {
    name: 'unrelated-retained-realm-media-history',
    hotPartition,
    hotShare: 1,
    rows({ ordinal }) {
      const revisionId = newId(route);
      const transactionId = newId(route);
      const media = mediaRow(route, realmId, fixture.alice.accountId);
      const revision = {
        route,
        realm_id: realmId,
        revision_id: revisionId,
        predecessor: null,
        title: `Detached retained Realm revision ${ordinal}`,
        summary: 'Unrelated retained settings history for growth measurement',
        visibility: 'protected',
        context_id: GLOBAL_CONTEXT,
        created_at: '2025-01-01T00:00:00.000Z',
        author: fixture.governor.accountId,
        board_scheme_id: null,
        votes: { upvote: 1, downvote: -1 },
      };
      return {
        ...(ordinal === 0
          ? {
              'community.space': [
                {
                  route,
                  space_id: spaceId,
                  state: 'active',
                  head_revision_id: spaceRevisionId,
                  created_at: '2025-01-01T00:00:00.000Z',
                  creator: fixture.governor.accountId,
                },
              ],
              'community.space_revision': [
                {
                  route,
                  space_id: spaceId,
                  revision_id: spaceRevisionId,
                  predecessor: null,
                  title: 'Unrelated retained-history Space',
                  summary: 'Isolated Realm image download growth fixture',
                  created_at: '2025-01-01T00:00:00.000Z',
                  author: fixture.governor.accountId,
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
                  creator: fixture.governor.accountId,
                  board_scheme_id: null,
                  votes: { upvote: 1, downvote: -1 },
                },
              ],
              'community.realm_revision': [
                {
                  ...revision,
                  revision_id: realmRevisionId,
                  title: 'Unrelated retained-history Realm head',
                },
                revision,
              ],
            }
          : { 'community.realm_revision': [revision] }),
        'community.realm_ban': [
          {
            route,
            realm_id: realmId,
            account_id: fixture.alice.accountId,
            valid: expiredRange(ordinal),
            reason: 'Expired unrelated Realm ban history',
            actor: fixture.governor.accountId,
            transaction_id: transactionId,
          },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: realmId,
            subject_id: fixture.alice.accountId,
            subject_role: '',
            action: 'realm:read',
            valid: expiredRange(ordinal),
            transaction_id: transactionId,
            subject_kind: 'identity',
          },
        ],
        'content.media': [media],
        'core.receipt': [
          {
            partition_no: hotPartition,
            principal_kind: 'account',
            principal_id: fixture.alice.accountId,
            command_kind: 'content.realm-image.unrelated-history',
            idempotency_key: `realm-image-history-${ordinal}`,
            request_digest: new Uint8Array(32).fill(ordinal % 256),
            epoch: 1,
            position: 0,
            transaction_id: newId(route),
            response: {},
          },
        ],
      };
    },
  };
}

function assertGrowthReport(
  name: string,
  report: Awaited<ReturnType<typeof checkGrowth>>,
  growsHistory: boolean,
): void {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
  expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
  expect(
    report.samples.every(({ cost }) => typeof cost.requestBytes === 'number' && typeof cost.responseBytes === 'number'),
  ).toBe(true);

  const observedRelations = growsHistory
    ? relations.filter((relation) => relation !== 'content.media_variant')
    : relations.filter((relation) => relation !== 'community.realm_ban' && relation !== 'access.resource_grant');
  for (const relation of observedRelations) {
    const rowCounts = report.samples.map(({ cost }) => cost.relations[relation]?.rows);
    expect(rowCounts.every((value) => typeof value === 'number')).toBe(true);
    expect(new Set(rowCounts).size).toBe(1);
  }

  const physicalRelations = growsHistory
    ? ['community.realm', 'community.realm_revision', 'community.realm_ban', 'access.resource_grant', 'content.media']
    : ['community.space', 'community.realm', 'community.realm_revision', 'content.media'];
  for (const relation of physicalRelations) {
    const pages = report.samples.at(-1)?.relationSizes[relation]?.relpages;
    if (typeof pages !== 'number') throw new Error(`${name}: missing post-grow page count for ${relation}`);
    expect(pages).toBeGreaterThan(8);
  }
  assertGrowthAccessPaths(name, report.samples, physicalRelations);

  console.info(
    `REALM_IMAGE_GROWTH ${JSON.stringify({
      axis: name,
      samples: report.samples.map(({ scale, cost, seeding }) => ({
        scale,
        statements: cost.statements,
        controlStatements: cost.controlStatements,
        catalogStatements: cost.catalogStatements,
        rows: cost.rows,
        blocks: cost.blocks,
        sharedHit: cost.sharedHit,
        sharedRead: cost.sharedRead,
        requestBytes: cost.requestBytes,
        responseBytes: cost.responseBytes,
        seeding,
      })),
    })}`,
  );
}

async function summary() {
  const actor = await fixture.kernel.testAccess.authenticate(fixture.alice.bearer, {
    pool: fixture.db.pool,
    deadline: Date.now() + 30_000,
  });
  return readRealmPresentationImages(
    { pool: fixture.db.pool, access: fixture.kernel.testAccess },
    { realmId: fixture.realmId, avatarMediaId: fixture.image.id, bannerMediaId: null },
    { actor, deadline: Date.now() + 30_000 },
  );
}

async function assertSelectedAnchor() {
  const selected = await fixture.db.admin.query<{
    space_id: string;
    realm_route: number;
    space_route: number;
    uploader_id: string;
    state: string;
    purpose: string;
    claimed_realm_id: string | null;
    claimed_at: string | null;
  }>(
    `SELECT r.space_id::text AS space_id, r.route AS realm_route, s.route AS space_route,
            m.uploader_id::text AS uploader_id, m.state, m.purpose,
            m.claimed_realm_id::text AS claimed_realm_id, m.claimed_at::text AS claimed_at
     FROM community.realm r
     JOIN community.space s ON s.route=r.route AND s.space_id=r.space_id
     JOIN content.media m ON m.route=r.route AND m.media_id=$3
     WHERE r.route=$1 AND r.realm_id=$2 AND r.state='active' AND s.state='active'`,
    [fixture.route, fixture.realmId, fixture.image.id],
  );
  expect(selected.rows).toHaveLength(1);
  expect(selected.rows[0]).toMatchObject({
    space_id: fixture.spaceId,
    realm_route: fixture.route,
    space_route: fixture.route,
    uploader_id: fixture.alice.accountId,
    state: 'available',
    purpose: 'realm-icon',
    claimed_realm_id: fixture.realmId,
  });
  expect(selected.rows[0]?.claimed_at).toBeString();
  return selected.rows[0]!;
}

test('native Realm image derivative download stays bounded across unrelated home population and retained history', async () => {
  expect(fixture.completionReplayValue).toEqual(fixture.completionValue);
  const upload = await fixture.storage.storage.get(`m/${fixture.image.id}/original`);
  expect(upload).toEqual(fixture.image.bytes);
  expect(upload).not.toBeNull();

  const derivative = await fixture.storage.storage.get(fixture.image.variant.key);
  expect(derivative).not.toBeNull();
  expect(derivative?.byteLength).toBe(fixture.image.variant.byteCount);
  expect(derivative && createHash('sha256').update(derivative).digest('hex')).toBe(fixture.image.variant.sha256);

  const current = await fixture.readRealm(fixture.realmId, fixture.alice.bearer);
  expect(current.response.status).toBe(200);
  const currentHeadRevisionId = current.value.realm.headRevisionId as string;
  const revisionsBeforeSelection = await fixture.db.admin.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM community.realm_revision WHERE route=$1 AND realm_id=$2',
    [fixture.route, fixture.realmId],
  );
  const selectionBody = {
    presentation: { avatarMediaId: fixture.image.id, bannerMediaId: null, rules: null },
  };
  const selectionKey = crypto.randomUUID();
  const selection = await fixture.checked('PATCH', `/v1/realms/${fixture.realmId}`, selectionBody, 200, {
    bearer: fixture.alice.bearer,
    key: selectionKey,
    headers: { 'if-match': JSON.stringify(currentHeadRevisionId) },
  });
  const replay = await fixture.checked('PATCH', `/v1/realms/${fixture.realmId}`, selectionBody, 200, {
    bearer: fixture.alice.bearer,
    key: selectionKey,
    headers: { 'if-match': JSON.stringify(currentHeadRevisionId) },
  });
  expect(replay).toEqual(selection);
  const revisionsAfterReplay = await fixture.db.admin.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM community.realm_revision WHERE route=$1 AND realm_id=$2',
    [fixture.route, fixture.realmId],
  );
  expect(revisionsAfterReplay.rows[0]?.count).toBe((revisionsBeforeSelection.rows[0]?.count ?? 0) + 1);

  const initialAnchor = await assertSelectedAnchor();
  const selectedSummary = await summary();
  expect(selectedSummary.avatar).toMatchObject({ state: 'available', value: { id: fixture.image.id } });

  const etag = `"${fixture.image.variant.sha256}"`;
  const conditionalHeaders = { 'if-none-match': etag };
  const unknownId = newId(requiredRoute(fixture.image.id));

  const operation = async () => {
    const allowed = await fixture.download(fixture.image.id, fixture.image.variantName, fixture.alice.bearer);
    expect(allowed.response.status).toBe(200);
    expect(allowed.value).toMatchObject({
      allowed: true,
      key: fixture.image.variant.key,
      sha256: fixture.image.variant.sha256,
      byteCount: fixture.image.variant.byteCount,
      publicCache: false,
    });
    expect(allowed.response.headers.get('cache-control')).toBe('private, no-store');

    const conditional = await fixture.download(
      fixture.image.id,
      fixture.image.variantName,
      fixture.alice.bearer,
      conditionalHeaders,
    );
    expect(conditional.response.status).toBe(200);
    expect(conditional.value).toMatchObject({
      allowed: true,
      key: fixture.image.variant.key,
      sha256: fixture.image.variant.sha256,
      byteCount: fixture.image.variant.byteCount,
      publicCache: false,
    });
    expect(conditional.response.headers.get('cache-control')).toBe('private, no-store');

    const original = await fixture.download(fixture.image.id, 'original', fixture.alice.bearer);
    const unknown = await fixture.download(
      unknownId,
      fixture.image.variantName,
      fixture.alice.bearer,
      conditionalHeaders,
    );
    expect(original.response.status).toBe(404);
    expect(unknown.response.status).toBe(404);
    assertAbsentMetadata(original.value, [
      fixture.image.sha256,
      fixture.image.variant.sha256,
      `m/${fixture.image.id}/`,
    ]);
    assertAbsentMetadata(unknown.value, [fixture.image.sha256, fixture.image.variant.sha256, `m/${fixture.image.id}/`]);
  };

  const populationReport = await checkGrowth(fixture.db, {
    name: 'Realm image derivative download with unrelated same-home Realm and media population',
    scales,
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: async (database, scale, previous) => {
      await seed(database, realmMediaPopulation(fixture), { from: previous, to: scale });
    },
    operation: async () => operation(),
  });
  assertGrowthReport('same-home Realm/media population', populationReport, false);
  expect(await assertSelectedAnchor()).toEqual(initialAnchor);

  const historyReport = await checkGrowth(fixture.db, {
    name: 'Realm image derivative download with independent retained grant, settings and media history',
    scales,
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: async (database, scale, previous) => {
      await seed(database, retainedHistoryPopulation(fixture), { from: previous, to: scale });
    },
    operation: async () => operation(),
  });
  assertGrowthReport('retained grant/settings/media history', historyReport, true);
  expect(await assertSelectedAnchor()).toEqual(initialAnchor);

  await fixture.revoke(fixture.realmId, fixture.alice.accountId, ['realm:read']);
  const retainedAuthority = await fixture.db.admin.query<{ uploader_id: string; manager_count: number }>(
    `SELECT m.uploader_id::text AS uploader_id,
            (SELECT count(*)::integer FROM access.resource_grant g
             WHERE g.route=$1 AND g.resource_id=$2 AND g.subject_id=$3 AND g.subject_role=''
               AND g.action='realm:manage' AND g.valid @> clock_timestamp()) AS manager_count
     FROM content.media m WHERE m.route=$1 AND m.media_id=$4`,
    [fixture.route, fixture.realmId, fixture.alice.accountId, fixture.image.id],
  );
  expect(retainedAuthority.rows).toEqual([{ uploader_id: fixture.alice.accountId, manager_count: 1 }]);
  expect((await summary()).avatar).toEqual({ state: 'none', value: null });

  const revoked = await fixture.download(
    fixture.image.id,
    fixture.image.variantName,
    fixture.alice.bearer,
    conditionalHeaders,
  );
  const unknownAfterRevoke = await fixture.download(
    unknownId,
    fixture.image.variantName,
    fixture.alice.bearer,
    conditionalHeaders,
  );
  expect(revoked.response.status).toBe(404);
  expect(unknownAfterRevoke.response.status).toBe(404);
  expect(normalizedProblem(revoked.value)).toEqual(normalizedProblem(unknownAfterRevoke.value));
  assertAbsentMetadata(revoked.value, [fixture.image.sha256, fixture.image.variant.sha256, `m/${fixture.image.id}/`]);

  await fixture.grant(fixture.alice.accountId, fixture.realmId, ['realm:read']);
  await fixture.checked('DELETE', `/v1/media/${fixture.image.id}`, undefined, 204, { bearer: fixture.alice.bearer });
  expect((await summary()).avatar).toEqual({ state: 'none', value: null });
  const erased = await fixture.download(
    fixture.image.id,
    fixture.image.variantName,
    fixture.alice.bearer,
    conditionalHeaders,
  );
  expect(erased.response.status).toBe(404);
  expect(normalizedProblem(erased.value)).toEqual(normalizedProblem(unknownAfterRevoke.value));

  const retainedClaim = await fixture.db.admin.query<{
    claimed_realm_id: string | null;
    claimed_at: string | null;
    erased: boolean;
  }>(
    `SELECT claimed_realm_id::text AS claimed_realm_id, claimed_at::text AS claimed_at, erased
     FROM content.media WHERE route=$1 AND media_id=$2`,
    [fixture.route, fixture.image.id],
  );
  expect(retainedClaim.rows).toEqual([
    { claimed_realm_id: fixture.realmId, claimed_at: initialAnchor.claimed_at, erased: true },
  ]);
}, 600_000);

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import partitionAnchor from '../../src/partition/read.sql';
import { assertGrowthAccessPaths, checkGrowth, seed, type Population } from '../support/growth.ts';
import { observeSql, type SqlBarrier } from './support/sql-observer.ts';
import {
  assertAbsentMetadata,
  mediaRealmDownloadFixture,
  normalizedProblem,
  type NativeImage,
} from './media-realm-download-fixture.ts';

const scales = [256, 1024, 4096] as const;
setDefaultTimeout(600_000);

let fixture: Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;

beforeAll(async () => {
  fixture = await mediaRealmDownloadFixture();
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

function requiredRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new Error(`Expected a routable identifier: ${id}`);
  return route;
}

function variant(image: NativeImage) {
  const selected = image.variants.find((entry) => entry.format === 'webp') ?? image.variants[0];
  if (!selected) throw new Error(`Native image ${image.id} produced no variants`);
  return { row: selected, name: `${selected.format}-${selected.width}` };
}

function historyPopulation(): Population {
  const hotPartition = partitionOf(requiredRoute(fixture.privateImage.id));
  return {
    name: 'native-realm-media-download-history',
    hotPartition,
    hotShare: 1,
    rows({ ordinal, route, partition }) {
      const spaceId = newId(route);
      const spaceRevisionId = newId(route);
      const realmId = newId(route);
      const realmRevisionId = newId(route);
      const containerId = newId(route);
      const mediaId = newId(route);
      const reservationRequestId = newId(route);
      const transactionId = newId(route);
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
            title: `Unrelated Realm history space ${ordinal}`,
            summary: 'Growth fixture history',
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
            title: `Unrelated protected Realm history ${ordinal}`,
            summary: 'Growth fixture history',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            created_at: '2025-01-01T00:00:00.000Z',
            author: fixture.governor.accountId,
            board_scheme_id: null,
            votes: { upvote: 1, downvote: -1 },
          },
        ],
        'community.realm_ban': [
          {
            route,
            realm_id: realmId,
            account_id: fixture.alice.accountId,
            valid: '(,)',
            reason: 'Unrelated current-ban history',
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
            valid: '(,)',
            transaction_id: transactionId,
            subject_kind: 'identity',
          },
        ],
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: containerId,
            uploader_id: fixture.alice.accountId,
            reservation_request_id: reservationRequestId,
            purpose: 'post-image',
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
          },
        ],
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: fixture.alice.accountId,
            command_kind: 'content.media.unrelated-history',
            idempotency_key: `media-realm-history-${ordinal}`,
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

test('a committed Realm read revocation after download preparation is caught at the final native Realm anchor', async () => {
  const image = fixture.privateImage;
  const availableVariant = variant(image);
  const trace = observeSql(fixture.db.pool);
  let barrier: SqlBarrier | undefined;
  let pending: ReturnType<typeof fixture.download> | undefined;
  let realmRevoked = false;
  try {
    const start = trace.records.length;
    const prepared = await fixture.download(image.id, availableVariant.name, fixture.alice.bearer);
    expect(prepared.response.status).toBe(200);
    const realmAnchors = trace.records
      .slice(start)
      .filter((execution) => execution.statement === partitionAnchor.sql).length;
    expect(realmAnchors).toBeGreaterThan(0);

    barrier = trace.hold({ statement: partitionAnchor.sql, occurrence: realmAnchors }, 'before');
    const inFlight = fixture.download(image.id, availableVariant.name, fixture.alice.bearer);
    pending = inFlight;
    const reached = await Promise.race([
      barrier.entered,
      inFlight.then(({ response }) => {
        throw new Error(`Download completed before final Realm anchor (${response.status})`);
      }),
    ]);
    expect(reached.statement).toBe(partitionAnchor.sql);

    await fixture.revoke(fixture.protectedRealm.realmId, fixture.alice.accountId, ['realm:read']);
    realmRevoked = true;
    barrier.release();
    const denied = await inFlight;
    const unknown = await fixture.download(newId(requiredRoute(image.id)), availableVariant.name, fixture.alice.bearer);
    expect(denied.response.status).toBe(404);
    expect(unknown.response.status).toBe(404);
    expect(normalizedProblem(denied.value)).toEqual(normalizedProblem(unknown.value));
    assertAbsentMetadata(denied.value, [image.sha256, availableVariant.row.sha256, `m/${image.id}/`]);

    await fixture.grant(fixture.alice.accountId, fixture.protectedRealm.realmId, ['realm:read']);
    realmRevoked = false;
    expect((await fixture.download(image.id, availableVariant.name, fixture.alice.bearer)).response.status).toBe(200);
  } finally {
    barrier?.release();
    if (pending) await pending.catch(() => undefined);
    if (realmRevoked) await fixture.grant(fixture.alice.accountId, fixture.protectedRealm.realmId, ['realm:read']);
    await trace.close();
  }
}, 600_000);

test('native Realm media download cost stays bounded with unrelated Realm, ban, grant, media and receipt history', async () => {
  const image = fixture.privateImage;
  const variantInfo = variant(image);
  const population = historyPopulation();
  const realmId = fixture.protectedRealm.realmId;
  await fixture.revoke(realmId, fixture.bob.accountId, ['realm:read']);
  const retained = await fixture.db.admin.query(
    `SELECT resource_id::text AS resource_id, action FROM access.resource_grant
     WHERE (resource_id=$1 OR resource_id=$2) AND subject_id=$3 AND subject_role=''
       AND action IN ('board:read','media:read') AND valid @> clock_timestamp()`,
    [fixture.protectedRealm.boardId, image.id, fixture.bob.accountId],
  );
  expect(retained.rows).toHaveLength(2);
  const report = await checkGrowth(fixture.db, {
    name: 'Native Realm media download cost stays bounded with unrelated Realm, ban, grant, media and receipt history',
    scales,
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
    },
    async operation() {
      const original = await fixture.download(image.id, 'original', fixture.alice.bearer);
      expect(original.response.status).toBe(200);
      expect(original.value).toMatchObject({
        allowed: true,
        key: `m/${image.id}/original`,
        sha256: image.sha256,
        byteCount: image.bytes.byteLength,
      });

      const allowedVariant = await fixture.download(image.id, variantInfo.name, fixture.alice.bearer);
      expect(allowedVariant.response.status).toBe(200);
      expect(allowedVariant.value).toMatchObject({
        allowed: true,
        key: variantInfo.row.key,
        sha256: variantInfo.row.sha256,
        byteCount: variantInfo.row.byteCount,
      });

      const unknown = await fixture.download(newId(requiredRoute(image.id)), variantInfo.name, fixture.bob.bearer);
      const refused = await fixture.download(image.id, variantInfo.name, fixture.bob.bearer);
      expect(unknown.response.status).toBe(404);
      expect(refused.response.status).toBe(404);
      expect(normalizedProblem(refused.value)).toEqual(normalizedProblem(unknown.value));
      assertAbsentMetadata(refused.value, [image.sha256, variantInfo.row.sha256, `m/${image.id}/`]);
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(new Set(report.samples.map(({ cost }) => cost.controlStatements)).size).toBe(1);
  expect(new Set(report.samples.map(({ cost }) => cost.catalogStatements)).size).toBe(1);
  for (const relation of [
    'community.realm',
    'community.realm_revision',
    'community.realm_ban',
    'access.resource_grant',
    'content.media',
  ]) {
    const rows = report.samples.map((sample) => sample.cost.relations[relation]?.rows);
    expect(rows.every((value) => typeof value === 'number')).toBe(true);
    expect(new Set(rows).size).toBe(1);
  }
  for (const relation of [
    'community.realm',
    'community.realm_revision',
    'community.realm_ban',
    'access.resource_grant',
    'content.media',
  ]) {
    const pages = report.samples.at(-1)?.relationSizes[relation]?.relpages;
    if (typeof pages !== 'number') throw new Error(`Missing post-grow page count for ${relation}`);
    expect(pages).toBeGreaterThan(8);
  }
  assertGrowthAccessPaths('Native Realm media download stays within its bound with same-home history', report.samples, [
    'community.realm',
    'community.realm_revision',
    'community.realm_ban',
    'access.resource_grant',
    'content.media',
  ]);
  await fixture.grant(fixture.bob.accountId, realmId, ['realm:read']);
}, 600_000);

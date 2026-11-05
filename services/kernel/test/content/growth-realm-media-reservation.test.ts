import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, seed, type GrowthReport } from '../support/growth.ts';
import {
  growthRealmMediaReservationFixture,
  realmReservationScales,
  retainedRealmGrantCommandPopulation,
  sameHomeRealmMediaPopulation,
  type RealmMediaPurpose,
} from './support/growth-realm-media-reservation-fixture.ts';

setDefaultTimeout(600_000);

let fixture: Awaited<ReturnType<typeof growthRealmMediaReservationFixture>>;

beforeAll(async () => {
  fixture = await growthRealmMediaReservationFixture();
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

const indexedRelations = [
  'community.realm',
  'community.realm_revision',
  'access.resource_grant',
  'content.media',
  'core.receipt',
  'core.outbox',
] as const;

type GrowthEvidence = Readonly<{ axis: string; operation: string; report: GrowthReport }>;
const evidence: GrowthEvidence[] = [];

async function growAndMeasure(
  axis: string,
  operationName: string,
  population: Parameters<typeof seed>[1],
  operation: () => Promise<void>,
): Promise<GrowthReport> {
  const name = `Realm media reservation ${axis} ${operationName}`;
  const report = await checkGrowth(fixture.db, {
    name,
    scales: realmReservationScales,
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
    },
    async operation() {
      await operation();
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...realmReservationScales]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(typeof sample.cost.requestBytes).toBe('number');
    expect(typeof sample.cost.responseBytes).toBe('number');
    expect(sample.cost.relations).not.toHaveProperty('content.account_image');
    expect(sample.cost.relations).not.toHaveProperty('content.revision');
  }
  assertGrowthAccessPaths(name, report.samples, indexedRelations);
  evidence.push({ axis, operation: operationName, report });
  return report;
}

function assertGrownRelations(report: GrowthReport, names: readonly string[]) {
  const largest = report.samples.at(-1);
  if (!largest) throw new Error('Realm reservation growth report has no largest sample');
  for (const relation of names) {
    const pages = largest.relationSizes[relation]?.relpages;
    if (typeof pages !== 'number') throw new Error(`Missing post-grow page count for ${relation}`);
    expect(pages).toBeGreaterThan(8);
  }
}

function assertReservationResponse(result: Awaited<ReturnType<typeof fixture.reserve>>, key: string) {
  expect(result.response.status).toBe(201);
  const mediaId = result.value.media?.id;
  expect(mediaId).toBeString();
  expect(routeOf(mediaId)).toBe(routeOf(fixture.selectedRealmId));
  expect(result.value).toEqual({
    media: {
      id: mediaId,
      state: 'reserved',
      byteCount: fixture.byteCount,
      mediaType: 'image/png',
      sha256: null,
      containerId: fixture.selectedRealmId,
      uploaderId: fixture.manager.accountId,
      key: `m/${mediaId}/original`,
      reservationRequestId: key,
    },
  });
  expect(result.response.headers.get('location')).toBe(`/v1/media/${mediaId}`);
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
}

async function assertCommittedReservation(
  key: string,
  result: Awaited<ReturnType<typeof fixture.reserve>>,
  purpose: RealmMediaPurpose,
) {
  assertReservationResponse(result, key);
  const mediaId = result.value.media.id as string;
  const route = routeOf(mediaId);
  if (route === null) throw new Error(`Invalid reserved Realm media identifier ${mediaId}`);
  const media = await fixture.db.admin.query<{
    container_id: string;
    uploader_id: string;
    reservation_request_id: string;
    purpose: RealmMediaPurpose;
    media_type: string;
    byte_count: number;
    declared_sha256: string | null;
    state: string;
    transaction_id: string;
  }>(
    `SELECT container_id::text, uploader_id::text, reservation_request_id, purpose, media_type,
            byte_count::integer AS byte_count, declared_sha256, state, transaction_id::text
       FROM content.media WHERE route=$1 AND media_id=$2`,
    [route, mediaId],
  );
  expect(media.rows).toEqual([
    {
      container_id: fixture.selectedRealmId,
      uploader_id: fixture.manager.accountId,
      reservation_request_id: key,
      purpose,
      media_type: 'image/png',
      byte_count: fixture.byteCount,
      declared_sha256: fixture.sha256,
      state: 'reserved',
      transaction_id: expect.any(String),
    },
  ]);

  const receipt = await fixture.db.admin.query<{
    position: string;
    transaction_id: string;
    response: { mediaId: string };
  }>(
    `SELECT position::text, transaction_id::text, response
       FROM core.receipt
      WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
        AND command_kind='content.media.reserve' AND idempotency_key=$3`,
    [partitionOf(route), fixture.manager.accountId, key],
  );
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.rows[0]).toMatchObject({ response: { mediaId } });
  expect(receipt.rows[0]?.transaction_id).toBe(media.rows[0]?.transaction_id);

  const events = await fixture.db.admin.query<{
    type: string;
    subject: string | null;
    data: { mediaId: string; containerId: string; actorId: string };
  }>(
    `SELECT type, subject, data FROM core.outbox
      WHERE partition_no=$1 AND position=$2::bigint ORDER BY event_seq`,
    [partitionOf(route), receipt.rows[0]!.position],
  );
  expect(events.rows).toEqual([
    {
      type: 'com.rezics.content.media.reserved.v1',
      subject: mediaId,
      data: { mediaId, containerId: fixture.selectedRealmId, actorId: fixture.manager.accountId },
    },
  ]);
  return result;
}

function denied(result: Awaited<ReturnType<typeof fixture.reserve>>, privateValues: readonly string[]) {
  expect(result.response.status).toBe(403);
  const serialized = JSON.stringify(result.value);
  for (const value of privateValues) expect(serialized).not.toContain(value);
}

function reportRows() {
  return evidence.map(({ axis, operation, report }) => ({
    axis,
    operation,
    samples: report.samples.map(({ scale, cost, seeding }) => ({
      scale,
      statements: cost.statements,
      rows: cost.rows,
      buffers: cost.blocks,
      sharedHit: cost.sharedHit,
      sharedRead: cost.sharedRead,
      controlStatements: cost.controlStatements,
      catalogStatements: cost.catalogStatements,
      plans: cost.plans,
      requestBytes: cost.requestBytes,
      responseBytes: cost.responseBytes,
      backgroundStatements: cost.backgroundStatements,
      backgroundRows: cost.backgroundRows,
      seeding,
      relations: Object.fromEntries(
        indexedRelations.map((name) => {
          const relation = cost.relations[name];
          return [
            name,
            relation
              ? { rows: relation.rows, blocks: relation.blocks, sequentialScans: relation.sequentialScans }
              : null,
          ];
        }),
      ),
    })),
  }));
}

test('Realm asset reservation admission stays bounded across unrelated Realm and retained history', async () => {
  expect(fixture.wrongPrincipal.accountId).not.toBe(fixture.manager.accountId);
  const sameHome = () => sameHomeRealmMediaPopulation(fixture, `same-home-${crypto.randomUUID()}`);
  const history = () => retainedRealmGrantCommandPopulation(fixture, `retained-history-${crypto.randomUUID()}`);
  const iconKey = crypto.randomUUID();

  const admission = await growAndMeasure('same-home Realm/media/receipt', 'fresh admission', sameHome(), async () => {
    const key = crypto.randomUUID();
    assertReservationResponse(await fixture.reserve(key, 'realm-icon'), key);
  });
  assertGrownRelations(admission, ['community.realm', 'community.realm_revision', 'content.media', 'core.receipt']);

  const selected = await assertCommittedReservation(
    iconKey,
    await fixture.reserve(iconKey, 'realm-icon'),
    'realm-icon',
  );
  const bannerKey = crypto.randomUUID();
  await assertCommittedReservation(bannerKey, await fixture.reserve(bannerKey, 'realm-banner'), 'realm-banner');

  await fixture.revoke(fixture.selectedRealmId, fixture.manager.accountId, ['realm:manage']);
  expect((await fixture.native.readRealm(fixture.selectedRealmId, fixture.manager.bearer)).response.status).toBe(200);
  expect((await fixture.native.readRealm(fixture.selectedRealmId, fixture.wrongPrincipal.bearer)).response.status).toBe(
    200,
  );
  const deniedSameHome = await growAndMeasure(
    'same-home Realm/media/receipt',
    'refused replay and wrong principal',
    sameHome(),
    async () => {
      denied(await fixture.reserve(iconKey, 'realm-icon'), [fixture.sha256, selected.value.media.id]);
      denied(await fixture.reserve(crypto.randomUUID(), 'realm-banner', fixture.wrongPrincipal.bearer), [
        fixture.sha256,
        selected.value.media.id,
      ]);
    },
  );
  assertGrownRelations(deniedSameHome, [
    'community.realm',
    'community.realm_revision',
    'content.media',
    'core.receipt',
  ]);

  await fixture.grant(fixture.manager.accountId, fixture.selectedRealmId, ['realm:manage']);
  const replaySameHome = await growAndMeasure(
    'same-home Realm/media/receipt',
    'receipt replay',
    sameHome(),
    async () => {
      const replay = await fixture.reserve(iconKey, 'realm-icon');
      expect(replay.response.status).toBe(201);
      expect(replay.value).toEqual(selected.value);
    },
  );
  assertGrownRelations(replaySameHome, [
    'community.realm',
    'community.realm_revision',
    'content.media',
    'core.receipt',
  ]);
  await assertCommittedReservation(iconKey, await fixture.reserve(iconKey, 'realm-icon'), 'realm-icon');

  const historyAdmission = await growAndMeasure(
    'retained Realm/grant/command history',
    'fresh admission',
    history(),
    async () => {
      const key = crypto.randomUUID();
      assertReservationResponse(await fixture.reserve(key, 'realm-icon'), key);
    },
  );
  assertGrownRelations(historyAdmission, [
    'community.realm',
    'community.realm_revision',
    'access.resource_grant',
    'core.receipt',
  ]);

  await fixture.revoke(fixture.selectedRealmId, fixture.manager.accountId, ['realm:manage']);
  expect((await fixture.native.readRealm(fixture.selectedRealmId, fixture.manager.bearer)).response.status).toBe(200);
  const deniedHistory = await growAndMeasure(
    'retained Realm/grant/command history',
    'refused replay and wrong principal',
    history(),
    async () => {
      denied(await fixture.reserve(iconKey, 'realm-icon'), [fixture.sha256, selected.value.media.id]);
      denied(await fixture.reserve(crypto.randomUUID(), 'realm-banner', fixture.wrongPrincipal.bearer), [
        fixture.sha256,
        selected.value.media.id,
      ]);
    },
  );
  assertGrownRelations(deniedHistory, [
    'community.realm',
    'community.realm_revision',
    'access.resource_grant',
    'core.receipt',
  ]);

  await fixture.grant(fixture.manager.accountId, fixture.selectedRealmId, ['realm:manage']);
  const replayHistory = await growAndMeasure(
    'retained Realm/grant/command history',
    'receipt replay',
    history(),
    async () => {
      const replay = await fixture.reserve(iconKey, 'realm-icon');
      expect(replay.response.status).toBe(201);
      expect(replay.value).toEqual(selected.value);
    },
  );
  assertGrownRelations(replayHistory, [
    'community.realm',
    'community.realm_revision',
    'access.resource_grant',
    'core.receipt',
  ]);
  await assertCommittedReservation(iconKey, await fixture.reserve(iconKey, 'realm-icon'), 'realm-icon');

  process.stdout.write(`REALM_MEDIA_RESERVATION_GROWTH ${JSON.stringify(reportRows())}\n`);
});

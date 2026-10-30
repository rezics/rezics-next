import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import {
  addressInPartition,
  addressRoute,
  createSpaceAddressRecoveryFixture,
  spaceCreateKeyInPartition,
  type RecoveryActor,
  type RecoverySpace,
  type SpaceAddressRecoveryFixture,
} from './space-address-recovery-fixture.ts';

// The owner growth test already covers claim/change/resolve. This check adds the joined replay and conflict outcomes
// while unrelated address claims, revisions and receipts grow at both the total and measured hot anchor.

const scales = [256, 1024, 4096] as const;
const hotPartition = 173;

type GrowthProbes = Readonly<{
  claim: RecoverySpace;
  claimAddress: string;
  claimKey: string;
  change: RecoverySpace;
  changeStart: string;
  changeTarget: string;
  conflict: RecoverySpace;
  occupiedAddress: string;
}>;

let fixture: SpaceAddressRecoveryFixture;
let growth: GrowthDatabase;
let governance: RecoveryActor;
let actor: RecoveryActor;

function hashRoute(value: string): number {
  return createHash('sha256').update(value).digest().readUInt16BE(0);
}

async function population(positionBase: number): Promise<Population> {
  const name = `space-address-recovery-growth-${randomUUID()}`;
  return {
    name,
    hotPartition,
    hotShare: 0.5,
    rows({ route, partition, ordinal }) {
      const spaceId = newId(route);
      const revisionId = newId(route);
      const address =
        partition === hotPartition
          ? addressInPartition(`unrelated-${ordinal.toString(36)}`, hotPartition)
          : `unrelated-${ordinal.toString(36)}-${randomUUID().slice(0, 8)}`;
      const handle = `unrelated-handle-${ordinal.toString(36)}-${randomUUID().slice(0, 8)}`;
      const at = fixture.now.toISOString();
      const transactionId = spaceId;
      const position = positionBase + ordinal * 100 + 1;
      const value = { spaceId, revisionId };
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: revisionId,
            created_at: at,
            creator: actor.accountId,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: revisionId,
            predecessor: null,
            address,
            title: 'Unrelated growth Space',
            summary: '',
            created_at: at,
            author: actor.accountId,
          },
        ],
        'community.space_address_claim': [
          {
            route: hashRoute(address),
            normalized_address: address,
            space_id: spaceId,
            state: 'active',
            expires_at: null,
            reserved_until: null,
            transaction_id: transactionId,
          },
        ],
        'access.resource_initialization': [
          {
            route,
            resource_id: spaceId,
            resource_type: 'community.space',
            creator_id: actor.accountId,
            initialized_at: at,
          },
        ],
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            command_kind: 'community.space.address',
            idempotency_key: `seed-space-address-recovery-${ordinal}`,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position,
            transaction_id: transactionId,
            response: value,
          },
        ],
        'core.outbox': [
          {
            partition_no: partition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: 'com.rezics.community.space.created.v1',
            subject: spaceId,
            data: value,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partition,
            transaction_id: transactionId,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: actor.accountId,
            client_id: 'space-address-recovery-client',
            requested_by: null,
            recorded_at: at,
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: spaceId,
            subject_kind: 'identity',
            subject_id: actor.accountId,
            grant_role: 'community.space.owner',
            valid: '(,)',
            transaction_id: transactionId,
          },
          {
            route,
            resource_id: spaceId,
            subject_kind: 'active_accounts',
            subject_id: '00000000-0000-0000-0000-000000000000',
            grant_role: 'community.space.standing',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'access.handle_claim': [
          {
            route: hashRoute(handle),
            normalized_handle: handle,
            account_id: actor.accountId,
            state: 'active',
            expires_at: null,
            reserved_until: null,
            transaction_id: transactionId,
          },
        ],
      };
    },
    async finish(admin, range) {
      const partitions = [
        ...new Set(
          Array.from({ length: range.to - range.from }, (_, index) => {
            const ordinal = range.from + index;
            const hash = createHash('sha256').update(`${name}\n${ordinal}`).digest().readUInt32BE(0);
            const hot = Math.floor((ordinal + 1) * 0.5) > Math.floor(ordinal * 0.5);
            if (hot) return hotPartition;
            let route = hash % 65_536;
            while (route >>> 4 === hotPartition) route = (route + 16) % 65_536;
            return partitionOf(route);
          }),
        ),
      ];
      if (partitions.length === 0) return;
      await admin.query(
        `UPDATE core.partition p
         SET position = GREATEST(p.position, COALESCE((
           SELECT max(o.position) FROM core.outbox o WHERE o.partition_no=p.partition_no
         ), p.position))
         WHERE p.partition_no = ANY($1::integer[])`,
        [partitions],
      );
    },
  };
}

async function makeSpace(title: string): Promise<RecoverySpace> {
  const key = spaceCreateKeyInPartition(actor, hotPartition);
  const space = await fixture.createSpace(actor, title, key);
  expect(partitionOf(routeOf(space.spaceId)!)).toBe(hotPartition);
  return space;
}

async function buildProbes(scale: number, label: string): Promise<GrowthProbes> {
  const claim = await makeSpace(`Claim ${label} ${scale}`);
  const claimAddress = addressInPartition(`claim-${label}-${scale}-${randomUUID().slice(0, 8)}`, hotPartition);
  const claimKey = randomUUID();

  const change = await makeSpace(`Change ${label} ${scale}`);
  const changeStart = addressInPartition(`change-start-${label}-${scale}-${randomUUID().slice(0, 8)}`, hotPartition);
  const changeClaim = await fixture.request('PUT', `/v1/spaces/${change.spaceId}/address`, {
    bearer: actor.bearer,
    key: randomUUID(),
    ifMatch: change.etag,
    body: { address: changeStart },
  });
  if (changeClaim.response.status !== 200)
    throw new Error(`Could not prepare a changed-address probe: ${changeClaim.response.status}`);
  const changedSpace = changeClaim.value.space as Record<string, unknown>;
  const changeTarget = addressInPartition(`change-target-${label}-${scale}-${randomUUID().slice(0, 8)}`, hotPartition);

  const occupied = await makeSpace(`Occupied ${label} ${scale}`);
  const occupiedAddress = addressInPartition(`occupied-${label}-${scale}-${randomUUID().slice(0, 8)}`, hotPartition);
  const occupiedClaim = await fixture.request('PUT', `/v1/spaces/${occupied.spaceId}/address`, {
    bearer: actor.bearer,
    key: randomUUID(),
    ifMatch: occupied.etag,
    body: { address: occupiedAddress },
  });
  if (occupiedClaim.response.status !== 200)
    throw new Error(`Could not prepare an occupied-address probe: ${occupiedClaim.response.status}`);

  const conflict = await makeSpace(`Conflict ${label} ${scale}`);
  return {
    claim,
    claimAddress,
    claimKey,
    change: {
      ...change,
      etag: changeClaim.response.headers.get('etag')!,
      headRevisionId: String(changedSpace.headRevisionId),
      address: changeStart,
      raw: changedSpace,
    },
    changeStart,
    changeTarget,
    conflict,
    occupiedAddress,
  };
}

async function exercise(probes: GrowthProbes) {
  const claimed = await fixture.request('PUT', `/v1/spaces/${probes.claim.spaceId}/address`, {
    bearer: actor.bearer,
    key: probes.claimKey,
    ifMatch: probes.claim.etag,
    body: { address: probes.claimAddress },
  });
  expect(claimed.response.status).toBe(200);
  const claimedBody = claimed.value.space as Record<string, unknown>;
  expect(claimedBody).toMatchObject({ spaceId: probes.claim.spaceId, address: probes.claimAddress });

  const replay = await fixture.request('PUT', `/v1/spaces/${probes.claim.spaceId}/address`, {
    bearer: actor.bearer,
    key: probes.claimKey,
    ifMatch: probes.claim.etag,
    body: { address: probes.claimAddress },
  });
  expect(replay.response.status).toBe(200);
  expect((replay.value.space as Record<string, unknown>).headRevisionId).toBe(claimedBody.headRevisionId);

  const conflict = await fixture.request('PUT', `/v1/spaces/${probes.conflict.spaceId}/address`, {
    bearer: actor.bearer,
    key: randomUUID(),
    ifMatch: probes.conflict.etag,
    body: { address: probes.occupiedAddress },
  });
  expect(conflict.response.status).toBe(409);
  expect(conflict.value.code).toBe('conflict');

  const changed = await fixture.request('PUT', `/v1/spaces/${probes.change.spaceId}/address`, {
    bearer: actor.bearer,
    key: randomUUID(),
    ifMatch: probes.change.etag,
    body: { address: probes.changeTarget },
  });
  expect(changed.response.status).toBe(200);
  expect((changed.value.space as Record<string, unknown>).address).toBe(probes.changeTarget);

  const resolved = await fixture.request('GET', `/v1/spaceAddresses/${probes.changeTarget}`);
  expect(resolved.response.status).toBe(200);
  expect(resolved.value).toEqual({ spaceId: probes.change.spaceId });
  expect(addressRoute(probes.claimAddress)).not.toBe(routeOf(probes.claim.spaceId));
}

beforeAll(async () => {
  const opened = await createSpaceAddressRecoveryFixture({ initialTime: new Date() });
  fixture = opened.fixture;
  growth = fixture.database;
  governance = opened.governance;
  actor = await fixture.person('growth-actor');
  const grant = await fixture.grantGlobal(governance, actor, ['space:create']);
  if (grant.response.status !== 201) throw new Error(`Growth actor grant failed: ${grant.response.status}`);
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

test('The distinct joined native outcomes and three-scale bounded growth retain the existing owner contracts.', async () => {
  const position = await growth.admin.query('SELECT max(position)::text AS position FROM core.partition');
  const positionBase = Number(position.rows[0]?.position ?? 0) + 1_000_000;
  const data = await population(positionBase);
  const warmups = new Map<number, GrowthProbes>();
  for (const scale of scales) warmups.set(scale, await buildProbes(scale, 'warmup'));
  const measured = new Map<string, GrowthProbes>();
  const keyOf = (scale: number, repetition: number) => `${scale}:${repetition}`;

  const report = await checkGrowth(growth, {
    name: 'community Space address recovery claim replay conflict change resolve',
    scales,
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      await seed({ pool: database.pool, admin: database.admin }, data, { from: previous, to: scale });
    },
    async prepare(_database, scale, repetition) {
      measured.set(keyOf(scale, repetition), await buildProbes(scale, 'measured'));
    },
    async warmup(_database, scale) {
      await exercise(warmups.get(scale)!);
    },
    async operation(_database, scale, repetition) {
      await exercise(measured.get(keyOf(scale, repetition))!);
    },
  });

  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
  expect(new Set(report.samples.map((sample) => sample.cost.rows)).size).toBe(1);
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.occurrenceRepetitions).toHaveLength(1);
    expect(sample.occurrenceRepetitions[0]?.statements.length).toBeGreaterThan(0);
    for (const relation of [
      'community.space_address_claim',
      'community.space',
      'community.space_revision',
      'core.receipt',
      'access.handle_claim',
    ]) {
      expect(sample.cost.relations[relation]?.sequentialScans ?? 0).toBe(0);
    }
  }
});

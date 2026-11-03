import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readRealmHomePresentation } from '../../src/community/realm-home-presentation.ts';
import openMembership from '../../src/community/membership-open.sql';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { communityFixtureRuntime } from './community-driver.ts';
import { capture, checkGrowth, costOf, seed, type Cost, type Population } from '../support/growth.ts';
import { openRealmMemberCountReadFixture, type RealmMemberCountReadFixture, type RealmMemberSummary } from './support/growth-realm-member-count-read-fixture.ts';

const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const currentTime = '2020-01-01T00:00:00.000Z';
let fixture: RealmMemberCountReadFixture;

beforeAll(async () => {
  fixture = await openRealmMemberCountReadFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

function assertCurrent(members: RealmMemberSummary, count: number, version?: string): asserts members is Extract<RealmMemberSummary, { state: 'current' }> {
  expect(members.state).toBe('current');
  if (members.state !== 'current') throw new Error('Expected a current Realm member count');
  expect(members.count).toBe(count);
  expect(Number.isSafeInteger(members.count)).toBe(true);
  expect(members.version).toMatch(/^(0|[1-9][0-9]*)$/);
  expect(BigInt(members.version).toString()).toBe(members.version);
  if (version !== undefined) expect(members.version).toBe(version);
}

function assertPointPlan(samples: readonly { cost: Cost }[]) {
  const firstStatements = samples[0]!.cost.statements;
  for (const sample of samples) {
    expect(sample.cost.statements).toBe(firstStatements);
    expect(sample.cost.relations['core.partition']?.rows).toBe(1);
    expect(sample.cost.relations['core.partition']?.sequentialScans).toBe(0);
    const control = sample.cost.relations['community.realm_member_count'];
    expect(control?.rows).toBe(1);
    expect(control?.sequentialScans).toBe(0);
    expect(sample.cost.relations['community.realm_member']?.sequentialScans ?? 0).toBe(0);
  }
}

function unrelatedRealmControls(partition: number): Population {
  return {
    name: `realm-member-count-unrelated-controls-${crypto.randomUUID()}`,
    hotPartition: partition,
    hotShare: 1,
    rows({ route }) {
      const spaceId = newId(route);
      const spaceRevisionId = newId(route);
      const realmId = newId(route);
      const realmRevisionId = newId(route);
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: currentTime,
            creator: fixture.accounts.owner.id,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: 'Unrelated growth host',
            summary: '',
            created_at: currentTime,
            author: fixture.accounts.owner.id,
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
            created_at: currentTime,
            creator: fixture.accounts.owner.id,
          },
        ],
        'community.realm_revision': [
          {
            route,
            realm_id: realmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: 'Unrelated growth Realm',
            summary: '',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            created_at: currentTime,
            author: fixture.accounts.owner.id,
          },
        ],
      };
    },
  };
}

function retainedHistory(): Population {
  const realmId = fixture.growth.realmId;
  const route = routeOf(realmId)!;
  return {
    name: `realm-member-count-retained-history-${crypto.randomUUID()}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    async write({ admin }, { ordinal }) {
      const accountId = newId(route);
      const since = new Date(Date.UTC(2010, 0, 1) + ordinal * 60_000);
      const until = new Date(since.getTime() + 30_000);
      await admin.query(
        `INSERT INTO community.realm_member
           (route,realm_id,account_id,role,valid,reservation_id,transaction_id)
         VALUES($1,$2,$3,'member',tstzrange($4::timestamptz,$5::timestamptz,'[)'),$6,$7)`,
        [route, realmId, accountId, since.toISOString(), until.toISOString(), newId(routeOf(accountId)!), newId(route)],
      );
    },
  };
}

async function growHistory(scale: number, previous: number): Promise<void> {
  await seed(fixture.database, retainedHistory(), { from: previous, to: scale });
  const count = await fixture.database.admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM community.realm_member
     WHERE route=$1 AND realm_id=$2 AND NOT upper_inf(valid)`,
    [routeOf(fixture.growth.realmId), fixture.growth.realmId],
  );
  expect(count.rows[0]?.count).toBe(scale);
}

test(
  'Realm home member count stays a native point read across member, unrelated control and retained history growth',
  async () => {
    const database = fixture.database;
    const selectedRoute = routeOf(fixture.growth.realmId)!;
    const selectedPartition = partitionOf(selectedRoute);
    const emptyRealm = await fixture.createRealm('Initialized empty Realm');
    assertCurrent((await fixture.readHome(emptyRealm)).members, 0, '0');

    const memberReport = await checkGrowth(database, {
      name: 'community Realm home member count with selected members',
      scales,
      bounds,
      async grow(_database, scale, previous) {
        await fixture.growSelectedMembers(scale, previous);
      },
      async operation(_database, scale) {
        const home = await fixture.readHome(fixture.growth.realmId);
        assertCurrent(home.members, scale);
        return home;
      },
    });
    expect(memberReport.samples.map((sample) => sample.scale)).toEqual(scales);
    assertPointPlan(memberReport.samples);

    const memberObservation = await capture(database, () => fixture.readHome(fixture.growth.realmId));
    const countStatements = memberObservation.capture.statements.filter((sql) => /FROM\s+community\.realm_member_count\b/i.test(sql));
    expect(countStatements).toHaveLength(1);
    expect(countStatements[0]).toMatch(/WHERE\s+route\s*=\s*\$1::integer\s+AND\s+realm_id\s*=\s*\$2::uuid/i);
    const ownershipStatements = memberObservation.capture.statements.filter((sql) => /FROM\s+core\.partition\s+WHERE\s+partition_no\s*=\s*\$1/i.test(sql));
    expect(ownershipStatements).toHaveLength(1);
    const memberCost = costOf(memberObservation.capture);
    expect(memberCost.relations['core.partition']?.rows).toBe(1);
    expect(memberCost.relations['community.realm_member_count']?.rows).toBe(1);
    expect(memberCost.relations['community.realm_member_count']?.sequentialScans).toBe(0);

    const left = await fixture.driver.request({
      method: 'DELETE',
      path: `/v1/realms/${fixture.growth.realmId}/membership`,
      actor: fixture.growth.actor,
      key: JSON.stringify(crypto.randomUUID()),
    });
    expect(left.status).toBe(202);
    await fixture.driver.settle();
    assertCurrent((await fixture.readHome(fixture.growth.realmId)).members, 4095, '1');
    const rejoined = await fixture.driver.request({
      method: 'POST',
      path: `/v1/realms/${fixture.growth.realmId}/membership`,
      actor: fixture.growth.actor,
      key: JSON.stringify(crypto.randomUUID()),
    });
    expect(rejoined.status).toBe(202);
    await fixture.driver.settle();
    assertCurrent((await fixture.readHome(fixture.growth.realmId)).members, 4096, '2');

    const controls = unrelatedRealmControls(selectedPartition);
    const controlReport = await checkGrowth(database, {
      name: 'community Realm home member count with unrelated Realm controls',
      scales,
      bounds,
      async grow(_database, scale, previous) {
        await seed(database, controls, { from: previous, to: scale });
        const controlCount = await database.admin.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM community.realm_member_count
           WHERE route BETWEEN $1 AND $2 AND realm_id <> $3`,
          [selectedPartition * 16, selectedPartition * 16 + 15, fixture.growth.realmId],
        );
        expect(controlCount.rows[0]?.count).toBe(scale);
      },
      async operation(_database, scale) {
        const home = await fixture.readHome(fixture.growth.realmId);
        assertCurrent(home.members, 4096, '2');
        return home;
      },
    });
    expect(controlReport.samples.map((sample) => sample.scale)).toEqual(scales);
    assertPointPlan(controlReport.samples);

    const historyReport = await checkGrowth(database, {
      name: 'community Realm home member count with retained membership history',
      scales,
      bounds,
      grow: growHistory,
      async operation(_database, scale) {
        const home = await fixture.readHome(fixture.growth.realmId);
        assertCurrent(home.members, 4096);
        return home;
      },
    });
    expect(historyReport.samples.map((sample) => sample.scale)).toEqual(scales);
    assertPointPlan(historyReport.samples);

    const runtime = communityFixtureRuntime();
    await expect(
      readRealmHomePresentation(
        { pool: database.pool, access: runtime.system.access },
        fixture.growth.realmId,
        { actor: { kind: 'anonymous' }, deadline: Date.now() - 1 },
      ),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });

    await database.admin.query('ALTER TABLE community.realm_member_count RENAME TO realm_member_count_hidden');
    try {
      const failedHome = await fixture.driver.request({
        method: 'GET',
        path: `/v1/realms/${fixture.growth.realmId}/presentation`,
        actor: fixture.growth.actor,
      });
      expect(failedHome.status).toBe(503);
    } finally {
      await database.admin.query('ALTER TABLE community.realm_member_count_hidden RENAME TO realm_member_count');
    }

    const missingControl = await fixture.createRealm('Missing count control');
    await database.admin.query('DELETE FROM community.realm_member_count WHERE route=$1 AND realm_id=$2', [
      routeOf(missingControl),
      missingControl,
    ]);
    expect((await fixture.readHome(missingControl)).members).toEqual({ state: 'unknown', count: null, version: null });

    const partialControl = await fixture.createRealm('Partial count control');
    await database.admin.query(
      'UPDATE community.realm_member_count SET initialized=false WHERE route=$1 AND realm_id=$2',
      [routeOf(partialControl), partialControl],
    );
    expect((await fixture.readHome(partialControl)).members).toEqual({ state: 'unknown', count: null, version: null });

    const uncoveredControl = await fixture.createRealm('Uncovered removal control');
    await database.admin.query(
      'UPDATE community.realm_member_count SET removal_coverage=false WHERE route=$1 AND realm_id=$2',
      [routeOf(uncoveredControl), uncoveredControl],
    );
    expect((await fixture.readHome(uncoveredControl)).members).toEqual({ state: 'unknown', count: null, version: null });

    const futureRealm = await fixture.createRealm('Unsupported temporal horizon');
    const futureRoute = routeOf(futureRealm)!;
    const futureMember = newId(futureRoute);
    await openMembership.run(database.pool, {
      route: futureRoute,
      realm_id: futureRealm,
      account_id: futureMember,
      reservation_id: newId(routeOf(futureMember)!),
      transaction_id: newId(futureRoute),
      at: '2099-01-01T00:00:00.000Z',
    });
    expect((await fixture.readHome(futureRealm)).members).toEqual({ state: 'unknown', count: null, version: null });

    const protectedRealm = await fixture.createRealm('Protected member count', 'protected');
    const denied = await fixture.driver.request({
      method: 'GET',
      path: `/v1/realms/${protectedRealm}/presentation`,
      actor: fixture.accounts.outsider,
    });
    const deniedBody = await denied.text();
    expect(denied.status).toBe(404);
    expect(deniedBody).not.toContain(protectedRealm);
  },
  240_000,
);

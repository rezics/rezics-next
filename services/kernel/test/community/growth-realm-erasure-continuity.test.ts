import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRealmOwnershipCommands } from '../../src/access/realm-ownership.ts';
import { eraseAccountRealmOwnership } from '../../src/community/account-erasure-memberships.ts';
import { lockRealmOwnershipSource } from '../../src/community/realm-continuity.ts';
import { runCommand } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, seed } from '../support/growth.ts';
import { costOf, type Capture } from '../support/growth-cost.ts';
import {
  createRealmErasureContinuityFixture,
  retainedRealmHistoryPopulation,
  unrelatedRealmErasurePopulation,
  type RealmErasureContinuityFixture,
  type RealmProbe,
} from './support/growth-realm-erasure-continuity-fixture.ts';

const scales = [256, 1024, 4096] as const;
let fixture: RealmErasureContinuityFixture;

beforeAll(async () => {
  fixture = await createRealmErasureContinuityFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

function deps() {
  return {
    pool: fixture.db.pool,
    access: fixture.system.access,
    clock: () => new Date(fixture.erasedAt),
  };
}

function selectedInput(realm: RealmProbe) {
  return { realmId: realm.realmId, accountId: fixture.accountId };
}

async function realmRow(realm: RealmProbe) {
  return (
    await fixture.db.admin.query('SELECT * FROM community.realm WHERE route=$1 AND realm_id=$2', [
      realm.route,
      realm.realmId,
    ])
  ).rows;
}

async function successionRow(realm: RealmProbe) {
  return (
    await fixture.db.admin.query(
      'SELECT * FROM access.realm_erasure_succession WHERE route=$1 AND resource_id=$2 AND account_id=$3',
      [realm.route, realm.realmId, fixture.accountId],
    )
  ).rows;
}

async function apply(realm: RealmProbe) {
  const outcome = await eraseAccountRealmOwnership(deps(), selectedInput(realm), { deadline: Date.now() + 30_000 });
  if (outcome.value.status === 'pending') throw new Error(`Native Realm succession stayed pending: ${outcome.value.reason}`);
  return outcome.value;
}

async function assertObservedOperation(realm: RealmProbe, first: Awaited<ReturnType<typeof apply>>) {
  const observed = await capture(fixture.db, () => apply(realm));
  expect(observed.value).toEqual({ ...first, replayed: true });
  const statements = observed.capture.statements;
  expect(
    statements.filter(
      (statement) =>
        /FROM\s+access\.erasure\s+e/i.test(statement) &&
        /authn_fenced/i.test(statement) &&
        /lifecycle_fence_receipt/i.test(statement),
    ),
  ).toHaveLength(1);
  expect(
    statements.some(
      (statement) =>
        /FROM\s+access\.realm_erasure_succession/i.test(statement) &&
        /source_version/i.test(statement) &&
        /source_at/i.test(statement),
    ),
  ).toBe(true);
  expect(statements.filter((statement) => /UPDATE\s+community\.realm\s+h/i.test(statement))).toHaveLength(1);

  const cost = costOf(observed.capture);
  expect(Number.isSafeInteger(cost.rows)).toBe(true);
  expect(Number.isSafeInteger(cost.sharedHit)).toBe(true);
  expect(Number.isSafeInteger(cost.sharedRead)).toBe(true);
  expect(cost.relations?.['community.realm_member']).toBeUndefined();
  expect(cost.relations?.['community.account_erasure_progress']).toBeUndefined();
  expect(cost.relations?.['access.erasure_progress']).toBeUndefined();
  for (const name of ['community.realm', 'community.realm_revision', 'access.resource_role_grant']) {
    const relation = cost.relations?.[name];
    if (relation) expect(relation.sequentialScans).toBe(0);
  }
  return cost;
}

function costForStatements(capture: Capture, include: (statement: string) => boolean) {
  const indexes = capture.statements.flatMap((statement, index) => (include(statement) ? [index] : []));
  const remap = new Map(indexes.map((index, next) => [index, next]));
  const selectedPlans = capture.plans.flatMap((plan, planIndex) => {
    const statementIndex = capture.planStatements?.[planIndex];
    return statementIndex !== undefined && remap.has(statementIndex) ? [{ plan, planIndex, statementIndex }] : [];
  });
  const selectParallel = <T>(values: readonly T[] | undefined) =>
    values === undefined ? undefined : indexes.map((index) => values[index]!);
  const subset: Capture = {
    ...capture,
    statements: indexes.map((index) => capture.statements[index]!),
    requestBytes: selectParallel(capture.requestBytes),
    responseBytes: selectParallel(capture.responseBytes),
    statementErrors: selectParallel(capture.statementErrors),
    statementErrorMessages: selectParallel(capture.statementErrorMessages),
    statementBackends: selectParallel(capture.statementBackends),
    plans: selectedPlans.map(({ plan }) => plan),
    planStatements: selectedPlans.map(({ statementIndex }) => remap.get(statementIndex)),
    planDatabases:
      capture.planDatabases === undefined ? undefined : selectedPlans.map(({ planIndex }) => capture.planDatabases![planIndex]!),
    planBackends:
      capture.planBackends === undefined ? undefined : selectedPlans.map(({ planIndex }) => capture.planBackends![planIndex]!),
    backgroundStatements: [],
    backgroundRequestBytes: [],
    backgroundResponseBytes: [],
    backgroundPlans: [],
    backgroundPlanStatements: [],
    backgroundStatementErrors: [],
    backgroundStatementErrorMessages: [],
    backgroundStatementBackends: [],
    backgroundPlanDatabases: [],
    backgroundPlanBackends: [],
  };
  return costOf(subset);
}

async function measureGrowth(
  name: string,
  realm: RealmProbe,
  population: ReturnType<typeof unrelatedRealmErasurePopulation> | ReturnType<typeof retainedRealmHistoryPopulation>,
) {
  const fixedRealm = await realmRow(realm);
  const fixedSuccession = await successionRow(realm);
  expect(fixedSuccession).toHaveLength(1);
  const report = await checkGrowth(fixture.db, {
    name,
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    slack: { rows: { absolute: 0, relative: 0 } },
    async grow(db, scale, previous) {
      await seed(db, population.population, { from: previous, to: scale });
      expect(await realmRow(realm)).toEqual(fixedRealm);
      expect(await successionRow(realm)).toEqual(fixedSuccession);
    },
    async operation() {
      return apply(realm);
    },
    async warmup() {},
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
  for (const { cost } of report.samples) {
    expect(Number.isSafeInteger(cost.rows)).toBe(true);
    expect(Number.isSafeInteger(cost.sharedHit)).toBe(true);
    expect(Number.isSafeInteger(cost.sharedRead)).toBe(true);
    for (const relation of Object.values(cost.relations ?? {})) expect(relation.sequentialScans).toBe(0);
  }
}

test(
  'Realm erasure continuity stays bounded at 256, 1024 and 4096 unrelated rows and retained revisions',
  async () => {
    const ordinary = fixture.ordinary;
    const before = await realmRow(ordinary);
    const commands = createRealmOwnershipCommands({ pool: fixture.db.pool, access: fixture.system.access });
    const rollback = new Error('Rollback native Realm erasure segment');
    await expect(
      runCommand(
        fixture.db.pool,
        {
          partition: partitionOf(ordinary.route),
          deadline: Date.now() + 30_000,
          authorization: commands.erasureSuccessionAuthorization({
            resource: { route: ordinary.route, id: ordinary.realmId },
            accountId: fixture.accountId,
          }),
        },
        async (tx) => {
          const applied = await commands.applyErasureSuccession(tx);
          expect(applied.status).toBe('orphaned');
          expect(await lockRealmOwnershipSource(tx, ordinary.realmId)).toMatchObject({
            ownershipState: 'orphaned',
          });
          throw rollback;
        },
      ),
    ).rejects.toBe(rollback);
    expect(await realmRow(ordinary)).toEqual(before);
    expect(await successionRow(ordinary)).toEqual([]);

    const completion = await capture(fixture.db, () => apply(ordinary));
    const ordinaryFirst = completion.value;
    expect(ordinaryFirst).toMatchObject({
      status: 'orphaned',
      replayed: false,
      source: { accountId: fixture.accountId },
    });
    const nativeStatements = completion.capture.statements.filter((statement) =>
      /access\.erasure\s+e|current_resource_role_(key|frontier)/i.test(statement),
    );
    expect(
      completion.capture.statements.filter(
        (statement) =>
          /FROM\s+access\.erasure\s+e/i.test(statement) &&
          /authn_fenced/i.test(statement) &&
          /lifecycle_fence_receipt/i.test(statement),
      ),
    ).toHaveLength(1);
    expect(nativeStatements.some((statement) => /current_resource_role_(key|frontier)/i.test(statement))).toBe(true);
    const nativePreparationCost = costForStatements(completion.capture, (statement) =>
      /access\.erasure\s+e|current_resource_role_(key|frontier)/i.test(statement),
    );
    const callbackCost = costForStatements(completion.capture, (statement) =>
      /community\.realm|realm_erasure_succession/i.test(statement),
    );
    for (const cost of [nativePreparationCost, callbackCost]) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(Number.isSafeInteger(cost.rows)).toBe(true);
      expect(Number.isSafeInteger(cost.sharedHit)).toBe(true);
      expect(Number.isSafeInteger(cost.sharedRead)).toBe(true);
    }
    const ordinaryState = await realmRow(ordinary);
    const ordinaryAuthority = await successionRow(ordinary);
    const root = await fixture.db.admin.query<{ version: number; at: string }>(
      'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
      [routeOf(fixture.accountId), fixture.accountId],
    );
    expect(ordinaryAuthority[0]).toMatchObject({ source_route: routeOf(fixture.accountId), source_version: root.rows[0]!.version });
    expect(Date.parse(String(ordinaryAuthority[0]!.source_at))).toBe(Date.parse(root.rows[0]!.at));
    expect(await apply(ordinary)).toEqual({ ...ordinaryFirst, replayed: true });
    expect(await realmRow(ordinary)).toEqual(ordinaryState);
    expect(await successionRow(ordinary)).toEqual(ordinaryAuthority);

    const removedFirst = await apply(fixture.removed);
    expect(removedFirst).toMatchObject({
      status: 'orphaned',
      replayed: false,
      source: { accountId: fixture.accountId },
    });
    const removedState = await realmRow(fixture.removed);
    const removedAuthority = await successionRow(fixture.removed);
    expect(removedState[0]).toMatchObject({ state: 'removed', ownership_state: 'orphaned' });
    expect(await apply(fixture.removed)).toEqual({ ...removedFirst, replayed: true });
    expect(await realmRow(fixture.removed)).toEqual(removedState);
    expect(await successionRow(fixture.removed)).toEqual(removedAuthority);

    await assertObservedOperation(ordinary, ordinaryFirst);
    await assertObservedOperation(fixture.removed, removedFirst);

    const unrelated = unrelatedRealmErasurePopulation(fixture);
    await measureGrowth('Realm erasure continuity unrelated ownership, membership and account progress', ordinary, unrelated);
    const insertedAccounts = unrelated.accounts.slice(0, 4096);
    const unrelatedCounts = await fixture.db.admin.query(
      `SELECT
         (SELECT count(*)::integer FROM access.resource_role_grant WHERE subject_id=ANY($1::uuid[])) AS owners,
         (SELECT count(*)::integer FROM community.realm_member WHERE account_id=ANY($1::uuid[])) AS members,
         (SELECT count(*)::integer FROM community.account_erasure_progress WHERE account_id=ANY($1::uuid[])) AS community_progress,
         (SELECT count(*)::integer FROM access.erasure_progress WHERE account_id=ANY($1::uuid[])) AS account_progress`,
      [insertedAccounts],
    );
    expect(unrelatedCounts.rows).toEqual([{ owners: 4096, members: 4096, community_progress: 4096, account_progress: 4096 }]);

    const history = retainedRealmHistoryPopulation(fixture);
    await measureGrowth('Realm erasure continuity retained Realm history', fixture.removed, history);
    expect(history.revisions.slice(0, 4096)).toHaveLength(4096);
    const retained = await fixture.db.admin.query(
      'SELECT count(*)::integer AS count FROM community.realm_revision WHERE route=$1 AND realm_id=$2 AND revision_id=ANY($3::uuid[])',
      [fixture.history.route, fixture.history.realmId, history.revisions.slice(0, 4096)],
    );
    expect(retained.rows).toEqual([{ count: 4096 }]);
  },
  1_200_000,
);

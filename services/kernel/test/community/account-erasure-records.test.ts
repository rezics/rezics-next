import { afterAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture, Realm } from '../../../../specs/community-driver.ts';
import { banAccount } from '../../src/community/ban.ts';
import { createSpace } from '../../src/community/space.ts';
import { createRealm } from '../../src/community/realm.ts';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';
import { createProductionAccess } from './membership-fixture.ts';
import { closeCommunityDrivers, createCommunityDriver, communityFixtureRuntime, worker } from './community-driver.ts';

const DAY = 86400000;
const due = (at: string, days = 183) => new Date(Date.parse(at) + days * DAY).toISOString();
const key = () => JSON.stringify(crypto.randomUUID());
afterAll(closeCommunityDrivers);

async function setup() {
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  const { system } = communityFixtureRuntime();
  const deletion = accountDeletionRuntime(system);
  const persona = await deletion.person();
  const account = { id: persona.accountId, bearer: persona.bearer };
  return { driver, fixture, system, deletion, persona, account };
}
async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}
async function realm(driver: CommunityDriver, fixture: Fixture, createdAt?: string) {
  if (createdAt) {
    const { system } = communityFixtureRuntime();
    const auth = await createProductionAccess({ actions: [...system.actions.keys()] });
    const owner = await auth.authenticate(system.database.pool, fixture.owner.id, [...system.actions.keys()]);
    const deps = {
      pool: system.database.pool,
      access: auth.access,
      routeKey: system.routeKey,
      clock: () => new Date(createdAt),
    };
    const context = () => ({ deadline: Date.now() + 30000, idempotencyKey: crypto.randomUUID() });
    const space = await createSpace(deps, owner, { title: 'Historical erasure host' }, context());
    const result = await createRealm(
      deps,
      owner,
      {
        spaceId: space.value.spaceId,
        title: 'Historical erasure Realm',
        visibility: 'public',
        contextId: fixture.contextId,
      },
      context(),
    );
    return { realmId: result.value.realmId };
  }
  const { space } = await json<{ space: { spaceId: string } }>(
    await driver.request({
      actor: fixture.owner,
      method: 'POST',
      path: '/v1/spaces',
      key: key(),
      body: { title: 'Erasure host' },
    }),
    201,
  );
  return (
    await json<{ realm: Realm }>(
      await driver.request({
        actor: fixture.owner,
        method: 'POST',
        path: '/v1/realms',
        key: key(),
        body: { spaceId: space.spaceId, title: 'Erasure Realm', visibility: 'public', contextId: fixture.contextId },
      }),
      201,
    )
  ).realm;
}
async function ban(driver: CommunityDriver, owner: Account, realmId: string, target: Account, reason: string) {
  await json(
    await driver.request({
      actor: owner,
      method: 'PUT',
      path: `/v1/realms/${realmId}/bans/${target.id}`,
      key: key(),
      body: { reason },
    }),
    200,
  );
}
async function drain(driver: CommunityDriver, ids: string[]) {
  await driver.settle();
  const { system } = communityFixtureRuntime();
  for (const partition of new Set(ids.map((id) => partitionOf(routeOf(id)!))))
    await drainEffects(system.database.pool, partition);
  // Effects are queued by the relay; settle waits for their durable completion too.
  await driver.settle();
}
async function erase(state: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  const erased = await deletePersona({ pool: state.system.database.pool, auth: state.deletion.auth }, state.persona);
  await drain(state.driver, [...ids, state.account.id]);
  const phase = await import('../../src/community/account-erasure-records.ts');
  let after: import('../../src/community/account-erasure-records.ts').CommunityRecordsCursor | null = null;
  let reasonsKeptUntil: string | null = null;
  let found = 0;
  do {
    const page = await phase.eraseAccountCommunityRecordsPage({ pool: state.system.database.pool }, state.account.id, {
      erasedAt: erased.at,
      after,
    });
    expect(page.pending).toBe(0);
    found += page.found;
    if (page.reasonsKeptUntil && (!reasonsKeptUntil || page.reasonsKeptUntil > reasonsKeptUntil))
      reasonsKeptUntil = page.reasonsKeptUntil;
    after = page.next;
  } while (after);
  return { erased, reasonsKeptUntil, found };
}

// Each phase is called only after native Auth has committed the account's erasure obligation.
test.serial(
  'account erasure deletes bans against the account, removes it from bans it issued, membership operations and curator verdicts, and keeps only ban reasons of the last six months until their expiry',
  async () => {
    const state = await setup();
    const { driver, fixture, system, account } = state;
    const targetRealm = await realm(driver, fixture);
    const modRealm = await realm(driver, fixture, new Date(Date.now() - 201 * DAY).toISOString());
    expect((await driver.grantModerator(modRealm.realmId, account)).status).toBe(201);
    await ban(driver, fixture.owner, targetRealm.realmId, account, 'Against erased account');
    // Use the command clock, while keeping authorization on a real bearer from the membership fixture.
    const auth = await createProductionAccess({ actions: [...system.actions.keys()] });
    const actor = await auth.authenticate(system.database.pool, account.id, [...system.actions.keys()]);
    const oldAt = new Date(Date.now() - 200 * DAY).toISOString();
    await banAccount(
      {
        pool: system.database.pool,
        access: auth.access,
        routeKey: system.routeKey,
        clock: () => new Date(oldAt),
        tokens: system.tokenKeys,
        workClient: async () => {
          throw new Error('Old nonmember ban starts no work');
        },
      },
      actor,
      { realmId: modRealm.realmId, accountId: fixture.outsider.id, reason: 'Old reason' },
      { deadline: Date.now() + 30000, idempotencyKey: crypto.randomUUID() },
    );
    await json(
      await driver.request({
        actor: fixture.owner,
        method: 'POST',
        path: `/v1/realms/${modRealm.realmId}/members`,
        key: key(),
        body: { accountId: fixture.member.id },
      }),
      202,
    );
    await driver.settle();
    await ban(driver, account, modRealm.realmId, fixture.member, 'Recent reason');
    await json(
      await driver.request({
        actor: account,
        method: 'POST',
        path: `/v1/realms/${modRealm.realmId}/publications`,
        key: key(),
        body: { subjectId: fixture.subject.id },
      }),
      201,
    );
    await drain(driver, [targetRealm.realmId, modRealm.realmId]);
    const before = await system.database.pool.query<{ at: string }>(
      'SELECT lower(valid)::text AS at FROM community.realm_ban WHERE realm_id=$1 AND account_id=$2',
      [modRealm.realmId, fixture.member.id],
    );
    const result = await erase(state, [targetRealm.realmId, modRealm.realmId]);
    expect(result.found).toBeGreaterThanOrEqual(5);
    expect(result.reasonsKeptUntil).toBe(due(before.rows[0]!.at));
    const rows = await system.database.pool.query(
      'SELECT account_id::text, actor, reason FROM community.realm_ban WHERE realm_id=ANY($1::uuid[])',
      [[targetRealm.realmId, modRealm.realmId]],
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { account_id: fixture.outsider.id, actor: null, reason: '' },
        { account_id: fixture.member.id, actor: null, reason: 'Recent reason' },
      ]),
    );
    expect(rows.rows).toHaveLength(2);
    const operations = await system.database.pool.query(
      `SELECT * FROM community.realm_membership_operation
    WHERE realm_id=$1 AND kind='removal'`,
      [modRealm.realmId],
    );
    expect(operations.rows).toHaveLength(1);
    expect(operations.rows[0]).toMatchObject({
      initiator_account_id: null,
      actor_client_id: null,
      actor_requested_by: null,
      original_operator_account_id: null,
    });
    for (const row of operations.rows) expect(JSON.stringify(row)).not.toContain(account.id);
    const verdicts = await system.database.pool.query('SELECT actor FROM community.publication WHERE realm_id=$1', [
      modRealm.realmId,
    ]);
    expect(verdicts.rows).toEqual([{ actor: null }]);
  },
  120000,
);

test.serial(
  'the ban reason purge erases each kept reason once its own ban time plus 183 days has passed, in ban-time order, and leaves the bans',
  async () => {
    const state = await setup();
    const { driver, fixture, system, account } = state;
    const place = await realm(driver, fixture, new Date(Date.now() - 61 * DAY).toISOString());
    expect((await driver.grantModerator(place.realmId, account)).status).toBe(201);
    const auth = await createProductionAccess({ actions: [...system.actions.keys()] });
    const actor = await auth.authenticate(system.database.pool, account.id, [...system.actions.keys()]);
    const times = [new Date(Date.now() - 60 * DAY).toISOString(), new Date(Date.now() - 30 * DAY).toISOString()];
    for (const [index, target] of [fixture.member, fixture.outsider].entries()) {
      await banAccount(
        {
          pool: system.database.pool,
          access: auth.access,
          routeKey: system.routeKey,
          clock: () => new Date(times[index]!),
          tokens: system.tokenKeys,
          workClient: async () => {
            throw new Error('Nonmember ban starts no work');
          },
        },
        actor,
        { realmId: place.realmId, accountId: target.id, reason: `Reason ${index}` },
        { deadline: Date.now() + 30000, idempotencyKey: crypto.randomUUID() },
      );
    }
    expect((await erase(state, [place.realmId])).reasonsKeptUntil).toBe(due(times[1]!));
    const { purgeAccountBanReasonsPage } = await import('../../src/community/account-erasure-records.ts');
    const reasons = async () =>
      (
        await system.database.pool.query(
          'SELECT reason FROM community.realm_ban WHERE realm_id=$1 ORDER BY lower(valid)',
          [place.realmId],
        )
      ).rows.map((row) => row.reason);
    expect(await reasons()).toEqual(['Reason 0', 'Reason 1']);
    expect(
      await purgeAccountBanReasonsPage({ pool: system.database.pool }, account.id, {
        asOf: due(times[0]!),
        after: null,
      }),
    ).toMatchObject({ found: 1, nextDueAt: due(times[1]!), next: null });
    expect(await reasons()).toEqual(['', 'Reason 1']);
    expect(
      await purgeAccountBanReasonsPage({ pool: system.database.pool }, account.id, {
        asOf: due(times[1]!),
        after: null,
      }),
    ).toMatchObject({ found: 1, nextDueAt: null, next: null });
    expect(await reasons()).toEqual(['', '']);
    for (const target of [fixture.member, fixture.outsider]) {
      await json(
        await driver.request({
          actor: target,
          method: 'POST',
          path: `/v1/realms/${place.realmId}/membership`,
          key: key(),
        }),
        403,
      );
    }
  },
  120000,
);

test.serial(
  "an account community record erasure page stays within its bound as other Realms' bans, operations and verdicts grow",
  async () => {
    const state = await setup();
    const { driver, fixture, system, account } = state;
    const place = await realm(driver, fixture);
    await json(
      await driver.request({
        actor: fixture.owner,
        method: 'POST',
        path: `/v1/realms/${place.realmId}/members`,
        key: key(),
        body: { accountId: fixture.member.id },
      }),
      202,
    );
    await driver.settle();
    expect((await driver.grantModerator(place.realmId, account)).status).toBe(201);
    await ban(driver, account, place.realmId, fixture.outsider, 'Growth probe');
    const erased = await deletePersona({ pool: system.database.pool, auth: state.deletion.auth }, state.persona);
    await drain(driver, [place.realmId, account.id]);
    await worker.stop();
    const db = await openGrowthDatabase(system.database.pool.options.connectionString);
    const phase = await import('../../src/community/account-erasure-records.ts');
    const route = routeOf(place.realmId)!;
    const at = new Date().toISOString();
    // Keep the measured page's input identical; unrelated rows use fresh Realms on the same route.
    const operation = (await db.admin.query('SELECT * FROM community.realm_membership_operation LIMIT 1')).rows[0];
    expect(operation).toBeDefined();
    try {
      const report = await checkGrowth(db, {
        name: "an account community record erasure page stays within its bound as other Realms' bans, operations and verdicts grow",
        rule: 'series',
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_db, scale, previous) {
          await seed(
            db,
            {
              name: 'unrelated-community-records',
              hotPartition: partitionOf(route),
              hotShare: 1,
              rows() {
                const realmId = newId(route),
                  revisionId = newId(route),
                  spaceId = newId(route);
                const other = newId(route);
                return {
                  'community.space': [
                    {
                      route,
                      space_id: spaceId,
                      state: 'active',
                      head_revision_id: revisionId,
                      created_at: at,
                      creator: fixture.owner.id,
                    },
                  ],
                  'community.realm': [
                    {
                      route,
                      realm_id: realmId,
                      space_id: spaceId,
                      state: 'active',
                      visibility: 'public',
                      context_id: fixture.contextId,
                      head_revision_id: revisionId,
                      created_at: at,
                      creator: fixture.owner.id,
                    },
                  ],
                  'community.space_revision': [
                    {
                      route,
                      space_id: spaceId,
                      revision_id: revisionId,
                      predecessor: null,
                      title: 'Unrelated',
                      summary: '',
                      created_at: at,
                      author: fixture.owner.id,
                    },
                  ],
                  'community.realm_revision': [
                    {
                      route,
                      realm_id: realmId,
                      revision_id: revisionId,
                      predecessor: null,
                      title: 'Unrelated',
                      summary: '',
                      visibility: 'public',
                      context_id: fixture.contextId,
                      created_at: at,
                      author: fixture.owner.id,
                    },
                  ],
                  'community.realm_ban': [
                    {
                      route,
                      realm_id: realmId,
                      account_id: other,
                      valid: '[2020-01-01,)',
                      reason: 'Unrelated',
                      actor: other,
                      transaction_id: newId(route),
                    },
                  ],
                  'community.realm_membership_operation': [
                    {
                      ...operation,
                      route,
                      operation_id: newId(route),
                      realm_id: realmId,
                      space_id: spaceId,
                      member_account_id: other,
                      initiator_account_id: other,
                    },
                  ],
                  'community.publication': [
                    {
                      route,
                      realm_id: realmId,
                      publication_id: newId(route),
                      subject_id: fixture.subject.id,
                      verdict: 'adopt',
                      actor: other,
                      created_at: at,
                    },
                  ],
                  'community.party_locator': [
                    {
                      route,
                      account_id: other,
                      kind: 'verdict',
                      due_at: at,
                      owner_route: route,
                      owner_id: realmId,
                      key: newId(route),
                    },
                  ],
                };
              },
            },
            { from: previous, to: scale },
          );
        },
        async operation() {
          const result = await phase.eraseAccountCommunityRecordsPage({ pool: db.pool }, account.id, {
            erasedAt: erased.at,
            after: null,
          });
          expect(result.found).toBe(1);
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    } finally {
      await db.close();
    }
  },
  600000,
);

import { afterAll, describe, expect, test } from 'bun:test';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import {
  ACCESS_WORK_AXES,
  EMPTY_ACCESS_WORK,
  AccessWorkAccounting,
  AccessWorkUnavailableError,
  accessNativeWork,
  accessOwnerWork,
  accessCheckout,
  type AccessWork,
  type AccessWorkSink,
} from '../../src/access/work.ts';
import { createAccess } from '../../src/access/permission.ts';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createPool } from '../../src/database/pool.ts';
import { withConnection } from '../../src/database/pool.ts';
import { mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import type { AccountActor, Actor, Resource } from '../../src/request/access.ts';

function sum(values: readonly AccessWork[]): AccessWork {
  return Object.fromEntries(
    ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((n, w) => n + w[axis], 0)]),
  ) as AccessWork;
}
function accounting(refuse?: string) {
  const admitted: { operation: string; bound: AccessWork }[] = [];
  const settled: AccessWork[] = [];
  const sink: AccessWorkSink = {
    reserve(operation, bound) {
      if (operation === refuse) return null;
      admitted.push({ operation, bound });
      return {
        settle: (actual) => {
          settled.push(actual);
        },
      };
    },
  };
  return { work: new AccessWorkAccounting(sink, Date.now() + 10_000), admitted, settled };
}
const footprint: AccessWork = { keys: 1, points: 2, witnesses: 0, rows: 3, bytes: 40, emptySeeks: 1 };

test('Access reserves before dispatch and reports exact charged work for positive and negative owner results', async () => {
  for (const value of [true, false]) {
    const { work, admitted, settled } = accounting();
    const actual = { ...footprint, rows: value ? footprint.rows : 0, bytes: 7, emptySeeks: 0 };
    const result = await work.capture(() =>
      accessOwnerWork(
        work,
        'owner',
        {
          bound: () => footprint,
          actual: () => actual,
        },
        {},
        async () => {
          expect(admitted).toEqual([{ operation: 'owner', bound: footprint }]);
          expect(work.usage()).toEqual(footprint);
          return value;
        },
      ),
    );
    expect(result).toEqual({ state: 'complete', value, usage: actual });
    expect(settled).toEqual([actual]);
  }
});

test('unproved and refused work never dispatch and report their exact dependency', async () => {
  for (const unproved of [true, false]) {
    const { work, admitted } = accounting(unproved ? undefined : 'owner');
    let called = false;
    const result = await work.capture(() =>
      accessOwnerWork(
        work,
        'owner',
        unproved
          ? undefined
          : {
              bound: () => footprint,
              actual: () => footprint,
            },
        {},
        async () => {
          called = true;
          return true;
        },
      ),
    );
    expect(result).toEqual({ state: 'unavailable', dependency: 'owner', usage: EMPTY_ACCESS_WORK });
    expect(called).toBe(false);
    expect(admitted).toHaveLength(0);
  }
});

test('checkout admission refuses before the pool wait and retains a failed dispatched acquisition', async () => {
  const refused = accounting('access.pool-checkout');
  let called = false;
  expect(
    (
      await refused.work.capture(() =>
        accessCheckout(refused.work, async () => {
          called = true;
        }),
      )
    ).state,
  ).toBe('unavailable');
  expect(called).toBe(false);
  const failed = accounting();
  await failed.work.capture(() =>
    accessCheckout(failed.work, async () => {
      expect(failed.admitted[0]?.operation).toBe('access.pool-checkout');
      throw new Error('pool acquisition failed');
    }),
  );
  expect(failed.work.usage()).toEqual({ ...EMPTY_ACCESS_WORK, points: 1 });
  expect(failed.work.usage()).toEqual(sum(failed.settled));
});

test('failed, missing and invalid actual receipts retain all dispatched work and poison reuse', async () => {
  for (const failure of ['throw', 'missing', 'row-refund', 'exceeded'] as const) {
    const { work, settled } = accounting();
    const result = await work.capture(() =>
      work.run(
        'owner',
        footprint,
        async () => {
          if (failure === 'throw') throw new Error('owner unavailable');
          return true;
        },
        () =>
          failure === 'missing'
            ? undefined
            : {
                ...footprint,
                rows: failure === 'row-refund' ? 0 : footprint.rows,
                points: failure === 'exceeded' ? footprint.points + 1 : footprint.points,
              },
      ),
    );
    expect(result.state).not.toBe('complete');
    expect(result.usage).toEqual(footprint);
    expect(settled).toEqual([footprint]);
    let called = false;
    await work.capture(() =>
      work.run('again', EMPTY_ACCESS_WORK, async () => {
        called = true;
      }),
    );
    expect(called).toBe(false);
    expect(work.usage()).toEqual(footprint);
  }
});

test('a timeout seals parallel in-flight bounds once, with no late refund or reused unknown work', async () => {
  const { work, settled } = accounting();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = work.run(
    'waiting callback',
    footprint,
    () => gate,
    () => ({ ...footprint, bytes: 0 }),
  );
  const failure = new Error('deadline reached while owner is running');
  work.fail(failure);
  expect(work.usage()).toEqual(footprint);
  expect(settled).toEqual([footprint]);
  finish();
  await expect(pending).rejects.toBe(failure);
  expect(settled).toEqual([footprint]);
  expect(work.usage()).toEqual(footprint);
});

test('native statement rows charge their proved plan even on empty output and query failure', async () => {
  for (const fail of [false, true]) {
    const { work, admitted, settled } = accounting();
    await work.capture(() =>
      accessNativeWork(work, 'membership', { group: 'bound' }, { groups: 1 }, async () => {
        expect(admitted.at(-1)?.operation).toBe('access.membership');
        if (fail) throw new Error('native connection failed');
        return [];
      }),
    );
    const bound = admitted[0]!.bound;
    expect(bound.rows).toBe(5); // one account + two current and two next role seeks
    expect(work.usage().rows).toBe(bound.rows);
    expect(work.usage()).toEqual(sum(settled));
    if (fail) expect(work.usage()).toEqual(bound);
    else expect(work.usage().emptySeeks).toBe(1);
  }
});

describe.skipIf(!process.env.DATABASE_URL)('existing native formula with Access work', () => {
  const pool = createPool(process.env.DATABASE_URL!);
  afterAll(() => pool.end());
  const action = 'work:read';
  const resource = (): Resource => ({
    route: 0x1234,
    id: `00000000-0000-7000-8000-1234${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
  });
  const anonymous: Actor = { kind: 'anonymous' };

  test('public positive, negative and changed final floor use the same formula and retain exact work', async () => {
    for (const initiallyPublic of [true, false]) {
      const { work, admitted, settled } = accounting();
      let published = initiallyPublic;
      let preparations = 0,
        verifications = 0;
      const target = resource();
      target.eligibility = createResourcePublicEligibility({
        resource: target,
        action,
        work: {
          prepare: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
          verify: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
        },
        async prepare() {
          preparations++;
          return {};
        },
        async verify() {
          verifications++;
          return published;
        },
      });
      const access = createAccess({ actions: new Map([[action, { anonymous: true }]]), accountEvidence: () => null });
      const time = await withConnection(pool, (client) => mintReadTime(client));
      try {
        const prepared = await work.capture(() =>
          access.prepare!(anonymous, action, target, { pool, work, time, deadline: work.deadline }),
        );
        expect(prepared.state).toBe('complete');
        if (prepared.state !== 'complete') throw new Error('Preparation failed');
        const decide = () =>
          withConnection(pool, (client) => access.authorize(client, anonymous, action, target, prepared.value, time));
        expect(await decide()).toBe(initiallyPublic);
        published = false;
        expect(await decide()).toBe(false);
        expect(preparations).toBe(1);
        expect(verifications).toBe(2);
        expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(initiallyPublic ? 1 : 0);
        expect(work.usage()).toEqual(sum(settled));
      } finally {
        releaseOperationalTime(time);
      }
    }
  });

  test('a callback without its owner producer refuses before callback or SQL dispatch', async () => {
    const { work, admitted } = accounting();
    let called = false;
    const target = resource();
    target.eligibility = createResourcePublicEligibility({
      resource: target,
      action,
      async prepare() {
        called = true;
        return {};
      },
      async verify() {
        called = true;
        return true;
      },
    });
    const access = createAccess({ actions: new Map([[action, { anonymous: true }]]), accountEvidence: () => null });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      expect(
        await work.capture(() =>
          access.prepare!(anonymous, action, target, { pool, work, time, deadline: work.deadline }),
        ),
      ).toEqual({ state: 'unavailable', dependency: 'Content resource eligibility.prepare', usage: EMPTY_ACCESS_WORK });
      expect(called).toBe(false);
      expect(admitted).toHaveLength(0);
    } finally {
      releaseOperationalTime(time);
    }
  });

  test('real account page shares preparation, rechecks grants/denials, and preserves failed formula work', async () => {
    const target = resource();
    const person = resource().id;
    await pool.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','active',$3)`,
      [target.route, person, crypto.randomUUID()],
    );
    const account = await readAccount(pool, target.route, person);
    if (!account) throw new Error('Missing native account fixture');
    const actor: AccountActor = {
      kind: 'account',
      accountId: person,
      clientId: 'native-work',
      requestedBy: null,
      scopes: [action],
      authnEpoch: 1,
    };
    const access = createAccess({
      actions: new Map([[action, { anonymous: false, 'x-resource-types': ['test.work'] }]]),
      accountEvidence: (input) => (input === actor ? account : null),
    });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    const { work, admitted, settled } = accounting();
    const other = resource();
    const page = { route: target.route, resourceType: 'test.work', ids: [target.id, other.id] };
    try {
      await pool.query(
        `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
        SELECT $1,id,$2,$3,'(,)'::tstzrange,$4 FROM unnest($5::uuid[]) id`,
        [target.route, person, action, crypto.randomUUID(), page.ids],
      );
      const evidence = await access.preparePage!(actor, action, page, { pool, work, time, deadline: work.deadline });
      expect(
        await withConnection(pool, (client) => access.authorizePage!(client, actor, action, page, evidence, time)),
      ).toBe(true);
      await pool.query(
        `INSERT INTO access.resource_denial (route,resource_id,subject_id,action,reason,valid,transaction_id)
        VALUES ($1,$2,$3,$4,'resource','(,)'::tstzrange,$5)`,
        [target.route, target.id, person, action, crypto.randomUUID()],
      );
      expect(
        await withConnection(pool, (client) => access.authorizePage!(client, actor, action, page, evidence, time)),
      ).toBe(false);
      expect(admitted.filter((item) => item.operation === 'access.inverse')).toHaveLength(1);
      expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(2);
      const before = work.usage();
      const result = await work.capture(() =>
        access.authorizePage!(
          {
            query: (() =>
              Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }))) as typeof pool.query,
          },
          actor,
          action,
          page,
          evidence,
          time,
        ),
      );
      expect(result.state).toBe('failed');
      expect(work.usage().rows).toBe(before.rows + admitted.at(-1)!.bound.rows);
      expect(work.usage()).toEqual(sum(settled));
    } finally {
      releaseOperationalTime(time);
    }
  });

  test('shared read window prepares inventory once, checks each target at its live T, and refuses unproved account authority', async () => {
    const { work, admitted, settled } = accounting();
    const person = resource().id;
    await pool.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','active',$3)`,
      [0x1234, person, crypto.randomUUID()],
    );
    const account = await readAccount(pool, 0x1234, person);
    const actor: AccountActor = {
      kind: 'account',
      accountId: person,
      clientId: 'shared-native-work',
      requestedBy: null,
      scopes: [action],
      authnEpoch: 1,
    };
    const access = createAccess({ actions: new Map([[action, { anonymous: true }]]), accountEvidence: () => account });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    const anotherTime = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const handle = await access.prepareReadDecisions!({
        actor,
        actions: new Set([action]),
        time,
        context: { pool, work, time, deadline: work.deadline },
      });
      for (let i = 0; i < 2; i++) {
        const target = resource();
        const eligibility = Object.assign(async () => ({ [target.id]: true }), {
          work: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
        });
        const decisions = await withConnection(pool, (client) =>
          handle.decide(client, { action, resourceType: 'test.work', ids: [target.id], eligibility }, time),
        );
        expect(decisions[target.id]?.allowed).toBe(true);
      }
      expect(admitted.filter((item) => item.operation === 'access.time')).toHaveLength(1);
      expect(admitted.filter((item) => item.operation === 'access.inverse')).toHaveLength(1);
      expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(2);
      expect(work.usage()).toEqual(sum(settled));
      await expect(handle.prepareAccountAuthority!([resource().id])).rejects.toMatchObject({
        dependency: 'Access AccountAuthority current account/operator projection native work producer',
      });
      await expect(
        withConnection(pool, (client) =>
          handle.decide(client, { action, resourceType: 'test.work', ids: [resource().id] }, anotherTime),
        ),
      ).rejects.toBeInstanceOf(AccessWorkUnavailableError);
      expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(2);
    } finally {
      releaseOperationalTime(time);
      releaseOperationalTime(anotherTime);
    }
  });

  test('assignment, organization role and final explicit formula are admitted; unproved Realm work is refused', async () => {
    const target = resource();
    const person = resource().id,
      principal = resource().id,
      organization = resource().id,
      realm = resource().id;
    for (const [id, kind] of [
      [person, 'actor'],
      [principal, 'actor'],
      [organization, 'organization'],
    ] as const)
      await pool.query(
        `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
        VALUES ($1,$2,$3,'active',$4)`,
        [target.route, id, kind, crypto.randomUUID()],
      );
    const requestId = resource().id;
    await pool.query(
      `INSERT INTO access.principal_assignment
      (route,principal_id,request_id,assigned_actor_id,valid,issued_valid,creator_principal_id,transaction_id)
      VALUES ($1,$2,$3,$4,'(,)'::tstzrange,'(,)'::tstzrange,$2,$5)`,
      [target.route, principal, requestId, person, crypto.randomUUID()],
    );
    await pool.query(
      `INSERT INTO access.membership_inverse
      (route,account_id,kind,group_id,reservation_id,transaction_id)
      VALUES ($1,$2,'organization',$3,$4,$5)`,
      [target.route, person, organization, crypto.randomUUID(), crypto.randomUUID()],
    );
    await pool.query(
      `INSERT INTO access.organization_member
      (route,organization_id,member_account_id,role,valid,transaction_id)
      VALUES ($1,$2,$3,'member','(,)'::tstzrange,$4)`,
      [target.route, organization, person, crypto.randomUUID()],
    );
    for (const [id, role] of [
      [organization, 'member'],
      [principal, ''],
    ] as const)
      await pool.query(
        `INSERT INTO access.resource_grant
        (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
        VALUES ($1,$2,$3,$4,$5,'(,)'::tstzrange,$6)`,
        [target.route, target.id, id, role, action, crypto.randomUUID()],
      );
    const account = await readAccount(pool, target.route, person);
    const actor: AccountActor = {
      kind: 'account',
      accountId: person,
      clientId: 'delegated-native-work',
      requestedBy: `urn:rezics:request:${principal}:${requestId}`,
      scopes: [action],
      authnEpoch: 1,
    };
    let realmCalls = 0;
    const access = createAccess({
      actions: new Map([[action, { anonymous: false }]]),
      accountEvidence: () => account,
      realmRoleReader: async () => {
        realmCalls++;
        return null;
      },
    });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const { work, admitted, settled } = accounting();
      const evidence = await access.prepare!(actor, action, target, { pool, work, time, deadline: work.deadline });
      expect(
        await withConnection(pool, (client) =>
          access.authorizeExplicit!(client, actor, action, target, evidence, time),
        ),
      ).toEqual({ allowed: true, explicit: true });
      for (const operation of ['assignment', 'inverse', 'candidates', 'membership', 'formula'])
        expect(admitted.some((entry) => entry.operation === `access.${operation}`)).toBe(true);
      expect(work.usage()).toEqual(sum(settled));
      await pool.query(
        `INSERT INTO access.membership_inverse
        (route,account_id,kind,group_id,reservation_id,transaction_id)
        VALUES ($1,$2,'realm',$3,$4,$5)`,
        [target.route, person, realm, crypto.randomUUID(), crypto.randomUUID()],
      );
      await pool.query(
        `INSERT INTO access.resource_grant
        (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
        VALUES ($1,$2,$3,'member',$4,'(,)'::tstzrange,$5)`,
        [target.route, target.id, realm, action, crypto.randomUUID()],
      );
      const refused = accounting();
      const result = await refused.work.capture(() =>
        access.prepare!(actor, action, target, { pool, work: refused.work, time, deadline: refused.work.deadline }),
      );
      expect(result.state).toBe('unavailable');
      if (result.state === 'unavailable') expect(result.dependency).toBe('Content AccessRealmRoleReader');
      expect(realmCalls).toBe(0);
      expect(result.usage).toEqual(sum(refused.settled));
      expect(result.usage.rows).toBeGreaterThan(0);
      let buyerCalls = 0;
      const benefitAccess = createAccess({
        actions: new Map([['edition:read', { anonymous: false }]]),
        accountEvidence: () => account,
        contentEditionBuyerFactReader: async () => {
          buyerCalls++;
          return null;
        },
      });
      const buyerActor = { ...actor, scopes: ['edition:read'] };
      const benefitTarget: Resource = {
        ...target,
        authenticatedBenefit: {
          kind: 'content-edition',
          resourceType: 'content.edition',
          resource: target,
          action: 'edition:read',
          version: { revisionId: resource().id, sha256: 'a'.repeat(64) },
        },
      };
      const commerce = accounting();
      const buyerResult = await commerce.work.capture(() =>
        benefitAccess.prepare!(buyerActor, 'edition:read', benefitTarget, {
          pool,
          work: commerce.work,
          time,
          deadline: commerce.work.deadline,
        }),
      );
      expect(buyerResult.state).toBe('unavailable');
      if (buyerResult.state === 'unavailable')
        expect(buyerResult.dependency).toBe('Commerce ContentEditionBuyerFactReader');
      expect(buyerCalls).toBe(0);
      expect(buyerResult.usage).toEqual(sum(commerce.settled));
      expect(commerce.admitted.map((entry) => entry.operation)).toEqual(['access.time', 'access.assignment']);
    } finally {
      releaseOperationalTime(time);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)('native account and fixed Global work variants', () => {
  const pool = createPool(process.env.DATABASE_URL!);
  afterAll(() => pool.end());
  const key = () => `00000000-0000-7000-8000-1234${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  async function account(kind = 'actor', operator: string | null = null) {
    const id = key();
    await pool.query(
      `INSERT INTO access.account (route,account_id,kind,state,operator_account_id,transaction_id)
      VALUES ($1,$2,$3,'active',$4,$5)`,
      [0x1234, id, kind, operator, crypto.randomUUID()],
    );
    return id;
  }
  async function grant(id: string, subject: string, action: string, route = 0x1234) {
    await pool.query(
      `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
      VALUES ($1,$2,$3,'',$4,'(,)'::tstzrange,$5)`,
      [route, id, subject, action, crypto.randomUUID()],
    );
  }

  test('Remaining Access-owned account floor authority standing and fixed Global gate branches reserve native bounded work before IO and preserve exact formula and cumulative failure accounting without callback estimates', async () => {
    const person = await account();
    const robot = await account('actor', person);
    const organization = await account('organization');
    const original = await readAccount(pool, 0x1234, person);
    const actions = new Map(
      ['account:read', 'account:update', 'account:manage'].map((action) => [action, { anonymous: false }]),
    );
    const actor: AccountActor = {
      kind: 'account',
      accountId: person,
      clientId: 'native-account-work',
      scopes: [...actions.keys()],
      requestedBy: null,
      authnEpoch: 1,
    };
    await grant(person, person, 'account:update');
    await grant(person, person, 'account:read');
    await grant(person, person, 'account:manage');
    await grant(organization, person, 'account:manage');
    const access = createAccess({ actions, accountEvidence: () => original });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    const { work, admitted, settled } = accounting();
    try {
      const handle = await access.prepareReadDecisions!({
        actor,
        actions: new Set(actions.keys()),
        time,
        context: { pool, work, time, deadline: work.deadline },
      });
      const authority = await handle.prepareAccountAuthority!([person, robot, organization]);
      expect(admitted.filter((entry) => entry.operation === 'access.formula')).toHaveLength(0);
      const decide = (kind: 'profile' | 'self' | 'verification', ids: string[]) =>
        withConnection(pool, (client) => authority.decide(client, { kind, action: 'account:update', ids }, time));
      expect((await decide('self', [person]))[person]?.allowed).toBe(true);
      const profile = await decide('profile', [robot]);
      expect(profile[robot]).toEqual({ action: 'account:manage', allowed: true, explicit: true });
      expect((await decide('verification', [organization]))[organization]?.allowed).toBe(true);
      expect((await decide('self', [organization]))[organization]?.allowed).toBe(false);
      // Revoke between calls: a live window cannot reuse the earlier grant answer.
      await pool.query(
        'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND action=$3',
        [0x1234, person, 'account:manage'],
      );
      expect((await decide('profile', [robot]))[robot]?.allowed).toBe(false);
      await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
        0x1234,
        person,
      ]);
      expect((await decide('self', [person]))[person]?.allowed).toBe(false);
      expect(work.usage()).toEqual(sum(settled));
      expect(admitted.filter((entry) => entry.operation === 'access.account-state').length).toBeGreaterThan(2);
      const before = work.usage();
      const failed = await work.capture(() =>
        authority.decide(
          { query: (() => Promise.reject(new Error('native account read failed'))) as typeof pool.query },
          { kind: 'profile', action: 'account:update', ids: [robot] },
          time,
        ),
      );
      expect(failed.state).toBe('failed');
      expect(failed.usage.rows).toBe(before.rows + admitted.at(-1)!.bound.rows);
      expect(failed.usage).toEqual(sum(settled));
    } finally {
      releaseOperationalTime(time);
    }
  });

  test('native account floor and standing retain denied work and reject released T without dependent IO', async () => {
    const { createAccountPublicEligibility } = await import('../../src/access/account-authority.ts');
    const { accountStandingCheck } = await import('../../src/access/account-standing.ts');
    const person = await account();
    const target = { route: 0x1234, id: person };
    const publicAction = 'account:read_public_identity';
    const access = createAccess({
      actions: new Map([
        [publicAction, { anonymous: true }],
        ['account:update', { anonymous: false }],
      ]),
      accountEvidence: () => undefined,
    });
    const publicTarget = { ...target, eligibility: createAccountPublicEligibility(target) };
    const time = await withConnection(pool, (client) => mintReadTime(client));
    const metered = accounting();
    try {
      const context = { pool, time, work: metered.work, deadline: metered.work.deadline };
      const evidence = await access.prepare!({ kind: 'anonymous' }, publicAction, publicTarget, context);
      expect(
        await withConnection(pool, (client) =>
          access.authorize(client, { kind: 'anonymous' }, publicAction, publicTarget, evidence, time),
        ),
      ).toBe(true);
      await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
        0x1234,
        person,
      ]);
      expect(
        await withConnection(pool, (client) =>
          access.authorize(client, { kind: 'anonymous' }, publicAction, publicTarget, evidence, time),
        ),
      ).toBe(false);
      expect(metered.work.usage()).toEqual(sum(metered.settled));
      const count = metered.admitted.length;
      releaseOperationalTime(time);
      expect(
        await withConnection(pool, (client) =>
          access.authorize(client, { kind: 'anonymous' }, publicAction, publicTarget, evidence, time),
        ),
      ).toBe(false);
      expect(metered.admitted).toHaveLength(count);
    } finally {
      releaseOperationalTime(time);
    }
    await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [0x1234, person]);
    await grant(person, person, 'account:update');
    const standing = accounting();
    const input = {
      accountId: person,
      action: 'account:update',
      target,
      context: { pool, work: standing.work, deadline: standing.work.deadline },
    };
    expect(await accountStandingCheck(access, input)).toEqual({ [person]: true });
    await pool.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [0x1234, person]);
    expect(await accountStandingCheck(access, input)).toEqual({ [person]: false });
    expect(standing.work.usage()).toEqual(sum(standing.settled));
    expect(standing.work.usage().rows).toBeGreaterThan(0);
  });

  test('installed verified bearer refresh and standalone Global gates use native scope and live opening work', async () => {
    const { createAccess: installedAccess, authorizePlatformGate } = await import('../../src/access/index.ts');
    const { admitGroup, PlatformClosedError } = await import('../../src/access/gates/admission.ts');
    const { GLOBAL_CONTEXT } = await import('../../src/access/gates/catalogue.ts');
    const { exportJWK, generateKeyPair, SignJWT } = await import('jose');
    const person = await account();
    const action = 'account:update';
    const issuer = 'https://native-account-work.test',
      audience = 'https://native-account-api.test';
    const keys = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'native-account-work', use: 'sig', alg: 'ES256' };
    let fetches = 0;
    const access = installedAccess({
      actions: new Map([[action, { anonymous: false }]]),
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/jwks`,
        fetch: async () => {
          fetches++;
          return Response.json({ keys: [jwk] });
        },
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const bearer = await new SignJWT({
      client_id: 'native-account-work',
      scope: action,
      authn_epoch: 1,
      auth_time: now,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(person)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    const actor = await access.authenticate(bearer, { pool, deadline: Date.now() + 10_000 });
    const { work, admitted, settled } = accounting();
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const context = { pool, time, work, deadline: work.deadline };
      const at = authoritativeTimeValue(time);
      await grant(GLOBAL_CONTEXT.id, person, 'gate:any', 0);
      await pool.query(
        `UPDATE access.resource_grant SET valid=tstzrange($3::timestamptz,NULL,'[)') WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$4`,
        [GLOBAL_CONTEXT.id, person, at, 'gate:any'],
      );
      const standalone = { pool, work, deadline: work.deadline };
      expect(await authorizePlatformGate(access, actor, ['gate:any'], action, GLOBAL_CONTEXT, standalone, at)).toBe(
        true,
      );
      expect(
        await authorizePlatformGate(
          access,
          actor,
          ['gate:native_work', 'gate:any'],
          action,
          GLOBAL_CONTEXT,
          context,
          at,
        ),
      ).toBe(true);
      expect(
        await authorizePlatformGate(access, actor, ['gate:any'], 'account:delete', GLOBAL_CONTEXT, context, at),
      ).toBe(false);
      await pool.query('DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2', [
        GLOBAL_CONTEXT.id,
        person,
      ]);
      expect(
        await authorizePlatformGate(
          access,
          actor,
          ['gate:native_work', 'gate:any'],
          action,
          GLOBAL_CONTEXT,
          context,
          at,
        ),
      ).toBe(false);
      const group = `work_${crypto.randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
      const input = { ...context, access: () => access, actor, group, clientAction: action, clock: () => new Date(at) };
      await expect(admitGroup(input)).rejects.toBeInstanceOf(PlatformClosedError);
      await pool.query(
        `INSERT INTO access.exposure_opening (route,"group",valid,transaction_id) VALUES (0,$1,tstzrange($2::timestamptz,NULL,'[)'),$3)`,
        [group, at, crypto.randomUUID()],
      );
      expect(await admitGroup(input)).toBeUndefined();
      await pool.query('DELETE FROM access.exposure_opening WHERE route=0 AND "group"=$1', [group]);
      await expect(admitGroup(input)).rejects.toBeInstanceOf(PlatformClosedError);
      expect(admitted.some((entry) => entry.operation === 'access.opening')).toBe(true);
      expect(admitted.some((entry) => entry.operation === 'access.transaction')).toBe(true);
      expect(work.usage()).toEqual(sum(settled));
      const unsupported = accounting();
      const unsupportedContext = { pool, work: unsupported.work, deadline: unsupported.work.deadline };
      expect(await unsupported.work.capture(() => access.authenticate(bearer, unsupportedContext))).toMatchObject({
        state: 'unavailable',
        dependency: 'Auth ES256 verification/JWKS native work producer',
        usage: EMPTY_ACCESS_WORK,
      });
      expect(fetches).toBe(1);
    } finally {
      releaseOperationalTime(time);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)('native opening partition admission', () => {
  const pool = createPool(process.env.DATABASE_URL!);
  afterAll(() => pool.end());

  test('native openings reserve the partition state and exact moved locator before disclosure', async () => {
    const { readExposure } = await import('../../src/access/gates/catalogue.ts');
    const original = (await pool.query('SELECT write_state, moved_to FROM core.partition WHERE partition_no=0'))
      .rows[0];
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      await pool.query("UPDATE core.partition SET write_state='active', moved_to=NULL WHERE partition_no=0");
      const active = accounting();
      expect(await readExposure(pool, 'work_partition', time, active.work.deadline, active.work)).toEqual({
        open: false,
        at: authoritativeTimeValue(time),
      });
      expect(active.admitted.map((entry) => entry.operation)).toEqual([
        'access.pool-checkout',
        'access.transaction',
        'access.opening-partition',
        'access.opening',
        'access.transaction',
      ]);
      expect(active.work.usage()).toEqual(sum(active.settled));
      const movedTo = 'https://handoff.test/"\\\n漢字';
      await pool.query("UPDATE core.partition SET write_state='moved', moved_to=$1 WHERE partition_no=0", [movedTo]);
      const refused = accounting('access.opening-moved-target');
      expect(
        await refused.work.capture(() =>
          readExposure(pool, 'work_partition', time, refused.work.deadline, refused.work),
        ),
      ).toMatchObject({ state: 'unavailable', dependency: 'access.opening-moved-target' });
      expect(refused.admitted.map((entry) => entry.operation)).toEqual([
        'access.pool-checkout',
        'access.transaction',
        'access.opening-partition',
      ]);
      expect(refused.work.usage()).toEqual(sum(refused.settled));
      const moved = accounting();
      const result = await moved.work.capture(() =>
        readExposure(pool, 'work_partition', time, moved.work.deadline, moved.work),
      );
      expect(result).toMatchObject({ state: 'failed', error: { reason: 'moved', partition: 0, movedTo } });
      expect(moved.admitted.map((entry) => entry.operation)).toEqual([
        'access.pool-checkout',
        'access.transaction',
        'access.opening-partition',
        'access.opening-moved-target',
      ]);
      expect(moved.work.usage()).toEqual(sum(moved.settled));
      expect(moved.work.usage().rows).toBe(2);
      releaseOperationalTime(time);
      const released = accounting();
      expect(
        await released.work.capture(() =>
          readExposure(pool, 'work_partition', time, released.work.deadline, released.work),
        ),
      ).toMatchObject({ state: 'failed', usage: EMPTY_ACCESS_WORK });
      expect(released.admitted).toHaveLength(0);
    } finally {
      releaseOperationalTime(time);
      await pool.query('UPDATE core.partition SET write_state=$1, moved_to=$2 WHERE partition_no=0', [
        original.write_state,
        original.moved_to,
      ]);
    }
  });
});

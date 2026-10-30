import { afterAll, describe, expect, test } from 'bun:test';
import {
  ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, AccessWorkAccounting, AccessWorkUnavailableError,
  accessNativeWork, accessOwnerWork, accessCheckout, type AccessWork, type AccessWorkSink,
} from '../../src/access/work.ts';
import { createAccess } from '../../src/access/permission.ts';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createPool } from '../../src/database/pool.ts';
import { withConnection } from '../../src/database/pool.ts';
import { mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import type { AccountActor, Actor, Resource } from '../../src/request/access.ts';

function sum(values: readonly AccessWork[]): AccessWork {
  return Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((n, w) => n + w[axis], 0)])) as AccessWork;
}
function accounting(refuse?: string) {
  const admitted: { operation: string; bound: AccessWork }[] = [];
  const settled: AccessWork[] = [];
  const sink: AccessWorkSink = {
    reserve(operation, bound) {
      if (operation === refuse) return null;
      admitted.push({ operation, bound });
      return { settle: (actual) => { settled.push(actual); } };
    },
  };
  return { work: new AccessWorkAccounting(sink, Date.now() + 10_000), admitted, settled };
}
const footprint: AccessWork = { keys: 1, points: 2, witnesses: 0, rows: 3, bytes: 40, emptySeeks: 1 };

test('Access reserves before dispatch and reports exact charged work for positive and negative owner results', async () => {
  for (const value of [true, false]) {
    const { work, admitted, settled } = accounting();
    const actual = { ...footprint, rows: value ? footprint.rows : 0, bytes: 7, emptySeeks: 0 };
    const result = await work.capture(() => accessOwnerWork(work, 'owner', {
      bound: () => footprint, actual: () => actual,
    }, {}, async () => {
      expect(admitted).toEqual([{ operation: 'owner', bound: footprint }]);
      expect(work.usage()).toEqual(footprint);
      return value;
    }));
    expect(result).toEqual({ state: 'complete', value, usage: actual });
    expect(settled).toEqual([actual]);
  }
});

test('unproved and refused work never dispatch and report their exact dependency', async () => {
  for (const unproved of [true, false]) {
    const { work, admitted } = accounting(unproved ? undefined : 'owner');
    let called = false;
    const result = await work.capture(() => accessOwnerWork(work, 'owner', unproved ? undefined : {
      bound: () => footprint, actual: () => footprint,
    }, {}, async () => { called = true; return true; }));
    expect(result).toEqual({ state: 'unavailable', dependency: 'owner', usage: EMPTY_ACCESS_WORK });
    expect(called).toBe(false);
    expect(admitted).toHaveLength(0);
  }
});

test('checkout admission refuses before the pool wait and retains a failed dispatched acquisition', async () => {
  const refused = accounting('access.pool-checkout');
  let called = false;
  expect((await refused.work.capture(() => accessCheckout(refused.work, async () => { called = true; }))).state)
    .toBe('unavailable');
  expect(called).toBe(false);
  const failed = accounting();
  await failed.work.capture(() => accessCheckout(failed.work, async () => {
    expect(failed.admitted[0]?.operation).toBe('access.pool-checkout');
    throw new Error('pool acquisition failed');
  }));
  expect(failed.work.usage()).toEqual({ ...EMPTY_ACCESS_WORK, points: 1 });
  expect(failed.work.usage()).toEqual(sum(failed.settled));
});

test('failed, missing and invalid actual receipts retain all dispatched work and poison reuse', async () => {
  for (const failure of ['throw', 'missing', 'row-refund', 'exceeded'] as const) {
    const { work, settled } = accounting();
    const result = await work.capture(() => work.run('owner', footprint, async () => {
      if (failure === 'throw') throw new Error('owner unavailable');
      return true;
    }, () => failure === 'missing' ? undefined : {
      ...footprint, rows: failure === 'row-refund' ? 0 : footprint.rows,
      points: failure === 'exceeded' ? footprint.points + 1 : footprint.points,
    }));
    expect(result.state).not.toBe('complete');
    expect(result.usage).toEqual(footprint);
    expect(settled).toEqual([footprint]);
    let called = false;
    await work.capture(() => work.run('again', EMPTY_ACCESS_WORK, async () => { called = true; }));
    expect(called).toBe(false);
    expect(work.usage()).toEqual(footprint);
  }
});

test('a timeout seals parallel in-flight bounds once, with no late refund or reused unknown work', async () => {
  const { work, settled } = accounting();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const pending = work.run('waiting callback', footprint, () => gate, () => ({ ...footprint, bytes: 0 }));
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
    await work.capture(() => accessNativeWork(work, 'membership', { group: 'bound' }, { groups: 1 }, async () => {
      expect(admitted.at(-1)?.operation).toBe('access.membership');
      if (fail) throw new Error('native connection failed');
      return [];
    }));
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
  const resource = (): Resource => ({ route: 0x1234, id: `00000000-0000-7000-8000-1234${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}` });
  const anonymous: Actor = { kind: 'anonymous' };

  test('public positive, negative and changed final floor use the same formula and retain exact work', async () => {
    for (const initiallyPublic of [true, false]) {
      const { work, admitted, settled } = accounting();
      let published = initiallyPublic;
      let preparations = 0, verifications = 0;
      const target = resource();
      target.eligibility = createResourcePublicEligibility({
        resource: target, action,
        work: {
          prepare: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
          verify: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
        },
        async prepare() { preparations++; return {}; },
        async verify() { verifications++; return published; },
      });
      const access = createAccess({ actions: new Map([[action, { anonymous: true }]]), accountEvidence: () => null });
      const time = await withConnection(pool, (client) => mintReadTime(client));
      try {
        const prepared = await work.capture(() => access.prepare!(anonymous, action, target, { pool, work, time, deadline: work.deadline }));
        expect(prepared.state).toBe('complete');
        if (prepared.state !== 'complete') throw new Error('Preparation failed');
        const decide = () => withConnection(pool, (client) => access.authorize(client, anonymous, action, target, prepared.value, time));
        expect(await decide()).toBe(initiallyPublic);
        published = false;
        expect(await decide()).toBe(false);
        expect(preparations).toBe(1);
        expect(verifications).toBe(2);
        expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(initiallyPublic ? 1 : 0);
        expect(work.usage()).toEqual(sum(settled));
      } finally { releaseOperationalTime(time); }
    }
  });

  test('a callback without its owner producer refuses before callback or SQL dispatch', async () => {
    const { work, admitted } = accounting();
    let called = false;
    const target = resource();
    target.eligibility = createResourcePublicEligibility({ resource: target, action,
      async prepare() { called = true; return {}; }, async verify() { called = true; return true; },
    });
    const access = createAccess({ actions: new Map([[action, { anonymous: true }]]), accountEvidence: () => null });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      expect(await work.capture(() => access.prepare!(anonymous, action, target, { pool, work, time, deadline: work.deadline })))
        .toEqual({ state: 'unavailable', dependency: 'Content resource eligibility.prepare', usage: EMPTY_ACCESS_WORK });
      expect(called).toBe(false);
      expect(admitted).toHaveLength(0);
    } finally { releaseOperationalTime(time); }
  });

  test('real account page shares preparation, rechecks grants/denials, and preserves failed formula work', async () => {
    const target = resource();
    const person = resource().id;
    await pool.query(`INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','active',$3)`, [target.route, person, crypto.randomUUID()]);
    const account = await readAccount(pool, target.route, person);
    if (!account) throw new Error('Missing native account fixture');
    const actor: AccountActor = { kind: 'account', accountId: person, clientId: 'native-work', requestedBy: null, scopes: [action], authnEpoch: 1 };
    const access = createAccess({ actions: new Map([[action, { anonymous: false }]]), accountEvidence: (input) => input === actor ? account : null });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    const { work, admitted, settled } = accounting();
    const other = resource();
    const page = { route: target.route, resourceType: 'test.work', ids: [target.id, other.id] };
    try {
      await pool.query(`INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
        SELECT $1,id,$2,$3,'(,)'::tstzrange,$4 FROM unnest($5::uuid[]) id`,
      [target.route, person, action, crypto.randomUUID(), page.ids]);
      const evidence = await access.preparePage!(actor, action, page, { pool, work, time, deadline: work.deadline });
      expect(await withConnection(pool, (client) => access.authorizePage!(client, actor, action, page, evidence, time))).toBe(true);
      await pool.query(`INSERT INTO access.resource_denial (route,resource_id,subject_id,action,reason,valid,transaction_id)
        VALUES ($1,$2,$3,$4,'resource','(,)'::tstzrange,$5)`, [target.route, target.id, person, action, crypto.randomUUID()]);
      expect(await withConnection(pool, (client) => access.authorizePage!(client, actor, action, page, evidence, time))).toBe(false);
      expect(admitted.filter((item) => item.operation === 'access.inverse')).toHaveLength(1);
      expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(2);
      const before = work.usage();
      const result = await work.capture(() => access.authorizePage!({ query: (() => Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }))) as typeof pool.query }, actor, action, page, evidence, time));
      expect(result.state).toBe('failed');
      expect(work.usage().rows).toBe(before.rows + admitted.at(-1)!.bound.rows);
      expect(work.usage()).toEqual(sum(settled));
    } finally { releaseOperationalTime(time); }
  });

  test('shared read window prepares inventory once, checks each target at its live T, and refuses unproved account authority', async () => {
    const { work, admitted, settled } = accounting();
    const person = resource().id;
    await pool.query(`INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','active',$3)`, [0x1234, person, crypto.randomUUID()]);
    const account = await readAccount(pool, 0x1234, person);
    const actor: AccountActor = { kind: 'account', accountId: person, clientId: 'shared-native-work', requestedBy: null, scopes: [action], authnEpoch: 1 };
    const access = createAccess({ actions: new Map([[action, { anonymous: true }]]), accountEvidence: () => account });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    const anotherTime = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const handle = await access.prepareReadDecisions!({ actor, actions: new Set([action]), time,
        context: { pool, work, time, deadline: work.deadline } });
      for (let i = 0; i < 2; i++) {
        const target = resource();
        const eligibility = Object.assign(async () => ({ [target.id]: true }), {
          work: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
        });
        const decisions = await withConnection(pool, (client) => handle.decide(client,
          { action, resourceType: 'test.work', ids: [target.id], eligibility }, time));
        expect(decisions[target.id]?.allowed).toBe(true);
      }
      expect(admitted.filter((item) => item.operation === 'access.time')).toHaveLength(1);
      expect(admitted.filter((item) => item.operation === 'access.inverse')).toHaveLength(1);
      expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(2);
      expect(work.usage()).toEqual(sum(settled));
      await expect(handle.prepareAccountAuthority!([resource().id])).rejects.toMatchObject({
        dependency: 'Access AccountAuthority current account/operator projection native work producer',
      });
      await expect(withConnection(pool, (client) => handle.decide(client,
        { action, resourceType: 'test.work', ids: [resource().id] }, anotherTime))).rejects.toBeInstanceOf(AccessWorkUnavailableError);
      expect(admitted.filter((item) => item.operation === 'access.formula')).toHaveLength(2);
    } finally { releaseOperationalTime(time); releaseOperationalTime(anotherTime); }
  });

  test('assignment, organization role and final explicit formula are admitted; unproved Realm work is refused', async () => {
    const target = resource();
    const person = resource().id, principal = resource().id, organization = resource().id, realm = resource().id;
    for (const [id, kind] of [[person, 'actor'], [principal, 'actor'], [organization, 'organization']] as const)
      await pool.query(`INSERT INTO access.account (route,account_id,kind,state,transaction_id)
        VALUES ($1,$2,$3,'active',$4)`, [target.route, id, kind, crypto.randomUUID()]);
    const requestId = resource().id;
    await pool.query(`INSERT INTO access.principal_assignment
      (route,principal_id,request_id,assigned_actor_id,valid,issued_valid,creator_principal_id,transaction_id)
      VALUES ($1,$2,$3,$4,'(,)'::tstzrange,'(,)'::tstzrange,$2,$5)`,
      [target.route, principal, requestId, person, crypto.randomUUID()]);
    await pool.query(`INSERT INTO access.membership_inverse
      (route,account_id,kind,group_id,reservation_id,transaction_id)
      VALUES ($1,$2,'organization',$3,$4,$5)`, [target.route, person, organization, crypto.randomUUID(), crypto.randomUUID()]);
    await pool.query(`INSERT INTO access.organization_member
      (route,organization_id,member_account_id,role,valid,transaction_id)
      VALUES ($1,$2,$3,'member','(,)'::tstzrange,$4)`, [target.route, organization, person, crypto.randomUUID()]);
    for (const [id, role] of [[organization, 'member'], [principal, '']] as const)
      await pool.query(`INSERT INTO access.resource_grant
        (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
        VALUES ($1,$2,$3,$4,$5,'(,)'::tstzrange,$6)`, [target.route, target.id, id, role, action, crypto.randomUUID()]);
    const account = await readAccount(pool, target.route, person);
    const actor: AccountActor = { kind: 'account', accountId: person, clientId: 'delegated-native-work',
      requestedBy: `urn:rezics:request:${principal}:${requestId}`, scopes: [action], authnEpoch: 1 };
    let realmCalls = 0;
    const access = createAccess({ actions: new Map([[action, { anonymous: false }]]), accountEvidence: () => account,
      realmRoleReader: async () => { realmCalls++; return null; } });
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const { work, admitted, settled } = accounting();
      const evidence = await access.prepare!(actor, action, target, { pool, work, time, deadline: work.deadline });
      expect(await withConnection(pool, (client) => access.authorizeExplicit!(client, actor, action, target, evidence, time)))
        .toEqual({ allowed: true, explicit: true });
      for (const operation of ['assignment', 'inverse', 'candidates', 'membership', 'formula'])
        expect(admitted.some((entry) => entry.operation === `access.${operation}`)).toBe(true);
      expect(work.usage()).toEqual(sum(settled));
      await pool.query(`INSERT INTO access.membership_inverse
        (route,account_id,kind,group_id,reservation_id,transaction_id)
        VALUES ($1,$2,'realm',$3,$4,$5)`, [target.route, person, realm, crypto.randomUUID(), crypto.randomUUID()]);
      await pool.query(`INSERT INTO access.resource_grant
        (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
        VALUES ($1,$2,$3,'member',$4,'(,)'::tstzrange,$5)`, [target.route, target.id, realm, action, crypto.randomUUID()]);
      const refused = accounting();
      const result = await refused.work.capture(() => access.prepare!(actor, action, target,
        { pool, work: refused.work, time, deadline: refused.work.deadline }));
      expect(result.state).toBe('unavailable');
      if (result.state === 'unavailable') expect(result.dependency).toBe('Content AccessRealmRoleReader');
      expect(realmCalls).toBe(0);
      expect(result.usage).toEqual(sum(refused.settled));
      expect(result.usage.rows).toBeGreaterThan(0);
      let buyerCalls = 0;
      const benefitAccess = createAccess({ actions: new Map([['edition:read', { anonymous: false }]]),
        accountEvidence: () => account,
        contentEditionBuyerFactReader: async () => { buyerCalls++; return null; },
      });
      const buyerActor = { ...actor, scopes: ['edition:read'] };
      const benefitTarget: Resource = { ...target, authenticatedBenefit: {
        kind: 'content-edition', resourceType: 'content.edition', resource: target, action: 'edition:read',
        version: { revisionId: resource().id, sha256: 'a'.repeat(64) },
      } };
      const commerce = accounting();
      const buyerResult = await commerce.work.capture(() => benefitAccess.prepare!(buyerActor, 'edition:read', benefitTarget,
        { pool, work: commerce.work, time, deadline: commerce.work.deadline }));
      expect(buyerResult.state).toBe('unavailable');
      if (buyerResult.state === 'unavailable') expect(buyerResult.dependency).toBe('Commerce ContentEditionBuyerFactReader');
      expect(buyerCalls).toBe(0);
      expect(buyerResult.usage).toEqual(sum(commerce.settled));
      expect(commerce.admitted.map((entry) => entry.operation)).toEqual(['access.time', 'access.assignment']);
    } finally { releaseOperationalTime(time); }
  });

});

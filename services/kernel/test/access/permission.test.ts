import { afterAll, beforeEach, expect, test } from 'bun:test';
import pg from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess, checkPermission, checkDelegationBounds } from '../../src/access/permission.ts';
import { AccessUnavailableError, createResourcePublicEligibility } from '../../src/access/index.ts';
import {
  accessCheck,
  accessExplicitCheck,
  prepareReadDecisions,
  type AccountActor,
  type Actor,
  type Resource,
} from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
// A single connection also detects any nested checkout during final authorization.
const pool = new pg.Pool({ connectionString: url, max: 1 });
afterAll(() => pool.end());
const id = (route: string, suffix: string) => `00000000-0000-7000-8000-${route}${suffix.padStart(8, '0')}`;
const actorId = id('1234', '1');
const principalId = id('2345', '2');
const otherId = id('3456', '3');
const orgId = id('4567', '4');
const otherOrgId = id('5678', '5');
const requestId = id('2345', '6');
const transactionId = id('1234', '7');
const resource: Resource = { route: 0x6789, id: id('6789', '8') };
const otherResource: Resource = { route: 0x789a, id: id('789a', '9') };
const action = 'subject:read';
const actions = new Map([
  [action, { anonymous: false }],
  ['subject:update', { anonymous: false }],
  ['access:grant', { anonymous: false }],
  ['subject:public', { anonymous: true }],
]);
const identity = (overrides: Partial<AccountActor> = {}): AccountActor => ({
  kind: 'account',
  accountId: actorId,
  clientId: 'third-party',
  scopes: [action],
  authnEpoch: 1,
  requestedBy: `urn:rezics:request:${principalId}:${requestId}`,
  ...overrides,
});
const routeOf = (accountId: string) => Number.parseInt(accountId.slice(24, 28), 16);
const allTime = '(,)';

async function grant(subject = actorId, verb = action, target = resource, role = '', valid = allTime) {
  await pool.query(
    `INSERT INTO access.resource_grant
    (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6::tstzrange,$7)`,
    [target.route, target.id, subject, role, verb, valid, transactionId],
  );
}
async function deny(subject = actorId, valid = allTime, kind = 'resource', verb = action, role = '') {
  await pool.query(
    `INSERT INTO access.resource_denial
    (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7::tstzrange,$8)`,
    [resource.route, resource.id, subject, role, verb, kind, valid, transactionId],
  );
}
async function removeGrant(subject: string) {
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    resource.route,
    resource.id,
    subject,
  ]);
}
async function membership(role = 'owner', member = actorId, organization = orgId, valid = allTime) {
  await pool.query(
    `INSERT INTO access.membership_inverse
    (route,account_id,kind,group_id,reservation_id,transaction_id)
    VALUES ($1,$2,'organization',$3,$4,$4) ON CONFLICT DO NOTHING`,
    [routeOf(member), member, organization, transactionId],
  );
  await pool.query(
    `INSERT INTO access.organization_member
    (route,organization_id,member_account_id,role,valid,transaction_id) VALUES ($1,$2,$3,$4,$5::tstzrange,$6)`,
    [routeOf(organization), organization, member, role, valid, transactionId],
  );
}
async function organizationGrant() {
  await removeGrant(actorId);
  await grant(orgId, action, resource, 'owner');
  await membership();
}
async function context(actor: Actor = identity(), deadline = Date.now() + 5000) {
  return {
    pool,
    deadline,
    account: actor.kind === 'account' ? await readAccount(pool, routeOf(actor.accountId), actor.accountId) : null,
  };
}
const access = createAccess({ actions, accountEvidence: (_actor, ctx) => ctx.account });
async function prepare(actor: Actor = identity(), verb = action, target = resource, deadline?: number) {
  return accessCheck(access, actor, verb, target, await context(actor, deadline));
}
async function run(actor: Actor = identity(), verb = action, target = resource) {
  const check = await prepare(actor, verb, target);
  const client = await pool.connect();
  try {
    return await check(client);
  } finally {
    client.release();
  }
}
async function unavailable(table: string, body: () => Promise<void>) {
  await pool.query(`ALTER TABLE access.${table} RENAME TO unavailable`);
  try {
    await body();
  } finally {
    await pool.query(`ALTER TABLE access.unavailable RENAME TO ${table}`);
  }
}

beforeEach(async () => {
  await pool.query('TRUNCATE access.membership_inverse');
  await pool.query(`CREATE TABLE IF NOT EXISTS permission_public_fixture
    (route integer, id uuid, published boolean, valid tstzrange, PRIMARY KEY (route,id))`);
  await pool.query('DELETE FROM permission_public_fixture');
  for (const target of [resource, { ...resource, id: id('6789', '10') }])
    await pool.query("INSERT INTO permission_public_fixture VALUES ($1,$2,true,'(,)')", [target.route, target.id]);
  for (const table of ['resource_grant', 'resource_denial', 'principal_assignment', 'organization_member', 'account']) {
    await pool.query(`DELETE FROM access.${table}`);
  }
  for (const accountId of [actorId, principalId, otherId, orgId, otherOrgId]) {
    await pool.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,$3,'active',$4)`,
      [
        routeOf(accountId),
        accountId,
        [orgId, otherOrgId].includes(accountId) ? 'organization' : 'actor',
        transactionId,
      ],
    );
  }
  await pool.query(
    `INSERT INTO access.principal_assignment
    (route,principal_id,request_id,assigned_actor_id,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$5)`,
    [routeOf(principalId), principalId, requestId, actorId, transactionId],
  );
  await grant();
  await grant(principalId);
});

test('actor grant, verified consented scope and principal grant independently cap the same operation', async () => {
  expect(await run()).toBe(true);
  await removeGrant(actorId);
  expect(await run()).toBe(false);
  await grant();
  expect(await run(identity({ scopes: [] }))).toBe(false);
  expect(await run()).toBe(true);
  await removeGrant(principalId);
  expect(await run()).toBe(false);
  expect(await run(identity({ requestedBy: null }))).toBe(true);
});

test('scalar, explicit and batched decisions admit 1000 inverse entries per operand and fail closed beyond coverage', async () => {
  const groups = Array.from({ length: 1001 }, () => newId(0x4567));
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     SELECT $1,id,'organization','active',$3 FROM unnest($2::uuid[]) id`,
    [0x4567, groups, transactionId],
  );
  for (const subject of [actorId, principalId]) {
    await removeGrant(subject);
    // Only the last admitted group supplies authority. The other 999 rows are
    // admission evidence, with real negative organization membership proofs.
    await membership('owner', subject, groups[999]!);
    await pool.query(
      `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
       SELECT $1,$2,'organization',id,id,$4 FROM unnest($3::uuid[]) id ON CONFLICT DO NOTHING`,
      [routeOf(subject), subject, groups.slice(0, 1000), transactionId],
    );
  }
  await grant(groups[999]!, action, resource, 'owner');
  const ordinary = identity({ requestedBy: null });
  const delegated = identity();
  async function decisions(actor: AccountActor, allowed: boolean) {
    const ctx = await context(actor);
    expect(await (await accessCheck(access, actor, action, resource, ctx))(pool)).toBe(allowed);
    expect(await (await accessExplicitCheck(access, actor, action, resource, await context(actor)))(pool)).toEqual({
      allowed,
      explicit: allowed,
    });
    const input = { actor, context: await context(actor), actions: new Set([action]) };
    if (!allowed) {
      await expect(prepareReadDecisions(access, input)).rejects.toBeInstanceOf(AccessUnavailableError);
      return;
    }
    const prepared = await prepareReadDecisions(access, input);
    expect(
      await prepared.decide(pool, { action, resourceType: 'subject', ids: [resource.id, otherResource.id] }),
    ).toEqual({
      [resource.id]: { allowed: true, explicit: true },
      [otherResource.id]: { allowed: false, explicit: false },
    });
  }
  await decisions(ordinary, true);
  await decisions(delegated, true);
  for (const subject of [actorId, principalId]) {
    const actor = subject === actorId ? ordinary : delegated;
    await pool.query(
      `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
       VALUES ($1,$2,'organization',$3,$3,$4)`,
      [routeOf(subject), subject, groups[1000], transactionId],
    );
    await decisions(actor, false);
    await pool.query('DELETE FROM access.membership_inverse WHERE route=$1 AND account_id=$2 AND group_id=$3', [
      routeOf(subject),
      subject,
      groups[1000],
    ]);
    await pool.query('UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2', [
      routeOf(subject),
      subject,
    ]);
    await decisions(actor, false);
    await pool.query('UPDATE access.account SET membership_inverse_complete=true WHERE route=$1 AND account_id=$2', [
      routeOf(subject),
      subject,
    ]);
    await decisions(actor, true);
  }
  // A cached actor observation cannot stand in for missing inverse coverage.
  const ctx = await context(ordinary);
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(actorId), actorId]);
  expect(await (await accessCheck(access, ordinary, action, resource, ctx))(pool)).toBe(false);
  expect(await (await accessExplicitCheck(access, ordinary, action, resource, ctx))(pool)).toEqual({
    allowed: false,
    explicit: false,
  });
  await expect(
    prepareReadDecisions(access, { actor: ordinary, context: ctx, actions: new Set([action]) }),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
});

test('resource, actor and action must match; operators and first-party preconsent supply no grants', async () => {
  expect(await run()).toBe(true);
  await removeGrant(actorId);
  await grant(otherId);
  await grant(actorId, action, otherResource);
  await grant(actorId, 'subject:update');
  await pool.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(actorId),
    actorId,
    principalId,
  ]);
  expect(await run()).toBe(false);
  expect(await run(identity({ clientId: 'first-party' }))).toBe(false);
  await grant();
  expect(await run(identity({ scopes: [action, 'unknown:action'] }), 'unknown:action')).toBe(false);
  expect(await run(identity({ scopes: [action, 'arbitrary:read'] }), 'arbitrary:read')).toBe(false);
});

test('the already-read actor state and epoch fail closed without an actor reread', async () => {
  expect(await run()).toBe(true);
  for (const state of ['pending', 'suspended', 'deleted']) {
    await pool.query('UPDATE access.account SET state=$3 WHERE route=$1 AND account_id=$2', [
      routeOf(actorId),
      actorId,
      state,
    ]);
    expect(await run()).toBe(false);
  }
  await pool.query("UPDATE access.account SET state='active',minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2", [
    routeOf(actorId),
    actorId,
  ]);
  expect(await run()).toBe(false);
  expect(await run(identity({ authnEpoch: 2 }))).toBe(true);
  const actor = identity({ authnEpoch: 2, requestedBy: null });
  const ctx = await context(actor);
  await unavailable('account', async () => {
    const check = await accessCheck(access, actor, action, resource, ctx);
    expect(await check(pool)).toBe(true);
  });
  expect(await access.authorize(pool, actor, action, resource)).toBe(false);
  const missing = createAccess({ actions, accountEvidence: () => null });
  expect(await (await accessCheck(missing, actor, action, resource, ctx))(pool)).toBe(false);
});

test('unresolved account, grant, assignment and membership reads deny at the production boundary', async () => {
  expect(await run()).toBe(true);
  await unavailable('account', async () => {
    const missing = createAccess({
      actions,
      accountEvidence: () => {
        throw new Error('unresolved account');
      },
    });
    expect(
      await (
        await accessCheck(missing, identity(), action, resource, { pool, deadline: Date.now() + 5000 })
      )(pool),
    ).toBe(false);
  });
  for (const table of ['resource_grant', 'resource_denial', 'principal_assignment']) {
    await unavailable(table, async () => {
      expect(await run()).toBe(false);
    });
  }
  await organizationGrant();
  expect(await run()).toBe(true);
  await unavailable('organization_member', async () => {
    expect(await run()).toBe(false);
  });
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(principalId), principalId]);
  expect(await run()).toBe(false);
});

test('grant ranges use exact inclusive start and exclusive end at the final database authority time', async () => {
  for (const subject of [actorId, principalId]) {
    await removeGrant(subject);
    await grant(subject, action, resource, '', '[2030-01-01,2030-01-02)');
    const statement = (await import('../../src/access/permission-check.sql')).default;
    const sql = statement.sql.replace('transaction_timestamp()', '$99::timestamptz');
    // Replace the clock expression only; all grant/denial decisions remain the production SQL.
    const parameters = {
      route: resource.route,
      resource_ids: [resource.id],
      include_global: false,
      action,
      actor_id: actorId,
      principal_id: principalId,
      anonymous: false,
      floor: false,
      at: null,
      roles: '[]',
      deadline: 'infinity',
    };
    const values = statement.params.map((key) => parameters[key as keyof typeof parameters]);
    const atParameter = values.length + 1;
    for (const [at, allowed] of [
      ['2029-12-31T23:59:59.999999Z', false],
      ['2030-01-01T00:00:00Z', true],
      ['2030-01-01T23:59:59.999999Z', true],
      ['2030-01-02T00:00:00Z', false],
    ] as const) {
      const result = await pool.query(sql.replace('$99', `$${atParameter}`), [...values, at]);
      expect(result.rows[0].allowed).toBe(allowed);
    }
    await removeGrant(subject);
    await grant(subject);
  }
});

test('native WITHOUT OVERLAPS rejects overlapping grant intervals and invalid range forms', async () => {
  await removeGrant(actorId);
  await grant(actorId, action, resource, '', '[2030-01-01,2030-01-02)');
  expect(await grant(actorId, action, resource, '', '[2030-01-01,2030-01-03)').catch((e) => e.code)).toBe('23P01');
  await grant(actorId, action, resource, '', '[2030-01-02,2030-01-03)');
  for (const interval of ['empty', '(2031-01-01,2031-01-02]', '[2031-01-01,2031-01-02]']) {
    expect(await grant(actorId, action, resource, '', interval).catch((e) => e.code)).toBe('23514');
  }
  const result = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='access.resource_grant'::regclass AND contype='p'`);
  expect(result.rows[0].definition).toContain('WITHOUT OVERLAPS');
});

test('future and expired explicit resource/Realm denials do not block; active bans override either operand', async () => {
  for (const subject of [actorId, principalId]) {
    await deny(subject, '[2099-01-01,2100-01-01)');
    await deny(subject, '[2000-01-01,2001-01-01)');
    expect(await run()).toBe(true);
    await deny(subject, '(,)', 'realm_ban');
    expect(await run()).toBe(false);
    await pool.query('DELETE FROM access.resource_denial WHERE route=$1', [resource.route]);
  }
  for (const reason of ['resource', 'suspension', 'realm_ban']) {
    await deny(actorId, '(,)', reason);
    expect(await run()).toBe(false);
    await pool.query('DELETE FROM access.resource_denial WHERE route=$1', [resource.route]);
  }
});

test('organization evidence is separately anchored, role-specific and excludes automated members', async () => {
  await organizationGrant();
  expect(await run()).toBe(true);
  for (const [role, member, organization, valid] of [
    ['member', actorId, orgId, allTime],
    ['owner', otherId, orgId, allTime],
    ['owner', actorId, otherOrgId, allTime],
    ['owner', actorId, orgId, '[2000-01-01,2001-01-01)'],
    ['owner', actorId, orgId, '[2099-01-01,2100-01-01)'],
  ]) {
    await pool.query('DELETE FROM access.organization_member');
    await membership(role, member, organization, valid);
    expect(await run()).toBe(false);
  }
  await pool.query('DELETE FROM access.organization_member');
  await membership();
  expect(await run()).toBe(true);
  await pool.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(actorId),
    actorId,
    principalId,
  ]);
  expect(await run()).toBe(false);
  expect(await run(identity({ accountId: orgId, requestedBy: null }))).toBe(false);
});

test('principal-created assignments bind canonical requestedBy, principal state and assigned actor', async () => {
  expect(await run()).toBe(true);
  for (const requestedBy of [
    principalId,
    `urn:rezics:request:${otherId}:${requestId}`,
    `urn:rezics:request:${principalId}:${actorId}`,
    `urn:rezics:request:${principalId}:${requestId}:extra`,
  ]) {
    expect(await run(identity({ requestedBy }))).toBe(false);
  }
  await pool.query('UPDATE access.principal_assignment SET assigned_actor_id=$2 WHERE route=$1', [
    routeOf(principalId),
    otherId,
  ]);
  expect(await run()).toBe(false);
  await pool.query('UPDATE access.principal_assignment SET assigned_actor_id=$2 WHERE route=$1', [
    routeOf(principalId),
    actorId,
  ]);
  for (const state of ['suspended', 'deleted']) {
    await pool.query('UPDATE access.account SET state=$2 WHERE route=$1', [routeOf(principalId), state]);
    expect(await run()).toBe(false);
  }
});

test('prepared evidence is opaque, bound to identity/action/resource/deadline and expires on delayed attempts', async () => {
  const actor = identity();
  const ctx = await context(actor);
  const evidence = await access.prepare!(actor, action, resource, ctx);
  expect(await checkPermission(pool, actor, action, resource, evidence)).toBe(true);
  expect(await access.authorize(pool, actor, action, resource, {})).toBe(false);
  expect(await access.authorize(pool, actor, action, resource, { ...(evidence as object) })).toBe(false);
  expect(await access.authorize(pool, identity({ clientId: 'other' }), action, resource, evidence)).toBe(false);
  expect(await access.authorize(pool, actor, 'subject:update', resource, evidence)).toBe(false);
  expect(await access.authorize(pool, actor, action, otherResource, evidence)).toBe(false);
  await expect(prepare(actor, action, resource, Date.now() - 1)).rejects.toBeInstanceOf(AccessUnavailableError);
  const delayed = await prepare(actor, action, resource, Date.now() + 80);
  expect(await delayed(pool)).toBe(true);
  await Bun.sleep(100);
  await expect(delayed(pool)).rejects.toBeInstanceOf(AccessUnavailableError);
});

test('every final attempt rechecks grants and denials on its resource client without pool reads', async () => {
  const check = await prepare();
  const client = await pool.connect();
  try {
    expect(await check(client)).toBe(true);
    await client.query('DELETE FROM access.resource_grant WHERE route=$1 AND subject_id=$2', [resource.route, actorId]);
    expect(await check(client)).toBe(false);
  } finally {
    client.release();
  }
  await grant();
  const repeated = await prepare();
  expect(await repeated(pool)).toBe(true);
  await deny();
  expect(await repeated(pool)).toBe(false);
});

test('membership and assignment expiry cannot be bypassed by prepared evidence on retry', async () => {
  await organizationGrant();
  await pool.query(`UPDATE access.organization_member SET valid=tstzrange(clock_timestamp()-interval '1 second',
    clock_timestamp()+interval '250 milliseconds','[)')`);
  const check = await prepare();
  expect(await check(pool)).toBe(true);
  await Bun.sleep(280);
  expect(await check(pool)).toBe(false);
  await pool.query("UPDATE access.organization_member SET valid='(,)'::tstzrange");
  await pool.query(`UPDATE access.principal_assignment SET valid=tstzrange(clock_timestamp()-interval '1 second',
    clock_timestamp()+interval '250 milliseconds','[)')`);
  const assignment = await prepare();
  expect(await assignment(pool)).toBe(true);
  await Bun.sleep(280);
  expect(await assignment(pool)).toBe(false);
});

test('known anonymous metadata needs current publication and retains targeted final denials', async () => {
  const anonymous: Actor = { kind: 'anonymous' };
  const published: Resource = {
    ...resource,
    eligibility: createResourcePublicEligibility({
      resource,
      action: 'subject:public',
      async prepare({ pool: source }) {
        const targets = [resource, { ...resource, id: id('6789', '10') }];
        for (const target of targets) {
          const { rows } = await source.query('SELECT id FROM permission_public_fixture WHERE route=$1 AND id=$2', [
            target.route,
            target.id,
          ]);
          if (rows.length !== 1) return null;
        }
        return targets;
      },
      async verify({ client, at, evidence }) {
        for (const target of evidence) {
          const { rows } = await client.query(
            `SELECT published AND valid @> $3::timestamptz AS current
            FROM permission_public_fixture WHERE route=$1 AND id=$2`,
            [target.route, target.id, at],
          );
          if (rows.length !== 1 || rows[0].current !== true) return false;
        }
        return true;
      },
    }),
  };
  expect(await run(anonymous, 'subject:public', published)).toBe(true);
  expect(await run(anonymous, 'subject:public')).toBe(false);
  expect(await run(anonymous, action)).toBe(false);
  expect(await run(anonymous, 'arbitrary:read')).toBe(false);
  expect(await run(identity({ scopes: [] }), 'subject:public', published)).toBe(true);
  await deny(actorId, '(,)', 'resource', 'subject:public');
  expect(await run(identity({ scopes: [] }), 'subject:public', published)).toBe(false);
  expect(await run(anonymous, 'subject:public', published)).toBe(true);
  await pool.query('UPDATE permission_public_fixture SET published=false WHERE id=$1', [resource.id]);
  expect(await run(anonymous, 'subject:public', published)).toBe(false);
});

test('delegation bounds check every proposed action against the grantor effective permissions', async () => {
  const actor = identity({ requestedBy: null, scopes: [action, 'subject:update', 'access:grant'] });
  await grant(actorId, 'subject:update');
  await grant(actorId, 'access:grant');
  const ctx = await context(actor);
  const bound = await checkDelegationBounds(access, actor, [action, 'subject:update'], resource, ctx);
  expect(await bound(pool)).toBe(true);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND action=$2', [
    resource.route,
    'subject:update',
  ]);
  expect(await bound(pool)).toBe(false);
  expect(await (await checkDelegationBounds(access, actor, ['unknown:action'], resource, ctx))(pool)).toBe(false);
  expect(await (await checkDelegationBounds(access, actor, [], resource, ctx))(pool)).toBe(false);
});

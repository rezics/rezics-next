import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  assertRealmOwnerMayLeave,
  createAccess,
  readRealmOwnerLeaveObservation,
  readRealmOwnershipRoles,
  RealmLastOwnerError,
} from '../../src/access/index.ts';
import { problemResponse } from '../../src/http/problem.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { ResourceAccessWriteDeniedError } from '../../src/access/resource-denials.ts';
import { authoritativeTimeValue, currentCommand, mintReadTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { accessCheck } from '../../src/request/access.ts';
import { grantCommand, type GrantCommandContext } from '../../src/access/grant-command.ts';
import { newId } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

const owner = 'community.realm.owner';
const administrator = 'community.realm.administrator';
const moderator = 'community.realm.moderator';
const actions = [
  'realm:read',
  'realm:manage',
  'realm:ban',
  'realm:publish',
  'board:create',
  'moderation:takedown',
  'realm:participate',
  'realm:join',
];
let f: Awaited<ReturnType<typeof grantFixture>>;
let commands: ReturnType<typeof createGrantCommands>;
beforeAll(async () => {
  f = await grantFixture(actions);
  f.pool.options.max = 2;
  commands = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
}, 30_000);
beforeEach(async () => {
  await f.reset();
  await f.reader.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
    f.resource.route,
    f.resource.id,
  ]);
  await f.reader.query(
    `INSERT INTO access.resource_initialization
    (route,resource_id,resource_type,creator_id,initialized_at)
    VALUES ($1,$2,'community.realm',$3,clock_timestamp()) ON CONFLICT DO NOTHING`,
    [f.resource.route, f.resource.id, f.actor],
  );
  // Keep the grantor's independent authority so that a successful receipt can
  // still be replayed after transferring its explicit owner role.
  for (const action of actions) await f.grant(f.actor, action);
  await role(f.actor);
});
afterAll(() => f?.close());
function input(accountId = f.actor, roleName = owner, valid = '(,)') {
  return {
    resource: f.resource,
    subject: { kind: 'account' as const, id: accountId },
    role: roleName,
    valid,
    key: Bun.randomUUIDv7(),
  };
}
async function role(accountId: string, roleName = owner, valid = '(,)', subjectRole = '') {
  await f.reader.query(
    `INSERT INTO access.resource_role_grant
    (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
    VALUES ($1,$2,'identity',$3,$4,$5,$6::tstzrange,$7)`,
    [f.resource.route, f.resource.id, accountId, subjectRole, roleName, valid, newId(f.resource.route)],
  );
}
async function owners() {
  return (
    await f.reader.query<{ subject_id: string }>(
      `SELECT subject_id FROM access.resource_role_grant
    WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_role=''
      AND grant_role=$3 AND valid @> clock_timestamp() ORDER BY subject_id`,
      [f.resource.route, f.resource.id, owner],
    )
  ).rows.map((row) => row.subject_id);
}

test('a sole explicit Realm owner cannot revoke, demote or close its interval', async () => {
  const context = await f.context();
  const before = await f.snapshot();
  await expect(commands.revokeRole(context, input())).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    commands.changeRole(context, { ...input(f.actor, moderator), previous: { role: owner, valid: '(,)' } }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    commands.changeRole(context, {
      ...input(f.actor, owner, '(,2100-01-01)'),
      previous: { role: owner, valid: '(,)' },
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await owners()).toEqual([f.actor]);
  expect(await f.snapshot()).toEqual(before);
});

test('one native transfer establishes the new holder before releasing the sole owner and replays its result', async () => {
  const context = await f.context();
  const request = {
    resource: f.resource,
    fromAccountId: f.actor,
    toAccountId: f.recipient,
    previousValid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  const result = await commands.transferRealmOwner(context, request);
  expect(result.value.subject).toEqual({ kind: 'account', id: f.recipient });
  expect(await owners()).toEqual([f.recipient]);
  expect(await commands.transferRealmOwner(context, request)).toEqual({ ...result, replayed: true });
  // Current scope and grantor authority are still checked before the receipt.
  await f.reader.query(
    `DELETE FROM access.resource_grant
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='access:grant'`,
    [f.resource.route, f.resource.id, f.actor],
  );
  await expect(commands.transferRealmOwner(context, request)).rejects.toBeInstanceOf(GrantDeniedError);
});

test('a failed exact transfer rolls back the new holder and a nonexistent recipient is refused', async () => {
  const context = await f.context();
  const request = {
    resource: f.resource,
    fromAccountId: f.actor,
    toAccountId: f.recipient,
    previousValid: '[2000-01-01,)',
    key: Bun.randomUUIDv7(),
  };
  await expect(commands.transferRealmOwner(context, request)).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await owners()).toEqual([f.actor]);
  await expect(
    commands.transferRealmOwner(context, {
      ...request,
      previousValid: '(,)',
      toAccountId: newId(0x3456),
      key: Bun.randomUUIDv7(),
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await owners()).toEqual([f.actor]);
});

test('concurrent native revocations cannot both hand back the last ownership', async () => {
  await role(f.recipient);
  const context = await f.context();
  const results = await Promise.allSettled([
    commands.revokeRole(context, input(f.actor)),
    commands.revokeRole(context, input(f.recipient)),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(await owners()).toHaveLength(1);
});

test('organization owner/member groups and action copies do not become explicit successor owners', async () => {
  await role(f.principal, owner, '(,)', 'owner');
  for (const action of ['access:grant', ...actions]) await f.grant(f.recipient, action);
  await expect(commands.revokeRole(await f.context(), input())).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await owners()).toEqual([f.actor]);
});

test('the leave guard belongs inside the real authorized resource command, never a released preflight', async () => {
  const at = await mintReadTime(f.pool);
  await expect(
    assertRealmOwnerMayLeave(f.pool, { resource: f.resource, accountId: f.actor, at }),
  ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
  await role(f.recipient);
  const result = await grantCommand(
    { pool: f.pool, access: f.access },
    await f.context(),
    {
      resource: f.resource,
      actions: ['realm:manage'],
      kind: 'access.role-grant.revoke',
      key: Bun.randomUUIDv7(),
      input: { leave: f.actor },
      denied: () => new GrantDeniedError(),
    },
    async (tx) => {
      await assertRealmOwnerMayLeave(tx, { resource: f.resource, accountId: f.actor, at: currentCommand(tx).time });
      // This fixture performs the caller's actual removal in the same transaction.
      await tx.query(
        `DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
      AND subject_id=$3 AND subject_role='' AND grant_role=$4`,
        [f.resource.route, f.resource.id, f.actor, owner],
      );
      return { resource: f.resource, subject: { kind: 'account' as const, id: f.actor }, role: owner, valid: '(,)' };
    },
  );
  expect(result.replayed).toBe(false);
  expect(await owners()).toEqual([f.recipient]);
});

test('read-only owner leave advice follows exact read admission and the native holder predicate', async () => {
  const context = await f.context();
  const disclose = await accessCheck(f.access, context.actor, 'realm:read', f.resource, context);
  await withConnection(f.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const at = await mintReadTime(client);
    expect(await disclose(client, at)).toBe(true);
    const observation = await readRealmOwnerLeaveObservation(client, { resource: f.resource, accountId: f.actor, at });
    expect(observation).toMatchObject({ owner: true, remaining: false });
    expect(observation.source).toBeString();
    await client.query('COMMIT');
  });

  await role(f.recipient);
  let originalSource = '';
  await withConnection(f.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const at = await mintReadTime(client);
    expect(await disclose(client, at)).toBe(true);
    const observation = await readRealmOwnerLeaveObservation(client, { resource: f.resource, accountId: f.actor, at });
    expect(observation).toMatchObject({ owner: true, remaining: true });
    expect(observation.source).toBeString();
    originalSource = observation.source!;
    await client.query('COMMIT');
  });

  await f.reader.query(
    `DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
      AND subject_id=$3 AND subject_role='' AND grant_role=$4`,
    [f.resource.route, f.resource.id, f.actor, owner],
  );
  await role(f.actor);
  await withConnection(f.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const at = await mintReadTime(client);
    expect(await disclose(client, at)).toBe(true);
    const observation = await readRealmOwnerLeaveObservation(client, { resource: f.resource, accountId: f.actor, at });
    expect(observation).toMatchObject({ owner: true, remaining: true });
    expect(observation.source).not.toBe(originalSource);
    await client.query('COMMIT');
  });
});

test('private current role ordering excludes an uninstalled administrator and ignores groups', async () => {
  await role(f.actor, administrator);
  await role(f.actor, moderator);
  await role(f.actor, 'community.realm.member');
  await role(f.actor, 'community.realm.standing');
  await role(f.recipient, administrator, '(,)', 'member');
  const at = await mintReadTime(f.pool);
  const rows = await readRealmOwnershipRoles(f.pool, { resource: f.resource, accountId: f.actor, at });
  expect(rows.map(({ role, rank }) => [role, rank])).toEqual([
    [owner, 4],
    [moderator, 2],
    ['community.realm.member', 1],
    ['community.realm.standing', 1],
  ]);
  expect(
    await readRealmOwnershipRoles(f.pool, { resource: f.resource, accountId: f.actor, at, access: f.access }),
  ).toEqual(rows);
  expect(await readRealmOwnershipRoles(f.pool, { resource: f.resource, accountId: f.recipient, at })).toEqual([]);
  const catalogue = resolveResourceRoles(new Map([...actions, 'access:grant'].map((action) => [action, {}])));
  expect(catalogue.roles.has(administrator)).toBe(false);
  const unmounted = createAccess({ actions: new Map() });
  expect(
    await readRealmOwnershipRoles(f.pool, { resource: f.resource, accountId: f.actor, at, access: unmounted }),
  ).toEqual([]);
});

test('transfer to an existing explicit owner preserves its actual interval and replays the handback', async () => {
  await role(f.recipient, owner, '[2000-01-01,)');
  const context = await f.context();
  const request = {
    resource: f.resource,
    fromAccountId: f.actor,
    toAccountId: f.recipient,
    previousValid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  const before = await f.reader.query(
    `SELECT valid::text, transaction_id FROM access.resource_role_grant
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND subject_role='' AND grant_role=$4`,
    [f.resource.route, f.resource.id, f.recipient, owner],
  );
  const result = await commands.transferRealmOwner(context, request);
  expect(result.value.valid).toBe(before.rows[0].valid);
  expect(await owners()).toEqual([f.recipient]);
  expect(
    (
      await f.reader.query(
        `SELECT valid::text, transaction_id FROM access.resource_role_grant
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND subject_role='' AND grant_role=$4`,
        [f.resource.route, f.resource.id, f.recipient, owner],
      )
    ).rows,
  ).toEqual(before.rows);
  expect(await commands.transferRealmOwner(context, request)).toEqual({ ...result, replayed: true });
});

test('role data uses exact half-open T even for an erased identity and is not live successor eligibility', async () => {
  const at = await mintReadTime(f.pool);
  const end = authoritativeTimeValue(at);
  await role(f.recipient, administrator, `(,${end})`);
  await role(f.recipient, moderator, `[${end},)`);
  await f.reader.query("UPDATE access.account SET state='deleted' WHERE account_id=$1", [f.recipient]);
  expect(
    (await readRealmOwnershipRoles(f.pool, { resource: f.resource, accountId: f.recipient, at })).map(
      ({ role }) => role,
    ),
  ).toEqual([moderator]);
});

test('transfer refuses a historical owner interval even when the source also holds a current owner grant', async () => {
  await f.reader.query(
    `UPDATE access.resource_role_grant SET valid='[2010-01-01,)'::tstzrange
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role=$4`,
    [f.resource.route, f.resource.id, f.actor, owner],
  );
  await role(f.actor, owner, '[2000-01-01,2001-01-01)');
  const before = await f.snapshot();
  await expect(
    commands.transferRealmOwner(await f.context(), {
      resource: f.resource,
      fromAccountId: f.actor,
      toAccountId: f.recipient,
      previousValid: '[2000-01-01,2001-01-01)',
      key: Bun.randomUUIDv7(),
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await owners()).toEqual([f.actor]);
  expect(await f.snapshot()).toEqual(before);
  const history = await f.reader.query(
    `SELECT 1 FROM access.resource_role_grant
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role=$4
      AND valid='[2000-01-01,2001-01-01)'::tstzrange`,
    [f.resource.route, f.resource.id, f.actor, owner],
  );
  expect(history.rowCount).toBe(1);
});

test('native last-owner enforcement uses command T for an interval that is not current at wall time', async () => {
  await f.reader.query(
    `UPDATE access.resource_role_grant SET valid='[2040-01-01,)'::tstzrange
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role=$4`,
    [f.resource.route, f.resource.id, f.actor, owner],
  );
  const at2050 = createGrantCommands({
    pool: f.pool,
    access: f.access,
    managementAction: 'access:grant',
    clock: () => new Date('2050-01-01T00:00:00Z'),
  });
  await expect(at2050.revokeRole(await f.context(), input(f.actor, owner, '[2040-01-01,)'))).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  const remaining = await f.reader.query(
    `SELECT 1 FROM access.resource_role_grant
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role=$4
      AND valid='[2040-01-01,)'::tstzrange`,
    [f.resource.route, f.resource.id, f.actor, owner],
  );
  expect(remaining.rowCount).toBe(1);
});

function attemptLeaveGuard(context: GrantCommandContext) {
  return grantCommand(
    { pool: context.pool, access: f.access },
    context,
    {
      resource: f.resource,
      actions: ['access:grant', 'realm:manage'],
      kind: 'access.role-grant.revoke',
      key: Bun.randomUUIDv7(),
      input: { leave: f.actor },
      denied: () => new GrantDeniedError(),
    },
    async (tx) => {
      await assertRealmOwnerMayLeave(tx, { resource: f.resource, accountId: f.actor, at: currentCommand(tx).time });
      return null;
    },
  );
}

test('only the authorized locked native sole-owner refusal exposes realm_last_owner without effects', async () => {
  const before = await f.snapshot();
  const error = await attemptLeaveGuard(await f.context()).then(
    () => {
      throw new Error('Expected sole-owner refusal');
    },
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(RealmLastOwnerError);
  expect(error).toBeInstanceOf(ResourceAccessWriteDeniedError);
  const response = problemResponse(error, { method: 'POST', id: 'sole-owner' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    type: 'https://rezics.com/problems/realm_last_owner',
    title: 'Realm Ownership Transfer Required',
    status: 409,
    code: 'realm_last_owner',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'sole-owner',
  });
  expect(await owners()).toEqual([f.actor]);
  expect(await f.snapshot()).toEqual(before);
});

for (const missing of ['target', 'source', 'command-time', 'resource', 'transaction'] as const) {
  test(`the locked leave guard keeps missing ${missing} generic without effects`, async () => {
    if (missing === 'target')
      await f.reader.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
        f.resource.route,
        f.resource.id,
      ]);
    if (missing === 'source')
      await f.reader.query('DELETE FROM access.resource_initialization WHERE route=$1 AND resource_id=$2', [
        f.resource.route,
        f.resource.id,
      ]);
    const otherTime = await mintReadTime(f.pool);
    const before = await f.snapshot();
    const error = await grantCommand(
      { pool: f.pool, access: f.access },
      await f.context(),
      {
        resource: f.resource,
        actions: ['realm:manage'],
        kind: 'access.role-grant.revoke',
        key: Bun.randomUUIDv7(),
        input: { leave: f.actor },
        denied: () => new GrantDeniedError(),
      },
      async (tx) => {
        await assertRealmOwnerMayLeave(missing === 'transaction' ? f.pool : tx, {
          resource: missing === 'resource' ? f.otherResource : f.resource,
          accountId: f.actor,
          at: missing === 'command-time' ? otherTime : currentCommand(tx).time,
        });
        throw new Error('A generic refusal must not reach the effect');
      },
    ).then(
      () => {
        throw new Error('Expected generic refusal');
      },
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ResourceAccessWriteDeniedError);
    expect(error).not.toBeInstanceOf(RealmLastOwnerError);
    expect(await f.snapshot()).toEqual(before);
  });
}

for (const refusal of ['authority', 'inactive', 'unavailable'] as const) {
  test(`${refusal} before owner mutation never exposes realm_last_owner or applies effects`, async () => {
    const context = await f.context();
    if (refusal === 'authority')
      await f.reader.query(
        "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='access:grant'",
        [f.resource.route, f.resource.id],
      );
    if (refusal === 'inactive')
      await f.reader.query("UPDATE access.account SET state='deleted' WHERE account_id=$1", [f.actor]);
    const before = await f.snapshot();
    const unavailable = new AccessUnavailableError('overloaded');
    const pool = Object.create(f.pool) as typeof f.pool;
    pool.connect = (async () => {
      throw unavailable;
    }) as typeof pool.connect;
    const error = await attemptLeaveGuard(refusal === 'unavailable' ? { ...context, pool } : context).then(
      () => {
        throw new Error('Expected generic refusal or unavailability');
      },
      (error: unknown) => error,
    );
    expect(error).not.toBeInstanceOf(RealmLastOwnerError);
    expect(error).toBeInstanceOf(refusal === 'unavailable' ? AccessUnavailableError : GrantDeniedError);
    expect(await owners()).toEqual([f.actor]);
    expect(await f.snapshot()).toEqual(before);
  });
}

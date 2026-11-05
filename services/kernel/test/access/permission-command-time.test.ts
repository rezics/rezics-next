import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { accessCheck, accessCommandAuthorization } from '../../src/request/access.ts';
import { runCommand, type CommandAttempt } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
const action = 'subject:read';
const policyResourceType = 'fixture.permission';
const resourceRoles = {
  roles: { 'fixture.permission.reader': [action] },
  types: { [policyResourceType]: { owner: 'fixture.permission.reader', standing: [] } },
};
const actionMetadata = { anonymous: false, 'x-resource-types': [policyResourceType] } as const;
const event = { type: 'com.rezics.access.time-probe.v1', data: {} };

beforeAll(async () => {
  f = await grantFixture([], { action, resourceType: policyResourceType });
}, 30_000);
beforeEach(() => f.reset());
afterAll(async () => {
  if (f) await f.close();
});

async function databaseNow(): Promise<number> {
  const result = await f.reader.query('SELECT clock_timestamp()::text AS at');
  return Date.parse(result.rows[0].at);
}

async function checkInCommand(
  context: Awaited<ReturnType<typeof f.context>>,
  clock: () => Date,
  delayAfterPrepare = 0,
) {
  const nativeAuthorization = await accessCommandAuthorization(
    f.access,
    context.actor,
    action,
    f.resource,
    delayAfterPrepare ? { ...context, deadline: Date.now() + 1000 } : context,
    () => new Error('Permission denied'),
  );
  const authorization = delayAfterPrepare
    ? {
        ...nativeAuthorization,
        async prepare(attempt: CommandAttempt) {
          const evidence = await nativeAuthorization.prepare!(attempt);
          await new Promise<void>((resolve) => setTimeout(resolve, delayAfterPrepare));
          return evidence;
        },
      }
    : nativeAuthorization;

  return runCommand(
    f.pool,
    {
      partition: partitionOf(f.resource.route),
      deadline: context.deadline,
      basis: {
        actorAccountId: context.actor.accountId,
        clientId: context.actor.clientId,
        requestedBy: context.actor.requestedBy,
      },
      authorization,
      clock,
    },
    async () => ({ value: true, events: [event] }),
  );
}

test('a command clock ahead of PostgreSQL uses the same timeline for its evidence deadline', async () => {
  const context = await f.context();
  const databaseAt = await databaseNow();
  const ahead = new Date(databaseAt + 30_000);
  expect(ahead.getTime() - databaseAt).toBeGreaterThan(context.deadline - Date.now());

  await expect(checkInCommand(context, () => ahead)).resolves.toMatchObject({ value: true });

  await f.reader.query(
    'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4',
    [f.resource.route, f.resource.id, f.actor, action],
  );
  await expect(checkInCommand(await f.context(), () => ahead)).rejects.toThrow('Permission denied');
});

test('a command behind PostgreSQL is unavailable after its evidence deadline expires', async () => {
  const context = await f.context();
  const behind = new Date((await databaseNow()) - 500);

  await expect(checkInCommand(context, () => behind, 1_150)).rejects.toBeInstanceOf(AccessUnavailableError);
});

test('a command ahead of PostgreSQL is unavailable after its evidence deadline expires', async () => {
  const context = await f.context();
  const ahead = new Date((await databaseNow()) + 30_000);

  await expect(checkInCommand(context, () => ahead, 1_150)).rejects.toBeInstanceOf(AccessUnavailableError);
});

function monthsBefore(base: number, months: number): Date {
  const date = new Date(base);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

/** A day around `instant`, so database time months later is outside the grant. */
async function cover(instant: Date) {
  await f.reader.query(
    `UPDATE access.resource_grant
     SET valid = tstzrange($5::timestamptz, $6::timestamptz, '[)')
     WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND action = $4`,
    [
      f.resource.route,
      f.resource.id,
      f.actor,
      action,
      new Date(instant.getTime() - 86_400_000).toISOString(),
      new Date(instant.getTime() + 86_400_000).toISOString(),
    ],
  );
}

async function readAt(clock?: () => Date): Promise<boolean> {
  const context = await f.context();
  const actor = context.actor;
  const account = await readAccount(f.pool, routeOf(actor.accountId)!, actor.accountId);
  if (!account) throw new Error('Fixture account is missing');
  const access = clock
    ? createPermissionAccess({
        actions: new Map([[action, actionMetadata]]),
        resourceRoles,
        accountEvidence: () => account,
        clock,
      })
    : f.access;
  const check = await accessCheck(access, actor, action, f.resource, context);
  return check(f.pool);
}

test('a command months behind PostgreSQL is permitted by its grant within its budget', async () => {
  const databaseAt = await databaseNow();
  const behind = monthsBefore(databaseAt, 4);
  expect(databaseAt - behind.getTime()).toBeGreaterThan(90 * 24 * 60 * 60 * 1000);
  await cover(behind);

  await expect(checkInCommand(await f.context(), () => behind)).resolves.toMatchObject({ value: true });
  await expect(checkInCommand(await f.context(), () => new Date(databaseAt))).rejects.toThrow('Permission denied');
});

test('a read months behind PostgreSQL is permitted by its grant within its budget', async () => {
  const databaseAt = await databaseNow();
  const behind = monthsBefore(databaseAt, 4);
  expect(databaseAt - behind.getTime()).toBeGreaterThan(90 * 24 * 60 * 60 * 1000);
  await cover(behind);

  expect(await readAt(() => behind)).toBe(true);
  expect(await readAt(() => new Date(databaseAt))).toBe(false);
  expect(await readAt()).toBe(false);
});

test('a read whose request budget has run out is unavailable whichever way its clock differs', async () => {
  const databaseAt = await databaseNow();
  for (const instant of [monthsBefore(databaseAt, 4), new Date(databaseAt + 30_000)]) {
    const context = await f.context();
    const account = await readAccount(f.pool, routeOf(context.actor.accountId)!, context.actor.accountId);
    if (!account) throw new Error('Fixture account is missing');
    const access = createPermissionAccess({
      actions: new Map([[action, { anonymous: false }]]),
      accountEvidence: () => account,
      clock: () => instant,
    });
    const check = await accessCheck(access, context.actor, action, f.resource, {
      ...context,
      deadline: Date.now() + 1000,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_150));
    await expect(check(f.pool)).rejects.toBeInstanceOf(AccessUnavailableError);
  }
});

test('a non-command permission read continues to use database time', async () => {
  const context = await f.context();
  const check = await accessCheck(f.access, context.actor, action, f.resource, context);

  expect(await check(f.pool)).toBe(true);
});

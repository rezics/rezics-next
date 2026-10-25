import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { accessCheck, accessCommandAuthorization } from '../../src/request/access.ts';
import { runCommand, type CommandAttempt } from '../../src/command/command.ts';
import { partitionOf } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
const action = 'subject:read';
const event = { type: 'com.rezics.access.time-probe.v1', data: {} };

beforeAll(async () => {
  f = await grantFixture();
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
    context,
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

test('a command behind PostgreSQL remains denied after its evidence deadline expires', async () => {
  const context = await f.context();
  const behind = new Date((await databaseNow()) - 500);

  await expect(checkInCommand(context, () => behind, 1_150)).rejects.toThrow('Permission denied');
});

test('a non-command permission read continues to use database time', async () => {
  const context = await f.context();
  const check = await accessCheck(f.access, context.actor, action, f.resource, context);

  expect(await check(f.pool)).toBe(true);
});

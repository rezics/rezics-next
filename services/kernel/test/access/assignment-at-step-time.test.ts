import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
const action = 'subject:read';
const effectTable = `public.assignment_step_effect_${process.pid}`;
const event = { type: 'com.rezics.access.time-probe.v1', data: {} };

beforeAll(async () => {
  f = await grantFixture();
  await f.reader.query(`CREATE TABLE ${effectTable} (effect_id uuid PRIMARY KEY)`);
}, 30_000);

beforeEach(async () => {
  await f.reset();
  await f.reader.query(`DELETE FROM ${effectTable}`);
});

afterAll(async () => {
  if (!f) return;
  try {
    await f.reader.query(`DROP TABLE IF EXISTS ${effectTable}`);
  } finally {
    await f.close();
  }
});

async function preparedStep() {
  const requestId = newId(routeOf(f.principal)!);
  const requestedBy = `urn:rezics:request:${f.principal}:${requestId}`;
  await f.reader.query(
    `INSERT INTO access.principal_assignment
     (route, principal_id, request_id, assigned_actor_id, creator_principal_id, valid, transaction_id)
     VALUES ($1, $2, $3, $4, $2, '(,)'::tstzrange, $5)`,
    [routeOf(f.principal), f.principal, requestId, f.actor, newId(routeOf(f.principal)!)],
  );
  await f.grant(f.principal, action);
  const context = await f.context(f.actor, f.actions, requestedBy);
  const evidence = await f.access.prepare!(context.actor, action, f.resource, context);
  const authorization: CommandAuthorization = {
    action,
    resource: f.resource,
    denied: () => new Error('Permission denied'),
    async prepare() {
      return evidence;
    },
    async authorize(tx, attempt, proof) {
      if (proof !== evidence || !(await f.access.authorize(tx, context.actor, action, f.resource, proof, attempt.time)))
        throw new Error('Permission denied');
      return 'execute';
    },
  };
  return { context, authorization, requestId };
}

async function runProtectedStep(context: Awaited<ReturnType<typeof f.context>>, authorization: CommandAuthorization) {
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
    },
    async (tx) => {
      await tx.query(`INSERT INTO ${effectTable} (effect_id) VALUES ($1)`, [Bun.randomUUIDv7()]);
      return { value: true, events: [event] };
    },
  );
}

test('a revoked assignment denies the protected step before it applies an effect', async () => {
  const prepared = await preparedStep();
  await f.reader.query(
    `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
     UPDATE access.principal_assignment p
     SET revoked_at = instant.at, valid = p.valid * tstzrange(NULL, instant.at, '[)')
     FROM instant
     WHERE p.route = $1 AND p.principal_id = $2 AND p.request_id = $3`,
    [routeOf(f.principal), f.principal, prepared.requestId],
  );

  await expect(runProtectedStep(prepared.context, prepared.authorization)).rejects.toThrow('Permission denied');
  expect((await f.reader.query(`SELECT count(*)::integer AS count FROM ${effectTable}`)).rows).toEqual([{ count: 0 }]);
});

test('an untouched assignment permits the protected step', async () => {
  const prepared = await preparedStep();

  await expect(runProtectedStep(prepared.context, prepared.authorization)).resolves.toMatchObject({ value: true });
  expect((await f.reader.query(`SELECT count(*)::integer AS count FROM ${effectTable}`)).rows).toEqual([{ count: 1 }]);
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { accessCheck } from '../../src/request/access.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { runCommand } from '../../src/command/command.ts';
import { partitionOf } from '../../src/route/route.ts';
import permission from '../../src/access/permission-check.sql';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
const actions = ['access:grant', 'subject:read', 'subject:update'];
beforeAll(async () => {
  f = await grantFixture();
  await f.reader.query('CREATE TABLE access.grant_time_probe (route integer PRIMARY KEY, version integer NOT NULL)');
  await f.reader.query('INSERT INTO access.grant_time_probe VALUES ($1, 0)', [f.resource.route]);
}, 30000);
beforeEach(() => f.reset());
afterAll(async () => {
  if (!f) return;
  await f.reader.query('DROP TABLE access.grant_time_probe');
  await f.close();
});
async function checks(context: Awaited<ReturnType<typeof f.context>>) {
  const result = [];
  for (const action of actions) result.push(await accessCheck(f.access, context.actor, action, f.resource, context));
  return result;
}
const event = { type: 'com.rezics.access.time-probe.v1', data: {} };

// Every permission below is the real Access implementation on runCommand's client.
// Privileged SQL establishes exact database instants, never a trusted-time input.
test('management and multiple delegated actions use exactly the transaction policy time including its start', async () => {
  const context = await f.context();
  const prepared = await checks(context);
  const result = await runCommand(
    f.pool,
    { partition: partitionOf(f.resource.route), deadline: context.deadline },
    async (tx) => {
      await tx.query(
        `UPDATE access.resource_grant SET valid=tstzrange(transaction_timestamp(),
        transaction_timestamp()+interval '200 milliseconds','[)')
        WHERE route=$1 AND resource_id=$2 AND subject_id=$3`,
        [f.resource.route, f.resource.id, f.actor],
      );
      const at = (await tx.query('SELECT transaction_timestamp()::text AS at')).rows[0].at;
      const allowed = [await prepared[0]!(tx)];
      await tx.query('SELECT pg_sleep(0.25)');
      for (const check of prepared.slice(1)) allowed.push(await check(tx));
      const exact = await tx.query(
        `SELECT bool_and(lower(valid)=transaction_timestamp()) AS starts,
        bool_and(NOT (valid @> upper(valid))) AS ends,
        transaction_timestamp()::text AS at, clock_timestamp()>max(upper(valid)) AS elapsed
        FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3`,
        [f.resource.route, f.resource.id, f.actor],
      );
      expect(exact.rows[0]).toEqual({ starts: true, ends: true, at, elapsed: true });
      return { value: allowed, events: [event] };
    },
  );
  expect(result.value).toEqual([true, true, true]);
});

test('one attempt cannot combine permissions on opposite sides of an exclusive boundary', async () => {
  const context = await f.context();
  const prepared = await checks(context);
  const result = await runCommand(
    f.pool,
    { partition: partitionOf(f.resource.route), deadline: context.deadline },
    async (tx) => {
      await tx.query(
        `UPDATE access.resource_grant SET valid=CASE WHEN action='subject:update'
        THEN tstzrange(transaction_timestamp()+interval '200 milliseconds',NULL,'[)')
        ELSE tstzrange(NULL,transaction_timestamp()+interval '200 milliseconds','[)') END
        WHERE route=$1 AND resource_id=$2 AND subject_id=$3`,
        [f.resource.route, f.resource.id, f.actor],
      );
      const allowed = [await prepared[0]!(tx), await prepared[1]!(tx)];
      await tx.query('SELECT pg_sleep(0.25)');
      allowed.push(await prepared[2]!(tx));
      return { value: allowed, events: [event] };
    },
  );
  expect(result.value).toEqual([true, true, false]);
});

test('a real serialization retry gets a fresh transaction policy time and rechecks every action', async () => {
  const context = await f.context();
  const prepared = await checks(context);
  const attempts: { at: string; allowed: boolean[] }[] = [];
  const boundary = (await f.reader.query("SELECT (clock_timestamp()+interval '400 milliseconds')::text AS at")).rows[0]
    .at;
  await f.reader.query(
    "UPDATE access.resource_grant SET valid=tstzrange(NULL,$4::timestamptz,'[)') WHERE route=$1 AND resource_id=$2 AND subject_id=$3",
    [f.resource.route, f.resource.id, f.actor, boundary],
  );
  const result = await runCommand(
    f.pool,
    { partition: partitionOf(f.resource.route), deadline: context.deadline },
    async (tx) => {
      await tx.query('SELECT version FROM access.grant_time_probe WHERE route=$1', [f.resource.route]);
      const at = (await tx.query('SELECT transaction_timestamp()::text AS at')).rows[0].at;
      const allowed = [];
      for (const check of prepared) allowed.push(await check(tx));
      attempts.push({ at, allowed });
      if (attempts.length === 1) {
        await f.reader.query('UPDATE access.grant_time_probe SET version=version+1 WHERE route=$1', [f.resource.route]);
        await tx.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.02)`, [
          boundary,
        ]);
      }
      // The first attempt must raise PostgreSQL's own serialization failure.
      await tx.query('UPDATE access.grant_time_probe SET version=version+1 WHERE route=$1', [f.resource.route]);
      return { value: allowed, events: [event] };
    },
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.at).not.toBe(attempts[1]!.at);
  expect(attempts[0]!.allowed).toEqual([true, true, true]);
  expect(attempts[1]!.allowed).toEqual([false, false, false]);
  expect(result.value).toEqual([false, false, false]);
});

test('policy time at an exact exclusive end denies management and every delegated action', async () => {
  const context = await f.context();
  const prepared = await checks(context);
  await runCommand(f.pool, { partition: partitionOf(f.resource.route), deadline: context.deadline }, async (tx) => {
    await tx.query(
      `UPDATE access.resource_grant SET valid=tstzrange(NULL,transaction_timestamp(),'[)')
      WHERE route=$1 AND resource_id=$2 AND subject_id=$3`,
      [f.resource.route, f.resource.id, f.actor],
    );
    for (const check of prepared) expect(await check(tx)).toBe(false);
    return { value: null, events: [event] };
  });
});

test('transaction policy time cannot extend an elapsed real database evidence deadline', async () => {
  const context = await f.context();
  const prepared = await checks(context);
  await runCommand(f.pool, { partition: partitionOf(f.resource.route), deadline: context.deadline }, async (tx) => {
    expect(await prepared[0]!(tx)).toBe(true);
    const deadline = (await tx.query("SELECT (clock_timestamp()+interval '50 milliseconds')::text AS at")).rows[0].at;
    await tx.query('SELECT pg_sleep(0.08)');
    // This isolates the production SQL budget guard from the additional JS guard.
    const result = await permission.run(tx, {
      route: f.resource.route,
      resource_ids: [f.resource.id],
      include_global: false,
      action: actions[0]!,
      actor_id: f.actor,
      principal_id: '',
      anonymous: false,
      roles: [],
      deadline,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.allowed).toBe(false);
    return { value: null, events: [event] };
  });
});

test('expired prepared evidence is unavailable within a still live command and leaves no receipt or effect', async () => {
  const context = await f.context();
  const prepared = await checks({ ...context, deadline: Date.now() + 1000 });
  const before = await f.snapshot();
  const denial = new Error('Expired evidence');
  await expect(
    runCommand(
      f.pool,
      {
        partition: partitionOf(f.resource.route),
        deadline: context.deadline,
        receipt: {
          actorAccountId: f.actor,
          kind: 'access.time-probe',
          key: Bun.randomUUIDv7(),
          digest: new Uint8Array(32),
        },
      },
      async (tx) => {
        expect(await prepared[0]!(tx)).toBe(true);
        await tx.query('SELECT pg_sleep(1.05)');
        expect(Date.now()).toBeLessThan(context.deadline);
        for (const check of prepared) await expect(check(tx)).rejects.toBeInstanceOf(AccessUnavailableError);
        throw denial;
      },
    ),
  ).rejects.toBe(denial);
  expect(await f.snapshot()).toEqual(before);
});

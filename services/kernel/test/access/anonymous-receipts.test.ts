import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createAccess, createResourceAnonymousEligibility, type ResourceEligibility } from '../../src/access/index.ts';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { accessCommandAuthorization, actorOf, type Actor, type Resource } from '../../src/request/access.ts';
import { anonymousRequestDigest } from '../../src/http/request.ts';
import { newId } from '../../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
afterAll(() => pool.end());
const action = 'report:create';
const access = createAccess({
  actions: new Map([
    [action, { anonymous: true }],
    ['private:create', { anonymous: false }],
  ]),
});
const actor: Actor = { kind: 'anonymous' };
class Denied extends Error {}
const event = { type: 'com.rezics.test.anonymous.v1', data: {} };
const body = async () => ({ value: { accepted: true }, events: [event] });
async function fixture(partition: number) {
  const resource: Resource = { route: partition << 4, id: newId(partition << 4) };
  // Real domain facts on the resource partition; a PRIVATE report's eligibility
  // comes from owning domain admission, independently of report visibility.
  await pool.query(`CREATE TABLE IF NOT EXISTS public.anonymous_domain_fixture
    (route integer NOT NULL, id uuid NOT NULL, admits boolean NOT NULL, PRIMARY KEY(route,id))`);
  await pool.query('INSERT INTO public.anonymous_domain_fixture VALUES($1,$2,true)', [resource.route, resource.id]);
  const eligibility = createResourceAnonymousEligibility({
    resource,
    action,
    async prepare() {
      return { target: resource.id };
    },
    async verify({ client, resource: target, evidence, at }) {
      expect(at).toBeTruthy();
      if (evidence.target !== target.id) return false;
      return (
        (
          await client.query('SELECT admits FROM public.anonymous_domain_fixture WHERE route=$1 AND id=$2', [
            target.route,
            target.id,
          ])
        ).rows[0]?.admits === true
      );
    },
  });
  return { ...resource, eligibility };
}
async function command(partition: number, resource: Resource, key: string, selected = action) {
  return runCommand(
    pool,
    {
      ...principalCommandIdentity(actor),
      partition,
      receipt: {
        kind: 'report.create',
        key,
        digest: anonymousRequestDigest('report.create', { semantic: { reason: 'spam' } }),
      },
      authorization: await accessCommandAuthorization(
        access,
        actor,
        selected,
        resource,
        { pool, deadline: Date.now() + 2_000 },
        () => new Denied(),
      ),
    },
    body,
  );
}

test('installed Access denies unknown action, missing/forged eligibility and non-anonymous action before receipt read', async () => {
  const resource = await fixture(98);
  const key = randomUUID();
  for (const [target, selected] of [
    [resource, 'unknown:create'],
    [resource, 'private:create'],
    [{ route: resource.route, id: resource.id }, action],
    [{ ...resource, eligibility: {} as ResourceEligibility }, action],
    [{ ...resource, eligibility: JSON.parse(JSON.stringify(resource.eligibility)) as ResourceEligibility }, action],
  ] as const)
    await expect(command(98, target, key, selected)).rejects.toBeInstanceOf(Denied);
  expect((await pool.query('SELECT position FROM core.partition WHERE partition_no=98')).rows).toEqual([
    { position: '0' },
  ]);
  expect((await pool.query('SELECT 1 FROM core.receipt WHERE partition_no=98')).rows).toEqual([]);
});

test('installed Access and generic eligibility admit one real command/replay and deny stale domain facts before disclosure', async () => {
  const resource = await fixture(99);
  const key = randomUUID();
  const first = await command(99, resource, key);
  expect(first.replayed).toBe(false);
  expect(await command(99, resource, key)).toEqual({ ...first, replayed: true });
  await pool.query('UPDATE public.anonymous_domain_fixture SET admits=false WHERE route=$1 AND id=$2', [
    resource.route,
    resource.id,
  ]);
  await expect(command(99, resource, key)).rejects.toBeInstanceOf(Denied);
  const { rows } = await pool.query(`SELECT position,
    (SELECT count(*)::int FROM core.receipt WHERE partition_no=99) AS receipts,
    (SELECT count(*)::int FROM core.outbox WHERE partition_no=99) AS events
    FROM core.partition WHERE partition_no=99`);
  expect(rows).toEqual([{ position: '1', receipts: 1, events: 1 }]);
});

test('supplied bad bearer is never discarded to enter the anonymous receipt namespace', async () => {
  await expect(
    actorOf(access, new Request('https://api.rezics.test', { headers: { authorization: 'Bearer invalid' } }), {
      pool,
      deadline: Date.now() + 2_000,
    }),
  ).rejects.toThrow('Authentication failed');
});

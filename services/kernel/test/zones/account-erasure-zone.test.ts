import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { authoritativeTimeValue, currentCommand, noEffect, runCommand } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountErasureGrantProgress, minimizeAccountErasureZone } from '../../src/zones/account-erasure-zone.ts';
import { lockZoneHead } from '../../src/zones/resource-head.ts';
import { accountErasureFixture, type AccountErasureFixture } from '../semantic/support/account-erasure-fixture.ts';
import { createBody } from './resource-fixture.ts';

let f: AccountErasureFixture;
beforeAll(async () => {
  f = await accountErasureFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

const platform = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-semantic-erasure',
  requestedBy: null,
};

async function createZone(owner: Awaited<ReturnType<AccountErasureFixture['author']>>) {
  await f.grant(GLOBAL_CONTEXT, owner, ['zone:create']);
  const input = createBody();
  input.configuration.scope = [];
  input.configuration.labels.en = `Erasure Zone ${randomUUID()}`;
  const created = await f.call(owner, 'POST', '/v1/zones', input);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.zone.id as string;
  const route = routeOf(id)!;
  return { owner, id, route, input };
}

async function minimize(
  zone: { route: number; id: string },
  accountId: string,
  options: { limit?: number; pages?: number } = {},
) {
  return (
    await runCommand(
      f.db.pool,
      { partition: partitionOf(zone.route), deadline: Date.now() + 30_000, clock: () => new Date(), basis: platform },
      async (tx) => {
        const command = currentCommand(tx);
        return {
          value: await minimizeAccountErasureZone(tx, {
            route: zone.route,
            id: zone.id,
            accountId,
            at: authoritativeTimeValue(command.time),
            transactionId: command.transactionId,
            ...options,
          }),
          events: [],
        };
      },
    )
  ).value;
}

async function readZone(route: number, id: string) {
  return (
    await f.db.admin.query<{
      owner_id: string | null;
      state: string;
      configuration: unknown;
      withholding: Record<string, unknown>;
      write_fenced: boolean;
    }>(
      `SELECT owner_id::text, state, configuration, withholding, write_fenced
       FROM zones.zone WHERE route=$1 AND zone_id=$2`,
      [route, id],
    )
  ).rows[0]!;
}

async function subjectGrants(route: number, id: string, accountId: string) {
  const resource = await f.db.admin.query(
    `SELECT count(*)::integer AS n FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3 AND subject_role=''`,
    [route, id, accountId],
  );
  const roles = await f.db.admin.query(
    `SELECT count(*)::integer AS n FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3 AND subject_role=''`,
    [route, id, accountId],
  );
  return { resource: resource.rows[0]!.n as number, roles: roles.rows[0]!.n as number };
}

test('empty direct grants still drain the erased owner role and leave unrelated grants', async () => {
  const { owner, id, route } = await createZone(await f.author());
  const other = await f.author();
  await f.grant(GLOBAL_CONTEXT, other, ['zone:create']);
  const unrelated = await f.call(other, 'POST', '/v1/zones', createBody());
  expect(unrelated.status, JSON.stringify(unrelated.body)).toBe(201);
  const unrelatedId = unrelated.body.zone.id as string;
  await f.db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [route, id]);
  expect(await subjectGrants(route, id, owner.accountId)).toMatchObject({ resource: 0, roles: 1 });
  const beforeUnrelated = await subjectGrants(routeOf(unrelatedId)!, unrelatedId, other.accountId);
  expect(beforeUnrelated.roles).toBeGreaterThan(0);
  await f.tombstone(owner);
  expect(await minimize({ route, id }, owner.accountId)).toBe('minimized');
  expect(await subjectGrants(route, id, owner.accountId)).toEqual({ resource: 0, roles: 0 });
  expect(await subjectGrants(routeOf(unrelatedId)!, unrelatedId, other.accountId)).toEqual(beforeUnrelated);
  const row = await readZone(route, id);
  expect(row).toMatchObject({ owner_id: null, state: 'purged', configuration: null, write_fenced: true });
  expect(row.withholding).not.toHaveProperty('grants');
}, 120_000);

test('interrupted grant pages resume the committed non-1 barrier through persisted readback', async () => {
  const { owner, id, route } = await createZone(await f.author());
  const editor = await f.author();
  await f.grantAs(owner, id, editor, ['zone:read', 'zone:configure']);
  await f.tombstone(owner);
  const client = await f.db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query('UPDATE access.erasure SET version=2 WHERE route=$1 AND account_id=$2', [
      routeOf(owner.accountId),
      owner.accountId,
    ]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const barrier = await f.db.admin.query<{ version: string; at: string }>(
    'SELECT version::text, at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
    [routeOf(owner.accountId), owner.accountId],
  );
  expect(barrier.rows[0]!.version).toBe('2');
  expect(await minimize({ route, id }, owner.accountId, { limit: 1, pages: 1 })).toBe('held');
  const interrupted = await readZone(route, id);
  expect(interrupted.write_fenced).toBe(true);
  expect(interrupted.owner_id).toBe(owner.accountId);
  expect(interrupted.configuration).not.toBeNull();
  const persisted = await runCommand(
    f.db.pool,
    { partition: partitionOf(route), deadline: Date.now() + 30_000, clock: () => new Date() },
    async (tx) => {
      const head = await lockZoneHead(tx, route, id);
      return noEffect(accountErasureGrantProgress(head!));
    },
  );
  expect(persisted.value).toMatchObject({
    store: expect.stringMatching(/resource_grant|resource_role_grant/),
    scope: {
      kind: 'terminal-account-subject',
      terminal: { accountId: owner.accountId, barrierVersion: '2', barrierAt: barrier.rows[0]!.at },
    },
  });
  expect(interrupted.withholding.grants).toMatchObject({
    afterKey: persisted.value!.afterKey,
    store: persisted.value!.store,
  });
  let outcome: Awaited<ReturnType<typeof minimize>> = 'held';
  for (let step = 0; step < 32 && outcome === 'held'; step += 1)
    outcome = await minimize({ route, id }, owner.accountId, { limit: 1, pages: 1 });
  expect(outcome).toBe('minimized');
  expect(await subjectGrants(route, id, owner.accountId)).toEqual({ resource: 0, roles: 0 });
  expect(await subjectGrants(route, id, editor.accountId)).toMatchObject({ resource: 2 });
  const done = await readZone(route, id);
  expect(done).toMatchObject({ owner_id: null, state: 'purged', configuration: null });
  expect(done.withholding).not.toHaveProperty('grants');
}, 120_000);

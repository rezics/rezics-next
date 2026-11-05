import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { deriveAccess } from '../../src/request/derived-access.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands, DelegationDeniedError } from '../../src/access/delegation-commands.ts';
import { authoritativeTimeValue, commandTime } from '../../src/command/command.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
beforeAll(async () => {
  f = await grantFixture();
  await f.reader.query(
    'CREATE TABLE access.grant_boundary_probe (route integer PRIMARY KEY, version integer NOT NULL)',
  );
  await f.reader.query('INSERT INTO access.grant_boundary_probe VALUES ($1, 0)', [f.resource.route]);
}, 30000);
beforeEach(() => f.reset());
afterAll(async () => {
  if (!f) return;
  await f.reader.query('DROP TABLE access.grant_boundary_probe');
  await f.close();
});
const grantInput = () => ({
  resource: f.resource,
  subjectId: f.recipient,
  subjectRole: '' as const,
  actions: ['subject:read', 'subject:update'],
  valid: '(,)',
  key: Bun.randomUUIDv7(),
});

// These are real public commands, production Access, migrated rows and receipts.
// Losing current authority must hide a matching receipt as well as prevent writes.
test('revoked matching grant replay denies without returning its stored response or effect', async () => {
  const commands = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  const context = await f.context();
  const input = grantInput();
  const created = await commands.create(context, input);
  expect(created.replayed).toBe(false);
  expect(await commands.create(context, input)).toEqual({ ...created, replayed: true });
  for (const action of ['access:grant', 'subject:read', 'subject:update']) {
    await f.reader.query(
      'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4',
      [f.resource.route, f.resource.id, f.actor, action],
    );
    const before = await f.snapshot();
    await expect(commands.create(context, input)).rejects.toBeInstanceOf(GrantDeniedError);
    expect(await f.snapshot()).toEqual(before);
    await f.grant(f.actor, action);
  }
});

test('revoked matching principal assignment replay denies without disclosing its immutable reference', async () => {
  const commands = createDelegationCommands({ pool: f.pool, access: f.access, action: 'account:delegate' });
  const context = await f.context(f.principal);
  const input = {
    principalId: f.principal,
    assignedActorId: f.actor,
    requestId: newId(0x2345),
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  const created = await commands.create(context, input);
  expect(await commands.create(context, input)).toEqual({ ...created, replayed: true });
  await f.reader.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$2', [
    routeOf(f.principal),
    f.principal,
  ]);
  const before = await f.snapshot(routeOf(f.principal)!);
  const assignments = await f.reader.query('SELECT row_to_json(p) AS value FROM access.principal_assignment p');
  await expect(commands.create(context, input)).rejects.toBeInstanceOf(DelegationDeniedError);
  expect(await f.snapshot(routeOf(f.principal)!)).toEqual(before);
  expect((await f.reader.query('SELECT row_to_json(p) AS value FROM access.principal_assignment p')).rows).toEqual(
    assignments.rows,
  );
});

test('grant command boundary binds management and every delegated action to one trusted T and retry gets a fresh T', async () => {
  const observations: { action: string; explicit: string | null; bound: string; allowed: boolean }[] = [];
  let retried = false;
  // Observe and synchronize the real evaluator without replacing any policy decision.
  const access: Access = deriveAccess(f.access, {
    async authorize(client, actor, action, resource, evidence, time) {
      const bound = commandTime(client);
      if (!bound) throw new Error('Expected an actual command attempt');
      const at = authoritativeTimeValue(bound);
      const allowed = await f.access.authorize(client, actor, action, resource, evidence, time);
      observations.push({ action, explicit: time ? authoritativeTimeValue(time) : null, bound: at, allowed });
      if (action === 'subject:update' && !retried) {
        retried = true;
        await client.query('SELECT version FROM access.grant_boundary_probe WHERE route=$1', [resource.route]);
        await f.reader.query('UPDATE access.grant_boundary_probe SET version=version+1 WHERE route=$1', [
          resource.route,
        ]);
        // Force PostgreSQL itself to reject this snapshot. The next attempt must
        // obtain a new capability/time and repeat all three policy checks.
        await client.query('UPDATE access.grant_boundary_probe SET version=version+1 WHERE route=$1', [resource.route]);
      }
      return allowed;
    },
  });
  const commands = createGrantCommands({ pool: f.pool, access, managementAction: 'access:grant' });
  const before = await f.snapshot();
  await commands.create(await f.context(), grantInput());
  expect(observations.map((item) => item.action)).toEqual([
    'access:grant',
    'subject:read',
    'subject:update',
    'access:grant',
    'subject:read',
    'subject:update',
  ]);
  for (const attempt of [observations.slice(0, 3), observations.slice(3)]) {
    expect(new Set(attempt.map((item) => item.bound)).size).toBe(1);
    for (const item of attempt) {
      expect(item.explicit).toBe(item.bound);
      expect(item.allowed).toBe(true);
    }
  }
  expect(observations[0]!.bound).not.toBe(observations[3]!.bound);
  const after = await f.snapshot();
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.events).toBe(before.events + 1);
});

test('assignment revocation mutation uses the same trusted T as its management authorization', async () => {
  const observed: string[] = [];
  const access: Access = deriveAccess(f.access, {
    async authorize(client, actor, action, resource, evidence, time) {
      const allowed = await f.access.authorize(client, actor, action, resource, evidence, time);
      if (time) observed.push(authoritativeTimeValue(time));
      await client.query('SELECT pg_sleep(0.02)');
      return allowed;
    },
  });
  const commands = createDelegationCommands({ pool: f.pool, access, action: 'account:delegate' });
  const context = await f.context(f.principal);
  const request = {
    principalId: f.principal,
    assignedActorId: f.actor,
    requestId: newId(0x2345),
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  await commands.create(context, request);
  await commands.revoke(context, { principalId: f.principal, requestId: request.requestId, key: Bun.randomUUIDv7() });
  expect(observed).toHaveLength(2);
  const row = await f.reader.query(
    'SELECT revoked_at=$3::timestamptz AS same, upper(valid)=$3::timestamptz AS ends FROM access.principal_assignment WHERE route=$1 AND request_id=$2',
    [routeOf(f.principal), request.requestId, observed[1]],
  );
  expect(row.rows).toEqual([{ same: true, ends: true }]);
});

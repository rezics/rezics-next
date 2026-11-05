import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  createDelegationCommands,
  readAssignment,
  DelegationDeniedError,
} from '../../src/access/delegation-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
let commands: ReturnType<typeof createDelegationCommands>;
beforeAll(async () => {
  f = await grantFixture();
  commands = createDelegationCommands({ pool: f.pool, access: f.access, action: 'account:delegate' });
}, 30000);
beforeEach(() => f.reset());
afterAll(() => f?.close());
function input(valid = '(,)') {
  return {
    principalId: f.principal,
    assignedActorId: f.actor,
    requestId: newId(0x2345),
    valid,
    key: Bun.randomUUIDv7(),
  };
}
async function snapshot() {
  const rows = await f.reader.query(
    `SELECT row_to_json(p) AS value FROM access.principal_assignment p
    WHERE route=$1 AND principal_id=$2 ORDER BY request_id`,
    [routeOf(f.principal), f.principal],
  );
  return { assignments: rows.rows, effects: await f.snapshot(routeOf(f.principal)!) };
}
async function denied(body: () => Promise<unknown>) {
  const before = await snapshot();
  await expect(body()).rejects.toBeInstanceOf(DelegationDeniedError);
  expect(await snapshot()).toEqual(before);
}

test('principal assignment is created by its authenticated principal command', async () => {
  const request = input();
  const ctx = await f.context(f.principal);
  const result = await commands.create(ctx, request);
  const requestedBy = `urn:rezics:request:${f.principal}:${request.requestId}`;
  expect(result.value.requestedBy).toBe(requestedBy);
  const assignment = await readAssignment(f.pool, requestedBy, f.actor);
  expect(assignment).toMatchObject({
    kind: 'resolved',
    principalId: f.principal,
    assignedActorId: f.actor,
    requestId: request.requestId,
  });
  expect(await readAssignment(f.pool, requestedBy, f.recipient)).toEqual({ kind: 'unresolved' });
  const delegated = await f.context(f.actor, f.actions, requestedBy);
  expect(delegated.actor).toMatchObject({ accountId: f.actor, clientId: 'web', requestedBy });
  // Provenance conveys no resource grant for the principal.
  expect(await f.permitted(f.actor, 'subject:read', requestedBy)).toBe(false);
  await f.grant(f.principal, 'subject:read');
  expect(await f.permitted(f.actor, 'subject:read', requestedBy)).toBe(true);
  expect(await commands.create(ctx, request)).toEqual({ ...result, replayed: true });
});

test('forged creator and actor body substitution cannot create another principal assignment', async () => {
  const request = input();
  const actor = await f.context();
  await denied(() => commands.create(actor, request));
  await denied(() => commands.create(actor, { ...{ ...request, createdBy: f.principal } }));
  const principal = await f.context(f.principal);
  await denied(() => commands.create(principal, { ...{ ...request, createdBy: f.recipient } }));
  await denied(() => commands.create({ ...principal, actor: { ...principal.actor, accountId: f.recipient } }, request));
});

test('pending suspended deleted and fenced principals cannot create assignments', async () => {
  const ctx = await f.context(f.principal);
  for (const state of ['pending', 'suspended', 'deleted']) {
    await setFixtureAccountState(f.reader, f.principal, state);
    await denied(() => commands.create(ctx, input()));
  }
  await f.reader.query("UPDATE access.account SET state='active', authn_fenced=true WHERE route=$1 AND account_id=$2", [
    routeOf(f.principal),
    f.principal,
  ]);
  await denied(() => commands.create(ctx, input()));
});

test('only the creating principal can revoke and a revoked immutable request cannot be reused', async () => {
  const ctx = await f.context(f.principal);
  const request = input();
  const created = await commands.create(ctx, request);
  const revoke = { principalId: f.principal, requestId: request.requestId, key: Bun.randomUUIDv7() };
  const other = await f.context(f.recipient);
  await denied(() => commands.revoke(other, revoke));
  const revoked = await commands.revoke(ctx, revoke);
  expect(await readAssignment(f.pool, created.value.requestedBy, f.actor)).toEqual({ kind: 'unresolved' });
  const after = await snapshot();
  expect(await commands.revoke(ctx, revoke)).toEqual({ ...revoked, replayed: true });
  expect(await snapshot()).toEqual(after);
  await expect(commands.create(ctx, { ...request, key: Bun.randomUUIDv7() })).rejects.toBeDefined();
  expect(await snapshot()).toEqual(after);
});

test('future expired revoked and malformed references fail closed and absence stays distinct', async () => {
  expect(await readAssignment(f.pool, null, f.actor)).toEqual({ kind: 'none' });
  for (const reference of [
    '',
    f.principal,
    `urn:rezics:request:${f.principal}:${newId(0x2345)}`,
    'urn:rezics:request:forged:creator',
  ]) {
    expect(await readAssignment(f.pool, reference, f.actor)).toEqual({ kind: 'unresolved' });
  }
  for (const valid of ['[2000-01-01,2001-01-01)', '[2099-01-01,2100-01-01)']) {
    const request = input(valid);
    const ctx = await f.context(f.principal);
    const result = await commands.create(ctx, request);
    expect(await readAssignment(f.pool, result.value.requestedBy, f.actor)).toEqual({ kind: 'unresolved' });
    await commands.revoke(ctx, { principalId: f.principal, requestId: request.requestId, key: Bun.randomUUIDv7() });
    expect(await readAssignment(f.pool, result.value.requestedBy, f.actor)).toEqual({ kind: 'unresolved' });
  }
  await f.reader.query('ALTER TABLE access.principal_assignment RENAME TO unavailable_assignment');
  try {
    expect(await readAssignment(f.pool, `urn:rezics:request:${f.principal}:${newId(0x2345)}`, f.actor)).toEqual({
      kind: 'unresolved',
    });
  } finally {
    await f.reader.query('ALTER TABLE access.unavailable_assignment RENAME TO principal_assignment');
  }
});

test('assignment identity is immutable and input digest conflicts leave no new effects', async () => {
  const ctx = await f.context(f.principal);
  const request = input();
  await commands.create(ctx, request);
  const before = await snapshot();
  await expect(commands.create(ctx, { ...request, assignedActorId: f.recipient })).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  expect(await snapshot()).toEqual(before);
  for (const column of ['assigned_actor_id', 'principal_id', 'request_id']) {
    await expect(
      f.reader.query(`UPDATE access.principal_assignment SET ${column}=$3 WHERE route=$1 AND principal_id=$2`, [
        routeOf(f.principal),
        f.principal,
        newId(0x2345),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await snapshot()).toEqual(before);
  }
});

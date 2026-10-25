import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
let commands: ReturnType<typeof createGrantCommands>;
beforeAll(async () => {
  f = await grantFixture();
  commands = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
}, 30000);
beforeEach(() => f.reset());
afterAll(() => f?.close());
const key = () => Bun.randomUUIDv7();
function input(actions = ['subject:update'], valid = '(,)') {
  return { resource: f.resource, subjectId: f.recipient, subjectRole: '' as const, actions, valid, key: key() };
}
async function denied(body: () => Promise<unknown>) {
  const before = await f.snapshot();
  await expect(body()).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await f.snapshot()).toEqual(before);
}

test('grant administration requires ordinary permission and cannot exceed grantor actions', async () => {
  const administrator = await f.context();
  const grant = input();
  const result = await commands.create(administrator, grant);
  expect(result.replayed).toBe(false);
  expect(await f.permitted(f.recipient, 'subject:update')).toBe(true);
  await f.reset();
  await f.reader.query('DELETE FROM access.resource_grant WHERE route=$1 AND subject_id=$2 AND action=$3', [
    f.resource.route,
    f.actor,
    'subject:update',
  ]);
  expect(await f.permitted(f.actor, 'subject:read')).toBe(true);
  expect(await f.permitted(f.actor, 'access:grant')).toBe(true);
  await denied(() => commands.create(administrator, { ...grant, key: key() }));
  expect(await f.permitted(f.recipient, 'subject:update')).toBe(false);
});

test('denied grant commands leave no permission effect or receipt', async () => {
  for (const action of ['access:grant', 'subject:read', 'subject:update']) {
    await f.reset();
    await f.reader.query('DELETE FROM access.resource_grant WHERE route=$1 AND subject_id=$2 AND action=$3', [
      f.resource.route,
      f.actor,
      action,
    ]);
    const ctx = await f.context();
    await denied(() => commands.create(ctx, input(['subject:read', 'subject:update'])));
  }
  const ctx = await f.context();
  await denied(() => commands.create(ctx, input(['subject:read', 'unknown:action'])));
  await denied(() => commands.create(ctx, { ...input(), resource: f.otherResource }));
  await denied(() => commands.create(ctx, { ...input(), resource: { ...f.resource, route: f.otherResource.route } }));
});

test('token scope alone and principal permission alone each bound every delegated action', async () => {
  const narrow = await f.context(f.actor, ['subject:read', 'access:grant']);
  await denied(() => commands.create(narrow, input(['subject:read', 'subject:update'])));
  const assignments = createDelegationCommands({ pool: f.pool, access: f.access, action: 'account:delegate' });
  const request = await assignments.create(await f.context(f.principal), {
    principalId: f.principal,
    assignedActorId: f.actor,
    requestId: newId(0x2345),
    valid: '(,)',
    key: key(),
  });
  for (const action of ['access:grant', 'subject:read']) await f.grant(f.principal, action);
  const delegated = await f.context(f.actor, f.actions, request.value.requestedBy);
  await denied(() => commands.create(delegated, input(['subject:read', 'subject:update'])));
  await f.grant(f.principal, 'subject:update');
  await commands.create(delegated, input());
  expect(await f.permitted(f.recipient, 'subject:update')).toBe(true);
});

test('active denies and unresolved separately anchored principal evidence fail closed', async () => {
  const ctx = await f.context();
  await f.reader.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'subject:update','resource','(,)',$3)`,
    [f.resource.route, f.resource.id, f.actor],
  );
  await denied(() => commands.create(ctx, input()));
  await f.reset();
  const assignments = createDelegationCommands({ pool: f.pool, access: f.access, action: 'account:delegate' });
  const assignment = await assignments.create(await f.context(f.principal), {
    principalId: f.principal,
    assignedActorId: f.actor,
    requestId: newId(0x2345),
    valid: '(,)',
    key: key(),
  });
  for (const action of ['access:grant', 'subject:update']) await f.grant(f.principal, action);
  const delegated = await f.context(f.actor, f.actions, assignment.value.requestedBy);
  await f.reader.query('ALTER TABLE access.principal_assignment RENAME TO unavailable_assignment');
  try {
    await denied(() => commands.create(delegated, input()));
  } finally {
    await f.reader.query('ALTER TABLE access.unavailable_assignment RENAME TO principal_assignment');
  }
});

test('change and revoke reauthorize management and every affected action', async () => {
  const ctx = await f.context();
  const grant = input(['subject:read']);
  await commands.create(ctx, grant);
  const changed = {
    ...grant,
    key: key(),
    previous: { actions: grant.actions, valid: grant.valid },
    actions: ['subject:update'],
  };
  await commands.change(ctx, changed);
  expect(await f.permitted(f.recipient, 'subject:read')).toBe(false);
  expect(await f.permitted(f.recipient, 'subject:update')).toBe(true);
  await f.reader.query('DELETE FROM access.resource_grant WHERE route=$1 AND subject_id=$2 AND action=$3', [
    f.resource.route,
    f.actor,
    'subject:update',
  ]);
  await denied(() => commands.revoke(ctx, { ...input(), key: key() }));
  await f.grant(f.actor, 'subject:update');
  await commands.revoke(ctx, input());
  expect(await f.permitted(f.recipient, 'subject:update')).toBe(false);
});

test('receipts bind actual actor client requestedBy operation and input digest', async () => {
  const ctx = await f.context();
  const grant = input();
  const first = await commands.create(ctx, grant);
  const beforeReplay = await f.snapshot();
  expect(await commands.create(ctx, grant)).toEqual({ ...first, replayed: true });
  expect(await f.snapshot()).toEqual(beforeReplay);
  await expect(commands.create(ctx, { ...grant, actions: ['subject:read'] })).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  const otherClient = await f.context(f.actor, f.actions, undefined, 'other-client');
  await expect(commands.create(otherClient, grant)).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await f.snapshot()).toEqual(beforeReplay);
});

test('native grant intervals retain inclusive start exclusive end and WITHOUT OVERLAPS', async () => {
  const ctx = await f.context();
  const first = input(['subject:update'], '[2030-01-01,2030-01-02)');
  await commands.create(ctx, first);
  await commands.create(ctx, input(['subject:update'], '[2030-01-02,2030-01-03)'));
  const before = await f.snapshot();
  await expect(commands.create(ctx, input(['subject:update'], '[2030-01-01,2030-01-03)'))).rejects.toMatchObject({
    code: '23P01',
  });
  expect(await f.snapshot()).toEqual(before);
  for (const valid of ['empty', '(2031-01-01,2031-01-02]', '[2031-01-01,2031-01-02]']) {
    await expect(commands.create(ctx, input(['subject:update'], valid))).rejects.toBeDefined();
    expect(await f.snapshot()).toEqual(before);
  }
  const result = await f.reader.query(
    `SELECT valid @> '2030-01-01'::timestamptz AS starts,
    valid @> '2030-01-02'::timestamptz AS ends FROM access.resource_grant
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 ORDER BY lower(valid)`,
    [f.resource.route, f.resource.id, f.recipient],
  );
  expect(result.rows).toEqual([
    { starts: true, ends: false },
    { starts: false, ends: true },
  ]);
});

test('concurrent identical commands settle once through real transaction retry and receipts', async () => {
  const ctx = await f.context();
  const grant = input();
  const before = await f.snapshot();
  const [one, two] = await Promise.all([commands.create(ctx, grant), commands.create(ctx, grant)]);
  expect(one.transactionId).toBe(two.transactionId);
  expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
  const after = await f.snapshot();
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.events).toBe(before.events + 1);
});

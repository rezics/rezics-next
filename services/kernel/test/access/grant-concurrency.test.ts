import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Access } from '../../src/request/access.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
beforeAll(async () => {
  f = await grantFixture();
  f.pool.options.max = 2;
}, 30000);
beforeEach(() => f.reset());
afterAll(() => f?.close());

/** Synchronize after both real transactions have read an absent receipt. Every
 * authorization still runs production Access, with its real prepared evidence.
 */
function simultaneousAccess(action: string): Access {
  let arrivals = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ...f.access,
    async authorize(client, actor, requested, resource, evidence) {
      const allowed = await f.access.authorize(client, actor, requested, resource, evidence);
      if (requested === action && arrivals < 2) {
        if (++arrivals === 2) release();
        await both;
      }
      return allowed;
    },
  };
}

test('simultaneous grant inserts on two connections settle one effect and replay the same receipt', async () => {
  const commands = createGrantCommands({
    pool: f.pool,
    access: simultaneousAccess('access:grant'),
    managementAction: 'access:grant',
  });
  const context = await f.context();
  const input = {
    resource: f.resource,
    subjectId: f.recipient,
    subjectRole: '' as const,
    actions: ['subject:update'],
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  const before = await f.snapshot();
  const results = await Promise.allSettled([commands.create(context, input), commands.create(context, input)]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  if (results[0]!.status !== 'fulfilled' || results[1]!.status !== 'fulfilled')
    throw new Error('Both commands must settle');
  const [one, two] = [results[0]!.value, results[1]!.value];
  expect(one.transactionId).toBe(two.transactionId);
  expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
  const after = await f.snapshot();
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.events).toBe(before.events + 1);
  expect(await f.permitted(f.recipient, 'subject:update')).toBe(true);
});

test('simultaneous principal assignment inserts preserve one immutable request and receipt', async () => {
  const commands = createDelegationCommands({
    pool: f.pool,
    access: simultaneousAccess('account:delegate'),
    action: 'account:delegate',
  });
  const context = await f.context(f.principal);
  const input = {
    principalId: f.principal,
    assignedActorId: f.actor,
    requestId: newId(0x2345),
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  const before = await f.snapshot(routeOf(f.principal)!);
  const results = await Promise.allSettled([commands.create(context, input), commands.create(context, input)]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  if (results[0]!.status !== 'fulfilled' || results[1]!.status !== 'fulfilled')
    throw new Error('Both commands must settle');
  const [one, two] = [results[0]!.value, results[1]!.value];
  expect(one.transactionId).toBe(two.transactionId);
  expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
  const after = await f.snapshot(routeOf(f.principal)!);
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.events).toBe(before.events + 1);
  const rows = await f.reader.query(
    'SELECT count(*)::integer AS count FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3',
    [routeOf(f.principal), f.principal, input.requestId],
  );
  expect(rows.rows).toEqual([{ count: 1 }]);
});

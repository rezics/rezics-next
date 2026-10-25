import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { grantFixture } from './grant-fixture.ts';

let f: Awaited<ReturnType<typeof grantFixture>>;
beforeAll(async () => {
  f = await grantFixture();
}, 30000);
beforeEach(() => f.reset());
afterAll(() => f?.close());

test('a grantor can revoke its own action using permission held before the mutation', async () => {
  const commands = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  const context = await f.context();
  const before = await f.snapshot();
  const result = await commands.revoke(context, {
    resource: f.resource,
    subjectId: f.actor,
    subjectRole: '',
    actions: ['subject:update'],
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  });
  expect(result.replayed).toBe(false);
  expect(await f.permitted(f.actor, 'subject:update')).toBe(false);
  expect(await f.permitted(f.actor, 'subject:read')).toBe(true);
  expect(await f.permitted(f.actor, 'access:grant')).toBe(true);
  const after = await f.snapshot();
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.events).toBe(before.events + 1);
});

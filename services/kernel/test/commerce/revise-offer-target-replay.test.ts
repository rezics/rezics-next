import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createProfileEntryFixture,
  entryKey,
  type NativeProfileFixture,
} from '../library/support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  options: '-c default_transaction_read_only=on',
});
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
  await reader.end();
});
test('offer revise canonical intent binds the exact authorized target so a same-partition different offer cannot replay another offers receipt', async () => {
  const seller = await f.identity(['offer:create', 'offer:manage', 'offer:read']);
  const other = await f.identity(['offer:create', 'offer:manage', 'offer:read']);
  const grants = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  for (const person of [seller, other])
    await grants.create(
      { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30000) },
      {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: person.actor.accountId },
        actions: ['offer:create'],
        valid: '(,)',
        key: entryKey(),
      },
    );
  const commands = createCommerceCommands({ pool: f.pool, access: f.access });
  const targetSubjectId = await f.createSubject('game');
  const input = {
    targetSubjectId,
    title: 'Native target binding',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  };
  const a = await commands.createOffer(seller.actor, input, entryKey());
  const b = await commands.createOffer(seller.actor, { ...input, title: 'Other authorized target' }, entryKey());
  const foreign = await commands.createOffer(other.actor, { ...input, title: 'Foreign target' }, entryKey());
  expect(a.partition).toBe(b.partition);
  const key = entryKey();
  const first = await commands.reviseOffer(seller.actor, a.value.id, { unitAmountMinor: 2400 }, key);
  const before = await f.inspect(seller.actor.accountId);
  const stored = await reader.query('SELECT to_jsonb(o) AS row FROM commerce.offer o WHERE route=$1 AND offer_id=$2', [
    routeOf(b.value.id),
    b.value.id,
  ]);
  await expect(commands.reviseOffer(seller.actor, b.value.id, { unitAmountMinor: 2400 }, key)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  expect(await f.inspect(seller.actor.accountId)).toEqual(before);
  expect(
    (
      await reader.query('SELECT to_jsonb(o) AS row FROM commerce.offer o WHERE route=$1 AND offer_id=$2', [
        routeOf(b.value.id),
        b.value.id,
      ])
    ).rows,
  ).toEqual(stored.rows);
  expect(await commands.reviseOffer(seller.actor, a.value.id, { unitAmountMinor: 2400 }, key)).toEqual({
    ...first,
    replayed: true,
  });
  await expect(commands.reviseOffer(seller.actor, a.value.id, { unitAmountMinor: 2500 }, key)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  await expect(
    commands.reviseOffer(seller.actor, foreign.value.id, { unitAmountMinor: 2400 }, key),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await f.inspect(seller.actor.accountId)).toEqual(before);
}, 120000);

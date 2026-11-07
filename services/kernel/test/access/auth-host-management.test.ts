import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { authDeletionHandleRead } from '@rezics/auth';
import { newId, routeOf } from '../../src/route/route.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture(pool);
});
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

test('a manager confirms the actual automated target handle with bounded native reads and preserved failures', async () => {
  const human = await f.person('confirmation_manager');
  const subject = await f.automated('confirmation_automation', human);
  const operations = f.bindings.accountOperations;
  expect(operations.context).toBe(f.bindings.accountManagementReads.context);
  expect(operations.readOperatorTransferState).toBe(f.bindings.accountManagementReads.readOperatorTransferState);
  expect(authDeletionHandleRead(operations)).toBeDefined();
  const read = (accountId: string) => operations.readDeletionHandle!(human.bearer, accountId, operations.context());
  expect(await read(human.accountId)).toBe('confirmation_manager');
  expect(await read(subject.accountId)).toBe('confirmation_automation');
  expect(await read(newId(0x4567))).toBeNull();
  await expect(
    operations.readDeletionHandle!(human.bearer, subject.accountId, {
      pool,
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow();
  await expect(
    operations.readDeletionHandle!('invalid-token', subject.accountId, operations.context()),
  ).rejects.toThrow();
  const original = await pool.query('SELECT state,handle FROM access.account WHERE route=$1 AND account_id=$2', [
    routeOf(subject.accountId),
    subject.accountId,
  ]);
  expect(original.rows).toEqual([{ state: 'active', handle: 'confirmation_automation' }]);
}, 120000);

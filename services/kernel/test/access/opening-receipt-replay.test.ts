import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { AuthBindingDeniedError } from '../../src/access/auth-bindings.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
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

async function openingFixture(key: string) {
  const human = await f.person(`${key}-owner`);
  const subject = await f.automated(`${key}-bot`, human);
  const operation = {
    kind: 'opening' as const,
    operatorAccountId: human.accountId,
    subjectAccountId: subject.accountId,
    authorization: 'approval-request',
  };
  const approve = () =>
    f.approval().approve(human.bearer, { operationKey: key, operation }, { pool, deadline: Date.now() + 10000 });
  const approved = await approve();
  const execute = (authorization = approved.reference) =>
    f.host.workflows.authorizeOperatorOpening({ ...operation, key, authorization });
  const issue = (receiptId: string) =>
    f.host.service.internal.openAutomatedSession({
      authorization: receiptId,
      subjectAccountId: subject.accountId,
      headers: human.headers,
    });
  const snapshot = async () => ({
    openings: (
      await pool.query(
        'SELECT r.*, xmin::text AS revision FROM access.operator_opening_receipt r WHERE operator_account_id=$1 ORDER BY receipt_id',
        [human.accountId],
      )
    ).rows,
    receipts: (
      await pool.query(
        "SELECT r.*, xmin::text AS revision FROM core.receipt r WHERE actor_account_id=$1 AND command_kind LIKE 'access.operator.opening-%' ORDER BY transaction_id",
        [human.accountId],
      )
    ).rows,
    sessions: (await f.authPool.query('SELECT * FROM session WHERE "userId"=$1 ORDER BY id', [subject.accountId])).rows,
  });
  return { human, subject, operation, approved, approve, execute, issue, snapshot };
}

test('native opening execution and restart replay return one receipt without consuming it or repeating writes', async () => {
  const o = await openingFixture('receipt-replay');
  const first = await o.execute();
  const before = await o.snapshot();
  expect(before.openings).toHaveLength(1);
  expect(before.receipts).toHaveLength(1);
  expect(before.openings[0].consumed_at).toBeNull();
  expect(before.sessions).toHaveLength(0);
  await f.restart();
  expect(await o.execute()).toEqual(first);
  expect(await o.snapshot()).toEqual(before);
  const fresh = await o.approve();
  expect(await o.execute(fresh.reference)).toEqual(first);
  expect(await o.snapshot()).toEqual(before);

  expect((await o.issue(first.receiptId)).status).toBe(200);
  const consumed = await o.snapshot();
  expect(consumed.openings).toHaveLength(1);
  expect(consumed.openings[0].consumed_at).not.toBeNull();
  expect(consumed.receipts).toHaveLength(2);
  expect(consumed.sessions).toHaveLength(1);
  await expect(o.issue(first.receiptId)).rejects.toThrow();
  expect(await o.snapshot()).toEqual(consumed);
  expect(await o.execute()).toEqual(first);
  expect(await o.snapshot()).toEqual(consumed);
});

test('changing a native opening request under its original key is a refusal without effects', async () => {
  const o = await openingFixture('receipt-conflict');
  await o.execute();
  const context = await f.bindings.workflowPorts.authorizeOperation!(o.approved.reference, o.operation);
  const key = f.bindings.workflowPorts.stableCommandKey!(context, 'session-opening');
  const before = await o.snapshot();
  await expect(
    f.bindings.workflowPorts.authorizeOpening!(context, {
      operatorAccountId: o.human.accountId,
      subjectAccountId: o.subject.accountId,
      purpose: 'credential-management' as 'session',
      key,
    }),
  ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  expect(await o.snapshot()).toEqual(before);
});

test('revoked operator authority denies both opening replay and session issuance without consuming the receipt', async () => {
  const o = await openingFixture('receipt-revoked');
  const first = await o.execute();
  await f.COMMANDS.internalLifecycle.raiseFence({ accountId: o.human.accountId, key: 'revoke-opening-operator' });
  const before = await o.snapshot();
  await expect(o.execute()).rejects.toThrow();
  await expect(o.issue(first.receiptId)).rejects.toThrow();
  expect(await o.snapshot()).toEqual(before);
  expect(before.openings[0].consumed_at).toBeNull();
});

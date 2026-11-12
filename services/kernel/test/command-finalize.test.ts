import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createPool } from '../src/database/pool.ts';
import { configureTestReceiptKeys } from './support/receipt-keys.ts';
import {
  runCommand,
  currentCommand,
  authoritativeTimeValue,
  registerCommandCallback,
  type CommandAuthorization,
  type CommandAttempt,
  type CommandAuthorizationMode,
  type CommandTransaction,
} from '../src/command/command.ts';

const pool = createPool(process.env.DATABASE_URL!);
configureTestReceiptKeys(pool);
const admin = new Pool({ connectionString: process.env.DATABASE_URL! });
const actor = '019a1b2c-3d4e-7f00-8a00-123400000001';
beforeAll(async () => {
  await admin.query('CREATE TABLE public.finalize_resource(id uuid PRIMARY KEY)');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
function fixture() {
  const order: string[] = [];
  const attempts: CommandAttempt[] = [];
  const proofs: object[] = [];
  let fail = false;
  const authorization: CommandAuthorization = {
    action: 'fixture:create',
    resource: { route: 0, id: actor },
    async prepare(attempt) {
      order.push('prepare');
      attempts.push(attempt);
      const proof = {};
      proofs.push(proof);
      return proof;
    },
    async authorize(tx, attempt, proof) {
      order.push('authorize');
      expect(proof).toBe(proofs.at(-1));
      expect(attempt).toBe(attempts.at(-1)!);
      expect(attempt.time).toBe(attempts.at(-1)!.time);
      return 'execute';
    },
    async finalize(tx, attempt, proof) {
      order.push('finalize');
      expect(
        (await tx.query('SELECT 1 FROM core.receipt WHERE idempotency_key=$1', [options.receipt.key])).rows,
      ).toEqual([]);
      expect(currentCommand(tx).time).toBe(attempt.time);
      expect(attempt).toBe(attempts.at(-1)!);
      expect(attempt.time).toBe(attempts.at(-1)!.time);
      expect(attempt.basis).toBe(attempts.at(-1)!.basis);
      expect(proof).toBe(proofs.at(-1));
      expect(authoritativeTimeValue(attempt.time)).toBeString();
      if (fail) throw new Error('finalizer failure');
    },
    denied() {
      return new Error('denied');
    },
  };
  const options = {
    partition: 213,
    basis: { actorAccountId: actor, clientId: 'web', requestedBy: null },
    authorization,
    receipt: { actorAccountId: actor, kind: 'fixture.finalize', key: Bun.randomUUIDv7(), digest: Buffer.alloc(32) },
  };
  return {
    order,
    attempts,
    proofs,
    options,
    fail() {
      fail = true;
    },
  };
}
test('optional finalizer follows body and precedes receipt/outbox, with zero finalization on replay or body failure', async () => {
  const f = fixture();
  const body = async () => {
    f.order.push('body');
    return { value: true, events: [{ type: 'com.rezics.fixture.finalize.v1', data: {} }] };
  };
  await runCommand(pool, f.options, body);
  expect(f.order).toEqual(['prepare', 'authorize', 'body', 'finalize']);
  expect((await runCommand(pool, f.options, body)).replayed).toBe(true);
  expect(f.order).toEqual(['prepare', 'authorize', 'body', 'finalize', 'prepare', 'authorize']);
  const failed = fixture();
  await expect(
    runCommand(pool, failed.options, async () => {
      throw new Error('body failure');
    }),
  ).rejects.toThrow('body failure');
  expect(failed.order).toEqual(['prepare', 'authorize']);
});
test('throwing finalizer rolls back domain rows, receipt and outbox', async () => {
  const f = fixture();
  f.fail();
  const before = (await admin.query('SELECT position FROM core.partition WHERE partition_no=213')).rows;
  const id = Bun.randomUUIDv7();
  await expect(
    runCommand(pool, f.options, async (tx) => {
      await tx.query('INSERT INTO public.finalize_resource VALUES ($1)', [id]);
      return { value: true, events: [{ type: 'com.rezics.fixture.finalize.v1', data: {} }] };
    }),
  ).rejects.toThrow('finalizer failure');
  expect((await admin.query('SELECT * FROM public.finalize_resource WHERE id=$1', [id])).rows).toEqual([]);
  expect(
    (await admin.query('SELECT * FROM core.receipt WHERE idempotency_key=$1', [f.options.receipt.key])).rows,
  ).toEqual([]);
  expect((await admin.query('SELECT position FROM core.partition WHERE partition_no=213')).rows).toEqual(before);
});
test('retry uses fresh proof and time and finalizes only the successful body', async () => {
  const f = fixture();
  let bodies = 0;
  await runCommand(pool, f.options, async () => {
    if (++bodies === 1) throw Object.assign(new Error('serialize'), { code: '40001' });
    return { value: true, events: [{ type: 'com.rezics.fixture.finalize.v1', data: {} }] };
  });
  expect(f.order).toEqual(['prepare', 'authorize', 'prepare', 'authorize', 'finalize']);
  expect(f.proofs[0]).not.toBe(f.proofs[1]);
  expect(f.attempts[0]!.time).not.toBe(f.attempts[1]!.time);
});

function callbackFixture(mode: CommandAuthorizationMode = 'execute') {
  const order: string[] = [];
  const callbackIds: string[] = [];
  const authorization: CommandAuthorization = {
    action: 'fixture:create',
    resource: { route: 0, id: actor },
    authorize(tx) {
      order.push('authorize');
      registerCommandCallback(tx, (transactionId) => {
        order.push('callback:first');
        callbackIds.push(transactionId);
      });
      registerCommandCallback(tx, (transactionId) => {
        order.push('callback:second');
        callbackIds.push(transactionId);
      });
      return Promise.resolve(mode);
    },
    async finalize() {
      order.push('finalize');
    },
    denied() {
      return new Error('receipt only');
    },
  };
  const options = {
    partition: 213,
    basis: { actorAccountId: actor, clientId: 'web', requestedBy: null },
    authorization,
    receipt: { actorAccountId: actor, kind: 'fixture.callback', key: Bun.randomUUIDv7(), digest: Buffer.alloc(32) },
  };
  return { order, callbackIds, options };
}

test('registered callbacks run after finalization once, and never on receipt replay or denial', async () => {
  const successful = callbackFixture();
  const body = async () => {
    successful.order.push('body');
    return { value: true, events: [{ type: 'com.rezics.fixture.finalize.v1', data: {} }] };
  };
  const first = await runCommand(pool, successful.options, body);
  expect(successful.order).toEqual(['authorize', 'body', 'finalize', 'callback:first', 'callback:second']);
  expect(successful.callbackIds).toEqual([first.transactionId, first.transactionId]);
  expect((await runCommand(pool, successful.options, body)).replayed).toBe(true);
  expect(successful.callbackIds).toEqual([first.transactionId, first.transactionId]);

  const denied = callbackFixture('receipt-only');
  await expect(
    runCommand(pool, denied.options, async () => {
      throw new Error('receipt-only command ran its body');
    }),
  ).rejects.toThrow('receipt only');
  expect(denied.callbackIds).toEqual([]);
});

test('registered callbacks are discarded after a failed body and a retried attempt', async () => {
  const failed = callbackFixture();
  await expect(
    runCommand(pool, failed.options, async () => {
      throw new Error('body failure');
    }),
  ).rejects.toThrow('body failure');
  expect(failed.callbackIds).toEqual([]);

  const retried = callbackFixture();
  let bodies = 0;
  let successfulTransaction = '';
  const result = await runCommand(pool, retried.options, async (_tx, context) => {
    if (++bodies === 1) throw Object.assign(new Error('serialize'), { code: '40001' });
    successfulTransaction = context.transactionId;
    return { value: true, events: [{ type: 'com.rezics.fixture.finalize.v1', data: {} }] };
  });
  expect(result.transactionId).toBe(successfulTransaction);
  expect(retried.callbackIds).toEqual([successfulTransaction, successfulTransaction]);
  expect(retried.order.filter((item) => item === 'callback:first')).toHaveLength(1);
  expect(retried.order.filter((item) => item === 'callback:second')).toHaveLength(1);
});

test('registering a callback outside a live command transaction throws', () => {
  expect(() => registerCommandCallback({} as CommandTransaction, () => {})).toThrow('No live command transaction');
});

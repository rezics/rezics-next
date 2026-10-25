import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createPool } from '../src/database/pool.ts';
import {
  runCommand,
  currentCommand,
  authoritativeTimeValue,
  type CommandAuthorization,
  type CommandAttempt,
} from '../src/command/command.ts';

const pool = createPool(process.env.DATABASE_URL!);
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

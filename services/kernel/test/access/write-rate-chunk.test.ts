import { afterAll, beforeAll, expect, expectTypeOf, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { nativeModule } from './durable-initiator.test.ts';
import {
  createWriteRateLimiter,
  WriteRateUnavailableError,
  type DurableWriteRateLimiter,
  type WriteRateLimiter,
} from '../../src/access/write-rate.ts';
import { bindAccountRateIdentity, rateIdentity } from '../../src/access/write-rate-identity.ts';
import { expireWriteRateCounters } from '../../src/access/write-rate-expiry.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkStatement } from '../support/partition-binding.ts';

let h: Awaited<ReturnType<typeof nativeModule>>;
beforeAll(async () => {
  h = await nativeModule();
}, 60000);
afterAll(async () => h?.close());
const secret = 'chunk-private-deployment-key-at-least-32-bytes';
const limiter = createWriteRateLimiter({
  secret,
  overrides: JSON.stringify({
    'new-account': { write: { maximum: 10, seconds: 60 } },
    member: { write: { maximum: 20, seconds: 60 } },
    trusted: { write: { maximum: 30, seconds: 60 } },
  }),
});

async function count(id: string) {
  const digest = createHmac('sha256', secret).update(`account:${id}`).digest('hex');
  return (
    await h.db.admin.query(
      'SELECT count FROM access.write_rate_counter WHERE route=$1 AND identity_digest=$2 AND family=$3',
      [0x1234, digest, 'write'],
    )
  ).rows[0]?.count;
}

test('additive durable port preserves spend-only implementations', () => {
  expectTypeOf<keyof WriteRateLimiter>().toEqualTypeOf<'spend'>();
  expectTypeOf<ReturnType<typeof createWriteRateLimiter>>().toEqualTypeOf<DurableWriteRateLimiter>();
});

test('restored chunk uses the initiator identity and class at step T, sharing interactive budgets', async () => {
  const f = await h.fixture();
  const restoreContext = h.context();
  const access = h.nativeAccess();
  const restorer = createInitiatorRestorer({
    pool: h.db.pool,
    access,
    readOperation: h.readOperation,
    readConsent: h.readConsent,
  });
  // Mint a real future step T: the immutable creation time stays unchanged.
  await runCommand(
    h.db.pool,
    {
      partition: partitionOf(f.target.route),
      deadline: restoreContext.deadline,
      basis: { actorAccountId: f.id, clientId: f.clientId, requestedBy: null },
      clock: () => new Date(Date.now() + 8 * 86400000),
      authorization: {
        action: 'subject:write',
        resource: f.target,
        denied: () => new Error('denied'),
        async authorize() {
          return 'execute';
        },
        async prepare(attempt) {
          const actor = await restorer.restoreInitiator(
            { operation: f.operation, action: 'subject:write', anchor: f.anchor, context: restoreContext },
            attempt.time,
          );
          const context = { ...h.context(), actor };
          expect(rateIdentity(context, secret).rateClass).toBe('member');
          expect(new Date(authoritativeTimeValue(attempt.time)).getTime()).toBeGreaterThan(Date.now() + 7 * 86400000);
          expect(await limiter.spendChunk(context, { operation: f.operation, index: 0 }, 'write', 15)).toEqual({
            allowed: true,
          });
          expect(await limiter.spend(context, 'write', 5)).toEqual({ allowed: true });
          expect((await limiter.spend(context, 'write')).allowed).toBe(false);
        },
      },
    },
    async () => ({ value: {}, events: [{ type: 'durable-test.step', data: f.operation }] }),
  );
  expect(await count(f.id)).toBe(20);
  await h.db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    0x1234,
    f.id,
  ]);
  await h.step(f, {
    async onActor(actor) {
      const context = { ...h.context(), actor };
      expect(rateIdentity(context, secret).rateClass).toBe('trusted');
      expect(await limiter.spendChunk(context, { operation: f.operation, index: 1 }, 'write', 10)).toEqual({
        allowed: true,
      });
    },
  });
  expect(await count(f.id)).toBe(30);
});

test('same chunk retry is free, refusal records no ledger, and retry after the window spends once', async () => {
  const f = await h.fixture();
  const chunk = { operation: f.operation, index: 0 };
  async function spend(index: number, units: number) {
    return h.step(f, {
      async onActor(actor) {
        const context = { ...h.context(), actor };
        const result = await limiter.spendChunk(context, { ...chunk, index }, 'write', units);
        if (index === 1 && (await count(f.id)) === 7) expect(result).toEqual({ allowed: false, retryAfter: 60 });
        else expect(result).toEqual({ allowed: true });
      },
    });
  }
  await spend(0, 7);
  await spend(0, 7);
  expect(await count(f.id)).toBe(7);
  await spend(1, 4);
  expect(
    (
      await h.db.admin.query(
        'SELECT chunk_index FROM access.write_rate_chunk WHERE route=$1 AND operation_id=$2 ORDER BY chunk_index',
        [0x1234, f.operation.id],
      )
    ).rows,
  ).toEqual([{ chunk_index: '0' }]);
  // Advance operational window storage instead of waiting a minute in this test.
  await h.db.admin.query(
    "UPDATE access.write_rate_counter SET expires_at='2020-01-01' WHERE route=$1 AND identity_digest=$2",
    [0x1234, createHmac('sha256', secret).update(`account:${f.id}`).digest('hex')],
  );
  await spend(1, 4);
  await spend(1, 4);
  expect(await count(f.id)).toBe(4);
  await h.db.admin.query(
    "UPDATE access.write_rate_chunk SET expires_at='2020-01-01' WHERE route=$1 AND operation_id=$2 AND chunk_index=0",
    [0x1234, f.operation.id],
  );
  await spend(0, 3);
  expect(await count(f.id)).toBe(7);
});

test('revoked restoration never reaches a counter; an unbound actor cannot spend', async () => {
  const f = await h.fixture();
  await h.db.admin.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    0x1234,
    f.id,
  ]);
  let calls = 0;
  await expect(
    h.step(f, {
      async onActor() {
        calls++;
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await count(f.id)).toBeUndefined();
  await expect(
    limiter.spendChunk({ ...h.context(), actor: { ...f.creator } }, { operation: f.operation, index: 0 }, 'write', 1),
  ).rejects.toBeInstanceOf(WriteRateUnavailableError);
});

test('invalid chunk units and indices fail before storage', async () => {
  const f = await h.fixture();
  const context = { ...h.context(), actor: f.creator };
  for (const units of [0, -1, 101, 1.5, NaN, Infinity])
    await expect(
      limiter.spendChunk(context, { operation: f.operation, index: 0 }, 'write', units),
    ).rejects.toBeInstanceOf(RangeError);
  for (const index of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await expect(limiter.spendChunk(context, { operation: f.operation, index }, 'write', 1)).rejects.toBeInstanceOf(
      RangeError,
    );
  expect(await count(f.id)).toBeUndefined();
});

test('concurrent duplicate admissions never double charge, including snapshot collisions', async () => {
  const f = await h.fixture();
  const actor = { ...f.creator };
  const context = { ...h.context(), actor };
  bindAccountRateIdentity(
    actor,
    context,
    { route: 0x1234, createdAt: null, rateTier: 'ordinary', operatorAccountId: null },
    Infinity,
  );
  const chunk = { operation: f.operation, index: 0 };
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => limiter.spendChunk(context, chunk, 'write', 3)),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') expect(result.value).toEqual({ allowed: true });
    else expect(result.reason).toBeInstanceOf(WriteRateUnavailableError);
  }
  expect(await limiter.spendChunk(context, chunk, 'write', 3)).toEqual({ allowed: true });
  expect(await count(f.id)).toBe(3);
});

test('expiry bounds combined counter and ledger deletion to 1000 on one route', async () => {
  const route = 0x7310;
  const operation = newId(route);
  await h.db.admin.query(
    `INSERT INTO access.write_rate_chunk(route,identity_digest,operation_id,chunk_index,expires_at)
    SELECT $1,lpad(to_hex(i),64,'0'),$2,i,'2020-01-01' FROM generate_series(1,1005) i`,
    [route, operation],
  );
  await h.db.admin.query(
    `INSERT INTO access.write_rate_chunk VALUES ($1,$2,$3,0,statement_timestamp()+interval '1 hour'),($4,$2,$3,0,'2020-01-01')`,
    [route, 'a'.repeat(64), operation, route + 1],
  );
  expect(await expireWriteRateCounters(h.db.pool, route)).toBe(1000);
  expect(await expireWriteRateCounters(h.db.pool, route)).toBe(5);
  expect(await expireWriteRateCounters(h.db.pool, route)).toBe(0);
  expect(await expireWriteRateCounters(h.db.pool, route + 1)).toBe(1);
  const sql = (await import('../../src/access/write-rate-chunk.sql')).default;
  expect(await checkStatement(h.db.admin, { sql: sql.sql, params: [...sql.params] })).toEqual({
    bound: true,
    parameter: 'route',
  });
});

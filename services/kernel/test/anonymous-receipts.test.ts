import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ANONYMOUS_PRINCIPAL_ID,
  authoritativeTimeValue,
  currentCommand,
  IdempotencyConflictError,
  normalizeCommandKey,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type PrincipalCommandOptions,
} from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';
import {
  anonymousCommandTarget,
  anonymousRequestDigest,
  idempotencyKeyOf,
  requestDigest,
} from '../src/http/request.ts';
import type { AccountActor } from '../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
afterAll(() => pool.end());
const identity = principalCommandIdentity({ kind: 'anonymous' });
const event = { type: 'com.rezics.test.anonymous.v1', data: {} };
const semantic = { target: 'thread:one', reason: 'spam', content: 'details' };
const digest = (body = semantic, proof = 'front-verified-proof') =>
  anonymousRequestDigest('report.create', { semantic: body, abuse: { turnstile: proof } });
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'web',
  requestedBy: null,
  scopes: [],
  authnEpoch: 1,
};
class Denied extends Error {}
// These trusted fixtures prove executor ordering/atomicity only. Installed Access
// and the owning eligibility formula are exercised in the separate Access suite.
function options(partition: number, key = randomUUID()): PrincipalCommandOptions {
  const authorization: CommandAuthorization = {
    action: 'report:create',
    resource: { route: partition << 4, id: actor.accountId },
    async authorize() {
      return 'execute';
    },
    denied: () => new Denied(),
  };
  return { ...identity, partition, authorization, receipt: { kind: 'report.create', key, digest: digest() } };
}
const body = async () => ({ value: { accepted: true }, events: [event] });
async function state(partition: number) {
  return (
    await pool.query(
      `SELECT position,
    (SELECT count(*)::int FROM core.receipt WHERE partition_no=$1) AS receipts,
    (SELECT count(*)::int FROM core.outbox WHERE partition_no=$1) AS events
    FROM core.partition WHERE partition_no=$1`,
      [partition],
    )
  ).rows[0];
}

test('anonymous possession replays one effect across textual case and fresh abuse proofs; another key is distinct', async () => {
  const input = options(90);
  let effects = 0;
  const execute: Parameters<typeof runCommand<unknown>>[2] = async (tx) => {
    effects++;
    expect(currentCommand(tx).basis).toEqual({
      principal: identity.principal,
      actorAccountId: null,
      clientId: null,
      requestedBy: null,
    });
    return body();
  };
  const first = await runCommand(pool, input, execute);
  const replay = await runCommand(
    pool,
    {
      ...options(90, input.receipt!.key.toUpperCase()),
      receipt: { ...input.receipt!, key: input.receipt!.key.toUpperCase(), digest: digest(semantic, 'fresh-proof') },
    },
    execute,
  );
  expect(replay).toEqual({ ...first, replayed: true });
  expect(effects).toBe(1);
  expect(await state(90)).toEqual({ position: '1', receipts: 1, events: 1 });
  expect(await runCommand(pool, options(90), execute)).toMatchObject({ replayed: false, position: 2n });
  expect(effects).toBe(2);
  const { rows } = await pool.query(`SELECT principal_kind, principal_id, actor_account_id, client_id, requested_by
    FROM editorial.write_basis WHERE partition_no=90 ORDER BY position`);
  expect(rows).toEqual(
    Array(2).fill({
      principal_kind: 'anonymous',
      principal_id: ANONYMOUS_PRINCIPAL_ID,
      actor_account_id: null,
      client_id: null,
      requested_by: null,
    }),
  );
  expect((await pool.query('SELECT 1 FROM access.account WHERE account_id=$1', [ANONYMOUS_PRINCIPAL_ID])).rows).toEqual(
    [],
  );
  expect(
    (
      await pool.query(`SELECT principal_kind, principal_id, actor_account_id, idempotency_key FROM core.receipt
    WHERE partition_no=90 ORDER BY position`)
    ).rows[0],
  ).toEqual({
    principal_kind: 'anonymous',
    principal_id: ANONYMOUS_PRINCIPAL_ID,
    actor_account_id: null,
    idempotency_key: input.receipt!.key,
  });
});

test('every effect-relevant change conflicts; semantic normalization and abuse proof rotation do not', async () => {
  const input = options(91);
  const first = await runCommand(pool, input, body);
  for (const changed of [
    { ...semantic, target: 'thread:two' },
    { ...semantic, reason: 'other' },
    { ...semantic, content: 'changed' },
  ]) {
    await expect(
      runCommand(pool, { ...input, receipt: { ...input.receipt!, digest: digest(changed) } }, body),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  }
  const normalized = anonymousRequestDigest('report.create', {
    semantic: { content: semantic.content, reason: semantic.reason, target: semantic.target },
    abuse: { turnstile: 'another-proof', csrf: 'fresh-csrf', ip: 'different-ip' },
  });
  expect(Buffer.from(normalized)).toEqual(Buffer.from(input.receipt!.digest));
  expect(Buffer.from(requestDigest('report.create', { kind: 'anonymous' }, semantic))).toEqual(Buffer.from(normalized));
  expect(Buffer.from(anonymousRequestDigest('report.update', { semantic }))).not.toEqual(Buffer.from(normalized));
  expect(await runCommand(pool, { ...input, receipt: { ...input.receipt!, digest: normalized } }, body)).toEqual({
    ...first,
    replayed: true,
  });
  expect(await state(91)).toEqual({ position: '1', receipts: 1, events: 1 });
});

test('denial precedes real receipt reads on hits, misses and mismatches', async () => {
  const input = options(92);
  await runCommand(pool, input, body);
  let receiptReads = 0;
  const query = pool.query.bind(pool);
  // Instrument checked-out clients, retaining the actual PostgreSQL driver/SQL.
  pool.on('acquire', (client) => {
    const original = client.query.bind(client);
    client.query = ((...args: Parameters<typeof client.query>) => {
      if (/FROM core\.receipt/.test(String(args[0]))) receiptReads++;
      return original(...args);
    }) as typeof client.query;
  });
  let checks = 0;
  const denied: CommandAuthorization = {
    ...input.authorization!,
    async authorize() {
      checks++;
      throw new Denied();
    },
  };
  for (const receipt of [
    input.receipt!,
    { ...input.receipt!, digest: digest({ ...semantic, content: 'changed' }) },
    { ...input.receipt!, key: randomUUID() },
  ]) {
    await expect(
      runCommand(pool, { ...input, receipt, authorization: denied }, async () => {
        throw new Error('denied command reached effect');
      }),
    ).rejects.toBeInstanceOf(Denied);
  }
  expect(checks).toBe(3);
  expect(receiptReads).toBe(0);
  expect((await query('SELECT position FROM core.partition WHERE partition_no=92')).rows).toEqual([{ position: '1' }]);
  expect(await state(92)).toEqual({ position: '1', receipts: 1, events: 1 });
});

test('concurrent identical keys converge and concurrent differing digests conflict', async () => {
  for (const mismatch of [false, true]) {
    const input = options(mismatch ? 94 : 93);
    const second = {
      ...input,
      receipt: { ...input.receipt!, digest: mismatch ? digest({ ...semantic, reason: 'other' }) : digest() },
    };
    const execute: Parameters<typeof runCommand<unknown>>[2] = async (tx) => {
      await tx.query('SELECT pg_sleep(0.04)');
      return body();
    };
    const results = await Promise.allSettled([runCommand(pool, input, execute), runCommand(pool, second, execute)]);
    if (mismatch) {
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason)[0]).toBeInstanceOf(
        IdempotencyConflictError,
      );
    } else {
      const values = results.map((r) => {
        if (r.status === 'rejected') throw r.reason;
        return r.value;
      });
      expect(values.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(values[0]!.transactionId).toBe(values[1]!.transactionId);
      expect(values[0]!.position).toBe(values[1]!.position);
    }
    expect(await state(input.partition)).toEqual({ position: '1', receipts: 1, events: 1 });
  }
});

test('anonymous UUIDv4 possession is mandatory before SQL; account text keys stay compatible', async () => {
  const trap = new Proxy(pool, {
    get() {
      throw new Error('invalid identity/key touched the pool');
    },
  });
  for (const key of [
    '',
    'short',
    ANONYMOUS_PRINCIPAL_ID,
    '019a1b2c-3d4e-7f00-8a00-beef00000001',
    '11111111-1111-1111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa',
    undefined,
  ]) {
    const input = options(95);
    await expect(
      runCommand(trap, { ...input, receipt: { ...input.receipt!, key: key as string } }, body),
    ).rejects.toBeInstanceOf(TypeError);
  }
  const input = options(95);
  delete input.receipt;
  await expect(runCommand(trap, input, body)).rejects.toBeInstanceOf(TypeError);
  expect(normalizeCommandKey(identity.principal, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  expect(idempotencyKeyOf('"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"', identity.principal)).toBe(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  expect(() => idempotencyKeyOf('"short"', identity.principal)).toThrow();
  expect(normalizeCommandKey({ kind: 'account', id: actor.accountId }, 'Text Key')).toBe('Text Key');
  expect(
    await runCommand(
      pool,
      {
        ...principalCommandIdentity(actor),
        partition: 95,
        receipt: { kind: 'report.create', key: 'Text Key', digest: digest() },
      },
      body,
    ),
  ).toMatchObject({ replayed: false });
});

test('contradictory mixed identity, unknown kind and account-nil marker fail before checkout', async () => {
  const trap = new Proxy(pool, {
    get() {
      throw new Error('invalid identity touched the pool');
    },
  });
  const base = options(96);
  for (const forged of [
    { ...base, actorAccountId: actor.accountId },
    { ...base, basis: { ...base.basis, actorAccountId: actor.accountId } },
    { ...base, receipt: { ...base.receipt, actorAccountId: actor.accountId } },
    { ...base, principal: { kind: 'unknown', id: ANONYMOUS_PRINCIPAL_ID } },
    { ...base, principal: { kind: 'anonymous', id: actor.accountId } },
    { ...base, principal: { kind: 'account', id: ANONYMOUS_PRINCIPAL_ID } },
  ])
    await expect(runCommand(trap, forged as PrincipalCommandOptions, body)).rejects.toBeInstanceOf(TypeError);
});

test('rollback leaves no basis, receipt, event or position; serialization retry uses a fresh T', async () => {
  const input = options(97);
  await expect(
    runCommand(pool, input, async () => {
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await state(97)).toEqual({ position: '0', receipts: 0, events: 0 });
  const checked: string[] = [];
  const authorization: CommandAuthorization = {
    ...input.authorization!,
    async authorize(_tx, attempt) {
      checked.push(authoritativeTimeValue(attempt.time));
      return 'execute';
    },
  };
  let attempts = 0;
  await runCommand(pool, { ...input, authorization }, async (tx) => {
    if (++attempts === 1) await tx.query(`DO $$ BEGIN RAISE EXCEPTION 'retry' USING ERRCODE='40001'; END $$`);
    return body();
  });
  expect(checked).toHaveLength(2);
  expect(checked[0]).not.toBe(checked[1]);
  expect(await state(97)).toEqual({ position: '1', receipts: 1, events: 1 });
});

test('anonymous target is stable across retries/case and independent of request proof or semantic body', () => {
  const routeKey = new Uint8Array(32).fill(7);
  const key = randomUUID();
  const target = anonymousCommandTarget(routeKey, 'report.create', key);
  expect(anonymousCommandTarget(routeKey, 'report.create', key.toUpperCase())).toEqual(target);
  expect(anonymousCommandTarget(routeKey, 'report.create', randomUUID())).not.toEqual(target);
  expect(anonymousCommandTarget(routeKey, 'report.update', key)).not.toEqual(target);
  expect(target.id.slice(14, 15)).toBe('8');
  expect(Number.parseInt(target.id.slice(24, 28), 16)).toBe(target.route);
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  ANONYMOUS_PRINCIPAL_ID,
  hasOwnCommandCompletion,
  IdempotencyConflictError,
  noEffect,
  runCommand,
  type CommandAuthorization,
  type CommandPrincipal,
} from '../../src/command/command.ts';
import {
  assertReceiptKeyRing,
  configureReceiptKeys,
  encodeReceiptKey,
  receiptKeyCandidates,
} from '../../src/command/receipt-key.ts';
import { statementOccurrences } from '../support/growth-report.ts';
import { assertGrowthAccessPaths } from '../support/growth-access-path.ts';
import { readConfig } from '../../src/server.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const ring = (current: number, versions = current): KeyRing => ({
  current,
  keys: new Map(Array.from({ length: versions }, (_, n) => [n + 1, Buffer.alloc(32, n + 17)])),
});
const principal: CommandPrincipal = { kind: 'account', id: '019a1b2c-3d4e-7f00-8a00-beef00000001' };
const anonymous: CommandPrincipal = { kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID };
const kind = 'test.receipt-key';
const partition = 4093;
const digest = Buffer.alloc(32, 7);
const authorization: CommandAuthorization = {
  action: 'test:receipt',
  resource: { route: partition << 4, id: principal.id },
  async authorize() {
    return 'execute';
  },
  denied: () => new Error('denied'),
};
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
  configureReceiptKeys(db.pool, ring(3));
});
afterAll(async () => {
  await db?.close();
});

test('versioned tokens bind the kind and principal with unambiguous framing and disclose no raw key', () => {
  const keys = ring(1);
  const raw = 'alice@example.test:1';
  const token = encodeReceiptKey(keys, kind, principal, raw);
  expect(token).toBe(encodeReceiptKey(keys, kind, principal, raw));
  expect(token).toMatch(/^rk1\.1\.[A-Za-z0-9_-]{43}$/);
  expect(token.length).toBeLessThanOrEqual(256);
  expect(token).not.toContain(raw);
  expect(Buffer.from(token.split('.')[2]!, 'base64url').includes(Buffer.from(raw))).toBe(false);
  expect(encodeReceiptKey(keys, kind + 'x', principal, raw)).not.toBe(token);
  expect(encodeReceiptKey(keys, kind, { ...principal, id: randomUUID() }, raw)).not.toBe(token);
  expect(encodeReceiptKey(keys, kind, anonymous, raw)).not.toBe(token);
  expect(encodeReceiptKey(keys, kind, { ...principal, id: principal.id.toUpperCase() }, raw)).toBe(token);
  expect(encodeReceiptKey(keys, 'a\0b', principal, 'c')).not.toBe(encodeReceiptKey(keys, 'a', principal, 'b\0c'));
  const lowEntropy = encodeReceiptKey(keys, kind, principal, '1');
  const framed = JSON.stringify([1, kind, principal.kind, principal.id, '1']);
  expect(lowEntropy).toBe(
    `rk1.1.${createHmac('sha256', Buffer.alloc(32, 17)).update('rezics.receipt-key.v1\0').update(framed).digest('base64url')}`,
  );
  expect(lowEntropy).not.toContain(createHash('sha256').update(framed).digest('base64url'));
  const guessedRing = { current: 1, keys: new Map([[1, Buffer.alloc(32, 99)]]) };
  expect(encodeReceiptKey(guessedRing, kind, principal, '1')).not.toBe(lowEntropy);
});

test('candidates retain two rotations, are deterministically ordered and deduplicate the raw fallback', () => {
  const raw = 'rotated';
  const candidates = receiptKeyCandidates(ring(3), kind, principal, raw);
  expect(candidates).toEqual([1, 2, 3].map((v) => encodeReceiptKey(ring(v), kind, principal, raw)).concat(raw));
  expect(
    receiptKeyCandidates({ current: 3, keys: new Map([...ring(3).keys].reverse()) }, kind, principal, raw),
  ).toEqual(candidates);
  expect(new Set(candidates).size).toBe(candidates.length);
  expect(receiptKeyCandidates(ring(4), kind, principal, raw)).toHaveLength(5);
});

test('startup accepts a dedicated ring, refuses five versions and rejects sealing-key reuse without echoing secrets', () => {
  const encode = (keys: KeyRing) =>
    [...keys.keys].map(([v, k]) => `${v}:${Buffer.from(k).toString('base64url')}`).join(',');
  const env = {
    DATABASE_URL: db.url,
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 90).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 91).toString('base64url')}`,
    KERNEL_RECEIPT_KEYS: encode(ring(4)),
    KERNEL_WRITE_RATE_SECRET: 'receipt-key-test-write-rate-secret-of-at-least-32-bytes',
  };
  expect(readConfig(env).receiptKeys?.keys.size).toBe(4);
  expect(() => readConfig({ ...env, KERNEL_RECEIPT_KEYS: encode(ring(5)) })).toThrow('between 1 and 4');
  expect(() => readConfig({ ...env, KERNEL_RECEIPT_KEYS: env.KERNEL_SESSION_KEYS })).toThrow('must not reuse');
  for (const invalid of [
    '',
    '1:abc',
    `256:${Buffer.alloc(32).toString('base64url')}`,
    `${encode(ring(1))},${encode(ring(1))}`,
  ])
    expect(() => readConfig({ ...env, KERNEL_RECEIPT_KEYS: invalid })).toThrow('KERNEL_RECEIPT_KEYS');
  expect(() => assertReceiptKeyRing(ring(5))).toThrow('between 1 and 4');
});

async function insert(key: string, owner: CommandPrincipal, position: number) {
  const transactionId = randomUUID();
  const value = { exact: ['response', null, 3], nested: { ok: true } };
  await db.admin.query(
    `INSERT INTO core.receipt
    (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
    VALUES($1,$2,$3,$4,$5,$6,2,$7,$8,$9)`,
    [partition, owner.kind, owner.id, kind, key, digest, position, transactionId, value],
  );
  return { value, partition, epoch: 2, position: BigInt(position), transactionId, replayed: true };
}

function options(owner: CommandPrincipal) {
  return {
    partition,
    principal: owner,
    basis: { clientId: owner.kind === 'account' ? 'test' : null, requestedBy: null },
    authorization,
    ...(owner.kind === 'anonymous' ? { receipt: { kind: 'test.receipt-key.lookup', key: randomUUID(), digest } } : {}),
  };
}
const unexpected = async (): Promise<never> => {
  throw new Error('Replay executed the command body');
};

test('both central readers replay raw, current and twice-rotated keys with exact conflicts and position zero', async () => {
  for (const owner of [principal, anonymous]) {
    for (const version of [0, 1, 2, 3]) {
      for (const position of [0, 17]) {
        const raw = randomUUID();
        const stored = version ? encodeReceiptKey(ring(version), kind, owner, raw) : raw;
        const expected = await insert(stored, owner, position);
        const receipt = { kind, key: raw, digest };
        const replay = { ...options(owner), receipt };
        expect(await runCommand(db.pool, replay, unexpected)).toEqual(expected);
        expect(
          (
            await runCommand(db.pool, options(owner), async (tx) =>
              noEffect(await hasOwnCommandCompletion(tx, receipt)),
            )
          ).value,
        ).toBe(true);
        const wrong = { ...receipt, digest: Buffer.alloc(32, 8) };
        await expect(runCommand(db.pool, { ...replay, receipt: wrong }, unexpected)).rejects.toBeInstanceOf(
          IdempotencyConflictError,
        );
        await expect(
          runCommand(db.pool, options(owner), async (tx) => noEffect(await hasOwnCommandCompletion(tx, wrong))),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
        expect(
          (
            await runCommand(db.pool, options(owner), async (tx) =>
              noEffect(await hasOwnCommandCompletion(tx, { ...receipt, key: randomUUID() })),
            )
          ).value,
        ).toBe(false);
      }
    }
  }
});

test('each reader uses one receipt primary-key probe with four retained versions as unrelated receipts grow', async () => {
  configureReceiptKeys(db.pool, ring(4));
  const raw = randomUUID();
  const expected = await insert(encodeReceiptKey(ring(1), kind, principal, raw), principal, 0);
  const receipt = { kind, key: raw, digest };
  const report = await checkGrowth(db, {
    name: 'Receipt key ring central reader probes',
    scales: [64, 512, 4096],
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    indexProbes: 2,
    async grow(database, scale, previous) {
      await database.admin.query(
        `INSERT INTO core.receipt
        (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT $1,'account',$2,$3,'unrelated-' || n,$4,1,0,$5,$8::jsonb
        FROM generate_series($6::int,$7::int) n`,
        [
          partition,
          principal.id,
          kind,
          digest,
          randomUUID(),
          previous + 1,
          scale,
          JSON.stringify({ noise: 'x'.repeat(2048) }),
        ],
      );
      await database.admin.query('ANALYZE core.receipt');
    },
    async operation() {
      expect(await runCommand(db.pool, { ...options(principal), receipt }, unexpected)).toEqual(expected);
      expect(
        (
          await runCommand(db.pool, options(principal), async (tx) =>
            noEffect(await hasOwnCommandCompletion(tx, receipt)),
          )
        ).value,
      ).toBe(true);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([64, 512, 4096]);
  expect(new Set(report.samples.map((s) => s.cost.statements)).size).toBe(1);
  assertGrowthAccessPaths('receipt key ring central reader probes', report.samples, ['core.receipt']);
  for (const { occurrenceRepetitions } of report.samples) {
    for (const repetition of occurrenceRepetitions) {
      const readers = repetition.statements.filter(
        (occurrence) => occurrence.error === null && /FROM core\.receipt/.test(occurrence.statement),
      );
      expect(readers).toHaveLength(2);
      for (const reader of readers) expect(reader.plans.length).toBeGreaterThan(0);
    }
  }
  // Capture the production callers, including own-completion's authorization transaction.
  for (const operation of [
    () => runCommand(db.pool, { ...options(principal), receipt }, unexpected),
    () => runCommand(db.pool, options(principal), async (tx) => noEffect(await hasOwnCommandCompletion(tx, receipt))),
  ]) {
    const { capture: evidence } = await capture(db, operation);
    const probes = evidence.statements.filter((s) => /FROM core\.receipt/.test(s));
    expect(probes).toHaveLength(1);
    expect(probes[0]).toContain('ANY(');
    const readers = statementOccurrences(evidence).statements.filter(
      (occurrence) => occurrence.error === null && /FROM core\.receipt/.test(evidence.statements[occurrence.index]!),
    );
    expect(readers).toHaveLength(1);
    const reader = readers[0]!;
    expect(reader.plans.length).toBeGreaterThan(0);
    const plans = reader.plans.map((index) => {
      expect(evidence.planStatements?.[index]).toBe(reader.index);
      return evidence.plans[index]!;
    });
    const readerCost = costOf({ statements: [evidence.statements[reader.index]!], plans });
    expect(readerCost.plans).toBeGreaterThan(0);
    expect(Object.values(readerCost.relations).every(({ sequentialScans }) => sequentialScans === 0)).toBe(true);
    expect(JSON.stringify(plans)).toContain('"Index Name":"receipt_pkey"');
    const cost = costOf(evidence);
    const operationReceipt = cost.relations['core.receipt'] ?? cost.relations.receipt;
    expect(operationReceipt?.sequentialScans ?? 0).toBe(0);
    expect(JSON.stringify(evidence.plans)).toContain('receipt_pkey');
  }
}, 90_000);

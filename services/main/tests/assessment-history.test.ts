import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  readVerificationAssessmentHistory,
  ASSESSMENT_HISTORY_SQL,
} from '../src/modules/access/assessment-history.ts';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function admission(n: number, change: QueryResultRow = {}): QueryResultRow {
  return {
    id: id(n),
    principal_id: id(100),
    acting_subject: `https://rezics.com/id/${id(101)}`,
    scope_id: 'verification:assess:global',
    action: 'verification.claim-assess',
    idempotency_key: `key-${n}`,
    request_digest: 'a'.repeat(64),
    authority_epoch: '7',
    registered_at: new Date('2020-01-01Z'),
    expires_at: new Date('2020-01-02Z'),
    claimed_at: null,
    state: 'registered',
    graph_receipt: null,
    graph_outcome: null,
    graph_data_epoch: null,
    graph_sequence: null,
    sealed_at: null,
    oversized_fields: false,
    ...change,
  };
}
function terminal(n: number): QueryResultRow {
  return admission(n, {
    state: 'sealed',
    claimed_at: new Date('2020-01-01Z'),
    sealed_at: new Date('2020-01-01Z'),
    graph_outcome: 'succeeded',
    graph_data_epoch: 'native-epoch',
    graph_sequence: '8',
    graph_receipt: `urn:rezics:receipt:${createHash('sha256')
      .update(`${id(n)}\0claim-assess`)
      .digest('hex')}`,
  });
}
function caller(raw: QueryResultRow[], fence = { open: false, generation: '9' }) {
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.startsWith('SHOW')) return { rows: [{ transaction_isolation: 'read committed' }] };
      if (sql.includes('access.recovery_fence')) return { rows: [fence] };
      if (sql.includes('FROM access.admission')) return { rows: raw };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, queries };
}

test('raw windows preserve all IDs and continue after malformed rows, not accepted facts', async () => {
  const raw = Array.from({ length: 33 }, (_, n) =>
    admission(
      n + 1,
      n % 2 ? { registered_at: Infinity } : { oversized_fields: true, acting_subject: null },
    ),
  );
  const { client, queries } = caller(raw);
  const page = await readVerificationAssessmentHistory(client);
  expect(page.rows.map((row) => row.id)).toEqual(raw.slice(0, 32).map((row) => row.id));
  expect(page.rows.every((row) => row.facts === null && row.unresolved.length === 1)).toBe(true);
  expect(page.rows[0]!.unresolved).toEqual(['oversized-fields']);
  expect(page.rows[1]!.unresolved).toEqual(['malformed-fields']);
  expect(page.next).toEqual({ after: id(32), recoveryGeneration: null });
  expect(page.windowExhausted).toBe(false);
  expect(page.endOfHistory).toBe(false);
  expect(queries.at(-1)).toEqual({ sql: ASSESSMENT_HISTORY_SQL.initial, values: [id(0)] });
  expect((await readVerificationAssessmentHistory(client, { cursor: page.next! })).next).toEqual({
    after: id(32),
    recoveryGeneration: null,
  });
  expect(queries.at(-1)).toEqual({ sql: ASSESSMENT_HISTORY_SQL.continuation, values: [id(32)] });
});

test('sealed cancellation/success and in-flight rows retain facts but never original input custody', async () => {
  const success = terminal(1),
    cancelled = { ...terminal(2), graph_outcome: 'cancelled' };
  const claimed = admission(3, { state: 'claimed', claimed_at: new Date('2020-01-01Z') });
  const unexpected = admission(4, { scope_id: 'historical:unexpected' });
  const page = await readVerificationAssessmentHistory(
    caller([success, cancelled, claimed, unexpected]).client,
    { recoveryGeneration: '9' },
  );
  expect(page.rows.map((row) => row.facts?.state)).toEqual([
    'sealed',
    'sealed',
    'claimed',
    'registered',
  ]);
  expect(page.rows.map((row) => row.originalCustody)).toEqual([
    'unknown',
    'unknown',
    'unknown',
    'unknown',
  ]);
  expect(page.rows.map((row) => row.unresolved)).toEqual([
    [],
    [],
    ['in-flight'],
    ['unexpected-scope', 'in-flight'],
  ]);
  expect(page.rows[0]!.facts).toEqual({
    principalId: id(100),
    actingSubject: `https://rezics.com/id/${id(101)}`,
    scope: 'verification:assess:global',
    action: 'verification.claim-assess',
    idempotencyKey: 'key-1',
    requestDigest: 'a'.repeat(64),
    authorityEpoch: '7',
    registeredAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-02T00:00:00.000Z',
    claimedAt: '2020-01-01T00:00:00.000Z',
    state: 'sealed',
    graphReceipt: success.graph_receipt,
    graphOutcome: 'succeeded',
    graphDataEpoch: 'native-epoch',
    graphSequence: '8',
    sealedAt: '2020-01-01T00:00:00.000Z',
  });
  expect(page.rows[2]!.nativeReceipt).toBe(
    `urn:rezics:receipt:${createHash('sha256')
      .update(`${id(3)}\0claim-assess`)
      .digest('hex')}`,
  );
  expect(page.endOfHistory).toBe(true);
  expect(page.cut).toEqual({ state: 'held', recoveryGeneration: '9' });
});

test('missing cuts, open recovery and changed generations never manufacture EOF', async () => {
  const open = caller([], { open: true, generation: '9' });
  const page = await readVerificationAssessmentHistory(open.client);
  expect(page.windowExhausted).toBe(true);
  expect(page.endOfHistory).toBe(false);
  expect(page.cut).toEqual({ state: 'unresolved', reason: 'access-not-quiesced' });
  await expect(
    readVerificationAssessmentHistory(open.client, { recoveryGeneration: '9' }),
  ).rejects.toThrow('Access cut changed');
  await expect(
    readVerificationAssessmentHistory(caller([]).client, { recoveryGeneration: '10' }),
  ).rejects.toThrow('Access cut changed');
});

test('malformed acknowledgement and escaped byte overflow keep explicit unresolved IDs', async () => {
  const raw = [terminal(1), terminal(2), admission(3), admission(4), terminal(5), admission(6)];
  raw[0]!.graph_receipt = 'urn:rezics:receipt:wrong';
  raw[1]!.graph_sequence = '-1';
  raw[2]!.state = 'claimed';
  raw[3]!.graph_receipt = terminal(4).graph_receipt;
  raw[4]!.graph_data_epoch = '\u0001'.repeat(3000);
  raw[5]!.acting_subject = `https://rezics.com/id/${'-'.repeat(36)}`;
  const page = await readVerificationAssessmentHistory(caller(raw).client);
  expect(page.rows.map((row) => row.id)).toEqual(raw.map((row) => row.id));
  expect(page.rows.map((row) => row.facts)).toEqual([null, null, null, null, null, null]);
  expect(page.rows.map((row) => row.unresolved)).toEqual([
    ['malformed-fields'],
    ['malformed-fields'],
    ['malformed-fields'],
    ['malformed-fields'],
    ['oversized-fields'],
    ['malformed-fields'],
  ]);
  expect(page.endOfHistory).toBe(false);
});

test('invalid caller positions fail before any query or lifecycle effects', async () => {
  const { client, queries } = caller([]);
  await expect(
    readVerificationAssessmentHistory(client, {
      cursor: { after: 'wrong', recoveryGeneration: null },
    }),
  ).rejects.toThrow('Invalid');
  await expect(
    readVerificationAssessmentHistory(client, { recoveryGeneration: '-1' }),
  ).rejects.toThrow('Invalid');
  expect(queries).toEqual([]);
});

test('continuations keep their original cut and cannot upgrade an unfenced prefix', async () => {
  const first = await readVerificationAssessmentHistory(
    caller(Array.from({ length: 33 }, (_, n) => terminal(n + 1))).client,
  );
  const { client, queries } = caller([]);
  const last = await readVerificationAssessmentHistory(client, { cursor: first.next! });
  expect(last.endOfHistory).toBe(false);
  expect(last.cut.state).toBe('unresolved');
  expect(queries.some((query) => query.sql.includes('access.recovery_fence'))).toBe(false);
  await expect(
    readVerificationAssessmentHistory(client, {
      cursor: first.next!,
      recoveryGeneration: '9',
    } as never),
  ).rejects.toThrow('Invalid');
  const held = await readVerificationAssessmentHistory(
    caller(Array.from({ length: 33 }, (_, n) => terminal(n + 1))).client,
    { recoveryGeneration: '9' },
  );
  expect(held.next).toEqual({ after: id(32), recoveryGeneration: '9' });
  await expect(
    readVerificationAssessmentHistory(caller([], { open: false, generation: '10' }).client, {
      cursor: held.next!,
    }),
  ).rejects.toThrow('Access cut changed');
});

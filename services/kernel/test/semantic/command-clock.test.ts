import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = { importer: '019a1b2c-3d4e-7f00-8a00-1a0000000071' };
const actions = ['subject:create', 'subject:batch_write', 'subject:read', 'statement:propose'];
const realAccess = await createRealAccess(admin, accounts, actions);
const commandAt = new Date('2031-02-03T04:05:06.000Z');
const kernel = createKernel({
  pool,
  access: realAccess.access,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
  clock: () => new Date(commandAt),
});

beforeAll(async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of ['subject:create', 'subject:batch_write', 'statement:propose'])
    await realAccess.grant(global, 'importer', action);
  await bootstrapRelease(pool, bundledRelease);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function call(path: string, body: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${realAccess.bearer('importer')}`,
        'content-type': 'application/json',
        'idempotency-key': `"${randomUUID()}"`,
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const source = (externalId: string): Source => ({
  source: 'openlibrary',
  external_id: externalId,
  record_revision: '1',
  digest: 'c'.repeat(64),
  converter_revision: 'review@1',
  field_group: 'facts',
});

test("a batch command runs at the kernel's configured clock", async () => {
  const seeded = await call('/v1/subjects', { type: 'schema:Book', labels: { en: 'Clock target' } });
  expect(seeded.status).toBe(201);
  const subjectId = (seeded.body.subject as Record<string, any>).id as string;
  const createKey = randomUUID();
  const proposeKey = randomUUID();
  const commands: BatchCommand[] = [
    {
      op: 'create',
      key: createKey,
      source: source(randomUUID()),
      subject: { type: 'schema:Book', labels: { en: 'Batch clock' } },
    },
    {
      op: 'propose',
      key: proposeKey,
      source: source(randomUUID()),
      subject: subjectId,
      statement: {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'ja' },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.com/record' },
              },
            ],
          },
        ],
      },
    },
  ];
  const response = await call('/v1/subjects:batchWrite', { commands });
  expect(response.status).toBe(200);
  expect(response.body.results).toHaveLength(2);
  expect((response.body.results as Record<string, any>[]).map(({ status }) => status)).toEqual([201, 201]);

  const receipts = await admin.query<{ idempotency_key: string; transaction_id: string; created_at: Date }>(
    `SELECT idempotency_key, transaction_id::text, created_at
     FROM core.receipt WHERE actor_account_id = $1 AND idempotency_key = ANY($2::text[])`,
    [accounts.importer, [createKey, proposeKey]],
  );
  expect(receipts.rows).toHaveLength(2);
  const transactions = receipts.rows.map(({ transaction_id }) => transaction_id);
  const expectedAt = commandAt.toISOString();
  expect(receipts.rows.map(({ created_at }) => created_at.toISOString())).toEqual([expectedAt, expectedAt]);

  const basis = await admin.query<{ transaction_id: string; recorded_at: Date }>(
    `SELECT transaction_id::text, recorded_at FROM editorial.write_basis
     WHERE transaction_id = ANY($1::uuid[])`,
    [transactions],
  );
  expect(basis.rows).toHaveLength(2);
  expect(basis.rows.map(({ recorded_at }) => recorded_at.toISOString())).toEqual([expectedAt, expectedAt]);

  const outbox = await admin.query<{ transaction_id: string; recorded_at: Date }>(
    `SELECT DISTINCT transaction_id::text, recorded_at
     FROM core.outbox JOIN editorial.write_basis USING (partition_no, position)
     WHERE transaction_id = ANY($1::uuid[])`,
    [transactions],
  );
  expect(outbox.rows).toHaveLength(2);
  expect(outbox.rows.map(({ recorded_at }) => recorded_at.toISOString())).toEqual([expectedAt, expectedAt]);
});

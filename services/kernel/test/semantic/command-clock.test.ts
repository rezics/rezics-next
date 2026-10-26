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
const accounts = {
  configuredWriter: '019a1b2c-3d4e-7f00-8a00-1a0000000071',
  realTimeWriter: '019a1b2c-3d4e-7f00-8a00-1a0000000072',
  seedWriter: '019a1b2c-3d4e-7f00-8a00-1a0000000073',
};
const actions = ['subject:create', 'subject:batch_write', 'subject:read', 'statement:propose'];
const realAccess = await createRealAccess(admin, accounts, actions);
const commandAt = new Date('2031-02-03T04:05:06.000Z');
const hour = 60 * 60 * 1000;
const windowAround = (instant: Date) => [
  new Date(instant.getTime() - hour / 2),
  new Date(instant.getTime() + hour / 2),
];
const kernel = createKernel({
  pool,
  access: realAccess.access,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
  clock: () => new Date(commandAt),
});

beforeAll(async () => {
  const configuredWindow = windowAround(commandAt);
  const realTimeWindow = windowAround(new Date());
  for (const [persona, window] of [
    ['configuredWriter', configuredWindow],
    ['realTimeWriter', realTimeWindow],
  ] as const) {
    const grantedActions =
      persona === 'configuredWriter'
        ? ['subject:batch_write', 'subject:create', 'statement:propose']
        : ['subject:batch_write'];
    for (const action of grantedActions) {
      await admin.query(
        `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
         VALUES (0, $1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $2)`,
        [GLOBAL_CONTEXT, accounts[persona], action, ...(persona === 'configuredWriter' ? configuredWindow : window)],
      );
    }
  }
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'seedWriter', 'subject:create');
  await bootstrapRelease(pool, bundledRelease);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function call(path: string, body: unknown, persona: keyof typeof accounts = 'configuredWriter') {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${realAccess.bearer(persona)}`,
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

function commands(subjectId: string): BatchCommand[] {
  return [
    {
      op: 'create',
      key: randomUUID(),
      source: source(randomUUID()),
      subject: { type: 'schema:Book', labels: { en: 'Batch clock' } },
    },
    {
      op: 'propose',
      key: randomUUID(),
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
}

test("a batch command runs at the kernel's configured clock", async () => {
  const seeded = await call('/v1/subjects', { type: 'schema:Book', labels: { en: 'Clock target' } }, 'seedWriter');
  expect(seeded.status).toBe(201);
  const subjectId = (seeded.body.subject as Record<string, any>).id as string;
  const accepted = commands(subjectId);
  const response = await call('/v1/subjects:batchWrite', { commands: accepted });
  expect(response.status).toBe(200);
  expect(response.body.results).toHaveLength(2);
  expect((response.body.results as Record<string, any>[]).map(({ status }) => status)).toEqual([201, 201]);

  const created = await admin.query<{ subject_id: string }>(
    `SELECT subject_id::text FROM semantic.external_claim WHERE source = $1 AND external_id = $2`,
    [accepted[0]!.source.source, accepted[0]!.source.external_id],
  );
  expect(created.rows).toHaveLength(1);

  const proposed = await admin.query<{ candidate_id: string }>(
    `SELECT candidate_id::text FROM semantic.source_candidate WHERE source = $1 AND external_id = $2`,
    [accepted[1]!.source.source, accepted[1]!.source.external_id],
  );
  expect(proposed.rows).toHaveLength(1);

  const refused = commands(subjectId);
  const denial = await call('/v1/subjects:batchWrite', { commands: refused }, 'realTimeWriter');
  expect(denial.status).toBe(403);

  const receipts = await admin.query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM core.receipt WHERE actor_account_id = $1 AND idempotency_key = ANY($2::text[])`,
    [accounts.realTimeWriter, refused.map(({ key }) => key)],
  );
  expect(receipts.rows).toHaveLength(0);

  const refusedCreate = await admin.query(
    `SELECT 1 FROM semantic.external_claim WHERE source = $1 AND external_id = $2`,
    [refused[0]!.source.source, refused[0]!.source.external_id],
  );
  expect(refusedCreate.rows).toHaveLength(0);
  const refusedProposal = await admin.query(
    `SELECT 1 FROM semantic.source_candidate WHERE source = $1 AND external_id = $2`,
    [refused[1]!.source.source, refused[1]!.source.external_id],
  );
  expect(refusedProposal.rows).toHaveLength(0);
});

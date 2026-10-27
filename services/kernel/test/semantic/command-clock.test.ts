import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import pg from 'pg';
import { installResourceRoleCatalogue, resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { contextTarget } from '../../src/semantic/context.ts';
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
const actions = [
  'subject:create',
  'subject:batch_write',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'context:create',
  'definitions:publish',
  'definitions:activate',
  'subject:merge',
  'moderation:hide',
];
const commandAt = new Date('2031-02-03T04:05:06.000Z');
const realAccess = await createRealAccess(admin, accounts, actions, { clock: () => new Date(commandAt) });
const hour = 60 * 60 * 1000;
const windowAround = (instant: Date) => [
  new Date(instant.getTime() - hour / 2),
  new Date(instant.getTime() + hour / 2),
];
const kernel = createKernel({
  pool,
  access: (config) => {
    const access = realAccess.access(config);
    installResourceRoleCatalogue(access, resolveResourceRoles(config.actions));
    return access;
  },
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
        ? [
            'subject:batch_write',
            'subject:create',
            'statement:propose',
            'context:accept',
            'context:adopt',
            'context:create',
            'definitions:publish',
            'definitions:activate',
            'subject:merge',
            'moderation:hide',
          ]
        : ['subject:batch_write', 'statement:propose', 'context:create'];
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

async function call(
  path: string,
  body: unknown,
  persona: keyof typeof accounts = 'configuredWriter',
  key = randomUUID(),
) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${realAccess.bearer(persona)}`,
        'content-type': 'application/json',
        'idempotency-key': `"${key}"`,
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

test("Context and definition commands run at the kernel's configured clock", async () => {
  const contextKey = randomUUID();
  const createdContext = await call(
    '/v1/contexts',
    { labels: { en: 'Configured clock Context' } },
    'configuredWriter',
    contextKey,
  );
  expect(createdContext.status).toBe(201);
  const contextId = (createdContext.body.context as Record<string, any>).id as string;

  const refusedKey = randomUUID();
  const refusedTarget = contextTarget(new Uint8Array(32).fill(4), accounts.realTimeWriter, refusedKey);
  const refusedContext = await call(
    '/v1/contexts',
    { labels: { en: 'Real-time clock Context' } },
    'realTimeWriter',
    refusedKey,
  );
  expect(refusedContext.status).toBe(403);
  expect(
    (
      await admin.query('SELECT 1 FROM semantic.context WHERE route = $1 AND context_id = $2', [
        refusedTarget.route,
        refusedTarget.id,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await admin.query('SELECT 1 FROM core.receipt WHERE actor_account_id = $1 AND idempotency_key = $2', [
        accounts.realTimeWriter,
        refusedKey,
      ])
    ).rows,
  ).toHaveLength(0);

  const subject = await call(
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: 'Community clock subject' } },
    'configuredWriter',
  );
  expect(subject.status).toBe(201);
  const subjectId = (subject.body.subject as Record<string, any>).id as string;
  const proposed = await call(
    `/v1/subjects/${subjectId}/candidates`,
    {
      statement: {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'ja' },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.com/community-clock' },
              },
            ],
          },
        ],
      },
    },
    'configuredWriter',
  );
  expect(proposed.status).toBe(201);
  const candidate = proposed.body.candidate as string;

  const accepted = await call(
    `/v1/subjects/${subjectId}/candidates/${candidate}:accept`,
    { context: contextId, expected_head: null },
    'configuredWriter',
  );
  expect(accepted.status).toBe(200);
  expect(accepted.body.acceptance).toMatchObject({ context: contextId, candidate, decision: 'accept', head: 1 });

  const adopted = await call(
    `/v1/subjects/${subjectId}:adopt`,
    {
      context: contextId,
      property: 'schema:inLanguage',
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    },
    'configuredWriter',
  );
  expect(adopted.status).toBe(200);
  expect(adopted.body.adoption).toMatchObject({
    context: contextId,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    head: 1,
  });

  const release = structuredClone(bundledRelease);
  release.catalogue.version = `clock-${randomUUID()}`;
  const active = await activeRelease(pool);
  expect(active).not.toBeNull();
  const published = await call('/v1/definitions/releases', { release }, 'configuredWriter');
  expect(published.status).toBe(201);
  const digest = published.body.digest as string;
  const activated = await call(
    `/v1/definitions/releases/${digest}:activate`,
    { expected_head: active!.head },
    'configuredWriter',
  );
  expect(activated.status).toBe(200);
  expect(activated.body).toEqual({ digest, head: active!.head + 1 });
});

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

test("subject routes run commands at the kernel's configured clock", async () => {
  const created = async (label: string, statements?: Record<string, unknown[]>) => {
    const response = await call('/v1/subjects', {
      type: 'schema:Book',
      labels: { en: label },
      ...(statements === undefined ? {} : { statements }),
    });
    expect(response.status).toBe(201);
    return (response.body.subject as Record<string, any>).id as string;
  };
  const subject = await created('Subject clock', {
    'schema:inLanguage': [
      {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'ja' },
      },
    ],
  });
  const other = await created('Merge clock one');
  const third = await created('Merge clock two');
  const hidden = await created('Hide clock');

  const proposed = await call(`/v1/subjects/${subject}/candidates`, {
    statement: {
      property: { id: 'schema:inLanguage' },
      value: { type: 'value', content: 'fr' },
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://example.com/clock' },
            },
          ],
        },
      ],
    },
  });
  expect(proposed.status).toBe(201);
  const candidate = proposed.body.candidate as string;

  const accepted = await call(`/v1/subjects/${subject}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  expect(accepted.status).toBe(200);
  expect(accepted.body.acceptance).toEqual({
    context: GLOBAL_CONTEXT,
    candidate,
    decision: 'accept',
    head: 1,
  });

  const adopted = await call(`/v1/subjects/${subject}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: 1,
  });
  expect(adopted.status).toBe(200);
  expect(adopted.body.adoption).toEqual({
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    head: 2,
  });

  const hiddenStatement = await call(`/v1/subjects/${subject}/candidates/${candidate}:hide`, {
    reason: 'Clock test',
  });
  expect(hiddenStatement.status).toBe(200);
  expect(hiddenStatement.body).toMatchObject({
    subject,
    candidate,
    visibility: 'hidden',
    security_revision: 1,
  });

  const hiddenSubject = await call(`/v1/subjects/${hidden}:hide`, { reason: 'Clock test' });
  expect(hiddenSubject.status).toBe(200);
  expect(hiddenSubject.body).toEqual({
    subject: hidden,
    visibility: 'hidden',
    security_revision: 1,
  });

  const merged = await call('/v1/subjects:merge', { subjects: [other, third] });
  expect(merged.status).toBe(200);
  expect(merged.body).toEqual({
    survivor: [other, third].sort()[0],
    redirected: [other, third].sort()[1],
    revision: 2,
  });

  const beforeRefusal = await admin.query(
    'SELECT count(*)::int AS count FROM semantic.revision WHERE subject_id = $1',
    [subject],
  );
  const refusalKey = randomUUID();
  const refused = await call(
    `/v1/subjects/${subject}/candidates`,
    {
      statement: {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'fr' },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.com/clock-refused' },
              },
            ],
          },
        ],
      },
    },
    'realTimeWriter',
    refusalKey,
  );
  expect(refused.status).toBe(403);
  const afterRefusal = await admin.query('SELECT count(*)::int AS count FROM semantic.revision WHERE subject_id = $1', [
    subject,
  ]);
  expect(afterRefusal.rows[0]?.count).toBe(beforeRefusal.rows[0]?.count);
  const receipt = await admin.query('SELECT 1 FROM core.receipt WHERE actor_account_id = $1 AND idempotency_key = $2', [
    accounts.realTimeWriter,
    refusalKey,
  ]);
  expect(receipt.rows).toHaveLength(0);
});

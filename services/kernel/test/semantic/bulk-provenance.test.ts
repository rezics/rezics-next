import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = { importer: '019a1b2c-3d4e-7f00-8a00-1a0000000061' };
const actions = ['subject:create', 'subject:batch_write', 'statement:propose', 'subject:read'];
const realAccess = await createRealAccess(admin, accounts, actions);
const kernel = createKernel({
  pool,
  access: realAccess.access,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
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
const source = (): Source => ({
  source: 'openlibrary',
  external_id: randomUUID(),
  record_revision: '1',
  digest: 'c'.repeat(64),
  converter_revision: 'review@1',
  field_group: 'facts',
});
const statement = (language = 'ja') => ({
  property: { id: 'schema:inLanguage' },
  value: { type: 'value' as const, content: language },
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value' as const, content: 'https://example.com/record' } },
      ],
    },
  ],
});
const create = (envelope: Source): BatchCommand => ({
  op: 'create',
  key: randomUUID(),
  source: envelope,
  subject: { type: 'schema:Book', labels: { en: 'Book' } },
});
async function call(path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${realAccess.bearer('importer')}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function batch(commands: unknown[]) {
  return (await call('/v1/subjects:batchWrite', { commands })).body.results as Record<string, any>[];
}

test('refresh receipts preserve their result and authorization precedes every replay', async () => {
  const envelope = source();
  const command = create(envelope);
  const { value: created } = (await batch([command]))[0]!;
  const resolving = { ...command, key: randomUUID() };
  const [resolved] = await batch([resolving]);
  expect(resolved).toMatchObject({ status: 200, value: created });
  const proposal: BatchCommand = {
    op: 'propose',
    key: randomUUID(),
    source: envelope,
    subject: created.id,
    statement: statement(),
  };
  const [proposed] = await batch([proposal]);
  const refresh = { ...proposal, key: randomUUID(), statement: { ...statement(), rank: 'preferred' as const } };
  const [refreshed] = await batch([refresh]);
  expect(refreshed).toMatchObject({ status: 200, value: proposed!.value });
  await batch([{ ...proposal, key: randomUUID(), statement: statement('en') }]);
  expect((await batch([resolving, refresh])).map(({ value }) => value)).toEqual([created, proposed!.value]);
  const changed = { ...resolving, subject: { type: 'schema:Book', labels: { en: 'Changed' } } };
  expect((await batch([changed]))[0]).toMatchObject({ status: 422, problem: { code: 'idempotency_conflict' } });
  realAccess.checks.length = 0;
  const global = { route: 0, id: GLOBAL_CONTEXT };
  await realAccess.revoke(global, 'importer', 'subject:create');
  await realAccess.revoke(global, 'importer', 'statement:propose');
  try {
    expect((await batch([command, proposal])).map(({ status }) => status)).toEqual([403, 403]);
    expect(realAccess.checks.filter(({ action }) => action === 'subject:batch_write')).toHaveLength(1);
    expect(realAccess.checks.map(({ action }) => action)).toContain('subject:create');
    expect(realAccess.checks.map(({ action }) => action)).toContain('statement:propose');
  } finally {
    await realAccess.grant(global, 'importer', 'subject:create');
    await realAccess.grant(global, 'importer', 'statement:propose');
  }
});

test('candidate provenance keeps the original proposal and the latest cited retraction', async () => {
  const envelope = source();
  const {
    value: { id },
  } = (await batch([create(envelope)]))[0]!;
  const proposal: BatchCommand = {
    op: 'propose',
    key: randomUUID(),
    source: envelope,
    subject: id,
    statement: statement(),
  };
  const {
    value: { candidate },
  } = (await batch([proposal]))[0]!;
  const retract: BatchCommand = {
    op: 'retract',
    key: randomUUID(),
    source: { ...envelope, record_revision: '2' },
    subject: id,
    candidate,
    references: statement().references,
  };
  expect(
    (await batch([{ ...retract, key: randomUUID(), source: { ...retract.source, external_id: randomUUID() } }]))[0],
  ).toMatchObject({ status: 409 });
  expect((await batch([retract]))[0]).toMatchObject({ status: 200, value: { revision: 3 } });
  const latest = { ...retract, key: randomUUID(), source: { ...envelope, record_revision: '3' } };
  expect((await batch([latest]))[0]).toMatchObject({ status: 200, value: { revision: 4 } });
  const listing = await call(`/v1/subjects/${id}/candidates?property=schema%3AinLanguage`);
  expect(listing.body.candidates[0]).toMatchObject({
    id: candidate,
    source: envelope,
    retracted: 4,
    retraction: { source: latest.source, references: latest.references },
  });
  const revisions = await call(`/v1/subjects/${id}/revisions`);
  expect(revisions.body.revisions.map(({ source }: Record<string, any>) => source)).toEqual([
    latest.source,
    retract.source,
    envelope,
    envelope,
  ]);
  const current = await call(`/v1/subjects/${id}`);
  expect(current.body.subject.statements).toEqual({});
  expect((await batch([{ ...proposal, key: randomUUID() }]))[0]).toMatchObject({ status: 201, value: { revision: 5 } });
  const rows = await pool.query(
    'SELECT count(*)::integer AS count FROM semantic.source_candidate WHERE route = $1 AND subject_id = $2',
    [routeOf(id), id],
  );
  expect(rows.rows[0].count).toBe(1);
});

test('concurrent claimants converge without duplicate subjects or proposals', async () => {
  const envelope = source();
  const commands = Array.from({ length: 3 }, () => create(envelope));
  const answers = (await Promise.all(commands.map((command) => batch([command])))).flat();
  expect(answers.map(({ status }) => status).sort()).toEqual([200, 200, 201]);
  const id = answers[0]!.value.id;
  expect(answers.every(({ value }) => value.id === id)).toBe(true);
  const proposals = Array.from({ length: 3 }, (): BatchCommand => ({
    op: 'propose',
    key: randomUUID(),
    source: envelope,
    subject: id,
    statement: statement(),
  }));
  const proposed = (await Promise.all(proposals.map((command) => batch([command])))).flat();
  expect(proposed.map(({ status }) => status).sort()).toEqual([200, 200, 201]);
  expect(new Set(proposed.map(({ value }) => value.candidate)).size).toBe(1);
});

test('malformed commands keep their own diagnostics and unsupported groups have one violation', async () => {
  const envelope = source();
  const valid = create(envelope);
  const replies = await batch([
    null,
    {},
    { ...valid, key: '' },
    { ...valid, key: randomUUID(), source: { ...envelope, field_group: 'future' }, extra: true },
    valid,
  ]);
  expect(replies.map(({ status }) => status)).toEqual([400, 400, 400, 400, 201]);
  expect(replies[3]!.problem.errors).toEqual([{ pointer: '/commands/3/source/field_group', code: 'unsupported' }]);
  expect(replies[2]!.problem.errors).toContainEqual({ pointer: '/commands/2/key', code: 'out_of_range' });
});

test('an authorized batch without an active release runs nothing', async () => {
  const saved = await pool.query('DELETE FROM semantic.definition_activation WHERE route = 0 RETURNING *');
  try {
    const reply = await call('/v1/subjects:batchWrite', { commands: [create(source())] });
    expect(reply).toMatchObject({ status: 503, body: { code: 'semantic_not_ready' } });
  } finally {
    for (const row of saved.rows)
      await pool.query(
        'INSERT INTO semantic.definition_activation (route, head, digest, recorded_transaction_id) VALUES ($1, $2, $3, $4)',
        [row.route, row.head, row.digest, row.recorded_transaction_id],
      );
  }
});

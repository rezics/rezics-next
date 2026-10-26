import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001' };
const realAccess = await createRealAccess(admin, accounts, ['subject:create', 'statement:propose']);
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  await bootstrapRelease(pool, bundledRelease);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(7),
  access: realAccess.access,
  writeRate: realAccess.writeRate,
});

async function post(path: string, body: unknown, key = `"${randomUUID()}"`) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const statement = {
  property: { id: 'schema:inLanguage' },
  value: { type: 'value', content: 'ja' },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.com/source' } }] },
  ],
};

test('malformed proposal ranks and value tags are refused without expansion or a revision', async () => {
  const created = await post('/v1/subjects', { type: 'schema:Book', labels: { en: 'Input validation' } });
  expect(created.status).toBe(201);
  const id = created.body.subject.id as string;
  const path = `/v1/subjects/${id}/candidates`;
  for (const rank of [null, ['normal'], 1, {}, { toString: null }]) {
    const response = await post(path, { statement: { ...statement, rank } });
    expect([rank, response.status]).toEqual([rank, 400]);
    expect(response.body.errors).toContainEqual({ pointer: '/statement/rank', code: 'invalid_type' });
  }
  for (const type of [null, ['value'], {}, { toString: null }]) {
    const response = await post(path, { statement: { ...statement, value: { type, content: 'ja' } } });
    expect([type, response.status]).toEqual([type, 400]);
    expect(response.body.errors).toContainEqual({ pointer: '/statement/value', code: 'invalid_format' });
  }
  const revisions = await pool.query('SELECT revision FROM semantic.revision WHERE route = $1 AND subject_id = $2', [
    routeOf(id),
    id,
  ]);
  expect(revisions.rows).toEqual([{ revision: 1 }]);
  const expansions = await pool.query(
    "SELECT 1 FROM semantic.fact WHERE route = $1 AND subject_id = $2 AND operation = 'expand'",
    [routeOf(id), id],
  );
  expect(expansions.rows).toEqual([]);
});

test('a reused proposal key conflicts before validating the changed statement', async () => {
  const created = await post('/v1/subjects', { type: 'schema:Book', labels: { en: 'Receipt ordering' } });
  expect(created.status).toBe(201);
  const path = `/v1/subjects/${created.body.subject.id}/candidates`;
  const key = `"${randomUUID()}"`;
  const proposed = await post(path, { statement }, key);
  expect(proposed.status).toBe(201);
  const conflict = await post(path, { statement: { ...statement, rank: { toString: null } } }, key);
  expect(conflict.status).toBe(422);
  expect(conflict.body.code).toBe('idempotency_conflict');
  const replay = await post(path, { statement }, key);
  expect(replay).toEqual(proposed);
});

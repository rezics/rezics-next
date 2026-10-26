import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { newId } from '../../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(23)]]) };
const routeKey = new Uint8Array(32).fill(29);
const accounts = {
  writer: '019a1b2c-3d4e-7f00-8a00-5ab1ec700071',
};
const realAccess = await createRealAccess(admin, accounts, ['subject:create']);

const realKernel = createKernel({ pool, routeKey });
const accessKernel = createKernel({
  pool,
  routeKey,
  access: realAccess.access,
  tokens,
  writeRate: realAccess.writeRate,
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'writer', 'subject:create');
  await bootstrapRelease(pool, bundledRelease);
});

async function call(kernel: typeof realKernel, method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: {
              authorization: `Bearer ${realAccess.bearer('writer')}`,
              'content-type': 'application/json',
              'idempotency-key': `"${randomUUID()}"`,
            },
            body: JSON.stringify(body),
          }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

function withoutRequestId(body: Record<string, any>) {
  const { request_id: _requestId, ...rest } = body;
  return rest;
}

test("anonymous subject and Context reads pass accounts' real public floor", async () => {
  const created = await call(accessKernel, 'POST', '/v1/subjects', {
    type: 'schema:Person',
    labels: { en: 'Eligibility evidence' },
  });
  expect(created.response.status).toBe(201);
  const subjectId = created.body.subject.id as string;

  for (const path of [`/v1/subjects/${subjectId}`, `/v1/contexts/${GLOBAL_CONTEXT}`]) {
    const expected = await call(accessKernel, 'GET', path);
    const actual = await call(realKernel, 'GET', path);
    expect(expected.response.status).toBe(200);
    expect(actual.response.status).toBe(200);
    expect(withoutRequestId(actual.body)).toEqual(withoutRequestId(expected.body));
  }
});

test('an unknown subject and an unknown Context stay the same 404 under the real floor', async () => {
  const subjectId = newId(0x0042);
  const contextId = newId(0x0043);
  for (const path of [`/v1/subjects/${subjectId}`, `/v1/contexts/${contextId}`]) {
    const expected = await call(accessKernel, 'GET', path);
    const actual = await call(realKernel, 'GET', path);
    expect(expected.response.status).toBe(404);
    expect(actual.response.status).toBe(404);
    expect(withoutRequestId(actual.body)).toEqual(withoutRequestId(expected.body));
    expect(actual.body.code).toBe('not_found');
  }
});

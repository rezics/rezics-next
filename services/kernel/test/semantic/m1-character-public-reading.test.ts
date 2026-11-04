import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { platformProfile } from '../../src/presentation/setup.ts';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

setDefaultTimeout(120_000);
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const text = fromPlainText('A supplied Character profile.');
const japanese = fromPlainText('公開された人物紹介。');
async function call(method: string, path: string, body?: unknown, signedIn = false) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(signedIn ? { authorization: `Bearer ${real.bearer('editor')}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(randomUUID()) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function create() {
  const response = await call(
    'POST',
    '/v1/subjects',
    {
      type: 'wd:Q95074',
      labels: { en: 'A public Character' },
      statements: {
        'schema:abstract': [text, japanese].map((document, index) => ({
          property: { id: 'schema:abstract' },
          value: { type: 'value', content: { document, language: index ? 'ja' : 'en', licence: 'CC-BY-4.0' } },
        })),
      },
    },
    true,
  );
  expect(response.status).toBe(201);
  return response.body.subject;
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, platformProfile);
  const actions = ['subject:create', 'subject:read', 'statement:propose'];
  real = await createRealAccess(db.admin, { editor: newId(0xc849) }, actions);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(49),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(50)]]) },
    access: real.access,
    writeRate: real.writeRate,
  });
});
afterAll(async () => {
  await db?.close();
});

test('native public Character and page reads carry the exact current-language document without editor advice', async () => {
  const subject = await create();
  for (const signedIn of [false, true]) {
    const reading = await call(
      'GET',
      `/v1/subjects/${subject.id}?language=ja&includeDocuments=true`,
      undefined,
      signedIn,
    );
    expect(reading.status).toBe(200);
    expect(reading.headers.get('cache-control')).toBe('private, no-store');
    expect(reading.body.viewerActions).toBeUndefined();
    const statement = subject.statements['schema:abstract'].find((row: any) => row.value.content.language === 'ja');
    const exact = await call('GET', `/v1/documents/${statement.value.content.document}`, undefined, signedIn);
    expect(exact.status).toBe(200);
    expect(reading.body.documents).toEqual({ [statement.id]: exact.body.document });
    expect(exact.body.document.body).toEqual(japanese);
    const page = await call('POST', '/v1/pages:read', { target: { subject: subject.id }, languages: ['ja'] }, signedIn);
    expect(page.status).toBe(200);
    const filled = Object.values(page.body.reads).find((read: any) => read.body?.subject?.id === subject.id) as any;
    expect(filled.body.documents).toEqual(reading.body.documents);
  }
});

test('an erased body remains unavailable while its current Character assertion stays readable', async () => {
  const subject = await create();
  const statement = subject.statements['schema:abstract'].find((row: any) => row.value.content.language === 'en');
  await db.admin.query('UPDATE content.authored_field SET body = $1 WHERE id = $2', [
    Buffer.from(serializeDocument(fromPlainText('A different valid body.'))),
    statement.value.content.document,
  ]);
  const mismatched = await call('GET', `/v1/subjects/${subject.id}?language=en&includeDocuments=true`);
  expect(mismatched.status).toBe(200);
  expect(mismatched.body.documents).toEqual({});
  await db.admin.query("UPDATE content.authored_field SET availability = 'erased', body = NULL WHERE id = $1", [
    statement.value.content.document,
  ]);
  const native = await call('GET', `/v1/subjects/${subject.id}?language=en&includeDocuments=true`);
  expect(native.status).toBe(200);
  expect(native.body.subject.statements['schema:abstract']).toContainEqual(statement);
  expect(native.body.documents).toEqual({});
  const page = await call('POST', '/v1/pages:read', { target: { subject: subject.id }, languages: ['en'] });
  expect(page.status).toBe(200);
  const filled = Object.values(page.body.reads).find((read: any) => read.body?.subject?.id === subject.id) as any;
  expect(filled.body.documents).toEqual({});
});

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createKernelClient, type SubjectReadQuery } from '@rezics/client';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { platformProfile } from '../../src/presentation/setup.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';

setDefaultTimeout(120_000);
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = newId(0xc849);
const erasureTrace: unknown[] = [];
const text = fromPlainText('A supplied Character profile.');
const japanese = fromPlainText('公開された人物紹介。');
async function call(method: string, path: string, body?: unknown, signedIn = false) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(signedIn ? { authorization: `Bearer ${real.bearer('editor')}` } : {}),
        ...(method !== 'GET' ? { 'idempotency-key': JSON.stringify(randomUUID()) } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: response.status === 204 ? undefined : await response.json(),
  };
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
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const projection = linkProjection(db.pool);
  // Run the native consumer before the read budget starts. Keep the one-connection
  // pool so the document and Subject readers must release each home in sequence.
  for (let step = 0; step < 200; step++) {
    const batch = await projection.run(partitionOf(routeOf(response.body.subject.id)!));
    if (batch.status === 'read' && batch.envelopes === 0) return response.body.subject;
  }
  throw new Error('Character link projection did not drain');
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, platformProfile);
  const actions = ['subject:create', 'subject:read', 'statement:propose', 'document:erase'];
  real = await createRealAccess(db.admin, { editor }, actions);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(49),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(50)]]) },
    receiptKeys: testReceiptKeys(),
    access(config) {
      const access = real.access(config);
      return deriveAccess(access, {
        async prepare(...args) {
          const evidence = await access.prepare!(...args);
          if (args[1] === 'document:erase') erasureTrace.push({ prepared: evidence !== null });
          return evidence;
        },
        async authorize(...args) {
          const allowed = await access.authorize(...args);
          if (args[2] === 'document:erase') erasureTrace.push({ authorized: allowed });
          return allowed;
        },
      });
    },
    writeRate: real.writeRate,
  });
  // Compile the served routes during startup, outside the native request budget.
  app.compile();
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
    expect(reading.status, JSON.stringify(reading.body)).toBe(200);
    expect(reading.headers.get('cache-control')).toBe('private, no-store');
    expect(reading.body.viewerActions).toBeUndefined();
    const statement = subject.statements['schema:abstract'].find((row: any) => row.value.content.language === 'ja');
    const exact = await call('GET', `/v1/documents/${statement.value.content.document}`, undefined, signedIn);
    expect(exact.status).toBe(200);
    expect(reading.body.documents).toEqual({ [statement.id]: exact.body.document });
    expect(exact.body.document.body).toEqual(japanese);
    const client = createKernelClient('http://kernel.test', {
      fetch: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      ...(signedIn ? { headers: { authorization: `Bearer ${real.bearer('editor')}` } } : {}),
    });
    const query = { language: 'ja', includeDocuments: true } satisfies SubjectReadQuery;
    const installed = await client.subjects({ id: subject.id }).get({ query });
    expect(installed.status).toBe(200);
    expect(installed.data?.documents?.[statement.id]).toEqual(exact.body.document);
    const withoutDocuments = await client.subjects({ id: subject.id }).get();
    expect(withoutDocuments.status).toBe(200);
    expect(withoutDocuments.data?.documents).toBeUndefined();
    const page = await call('POST', '/v1/pages:read', { target: { subject: subject.id }, languages: ['ja'] }, signedIn);
    expect(page.status).toBe(200);
    const filled = Object.values(page.body.reads).find((read: any) => read.body?.subject?.id === subject.id) as any;
    expect(filled.body.documents).toEqual(reading.body.documents);
  }
});

test('fallback language stays explicit and erasure withholds the body while preserving the Character assertion', async () => {
  const subject = await create();
  const statement = subject.statements['schema:abstract'].find((row: any) => row.value.content.language === 'en');
  // Authored bodies and digests are immutable. A missing translation selects the
  // existing fallback and preserves its actual language, before native erasure.
  const fallback = await call('GET', `/v1/subjects/${subject.id}?language=fr&includeDocuments=true`);
  expect(fallback.status, JSON.stringify(fallback.body)).toBe(200);
  expect(fallback.body.documents).toEqual({
    [statement.id]: expect.objectContaining({ language: 'en', body: text, origin: 'account', author: editor }),
  });
  const document = statement.value.content.document;
  await real.grant({ route: routeOf(document)!, id: document }, 'editor', 'document:erase');
  const erased = await call('DELETE', `/v1/documents/${document}`, undefined, true);
  const stored = await db.admin.query(
    'SELECT author_account_id, availability FROM content.authored_field WHERE route=$1 AND id=$2',
    [routeOf(document), document],
  );
  expect(erased.status, JSON.stringify({ problem: erased.body, erasureTrace, stored: stored.rows })).toBe(204);
  const exact = await call('GET', `/v1/documents/${statement.value.content.document}`);
  expect(exact.status, JSON.stringify(exact.body)).toBe(404);
  const native = await call('GET', `/v1/subjects/${subject.id}?language=en&includeDocuments=true`);
  expect(native.status, JSON.stringify(native.body)).toBe(200);
  expect(native.body.subject.statements['schema:abstract']).toContainEqual(statement);
  expect(native.body.documents).toEqual({});
  const page = await call('POST', '/v1/pages:read', { target: { subject: subject.id }, languages: ['en'] });
  expect(page.status).toBe(200);
  const filled = Object.values(page.body.reads).find((read: any) => read.body?.subject?.id === subject.id) as any;
  expect(filled.body.documents).toEqual({});
});

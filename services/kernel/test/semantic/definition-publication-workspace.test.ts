import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { EXTENSION_FORMAT, extensionDigest, termPrefix, type Extension } from '@rezics/definitions/extension';
import { releaseDigest } from '@rezics/definitions';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { VERTICAL_LOCALES } from '../support/manifests.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const global = { route: 0, id: GLOBAL_CONTEXT };
const accounts = {
  operator: newId(0x7311),
  editor: newId(0x7312),
  rival: newId(0x7313),
  reader: newId(0x7314),
  suspended: newId(0x7315),
};
const actions = [
  'definitions:publish',
  'definitions:activate',
  'definitions:read',
  'gate:definition_publication',
  'subject:create',
  'subject:read',
  'context:create',
  'context:read',
  'access:grant',
  'gate:any',
];
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let real: Awaited<ReturnType<typeof createRealAccess<typeof accounts>>>;
let app: ReturnType<typeof createKernel>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  real = await createRealAccess(db.admin, accounts, actions);
  await db.admin.query("UPDATE access.account SET state = 'suspended' WHERE account_id = $1", [accounts.suspended]);
  app = createKernel({
    pool: db.pool,
    access: real.access,
    clock: () => new Date(),
    routeKey: new Uint8Array(32).fill(62),
    receiptKeys: testReceiptKeys(),
    writeRate: createWriteRateLimiter({
      secret: 'definition-publication-workspace-write-rate',
      overrides: '{"new-account":{"write":{"maximum":10000,"seconds":60}}}',
    }),
  });
  await bootstrapRelease(db.pool, bundledRelease);
  for (const action of ['access:grant', 'gate:any']) await real.grant(global, 'operator', action);
  for (const action of [
    'definitions:publish',
    'definitions:activate',
    'gate:definition_publication',
    'subject:create',
    'subject:read',
    'context:create',
  ]) {
    await real.grant(global, 'editor', action);
    await real.grant(global, 'rival', action);
  }
}, 120_000);
afterAll(async () => {
  await db?.close();
});

async function call(
  who: keyof typeof accounts | 'anonymous',
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(who === 'anonymous' ? {} : { authorization: `Bearer ${real.bearer(who)}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

test('platform and Context editors publish, resume, activate and use a compiled fixture vertical with independent pinned reads', async () => {
  const anonymous = await call('anonymous', 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(anonymous.status, JSON.stringify(anonymous.body)).toBe(403);
  expect(anonymous.body.code).toBe('platform_closed');
  const closed = await call('reader', 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(closed.status, JSON.stringify(closed.body)).toBe(403);
  expect(closed.body.code).toBe('platform_closed');
  const suspended = await call('suspended', 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect([401, 403]).toContain(suspended.status);

  const invalid = await call('editor', 'POST', '/v1/definitions/imports', { document: { format: 'nope' } });
  expect(invalid.status, JSON.stringify(invalid.body)).toBe(200);
  expect(invalid.body.kind).toBe('invalid');
  expect(invalid.body.diagnostics[0]?.pointer).toBe('/document');

  const classes: Record<string, object> = {};
  const labels: Record<string, string> = {};
  for (let index = 0; index < 10; index++) {
    const name = `T${index}`;
    classes[name] = { class_uri: `scale:${name}`, annotations: { library: { id: 'fixture.catalogue' } } };
    labels[`scale:${name}`] = `Type ${name}`;
  }
  const ten = {
    root: 'main.yaml',
    schemas: {
      'main.yaml': JSON.stringify({
        id: 'https://catalogue.example/ten',
        name: 'ten',
        version: '1',
        prefixes: { scale: 'https://catalogue.example/types/', linkml: 'https://w3id.org/linkml/' },
        imports: ['linkml:types'],
        classes,
        slots: {},
      }),
    },
    presentation: { en: JSON.stringify({ types: labels, properties: {} }) },
  };
  const compiledTen = await compileCatalogue(ten);
  expect(Object.keys(compiledTen.types)).toHaveLength(10);
  const measured = await call('editor', 'POST', '/v1/definitions/imports', { document: ten });
  expect(measured.status, JSON.stringify(measured.body)).toBe(200);
  expect(measured.body.identity.digest).toBe(releaseDigest(compiledTen));

  const typeId = 'ex:V0Work';
  const usableClasses = {
    ...classes,
    V0Work: { class_uri: typeId, annotations: { library: { id: 'fixture.catalogue' } } },
  };
  const usableLabels = { ...labels, [typeId]: 'Fixture vertical work' };
  const usable = {
    root: 'main.yaml',
    schemas: {
      'main.yaml': JSON.stringify({
        id: 'https://catalogue.example/usable',
        name: 'usable',
        version: '1',
        prefixes: {
          scale: 'https://catalogue.example/types/',
          ex: 'https://example.org/vocab/',
          linkml: 'https://w3id.org/linkml/',
        },
        imports: ['linkml:types'],
        classes: usableClasses,
        slots: {},
      }),
    },
    presentation: Object.fromEntries(
      VERTICAL_LOCALES.map((locale) => [
        locale,
        JSON.stringify({
          types: Object.fromEntries(
            Object.entries(usableLabels).map(([id, label]) => [id, locale === 'en' ? label : `${label} ${locale}`]),
          ),
          properties: {},
        }),
      ]),
    ),
  };
  const compiled = await compileCatalogue(usable);
  const preview = await call('editor', 'POST', '/v1/definitions/imports', { document: usable });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.kind).toBe('sources');
  expect(preview.body.diagnostics).toEqual([]);
  expect(preview.body.identity.digest).toBe(releaseDigest(compiled));
  expect(preview.body.operations).toMatchObject({ grant: 'definition_publication', admitted: true, publish: true });
  const previousHead = preview.body.current.head as number;
  const previousDigest = preview.body.current.digest as string;
  const digest = preview.body.identity.digest as string;
  const publishKey = { 'idempotency-key': JSON.stringify(randomUUID()) };

  const first = await call('editor', 'POST', '/v1/definitions/releases', { release: compiled }, publishKey);
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toEqual({ digest });
  const replay = await call('editor', 'POST', '/v1/definitions/releases', { release: compiled }, publishKey);
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(first.body);

  const independent = await call('anonymous', 'GET', `/v1/definitions/releases/${digest}`);
  expect(independent.status).toBe(200);
  expect(independent.body.digest).toBe(digest);

  const stale = await call('editor', 'POST', `/v1/definitions/releases/${digest}:activate`, {
    expected_head: previousHead + 1,
  });
  expect(stale.status, JSON.stringify(stale.body)).toBe(409);
  const refreshed = await call('editor', 'GET', '/v1/definitions/active');
  expect(refreshed.body.head).toBe(previousHead);
  const activated = await call('editor', 'POST', `/v1/definitions/releases/${digest}:activate`, {
    expected_head: previousHead,
  });
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  const competing = await call('rival', 'POST', `/v1/definitions/releases/${previousDigest}:activate`, {
    expected_head: previousHead,
  });
  expect(competing.status, JSON.stringify(competing.body)).toBe(409);

  const pinnedOld = await call('anonymous', 'GET', `/v1/definitions/releases/${previousDigest}`);
  const pinnedNew = await call('anonymous', 'GET', `/v1/definitions/releases/${digest}`);
  const active = await call('anonymous', 'GET', '/v1/definitions/active');
  expect(pinnedOld.status).toBe(200);
  expect(pinnedOld.body.digest).toBe(previousDigest);
  expect(pinnedNew.body.digest).toBe(digest);
  expect(active.body.digest).toBe(digest);
  const created = await call('editor', 'POST', '/v1/subjects', {
    type: typeId,
    labels: { en: 'Fixture vertical work' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const subjectId = created.body.subject.id as string;
  const read = await call('editor', 'GET', `/v1/subjects/${subjectId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body.subject.type).toBe(typeId);
  for (const locale of VERTICAL_LOCALES) {
    const descriptor = await call(
      'anonymous',
      'GET',
      `/v1/definitionTypes/${encodeURIComponent(typeId)}?locale=${locale}`,
    );
    expect(descriptor.status, `${locale} ${JSON.stringify(descriptor.body)}`).toBe(200);
    expect((descriptor.body.label as string).length).toBeGreaterThan(0);
  }

  const contextResult = await call('editor', 'POST', '/v1/contexts', { labels: { en: 'Publication extension' } });
  expect(contextResult.status, JSON.stringify(contextResult.body)).toBe(201);
  const context = contextResult.body.context.id as string;
  const resource = { route: routeOf(context)!, id: context };
  for (const action of ['definitions:publish', 'definitions:activate']) await real.grant(resource, 'editor', action);
  const extension: Extension = {
    format: EXTENSION_FORMAT,
    context,
    terms: {
      [`${termPrefix(context)}:boardLink`]: {
        description: { en: 'Board relation' },
        labels: Object.fromEntries(
          VERTICAL_LOCALES.map((locale) => [locale, locale === 'en' ? 'board link' : `board ${locale}`]),
        ),
        domain: [typeId],
        targets: [typeId],
        multivalued: true,
        relation: { group: 'association', inverse: 'none' },
      },
    },
  };
  const extensionPreview = await call('editor', 'POST', '/v1/definitions/imports', { document: extension, context });
  expect(extensionPreview.status, JSON.stringify(extensionPreview.body)).toBe(200);
  expect(extensionPreview.body.identity.digest).toBe(extensionDigest(extension));
  const publishedExtension = await call('editor', 'POST', `/v1/contexts/${context}/definitions/extensions`, {
    extension,
  });
  expect(publishedExtension.status, JSON.stringify(publishedExtension.body)).toBe(201);
  const extensionDigestValue = publishedExtension.body.digest as string;
  const extensionRead = await call(
    'anonymous',
    'GET',
    `/v1/contexts/${context}/definitions/extensions/${extensionDigestValue}`,
  );
  expect(extensionRead.status, JSON.stringify(extensionRead.body)).toBe(200);
  expect(extensionRead.body.digest).toBe(extensionDigestValue);
  const currentExtension = await call('editor', 'GET', `/v1/contexts/${context}/definitions`);
  const extensionHead = currentExtension.body.head as number;
  const activatedExtension = await call(
    'editor',
    'POST',
    `/v1/contexts/${context}/definitions/extensions/${extensionDigestValue}:activate`,
    { expected_head: extensionHead === 0 ? null : extensionHead },
  );
  expect(activatedExtension.status, JSON.stringify(activatedExtension.body)).toBe(200);

  await real.grant(global, 'reader', 'definitions:publish');
  const revokedGate = await call('reader', 'POST', '/v1/definitions/imports', { document: usable });
  expect(revokedGate.status).toBe(403);
  await real.grant(global, 'editor', 'gate:definition_publication');
  await real.revoke(global, 'editor', 'gate:definition_publication');
  const revoked = await call('editor', 'POST', '/v1/definitions/imports', { document: usable });
  expect(revoked.status).toBe(403);
  expect(revoked.body.code).toBe('platform_closed');
}, 180_000);

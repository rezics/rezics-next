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
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(63)]]) },
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
    'context:read',
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

function typeLabels(locale: string) {
  return Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => {
      const id = index === 0 ? 'ex:V0Work' : `ex:T${index}`;
      const base = index === 0 ? 'Fixture vertical work' : `Type ${index}`;
      return [id, locale === 'en' ? base : `${base} ${locale}`];
    }),
  );
}

function propertyLabels(locale: string) {
  return { 'ex:playerCount': locale === 'en' ? 'Player count' : `Player count ${locale}` };
}

function fixtureSources() {
  const classes: Record<string, object> = {
    V0Work: { class_uri: 'ex:V0Work', slots: ['playerCount'] },
  };
  for (let index = 1; index < 10; index++) classes[`T${index}`] = { class_uri: `ex:T${index}` };
  return {
    root: 'main.yaml',
    schemas: {
      'main.yaml': JSON.stringify({
        id: 'https://catalogue.example/fixture-vertical',
        name: 'fixture',
        version: '1',
        prefixes: { ex: 'https://example.org/vocab/' },
        classes,
        slots: { playerCount: { slot_uri: 'ex:playerCount', annotations: { datatype: 'string' } } },
      }),
    },
    presentation: Object.fromEntries(
      VERTICAL_LOCALES.map((locale) => [
        locale,
        JSON.stringify({ types: typeLabels(locale), properties: propertyLabels(locale) }),
      ]),
    ),
  };
}

test('platform and Context editors publish, resume, activate and use a compiled fixture vertical with independent pinned reads', async () => {
  const anonymous = await call('anonymous', 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(anonymous.status, JSON.stringify(anonymous.body)).toBe(403);
  expect(anonymous.body.code).toBe('platform_closed');
  const closed = await call('reader', 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(closed.status, JSON.stringify(closed.body)).toBe(403);
  expect(closed.body.code).toBe('platform_closed');
  const suspended = await call('suspended', 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(suspended.status).toBe(401);
  expect(suspended.body.code).toBe('invalid_credentials');

  const invalid = await call('editor', 'POST', '/v1/definitions/imports', { document: { format: 'nope' } });
  expect(invalid.status, JSON.stringify(invalid.body)).toBe(200);
  expect(invalid.body.kind).toBe('invalid');
  expect(invalid.body.diagnostics[0]?.pointer).toBe('/document');

  const sources = fixtureSources();
  const compiled = await compileCatalogue(sources);
  expect(Object.keys(compiled.types)).toHaveLength(10);
  const typeId = 'ex:V0Work';
  const fieldId = 'ex:playerCount';
  const preview = await call('editor', 'POST', '/v1/definitions/imports', { document: sources });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.kind).toBe('sources');
  expect(preview.body.diagnostics).toEqual([]);
  expect(preview.body.identity.digest).toBe(releaseDigest(compiled));
  expect(preview.body.identity.version).toBe(compiled.catalogue.version);
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
  expect(independent.body.release.types[typeId].labels).toEqual(compiled.types[typeId]!.labels);
  expect(independent.body.release.properties[fieldId].labels).toEqual(compiled.properties[fieldId]!.labels);
  for (const locale of VERTICAL_LOCALES) {
    expect(independent.body.release.types[typeId].labels[locale].length).toBeGreaterThan(0);
    expect(independent.body.release.properties[fieldId].labels[locale].length).toBeGreaterThan(0);
  }

  const stale = await call('editor', 'POST', `/v1/definitions/releases/${digest}:activate`, {
    expected_head: previousHead + 1,
  });
  expect(stale.status, JSON.stringify(stale.body)).toBe(409);
  const refreshed = await call('editor', 'GET', '/v1/definitions/active');
  expect(refreshed.body.head).toBe(previousHead);
  const comparison = await call('editor', 'POST', '/v1/definitions/imports', {
    document: sources,
    expected_head: refreshed.body.head,
  });
  expect(comparison.body.reconciliation.stale).toBe(false);
  expect(comparison.body.identity.digest).toBe(digest);
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
  expect(created.body.subject.type).toBe(typeId);
  expect(created.body.subject.release).toBe(digest);
  expect(created.body.subject.labels.en).toBe('Fixture vertical work');
  const subject = await call('editor', 'GET', `/v1/subjects/${created.body.subject.id}`);
  expect(subject.status, JSON.stringify(subject.body)).toBe(200);
  expect(subject.body.subject.id).toBe(created.body.subject.id);
  expect(subject.body.subject.type).toBe(typeId);
  for (const locale of VERTICAL_LOCALES) {
    const descriptor = await call(
      'anonymous',
      'GET',
      `/v1/definitionTypes/${encodeURIComponent(typeId)}?locale=${locale}`,
    );
    expect(descriptor.status, `${locale} ${JSON.stringify(descriptor.body)}`).toBe(200);
    expect(descriptor.body.label).toBe(compiled.types[typeId]!.labels[locale]);
    expect(descriptor.body.properties[fieldId].labels[locale]).toBe(compiled.properties[fieldId]!.labels[locale]);
  }

  const contextResult = await call('editor', 'POST', '/v1/contexts', { labels: { en: 'Publication extension' } });
  expect(contextResult.status, JSON.stringify(contextResult.body)).toBe(201);
  const context = contextResult.body.context.id as string;
  const resource = { route: routeOf(context)!, id: context };
  for (const action of ['definitions:publish', 'definitions:activate', 'context:read'])
    await real.grant(resource, 'editor', action);
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
  expect(extensionPreview.body.kind).toBe('extension');
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
  for (const locale of VERTICAL_LOCALES)
    expect(
      extensionRead.body.extension.terms[`${termPrefix(context)}:boardLink`].labels[locale].length,
    ).toBeGreaterThan(0);
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
  const revokedGate = await call('reader', 'POST', '/v1/definitions/imports', { document: sources });
  expect(revokedGate.status).toBe(403);
  await real.revoke(global, 'editor', 'gate:definition_publication');
  const revoked = await call('editor', 'POST', '/v1/definitions/imports', { document: sources });
  expect(revoked.status).toBe(403);
  expect(revoked.body.code).toBe('platform_closed');
}, 180_000);

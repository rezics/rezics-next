import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT } from '@rezics/composition';
import { bundledRelease } from '@rezics/definitions/bundled';
import { EXTENSION_FORMAT, termPrefix } from '@rezics/definitions/extension';
import { visibleOperations } from '../../src/access/gates/visibility.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

const global = { route: 0, id: GLOBAL_CONTEXT };
const accounts = { operator: newId(0x7211), editor: newId(0x7212), reader: newId(0x7213) };
const actions = [
  'access:grant',
  'gate:any',
  'definitions:publish',
  'definitions:activate',
  'definitions:read',
  'subject:create',
  'subject:read',
  'subject:merge',
  'statement:propose',
  'context:create',
  'context:read',
  'context:accept',
  'context:adopt',
  'presentation:read',
  'exposure:read',
  'openapi:read',
];
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let real: Awaited<ReturnType<typeof createRealAccess<typeof accounts>>>;
let app: ReturnType<typeof createKernel>;
let profile: string;
const clock = () => new Date();
beforeAll(async () => {
  db = await openGrowthDatabase();
  real = await createRealAccess(db.admin, accounts, actions);
  app = createKernel({
    pool: db.pool,
    access: real.access,
    clock,
    routeKey: new Uint8Array(32).fill(61),
    writeRate: createWriteRateLimiter({
      secret: 'semantic-public-slice-write-rate-secret',
      overrides: '{"new-account":{"write":{"maximum":10000,"seconds":60}}}',
    }),
  });
  await bootstrapRelease(db.pool, bundledRelease);
  profile = await bootstrapProfile(db.pool, {
    format: PROFILE_FORMAT,
    generic: { views: { overview: { root: { props: {} }, content: [] } } },
    types: [],
    bases: [],
    routes: [],
  });
  // Existing native fixture authority only. Feature groups remain globally closed.
  for (const action of ['access:grant', 'gate:any', 'definitions:publish', 'definitions:activate', 'subject:merge'])
    await real.grant(global, 'operator', action);
  for (const action of ['subject:create', 'statement:propose', 'context:create', 'context:accept', 'context:adopt'])
    await real.grant(global, 'editor', action);
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
        'idempotency-key': JSON.stringify(randomUUID()),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}
function status(answer: { status: number; body: unknown }, expected: number) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(expected);
}
function closed(answer: Awaited<ReturnType<typeof call>>) {
  status(answer, 403);
  expect(answer.body).toEqual({
    type: 'https://rezics.com/problems/platform_closed',
    title: 'Platform Closed',
    status: 403,
    code: 'platform_closed',
    retryable: false,
    effect_status: 'not_applied',
    request_id: expect.any(String),
  });
}
async function grant(who: 'editor' | 'reader', action: string, resource = global) {
  status(
    await call('operator', 'POST', '/v1/grants', {
      resource,
      subject: { kind: 'account', id: accounts[who] },
      actions: [action],
      valid: '(,)',
    }),
    201,
  );
}
async function effects() {
  const counts: Record<string, number> = {};
  for (const table of [
    'core.receipt',
    'core.outbox',
    'semantic.definition_release',
    'semantic.definition_activation',
    'semantic.context_extension',
    'semantic.context_extension_activation',
    'semantic.subject',
    'semantic.revision',
  ]) {
    counts[table] = (await db.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
  }
  return counts;
}
async function person(label: string) {
  const result = await call('editor', 'POST', '/v1/subjects', { type: 'schema:Person', labels: { en: label } });
  status(result, 201);
  return result.body.subject.id as string;
}

test('ordinary native contributions and released definition and common profile reads remain public', async () => {
  const active = await call('anonymous', 'GET', '/v1/definitions/active');
  status(active, 200);
  status(await call('anonymous', 'GET', `/v1/definitions/releases/${active.body.digest}`), 200);
  status(await call('reader', 'GET', `/v1/presentation/profiles/${profile}`), 200);
  status(await call('anonymous', 'GET', `/v1/presentation/profiles/${profile}`), 200);
  const subject = await person('Ordinary catalogue contribution');
  const value = `https://example.test/${randomUUID()}`;
  const proposed = await call('editor', 'POST', `/v1/subjects/${subject}/candidates`, {
    statement: {
      property: { id: 'schema:url' },
      value: { type: 'value', content: value },
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } },
          ],
        },
      ],
    },
  });
  status(proposed, 201);
  status(
    await call('editor', 'POST', `/v1/subjects/${subject}/candidates/${proposed.body.candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    }),
    200,
  );
  status(
    await call('editor', 'POST', `/v1/subjects/${subject}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate: proposed.body.candidate, rank: 'normal' }],
      expected_head: null,
    }),
    200,
  );
  const read = await call('anonymous', 'GET', `/v1/subjects/${subject}`);
  status(read, 200);
  expect(JSON.stringify(read.body)).toContain(value);
  status(await call('reader', 'GET', `/v1/subjects/${subject}/candidates?property=schema%3Aurl`), 200);
  const invalid = await call('anonymous', 'GET', '/v1/definitions/active', undefined, {
    authorization: 'Bearer invalid',
  });
  status(invalid, 401);
  expect(invalid.body.code).toBe('invalid_credentials');
}, 120_000);

test('definition publication, Context extension writes and identity refuse before any native effects', async () => {
  const subjects = [await person('Identity one'), await person('Identity two')];
  const digest = (await call('anonymous', 'GET', '/v1/definitions/active')).body.digest;
  const writes: [string, unknown][] = [
    ['/v1/definitions/releases', { release: bundledRelease }],
    [`/v1/definitions/releases/${digest}:activate`, { expected_head: 1 }],
    [`/v1/contexts/${GLOBAL_CONTEXT}/definitions/extensions`, { extension: {} }],
    [`/v1/contexts/${GLOBAL_CONTEXT}/definitions/extensions/${digest}:activate`, { expected_head: null }],
    ['/v1/subjects:merge', { subjects }],
  ];
  const before = await effects();
  for (const [path, body] of writes)
    for (const who of ['anonymous', 'editor', 'reader'] as const) closed(await call(who, 'POST', path, body));
  expect(await effects()).toEqual(before);
  const invalid = await call('anonymous', 'POST', writes[0]![0], writes[0]![1], { authorization: 'Bearer invalid' });
  status(invalid, 401);
  expect(invalid.body.code).toBe('invalid_credentials');
}, 120_000);

test('native platform grants expose real development commands while preserving resource authority and discovery', async () => {
  const ids = (body: Record<string, any>) =>
    Object.values(body.paths).flatMap((path: any) =>
      Object.values(path).map((operation: any) => operation.operationId),
    );
  const gated = [
    'definitions.publish',
    'definitions.activate',
    'definitions.publish_extension',
    'definitions.activate_extension',
    'subject.merge',
  ];
  const publicIds = ids((await call('anonymous', 'GET', '/v1/openapi.json')).body);
  for (const id of gated) expect(publicIds).not.toContain(id);
  expect(publicIds).toContain('subject.create');
  expect(publicIds).toContain('definitions.read_active');
  const generated = openApiDocument(app);
  const generatedOps = Object.values(generated.paths).flatMap((path) => Object.values(path));
  for (const id of gated)
    expect(generatedOps.find((op) => op.operationId === id)?.['x-exposure']).toBe(
      id === 'subject.merge' ? 'gate:subject_identity' : 'gate:definition_publication',
    );
  await grant('reader', 'gate:definition_publication');
  const denied = await call('reader', 'POST', '/v1/definitions/releases', { release: bundledRelease });
  status(denied, 403);
  expect(denied.body.code).toBe('forbidden');
  await grant('editor', 'gate:definition_publication');
  await grant('editor', 'gate:subject_identity');
  await grant('editor', 'definitions:publish');
  await grant('editor', 'definitions:activate');
  await grant('editor', 'subject:merge');
  const admitted = await call('editor', 'GET', '/v1/platform/exposure');
  status(admitted, 200);
  expect(admitted.body.admitted).toEqual(expect.arrayContaining(['definition_publication', 'subject_identity']));
  const discoveryAccess = real.access({ actions: actionCatalogue(app) });
  const actor = await discoveryAccess.authenticate(real.bearer('editor'), {
    pool: db.pool,
    deadline: Date.now() + 30_000,
  });
  const visible = await visibleOperations({
    viewer: actor,
    pool: db.pool,
    access: discoveryAccess,
    routes: app.routes,
    deadline: Date.now() + 30_000,
    clock,
  });
  const served = ids((await call('editor', 'GET', '/v1/openapi.json')).body);
  expect(served.sort()).toEqual(visible.map((operation) => operation.operationId).sort());
  for (const id of gated) expect(served).toContain(id);
  const developmentRelease = structuredClone(bundledRelease);
  developmentRelease.catalogue.version = '999.0.0';
  const published = await call('editor', 'POST', '/v1/definitions/releases', { release: developmentRelease });
  status(published, 201);
  expect((await call('anonymous', 'GET', `/v1/definitions/releases/${published.body.digest}`)).body.release).toEqual(
    developmentRelease,
  );
  const active = (await call('anonymous', 'GET', '/v1/definitions/active')).body;
  status(
    await call('editor', 'POST', `/v1/definitions/releases/${published.body.digest}:activate`, {
      expected_head: active.head,
    }),
    200,
  );
  const contextResult = await call('editor', 'POST', '/v1/contexts', {
    labels: { en: 'Development extension' },
    settings: 'lifecycle',
  });
  status(contextResult, 201);
  const context = contextResult.body.context.id as string;
  const resource = { route: routeOf(context)!, id: context };
  // This Context's creator owns its native grant administration and exact definition actions.
  for (const action of ['definitions:publish', 'definitions:activate']) await real.grant(resource, 'editor', action);
  const extension = {
    format: EXTENSION_FORMAT,
    context,
    terms: {
      [`${termPrefix(context)}:related`]: {
        description: { en: 'Development relation' },
        labels: { en: 'related' },
        domain: ['schema:Person'],
        targets: ['schema:Person'],
        multivalued: true,
        relation: { group: 'association', inverse: 'none' },
      },
    },
  };
  const extended = await call('editor', 'POST', `/v1/contexts/${context}/definitions/extensions`, { extension });
  status(extended, 201);
  status(
    await call('editor', 'POST', `/v1/contexts/${context}/definitions/extensions/${extended.body.digest}:activate`, {
      expected_head: null,
    }),
    200,
  );
  const subjects = [await person('Development identity one'), await person('Development identity two')];
  const merged = await call('editor', 'POST', '/v1/subjects:merge', { subjects });
  status(merged, 200);
  expect(merged.body).toMatchObject({
    survivor: expect.any(String),
    redirected: expect.any(String),
    revision: expect.any(Number),
  });
  const redirect = await call('anonymous', 'GET', `/v1/subjects/${merged.body.redirected}`);
  status(redirect, 308);
  expect(redirect.headers.get('location')).toBe(`/v1/subjects/${merged.body.survivor}`);
  const ungranted = ids((await call('anonymous', 'GET', '/v1/openapi.json')).body);
  for (const id of gated) expect(ungranted).not.toContain(id);
}, 180_000);

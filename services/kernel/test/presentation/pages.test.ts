import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { activeRelease, bootstrapRelease } from '../../src/semantic/definitions.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(() => pool.end());
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(7),
  access: {
    async authenticate() {
      return {
        kind: 'account',
        accountId: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
        clientId: 'web',
        scopes: ['subject:create', 'statement:propose', 'subject:read', 'presentation:read'],
        requestedBy: null,
        authnEpoch: 1,
      };
    },
    async authorize() {
      return true;
    },
  },
  writeRate: {
    async spend() {
      return { allowed: true };
    },
  },
});

async function call(method: string, path: string, body?: unknown, editor = false) {
  const headers: Record<string, string> = {};
  if (editor) {
    headers.authorization = 'Bearer editor';
    headers['idempotency-key'] = `"${randomUUID()}"`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
const read = (target: unknown) => call('POST', '/v1/pages:read', { target });
async function create(type: string, label: string): Promise<string> {
  const created = await call('POST', '/v1/subjects', { type, labels: { en: label } }, true);
  expect(created.response.status).toBe(201);
  return created.body.subject.id;
}
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const works = node('SubjectList', 'works', { title: { en: 'Works' }, property: 'schema:author', limit: 6 });
let profile: PresentationProfile;
let base: { type: string; base: string };
const withoutRequestId = ({ request_id: _ignored, ...rest }: Record<string, unknown>) => rest;

test('a page read answers presentation_not_ready until a profile is active', async () => {
  const answer = await read({ route: '/' });
  expect(answer.response.status).toBe(503);
  expect(answer.body.code).toBe('presentation_not_ready');
  expect(answer.response.headers.get('retry-after')).toBe('1');
  const { release } = (await activeRelease(pool))!;
  const [type, definition] = Object.entries(release.types).find(
    ([type, definition]) => type !== 'schema:Book' && definition.bases.length > 0,
  )!;
  base = { type, base: definition.bases[0]! };
  profile = {
    format: PROFILE_FORMAT,
    generic: page(node('SubjectHeader', 'header'), node('MoreStatements', 'more')),
    bases: [
      { base: base.base, document: page(node('SubjectHeader', 'header'), node('Text', 'base', { text: 'Base' })) },
    ],
    types: [
      {
        type: 'schema:Book',
        document: page(
          node('SubjectHeader', 'header'),
          node('Statements', 'facts', { properties: ['schema:author'] }),
          works,
        ),
      },
    ],
    routes: [{ route: '/', document: page(node('Heading', 'home', { text: 'Home', level: 2 })) }],
  };
  await bootstrapProfile(pool, profile);
});

test('a subject page resolves its type template and runs its reads in one round trip', async () => {
  const id = await create('schema:Book', 'Kokoro');
  const answer = await read({ subject: id });
  expect(answer.response.status).toBe(200);
  expect(answer.response.headers.get('cache-control')).toBe('private, no-store');
  expect(answer.body.subject).toBe(id);
  expect(answer.body.profile).toBe(profileDigest(profile));
  expect(answer.body.template).toEqual({ scope: 'type', key: 'schema:Book' });
  expect(answer.body.document).toEqual(profile.types[0]!.document);
  expect(Object.keys(answer.body.reads).sort()).toEqual(['r0', 'r1']);
  const standalone = await call('GET', `/v1/subjects/${id}`);
  expect(answer.body.reads.r0).toEqual({ status: 200, body: standalone.body });
  const search = await call('POST', '/v1/subjects:search', {
    filter: { statement: { property: 'schema:author', in: [id] } },
    sort: 'name',
    limit: 6,
  });
  expect(answer.body.reads.r1.status).toBe(search.response.status);
  expect(withoutRequestId(answer.body.reads.r1.body)).toEqual(withoutRequestId(search.body));
});

test('a subject without a type template falls back through its structural bases', async () => {
  const id = await create(base.type, 'Based');
  const answer = await read({ subject: id });
  expect(answer.response.status).toBe(200);
  expect(answer.body.template).toEqual({ scope: 'base', key: base.base });
  expect(answer.body.document).toEqual(profile.bases[0]!.document);
  expect(answer.body.reads).toEqual({ r0: { status: 200, body: (await call('GET', `/v1/subjects/${id}`)).body } });
});

test('an unknown subject answers exactly what the subject read answers', async () => {
  const id = await create('schema:Book', 'Known');
  const unknown = `${id.slice(0, -12)}${'f'.repeat(12)}`;
  const answer = await read({ subject: unknown });
  const standalone = await call('GET', `/v1/subjects/${unknown}`);
  expect(answer.response.status).toBe(404);
  expect(answer.response.status).toBe(standalone.response.status);
  expect(withoutRequestId(answer.body)).toEqual(withoutRequestId(standalone.body));
});

test('route targets resolve route templates and malformed targets are field errors', async () => {
  const home = await read({ route: '/' });
  expect(home.response.status).toBe(200);
  expect(home.body).toEqual({
    profile: profileDigest(profile),
    template: { scope: 'route', key: '/' },
    document: profile.routes[0]!.document,
    reads: {},
  });
  const other = await read({ route: '/unknown' });
  expect(other.body.template).toEqual({ scope: 'generic', key: null });
  expect(other.body.document).toEqual(profile.generic);
  expect(other.body.reads).toEqual({});
  const route = await read({ route: '//x' });
  expect(route.response.status).toBe(400);
  expect(route.body.code).toBe('invalid_request');
  expect(route.body.errors).toEqual([{ pointer: '/target/route', code: 'invalid_format' }]);
  const subject = await read({ subject: 'not-a-uuid' });
  expect(subject.response.status).toBe(400);
  expect(subject.body.errors).toEqual([{ pointer: '/target/subject', code: 'invalid_format' }]);
  for (const target of [{}, { subject: randomUUID(), route: '/' }, 'x'])
    expect((await read(target)).response.status).toBe(400);
});

test('the kernel contract documents the page read', () => {
  const operation = openApiDocument(kernel).paths['/v1/pages:read']!.post!;
  expect(operation).toMatchObject({
    operationId: 'pages.read',
    'x-action': 'presentation:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(Object.keys(operation.responses!).sort()).toEqual(['200', '400', '401', '404', '503']);
});

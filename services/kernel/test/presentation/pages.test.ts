import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, profileDigest, templateViews, type PresentationProfile } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linksCaughtUp } from '../../src/semantic/link-freshness.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001' };
const realAccess = await createRealAccess(admin, accounts, ['subject:create']);
const kernel = createKernel({
  pool,
  requestDeadlineMs: 30_000,
  routeKey: new Uint8Array(32).fill(7),
  access: realAccess.access,
  writeRate: realAccess.writeRate,
});

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
});

async function call(method: string, path: string, body?: unknown, editor = false) {
  const headers: Record<string, string> = {};
  if (editor) {
    headers.authorization = `Bearer ${realAccess.bearer('editor')}`;
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
const setupSubjects = new Set<string>();
// Definition and profile bootstrap both commit in the Global Context's home.
const setupHomes = new Set([partitionOf(routeOf(GLOBAL_CONTEXT)!)]);

async function projectSetup(): Promise<void> {
  const projection = linkProjection(pool);
  for (let round = 0; round < 50; round++) {
    let progressed = false;
    for (const partition of setupHomes) {
      const result = await projection.run(partition);
      if (result.status !== 'read')
        throw new Error(
          `Semantic setup projection ${partition}: ${result.status}${result.status === 'stopped' ? ` (${result.reason}) at ${result.position}` : ''}`,
        );
      progressed ||= result.envelopes > 0;
    }
    // Applying a batch can emit more events, including back into an earlier home.
    if (progressed) continue;
    const seen = [];
    for (const partition of setupHomes) {
      const head = await readPartition(pool, partition);
      if (!head) throw new Error(`Semantic setup home ${partition} is unavailable`);
      seen.push({ partition, epoch: head.epoch, position: head.position });
    }
    for (const subject of setupSubjects)
      expect(
        await linksCaughtUp(pool, seen, subject, undefined, [...setupSubjects]),
        `Semantic setup must cover ${subject} at ${seen.map((head) => `${head.partition}.${head.epoch}:${head.position}`).join(', ')}`,
      ).toBe(true);
    return;
  }
  throw new Error('Semantic setup projection did not reach quiescence in 50 bounded relay rounds');
}

async function create(type: string, label: string): Promise<string> {
  const created = await call('POST', '/v1/subjects', { type, labels: { en: label } }, true);
  expect(created.response.status, JSON.stringify(created.body)).toBe(201);
  const id: string = created.body.subject.id;
  setupSubjects.add(id);
  setupHomes.add(partitionOf(routeOf(id)!));
  await projectSetup();
  return id;
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
    generic: {
      views: {
        overview: page(node('SubjectHeader', 'header'), node('MoreStatements', 'more')),
        details: page(node('MoreStatements', 'details')),
      },
    },
    bases: [
      { base: base.base, document: page(node('SubjectHeader', 'header'), node('Text', 'base', { text: 'Base' })) },
    ],
    types: [
      {
        type: 'schema:Book',
        views: {
          overview: page(
            node('SubjectHeader', 'header'),
            node('Statements', 'facts', { properties: ['schema:author'] }),
            works,
          ),
          credits: page(node('Text', 'credits', { text: 'Credits' })),
        },
      },
    ],
    routes: [{ route: '/', document: page(node('Heading', 'home', { text: 'Home', level: 2 })) }],
  };
  await bootstrapProfile(pool, profile);
});

test('a subject page resolves its type template and runs its reads in one round trip', async () => {
  const id = await create('schema:Book', 'Kokoro');
  const answer = await read({ subject: id });
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.response.headers.get('cache-control')).toBe('private, no-store');
  expect(answer.body.subject).toBe(id);
  expect(answer.body.profile).toBe(profileDigest(profile));
  expect(answer.body.template).toEqual({ scope: 'type', key: 'schema:Book' });
  expect(answer.body.document).toEqual(templateViews(profile.types[0]!).overview);
  expect(Object.keys(answer.body.reads).sort()).toEqual(['r0', 'r1']);
  const standalone = await call('GET', `/v1/subjects/${id}`);
  expect(answer.body.reads.r0).toEqual({ status: 200, body: standalone.body });
  const links = await call('GET', `/v1/subjects/${id}/links?property=schema%3Aauthor&limit=6`);
  expect(answer.body.reads.r1.status).toBe(links.response.status);
  expect(links.response.status).toBe(200);
  expect(withoutRequestId(answer.body.reads.r1.body)).toEqual(withoutRequestId(links.body));
});

test('a subject without a type template falls back through its structural bases', async () => {
  const id = await create(base.type, 'Based');
  const answer = await read({ subject: id });
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.body.template).toEqual({ scope: 'base', key: base.base });
  expect(answer.body.document).toEqual(profile.bases[0]!.document);
  expect(answer.body.reads).toEqual({ r0: { status: 200, body: (await call('GET', `/v1/subjects/${id}`)).body } });
});

test('a view target answers that view, falling back to the generic view, and lists the views a page defines', async () => {
  const id = await create('schema:Book', 'Viewed');
  const overview = await read({ subject: id });
  expect(overview.body.views).toEqual(['overview', 'credits', 'details']);
  const same = await read({ subject: id, view: 'overview' });
  expect(same.body.document).toEqual(overview.body.document);
  const credits = await read({ subject: id, view: 'credits' });
  expect(credits.response.status).toBe(200);
  expect(credits.body.template).toEqual({ scope: 'type', key: 'schema:Book' });
  expect(credits.body.document).toEqual(templateViews(profile.types[0]!).credits);
  expect(credits.body.views).toEqual(['overview', 'credits', 'details']);
  expect(Object.keys(credits.body.reads)).toEqual([]);
  const details = await read({ subject: id, view: 'details' });
  expect(details.body.template).toEqual({ scope: 'generic', key: null });
  expect(details.body.document).toEqual(templateViews(profile.generic).details);
  const undefinedView = await read({ subject: id, view: 'works' });
  expect(undefinedView.response.status).toBe(404);
  const unknownView = await read({ subject: id, view: 'tabs' });
  expect(unknownView.response.status).toBe(400);
  expect(unknownView.body.errors).toEqual([{ pointer: '/target/view', code: 'invalid_format' }]);
  const routeView = await read({ route: '/', view: 'details' });
  expect(routeView.body.errors).toEqual([{ pointer: '/target/view', code: 'unknown_field' }]);
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
  expect(other.body.document).toEqual(templateViews(profile.generic).overview);
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
  expect(Object.keys(operation.responses!).sort()).toEqual(['200', '308', '400', '401', '404', '503']);
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
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
import { readPage } from '../../src/presentation/reads.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { newId } from '../../src/route/route.ts';
import { itemFacts } from '../../src/semantic/item.ts';

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

test('native subject redirect, credentials and aggregate observations retain standalone authority', async () => {
  const personas = { reader: '019a1b2c-3d4e-7f00-8a00-ed170e000002' };
  const access = await createRealAccess(admin, personas, ['subject:create', 'subject:merge', 'subject:read']);
  for (const action of ['subject:create', 'subject:merge', 'gate:subject_identity'])
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'reader', action);
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(23)]]) };
  const native = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(7),
    requestDeadlineMs: 30_000,
    access: access.access,
    writeRate: access.writeRate,
    tokens: ring,
  });
  const bearer = `Bearer ${access.bearer('reader')}`;
  async function send(path: string, body?: unknown) {
    const response = await native.handle(
      new Request(`http://kernel.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: bearer,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { response, body: (await response.json()) as any };
  }
  const ids: string[] = [];
  for (const label of ['Canonical subject', 'Merged subject']) {
    const created = await send('/v1/subjects', { type: 'schema:Book', labels: { en: label } });
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    ids.push(created.body.subject.id);
  }
  ids.sort();
  const [survivor, redirected] = ids as [string, string];
  const merged = await send('/v1/subjects:merge', { subjects: ids });
  expect(merged.response.status, JSON.stringify(merged.body)).toBe(200);
  const callerSession = merged.response.headers.get(SESSION_HEADER)!;
  expect(callerSession).not.toBeNull();
  const seen: Request[] = [];
  const observations: string[] = [callerSession];
  const session = { ring, scope: `account:${personas.reader}` };
  const missing = randomUUID();
  const page = await readPage({
    incoming: new Request('http://kernel.test/v1/pages:read', {
      headers: { authorization: bearer, [SESSION_HEADER]: callerSession, cookie: 'unforwarded=secret' },
    }),
    reads: {
      old: { kind: 'subject', id: redirected },
      alias: { kind: 'subject', id: redirected },
      unknown: { kind: 'subject', id: missing },
    },
    session,
    async dispatch(request) {
      seen.push(request);
      const response = await native.handle(request);
      const token = response.headers.get(SESSION_HEADER);
      if (token !== null) observations.push(token);
      return response;
    },
  });
  expect(seen.map((request) => new URL(request.url).pathname).sort()).toEqual(
    [`/v1/subjects/${redirected}`, `/v1/subjects/${survivor}`, `/v1/subjects/${missing}`].sort(),
  );
  expect(page.results.old!.status).toBe(200);
  expect(page.results.old).toBe(page.results.alias);
  expect(page.results.old!.body).toEqual((await send(`/v1/subjects/${survivor}`)).body);
  expect(page.results.unknown!.status).toBe(404);
  expect(withoutRequestId(page.results.unknown!.body as Record<string, unknown>)).toEqual(
    withoutRequestId((await send(`/v1/subjects/${missing}`)).body),
  );
  expect(page.session).not.toBeNull();
  const mergedComponents = decodeSession(ring, session.scope, page.session!)!;
  for (const token of observations) {
    const components = decodeSession(ring, session.scope, token)!;
    expect(components).not.toBeNull();
    for (const component of components) {
      const observed = mergedComponents.find(({ partition }) => partition === component.partition)!;
      expect(observed.epoch).toBeGreaterThanOrEqual(component.epoch);
      if (observed.epoch === component.epoch) expect(observed.position).toBeGreaterThanOrEqual(component.position);
    }
  }
  for (const request of seen) {
    expect(request.headers.get('authorization')).toBe(bearer);
    expect(request.headers.get(SESSION_HEADER)).toBe(callerSession);
    expect(request.headers.get('cookie')).toBeNull();
  }
  const invalid = await readPage({
    incoming: new Request('http://kernel.test/v1/pages:read', { headers: { authorization: 'Bearer invalid' } }),
    reads: { subject: { kind: 'subject', id: survivor } },
    session,
    dispatch: (request) => native.handle(request),
  });
  expect(invalid.results.subject!.status).toBe(401);
  expect((invalid.results.subject!.body as any).code).toBe('invalid_credentials');
  expect(access.readChecks).toContainEqual({
    persona: 'reader',
    action: 'subject:read',
    resource: { route: routeOf(survivor)!, id: survivor },
  });
});

test('a fixed native admitted plan retains dispatch, row and byte bounds at 64, 512 and 4096 unrelated subjects and revisions', async () => {
  const db = await openGrowthDatabase(url);
  try {
    await bootstrapRelease(db.pool, bundledRelease);
    const access = await createRealAccess(
      db.admin,
      {
        editor: '019a1b2c-3d4e-7f00-8a00-ed170e000003',
      },
      ['subject:create'],
    );
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
    const native = createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32).fill(7),
      requestDeadlineMs: 30_000,
      access: access.access,
      writeRate: access.writeRate,
    });
    const response = await native.handle(
      new Request('http://kernel.test/v1/subjects', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${randomUUID()}"`,
        },
        body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Fixed admission anchor' } }),
      }),
    );
    const created = (await response.json()) as any;
    expect(response.status, JSON.stringify(created)).toBe(201);
    const anchor: string = created.subject.id;
    const population: Population = {
      name: 'aggregate-unrelated-subjects-and-history',
      hotPartition: partitionOf(routeOf(anchor)!),
      hotShare: 1,
      rows: ({ ordinal, route }) => {
        const id = newId(route);
        const tx = randomUUID();
        return {
          'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: tx }],
          'semantic.revision': [1, 2].map((revision) => ({
            route,
            subject_id: id,
            revision,
            kind: revision === 1 ? 'create' : 'adopt',
            release: bundledDigest,
            recorded_transaction_id: tx,
          })),
          'semantic.fact': itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } }).map((fact) => ({
            ...fact,
            route,
            subject_id: id,
            recorded_transaction_id: tx,
          })),
        };
      },
    };
    const report = await checkGrowth(db, {
      name: 'a fixed native admitted plan retains dispatch, row and byte bounds at 64, 512 and 4096 unrelated subjects and revisions',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      grow: (database, scale, previous) =>
        seed({ pool: database.pool, admin: database.admin }, population, {
          from: previous,
          to: scale,
        }),
      operation: async () => {
        let calls = 0;
        const page = await readPage({
          incoming: new Request('http://kernel.test/v1/pages:read'),
          session: { ring: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) }, scope: 'anonymous' },
          reads: { anchor: { kind: 'subject', id: anchor }, alias: { kind: 'subject', id: anchor } },
          async dispatch(request) {
            calls++;
            return native.handle(request);
          },
        });
        expect(calls).toBe(1);
        expect(page.results.anchor!.status).toBe(200);
        expect(page.results.anchor).toBe(page.results.alias);
        expect((page.results.anchor!.body as any).subject.id).toBe(anchor);
        return page;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
    for (const { cost } of report.samples) {
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.responseBytes!).toBeGreaterThan(0);
    }
  } finally {
    await db.close();
  }
}, 180_000);

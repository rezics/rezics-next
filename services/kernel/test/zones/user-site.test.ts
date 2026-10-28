import { afterAll, beforeAll, expect, test } from 'bun:test';
import { UI_LOCALES, type ZoneStarter } from '@rezics/composition';
import { Compile } from 'typebox/compile';
import { problemSchema } from '../../src/http/problem.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { ZonePageResponseSchema, type ZonePageRequest } from '../../src/zones/contract.ts';
import { ZonePageReadProgressSchema } from '../../src/zones/page-continuation.ts';
import { createBody, page, problem, resourceFixture, type Persona, type ResourceFixture } from './resource-fixture.ts';

// The case ledger distinguishes these native HTTP assertions from the worker-dependent cells still unbound.
// Resource, typed, membership and discovery suites retain their own policy assertions unchanged.
let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

type Answer = Awaited<ReturnType<ResourceFixture['call']>>;
const commonPage = Compile(ZonePageResponseSchema);
const progress = Compile(ZonePageReadProgressSchema);
const unavailable = Compile(
  problemSchema(
    'dependency_unavailable',
    'index_not_ready',
    'semantic_not_ready',
    'presentation_not_ready',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
);
const path = (id: string) => `/v1/zones/${id}`;

function complete(answer: Answer) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(commonPage.Check(answer.body), JSON.stringify(answer.body)).toBe(true);
  expect(answer.headers.get('cache-control')).toBe('private, no-store');
  expect(answer.body.profile).toMatch(/^sha256:[0-9a-f]{64}$/);
  return answer.body;
}

async function read(id: string, who: Persona, request: ZonePageRequest, cursor?: string) {
  const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor })}`;
  return f.call(who, 'POST', `${path(id)}:readPage${query}`, request);
}

// This follows native retained progress, without the Web renderer's four-follow limit.
// Test timeout remains the failure boundary for a service that never converges on this finite input.
async function resolved(id: string, who: Persona, request: ZonePageRequest, cursor?: string) {
  let answer = await read(id, who, request, cursor);
  while (answer.status === 202) {
    expect(answer.headers.get('cache-control')).toBe('private, no-store');
    expect(progress.Check(answer.body), JSON.stringify(answer.body)).toBe(true);
    // The closed progress schema excludes a partial document, reads and public shell.
    answer = await read(id, who, request, answer.body.next);
  }
  if (answer.status === 503) {
    expect(unavailable.Check(answer.body), JSON.stringify(answer.body)).toBe(true);
    expect(answer.headers.get('retry-after')).not.toBeNull();
    expect(answer.body).not.toHaveProperty('next');
    expect(answer.body).not.toHaveProperty('cursor');
    expect(answer.body).not.toHaveProperty('document');
  }
  return complete(answer); // Readiness and missing routes never count as a successful journey.
}

async function configure(id: string, revision: string, configuration: ZoneStarter, mounts: string[]) {
  const answer = await f.call(
    'owner',
    'PUT',
    `${path(id)}/configuration`,
    { configuration, mounts },
    f.conditional(revision),
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.zone.revision as string;
}

async function publish(id: string, revision: string) {
  const answer = await f.call(
    'owner',
    'POST',
    `${path(id)}:publish`,
    { visibility: 'public' },
    f.conditional(revision),
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.zone.revision as string;
}

async function subject(label: string, type = 'schema:Book') {
  const answer = await f.call('owner', 'POST', '/v1/subjects', { type, labels: { en: label } });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  const id = answer.body.subject.id as string;
  expect((await f.call('anonymous', 'GET', `/v1/subjects/${id}`)).status).toBe(200);
  return id;
}

async function collection(title: string, visibility: 'public' | 'private') {
  const answer = await f.call('owner', 'POST', '/v1/collections', { title, visibility });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.collection as { id: string; revision: number };
}

async function add(id: string, subjectId: string) {
  const answer = await f.call('owner', 'POST', `/v1/collections/${id}/members`, {
    subjectId,
    note: 'PRIVATE-SITE-OCCURRENCE',
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
}

async function sourceGrant(id: string, revoke = false) {
  const answer = await f.call('owner', 'POST', revoke ? '/v1/grants:revoke' : '/v1/grants', {
    resource: { route: routeOf(id)!, id },
    subject: { kind: 'account', id: f.accounts.editor },
    actions: ['collection:read'],
    valid: '(,)',
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(revoke ? 200 : 201);
}

async function concealed(id: string, who: Persona, subjectId: string) {
  const denied = await read(id, who, { target: { subject: subjectId } });
  const unknown = await read(id, who, { target: { subject: newId(0x7111) } });
  expect(denied.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(problem(denied.body)).toEqual(problem(unknown.body));
  expect(denied.body.code).toBe('not_found');
}

test('published routed Zone serves a common page and a currently eligible direct subject', async () => {
  const input = createBody();
  input.configuration.scope = [];
  input.configuration.pages = [{ route: '', document: page('Draft') }];
  const zone = await f.create(input);
  const configured = structuredClone(input.configuration);
  configured.pages = [
    { route: '', document: page('Site home', { density: 'compact' }) },
    { route: 'about', document: page('About this site') },
    { route: 'empty', document: { root: { props: {} }, content: [] } },
  ];
  let revision = await configure(zone.id, zone.revision, configured, []);
  revision = await publish(zone.id, revision);

  // First outcome is deliberately static: no Search or Collection readiness can excuse a missing page route.
  const home = complete(await read(zone.id, 'anonymous', { target: { route: '' }, languages: ['en'] }));
  expect(home.document).toEqual(configured.pages[0]!.document);
  expect(home.reads).toEqual({});
  expect(home.zone).toEqual({
    id: zone.id,
    revision,
    visibility: 'public',
    labels: configured.labels,
    appearance: { density: 'compact' },
    navigation: configured.pages.map(({ route }) => ({ route })),
  });
  for (const locale of UI_LOCALES) {
    const about = complete(await read(zone.id, 'anonymous', { target: { route: 'about' }, languages: [locale] }));
    expect(about.document).toEqual(configured.pages[1]!.document);
    expect(about.zone).toEqual(home.zone);
    expect(about.reads).toEqual({});
  }
  const empty = complete(await read(zone.id, 'anonymous', { target: { route: 'empty' } }));
  expect(empty.document).toEqual(configured.pages[2]!.document);
  expect(empty.reads).toEqual({});
  expect((await read(zone.id, 'anonymous', { target: { route: 'missing' } })).status).toBe(404);
  // Unusable but valid-shaped POST progress fresh-starts. GET cursor rules are owned elsewhere.
  expect(complete(await read(zone.id, 'anonymous', { target: { route: 'about' } }, 'unusable')).document).toEqual(
    configured.pages[1]!.document,
  );

  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'gate:collections');
  const left = await collection('Site left', 'public');
  const right = await collection('Site right', 'public');
  const first = await subject('Site first');
  const second = await subject('Site second');
  const outside = await subject('Readable outside the site', 'schema:Recipe');
  await add(left.id, second);
  await add(left.id, first);
  await add(left.id, first);
  await add(right.id, first);
  revision = await configure(zone.id, revision, configured, [right.id, left.id]);
  const browse = await f.call('anonymous', 'GET', `${path(zone.id)}/subjects?limit=100`);
  expect(browse.status, JSON.stringify(browse.body)).toBe(200);
  expect(browse.body.subjects.map((row: { id: string }) => row.id)).toEqual([first, second].sort());
  expect(browse.body.next).toBeNull();
  expect(JSON.stringify(browse.body)).not.toContain('PRIVATE-SITE-OCCURRENCE');
  const target = await resolved(zone.id, 'anonymous', { target: { subject: first }, languages: ['en'] });
  expect(target.subject).toBe(first);
  expect(target.views).toContain('overview');
  expect(target.zone.revision).toBe(revision);
  const native = await f.call('anonymous', 'GET', `/v1/subjects/${first}`);
  expect(native.status).toBe(200);
  expect(Object.values(target.reads)).toContainEqual({ status: 200, body: native.body });
  await concealed(zone.id, 'anonymous', outside);

  // A real released saved scope overlaps both curated sources; it adds no second catalogue builder.
  configured.scope = ['book/all'];
  revision = await configure(zone.id, revision, configured, [right.id, left.id]);
  const overlap = await f.call('anonymous', 'GET', `${path(zone.id)}/subjects?limit=100`);
  expect(overlap.status, JSON.stringify(overlap.body)).toBe(200);
  expect(overlap.body.subjects.map((row: { id: string }) => row.id)).toEqual([first, second].sort());
  expect(overlap.body.next).toBeNull();
  expect((await resolved(zone.id, 'anonymous', { target: { subject: second, view: 'overview' } })).subject).toBe(
    second,
  );
  await concealed(zone.id, 'anonymous', outside);
  // Removing every source makes direct access fail while the configured route remains a complete page.
  configured.scope = [];
  await configure(zone.id, revision, configured, []);
  await concealed(zone.id, 'anonymous', first);
  expect((await resolved(zone.id, 'anonymous', { target: { route: '' } })).document).toEqual(
    configured.pages[0]!.document,
  );
}, 180_000);

test('source restriction and cursor reauthorization never borrow private Collection or subject grants', async () => {
  for (const who of ['owner', 'editor'] as const)
    await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, who, 'gate:collections');
  const source = await collection('PRIVATE-SITE-SOURCE', 'private');
  const member = await subject('Private source public subject');
  await add(source.id, member);
  const input = createBody();
  input.configuration.scope = [];
  input.configuration.pages = [{ route: '', document: page('Public route, private source') }];
  input.mounts = [source.id];
  const zone = await f.create(input);
  let revision = await publish(zone.id, zone.revision);
  await f.grant(zone.id, 'editor', 'zone:read');

  // Owning/reading the Zone never lends the curator's private mount grant to this viewer.
  const route = complete(await read(zone.id, 'editor', { target: { route: '' } }));
  expect(route.document).toEqual(input.configuration.pages[0]!.document);
  expect(JSON.stringify(route)).not.toContain(source.id);
  expect(JSON.stringify(route)).not.toContain('PRIVATE-SITE-SOURCE');
  expect((await f.call('editor', 'GET', `/v1/collections/${source.id}`)).status).toBe(404);
  await concealed(zone.id, 'editor', member);
  expect((await resolved(zone.id, 'owner', { target: { subject: member } })).subject).toBe(member);
  await sourceGrant(source.id);
  expect((await f.call('editor', 'GET', `/v1/collections/${source.id}`)).status).toBe(200);
  expect((await resolved(zone.id, 'editor', { target: { subject: member } })).subject).toBe(member);

  // Revocation is authoritative before any ordinary projection is advanced by this suite.
  await sourceGrant(source.id, true);
  expect((await f.call('editor', 'GET', `/v1/collections/${source.id}`)).status).toBe(404);
  const continued = await read(zone.id, 'editor', { target: { subject: member } }, 'unusable');
  expect(continued.status).toBe(404);
  expect(continued.body.code).toBe('not_found');
  await concealed(zone.id, 'editor', member);
  expect((await resolved(zone.id, 'editor', { target: { route: '' } }, 'unusable')).document).toEqual(
    input.configuration.pages[0]!.document,
  );

  await sourceGrant(source.id);
  revision = await configure(zone.id, revision, input.configuration, []);
  await concealed(zone.id, 'editor', member);
  expect((await f.call('editor', 'GET', `/v1/subjects/${member}`)).status).toBe(200);
  expect((await resolved(zone.id, 'editor', { target: { route: '' } })).zone.revision).toBe(revision);
  const empty = await f.call('editor', 'GET', `${path(zone.id)}/subjects?limit=1`);
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  expect(empty.body).toEqual({ subjects: [], next: null });
}, 180_000);

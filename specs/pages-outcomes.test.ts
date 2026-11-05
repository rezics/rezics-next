import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HttpResponse, PagesDriver, Persona } from './pages-driver';
import type { Labels, StatementInput, Subject } from './semantic-driver';

setDefaultTimeout(60_000);
let driver: PagesDriver;
beforeEach(async () => {
  const location = process.env.PAGES_DRIVER;
  if (!location) throw new Error('Pages outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('PAGES_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('PAGES_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createPagesDriver !== 'function') throw new Error('Expected createPagesDriver factory');
  driver = await binding.createPagesDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});

const PROFILE_FORMAT = 'https://rezics.com/presentation/profile/1';
const DATA_COMPONENTS = new Set(['SubjectHeader', 'Statements', 'MoreStatements', 'SubjectList']);
const SUBJECT_READS = new Set(['SubjectHeader', 'Statements', 'MoreStatements']);
const VIEW_NAMES = [
  'overview',
  'editions',
  'contents',
  'characters',
  'appearances',
  'credits',
  'works',
  'relations',
  'posts',
  'reviews',
  'discussion',
  'lists',
  'collections',
  'details',
] as const;
type ViewName = (typeof VIEW_NAMES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface ComponentProps {
  id: string;
  text?: string;
  level?: 2 | 3 | 4;
  properties?: string[];
  title?: string;
  property?: string;
  limit?: number;
}
interface Component {
  type: string;
  props: ComponentProps;
}
interface Composition {
  root: { props: Record<string, never> };
  content: Component[];
}
type ViewDocuments = { overview: Composition } & { [Name in Exclude<ViewName, 'overview'>]?: Composition };
type Documents = { document: Composition; views?: undefined } | { views: ViewDocuments; document?: undefined };
type TypeTemplate = { type: string } & Documents;
type BaseTemplate = { base: string } & Documents;
type RouteTemplate = { route: string } & Documents;
type GenericTemplate = Composition | { views: ViewDocuments };
interface Profile {
  format: typeof PROFILE_FORMAT;
  generic: GenericTemplate;
  bases: BaseTemplate[];
  types: TypeTemplate[];
  routes: RouteTemplate[];
}
interface TemplateName {
  scope: 'route' | 'type' | 'base' | 'generic';
  key: string | null;
}
interface ReadValue {
  status: number;
  body: Record<string, unknown>;
}
interface PageBody {
  subject?: string;
  profile: string;
  template: TemplateName;
  document: Composition;
  views?: ViewName[];
  reads: Record<string, ReadValue>;
}

const key = () => `"${randomUUID()}"`;
const subjectPath = (id: string) => `/v1/subjects/${id}`;
const get = (path: string, persona: Persona = 'anonymous') => driver.request(persona, 'GET', path);
const write = (persona: Persona, path: string, body: unknown, token = key()) =>
  driver.request(persona, 'POST', path, body, { 'Idempotency-Key': token });
const readPage = (target: { subject: string } | { route: string }, persona: Persona = 'anonymous') =>
  driver.request(persona, 'POST', '/v1/pages:read', { target });
const publish = (persona: Persona, profile: Profile, token = key()) =>
  write(persona, '/v1/presentation/profiles', { profile }, token);
const activate = (persona: Persona, digest: string, expectedHead: number, token = key()) =>
  write(persona, `/v1/presentation/profiles/${digest}:activate`, { expected_head: expectedHead }, token);
const statement = (property: string, content: string): StatementInput => ({
  property: { id: property },
  value: { type: 'value', content },
  rank: 'normal',
});
const heading = (id: string, text: string, level: 2 | 3 | 4 = 2): Component => ({
  type: 'Heading',
  props: { id, text, level },
});
const document = (content: Component[]): Composition => ({ root: { props: {} }, content });
function profile(
  parts: { generic?: GenericTemplate; bases?: BaseTemplate[]; types?: TypeTemplate[]; routes?: RouteTemplate[] } = {},
): Profile {
  return {
    format: PROFILE_FORMAT,
    generic: parts.generic ?? document([heading('generic-title', 'Catalogue')]),
    bases: parts.bases ?? [],
    types: parts.types ?? [],
    routes: parts.routes ?? [],
  };
}
function problem(response: HttpResponse, status: number, code: string, writeRequest = true) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({
    type: `https://rezics.com/problems/${code}`,
    status,
    code,
    title: expect.any(String),
    request_id: expect.any(String),
    effect_status: writeRequest ? 'not_applied' : 'not_applicable',
    retryable: expect.any(Boolean),
  });
}
function field(response: HttpResponse, pointer: string, code: string, writeRequest = true) {
  problem(response, 400, 'invalid_request', writeRequest);
  expect(response.body.errors).toEqual(expect.arrayContaining([{ pointer, code }]));
}
function stable(response: HttpResponse, status: number, code: string, writeRequest = true) {
  problem(response, status, code, writeRequest);
  const { request_id: _requestId, ...rest } = response.body;
  return rest;
}
function unknownDigest(digest: string) {
  expect(digest.length).toBeGreaterThan(1);
  return `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
}
async function active() {
  const response = await get('/v1/presentation/active');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(Object.keys(response.body).sort()).toEqual(['digest', 'head']);
  const pointer = response.body as { digest: string; head: number };
  expect(pointer.digest).toEqual(expect.any(String));
  expect(pointer.digest.length).toBeGreaterThan(0);
  expect(Number.isInteger(pointer.head)).toBe(true);
  return pointer;
}
function expectComposition(value: Composition) {
  expect(Object.keys(value).sort()).toEqual(['content', 'root']);
  expect(Object.keys(value.root).sort()).toEqual(['props']);
  expect(value.root.props).toEqual(expect.any(Object));
  expect(Array.isArray(value.content)).toBe(true);
  for (const item of value.content) {
    expect(item).toEqual({ type: expect.any(String), props: expect.objectContaining({ id: expect.any(String) }) });
  }
}
function expectViews(value: ViewDocuments) {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  const names = Object.keys(value);
  expect(names).toContain('overview');
  for (const name of names) {
    expect(VIEW_NAMES as readonly string[]).toContain(name);
    expectComposition(value[name as ViewName]!);
  }
}
function expectEntries<Key extends string>(items: ({ [Name in Key]: string } & Documents)[], fieldName: Key) {
  expect(Array.isArray(items)).toBe(true);
  const values = items.map((item) => {
    if ('views' in item && item.views !== undefined) {
      expect(Object.keys(item).sort()).toEqual([fieldName, 'views'].sort());
      expectViews(item.views);
    } else {
      expect(Object.keys(item).sort()).toEqual([fieldName, 'document'].sort());
      expectComposition(item.document!);
    }
    expect(typeof item[fieldName]).toBe('string');
    return item[fieldName];
  });
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  expect(values).toEqual(sorted);
  expect(new Set(values).size).toBe(values.length);
}
function expectProfile(value: Profile) {
  expect(Object.keys(value).sort()).toEqual(['bases', 'format', 'generic', 'routes', 'types']);
  expect(value.format).toBe(PROFILE_FORMAT);
  if ('views' in value.generic) {
    expect(Object.keys(value.generic)).toEqual(['views']);
    expectViews(value.generic.views);
  } else expectComposition(value.generic);
  expectEntries(value.bases, 'base');
  expectEntries(value.types, 'type');
  expectEntries(value.routes, 'route');
}
async function fetchProfile(digest: string) {
  const response = await get(`/v1/presentation/profiles/${digest}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('etag')).toBe(`"${digest}"`);
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  const stored = response.body.profile as Profile;
  expect(response.body).toEqual({ digest, profile: stored });
  expectProfile(stored);
  return stored;
}
function overview(found: GenericTemplate | Documents): Composition {
  if ('views' in found && found.views !== undefined) return found.views.overview;
  if ('document' in found && found.document !== undefined) return found.document;
  return found as Composition;
}
function templateDocument(stored: Profile, template: TemplateName): Composition {
  if (template.scope === 'generic') {
    expect(template.key).toBeNull();
    return overview(stored.generic);
  }
  const keyName = template.key;
  expect(typeof keyName).toBe('string');
  const found =
    template.scope === 'type'
      ? stored.types.find((item) => item.type === keyName)
      : template.scope === 'base'
        ? stored.bases.find((item) => item.base === keyName)
        : stored.routes.find((item) => item.route === keyName);
  if (!found) throw new Error(`Missing ${template.scope} template ${keyName}`);
  return overview(found);
}
function components(value: unknown, found: Component[] = []): Component[] {
  if (Array.isArray(value)) {
    for (const item of value) components(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const record = value as Record<string, unknown>;
  if (typeof record.type === 'string' && record.props && typeof record.props === 'object')
    found.push(record as unknown as Component);
  for (const child of Object.values(record)) components(child, found);
  return found;
}
function subjectReadId(entryKey: string, body: unknown) {
  const path = /^\/v1\/subjects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(entryKey);
  const embedded =
    body && typeof body === 'object' && body !== null && 'subject' in body
      ? (body as { subject?: { id?: unknown } }).subject?.id
      : undefined;
  const fromBody = typeof embedded === 'string' && UUID.test(embedded) ? embedded : null;
  if (path?.[1] && fromBody) expect(fromBody.toLowerCase()).toBe(path[1].toLowerCase());
  return path?.[1] ?? fromBody;
}
async function expectReads(reads: Record<string, ReadValue>, persona: Persona) {
  expect(reads).toEqual(expect.any(Object));
  expect(Array.isArray(reads)).toBe(false);
  for (const [entryKey, read] of Object.entries(reads)) {
    expect(read).toEqual({ status: expect.any(Number), body: expect.anything() });
    const id = subjectReadId(entryKey, read.body);
    if (!id) continue;
    const standalone = await get(subjectPath(id), persona);
    expect(read.status).toBe(standalone.status);
    expect(read.body).toEqual(standalone.body);
  }
}
async function expectAggregate(
  composition: Composition,
  reads: Record<string, ReadValue>,
  persona: Persona,
  subjectId?: string,
) {
  const present = components(composition.content);
  if (!present.some((item) => DATA_COMPONENTS.has(item.type))) {
    expect(reads).toEqual({});
    return;
  }
  await expectReads(reads, persona);
  if (!subjectId || !present.some((item) => SUBJECT_READS.has(item.type))) return;
  const standalone = await get(subjectPath(subjectId), persona);
  expect(standalone.status).toBe(200);
  expect(
    Object.values(reads).some(
      (read) => read.status === standalone.status && subjectReadId('', read.body) === subjectId,
    ),
  ).toBe(true);
}
function page(response: HttpResponse, kind: 'subject' | 'route') {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = response.body as unknown as PageBody;
  expect(Object.keys(body).sort()).toEqual(
    kind === 'subject'
      ? ['document', 'profile', 'reads', 'subject', 'template', 'views']
      : ['document', 'profile', 'reads', 'template'],
  );
  expect(Object.keys(body.template).sort()).toEqual(['key', 'scope']);
  expect(body.template.scope).toMatch(/^(route|type|base|generic)$/);
  if (body.template.scope === 'generic') expect(body.template.key).toBeNull();
  else expect(body.template.key).toEqual(expect.any(String));
  expect(body.profile).toEqual(expect.any(String));
  if (kind === 'subject') {
    expect(body.subject).toEqual(expect.any(String));
    const names = body.views as string[];
    expect(Array.isArray(names)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(VIEW_NAMES as readonly string[]).toContain(name);
    expect(names).toContain('overview');
    expect(names).toEqual(VIEW_NAMES.filter((name) => names.includes(name)));
  }
  return body;
}
async function create(type: string, labels: Labels, statements: Record<string, StatementInput[]> = {}) {
  const response = await write('editor', '/v1/subjects', { type, labels, statements });
  expect(response.status).toBe(201);
  const subject = response.body.subject as Subject;
  expect(response.headers.get('location')).toBe(subjectPath(subject.id));
  expect(response.headers.get('etag')).toBe('"1"');
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  expect(subject.type).toBe(type);
  expect(subject.labels).toEqual(labels);
  return subject;
}
function publishedDigest(response: HttpResponse, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.body).toEqual({ digest: expect.any(String) });
  return response.body.digest as string;
}
function sortedErrors(response: HttpResponse) {
  const errors = response.body.errors as { pointer: string; code: string }[];
  expect(Array.isArray(errors)).toBe(true);
  return [...errors].sort((left, right) => (left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0));
}

test("anonymous reads a public subject's page in one aggregate read", async () => {
  const author = await create('schema:Person', { en: 'Natsume Sōseki' });
  const book = await create(
    'schema:Book',
    { en: 'Kokoro', ja: 'こころ' },
    {
      'schema:author': [statement('schema:author', author.id)],
    },
  );
  expect(book.statements['schema:author']).toEqual([
    expect.objectContaining({ value: { type: 'value', content: author.id } }),
  ]);
  const pointer = await active();
  const stored = await fetchProfile(pointer.digest);
  const result = page(await readPage({ subject: book.id }), 'subject');
  expect(result.subject).toBe(book.id);
  expect(result.profile).toBe(pointer.digest);
  if (stored.types.some((item) => item.type === book.type))
    expect(result.template).toEqual({ scope: 'type', key: book.type });
  expect(result.document).toEqual(templateDocument(stored, result.template));
  await expectAggregate(result.document, result.reads, 'anonymous', book.id);
});

test('an unknown, a hidden and a taken-down subject answer the same not_found', async () => {
  const hidden = await create('schema:Book', { en: 'Hidden catalogue' });
  const taken = await create('schema:Book', { en: 'Withdrawn catalogue' });
  expect((await get(subjectPath(hidden.id))).status).toBe(200);
  expect((await get(subjectPath(taken.id))).status).toBe(200);
  await driver.remove(hidden.id, 'hidden');
  await driver.remove(taken.id, 'taken_down');
  const missing = Bun.randomUUIDv7();
  for (const persona of ['anonymous', 'editor'] as const) {
    const bodies = [
      await readPage({ subject: missing }, persona),
      await readPage({ subject: hidden.id }, persona),
      await readPage({ subject: taken.id }, persona),
      await get(subjectPath(missing), persona),
      await get(subjectPath(hidden.id), persona),
      await get(subjectPath(taken.id), persona),
    ].map((response) => stable(response, 404, 'not_found', false));
    const expected = bodies[0];
    if (!expected) throw new Error('Missing not_found problem');
    for (const body of bodies) expect(body).toEqual(expected);
  }
});

test('publishing a profile needs the presentation grant', async () => {
  const before = await active();
  const submitted = profile({
    generic: document([
      {
        type: 'SubjectList',
        props: { id: 'authors', title: 'Authors', property: 'schema:author', limit: 24 },
      },
    ]),
  });
  problem(await publish('anonymous', submitted), 401, 'authentication_required');
  problem(await publish('editor', submitted), 403, 'forbidden');
  const suspendedPublish = await publish('suspended', submitted);
  const suspendedCreate = await write('suspended', '/v1/subjects', { type: 'schema:Book', labels: { en: 'Denied' } });
  expect(suspendedPublish.status).toBe(401);
  expect(suspendedPublish.status).toBe(suspendedCreate.status);
  problem(suspendedPublish, 401, 'invalid_credentials');
  problem(suspendedCreate, 401, 'invalid_credentials');
  expect(suspendedPublish.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect(suspendedCreate.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect(await active()).toEqual(before);
  const digest = publishedDigest(await publish('curator', submitted), 201);
  expect(digest).not.toBe(before.digest);
  expect(publishedDigest(await publish('curator', submitted), 200)).toBe(digest);
  expect(await fetchProfile(digest)).toEqual(submitted);
  problem(await get(`/v1/presentation/profiles/${unknownDigest(digest)}`), 404, 'not_found', false);
  expect(await active()).toEqual(before);
});

test('activating a profile changes the template a page uses', async () => {
  const author = await create('schema:Person', { en: 'Natsume Sōseki' });
  const book = await create(
    'schema:Book',
    { en: 'Kokoro' },
    {
      'schema:author': [statement('schema:author', author.id)],
    },
  );
  const other = await create('schema:Organization', { en: 'Aozora' });
  const bookDocument = document([
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Statements', props: { id: 'statements', properties: ['schema:author'] } },
  ]);
  const generic = document([heading('generic-title', 'Everything else')]);
  const submitted = profile({ generic, types: [{ type: 'schema:Book', document: bookDocument }] });
  const before = await active();
  const digest = publishedDigest(await publish('curator', submitted), 201);
  expect(digest).not.toBe(before.digest);
  const pending = page(await readPage({ subject: book.id }), 'subject');
  expect(pending.profile).toBe(before.digest);
  const activated = await activate('curator', digest, before.head);
  expect(activated.status).toBe(200);
  expect(activated.headers.get('content-type')).toContain('application/json');
  expect(activated.body).toEqual({ digest, head: before.head + 1 });
  expect(await active()).toEqual({ digest, head: before.head + 1 });
  const stored = await fetchProfile(digest);
  const bookPage = page(await readPage({ subject: book.id }), 'subject');
  expect(bookPage.subject).toBe(book.id);
  expect(bookPage.profile).toBe(digest);
  expect(bookPage.template).toEqual({ scope: 'type', key: 'schema:Book' });
  expect(bookPage.document).toEqual(bookDocument);
  expect(bookPage.document).toEqual(templateDocument(stored, bookPage.template));
  await expectAggregate(bookPage.document, bookPage.reads, 'anonymous', book.id);
  const otherPage = page(await readPage({ subject: other.id }), 'subject');
  expect(otherPage.subject).toBe(other.id);
  expect(otherPage.profile).toBe(digest);
  expect(otherPage.template.scope).not.toBe('type');
  expect(otherPage.template).toEqual({ scope: 'generic', key: null });
  expect(otherPage.document).toEqual(generic);
  problem(await activate('curator', digest, before.head), 409, 'stale_editorial_head');
  problem(await activate('anonymous', digest, before.head + 1), 401, 'authentication_required');
  problem(await activate('editor', digest, before.head + 1), 403, 'forbidden');
  problem(await activate('curator', unknownDigest(digest), before.head + 1), 404, 'not_found');
  expect(await active()).toEqual({ digest, head: before.head + 1 });
});

test('a profile with HTML, script or an executable link is refused with pointers', async () => {
  const before = await active();
  const refused = await publish(
    'curator',
    profile({
      generic: document([{ type: 'Script', props: { id: 'script' } }]),
      types: [
        {
          type: 'schema:Book',
          document: document([
            { type: 'Text', props: { id: 'text', text: '<script>alert(1)</script>' } },
            heading('heading', '<b>x</b>'),
          ]),
        },
      ],
    }),
  );
  problem(refused, 400, 'invalid_request');
  expect(sortedErrors(refused)).toEqual([
    { pointer: '/profile/generic/content/0/type', code: 'unsupported' },
    { pointer: '/profile/types/0/document/content/0/props/text', code: 'invalid_format' },
    { pointer: '/profile/types/0/document/content/1/props/text', code: 'invalid_format' },
  ]);
  const limit = await publish(
    'curator',
    profile({
      generic: document([
        {
          type: 'SubjectList',
          props: { id: 'related', title: 'Authors', property: 'schema:author', limit: 25 },
        },
      ]),
    }),
  );
  problem(limit, 400, 'invalid_request');
  expect(sortedErrors(limit)).toEqual([{ pointer: '/profile/generic/content/0/props/limit', code: 'out_of_range' }]);
  expect(await active()).toEqual(before);
});

test('a route template answers a route target and other routes fall back to generic', async () => {
  const home = document([heading('home-title', 'Home')]);
  const fallback = document([heading('fallback-title', 'Fallback')]);
  const submitted = profile({ generic: fallback, routes: [{ route: '/', document: home }] });
  const before = await active();
  const digest = publishedDigest(await publish('curator', submitted), 201);
  const activated = await activate('curator', digest, before.head);
  expect(activated.status).toBe(200);
  expect(activated.body).toEqual({ digest, head: before.head + 1 });
  const stored = await fetchProfile(digest);
  const homePage = page(await readPage({ route: '/' }), 'route');
  expect(homePage.profile).toBe(digest);
  expect(homePage.template).toEqual({ scope: 'route', key: '/' });
  expect(homePage.document).toEqual(home);
  expect(homePage.document).toEqual(templateDocument(stored, homePage.template));
  expect(homePage.subject).toBeUndefined();
  await expectAggregate(homePage.document, homePage.reads, 'anonymous');
  const unknown = page(await readPage({ route: '/unknown' }), 'route');
  expect(unknown.profile).toBe(digest);
  expect(unknown.template).toEqual({ scope: 'generic', key: null });
  expect(unknown.document).toEqual(fallback);
  expect(unknown.document).toEqual(templateDocument(stored, unknown.template));
  expect(unknown.subject).toBeUndefined();
  await expectAggregate(unknown.document, unknown.reads, 'anonymous');
  field(await readPage({ route: '//x' }), '/target/route', 'invalid_format', false);
});

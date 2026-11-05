import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  PROFILE_FORMAT,
  planReads,
  platformRegistry,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { Actor } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { decodeSession, type SessionComponent } from '../../src/tokens/session.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';

// One existing native fixture, one graph and one kernel. Observers only delegate;
// no permission, opaque time, evidence, response or registry is manufactured.
type Account = Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
type Realm = { realmId: string; contextId: string; title: string; headRevisionId: string };
type Observation = {
  path: string;
  headers: Headers;
  status: number;
  responseHeaders: Headers;
  body?: unknown;
};
type Capture = {
  requests: Observation[];
  decisions: { action: string; id: string; actor: Actor }[];
  deadlines: number[];
  pause?: { realm: string; observed: () => void; release: Promise<void>; used: boolean };
  selectedPause?: { subject: string; context: string; observed: () => void; release: Promise<void>; used: boolean };
};
const capture = new AsyncLocalStorage<Capture>();
const SESSION = 'rezics-session-token';
const key = () => ({ 'Idempotency-Key': JSON.stringify(randomUUID()) });
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    node('SubjectHeader', 'header'),
    node('MoreStatements', 'facts'),
    node('Sources', 'sources'),
    node('SubjectList', 'editions', { title: { en: 'Editions' }, property: 'schema:exampleOfWork', limit: 6 }),
    node('SubjectList', 'editions-again', {
      title: { en: 'Same editions' },
      property: 'schema:exampleOfWork',
      limit: 6,
    }),
  ],
};
const profile: PresentationProfile = { format: PROFILE_FORMAT, generic: document, types: [], bases: [], routes: [] };
let driver: SemanticOutcomeDriver;
let app: ReturnType<typeof createKernel>;
let ring: KeyRing;
let publisher: Account;
let reader: Account;
let outsider: Account;
let unscoped: Account;
let contextA: string;
let contextB: string;
let book: string;
let author: string;
let edition: string;
let pen: string;
let privateCandidate: string;
let privateRelated: string;
let realm: Realm;
let digest: string;
const localA = 'https://example.test/selected-context-a';
const localB = 'https://example.test/selected-context-b';

function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
}
function record(value: unknown): Record<string, any> {
  expect(value).toBeObject();
  return value as Record<string, any>;
}
function stable(body: Record<string, unknown>) {
  const { request_id: _request, instance: _instance, ...rest } = body;
  return rest;
}
function statement(property: string, content: unknown) {
  return { property: { id: property }, value: { type: 'value', content } };
}
function send(
  account: Account | null,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return driver.fixtures.send(account, method, path, body, headers);
}
async function write(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return send(publisher, 'POST', path, body, { ...key(), ...headers });
}
async function createSubject(type: string, label: string, statements: Record<string, unknown[]> = {}) {
  const created = await write('/v1/subjects', { type, labels: { en: label }, statements });
  status(created, 201);
  return record(created.body.subject);
}
async function context(label: string) {
  const created = await write('/v1/contexts', { labels: { en: label } });
  status(created, 201);
  const id = record(created.body.context).id as string;
  status(await send(reader, 'GET', `/v1/contexts/${id}`), 200);
  return id;
}
async function grant(account: Account, resource: string, actions: string[]) {
  const granted = await write('/v1/grants', {
    resource: { route: routeOf(resource)!, id: resource },
    subject: { kind: 'account', id: account.accountId },
    actions,
    valid: '(,)',
  });
  status(granted, 201);
}
async function makeRealm(contextId = contextA, visibility = 'protected'): Promise<Realm> {
  const space = await write('/v1/spaces', { title: 'Native Realm page host' });
  status(space, 201);
  const created = await write('/v1/realms', {
    spaceId: record(space.body.space).spaceId,
    title: 'Actual protected editorial Realm',
    visibility,
    contextId,
  });
  status(created, 201);
  const result = record(created.body.realm) as Realm;
  await grant(reader, result.realmId, ['realm:read']);
  await grant(unscoped, result.realmId, ['realm:read']);
  const readable = await send(reader, 'GET', `/v1/realms/${result.realmId}`);
  status(readable, 200);
  expect(readable.body.realm).toEqual(created.body.realm);
  return result;
}
async function publish(target: Realm, subject = book) {
  const result = await write(`/v1/realms/${target.realmId}/publications`, { subjectId: subject });
  status(result, 201);
  const current = await send(reader, 'GET', `/v1/realms/${target.realmId}/publications/${subject}`);
  status(current, 200);
  expect(current.body).toEqual(result.body);
  return record(result.body.publication).publicationId as string;
}
async function patchRealm(target: Realm, body: unknown): Promise<Realm> {
  // The existing Semantic send helper has no PATCH method. Use its same composed
  // kernel boundary and genuinely issued bearer, without changing the helper.
  const response = await app.handle(
    new Request(`http://kernel.test/v1/realms/${target.realmId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${publisher.bearer}`,
        'content-type': 'application/json',
        ...key(),
        'if-match': JSON.stringify(target.headRevisionId),
      },
      body: JSON.stringify(body),
    }),
  );
  const result = { status: response.status, headers: response.headers, body: await response.json() } as HttpResponse;
  status(result, 200);
  return record(result.body.realm) as Realm;
}
async function adopt(
  id: string,
  selected: string,
  property: string,
  mode: 'replace' | 'suppress',
  candidate?: string,
  target?: string,
) {
  if (candidate)
    status(
      await write(`/v1/subjects/${id}/candidates/${candidate}:accept`, {
        context: selected,
        expected_head: null,
      }),
      200,
    );
  status(
    await write(`/v1/subjects/${id}:adopt`, {
      context: selected,
      property,
      ...(target === undefined ? {} : { target }),
      mode,
      selection: candidate ? [{ candidate, rank: 'normal' }] : [],
      expected_head: null,
    }),
    200,
  );
}
async function selectedSubject(id: string, selected: string, account: Account | null = reader) {
  const response = await send(account, 'GET', `/v1/subjects/${id}?context=${selected}`);
  status(response, 200);
  expect(record(response.body.subject).context).toBe(selected);
  return response;
}
function plan(id: string) {
  // Only locate node keys. Expected Contexts and real wire observations below
  // are independent of the planner, which currently omits Context entirely.
  return planReads(platformRegistry, document, { subject: id, account: null });
}
function embedded(response: HttpResponse, id = book) {
  const reads = record(response.body.reads);
  const keys = plan(id).nodes;
  expect(keys.header).toBe(keys.facts);
  expect(keys.header).toBe(keys.sources);
  expect(keys.editions).toBe(keys['editions-again']);
  expect(Object.keys(reads)).toHaveLength(2);
  const subject = record(reads[keys.header!]);
  const links = record(reads[keys.editions!]);
  expect(subject.status).toBe(200);
  expect(links.status).toBe(200);
  return { subject: record(subject.body), links: record(links.body) };
}
function metadata(response: HttpResponse, selected: string, population: unknown) {
  expect(response.body.context).toEqual({ id: selected, population });
  expect(record(embedded(response, response.body.subject as string).subject.subject).context).toBe(selected);
}
function components(response: HttpResponse, account: Account | null): SessionComponent[] {
  const token = response.headers.get(SESSION);
  expect(token).toBeString();
  const decoded = decodeSession(ring, account ? `account:${account.accountId}` : 'anonymous', token!);
  expect(decoded).toBeDefined();
  return decoded!;
}
function preserves(actual: SessionComponent[], required: SessionComponent[]) {
  for (const source of required) {
    const found = actual.find(({ partition }) => partition === source.partition);
    expect(found, `missing native session partition ${source.partition}`).toBeDefined();
    expect(found!.epoch).toBeGreaterThanOrEqual(source.epoch);
    if (found!.epoch === source.epoch) expect(found!.position >= source.position).toBe(true);
  }
}
const page = (
  account: Account | null = reader,
  target: unknown = { subject: book, realm: realm.realmId },
  headers?: Record<string, string>,
) => send(account, 'POST', '/v1/pages:read', { target, languages: ['en'] }, headers);
const observed = (): Capture => ({ requests: [], decisions: [], deadlines: [] });

beforeAll(async () => {
  driver = await createSemanticDriver((config) => {
    ring = config.tokens!;
    const nativeFactory = config.access;
    if (typeof nativeFactory !== 'function') throw new Error('Semantic fixture must compose its real Access factory');
    app = createKernel({
      ...config,
      // Use the existing native limiter's documented fixture override, as the
      // Community publication/Realm native suites do for multi-scenario writes.
      writeRate: createWriteRateLimiter({
        secret: 'realm-page-native-write-rate-secret-with-32-bytes',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
      }),
      access(accessConfig) {
        const native = nativeFactory(accessConfig);
        return deriveAccess(native, {
          async prepare(actor, action, resource, boundary) {
            capture.getStore()?.deadlines.push(boundary.deadline);
            return native.prepare?.(actor, action, resource, boundary);
          },
          async authorize(client, actor, action, resource, evidence, time) {
            const allowed = await native.authorize(client, actor, action, resource, evidence, time);
            const seen = capture.getStore();
            seen?.decisions.push({ action, id: resource.id, actor });
            const pause = seen?.pause;
            if (pause && !pause.used && action === 'realm:read' && resource.id === pause.realm) {
              pause.used = true;
              pause.observed();
              await pause.release;
            }
            return allowed;
          },
        });
      },
    });
    app.wrap((handle) => async (request: Request) => {
      const seen = capture.getStore();
      if (!seen) return handle(request);
      const path = new URL(request.url).pathname + new URL(request.url).search;
      const headers = new Headers(request.headers);
      const response = await handle(request);
      const selected = seen.selectedPause;
      const url = new URL(request.url);
      const selectedRead =
        selected &&
        url.searchParams.get('context') === selected.context &&
        (url.pathname === `/v1/subjects/${selected.subject}` ||
          url.pathname === `/v1/subjects/${selected.subject}/links`);
      seen.requests.push({
        path,
        headers,
        status: response.status,
        responseHeaders: new Headers(response.headers),
        ...(selectedRead ? { body: await response.clone().json() } : {}),
      });
      // Record real responses first. The subject probe must return so planning can
      // start links; only hold the completed links response on its way back.
      if (selectedRead && url.pathname.endsWith('/links') && !selected.used) {
        selected.used = true;
        selected.observed();
        await selected.release;
      }
      return response;
    });
    return app;
  });
  publisher = await driver.fixtures.person('editor');
  reader = await driver.fixtures.person('realm_page_reader');
  outsider = await driver.fixtures.person('realm_page_outsider');
  unscoped = await driver.fixtures.person('realm_page_unscoped', { scopes: ['presentation:read', 'realm:read'] });
  await driver.fixtures.grantAccount(publisher, [
    'space:create',
    'realm:create',
    'presentation:publish',
    'presentation:activate',
    'moderation:hide',
  ]);
  contextA = await context('Native Context A');
  contextB = await context('Native Context B');
  author = (await createSubject('schema:Person', 'Public author')).id;
  const created = await createSubject('schema:Book', 'Shared Realm book', {
    'schema:author': [statement('schema:author', author)],
    'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    'schema:url': [statement('schema:url', 'https://example.test/global')],
  });
  book = created.id;
  edition = (
    await createSubject('bf:Instance', 'Shared edition', {
      'schema:exampleOfWork': [statement('schema:exampleOfWork', book)],
    })
  ).id;
  for (const [selected, content] of [
    [contextA, localA],
    [contextB, localB],
  ] as const) {
    const proposed = await write(`/v1/subjects/${book}/candidates`, {
      statement: {
        ...statement('schema:url', content),
        references: [{ parts: [statement('schema:url', 'https://example.test/editorial-reference')] }],
      },
    });
    status(proposed, 201);
    await adopt(book, selected, 'schema:url', 'replace', proposed.body.candidate as string);
  }
  await adopt(book, contextA, 'schema:author', 'suppress', undefined, author);
  await adopt(edition, contextA, 'schema:exampleOfWork', 'suppress', undefined, book);
  const agent = await ensureAccountAgent(driver.fixtures.pool, {
    account: publisher.accountId,
    kind: 'person',
    name: 'Native publisher identity',
  });
  privateRelated = agent.subject.id;
  const privateSubject = await createSubject('schema:Person', 'Public pen name', {
    'rezics:penNameOf': [{ ...statement('rezics:penNameOf', privateRelated), references: [], qualifiers: [] }],
  });
  pen = privateSubject.id;
  privateCandidate = privateSubject.statements['rezics:penNameOf'][0].id;
  realm = await makeRealm();
  await publish(realm);
  await publish(realm, pen);
  const active = await send(null, 'GET', '/v1/presentation/active');
  status(active, 200);
  const published = await write('/v1/presentation/profiles', { profile });
  status(published, 201);
  digest = published.body.digest as string;
  status(await write(`/v1/presentation/profiles/${digest}:activate`, { expected_head: active.body.head }), 200);

  // Genuine standalone controls establish the expected facts before any page red.
  const global = record((await selectedSubject(book, GLOBAL_CONTEXT)).body.subject);
  const a = record((await selectedSubject(book, contextA)).body.subject);
  const b = record((await selectedSubject(book, contextB)).body.subject);
  expect(a.statements['schema:inLanguage']).toEqual(global.statements['schema:inLanguage']);
  expect(a.statements['schema:author'] ?? []).toEqual([]);
  expect(a.resolution['schema:author']).toBe('suppressed');
  expect(JSON.stringify(a)).toContain(localA);
  expect(JSON.stringify(a)).not.toContain(localB);
  expect(JSON.stringify(b)).toContain(localB);
  expect(b.statements['schema:author']).toEqual(global.statements['schema:author']);
  const editionRead = await selectedSubject(edition, GLOBAL_CONTEXT);
  const inheritedLinks = await send(
    reader,
    'GET',
    `/v1/subjects/${book}/links?context=${contextB}&property=schema%3AexampleOfWork&limit=6`,
    undefined,
    { [SESSION]: editionRead.headers.get(SESSION)! },
  );
  status(inheritedLinks, 200);
  expect(JSON.stringify(inheritedLinks.body.links)).toContain(edition);
}, 180_000);
afterAll(async () => {
  await driver?.close();
});

test('Realm subject page selects only the current authorized published Context with unchanged caller and public candidate audience', async () => {
  const native = await selectedSubject(book, contextA);
  const incoming = native.headers.get(SESSION)!;
  const seen = observed();
  const response = await capture.run(seen, () =>
    page(reader, undefined, {
      [SESSION]: incoming,
      cookie: 'must-not-forward=1',
      'x-forwarded-for': '203.0.113.9',
    }),
  );
  // First native expected200: missing target.realm must fail here, never become
  // a passing missing-driver assertion or an expected validation failure.
  status(response, 200);
  expect(response.body.subject).toBe(book);
  expect(response.body.profile).toBe(digest);
  metadata(response, contextA, { kind: 'realm', id: realm.realmId, title: realm.title });
  const result = embedded(response);
  expect(result.subject.subject).toEqual(native.body.subject);
  const links = await send(
    reader,
    'GET',
    `/v1/subjects/${book}/links?context=${contextA}&property=schema%3AexampleOfWork&limit=6`,
  );
  status(links, 200);
  expect(result.links.links).toEqual(links.body.links);
  expect(result.links.count).toEqual(links.body.count);
  expect(JSON.stringify(result.links)).not.toContain(edition);
  const reads = seen.requests.filter(({ path }) => path.startsWith(`/v1/subjects/${book}`));
  expect(reads).toHaveLength(2); // probe reused, repeated subject and links nodes deduplicated
  for (const read of reads) {
    expect(new URL(read.path, 'http://kernel.test').searchParams.get('context')).toBe(contextA);
    expect(read.headers.get('authorization')).toBe(`Bearer ${reader.bearer}`);
    expect(read.headers.get(SESSION)).toBe(incoming);
    expect(read.headers.get('cookie')).toBeNull();
    expect(read.headers.get('x-forwarded-for')).toBeNull();
    if (read.responseHeaders.has(SESSION))
      preserves(
        components(response, reader),
        components(
          {
            status: read.status,
            headers: read.responseHeaders,
            body: {},
          },
          reader,
        ),
      );
  }
  expect(seen.decisions.filter(({ action }) => action === 'realm:read').length).toBeGreaterThanOrEqual(2);
  expect(seen.decisions.some(({ action, id }) => action === 'context:read' && id === contextA)).toBe(true);
  for (const { actor } of seen.decisions) {
    expect(actor.kind).toBe('account');
    if (actor.kind === 'account') expect(actor.accountId).toBe(reader.accountId);
  }
  expect(Math.max(...seen.deadlines) - Math.min(...seen.deadlines)).toBeLessThanOrEqual(0);
  preserves(components(response, reader), components(native, reader));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}, 180_000);

test('Realm selector preserves Global agent candidate audience without publisher-private candidates or related ids while standalone hydration stays private', async () => {
  for (const caller of [reader, publisher]) {
    const standalone = await selectedSubject(pen, GLOBAL_CONTEXT, caller);
    const publicRead = await selectedSubject(pen, GLOBAL_CONTEXT, null);
    if (caller === publisher) expect(JSON.stringify(standalone.body)).toContain(privateCandidate);
    expect(JSON.stringify(publicRead.body)).not.toContain(privateCandidate);
    const aggregate = await page(caller, { subject: pen, realm: realm.realmId });
    status(aggregate, 200);
    expect(aggregate.body).not.toHaveProperty('context');
    const subject = embedded(aggregate, pen).subject;
    expect(record(subject.subject).context).toBe(GLOBAL_CONTEXT);
    expect(subject.subject).toEqual(publicRead.body.subject);
    expect(subject.related).toEqual(publicRead.body.related);
    expect(JSON.stringify(aggregate.body)).not.toContain(privateCandidate);
    expect(JSON.stringify(aggregate.body)).not.toContain(privateRelated);
    // The public page scope must not stick to a later permitted standalone read.
    if (caller === publisher)
      expect(JSON.stringify((await selectedSubject(pen, GLOBAL_CONTEXT, caller)).body)).toContain(privateCandidate);
  }
}, 180_000);

async function fallback(verdict: 'unpublished' | 'withdraw' | 'reject') {
  const target = await makeRealm();
  if (verdict !== 'unpublished') {
    const head = await publish(target);
    status(
      await write(`/v1/realms/${target.realmId}/publications/${book}:${verdict}`, undefined, {
        'if-match': JSON.stringify(head),
      }),
      200,
    );
  }
  status(await send(reader, 'GET', `/v1/realms/${target.realmId}/publications/${book}`), 404);
  const standalone = await selectedSubject(book, GLOBAL_CONTEXT);
  const response = await page(reader, { subject: book, realm: target.realmId });
  status(response, 200);
  metadata(response, GLOBAL_CONTEXT, { kind: 'global' });
  expect(embedded(response).subject.subject).toEqual(standalone.body.subject);
  const text = JSON.stringify(response.body);
  for (const secret of [target.realmId, target.title, contextA, localA, 'unpublished', 'withdraw', 'reject'])
    expect(text).not.toContain(secret);
  // The native public floor can admit Global without a subject token scope.
  // Preserve that actual decision; absence of a token scope is not a denial.
  status(await send(unscoped, 'GET', `/v1/realms/${target.realmId}`), 200);
  const publicFloor = await send(unscoped, 'GET', `/v1/subjects/${book}`);
  status(publicFloor, 200);
  const aggregate = await page(unscoped, { subject: book, realm: target.realmId });
  status(aggregate, publicFloor.status);
  metadata(aggregate, GLOBAL_CONTEXT, { kind: 'global' });
  expect(embedded(aggregate).subject.subject).toEqual(publicFloor.body.subject);
}

test(
  'readable unpublished Realm falls back to independently authorized labelled Global without revealing Realm data',
  () => fallback('unpublished'),
  180_000,
);
test(
  'readable withdrawn Realm uses independently authorized labelled Global without Realm disclosure',
  () => fallback('withdraw'),
  180_000,
);
test(
  'readable rejected Realm uses independently authorized labelled Global without Realm disclosure',
  () => fallback('reject'),
  180_000,
);

test('Realm contextA toB change cannot publish staleA success', async () => {
  const target = await makeRealm();
  await publish(target);
  let announce!: () => void;
  let resume!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const seen = observed();
  seen.pause = { realm: target.realmId, observed: announce, release, used: false };
  const pending = capture.run(seen, () => page(reader, { subject: book, realm: target.realmId }));
  try {
    // If the native wire is absent the actual request finishes with 400; fail at
    // expected200 immediately rather than hanging on a nonexistent observation.
    const first = await Promise.race([
      firstRead.then(() => ({ kind: 'observed' as const })),
      pending.then((response) => ({ kind: 'finished' as const, response })),
    ]);
    if (first.kind === 'finished') {
      status(first.response, 200);
      expect(seen.pause.used).toBe(true);
      return;
    }
    const moved = await patchRealm(target, { contextId: contextB, title: 'Actual current Realm B' });
    expect(moved.contextId).toBe(contextB);
    expect(moved.headRevisionId).not.toBe(target.headRevisionId);
    resume();
    const response = await pending;
    if (response.status === 200) {
      metadata(response, contextB, { kind: 'realm', id: target.realmId, title: moved.title });
      expect(JSON.stringify(response.body)).toContain(localB);
      expect(JSON.stringify(response.body)).not.toContain(localA);
      expect(JSON.stringify(response.body)).not.toContain(contextA);
      expect(JSON.stringify(embedded(response).links)).toContain(edition);
    } else {
      status(response, 503);
      expect(['presentation_not_ready', 'semantic_not_ready', 'deadline_exceeded']).toContain(
        response.body.code as string,
      );
      expect(response.body).not.toHaveProperty('context');
      expect(response.body).not.toHaveProperty('reads');
    }
    const current = await page(reader, { subject: book, realm: target.realmId });
    status(current, 200);
    metadata(current, contextB, { kind: 'realm', id: target.realmId, title: moved.title });
    expect(JSON.stringify(current.body)).toContain(localB);
    expect(JSON.stringify(current.body)).not.toContain(localA);
    expect(JSON.stringify(embedded(current).links)).toContain(edition);
  } finally {
    resume();
    await pending;
  }
}, 180_000);

test('unknown denied and currently banned protected Realms conceal even over an independent read grant', async () => {
  const unknown = await page(reader, { subject: book, realm: Bun.randomUUIDv7() });
  status(unknown, 404);
  const target = await makeRealm();
  await publish(target);
  for (const caller of [null, outsider]) {
    status(await send(caller, 'GET', `/v1/realms/${target.realmId}`), 404);
    const response = await page(caller, { subject: book, realm: target.realmId });
    status(response, 404);
    expect(stable(response.body)).toEqual(stable(unknown.body));
  }
  const ban = await send(
    publisher,
    'PUT',
    `/v1/realms/${target.realmId}/bans/${reader.accountId}`,
    { reason: 'Native current ban' },
    key(),
  );
  status(ban, 200);
  expect(record(ban.body.ban).workflowId).toBeNull(); // direct grant, no membership workflow required
  status(await send(reader, 'GET', `/v1/realms/${target.realmId}`), 404);
  const response = await page(reader, { subject: book, realm: target.realmId });
  status(response, 404);
  expect(stable(response.body)).toEqual(stable(unknown.body));
  expect(JSON.stringify(response.body)).not.toContain(target.realmId);
}, 180_000);

test('current subject hiding and Context deletion conceal selected Realm facts and fallback cannot revive a hidden subject', async () => {
  const selected = await context('Native deletion Context');
  const target = await makeRealm(selected);
  await publish(target);
  status(await send(publisher, 'DELETE', `/v1/contexts/${selected}`, undefined, key()), 200);
  status(await send(reader, 'GET', `/v1/contexts/${selected}`), 404);
  status(await send(reader, 'GET', `/v1/subjects/${book}?context=${selected}`), 404);
  const deleted = await page(reader, { subject: book, realm: target.realmId });
  status(deleted, 404);
  expect(deleted.body).not.toHaveProperty('context');
  expect(deleted.body).not.toHaveProperty('reads');
  const hidden = (await createSubject('schema:Book', 'Current hidden subject')).id as string;
  const published = await makeRealm();
  await publish(published, hidden);
  status(await write(`/v1/subjects/${hidden}:hide`, { reason: 'Native current moderation' }), 200);
  for (const actual of [published, await makeRealm()]) {
    const native = await send(reader, 'GET', `/v1/subjects/${hidden}`);
    status(native, 404);
    const response = await page(reader, { subject: hidden, realm: actual.realmId });
    status(response, 404);
    expect(stable(response.body)).toEqual(stable(native.body));
  }
}, 180_000);

test('Realm read grant and publication pointer never replace current Context authority', async () => {
  const selected = await context('Current Context authority');
  const target = await makeRealm(selected);
  await publish(target);
  status(await send(publisher, 'DELETE', `/v1/contexts/${selected}`, undefined, key()), 200);
  status(await send(reader, 'GET', `/v1/realms/${target.realmId}`), 200);
  status(await send(reader, 'GET', `/v1/realms/${target.realmId}/publications/${book}`), 200);
  status(await send(reader, 'GET', `/v1/subjects/${book}`), 200);
  status(await send(reader, 'GET', `/v1/contexts/${selected}`), 404);
  const response = await page(reader, { subject: book, realm: target.realmId });
  status(response, 404);
  expect(response.body).not.toHaveProperty('context');
  expect(response.body).not.toHaveProperty('reads');
}, 180_000);

test('current subject takedown and candidate moderation remain authoritative on published Realm pages', async () => {
  const hidden = (await createSubject('schema:Book', 'Taken down Realm subject')).id as string;
  const target = await makeRealm();
  await publish(target, hidden);
  await driver.fixtures.grantAccount(publisher, ['moderation:takedown']);
  status(
    await write(`/v1/subjects/${hidden}:takedown`, {
      notice: { complaint: 'Native subject lifecycle', received_at: new Date().toISOString() },
    }),
    200,
  );
  status(await send(reader, 'GET', `/v1/subjects/${hidden}`), 404);
  const withheld = await page(reader, { subject: hidden, realm: target.realmId });
  status(withheld, 404);
  expect(withheld.body).not.toHaveProperty('reads');

  const subject = await createSubject('schema:Book', 'Moderated current candidate', {
    'schema:url': [statement('schema:url', 'https://example.test/currently-withheld-candidate')],
  });
  const candidate = subject.statements['schema:url'][0].id as string;
  await publish(target, subject.id);
  status(
    await write(`/v1/subjects/${subject.id}/candidates/${candidate}:hide`, {
      reason: 'Native candidate moderation',
    }),
    200,
  );
  const native = await selectedSubject(subject.id, contextA);
  expect(JSON.stringify(native.body)).not.toContain(candidate);
  const response = await page(reader, { subject: subject.id, realm: target.realmId });
  status(response, 200);
  metadata(response, contextA, { kind: 'realm', id: target.realmId, title: target.title });
  expect(JSON.stringify(response.body)).not.toContain(candidate);
  expect(JSON.stringify(response.body)).not.toContain('https://example.test/currently-withheld-candidate');
}, 180_000);

test('Realm selector validates the existing single target family and rejects raw Context and unknown fields', async () => {
  for (const target of [
    { subject: book, realm: 1 },
    { subject: book, realm: 'not-a-uuid' },
    { subject: book, realm: null },
    { subject: book, realm: realm.realmId, context: contextA },
    { account: 'reader', realm: realm.realmId },
    { route: '/', realm: realm.realmId },
    { subject: book, account: 'reader', realm: realm.realmId },
    { realm: realm.realmId },
    { subject: book, realm: realm.realmId, view: 'not-a-view' },
  ]) {
    const response = await page(reader, target);
    status(response, 400);
    expect(response.body.code).toBe('invalid_request');
  }
  const extra = await send(reader, 'POST', '/v1/pages:read', {
    target: { subject: book, realm: realm.realmId },
    context: contextA,
  });
  status(extra, 400);
  expect(extra.body.errors).toContainEqual({ pointer: '/context', code: 'unknown_field' });
  const valid = await page(reader, { subject: book, realm: realm.realmId, view: 'overview' });
  status(valid, 200);
  metadata(valid, contextA, { kind: 'realm', id: realm.realmId, title: realm.title });
}, 180_000);

test('agent Realm selectors retain canonical Global redirects and old Global reads retain their response shape', async () => {
  const global = await page(reader, { subject: book });
  status(global, 200);
  expect(global.body).not.toHaveProperty('context');
  expect(record(embedded(global).subject.subject).context).toBe(GLOBAL_CONTEXT);
  const canonical = await page(reader, { subject: author });
  status(canonical, 200);
  const agent = await page(reader, { subject: author, realm: realm.realmId });
  status(agent, 200);
  expect(agent.body).toEqual(canonical.body);
  const linked = await page(reader, { subject: privateRelated });
  status(linked, 308);
  const routed = await page(reader, { subject: privateRelated, realm: realm.realmId });
  status(routed, 308);
  expect(routed.body).toEqual(linked.body);
  expect(routed.headers.get('location')).toBe(linked.headers.get('location'));
  expect(routed.headers.get('location')).not.toContain(realm.realmId);
}, 180_000);

test('native suspended pre-suspension bearer is invalid on Realm page reads with the standard Bearer challenge', async () => {
  // The existing driver registers, issues, then natively suspends this persona.
  // Keep its real original bearer; no replacement or forged valid token.
  const native = await driver.request('suspended', 'GET', `/v1/subjects/${book}`);
  const response = await driver.request('suspended', 'POST', '/v1/pages:read', {
    target: { subject: book, realm: realm.realmId },
  });
  for (const actual of [native, response]) {
    status(actual, 401);
    expect(actual.body.code).toBe('invalid_credentials');
    expect(actual.headers.get('www-authenticate')).toContain('Bearer');
    expect(actual.headers.get('www-authenticate')).toContain('error="invalid_token"');
  }
  expect(stable(response.body)).toEqual(stable(native.body));
}, 180_000);

test('protected ban after the first actual Realm read conceals publication not_found without Global fallback', async () => {
  const target = await makeRealm();
  await publish(target);
  const unknown = await send(reader, 'GET', `/v1/realms/${Bun.randomUUIDv7()}`);
  status(unknown, 404);
  expect(unknown.body.code).toBe('not_found');
  let announce!: () => void;
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const seen = observed();
  seen.pause = { realm: target.realmId, observed: announce, release, used: false };
  const pending = capture.run(seen, () => page(reader, { subject: book, realm: target.realmId }));
  try {
    const first = await Promise.race([
      barrier.then(() => ({ kind: 'observed' as const })),
      pending.then((response) => ({ kind: 'finished' as const, response })),
    ]);
    if (first.kind === 'finished') {
      status(first.response, 404);
      expect(first.response.body.code).toBe('not_found');
      expect(seen.pause.used).toBe(true);
    }
    expect(seen.pause.used).toBe(true);
    const ban = await send(
      publisher,
      'PUT',
      `/v1/realms/${target.realmId}/bans/${reader.accountId}`,
      { reason: 'Private early ban reason' },
      key(),
    );
    status(ban, 200);
    expect(record(ban.body.ban).workflowId).toBeNull();
    const current = await send(reader, 'GET', `/v1/realms/${target.realmId}`);
    status(current, 404);
    expect(current.body.code).toBe('not_found');
    const unchanged = await send(publisher, 'GET', `/v1/realms/${target.realmId}`);
    status(unchanged, 200);
    expect(record(unchanged.body.realm).contextId).toBe(target.contextId);
    expect(record(unchanged.body.realm).headRevisionId).toBe(target.headRevisionId);
    // This native publication read exercises the throwing protected-ban check,
    // independently of readRealm's null concealment. Keep the read grant intact.
    const publication = await send(reader, 'GET', `/v1/realms/${target.realmId}/publications/${book}`);
    status(publication, 404);
    expect(publication.body.code).toBe('not_found');
    resume();
    const response = await pending;
    status(response, 404);
    expect(response.body.code).toBe('not_found');
    expect(stable(response.body)).toEqual(stable(unknown.body));
    expect(response.body).not.toHaveProperty('context');
    expect(response.body).not.toHaveProperty('reads');
    for (const secret of [target.realmId, target.title, contextA, localA, 'Private early ban reason'])
      expect(JSON.stringify(response.body)).not.toContain(secret);
  } finally {
    resume();
    await pending.catch(() => {});
  }
}, 180_000);

async function lateAuthority(verdict: 'withdraw' | 'reject' | 'ban') {
  const target = await makeRealm();
  const head = await publish(target);
  const before = await send(publisher, 'GET', `/v1/realms/${target.realmId}`);
  status(before, 200);
  const nativeSubject = await selectedSubject(book, contextA);
  const nativeLinks = await send(
    reader,
    'GET',
    `/v1/subjects/${book}/links?context=${contextA}&property=schema%3AexampleOfWork&limit=6`,
  );
  status(nativeLinks, 200);
  const globalSubject = await selectedSubject(book, GLOBAL_CONTEXT);
  const globalLinks = await send(
    reader,
    'GET',
    `/v1/subjects/${book}/links?context=${GLOBAL_CONTEXT}&property=schema%3AexampleOfWork&limit=6`,
  );
  status(globalLinks, 200);
  expect(JSON.stringify(globalLinks.body.links)).toContain(edition);
  let announce!: () => void;
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const seen = observed();
  seen.selectedPause = { subject: book, context: contextA, observed: announce, release, used: false };
  const pending = capture.run(seen, () => page(reader, { subject: book, realm: target.realmId }));
  const assertGlobal = (response: HttpResponse) => {
    status(response, 200);
    metadata(response, GLOBAL_CONTEXT, { kind: 'global' });
    const result = embedded(response);
    expect(result.subject.subject).toEqual(globalSubject.body.subject);
    expect(result.links).toEqual(globalLinks.body);
    for (const secret of [target.realmId, target.title, contextA, localA, 'Private late ban reason'])
      expect(JSON.stringify(response.body)).not.toContain(secret);
  };
  try {
    const first = await Promise.race([
      barrier.then(() => ({ kind: 'observed' as const })),
      pending.then((response) => ({ kind: 'finished' as const, response })),
    ]);
    if (first.kind === 'finished') {
      // Even an otherwise valid page is no proof of the required during-read seam.
      status(first.response, 200);
      metadata(first.response, contextA, { kind: 'realm', id: target.realmId, title: target.title });
      expect(seen.selectedPause.used).toBe(true);
    }
    expect(seen.selectedPause.used).toBe(true);
    const selected = seen.requests.filter(({ path }) => {
      const url = new URL(path, 'http://kernel.test');
      return (
        url.searchParams.get('context') === contextA &&
        (url.pathname === `/v1/subjects/${book}` || url.pathname === `/v1/subjects/${book}/links`)
      );
    });
    expect(selected).toHaveLength(2);
    const subject = selected.find(
      ({ path }) => new URL(path, 'http://kernel.test').pathname === `/v1/subjects/${book}`,
    )!;
    const links = selected.find(({ path }) => new URL(path, 'http://kernel.test').pathname.endsWith('/links'))!;
    for (const actual of [subject, links]) {
      expect(actual.status).toBe(200);
      expect(actual.headers.get('authorization')).toBe(`Bearer ${reader.bearer}`);
      expect(actual.responseHeaders.get(SESSION)).toBeString();
      expect(
        components({ status: actual.status, body: record(actual.body), headers: actual.responseHeaders }, reader)
          .length,
      ).toBeGreaterThan(0);
    }
    expect(record(subject.body).subject).toEqual(nativeSubject.body.subject);
    expect(record(links.body)).toEqual(nativeLinks.body);
    expect(JSON.stringify(subject.body)).toContain(localA);
    expect(JSON.stringify(links.body)).not.toContain(edition);
    for (const { actor } of seen.decisions) {
      expect(actor.kind).toBe('account');
      if (actor.kind === 'account') expect(actor.accountId).toBe(reader.accountId);
    }
    // Outside capture: same native driver and retained independent read grant.
    if (verdict === 'ban') {
      const ban = await send(
        publisher,
        'PUT',
        `/v1/realms/${target.realmId}/bans/${reader.accountId}`,
        { reason: 'Private late ban reason' },
        key(),
      );
      status(ban, 200);
      expect(record(ban.body.ban).workflowId).toBeNull();
    } else {
      status(
        await write(`/v1/realms/${target.realmId}/publications/${book}:${verdict}`, undefined, {
          'if-match': JSON.stringify(head),
        }),
        200,
      );
      status(await send(reader, 'GET', `/v1/realms/${target.realmId}/publications/${book}`), 404);
    }
    const after = await send(publisher, 'GET', `/v1/realms/${target.realmId}`);
    status(after, 200);
    expect(record(after.body.realm).contextId).toBe(record(before.body.realm).contextId);
    expect(record(after.body.realm).headRevisionId).toBe(record(before.body.realm).headRevisionId);
    resume();
    const response = await pending;
    if (verdict === 'ban') {
      const current = await send(reader, 'GET', `/v1/realms/${target.realmId}`);
      status(current, 404);
      expect(current.body.code).toBe('not_found');
      status(response, 404);
      expect(response.body.code).toBe('not_found');
      expect(stable(response.body)).toEqual(stable(current.body));
      expect(response.body).not.toHaveProperty('context');
      expect(response.body).not.toHaveProperty('reads');
      for (const secret of [target.realmId, target.title, contextA, localA, 'Private late ban reason'])
        expect(JSON.stringify(response.body)).not.toContain(secret);
    } else {
      if (response.status === 200) assertGlobal(response);
      else {
        status(response, 503);
        expect([
          'presentation_not_ready',
          'semantic_not_ready',
          'deadline_exceeded',
          'overloaded',
          'partition_unavailable',
          'transaction_retry_exhausted',
        ]).toContain(response.body.code as string);
        expect(response.headers.get('retry-after')).toBe('1');
        for (const field of ['context', 'reads', 'subject', 'document', 'result'])
          expect(response.body).not.toHaveProperty(field);
        for (const secret of [target.realmId, target.title, contextA, localA])
          expect(JSON.stringify(response.body)).not.toContain(secret);
      }
      assertGlobal(await page(reader, { subject: book, realm: target.realmId }));
    }
  } finally {
    resume();
    await pending.catch(() => {});
  }
}

test.each(['withdraw', 'reject'] as const)(
  'publication %s after selected subject and links cannot survive an unchanged Realm head guard',
  (verdict) => lateAuthority(verdict),
  180_000,
);
test(
  'protected ban after selected subject and links conceals despite an unchanged Realm head and independent grant',
  () => lateAuthority('ban'),
  180_000,
);

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import release from '../packages/definitions/release/rezics.json';
import {
  VIEWER_ACTIONS_SURFACES_MISSING_DRIVER,
  VIEWER_ACTIONS_SURFACES_ROUTE,
  type Credential,
  type ResourceReference,
  type SurfaceAction,
  type ViewerActionsResponse,
  type ViewerActionsSurfacesDriver,
} from './viewer-actions-surfaces-driver.ts';

setDefaultTimeout(240_000);
let driver: ViewerActionsSurfacesDriver | undefined;
beforeEach(async () => {
  const location = process.env.VIEWER_ACTIONS_SURFACES_DRIVER;
  if (!location) throw new Error(VIEWER_ACTIONS_SURFACES_MISSING_DRIVER);
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('VIEWER_ACTIONS_SURFACES_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('VIEWER_ACTIONS_SURFACES_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createViewerActionsSurfacesDriver !== 'function')
    throw new Error('Expected createViewerActionsSurfacesDriver factory');
  driver = await binding.createViewerActionsSurfacesDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
const native = () => driver!;
const bindings = [
  { action: 'follow:create', operations: ['follow.put'] },
  { action: 'follow:delete', operations: ['follow.delete'] },
  { action: 'library_entry:delete', operations: ['library_entry.delete'] },
  { action: 'library_entry:update', operations: ['library_entry.put'] },
] satisfies { action: SurfaceAction; operations: string[] }[];
const scopes = bindings.map(({ action }) => action);

async function fixture() {
  const f = await native().fixture();
  expect(release.types).toHaveProperty('schema:Book');
  expect(f.subjects.length).toBeGreaterThanOrEqual(20);
  const refs = [...f.subjects, f.withheld, f.concealed, f.unknown];
  expect(new Set(refs.map(({ id }) => id)).size).toBe(refs.length);
  for (const ref of refs) expect(ref.type).toBe('schema:Book');
  expect(f.alice.accountId).not.toBe(f.bob.accountId);
  expect(f.anonymous.credential).toBeNull();
  return f;
}
function send(credential: Credential | null, resources: readonly ResourceReference[]) {
  return native().request(credential, VIEWER_ACTIONS_SURFACES_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resources }),
  });
}
async function read(credential: Credential | null, resources: readonly ResourceReference[]) {
  const response = await send(credential, resources);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = (await response.json()) as ViewerActionsResponse;
  expect(Object.keys(body)).toEqual(['resources']);
  expect(body.resources.map(({ type, id }) => ({ type, id }))).toEqual([...resources]);
  return body.resources;
}
function offered(ref: ResourceReference, actions = bindings) {
  return { ...ref, viewerActions: actions };
}
function command(credential: Credential | null, path: string, method: 'PUT' | 'DELETE', body?: unknown) {
  return native().request(credential, path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json();
  expect(body).toMatchObject({ status, code, type: `https://rezics.com/problems/${code}` });
  expect(body).not.toHaveProperty('resources');
  expect(body).not.toHaveProperty('viewerActions');
}

test('a signed-in reader of a public catalogue subject is offered follow and library entry operations and each offered operation succeeds with the same bearer', async () => {
  const f = await fixture();
  const ref = f.subjects[0]!;
  const bearer = f.alice.credential;
  expect(await read(bearer, [ref])).toEqual([offered(ref)]);
  // Viewer actions cover Access and gates; execute commands in their valid domain states.
  const followPath = `/v1/follows/${ref.id}`;
  let response = await command(bearer, followPath, 'PUT');
  expect(response.status).toBe(200);
  expect((await response.json()).follow).toMatchObject({ targetId: ref.id, targetType: 'subject', state: 'following' });
  expect(await read(bearer, [ref])).toEqual([offered(ref)]);
  response = await command(bearer, followPath, 'DELETE');
  expect(response.status).toBe(200);
  expect((await response.json()).follow).toMatchObject({ targetId: ref.id, state: 'unfollowed' });
  const entryPath = `/v1/libraryEntries/${ref.id}`;
  response = await command(bearer, entryPath, 'PUT', { state: 'planned' });
  expect(response.status).toBe(201);
  const { libraryEntry } = await response.json();
  expect(libraryEntry).toMatchObject({ subjectId: ref.id, state: 'planned' });
  expect(libraryEntry.revision).toBeGreaterThan(0);
  expect(await read(bearer, [ref])).toEqual([offered(ref)]);
  expect(
    (
      await command(
        bearer,
        `${entryPath}?revision=${libraryEntry.revision}&incarnationId=${libraryEntry.incarnationId}`,
        'DELETE',
      )
    ).status,
  ).toBe(204);
  expect(await read(bearer, [ref])).toEqual([offered(ref)]);
  const unscoped = await f.unscoped('follow:create');
  expect(await read(unscoped.credential, [ref])).toEqual([
    offered(
      ref,
      bindings.filter(({ action }) => action !== 'follow:create'),
    ),
  ]);
  await problem(await command(unscoped.credential, followPath, 'PUT'), 403, 'forbidden');
});

test('a TypeList page sends its displayed subject rows in one request and each row equals the detail answer', async () => {
  const f = await fixture();
  const rows = f.subjects.slice(0, 20).reverse();
  const batch = await read(f.alice.credential, rows);
  expect(batch).toHaveLength(20);
  for (const [index, ref] of rows.entries()) {
    const [detail] = await read(f.alice.credential, [ref]);
    expect(batch[index]).toEqual(detail!);
    expect(detail).toEqual(offered(ref));
  }
});

test('a withheld or concealed subject in a TypeList row answers the same not_found item as an unknown id', async () => {
  const f = await fixture();
  const refs = [f.subjects[0]!, f.withheld, f.unknown, f.concealed, f.subjects[1]!];
  for (const credential of [f.alice.credential, f.bob.credential, f.anonymous.credential]) {
    const batch = await read(credential, refs);
    for (const index of [1, 2, 3]) {
      const ref = refs[index]!;
      expect(batch[index]).toEqual({ ...ref, error: 'not_found' });
    }
    expect(batch[0]).toEqual(offered(refs[0]!, credential === null ? [] : bindings));
    expect(batch[4]).toEqual(offered(refs[4]!, credential === null ? [] : bindings));
  }
});

test('an anonymous reader of a subject or TypeList row is offered no mutation and the answer is private no-store', async () => {
  const f = await fixture();
  const rows = f.subjects.slice(0, 20);
  expect(await read(f.anonymous.credential, [rows[0]!])).toEqual([offered(rows[0]!, [])]);
  expect(await read(f.anonymous.credential, rows)).toEqual(rows.map((ref) => offered(ref, [])));
  for (const path of [`/v1/follows/${rows[0]!.id}`, `/v1/libraryEntries/${rows[0]!.id}`]) {
    for (const method of ['PUT', 'DELETE'] as const) {
      const body = method === 'PUT' && path.includes('libraryEntries') ? { state: 'planned' } : undefined;
      await problem(await command(null, path, method, body), 401, 'authentication_required');
    }
  }
});

test('a token without the follow or library scope is offered no operation that needs the missing scope', async () => {
  const f = await fixture();
  const ref = f.subjects[0]!;
  for (const missing of scopes) {
    const persona = await f.unscoped(missing);
    const expected = offered(
      ref,
      bindings.filter(({ action }) => action !== missing),
    );
    expect(await read(persona.credential, [ref])).toEqual([expected]);
    const rows = f.subjects.slice(0, 20);
    expect(await read(persona.credential, rows)).toEqual(rows.map((row) => ({ ...expected, ...row })));
    const follow = missing.startsWith('follow:');
    const path = follow ? `/v1/follows/${ref.id}` : `/v1/libraryEntries/${ref.id}`;
    const method = missing.endsWith(':delete') ? 'DELETE' : 'PUT';
    const body = !follow && method === 'PUT' ? { state: 'planned' } : undefined;
    await problem(await command(persona.credential, path, method, body), 403, 'forbidden');
  }
});

test("a suspended account's bearer gets its normal refusal and never an old positive or an anonymous answer", async () => {
  const f = await fixture();
  const rows = f.subjects.slice(0, 20);
  const bearer = f.alice.credential;
  expect(await read(bearer, [rows[0]!])).toEqual([offered(rows[0]!)]);
  expect(await read(bearer, rows)).toEqual(rows.map((row) => offered(row)));
  await native().suspend(f.alice);
  for (const credential of [bearer, f.suspended.credential]) {
    for (const refs of [[rows[0]!], rows]) await problem(await send(credential, refs), 401, 'invalid_credentials');
  }
  expect(await read(null, [rows[0]!])).toEqual([offered(rows[0]!, [])]);
  await problem(await send(bearer, [rows[0]!]), 401, 'invalid_credentials');
});

test("two personas reading the same subject never see each other's answers", async () => {
  const f = await fixture();
  const ref = f.subjects[0]!;
  expect((await command(f.bob.credential, `/v1/follows/${ref.id}`, 'PUT')).status).toBe(200);
  // Different consent makes identity isolation observable; follow state alone is not Access.
  const bob = await native().authenticate(
    f.bob,
    scopes.filter((scope) => scope !== 'follow:create'),
  );
  expect(bob.accountId).toBe(f.bob.accountId);
  const aliceAnswer = [offered(ref)];
  const bobAnswer = [
    offered(
      ref,
      bindings.filter(({ action }) => action !== 'follow:create'),
    ),
  ];
  const refs = [ref];
  expect(await read(f.alice.credential, refs)).toEqual(aliceAnswer);
  expect(await read(bob.credential, refs)).toEqual(bobAnswer);
  expect(await Promise.all([read(bob.credential, refs), read(f.alice.credential, refs)])).toEqual([
    bobAnswer,
    aliceAnswer,
  ]);
  expect(await read(f.alice.credential, refs)).toEqual(aliceAnswer);
  expect(await read(bob.credential, refs)).toEqual(bobAnswer);
});

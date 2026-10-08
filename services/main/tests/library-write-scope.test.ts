import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { AccountAssertionInsufficientScope } from '../src/modules/account/verify-assertion.ts';
import { emptyRow } from '../src/modules/library-import/formats/contract.ts';
import type { StoredSourceRow } from '../src/modules/library-import/file-store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { libraryCopiesRoutes, openApiOperations as copyOperations } from '../src/routes/library-copies.ts';
import { libraryRoutes, openApiOperations as libraryOperations } from '../src/routes/library.ts';
import { libraryImportsRoutes, openApiOperations as importOperations, capabilities } from '../src/routes/library-imports.ts';
import { sessionsRoutes, openApiOperations as sessionOperations } from '../src/routes/sessions.ts';
import { readingSettingsRoutes, openApiOperations as settingsOperations } from '../src/routes/reading-settings.ts';
import { progressRoutes, openApiOperations as progressOperations } from '../src/routes/progress.ts';
import { typedRefusal } from '../src/routes/problems.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const agent = id(1), work = id(2), release = id(3), record = id(4), file = id(5).slice(-36);
const timestamp = '2026-10-01T00:00:00.000Z';
const command = { actingSubject: agent, expectedVersion: 0 };
const settings = { fontSize: 19, lineWidth: 'medium', typeface: 'serif', paragraphIndent: false,
  theme: 'system', cjkSpacing: 'auto', cjkPunctuation: 'standard' };
const copy = { id: record, work, release, format: null, acquiredFrom: null, acquiredAt: null,
  ownedFrom: null, ownedThrough: null, removed: false, version: 1, changedAt: timestamp, replayed: false };
const loan = { id: record, copy: record, direction: 'lent', counterparty: { kind: 'name', name: 'Jane' },
  startedAt: timestamp, dueAt: timestamp, returnedAt: null, version: 1, changedAt: timestamp,
  state: 'open', replayed: false };
const target = { resource: work, base: 'work', types: [], work, revision: id(6), disclosure: 'public' };
const session = { id: record, target, state: 'active', startedOn: null, finishedOn: null,
  selections: [{ target, language: null, format: null, progress: 'locator' }], locators: [],
  completedAt: null, version: 1, createdAt: timestamp, changedAt: timestamp, replayed: false };
const goal = { year: 2026, target: 12, completed: 0, version: 1, changedAt: timestamp, replayed: false };

const families = {
  copies: { routes: libraryCopiesRoutes, operations: copyOperations },
  library: { routes: libraryRoutes, operations: libraryOperations },
  imports: { routes: libraryImportsRoutes, operations: importOperations },
  sessions: { routes: sessionsRoutes, operations: sessionOperations },
  settings: { routes: readingSettingsRoutes, operations: settingsOperations },
  progress: { routes: (deps: MainWorkDependencies) => progressRoutes(deps.environment.fuseki, deps),
    operations: progressOperations },
};
type Family = keyof typeof families;
interface Mutation { family: Family; method: string; path: string; body?: object; query?: string }
const mutations: Mutation[] = [
  { family: 'copies', method: 'POST', path: '/v1/me/library-copies', body: { ...command, release } },
  { family: 'copies', method: 'PATCH', path: '/v1/me/library-copies/{id}', body: { ...command, format: 'paperback' } },
  { family: 'copies', method: 'DELETE', path: '/v1/me/library-copies/{id}', body: command },
  { family: 'copies', method: 'POST', path: '/v1/me/library-loans', body: { ...command, copy: record,
    direction: 'lent', counterparty: { kind: 'name', name: 'Jane' }, startedAt: timestamp, dueAt: timestamp } },
  { family: 'copies', method: 'POST', path: '/v1/me/library-loans/{id}/extend', body: { ...command, dueAt: timestamp } },
  { family: 'copies', method: 'POST', path: '/v1/me/library-loans/{id}/return', body: command },
  { family: 'library', method: 'PUT', path: '/v1/works/{id}/reader-status', body: { ...command, status: 'reading' } },
  { family: 'library', method: 'PUT', path: '/v1/me/import-reviews/{id}', body: { ...command,
    text: 'Private reading notes', language: 'en', spoiler: false } },
  { family: 'library', method: 'PUT', path: '/v1/me/reading-goal', body: { ...command, year: 2026, target: 12 } },
  { family: 'imports', method: 'POST', path: '/v1/me/library-imports', body: { actingSubject: agent,
    format: 'generic-csv', file: 'title\nBook', mapping: { title: 'title', statuses: {} } } },
  { family: 'imports', method: 'DELETE', path: '/v1/me/library-imports/{id}', query: `actingSubject=${agent}` },
  { family: 'imports', method: 'PUT', path: '/v1/me/library-imports/{id}/rows/{row}',
    body: { actingSubject: agent, expectedVersion: 1, choice: 'private' } },
  { family: 'imports', method: 'POST', path: '/v1/me/library-imports/{id}/apply',
    body: { actingSubject: agent, context: null, language: 'en' } },
  { family: 'imports', method: 'POST', path: '/v1/me/library-imports/{id}/rows/{row}/adoptions',
    body: { actingSubject: agent, workId: 'OL45804W' } },
  { family: 'sessions', method: 'POST', path: '/v1/me/sessions', body: { ...command, target: work, state: 'active' } },
  { family: 'sessions', method: 'PATCH', path: '/v1/me/sessions/{id}', body: { ...command, state: 'paused' } },
  { family: 'settings', method: 'PUT', path: '/v1/reader/settings', body: { ...command, ...settings } },
  { family: 'progress', method: 'PUT', path: '/v1/compositions/{id}/occurrences/{occurrence}/progress',
    body: { ...command, completed: true, position: null } },
];

function respond(plugin: { handle(request: Request): Promise<Response> }, incoming: Request) {
  // Library import intake throws its Account refusal. The composition root maps
  // it; a plugin mounted alone needs the same table in front.
  return new Elysia().error(({ error }) => typedRefusal(error)).use(plugin as never).handle(incoming);
}

function request(operation: Pick<Mutation, 'method' | 'path' | 'body' | 'query'>) {
  const path = operation.path.replaceAll('{id}', record.slice(-36)).replaceAll('{row}', '0')
    .replaceAll('{occurrence}', id(7).slice(-36));
  return new Request(`http://main.local${path}${operation.query ? `?${operation.query}` : ''}`, {
    method: operation.method,
    headers: { authorization: 'Bearer reader', 'idempotency-key': 'library-consent-test',
      ...(operation.body ? { 'content-type': 'application/json' } : {}) },
    ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
  });
}

function fixture(scopes: readonly string[], overrides: Record<string, unknown> = {}) {
  const required: string[][] = [], touched: string[] = [];
  const untouched = (name: string) => new Proxy({}, { get: (_target, method) => async () => {
    touched.push(`${name}.${String(method)}`);
    throw new Error(`Unexpected owner access: ${name}.${String(method)}`);
  } });
  const deps = {
    account: { verify: async (_request: Request, needed: readonly string[]) => {
      required.push([...needed]);
      if (needed.some(scope => !scopes.includes(scope))) {
        throw new AccountAssertionInsufficientScope('Account assertion lacks a required scope');
      }
      return { issuer: 'https://account.test', subject: 'reader', accountScopes: scopes };
    } },
    access: { canReadAsBaselineMember: async () => { touched.push('access.ownPerson'); return true; } },
    libraryCopies: untouched('copies'), libraryLoans: untouched('loans'), libraryStatus: untouched('status'),
    libraryFiles: untouched('files'), libraryImport: untouched('imports'), sessions: untouched('sessions'),
    readingSettings: untouched('settings'), progress: untouched('progress'),
    sourceIntake: untouched('intake'), sourceGraph: untouched('sourceGraph'),
    sourceConversions: untouched('conversions'), sourceProposals: untouched('proposals'), sourceAdoptions: untouched('adoptions'),
    environment: { fuseki: untouched('graph') },
    ...overrides,
  } as unknown as MainWorkDependencies;
  return { deps, required, touched };
}

test.each(mutations)('$method $path refuses read-only consent before ownership, owner records or graph writes', async operation => {
  let admissionReads = 0;
  let graphWrites = 0;
  const state = fixture(['work:read'], operation.family === 'progress' ? {
    environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
      query: async (query: string) => {
        // Progress checks recovery readiness before verifying consent. This
        // read must not expand into chapter resolution or a graph command.
        expect(query).toContain('ASK { GRAPH');
        expect(query).toContain('rv:restoreHold true');
        admissionReads++;
        return { boolean: true };
      },
      commandWithReceipt: async () => { graphWrites++; throw new Error('Unexpected graph write'); },
    } },
  } : {});
  const response = await respond(families[operation.family].routes(state.deps), request(operation));
  // Main's existing Account denial mapper represents missing scope as 401.
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: 'account_assertion_denied' });
  expect(state.required).toEqual([['work:read', 'library:write']]);
  expect(state.touched).toEqual([]);
  expect(admissionReads).toBe(operation.family === 'progress' ? 1 : 0);
  expect(graphWrites).toBe(0);
});

test('the denial matrix covers every declared and mounted personal-record mutation', () => {
  for (const [family, definition] of Object.entries(families)) {
    const declared = Object.entries(definition.operations).flatMap(([path, methods]) =>
      Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`)).sort();
    const mounted = definition.routes(fixture(['work:read']).deps).routes.map(route =>
      `${route.method} ${route.path.replace(/:([a-z]+)/g, '{$1}')}`).sort();
    expect(mounted).toEqual(declared);
    expect(mutations.filter(operation => operation.family === family).map(operation =>
      `${operation.method} ${operation.path}`).sort()).toEqual(declared.filter(operation => !operation.startsWith('GET ')));
  }
});

test('MCP import declarations preserve read scope and require write consent for every mutation', () => {
  for (const [path, methods] of Object.entries(capabilities)) {
    for (const [method, capability] of Object.entries(methods)) {
      expect(capability.mcp.scopes).toContain('work:read');
      if (method === 'get') expect(capability.mcp.scopes).toEqual(['work:read']);
      else {
        expect(capability.mcp.scopes).toContain('library:write');
        expect(mutations.some(operation => operation.path === path && operation.method === method.toUpperCase())).toBe(true);
      }
    }
  }
  expect(capabilities['/v1/me/library-imports/{id}/apply'].post.mcp.scopes)
    .toEqual(['work:read', 'library:write', 'collection:edit', 'rating:read', 'rating:submit']);
  expect(capabilities['/v1/me/library-imports/{id}/rows/{row}/adoptions'].post.mcp.scopes)
    .toEqual(['work:read', 'library:write', 'work:create']);
});

const ownerAdmissions = mutations.filter(operation => operation.family !== 'progress' && !(operation.family === 'library'
  && operation.path !== '/v1/me/reading-goal') && !(operation.family === 'imports'
  && (operation.path.endsWith('/apply') || operation.path.endsWith('/adoptions'))));

test.each(ownerAdmissions)('$method $path admits writer consent to its owner', async operation => {
  const writes: string[] = [];
  const save = (owner: string, value?: unknown) => async () => { writes.push(owner); return value; };
  const state = fixture(['work:read', 'library:write'], {
    libraryCopies: { write: save('copies', copy) }, libraryLoans: { write: save('loans', loan) },
    libraryStatus: { setGoal: save('goal', goal) },
    libraryFiles: { create: save('files', { id: file, total: 1 }), delete: save('files'), resolve: save('files') },
    sessions: { write: save('sessions', session) },
    readingSettings: { write: save('settings', { profile: 'reader-settings-v1', ...settings, version: 1 }) },
  });
  const response = await respond(families[operation.family].routes(state.deps), request(operation));
  expect(response.status).toBe(operation.method === 'POST' && !operation.path.includes('{id}') ? 201 : 200);
  expect(state.required).toEqual([['work:read', 'library:write']]);
  expect(state.touched).toEqual(['access.ownPerson']);
  expect(writes).toHaveLength(1);
});

const reads: Array<{ family: Family; path: string; query?: string }> = [
  { family: 'copies', path: '/v1/works/{id}/copies' },
  { family: 'copies', path: '/v1/me/library-loans' },
  { family: 'library', path: '/v1/me/reading-goal', query: `actingSubject=${agent}&year=2026` },
  { family: 'imports', path: '/v1/me/library-imports/{id}/rows' },
  { family: 'sessions', path: '/v1/me/sessions' },
  { family: 'settings', path: '/v1/reader/settings' },
];
test.each(reads)('read-only consent still reads $path', async operation => {
  const state = fixture(['work:read'], {
    libraryCopies: { page: async () => ({ items: [], nextCursor: null }) },
    libraryLoans: { page: async () => ({ items: [], nextCursor: null }) },
    libraryStatus: { goal: async () => goal }, libraryFiles: { page: async () => ({ rows: [], more: false }) },
    sessions: { page: async () => ({ items: [], nextCursor: null }) },
    readingSettings: { read: async () => ({ profile: 'reader-settings-v1', ...settings, version: 0 }) },
  });
  const response = await respond(families[operation.family].routes(state.deps), request({ ...operation,
    method: 'GET', query: operation.query ?? `actingSubject=${agent}` }));
  expect(response.status).toBe(200);
  expect(state.required.length).toBeGreaterThan(0);
  expect(state.required.every(scopes => scopes.length === 1 && scopes[0] === 'work:read')).toBe(true);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

function unmatchedRow(): StoredSourceRow {
  return { index: 0, source: emptyRow('source-row', 'Book', { original: 'retained' }), match: null,
    resolution: { choice: 'private' }, outcome: null, version: 1 };
}

test.each([false, true])('import row reads retain a discovered match only with writer consent (write=%s)', async write => {
  const stored = unmatchedRow(), before = structuredClone(stored);
  let saves = 0;
  const state = fixture(write ? ['work:read', 'library:write'] : ['work:read'], {
    libraryFiles: {
      page: async () => ({ rows: [structuredClone(stored)], more: false }),
      saveMatch: async (_agent: string, _file: string, _row: number, match: StoredSourceRow['match']) => {
        saves++; stored.match = match; stored.version++;
      },
    },
  });
  const response = await respond(libraryImportsRoutes(state.deps), request({ method: 'GET',
    path: '/v1/me/library-imports/{id}/rows', query: `actingSubject=${agent}` }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ rows: [{ index: 0, version: write ? 2 : 1,
    match: { kind: 'not-found', openLibraryAvailability: 'not-requested' } }], nextCursor: null });
  expect(saves).toBe(write ? 1 : 0);
  if (!write) expect(stored).toEqual(before);
  expect(state.required).toEqual(write ? [['work:read'], ['work:read', 'library:write'], ['work:read']]
    : [['work:read'], ['work:read']]);
});

test('import match retention rechecks write consent before saving a row', async () => {
  const stored = unmatchedRow(), before = structuredClone(stored);
  let saves = 0;
  const state = fixture(['work:read'], {
    account: { verify: async (_request: Request, required: readonly string[]) => {
      if (required.includes('library:write')) throw new AccountAssertionInsufficientScope('Consent changed');
      return { issuer: 'https://account.test', subject: 'reader', accountScopes: ['work:read', 'library:write'] };
    } },
    libraryFiles: { page: async () => ({ rows: [structuredClone(stored)], more: false }),
      saveMatch: async () => { saves++; } },
  });
  const response = await respond(libraryImportsRoutes(state.deps), request({ method: 'GET',
    path: '/v1/me/library-imports/{id}/rows', query: `actingSubject=${agent}` }));
  expect(response.status).toBe(401);
  expect(saves).toBe(0);
  expect(stored).toEqual(before);
});


test('retained row adoption admits library writers only with catalogue creation consent too', async () => {
  const operation = mutations.find(item => item.path.endsWith('/adoptions'))!;
  for (const createConsent of [false, true]) {
    let adoptedLookups = 0;
    const row = unmatchedRow();
    row.match = { kind: 'not-found', work: null, target: null, candidates: [], truncated: false,
      openLibraryAvailability: 'available', openLibrary: [{ workId: 'OL45804W', title: 'Book', authors: [], coverId: null }] };
    const state = fixture(['work:read', 'library:write', ...(createConsent ? ['work:create'] : [])], {
      access: { canReadAsBaselineMember: async () => true, activePrincipalId: async () => 'reader' },
      libraryFiles: { page: async () => ({ rows: [row], more: false }) },
      libraryImport: {
        withOpenLibraryWork: async (_work: string, action: () => Promise<Response>) => action(),
        adoptedOpenLibraryWork: async () => { adoptedLookups++; return work; },
      },
      sourceIntake: { replay: async () => null },
    });
    const response = await respond(libraryImportsRoutes(state.deps), request(operation));
    expect(response.status).toBe(createConsent ? 200 : 401);
    expect(adoptedLookups).toBe(createConsent ? 1 : 0);
    expect(state.required).toEqual([['work:read', 'library:write'], ['work:read', 'work:create']]);
    expect(await response.json()).toMatchObject(createConsent
      ? { work, replayed: true } : { code: 'account_assertion_denied' });
  }
});

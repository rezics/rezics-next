import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/http/app.ts';
import { createKernelAccessResolver } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { personalLibraryRoutes } from '../../src/library/personal-routes.ts';
import { admitShelfRead } from '../../src/library/shelf-admission.ts';
import { type ShelfEntry, type ShelfReads, type ShelfSummary } from '../../src/library/shelf-contract.ts';
import type { definitionRoutes } from '../../src/semantic/http/definitions.ts';
import { AuthenticationError, type Actor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountToken, admittedAccess } from '../support/admitted-access.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';
import { testTokens } from '../support/test-kernel.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof personalLibraryRoutes>;
let withoutPort: typeof app;
let access: ReturnType<typeof admittedAccess>;
const clock = () => new Date();
const accounts = { owner: newId(0x2200), other: newId(0x2201), suspended: newId(0x2200) };
const bearer = new Map<string, string>();
const fullType = `schema:${'A'.repeat(8192)}`;
const subjectId = newId(0x2200);
const baseEntry = {
  subjectId,
  state: 'in_progress' as const,
  revision: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const session = {
  id: newId(0x2200),
  subjectId,
  versionSubjectId: newId(0x2200),
  mode: 'cursor_position' as const,
  unit: 'page' as const,
  total: '100.00',
  amount: null,
  locator: 'chapter:two',
  position: '12.50',
  completedUnitCount: 0,
  state: 'active' as const,
  revision: 3,
  startedAt: '2026-01-01T00:00:00.123456Z',
  completedAt: null,
};
const shelfEntry: ShelfEntry = {
  ...baseEntry,
  lastActivityAt: '2026-01-03T00:00:00.123456Z',
  finishedAt: null,
  activeProgressSession: session,
};
const summary: ShelfSummary = {
  tabs: {
    all: { total: 8, shown: 3 },
    in_progress: { total: 4, shown: 1 },
    planned: { total: 1, shown: 1 },
    completed: { total: 1, shown: 1 },
    paused: { total: 1, shown: 0 },
    dropped: { total: 1, shown: 0 },
    collections: { total: 2, shown: 2 },
  },
};
const calls: { method: string; actor: Actor; input: unknown }[] = [];
let failure: ProblemError | AuthenticationError | null = null;
// Only the read port is injected: these assertions cover HTTP transport, not SQL shelf semantics.
const reads: ShelfReads = {
  async listShelf(actor, input) {
    calls.push({ method: 'page', actor, input });
    if (failure) throw failure;
    return {
      entries: [
        {
          ...shelfEntry,
          accountId: accounts.owner,
          transactionId: randomUUID(),
          activeProgressSession:
            shelfEntry.activeProgressSession === null
              ? null
              : {
                  ...shelfEntry.activeProgressSession,
                  accountId: accounts.owner,
                  transactionId: randomUUID(),
                  completedUnits: ['secret'],
                  subject: { private: true },
                },
        } as ShelfEntry,
      ],
      next: 'opaque-page',
    };
  },
  async summary(actor, input) {
    calls.push({ method: 'summary', actor, input });
    if (failure) throw failure;
    return summary;
  },
  async listTypes(actor, input) {
    calls.push({ method: 'types', actor, input });
    if (failure) throw failure;
    return { types: [{ type: fullType, count: 3 }], next: 'opaque-facet' };
  },
};
function mount(shelves?: () => ShelfReads) {
  const base = createApp({ pool: db.pool, tokens: testTokens(), clock, access });
  return personalLibraryRoutes(base as unknown as ReturnType<typeof definitionRoutes>, {
    pool: db.pool,
    tokens: testTokens(),
    clock,
    access: () => access,
    ...(shelves ? { shelves } : {}),
  });
}
async function get(path: string, persona = 'owner', mounted = app) {
  return mounted.handle(
    new Request(`http://kernel.test${path}`, {
      headers: persona === 'anonymous' ? {} : { authorization: `Bearer ${bearer.get(persona)!}` },
    }),
  );
}
async function json(response: Response, status = 200, code?: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const body = await response.json();
  if (code) {
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body).toMatchObject({ status, code });
  }
  return body;
}
async function progress(open: boolean) {
  await db.admin.query('DELETE FROM access.exposure_opening WHERE "group" = \'reading_progress\'');
  if (open)
    await db.admin.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id) VALUES ('reading_progress', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
      [randomUUID()],
    );
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  const composition = createKernelAccessResolver({
    pool: db.pool,
    tokens: testTokens(),
    clock,
    access: admittedAccess,
  });
  access = composition.resolveAccess({ actions: productionActions() });
  for (const [name, id] of Object.entries(accounts)) {
    await db.admin.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor',$3,$2)`,
      [routeOf(id), id, name === 'suspended' ? 'suspended' : 'active'],
    );
  }
  for (const [name, id, scopes] of [
    ['owner', accounts.owner, ['library_entry:list', 'progress_session:list', 'subject:read']],
    ['other', accounts.other, ['library_entry:list', 'progress_session:list']],
    ['libraryOnly', accounts.owner, ['library_entry:list']],
    ['progressOnly', accounts.owner, ['progress_session:list']],
    ['suspended', accounts.suspended, ['library_entry:list', 'progress_session:list']],
  ] as const)
    bearer.set(name, await accountToken({ accountId: id, clientId: 'shelf-http', scopes }));
  await db.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id) VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );
  await progress(true);
  app = mount(() => reads);
  withoutPort = mount();
});
afterAll(async () => {
  await db?.close();
});

test('shelf HTTP preserves full CURIEs and requires progress admission', async () => {
  const path = `/v1/libraryEntries?orderBy=lastActivity&direction=asc&state=in_progress&type=${encodeURIComponent(fullType)}&limit=48`;
  expect(await json(await get(path))).toEqual({ libraryEntries: [shelfEntry], next: 'opaque-page' });
  expect(calls.at(-1)).toMatchObject({
    method: 'page',
    actor: { accountId: accounts.owner },
    input: { orderBy: 'lastActivity', direction: 'asc', state: 'in_progress', type: fullType, limit: 48 },
  });
  const full = await json(await get(`${path}&view=FULL`));
  expect(full).toEqual({ libraryEntries: [{ ...shelfEntry, subject: null }], next: 'opaque-page' });
  expect(calls.at(-1)!.input).not.toHaveProperty('view');
  // Other scalar and sparse-unit BASIC values, including null sessions and finished dates, survive serialization.
  for (const active of [
    null,
    { ...session, mode: 'scalar_amount' as const, amount: '9.750', locator: null, position: null },
    { ...session, mode: 'completed_units' as const, completedUnitCount: 7, locator: null, position: null },
  ]) {
    shelfEntry.activeProgressSession = active;
    shelfEntry.finishedAt = '2026-01-04T00:00:00.123456Z';
    const body = await json(await get('/v1/libraryEntries?orderBy=finishedAt'));
    expect(body.libraryEntries[0]).toEqual(shelfEntry);
  }
  shelfEntry.activeProgressSession = session;
  shelfEntry.finishedAt = null;
  const before = calls.length;
  await json(await get(path, 'libraryOnly'), 403, 'forbidden');
  await json(await get(path, 'progressOnly'), 403, 'forbidden');
  expect(calls).toHaveLength(before);
  // Scope refusal precedes even the reading_progress gate lookup.
  const measured = await capture(db, () =>
    admitShelfRead(
      { pool: db.pool, access, clock },
      {
        kind: 'account',
        accountId: accounts.owner,
        clientId: 'shelf-http',
        scopes: ['library_entry:list'],
        requestedBy: null,
        authnEpoch: 1,
      },
      Date.now() + 5000,
    ).catch((error) => error),
  );
  expect(measured.value).toBeInstanceOf(ProblemError);
  expect(measured.capture.statements).toHaveLength(0);
  await progress(false);
  await json(await get(path), 403, 'platform_closed');
  expect(calls).toHaveLength(before);
  expect(await json(await get(`/v1/libraryShelfSummary?type=${encodeURIComponent(fullType)}`, 'libraryOnly'))).toEqual(
    summary,
  );
  expect(calls.at(-1)).toMatchObject({ method: 'summary', input: { type: fullType } });
  expect(await json(await get('/v1/libraryShelfTypes?limit=48&cursor=facet-token', 'libraryOnly'))).toEqual({
    types: [{ type: fullType, count: 3 }],
    next: 'opaque-facet',
  });
  expect(calls.at(-1)).toMatchObject({ method: 'types', input: { limit: 48, cursor: 'facet-token' } });
  // A native Global Context grant opens the closed gate using the progress scope operand.
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES (0, '00000000-0000-8000-8000-000000000000', $1, 'gate:reading_progress', '(,)', $2)`,
    [accounts.owner, randomUUID()],
  );
  await json(await get(path));
  const admittedCalls = calls.length;
  await json(await get(path, 'libraryOnly'), 403, 'forbidden');
  expect(calls).toHaveLength(admittedCalls);
  await db.admin.query(`DELETE FROM access.resource_grant WHERE action = 'gate:reading_progress'`);
  await progress(true);
  await json(await get('/v1/libraryEntries?orderBy=createdAt&cursor=page-token', 'other'));
  expect(calls.at(-1)).toMatchObject({
    actor: { accountId: accounts.other },
    input: { orderBy: 'createdAt', cursor: 'page-token', limit: 20 },
  });
  for (const code of ['invalid_argument', 'invalid_cursor', 'stale_cursor', 'deadline_exceeded'] as const) {
    failure = new ProblemError(code);
    for (const endpoint of [
      '/v1/libraryEntries?orderBy=createdAt&type=schema:Unknown',
      '/v1/libraryShelfSummary?type=schema:Unknown',
      '/v1/libraryShelfTypes?cursor=bad',
    ])
      await json(await get(endpoint), code === 'stale_cursor' ? 409 : code === 'deadline_exceeded' ? 503 : 400, code);
  }
  failure = new AuthenticationError(401, 'Bearer');
  await json(await get('/v1/libraryEntries?orderBy=createdAt'), 401, 'authentication_required');
  failure = null;
});

test('shelf port transport keeps old entries and rejects closed queries and unauthenticated callers', async () => {
  const secondId = newId(0x2200);
  for (const [id, updated] of [
    [subjectId, '2026-01-02T00:00:00Z'],
    [secondId, '2026-01-03T00:00:00Z'],
  ])
    await db.admin.query(
      `INSERT INTO library.entry(route, account_id, subject_id, state, revision, created_at, updated_at, transaction_id) VALUES ($1,$2,$3,'in_progress',2,'2026-01-01T00:00:00Z',$4,$5)`,
      [routeOf(accounts.owner), accounts.owner, id, updated, randomUUID()],
    );
  await progress(false);
  const old = {
    libraryEntries: [{ ...baseEntry, subjectId: secondId, updatedAt: '2026-01-03T00:00:00.000Z' }, baseEntry],
    next: null,
  };
  expect(await json(await get('/v1/libraryEntries', 'libraryOnly'))).toEqual(old);
  expect(await json(await get('/v1/libraryEntries', 'libraryOnly', withoutPort))).toEqual(old);
  const before = calls.length;
  for (const query of [
    'direction=asc',
    'type=schema:Book',
    'orderBy=random',
    'orderBy=createdAt&typeKey=uuid',
    'orderBy=createdAt&unknown=x',
    'orderBy=createdAt&limit=101',
    'orderBy=createdAt&direction=up',
    'orderBy=createdAt&view=SECRET',
    'orderBy=createdAt&cursor=' + 'a'.repeat(4097),
  ])
    await json(await get(`/v1/libraryEntries?${query}`), 400, 'invalid_request');
  for (const path of [
    '/v1/libraryShelfSummary?state=planned',
    '/v1/libraryShelfTypes?type=schema:Book',
    '/v1/libraryShelfTypes?limit=0',
  ])
    await json(await get(path), 400, 'invalid_request');
  for (const path of ['/v1/libraryEntries?orderBy=createdAt', '/v1/libraryShelfSummary', '/v1/libraryShelfTypes']) {
    await json(await get(path, 'anonymous'), 401, 'authentication_required');
    await json(await get(path, 'suspended'), 401, 'authentication_required');
    await json(await get(path, 'progressOnly'), 403, 'forbidden');
  }
  expect(calls).toHaveLength(before);
  await progress(true);
  // Missing wiring explicitly fails; never manufacture a successful empty shelf.
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const path of ['/v1/libraryEntries?orderBy=createdAt', '/v1/libraryShelfSummary', '/v1/libraryShelfTypes'])
      await json(await get(path, 'owner', withoutPort), 500, 'internal_error');
    expect(errors.mock.calls.map(([event]) => JSON.parse(event).name)).toEqual([
      'ShelfContractNotImplementedError',
      'ShelfContractNotImplementedError',
      'ShelfContractNotImplementedError',
    ]);
  } finally {
    errors.mockRestore();
  }
  const document = openApiDocument(app);
  for (const path of ['/v1/libraryEntries', '/v1/libraryShelfSummary', '/v1/libraryShelfTypes']) {
    expect(document.paths[path]?.get?.['x-exposure']).toBe('gate:personal_library');
    expect(document.paths[path]?.get?.['x-action']).toBe('library_entry:list');
  }
  expect(document.paths['/v1/libraryEntries']?.get?.operationId).toBe('library_entry.list');
});

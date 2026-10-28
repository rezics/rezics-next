import { expect, test } from 'bun:test';
import type { LibraryProfile } from '@rezics/definitions';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

// Native executable specification; no replacement release, transport, policy or Continue implementation.
type World = ReleasedDiscoveryFixture;
type Owner = 'alice' | 'bob';
type BasicSession = {
  id: string;
  subjectId: string;
  versionSubjectId: string | null;
  mode: string;
  unit: string;
  total: string | null;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: string;
  revision: number;
  startedAt: string;
  completedAt: string | null;
};
type Row = {
  subjectId: string;
  state: string | null;
  lastActivityAt: string;
  activeProgressSession: BasicSession | null;
};
type Page = { subjects: Row[]; next: string | null };
const sessionKeys = [
  'id',
  'subjectId',
  'versionSubjectId',
  'mode',
  'unit',
  'total',
  'amount',
  'locator',
  'position',
  'completedUnitCount',
  'state',
  'revision',
  'startedAt',
  'completedAt',
].sort();

async function world(run: (fixture: World) => Promise<void>) {
  const fixture = await createReleasedDiscoveryFixture({ version: 1 });
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

function status(response: HttpResponse, expected: number, operation: string) {
  expect(response.status, `${operation}: ${response.status} ${JSON.stringify(response.body)}`).toBe(expected);
}

function profile(f: World, type: string): LibraryProfile {
  const reference = f.release.definition.types[type]?.library;
  expect(
    reference,
    `Bundled ${f.release.digest}: ${type} must reference its actual accepting Library profile`,
  ).toBeDefined();
  const accepted = f.release.definition.libraryProfiles?.[reference!.profileId];
  expect(accepted, `Bundled ${f.release.digest}: missing registry entry ${reference!.profileId}`).toBeDefined();
  expect(accepted!.id).toBe(reference!.profileId);
  return accepted!;
}

function stateChoice(f: World, type: string, role: 'active' | 'completed' | 'planned', renamed = false): string {
  const accepted = profile(f, type);
  const choice = accepted.entryStateSet?.states.find(
    (state) => state.role === role && (!renamed || state.id !== 'in_progress'),
  );
  expect(
    choice,
    `Bundled ${f.release.digest} ${type}/${accepted.id}: required ${role} state${renamed ? ' other than in_progress' : ''}`,
  ).toBeDefined();
  return choice!.id;
}

function scalar(f: World, type: string) {
  const accepted = profile(f, type);
  const pair = accepted.progress?.allowed.find((choice) => choice.mode === 'scalar_amount');
  const unit = pair?.units.find((choice) => choice.totalPolicy !== 'required');
  expect(
    unit,
    `Bundled ${f.release.digest} ${type}/${accepted.id}: required actual scalar unit without mandatory total`,
  ).toBeDefined();
  return { mode: 'scalar_amount', unit: unit!.id, amount: unit!.minimum ?? '0' };
}

async function put(f: World, subject: CreatedSubject, state: string, owner: Owner = 'alice') {
  const response = await f.request(owner, 'PUT', `/v1/libraryEntries/${subject.id}`, { state }, discoveryKey());
  status(response, 201, `Set ${owner} actual released state ${state}`);
  return response.body.libraryEntry as { subjectId: string; state: string; revision: number; incarnationId?: string };
}

async function start(f: World, subject: CreatedSubject, type: string, owner: Owner = 'alice') {
  const { mode, unit } = scalar(f, type);
  const response = await f.request(
    owner,
    'POST',
    '/v1/progressSessions',
    { subjectId: subject.id, mode, unit },
    discoveryKey(),
  );
  status(response, 201, `Start ${owner} actual released ${type} ${mode}/${unit}`);
  return response.body.progressSession as BasicSession;
}

async function transition(f: World, session: BasicSession, action: 'record' | 'complete', amount?: string) {
  const response = await f.request(
    'alice',
    'POST',
    `/v1/progressSessions/${session.id}:${action}`,
    { revision: session.revision, ...(action === 'record' ? { amount } : {}) },
    discoveryKey(),
  );
  status(response, 200, `Native progress ${action}`);
  return response.body.progressSession as BasicSession;
}

function page(response: HttpResponse): Page {
  status(response, 200, 'GET /v1/libraryContinue');
  expect(Object.keys(response.body).sort()).toEqual(['next', 'subjects']);
  expect(Array.isArray(response.body.subjects)).toBe(true);
  const value = response.body as Page;
  expect(value.next === null || typeof value.next === 'string').toBe(true);
  expect(response.headers.get('cache-control')).toContain('private');
  expect(response.headers.get('cache-control')).toContain('no-store');
  for (const row of value.subjects) {
    expect(Object.keys(row).sort()).toEqual(['activeProgressSession', 'lastActivityAt', 'state', 'subjectId']);
    expect(typeof row.subjectId).toBe('string');
    expect(row.state === null || typeof row.state === 'string').toBe(true);
    expect(row.lastActivityAt).toMatch(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/);
    if (row.activeProgressSession !== null) {
      expect(Object.keys(row.activeProgressSession).sort()).toEqual(sessionKeys);
      expect(row.activeProgressSession.state).toBe('active');
    }
  }
  expect(new Set(value.subjects.map((row) => row.subjectId)).size).toBe(value.subjects.length);
  return value;
}

async function read(f: World, query = '', owner: DiscoveryPersona = 'alice') {
  return page(await f.request(owner, 'GET', `/v1/libraryContinue${query}`));
}

function problem(response: HttpResponse, expected: number, code: string) {
  status(response, expected, code);
  expect(response.body.code).toBe(code);
}

async function noEntry(f: World, subject: CreatedSubject) {
  problem(await f.request('alice', 'GET', `/v1/libraryEntries/${subject.id}`), 404, 'not_found');
}

test(
  'Continue uses actual accepted active profile roles and session activity across released Library subjects without requiring an entry or coupling independent facts',
  () =>
    world(async (f) => {
      const active = stateChoice(f, 'schema:Book', 'active', true);
      const completed = stateChoice(f, 'schema:Book', 'completed');
      const stateOnly = await f.createSubject('schema:Book', 'Active role with non-fixed state ID');
      const book = await f.createSubject('schema:Book', 'Session-only Book');
      const recipe = await f.createSubject('schema:Recipe', 'Session-only Recipe');
      const history = await f.createSubject('schema:Book', 'Completed-only history');
      const terminalState = await f.createSubject('schema:Book', 'Completed state only');
      const holding = await f.createSubject('schema:Book', 'Holding only');
      const following = await f.createSubject('schema:Book', 'Follow only');
      const labelled = await f.createSubject('schema:Book', 'Label only');
      const foreign = await f.createSubject('schema:Book', 'Bob activity only');
      await put(f, stateOnly, active);
      await put(f, terminalState, completed);
      const bookSession = await start(f, book, 'schema:Book');
      const recipeSession = await start(f, recipe, 'schema:Recipe');
      await transition(f, await start(f, history, 'schema:Book'), 'complete');
      await start(f, foreign, 'schema:Book', 'bob');
      const accepted = profile(f, 'schema:Book');
      const kind = accepted.copies?.kinds.find((choice) => choice.statuses.length > 0);
      expect(kind, `Bundled ${f.release.digest}: actual holding kind/status required`).toBeDefined();
      status(
        await f.request(
          'alice',
          'POST',
          '/v1/copies',
          {
            subjectId: holding.id,
            kind: kind!.id,
            status: kind!.statuses[0]!.id,
          },
          discoveryKey(),
        ),
        201,
        'Create holding-only control',
      );
      status(
        await f.request('alice', 'PUT', `/v1/follows/${following.id}`, undefined, discoveryKey()),
        200,
        'Follow-only control',
      );
      const label = await f.request(
        'alice',
        'POST',
        '/v1/libraryLabels',
        { name: 'Continue exclusion control' },
        discoveryKey(),
      );
      status(label, 201, 'Create native label');
      const labelId = (label.body.label as { id: string }).id;
      status(
        await f.request(
          'alice',
          'POST',
          `/v1/libraryLabels/${labelId}:assign`,
          { subjectId: labelled.id },
          discoveryKey(),
        ),
        200,
        'Assign label-only control',
      );
      const result = await read(f);
      expect(result.next).toBeNull();
      expect(result.subjects.map((row) => row.subjectId).sort()).toEqual([stateOnly.id, book.id, recipe.id].sort());
      expect(result.subjects.find((row) => row.subjectId === stateOnly.id)).toMatchObject({
        state: active,
        activeProgressSession: null,
      });
      expect(result.subjects.find((row) => row.subjectId === book.id)).toMatchObject({
        state: null,
        activeProgressSession: bookSession,
      });
      expect(result.subjects.find((row) => row.subjectId === recipe.id)).toMatchObject({
        state: null,
        activeProgressSession: recipeSession,
      });
      await noEntry(f, book);
      await noEntry(f, recipe);
    }),
  180_000,
);

test(
  'Continue start record complete and state clear preserve independent native state sessions and history',
  () =>
    world(async (f) => {
      const book = await f.createSubject('schema:Book', 'Independent transitions');
      const active = stateChoice(f, 'schema:Book', 'active', true);
      const entry = await put(f, book, active);
      expect((await read(f)).subjects).toMatchObject([
        { subjectId: book.id, state: active, activeProgressSession: null },
      ]);
      const initial = await start(f, book, 'schema:Book');
      const recorded = await transition(f, initial, 'record', scalar(f, 'schema:Book').amount);
      const unchanged = await f.request('alice', 'GET', `/v1/libraryEntries/${book.id}`);
      status(unchanged, 200, 'Read independent entry after record');
      expect(unchanged.body.libraryEntry).toMatchObject(entry);
      const beforeClear = await f.request('alice', 'GET', `/v1/progressSessions/${recorded.id}/changes`);
      status(beforeClear, 200, 'Read recorded native history');
      expect(beforeClear.body.changes).toHaveLength(1);
      const clear = new URLSearchParams({ revision: String(entry.revision) });
      if (entry.incarnationId !== undefined) clear.set('incarnationId', entry.incarnationId);
      status(
        await f.request('alice', 'DELETE', `/v1/libraryEntries/${book.id}?${clear}`, undefined, discoveryKey()),
        204,
        'Clear only explicit state',
      );
      await noEntry(f, book);
      expect((await read(f)).subjects).toMatchObject([
        { subjectId: book.id, state: null, activeProgressSession: recorded },
      ]);
      const completed = await transition(f, recorded, 'complete');
      expect(completed.state).toBe('completed');
      expect((await read(f)).subjects).toEqual([]);
      const retained = await f.request('alice', 'GET', `/v1/progressSessions/${completed.id}`);
      status(retained, 200, 'Retained completed session');
      expect(retained.body.progressSession).toEqual(completed);
      const after = await f.request('alice', 'GET', `/v1/progressSessions/${completed.id}/changes`);
      status(after, 200, 'Retained exact record history');
      expect(after.body).toEqual(beforeClear.body);
      // A second subject proves completion does not clear an independently active state.
      const stateSupported = await f.createSubject('schema:Book', 'Active state survives completion');
      const independent = await put(f, stateSupported, active);
      await transition(f, await start(f, stateSupported, 'schema:Book'), 'complete');
      expect((await read(f)).subjects).toMatchObject([
        { subjectId: stateSupported.id, state: active, activeProgressSession: null },
      ]);
      const still = await f.request('alice', 'GET', `/v1/libraryEntries/${stateSupported.id}`);
      status(still, 200, 'State survives completion');
      expect(still.body.libraryEntry).toMatchObject(independent);
    }),
  180_000,
);

test(
  'Continue admits an active session alongside a non-active state and chooses native top active session after record and completion',
  () =>
    world(async (f) => {
      const book = await f.createSubject('schema:Book', 'Two independent active sessions');
      const planned = stateChoice(f, 'schema:Book', 'planned');
      await put(f, book, planned);
      const first = await start(f, book, 'schema:Book');
      const second = await start(f, book, 'schema:Book');
      expect((await read(f)).subjects).toMatchObject([
        { subjectId: book.id, state: planned, activeProgressSession: second },
      ]);
      const changedFirst = await transition(f, first, 'record', scalar(f, 'schema:Book').amount);
      expect((await read(f)).subjects).toMatchObject([
        { subjectId: book.id, state: planned, activeProgressSession: changedFirst },
      ]);
      await transition(f, changedFirst, 'complete');
      expect((await read(f)).subjects).toMatchObject([
        { subjectId: book.id, state: planned, activeProgressSession: second },
      ]);
      await transition(f, second, 'complete');
      expect((await read(f)).subjects).toEqual([]);
    }),
  180_000,
);

test(
  'Continue returns raw first and final signed pages ordered by native activity and isolates viewer and effective limit',
  () =>
    world(async (f) => {
      const a = await f.createSubject('schema:Book', 'Earlier session activity');
      const b = await f.createSubject('schema:Recipe', 'Later session activity');
      const firstSession = await start(f, a, 'schema:Book');
      await start(f, b, 'schema:Recipe');
      const bumped = await transition(f, firstSession, 'record', scalar(f, 'schema:Book').amount);
      const first = await read(f, '?limit=1');
      expect(first.subjects).toHaveLength(1);
      expect(first.subjects[0]).toMatchObject({ subjectId: a.id, state: null, activeProgressSession: bumped });
      expect(typeof first.next).toBe('string');
      expect(first.next!.length).toBeGreaterThan(0);
      const suffix = `&cursor=${encodeURIComponent(first.next!)}`;
      const final = await read(f, `?limit=1${suffix}`);
      expect(final.subjects).toHaveLength(1);
      expect(final.subjects[0]!.subjectId).toBe(b.id);
      expect(final.next).toBeNull();
      expect(new Set([...first.subjects, ...final.subjects].map((row) => row.subjectId)).size).toBe(2);
      expect((await read(f, `?limit=1${suffix}`)).subjects).toEqual(final.subjects);
      problem(await f.request('bob', 'GET', `/v1/libraryContinue?limit=1${suffix}`), 400, 'invalid_cursor');
      problem(await f.request('alice', 'GET', `/v1/libraryContinue?limit=2${suffix}`), 400, 'invalid_cursor');
      const token = first.next!;
      const tampered = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
      problem(
        await f.request('alice', 'GET', `/v1/libraryContinue?limit=1&cursor=${encodeURIComponent(tampered)}`),
        400,
        'invalid_cursor',
      );
      expect((await read(f, '', 'bob')).subjects).toEqual([]);
      expect((await read(f, '', 'outsider')).subjects).toEqual([]);
      const bobSession = await start(f, a, 'schema:Book', 'bob');
      const bob = await read(f, '', 'bob');
      expect(bob.subjects).toHaveLength(1);
      expect(bob.subjects[0]!.activeProgressSession).toEqual(bobSession);
      expect((await read(f)).subjects.map((row) => row.subjectId)).toEqual([a.id, b.id]);
    }),
  180_000,
);

test(
  'Continue has a closed query and genuine empty success without an entry or materialized owner Library',
  () =>
    world(async (f) => {
      const result = await read(f);
      expect(result).toEqual({ subjects: [], next: null });
      expect(await read(f, '?limit=100')).toEqual(result);
      for (const query of [
        `accountId=${f.personas.bob.accountId}`,
        'state=in_progress',
        'status=in_progress',
        'type=schema:Book',
        'filter=%7B%7D',
        'orderBy=lastActivityAt',
        'direction=asc',
        'view=FULL',
        'q=book',
        'limit=0',
        'limit=101',
        'limit=1.5',
        'limit=word',
      ])
        problem(await f.request('alice', 'GET', `/v1/libraryContinue?${query}`), 400, 'invalid_request');
      problem(await f.request('alice', 'GET', '/v1/libraryContinue?cursor=not-a-cursor'), 400, 'invalid_cursor');
    }),
  180_000,
);

test(
  'Continue shares default20 max100 paging over actual released active-state subjects',
  () =>
    world(async (f) => {
      const active = stateChoice(f, 'schema:Book', 'active', true);
      const ids = [];
      for (let index = 0; index < 21; index++) {
        const subject = await f.createSubject('schema:Book', `Native default-page subject ${index}`);
        await put(f, subject, active);
        ids.push(subject.id);
      }
      const first = await read(f);
      expect(first.subjects).toHaveLength(20);
      expect(typeof first.next).toBe('string');
      // Explicit default and omitted default have the same effective cursor binding.
      const last = await read(f, `?limit=20&cursor=${encodeURIComponent(first.next!)}`);
      expect(last.subjects).toHaveLength(1);
      expect(last.next).toBeNull();
      const all = [...first.subjects, ...last.subjects];
      expect(all.map((row) => row.subjectId)).toEqual(ids.toReversed());
      const maximum = await read(f, '?limit=100');
      expect(maximum.subjects).toEqual(all);
      expect(maximum.next).toBeNull();
    }),
  180_000,
);

test(
  'Continue uses native revoked pre-suspend bearer401 and unscoped403 without exposing own rows to anonymous',
  () =>
    world(async (f) => {
      const revoked = await f.request('suspended', 'GET', '/v1/libraryContinue');
      problem(revoked, 401, 'invalid_credentials');
      expect(revoked.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      const unscoped = await f.request('unscoped', 'GET', '/v1/libraryContinue');
      status(unscoped, 403, 'Empty native scope set');
      expect(unscoped.headers.get('www-authenticate')).toContain('insufficient_scope');
      expect(unscoped.body.subjects).toBeUndefined();
      const anonymous = await f.request('anonymous', 'GET', '/v1/libraryContinue');
      problem(anonymous, 401, 'authentication_required');
      expect(anonymous.body.subjects).toBeUndefined();
    }),
  180_000,
);

test(
  'Continue GET replay preserves native entry session history holding follow label and Collection responses',
  () =>
    world(async (f) => {
      const subject = await f.createSubject('schema:Book', 'Read-only Continue replay');
      const entry = await put(f, subject, stateChoice(f, 'schema:Book', 'active', true));
      const recorded = await transition(
        f,
        await start(f, subject, 'schema:Book'),
        'record',
        scalar(f, 'schema:Book').amount,
      );
      const accepted = profile(f, 'schema:Book');
      const kind = accepted.copies?.kinds.find((choice) => choice.statuses.length > 0);
      expect(kind, `Bundled ${f.release.digest}: actual read-only holding control`).toBeDefined();
      status(
        await f.request(
          'alice',
          'POST',
          '/v1/copies',
          {
            subjectId: subject.id,
            kind: kind!.id,
            status: kind!.statuses[0]!.id,
            note: 'Preserve private holding',
          },
          discoveryKey(),
        ),
        201,
        'Read-only existing holding',
      );
      status(
        await f.request('alice', 'PUT', `/v1/follows/${subject.id}`, undefined, discoveryKey()),
        200,
        'Read-only existing follow',
      );
      const label = await f.request(
        'alice',
        'POST',
        '/v1/libraryLabels',
        { name: 'Preserve existing label' },
        discoveryKey(),
      );
      status(label, 201, 'Read-only existing label');
      const labelId = (label.body.label as { id: string }).id;
      status(
        await f.request(
          'alice',
          'POST',
          `/v1/libraryLabels/${labelId}:assign`,
          { subjectId: subject.id },
          discoveryKey(),
        ),
        200,
        'Read-only existing assignment',
      );
      status(
        await f.request(
          'alice',
          'POST',
          '/v1/collections',
          {
            title: 'Preserve existing private Collection',
            visibility: 'private',
          },
          discoveryKey(),
        ),
        201,
        'Read-only existing Collection',
      );
      const paths = [
        `/v1/libraryEntries/${subject.id}`,
        `/v1/progressSessions/${recorded.id}`,
        `/v1/progressSessions?subjectId=${subject.id}`,
        `/v1/progressSessions/${recorded.id}/changes`,
        `/v1/progressSessions/${recorded.id}/completedUnits`,
        '/v1/libraryEntries',
        '/v1/copies',
        '/v1/follows',
        '/v1/libraryLabels',
        `/v1/libraryLabelAssignments?subjectId=${subject.id}`,
        `/v1/collections?curatorAccountId=${f.personas.alice.accountId}`,
      ];
      async function snapshot() {
        const bodies = [];
        for (const path of paths) {
          const response = await f.request('alice', 'GET', path);
          status(response, 200, `Read-only native snapshot ${path}`);
          // All populations here fit one page; no cursor/receipt normalization hides a domain effect.
          if ('next' in response.body) expect(response.body.next).toBeNull();
          bodies.push(response.body);
        }
        return bodies;
      }
      const before = await snapshot();
      const first = await read(f, '?limit=1');
      expect(first.subjects).toMatchObject([
        { subjectId: subject.id, state: entry.state, activeProgressSession: recorded },
      ]);
      expect(await read(f, '?limit=1')).toEqual(first);
      expect(await snapshot()).toEqual(before);
    }),
  180_000,
);

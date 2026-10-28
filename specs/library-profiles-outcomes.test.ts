import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LibraryProfilePersona,
  LibraryProfilesDriver,
  LibraryProfilesFixture,
  ProfileCompilation,
  ProfileMigrationBoundary,
  ProfileReleaseScenario,
} from './library-profiles-driver.ts';

setDefaultTimeout(240_000);

let driver: LibraryProfilesDriver;
let fixture: LibraryProfilesFixture;

beforeEach(async () => {
  const location = process.env.LIBRARY_PROFILES_DRIVER;
  if (!location) throw new Error('Library profile outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_PROFILES_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_PROFILES_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryProfilesDriver !== 'function')
    throw new Error('Expected createLibraryProfilesDriver factory');
  driver = await binding.createLibraryProfilesDriver();
  fixture = await driver.fixture();
});

afterEach(async () => {
  const current = driver;
  driver = undefined!;
  fixture = undefined!;
  await current?.close();
});

const idempotencyKey = () => `"${randomUUID()}"`;
const body = (response: Response) => response.json() as Promise<Record<string, any>>;

function api(
  persona: LibraryProfilePersona,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  requestBody?: unknown,
  key?: string,
) {
  return driver.request(fixture, persona, method, path, requestBody, key ? { 'Idempotency-Key': key } : undefined);
}

async function requireRelease(scenario: ProfileReleaseScenario) {
  const result = await driver.compile(scenario);
  if (!result.valid) throw new Error(`Expected ${scenario} fixture to compile: ${JSON.stringify(result.errors)}`);
  expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  return result;
}

async function publish(scenario: ProfileReleaseScenario) {
  const compiled = await requireRelease(scenario);
  const response = await api(
    'steward',
    'POST',
    '/v1/definitions/releases',
    { release: compiled.release },
    idempotencyKey(),
  );
  expect([200, 201]).toContain(response.status);
  expect(await body(response)).toEqual({ digest: compiled.digest });
  const reread = await api('anonymous', 'GET', `/v1/definitions/releases/${compiled.digest}`);
  expect(reread.status).toBe(200);
  expect(await body(reread)).toMatchObject({ digest: compiled.digest, release: compiled.release });
  return compiled;
}

async function active() {
  const response = await api('anonymous', 'GET', '/v1/definitions/active');
  expect(response.status).toBe(200);
  return (await body(response)) as { digest: string; head: number };
}

async function activate(digest: string, expectedHead?: number) {
  const before = await active();
  const response = await api(
    'steward',
    'POST',
    `/v1/definitions/releases/${digest}:activate`,
    { expected_head: expectedHead ?? before.head },
    idempotencyKey(),
  );
  expect(response.status).toBe(200);
  return body(response);
}

async function setupProfiles(scenario: ProfileReleaseScenario = 'profile-v1') {
  const compiled = await publish(scenario);
  await activate(compiled.digest);
  return compiled;
}

async function entry(subjectId: string, state: string, key = idempotencyKey(), revision?: number) {
  return api(
    'owner',
    'PUT',
    `/v1/libraryEntries/${subjectId}`,
    { state, ...(revision === undefined ? {} : { revision }) },
    key,
  );
}

async function session(input: Record<string, unknown>, key = idempotencyKey()) {
  return api('owner', 'POST', '/v1/progressSessions', input, key);
}

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await body(response)).toMatchObject({ status, code, effect_status: 'not_applied' });
}

async function expectNoProfileMetadata(response: Response) {
  const text = JSON.stringify(await response.clone().json());
  for (const key of ['pin', 'profilePin', 'profileId', 'releaseDigest', 'acceptingType']) {
    expect(text).not.toContain(key);
  }
}

function sameUserEntry(row: Record<string, any>) {
  const { pin: _pin, ...userRow } = row;
  return userRow;
}

function sameUserSession(row: Record<string, any>) {
  const { pin: _pin, ...userRow } = row;
  return userRow;
}

function sameUserCopy(row: Record<string, any>) {
  const { pin: _pin, kind: _kind, ...userRow } = row;
  return userRow;
}

test('profiled personal facts preserve release pins and legacy values through migration and replay', async () => {
  await driver.seedLegacyFacts(fixture);
  const before = await driver.inspect(fixture);
  const oldReceipts = structuredClone(before.receipts);
  const oldEntries = before.entries.map(sameUserEntry);
  const oldSessions = before.sessions.map(sameUserSession);
  const oldCopies = before.copies.map(sameUserCopy);

  const first = await setupProfiles();
  await driver.migrateOwner(fixture, first.digest);
  const migrated = await driver.inspect(fixture);
  expect(migrated.entries.map(sameUserEntry)).toEqual(oldEntries);
  expect(migrated.sessions.map(sameUserSession)).toEqual(oldSessions);
  expect(migrated.copies.map(sameUserCopy)).toEqual(oldCopies);
  expect(migrated.receipts).toEqual(oldReceipts);
  for (const row of [...migrated.entries, ...migrated.sessions, ...migrated.copies]) {
    expect(row.pin).toEqual({
      provenance: 'legacy',
      releaseDigest: first.digest,
      acceptingType: null,
      profileId: 'legacy-fixed-v1',
    });
  }

  const subjectId = await driver.provisionSubject(fixture, 'game');
  const key = idempotencyKey();
  const original = await entry(subjectId, 'planned', key);
  expect(original.status).toBe(201);
  const originalBody = await body(original);
  const second = await publish('profile-v2-changed-ids');
  await activate(second.digest);
  const replay = await entry(subjectId, 'planned', key);
  expect(replay.status).toBe(original.status);
  expect(await body(replay)).toEqual(originalBody);
  const afterReplay = await driver.inspect(fixture);
  expect(afterReplay.entries.find((row) => row.subjectId === subjectId)?.pin).toEqual({
    provenance: 'profile',
    releaseDigest: first.digest,
    acceptingType: expect.any(String),
    profileId: expect.any(String),
  });
  expect(afterReplay.receipts.find((receipt) => receipt.requestKey === key)?.digest).toEqual(expect.any(String));
});

test('definition publication is immutable and profile activation or rollback never changes fact pins', async () => {
  const first = await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  expect((await entry(subjectId, 'planned')).status).toBe(201);
  const before = await driver.inspect(fixture);
  const originalPin = before.entries.find((row) => row.subjectId === subjectId)?.pin;
  const oldHead = await active();

  const second = await publish('profile-v2-changed-ids');
  expect(await active()).toEqual(oldHead);
  await activate(second.digest, oldHead.head);
  expect((await active()).digest).toBe(second.digest);
  const afterChange = await driver.inspect(fixture);
  expect(afterChange.entries.find((row) => row.subjectId === subjectId)?.pin).toEqual(originalPin);

  await activate(first.digest, (await active()).head);
  expect((await active()).digest).toBe(first.digest);
  const afterRollback = await driver.inspect(fixture);
  expect(afterRollback.entries.find((row) => row.subjectId === subjectId)?.pin).toEqual(originalPin);

  const stale = await api(
    'steward',
    'POST',
    `/v1/definitions/releases/${second.digest}:activate`,
    { expected_head: oldHead.head },
    idempotencyKey(),
  );
  await expectProblem(stale, 409, 'stale_editorial_head');
});

test('game recipe and record profiles are data-only and bundled book and anime profiles stay valid', async () => {
  await setupProfiles('profile-fixture-verticals');
  for (const vertical of ['game', 'recipe', 'record', 'book', 'anime'] as const) {
    const subjectId = await driver.provisionSubject(fixture, vertical);
    const response = await entry(subjectId, 'planned');
    expect(response.status).toBe(201);
  }
  const rows = (await driver.inspect(fixture)).entries;
  expect(rows).toHaveLength(5);
  expect(new Set(rows.map((row) => row.pin?.profileId)).size).toBe(5);
  expect(rows.every((row) => row.pin?.provenance === 'profile')).toBe(true);
});

test('nearest complete inherited profile wins while incompatible repeated profile IDs fail compilation', async () => {
  const nearest = await driver.compile('profile-inheritance-nearest');
  expect(nearest.valid).toBe(true);
  if (nearest.valid) {
    const published = await api(
      'steward',
      'POST',
      '/v1/definitions/releases',
      { release: nearest.release },
      idempotencyKey(),
    );
    expect([200, 201]).toContain(published.status);
    const before = await active();
    await activate(nearest.digest, before.head);
    const subjectId = await driver.provisionSubject(fixture, 'inheritance-child');
    const acceptingType = await driver.readAcceptingType(fixture, subjectId);
    const compiledTypes = nearest.release.types as Record<string, { library?: { profileId: string } }>;
    const expectedProfileId = compiledTypes[acceptingType]?.library?.profileId;
    expect(expectedProfileId).toBeDefined();
    expect((await entry(subjectId, 'planned')).status).toBe(201);
    const row = (await driver.inspect(fixture)).entries.find((item) => item.subjectId === subjectId);
    expect(row?.pin).toMatchObject({ acceptingType, profileId: expectedProfileId, releaseDigest: nearest.digest });
  }

  const conflict = await driver.compile('profile-inheritance-conflict');
  expect(conflict.valid).toBe(false);
  if (!conflict.valid) expect(conflict.errors.length).toBeGreaterThan(0);
});

test('profile absence does not grant People or Concepts new profiled state values', async () => {
  await setupProfiles('profile-absent');
  for (const vertical of ['people', 'concept'] as const) {
    const subjectId = await driver.provisionSubject(fixture, vertical);
    const before = await driver.inspect(fixture);
    await expectProblem(await entry(subjectId, 'planned'), 422, 'unsupported_library_profile');
    const after = await driver.inspect(fixture);
    expect(after.entries).toEqual(before.entries);
    expect(after.receipts).toEqual(before.receipts);
  }
});

test('changed and removed IDs remain readable from their stored release and fail for fresh writes', async () => {
  const first = await setupProfiles();
  const changedIdSubject = await driver.provisionSubject(fixture, 'game');
  const removedIdSubject = await driver.provisionSubject(fixture, 'game');
  expect((await entry(changedIdSubject, 'in_progress')).status).toBe(201);
  expect((await entry(removedIdSubject, 'planned')).status).toBe(201);
  const firstEntries = (await driver.inspect(fixture)).entries;
  const changedIdPin = firstEntries.find((row) => row.subjectId === changedIdSubject)?.pin;
  const removedIdPin = firstEntries.find((row) => row.subjectId === removedIdSubject)?.pin;
  expect(changedIdPin?.releaseDigest).toBe(first.digest);
  expect(removedIdPin?.releaseDigest).toBe(first.digest);

  const changed = await publish('profile-v2-changed-ids');
  await activate(changed.digest);
  const changedRead = await api('owner', 'GET', `/v1/libraryEntries/${changedIdSubject}`);
  expect(changedRead.status).toBe(200);
  expect(await body(changedRead)).toMatchObject({ libraryEntry: { state: 'in_progress' } });
  expect((await driver.inspect(fixture)).entries.find((row) => row.subjectId === changedIdSubject)?.pin).toEqual(
    changedIdPin,
  );
  await expectProblem(await entry(changedIdSubject, 'in_progress'), 422, 'unsupported_library_profile');
  const newIdSubject = await driver.provisionSubject(fixture, 'game');
  expect((await entry(newIdSubject, 'reading')).status).toBe(201);
  expect(
    (await driver.inspect(fixture)).entries.find((row) => row.subjectId === newIdSubject)?.pin?.releaseDigest,
  ).toBe(changed.digest);

  const removed = await publish('profile-v3-removed-ids');
  await activate(removed.digest);
  const removedRead = await api('owner', 'GET', `/v1/libraryEntries/${removedIdSubject}`);
  expect(removedRead.status).toBe(200);
  expect(await body(removedRead)).toMatchObject({ libraryEntry: { state: 'planned' } });
  expect((await driver.inspect(fixture)).entries.find((row) => row.subjectId === removedIdSubject)?.pin).toEqual(
    removedIdPin,
  );
  await expectProblem(await entry(removedIdSubject, 'planned'), 422, 'unsupported_library_profile');
});

test('callers cannot submit a legacy pin or an old release pin as new fact metadata', async () => {
  await setupProfiles('profile-absent');
  const subjectId = await driver.provisionSubject(fixture, 'people');
  const before = await driver.inspect(fixture);
  const response = await api(
    'owner',
    'PUT',
    `/v1/libraryEntries/${subjectId}`,
    {
      state: 'planned',
      profilePin: {
        provenance: 'legacy',
        releaseDigest: 'sha256:' + '0'.repeat(64),
        acceptingType: null,
        profileId: 'legacy-fixed-v1',
      },
    },
    idempotencyKey(),
  );
  await expectProblem(response, 400, 'invalid_request');
  expect((await driver.inspect(fixture)).entries).toEqual(before.entries);
});

test('fresh copy creation requires a declared kind and never defaults to legacy-unspecified', async () => {
  await setupProfiles('profile-fixture-verticals');
  const subjectId = await driver.provisionSubject(fixture, 'record');
  const before = await driver.inspect(fixture);
  const response = await api('owner', 'POST', '/v1/copies', { subjectId, status: 'owned' }, idempotencyKey());
  await expectProblem(response, 400, 'invalid_request');
  expect((await driver.inspect(fixture)).copies).toEqual(before.copies);
});

test('fresh state unit kind and status IDs are checked as profile data', async () => {
  await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  const before = await driver.inspect(fixture);
  await expectProblem(await entry(subjectId, 'not_declared_state'), 422, 'unsupported_library_profile');
  await expectProblem(
    await session({ subjectId, mode: 'scalar_amount', unit: 'not_declared_unit' }),
    422,
    'unsupported_library_profile',
  );
  await expectProblem(
    await api(
      'owner',
      'POST',
      '/v1/copies',
      {
        subjectId,
        kind: 'not_declared_kind',
        status: 'owned',
      },
      idempotencyKey(),
    ),
    422,
    'unsupported_library_profile',
  );
  await expectProblem(
    await api(
      'owner',
      'POST',
      '/v1/copies',
      {
        subjectId,
        kind: 'physical',
        status: 'not_declared_status',
      },
      idempotencyKey(),
    ),
    422,
    'unsupported_library_profile',
  );
  const after = await driver.inspect(fixture);
  expect(after.entries).toEqual(before.entries);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.copies).toEqual(before.copies);
  expect(after.receipts).toEqual(before.receipts);
});

test('owner other anonymous and suspended personas use real authorization for private library facts', async () => {
  await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  expect((await entry(subjectId, 'planned')).status).toBe(201);
  const own = await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`);
  expect(own.status).toBe(200);
  for (const persona of ['other', 'anonymous', 'suspended'] as const) {
    const denied = await api(persona, 'GET', `/v1/libraryEntries/${subjectId}`);
    expect([401, 403, 404]).toContain(denied.status);
    expect(JSON.stringify(await body(denied))).not.toContain('planned');
  }
});

test('authorized exact receipts replay before current subject membership validation and changed bodies conflict', async () => {
  await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  const key = idempotencyKey();
  const original = await entry(subjectId, 'planned', key);
  expect(original.status).toBe(201);
  const originalBody = await body(original);
  await driver.revokeSubjectRead(fixture, subjectId);

  const replay = await entry(subjectId, 'planned', key);
  expect(replay.status).toBe(original.status);
  expect(await body(replay)).toEqual(originalBody);
  await expectProblem(await entry(subjectId, 'completed', key), 422, 'idempotency_conflict');
});

test('release change preserves an authorized exact replay but current authorization revocation denies it', async () => {
  const first = await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  const key = idempotencyKey();
  const original = await entry(subjectId, 'planned', key);
  const originalBody = await body(original);
  const second = await publish('profile-v2-changed-ids');
  await activate(second.digest);
  const replay = await entry(subjectId, 'planned', key);
  expect(replay.status).toBe(original.status);
  expect(await body(replay)).toEqual(originalBody);
  expect((await driver.inspect(fixture)).entries.find((row) => row.subjectId === subjectId)?.pin?.releaseDigest).toBe(
    first.digest,
  );

  await driver.revoke(fixture, 'owner', 'library_entry:update', subjectId);
  const denied = await entry(subjectId, 'planned', key);
  expect([401, 403, 404]).toContain(denied.status);
  expect(JSON.stringify(await body(denied))).not.toContain(originalBody.libraryEntry?.state ?? 'planned');
});

test('all 18 legacy progress mode and unit pairs survive migration unchanged', async () => {
  await driver.seedLegacyFacts(fixture);
  const before = await driver.inspect(fixture);
  const expectedModes = ['scalar_amount', 'cursor_position', 'completed_units'];
  const expectedUnits = ['page', 'chapter', 'episode', 'volume', 'minute', 'percent'];
  const pairs = before.sessions.map(({ mode, unit }) => `${mode}/${unit}`).sort();
  expect(pairs).toEqual(expectedModes.flatMap((mode) => expectedUnits.map((unit) => `${mode}/${unit}`)).sort());

  const release = await setupProfiles();
  await driver.migrateOwner(fixture, release.digest);
  const after = await driver.inspect(fixture);
  expect(after.sessions.map(({ mode, unit }) => `${mode}/${unit}`).sort()).toEqual(pairs);
  expect(after.sessions.map(sameUserSession)).toEqual(before.sessions.map(sameUserSession));
});

test('legacy decimal parsing keeps twelve integer and six fraction digits when precision is absent', async () => {
  await driver.seedLegacyFacts(fixture);
  const before = await driver.inspect(fixture);
  const boundary = before.sessions.find((row) => row.mode === 'scalar_amount' && row.unit === 'page');
  expect(boundary).toBeDefined();
  const change = before.changes.find((row) => row.sessionId === boundary?.id);
  expect(change?.intent).toEqual({ amount: '999999999999.999999' });

  const release = await setupProfiles();
  await driver.migrateOwner(fixture, release.digest);
  const after = await driver.inspect(fixture);
  expect(after.changes.find((row) => row.sessionId === boundary?.id)?.intent).toEqual(change?.intent);
  expect(after.sessions.find((row) => row.id === boundary?.id)?.pin?.provenance).toBe('legacy');
});

test('numeric profile bounds compare decimal strings exactly and scalar percent alone caps at one hundred', async () => {
  await setupProfiles('profile-numeric-boundaries');
  const subjectId = await driver.provisionSubject(fixture, 'game');
  const scalar = await session({ subjectId, mode: 'scalar_amount', unit: 'percent', total: '100' });
  expect(scalar.status).toBe(201);
  const scalarId = (await body(scalar)).progressSession.id as string;
  expect(
    (await api('owner', 'POST', `/v1/progressSessions/${scalarId}:record`, { amount: '100' }, idempotencyKey())).status,
  ).toBe(200);

  const cursor = await session({ subjectId, mode: 'cursor_position', unit: 'percent' });
  expect(cursor.status).toBe(201);
  const cursorId = (await body(cursor)).progressSession.id as string;
  expect(
    (
      await api(
        'owner',
        'POST',
        `/v1/progressSessions/${cursorId}:record`,
        {
          locator: 'opaque:chapter-1',
          position: '1000.000001',
        },
        idempotencyKey(),
      )
    ).status,
  ).toBe(200);
  await expectProblem(
    await api('owner', 'POST', `/v1/progressSessions/${scalarId}:record`, { amount: '100.000001' }, idempotencyKey()),
    400,
    'invalid_request',
  );

  const bounded = await session({ subjectId, mode: 'scalar_amount', unit: 'page' });
  expect(bounded.status).toBe(201);
  const boundedId = (await body(bounded)).progressSession.id as string;
  expect(
    (
      await api(
        'owner',
        'POST',
        `/v1/progressSessions/${boundedId}:record`,
        {
          amount: '999999999999.999999',
        },
        idempotencyKey(),
      )
    ).status,
  ).toBe(200);
  await expectProblem(
    await api(
      'owner',
      'POST',
      `/v1/progressSessions/${boundedId}:record`,
      { amount: '1000000000000' },
      idempotencyKey(),
    ),
    400,
    'invalid_request',
  );
});

test('sparse completed-unit identity preserves exact opaque keys and never fills ordinal ranges', async () => {
  await setupProfiles('profile-fixture-verticals');
  const subjectId = await driver.provisionSubject(fixture, 'record');
  const created = await session({ subjectId, mode: 'completed_units', unit: 'track' });
  expect(created.status).toBe(201);
  const sessionId = (await body(created)).progressSession.id as string;
  const changed = await api(
    'owner',
    'POST',
    `/v1/progressSessions/${sessionId}:record`,
    { add: ['1', '3', '7'] },
    idempotencyKey(),
  );
  expect(changed.status).toBe(200);
  const units = await api('owner', 'GET', `/v1/progressSessions/${sessionId}/completedUnits?limit=100`);
  expect(units.status).toBe(200);
  expect(await body(units)).toMatchObject({ completedUnits: ['1', '3', '7'] });
  const inspect = await driver.inspect(fixture);
  expect(inspect.completedUnits.filter((row) => row.sessionId === sessionId).map((row) => row.unitId)).toEqual([
    '1',
    '3',
    '7',
  ]);
});

test('copy migration preserves four statuses and marks kind legacy-unspecified without inferring rights', async () => {
  await driver.seedLegacyFacts(fixture);
  const before = await driver.inspect(fixture);
  expect(before.copies.map((row) => row.status).sort()).toEqual(['disposed', 'lent', 'ordered', 'owned']);
  const release = await setupProfiles();
  await driver.migrateOwner(fixture, release.digest);
  const after = await driver.inspect(fixture);
  expect(after.copies.map((row) => row.status).sort()).toEqual(['disposed', 'lent', 'ordered', 'owned']);
  expect(after.copies.every((row) => row.kind === 'legacy-unspecified')).toBe(true);
  expect(after.copies.map(sameUserCopy)).toEqual(before.copies.map(sameUserCopy));
});

test('two holdings of one book edition keep independent copy IDs and update history', async () => {
  await setupProfiles('profile-fixture-verticals');
  const subjectId = await driver.provisionSubject(fixture, 'book-edition');
  const first = await api(
    'owner',
    'POST',
    '/v1/copies',
    { subjectId, kind: 'physical', status: 'owned' },
    idempotencyKey(),
  );
  const second = await api(
    'owner',
    'POST',
    '/v1/copies',
    { subjectId, kind: 'physical', status: 'owned' },
    idempotencyKey(),
  );
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const firstBody = await body(first);
  const secondBody = await body(second);
  expect(firstBody.copy.id).not.toBe(secondBody.copy.id);
  const copies = (await driver.inspect(fixture)).copies.filter((row) => row.subjectId === subjectId);
  expect(copies.map((row) => row.id).sort()).toEqual([firstBody.copy.id, secondBody.copy.id].sort());
  expect(copies.every((row) => row.pin?.provenance === 'profile')).toBe(true);
});

test('exclusive state does not create or couple independent labels sessions holdings or ratings', async () => {
  await setupProfiles('profile-fixture-verticals');
  const subjectId = await driver.provisionSubject(fixture, 'recipe');
  expect((await entry(subjectId, 'planned')).status).toBe(201);
  const label = await driver.addLabel(fixture, subjectId, 'vegetarian');
  expect([200, 201]).toContain(label.status);
  const rating = await driver.rateSubject(fixture, subjectId, 4);
  expect([200, 201]).toContain(rating.status);
  const sessionResponse = await session({ subjectId, mode: 'scalar_amount', unit: 'minute' });
  expect(sessionResponse.status).toBe(201);
  const copyResponse = await api(
    'owner',
    'POST',
    '/v1/copies',
    {
      subjectId,
      kind: 'physical',
      status: 'owned',
    },
    idempotencyKey(),
  );
  expect(copyResponse.status).toBe(201);
  const before = await driver.inspect(fixture);
  const row = before.entries.find((item) => item.subjectId === subjectId);
  expect(row?.state).toBe('planned');
  expect(before.independentLabels.length).toBe(1);
  expect(before.ratings.length).toBe(1);
  expect(before.sessions.filter((item) => item.subjectId === subjectId)).toHaveLength(1);
  expect(before.copies.filter((item) => item.subjectId === subjectId)).toHaveLength(1);

  expect((await entry(subjectId, 'completed', idempotencyKey(), row?.revision)).status).toBe(200);
  const after = await driver.inspect(fixture);
  expect(after.independentLabels).toEqual(before.independentLabels);
  expect(after.ratings).toEqual(before.ratings);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.copies).toEqual(before.copies);
});

test('import source declarations remain inert and create no provider adapter or import run', async () => {
  const compiled = await setupProfiles('profile-import-declaration-only');
  const before = await driver.inspect(fixture);
  expect(before.importRuns).toEqual([]);
  expect((await active()).digest).toBe(compiled.digest);
  expect((await driver.inspect(fixture)).importRuns).toEqual([]);
});

test('historic reads use their pinned release after head change and rollback', async () => {
  const first = await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  expect((await entry(subjectId, 'planned')).status).toBe(201);
  const original = await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`);
  const originalBody = await body(original);
  const second = await publish('profile-v2-changed-ids');
  await activate(second.digest);
  const changedHeadRead = await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`);
  expect(await body(changedHeadRead)).toEqual(originalBody);
  await activate(first.digest);
  const rolledBackRead = await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`);
  expect(await body(rolledBackRead)).toEqual(originalBody);
  expect((await driver.inspect(fixture)).entries.find((row) => row.subjectId === subjectId)?.pin?.releaseDigest).toBe(
    first.digest,
  );
});

test('profile pins and hidden accepting types are absent from fact responses public collections and published logs', async () => {
  const first = await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  const entryResponse = await entry(subjectId, 'planned');
  expect(entryResponse.status).toBe(201);
  await expectNoProfileMetadata(entryResponse);
  const createdSession = await session({ subjectId, mode: 'scalar_amount', unit: 'minute', total: '123.5' });
  expect(createdSession.status).toBe(201);
  await expectNoProfileMetadata(createdSession);
  const sessionId = (await body(createdSession)).progressSession.id as string;
  const recordResponse = await api(
    'owner',
    'POST',
    `/v1/progressSessions/${sessionId}:record`,
    { amount: '42.25' },
    idempotencyKey(),
  );
  await expectNoProfileMetadata(recordResponse);
  const copy = await api(
    'owner',
    'POST',
    '/v1/copies',
    {
      subjectId,
      kind: 'physical',
      status: 'owned',
      note: 'private note',
    },
    idempotencyKey(),
  );
  expect(copy.status).toBe(201);
  await expectNoProfileMetadata(copy);
  const copyId = (await body(copy)).copy.id as string;
  await expectNoProfileMetadata(await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`));
  await expectNoProfileMetadata(await api('owner', 'GET', `/v1/progressSessions/${sessionId}`));
  await expectNoProfileMetadata(await api('owner', 'GET', `/v1/copies/${copyId}`));
  const log = await api('owner', 'POST', '/v1/publishedLogs', { sessionId }, idempotencyKey());
  const logId = (await body(log)).publishedLog.id as string;
  const publicLog = await api('anonymous', 'GET', `/v1/publishedLogs/${logId}`);
  expect(publicLog.status).toBe(200);
  const publicLogText = JSON.stringify(await body(publicLog));
  expect(publicLogText).not.toContain('42.25');
  expect(publicLogText).not.toContain('123.5');
  for (const key of ['pin', 'profilePin', 'profileId', 'releaseDigest', 'acceptingType']) {
    expect(publicLogText).not.toContain(key);
  }

  const collection = await api(
    'owner',
    'POST',
    '/v1/collections',
    {
      title: 'Public subjects',
      visibility: 'public',
    },
    idempotencyKey(),
  );
  expect(collection.status).toBe(201);
  const collectionId = (await body(collection)).collection.id as string;
  expect(
    (await api('owner', 'POST', `/v1/collections/${collectionId}/members`, { subjectId }, idempotencyKey())).status,
  ).toBe(201);
  const members = await api('anonymous', 'GET', `/v1/collections/${collectionId}/members?limit=20`);
  expect(members.status).toBe(200);
  const publicMembers = JSON.stringify(await body(members));
  expect(publicMembers).toContain(subjectId);
  expect(publicMembers).not.toContain('planned');
  expect(publicMembers).not.toContain('private note');
  for (const key of ['pin', 'profilePin', 'profileId', 'releaseDigest', 'acceptingType']) {
    expect(publicMembers).not.toContain(key);
  }

  for (const [path, privateValue] of [
    [`/v1/libraryEntries/${subjectId}`, 'planned'],
    [`/v1/progressSessions/${sessionId}`, '42.25'],
    [`/v1/copies/${copyId}`, 'private note'],
  ] as const) {
    const denied = await api('other', 'GET', path);
    expect([401, 403, 404]).toContain(denied.status);
    const deniedText = JSON.stringify(await body(denied));
    expect(deniedText).not.toContain(privateValue);
    for (const key of ['pin', 'profilePin', 'profileId', 'releaseDigest', 'acceptingType']) {
      expect(deniedText).not.toContain(key);
    }
  }
  const inspected = await driver.inspect(fixture);
  for (const event of inspected.events) {
    const eventText = JSON.stringify(event);
    for (const key of ['pin', 'profilePin', 'profileId', 'releaseDigest', 'acceptingType']) {
      expect(eventText).not.toContain(key);
    }
  }
  for (const receipt of inspected.receipts) {
    const receiptText = JSON.stringify(receipt.response);
    for (const key of ['pin', 'profilePin', 'profileId', 'releaseDigest', 'acceptingType']) {
      expect(receiptText).not.toContain(key);
    }
  }
  expect((await driver.inspect(fixture)).entries.find((row) => row.subjectId === subjectId)?.pin?.releaseDigest).toBe(
    first.digest,
  );
});

test('legacy unknown values and null accepting type remain readable without consulting the current type', async () => {
  await driver.seedLegacyFacts(fixture);
  const first = await setupProfiles();
  await driver.migrateOwner(fixture, first.digest);
  const before = await driver.inspect(fixture);
  const legacy = before.entries.find((row) => row.pin?.provenance === 'legacy');
  expect(legacy?.pin).toMatchObject({ acceptingType: null, profileId: 'legacy-fixed-v1' });

  const v2 = await publish('profile-v2-changed-ids');
  await activate(v2.digest);
  const read = await api('owner', 'GET', `/v1/libraryEntries/${legacy?.subjectId}`);
  expect(read.status).toBe(200);
  expect(await body(read)).toMatchObject({ libraryEntry: { state: legacy?.state } });
  expect((await driver.inspect(fixture)).entries.find((row) => row.subjectId === legacy?.subjectId)?.pin).toEqual(
    legacy?.pin,
  );
});

test('profile writes perform one bounded lookup across three unrelated fact scales', async () => {
  await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  const measurements: {
    statements: number;
    rowsRead: number;
    rowsWritten: number;
    bytesRead: number;
    bytesWritten: number;
  }[] = [];
  for (const count of [64, 512, 4096]) {
    await driver.ensureUnrelatedFacts(fixture, count);
    const measured = await driver.measure(() => entry(subjectId, 'planned'));
    expect([200, 201]).toContain(measured.value.status);
    measurements.push(measured.sql);
  }
  expect(measurements[1]!.statements).toBe(measurements[0]!.statements);
  expect(measurements[2]!.statements).toBe(measurements[0]!.statements);
  expect(measurements[1]!.rowsRead).toBe(measurements[0]!.rowsRead);
  expect(measurements[2]!.rowsRead).toBe(measurements[0]!.rowsRead);
  expect(measurements[1]!.rowsWritten).toBe(measurements[0]!.rowsWritten);
  expect(measurements[2]!.rowsWritten).toBe(measurements[0]!.rowsWritten);
  expect(measurements[1]!.bytesRead).toBe(measurements[0]!.bytesRead);
  expect(measurements[2]!.bytesRead).toBe(measurements[0]!.bytesRead);
  expect(measurements[1]!.bytesWritten).toBe(measurements[0]!.bytesWritten);
  expect(measurements[2]!.bytesWritten).toBe(measurements[0]!.bytesWritten);
});

test('ten and one hundred profile manifests stay inside canonical release caps without owner catalogue copies', async () => {
  for (const [scenario, expected] of [
    ['profile-manifests-10', 10],
    ['profile-manifests-100', 100],
  ] as const) {
    const compiled = await requireRelease(scenario);
    const activeBefore = await active();
    const published = await api(
      'steward',
      'POST',
      '/v1/definitions/releases',
      { release: compiled.release },
      idempotencyKey(),
    );
    expect([200, 201]).toContain(published.status);
    const stats = await driver.inspectRelease(fixture, compiled.digest);
    expect(stats.canonicalBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(stats.typeCount).toBeLessThanOrEqual(1_024);
    expect(stats.propertyCount).toBeLessThanOrEqual(4_096);
    expect(stats.profileRegistryBytes).toBeGreaterThan(0);
    expect(await active()).toEqual(activeBefore);
    expect(stats.typeCount).toBeGreaterThanOrEqual(expected * 3);
    expect(stats.propertyCount).toBeGreaterThanOrEqual(expected * 12);

    await activate(compiled.digest, activeBefore.head);
    expect((await active()).digest).toBe(compiled.digest);

    const subjectId = await driver.provisionSubject(fixture, 'game');
    const measured = await driver.measure(() => entry(subjectId, 'planned'));
    expect([200, 201]).toContain(measured.value.status);
    expect(measured.sql.rowsWritten).toBeLessThanOrEqual(8);
  }
  expect((await driver.inspect(fixture)).entries.every((row) => row.pin?.provenance === 'profile')).toBe(true);
});

test('migration reads and changes no more than one hundred indexed owner rows per checkpoint', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 205, sessions: 205, copies: 205 });
  const release = await setupProfiles();
  await driver.migrateOwner(fixture, release.digest);
  const inspected = await driver.inspect(fixture);
  expect(inspected.migration.pages.length).toBeGreaterThan(1);
  for (const page of inspected.migration.pages) {
    expect(page.ownerRowsRead).toBeLessThanOrEqual(100);
    expect(page.ownerRowsChanged).toBeLessThanOrEqual(100);
    expect(page.bytesRead).toBeGreaterThanOrEqual(0);
    expect(page.bytesWritten).toBeGreaterThanOrEqual(0);
    expect(page.statements).toBeGreaterThan(0);
    expect(page.statements).toBeLessThanOrEqual(32);
    expect(page.relationRowsRead['library.progress_unit'] ?? 0).toBe(0);
    expect(page.relationRowsRead['library.progress_change'] ?? 0).toBe(0);
    expect(page.relationRowsWritten['library.progress_unit'] ?? 0).toBe(0);
    expect(page.relationRowsWritten['library.progress_change'] ?? 0).toBe(0);
    expect(page.ownerFenceChecked).toBe(true);
    expect(page.committed).toBe(true);
  }
  expect(inspected.entries).toHaveLength(205);
  expect(inspected.sessions).toHaveLength(205);
  expect(inspected.copies).toHaveLength(205);
});

test('migration crash before page commit leaves no partial pins and restarts from the last committed key', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 205, sessions: 0, copies: 0 });
  const release = await setupProfiles();
  await driver.crashNextMigration(fixture, 'before-page-commit');
  await driver.migrateOwner(fixture, release.digest);
  const crashed = await driver.inspect(fixture);
  expect(crashed.migration.pages.some((page) => !page.committed)).toBe(true);
  expect(crashed.entries.filter((row) => row.pin !== null).length).toBeLessThan(205);
  await driver.recoverMigration(fixture);
  await driver.migrateOwner(fixture, release.digest);
  const recovered = await driver.inspect(fixture);
  expect(recovered.entries).toHaveLength(205);
  expect(recovered.entries.every((row) => row.pin?.provenance === 'legacy')).toBe(true);
});

test('migration crash after page commit replays the same page without duplicate pins or skipped rows', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 205, sessions: 0, copies: 0 });
  const release = await setupProfiles();
  await driver.crashNextMigration(fixture, 'after-page-commit-before-ack');
  await driver.migrateOwner(fixture, release.digest);
  const first = await driver.inspect(fixture);
  expect(first.migration.pages.some((page) => page.committed)).toBe(true);
  const committedRows = first.entries.filter((row) => row.pin !== null);
  await driver.recoverMigration(fixture);
  await driver.migrateOwner(fixture, release.digest);
  const recovered = await driver.inspect(fixture);
  expect(recovered.entries).toHaveLength(205);
  expect(recovered.entries.every((row) => row.pin?.provenance === 'legacy')).toBe(true);
  for (const row of committedRows) {
    expect(recovered.entries.find((item) => item.subjectId === row.subjectId)?.pin).toEqual(row.pin);
  }
});

test('migration CAS preserves a concurrent current-profile write and never increments user revisions', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 1, sessions: 0, copies: 0 });
  const release = await setupProfiles();
  const initial = (await driver.inspect(fixture)).entries[0]!;
  const pause = await driver.pauseNextMigration(fixture, 'after-page-read-before-cas');
  const migration = driver.migrateOwner(fixture, release.digest);
  await pause.reached;
  const subjectId = initial.subjectId;
  const currentWrite = await entry(subjectId, 'completed', idempotencyKey(), initial.revision);
  expect(currentWrite.status).toBe(200);
  const written = (await driver.inspect(fixture)).entries.find((row) => row.subjectId === subjectId)!;
  expect(written.state).toBe('completed');
  expect(written.revision).toBe(initial.revision + 1);
  expect(written.pin?.provenance).toBe('profile');
  await pause.resume();
  await migration;
  const after = (await driver.inspect(fixture)).entries.find((row) => row.subjectId === subjectId)!;
  expect(after.state).toBe('completed');
  expect(after.revision).toBe(written.revision);
  expect(after.pin).toEqual(written.pin);
});

test('account deletion fences a paused migration and recovery never restores erased rows or receipts', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 205, sessions: 205, copies: 205 });
  const release = await setupProfiles();
  const pause = await driver.pauseNextMigration(fixture, 'after-page-commit-before-ack');
  const migration = driver.migrateOwner(fixture, release.digest);
  await pause.reached;
  await driver.deleteOwner(fixture);
  await pause.resume();
  await migration;
  await driver.recoverMigration(fixture);
  const after = await driver.inspect(fixture);
  expect(after.entries).toEqual([]);
  expect(after.sessions).toEqual([]);
  expect(after.completedUnits).toEqual([]);
  expect(after.changes).toEqual([]);
  expect(after.copies).toEqual([]);
  expect(after.receipts).toEqual([]);
});

test('migration preserves row IDs times intents and receipts without searching or rewriting progress history', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 5, sessions: 18, copies: 4 });
  const before = await driver.inspect(fixture);
  const release = await setupProfiles();
  await driver.migrateOwner(fixture, release.digest);
  const after = await driver.inspect(fixture);
  expect(after.entries.map(sameUserEntry)).toEqual(before.entries.map(sameUserEntry));
  expect(after.sessions.map(sameUserSession)).toEqual(before.sessions.map(sameUserSession));
  expect(after.copies.map(sameUserCopy)).toEqual(before.copies.map(sameUserCopy));
  expect(after.completedUnits).toEqual(before.completedUnits);
  expect(after.changes).toEqual(before.changes);
  expect(after.receipts).toEqual(before.receipts);
  expect(after.migration.pages.every((page) => page.ownerRowsRead <= 100 && page.ownerRowsChanged <= 100)).toBe(true);
});

test('migration target digest stays fixed across activation changes and bundle compilation never autoactivates', async () => {
  const first = await setupProfiles();
  await driver.seedLegacyFacts(fixture);
  const second = await publish('profile-v2-changed-ids');
  expect((await active()).digest).toBe(first.digest);
  await driver.migrateOwner(fixture, first.digest);
  await activate(second.digest);
  expect((await active()).digest).toBe(second.digest);
  const rows = (await driver.inspect(fixture)).entries;
  expect(rows.every((row) => row.pin?.releaseDigest === first.digest)).toBe(true);

  const third = await driver.compile('profile-v3-removed-ids');
  expect(third.valid).toBe(true);
  expect((await active()).digest).toBe(second.digest);
});


test('unprofiled readable subjects accept labels without default state but reject new state progress and holding', async () => {
  await setupProfiles('profile-absent');
  const subjectId = await driver.provisionSubject(fixture, 'people');
  expect((await driver.addLabel(fixture, subjectId, 'unprofiled-label')).status).toBe(200);
  const before = await driver.inspect(fixture);
  expect(before.independentLabels.length).toBeGreaterThan(0);
  await expectProblem(await entry(subjectId, 'planned'), 422, 'unsupported_library_profile');
  await expectProblem(await session({ subjectId, mode: 'scalar_amount', unit: 'page' }), 422, 'unsupported_library_profile');
  await expectProblem(await api('owner', 'POST', '/v1/copies', { subjectId, kind: 'physical', status: 'owned' }, idempotencyKey()), 422, 'unsupported_library_profile');
  const after = await driver.inspect(fixture);
  for (const field of ['entries', 'sessions', 'copies', 'receipts', 'events', 'independentLabels'] as const)
    expect(after[field]).toEqual(before[field]);
});

test('removed profile values remain pinned and readable and their owner can clear them without reacceptance', async () => {
  await setupProfiles();
  const subjectId = await driver.provisionSubject(fixture, 'game');
  expect((await entry(subjectId, 'planned')).status).toBe(201);
  const before = (await driver.inspect(fixture)).entries.find(row => row.subjectId === subjectId)!;
  await setupProfiles('profile-v3-removed-ids');
  expect((await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`)).status).toBe(200);
  expect((await driver.inspect(fixture)).entries.find(row => row.subjectId === subjectId)).toEqual(before);
  await expectProblem(await entry(subjectId, 'planned'), 422, 'unsupported_library_profile');
  expect((await api('owner', 'DELETE', `/v1/libraryEntries/${subjectId}?revision=${before.revision}`, undefined, idempotencyKey())).status).toBe(200);
  expect((await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`)).status).toBe(404);
});

test('migration bounds examined source keys through a long pinned prefix and interspersed pinned rows', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 1024, sessions: 0, copies: 0 });
  const release = await setupProfiles();
  const rows = (await driver.inspect(fixture)).entries.toSorted((a, b) => a.subjectId.localeCompare(b.subjectId));
  for (const [index, row] of rows.entries()) {
    if (index < 512 || index % 2 === 0)
      expect((await entry(row.subjectId, row.state, idempotencyKey(), row.revision)).status).toBe(200);
  }
  const before = await driver.inspect(fixture);
  await driver.migrateOwner(fixture, release.digest);
  const after = await driver.inspect(fixture);
  expect(after.entries.map(sameUserEntry)).toEqual(before.entries.map(sameUserEntry));
  expect(after.entries.every(row => row.pin !== null)).toBe(true);
  const pages = after.migration.pages;
  expect(pages.some(page => page.committed && page.ownerRowsChanged === 0 && page.sourceRowsExamined === 100)).toBe(true);
  for (const page of pages) {
    expect(page.sourceRowsExamined).toBeLessThanOrEqual(100);
    expect(page.sourcePlans.reduce((n, plan) => n + plan.rowsExamined, 0)).toBe(page.sourceRowsExamined);
    expect(page.sourcePlans.some(plan => plan.relation === 'library.entry' && plan.indexName.length > 0)).toBe(true);
    if (page.committed && page.sourceRowsExamined > 0) expect(page.checkpointAfter).not.toEqual(page.checkpointBefore);
  }
  expect(pages.reduce((n, page) => n + page.sourceRowsExamined, 0)).toBe(1024);
});

test('removing a profile preserves historic state progress and holding pins while permitting own clear and delete', async () => {
  await setupProfiles('profile-fixture-verticals');
  const subjectId = await driver.provisionSubject(fixture, 'recipe');
  expect((await entry(subjectId, 'planned')).status).toBe(201);
  const progress = await session({ subjectId, mode: 'scalar_amount', unit: 'minute' });
  expect(progress.status).toBe(201);
  const progressId = (await body(progress)).progressSession.id as string;
  const holding = await api('owner', 'POST', '/v1/copies', { subjectId, kind: 'physical', status: 'owned' }, idempotencyKey());
  expect(holding.status).toBe(201);
  const copyId = (await body(holding)).copy.id as string;
  const before = await driver.inspect(fixture);
  const state = before.entries.find(row => row.subjectId === subjectId)!;
  await setupProfiles('profile-absent');
  const absent = await driver.inspect(fixture);
  for (const field of ['entries', 'sessions', 'copies'] as const) expect(absent[field]).toEqual(before[field]);
  for (const path of [`/v1/libraryEntries/${subjectId}`, `/v1/progressSessions/${progressId}`, `/v1/copies/${copyId}`])
    expect((await api('owner', 'GET', path)).status).toBe(200);
  await expectProblem(await entry(subjectId, 'planned', idempotencyKey(), state.revision), 422, 'unsupported_library_profile');
  await expectProblem(await session({ subjectId, mode: 'scalar_amount', unit: 'minute' }), 422, 'unsupported_library_profile');
  await expectProblem(await api('owner', 'POST', '/v1/copies', { subjectId, kind: 'physical', status: 'owned' }, idempotencyKey()), 422, 'unsupported_library_profile');
  const rejected = await driver.inspect(fixture);
  for (const field of ['entries', 'sessions', 'copies', 'receipts', 'events'] as const) expect(rejected[field]).toEqual(absent[field]);
  expect((await api('other', 'DELETE', `/v1/copies/${copyId}`, undefined, idempotencyKey())).status).toBe(404);
  expect(await driver.inspect(fixture)).toEqual(rejected);
  expect((await api('owner', 'DELETE', `/v1/libraryEntries/${subjectId}?revision=${state.revision}`, undefined, idempotencyKey())).status).toBe(200);
  expect((await api('owner', 'DELETE', `/v1/copies/${copyId}`, undefined, idempotencyKey())).status).toBe(204);
  expect((await api('owner', 'GET', `/v1/libraryEntries/${subjectId}`)).status).toBe(404);
  expect((await api('owner', 'GET', `/v1/copies/${copyId}`)).status).toBe(404);
  expect((await driver.inspect(fixture)).sessions).toEqual(before.sessions);
});

test('migration shares one examined-source allowance across pinned entries and pending session and copy phases', async () => {
  await driver.seedLegacyFacts(fixture, { entries: 120, sessions: 101, copies: 101 });
  const release = await setupProfiles();
  for (const row of (await driver.inspect(fixture)).entries)
    expect((await entry(row.subjectId, row.state, idempotencyKey(), row.revision)).status).toBe(200);
  const before = await driver.inspect(fixture);
  expect(before.entries.every(row => row.pin !== null)).toBe(true);
  expect([...before.sessions, ...before.copies].every(row => row.pin === null)).toBe(true);

  await driver.migrateOwner(fixture, release.digest);
  const after = await driver.inspect(fixture);
  expect(after.entries).toEqual(before.entries);
  expect(after.sessions.map(sameUserSession)).toEqual(before.sessions.map(sameUserSession));
  expect(after.copies.map(sameUserCopy)).toEqual(before.copies.map(sameUserCopy));
  expect(after.receipts).toEqual(before.receipts);
  expect([...after.sessions, ...after.copies].every(row => row.pin !== null)).toBe(true);
  const pages = after.migration.pages;
  expect(pages.some(page => page.committed && page.sourceRowsExamined === 100 && page.ownerRowsChanged === 0)).toBe(true);
  for (const page of pages) {
    expect(page.sourceRowsExamined).toBeLessThanOrEqual(100);
    expect(page.sourcePlans.reduce((total, plan) => total + plan.rowsExamined, 0)).toBe(page.sourceRowsExamined);
    expect(page.ownerRowsChanged).toBeLessThanOrEqual(page.sourceRowsExamined);
    expect(page.ownerFenceChecked).toBe(true);
    if (page.sourceRowsExamined > 0) {
      expect(page.committed).toBe(true);
      expect(page.checkpointAfter).not.toEqual(page.checkpointBefore);
    }
  }
  expect(pages.reduce((total, page) => total + page.sourceRowsExamined, 0)).toBe(322);
  expect(pages.reduce((total, page) => total + page.ownerRowsChanged, 0)).toBe(202);
  expect(new Set(pages.flatMap(page => page.sourcePlans.map(plan => plan.relation))))
    .toEqual(new Set(['library.entry', 'library.progress_session', 'library.copy']));
});

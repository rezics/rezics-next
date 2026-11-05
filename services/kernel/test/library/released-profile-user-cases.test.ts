import { expect, test } from 'bun:test';
import { releaseDigest, type LibraryProfile, type LibraryProgressUnit, type Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import pg from 'pg';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

// This is the bundled first-public boundary. The complete 37-case custom-profile suite still needs its
// native binding. Two actual immutable renamed/retired bundled releases remain a separate fixture prerequisite;
// neither this single bundled world nor the existing synthetic compiler fixtures establish that control.
type World = ReleasedDiscoveryFixture;
type Entry = { subjectId: string; state: string; revision: number; createdAt: string; updatedAt: string };
type Session = {
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
type Copy = { id: string; subjectId: string; kind: string; status: string; revision: number };
const entryPath = (id: string) => `/v1/libraryEntries/${id}`;
const sessionPath = (id: string) => `/v1/progressSessions/${id}`;
const copyPath = (id: string) => `/v1/copies/${id}`;
type PinRead = (fact: 'entry' | 'progress_session' | 'copy', id: string, acceptingType: string) => Promise<void>;

// The shared fixture does not export its pool. Its native account handle contains the same unique suffix
// used by outcome-driver.ts to name its owned database. Resolve that exact account over HTTP, then open
// only that database, with PostgreSQL enforcing read-only transactions. Never enumerate other fixtures.
async function pinPool(world: World) {
  const accountId = world.personas.alice.accountId;
  const identity = await world.request('anonymous', 'GET', `/v1/accounts?ids=${accountId}`);
  http(identity, 200, 'Locate the fixture-owned database through its actual account identity');
  const accounts = identity.body.accounts as { id: string; handle: string }[];
  expect(accounts).toHaveLength(1);
  expect(accounts[0]!.id).toBe(accountId);
  const suffix = /^discovery-alice_([a-f0-9]{32})$/.exec(accounts[0]!.handle)?.[1];
  expect(suffix, 'Native released fixture account must identify its owned semantic database').toBeString();
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/semantic_${suffix}`;
  const reader = new pg.Pool({
    connectionString: url.href,
    max: 1,
    options: '-c default_transaction_read_only=on',
  });
  try {
    const settings = await reader.query(
      `SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only`,
    );
    expect(settings.rows).toEqual([{ database: `semantic_${suffix}`, read_only: 'on' }]);
    const owner = await reader.query('SELECT account_id::text FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ]);
    expect(owner.rows).toEqual([{ account_id: accountId }]);
    return reader;
  } catch (error) {
    await reader.end();
    throw error;
  }
}

function nativeCase(title: string, run: (world: World, release: Release, pin: PinRead) => Promise<void>) {
  test(
    title,
    async () => {
      const world = await createReleasedDiscoveryFixture({ version: 1 });
      let reader: pg.Pool | undefined;
      try {
        // Inspect the HTTP object itself, not base.profiles (which is only a prerequisite descriptor).
        const raw = await world.request('anonymous', 'GET', `/v1/definitions/releases/${world.release.digest}`);
        http(raw, 200, 'Read actual bundled release');
        expect(raw.body).toEqual({ digest: bundledDigest, release: bundledRelease });
        const release = raw.body.release as Release;
        expect(releaseDigest(release)).toBe(world.release.digest);
        const pin: PinRead = async (fact, id, acceptingType) => {
          reader ??= await pinPool(world);
          const key = { entry: 'subject_id', progress_session: 'session_id', copy: 'copy_id' }[fact];
          const result = await reader.query<{ library_profile_pin: unknown }>(
            `SELECT library_profile_pin FROM library.${fact} WHERE route=$1 AND account_id=$2 AND ${key}=$3`,
            [routeOf(world.personas.alice.accountId), world.personas.alice.accountId, id],
          );
          const field = `library.${fact}[${id}].library_profile_pin`;
          expect(result.rows, `${world.release.digest} missing persisted ${field}`).toHaveLength(1);
          expect(result.rows[0]!.library_profile_pin, `${world.release.digest} ${field}`).toEqual({
            provenance: 'profile',
            releaseDigest: releaseDigest(release),
            acceptingType,
            profileId: profile(world, release, acceptingType).id,
          });
        };
        await run(world, release, pin);
      } finally {
        try {
          await reader?.end();
        } finally {
          await world.close();
        }
      }
    },
    240_000,
  );
}

function http(response: HttpResponse, status: number, operation: string) {
  // The transport returns {status, headers, body}, not Response. Never replace a native status/envelope.
  expect(response.status, `${operation}: HTTP ${response.status} ${JSON.stringify(response.body)}`).toBe(status);
  expect(response.headers.get('content-type')).toContain('json');
}

function privateFree(world: World, value: unknown) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      'pin',
      'library_profile_pin',
      'libraryProfilePin',
      'provenance',
      'releaseDigest',
      'acceptingType',
      'profileId',
      'accountId',
      'account_id',
      'clientId',
      'authnEpoch',
      'transactionId',
      'transaction_id',
      'partition',
      'epoch',
      'typeId',
      'typeSourceId',
      'sourcePartition',
      'sourceEpoch',
      'sourcePosition',
      'owner_write_seq',
    ]).not.toContain(key);
    privateFree(world, child);
  }
  const raw = JSON.stringify(value);
  expect(raw).not.toContain(world.release.digest);
  for (const account of Object.values(world.personas)) expect(raw).not.toContain(account.accountId);
}

function problem(world: World, response: HttpResponse, status: number, code: string, effect = 'not_applied') {
  http(response, status, code);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({ status, code, effect_status: effect });
  for (const key of ['libraryEntry', 'progressSession', 'copy']) expect(response.body).not.toHaveProperty(key);
  privateFree(world, response.body);
}

function profile(world: World, release: Release, type: string): LibraryProfile {
  const field = `/types/${type}/library/profileId`;
  const reference = release.types[type]?.library;
  expect(reference?.profileId, `Actual bundled ${world.release.digest} missing ${field}`).toBeString();
  const found = release.libraryProfiles?.[reference!.profileId];
  expect(
    found,
    `Actual bundled ${world.release.digest} missing /libraryProfiles/${reference!.profileId}`,
  ).toBeDefined();
  expect(found!.id).toBe(reference!.profileId);
  expect(found!.id).not.toBe('legacy-fixed-v1');
  return found!;
}

function activeState(world: World, selected: LibraryProfile) {
  const states = selected.entryStateSet?.states;
  expect(
    states?.length,
    `${world.release.digest} /libraryProfiles/${selected.id}/entryStateSet/states`,
  ).toBeGreaterThan(0);
  const active = states!.find((state) => state.role === 'active');
  expect(
    active,
    `${world.release.digest} /libraryProfiles/${selected.id}/entryStateSet/states role=active`,
  ).toBeDefined();
  expect(active!.labels.en).toBeString();
  return active!.id;
}

async function subject(world: World, type: string, title: string) {
  const created = await world.createSubject(type, title);
  expect(created.release).toBe(world.release.digest);
  const raw = await world.read(created);
  http(raw, 200, 'Ordinary readable subject');
  expect(raw.body.subject).toMatchObject({ id: created.id, type, release: world.release.digest });
  return created;
}

async function putEntry(world: World, target: CreatedSubject, state: string, pin: PinRead, type: string) {
  const first = await world.request('alice', 'PUT', entryPath(target.id), { state }, discoveryKey());
  http(first, 201, `Owner selects released state ${state}`);
  const entry = first.body.libraryEntry as Entry;
  expect(first.body).toEqual({
    libraryEntry: {
      subjectId: target.id,
      state,
      revision: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  });
  privateFree(world, first.body);
  const read = await world.request('alice', 'GET', entryPath(target.id));
  http(read, 200, 'Read original own entry');
  expect(read.body).toEqual(first.body);
  privateFree(world, read.body);
  // The released ID can legally equal a legacy parser literal; only the stored pin proves admission.
  await pin('entry', target.id, type);
  return entry;
}

async function absentEntry(world: World, id: string, persona: DiscoveryPersona = 'alice') {
  problem(world, await world.request(persona, 'GET', entryPath(id)), 404, 'not_found', 'not_applicable');
}

async function sessions(world: World, id: string, persona: DiscoveryPersona = 'alice') {
  const read = await world.request(persona, 'GET', `/v1/progressSessions?subjectId=${id}&limit=100`);
  http(read, 200, 'Read native subject sessions');
  expect(Object.keys(read.body).sort()).toEqual(['next', 'progressSessions']);
  expect(read.body.next).toBeNull();
  privateFree(world, read.body);
  return read.body.progressSessions as Session[];
}

async function copies(world: World, id: string, persona: DiscoveryPersona = 'alice') {
  const read = await world.request(persona, 'GET', `/v1/copies?subjectId=${id}&limit=100`);
  http(read, 200, 'Read native subject copies');
  expect(Object.keys(read.body).sort()).toEqual(['copies', 'next']);
  expect(read.body.next).toBeNull();
  privateFree(world, read.body);
  return read.body.copies as Copy[];
}

async function entitlements(world: World) {
  const read = await world.request('alice', 'GET', '/v1/entitlements');
  http(read, 200, 'Read actual own entitlements');
  expect(read.body).toEqual({ entitlements: [], next: null });
  privateFree(world, read.body);
  return read.body;
}

async function empty(world: World, id: string) {
  await absentEntry(world, id);
  expect(await sessions(world, id)).toEqual([]);
  expect(await copies(world, id)).toEqual([]);
  await entitlements(world);
}

async function entryIsolation(world: World, target: CreatedSubject, own: Entry) {
  await absentEntry(world, target.id, 'bob');
  await absentEntry(world, target.id, 'anonymous');
  const denied = await world.request('anonymous', 'PUT', entryPath(target.id), { state: own.state }, discoveryKey());
  problem(world, denied, 401, 'authentication_required');
  const scope = await world.request('unscoped', 'PUT', entryPath(target.id), { state: own.state }, discoveryKey());
  problem(world, scope, 403, 'forbidden');
  const read = await world.request('alice', 'GET', entryPath(target.id));
  http(read, 200, 'Denied callers preserve owner entry');
  expect(read.body).toEqual({ libraryEntry: own });
}

nativeCase(
  'bundled Book reader selects its declared active state and reads the exact original entry201 as read200',
  async (world, release, pin) => {
    const book = await subject(world, 'schema:Book', 'Bundled reader');
    const selected = profile(world, release, 'schema:Book');
    const state = activeState(world, selected);
    await empty(world, book.id);
    const own = await putEntry(world, book, state, pin, 'schema:Book');
    expect(await sessions(world, book.id)).toEqual([]);
    expect(await copies(world, book.id)).toEqual([]);
    await entitlements(world);
    const invalid = 'not-declared-in-release';
    expect(selected.entryStateSet!.states.map((choice) => choice.id)).not.toContain(invalid);
    problem(
      world,
      await world.request(
        'alice',
        'PUT',
        entryPath(book.id),
        { state: invalid, revision: own.revision },
        discoveryKey(),
      ),
      422,
      'unsupported_library_profile',
    );
    const unchanged = await world.request('alice', 'GET', entryPath(book.id));
    http(unchanged, 200, 'Invalid state has no partial entry mutation');
    expect(unchanged.body).toEqual({ libraryEntry: own });
    await entryIsolation(world, book, own);
    expect(await sessions(world, book.id)).toEqual([]);
    expect(await copies(world, book.id)).toEqual([]);
    await entitlements(world);
  },
);

type Allowed = NonNullable<LibraryProfile['progress']>['allowed'][number];
const numericValue = (unit: LibraryProgressUnit) =>
  (unit.minimum ?? unit.maximum ?? '1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
function recordValue(mode: Allowed['mode'], unit: LibraryProgressUnit) {
  // Algorithms/lifecycle are fixed; IDs and numeric constraints come from the actual released pair.
  const value = numericValue(unit);
  switch (mode) {
    case 'scalar_amount':
      return { amount: value };
    case 'cursor_position':
      return { locator: 'released-user-position', position: value };
    case 'completed_units':
      return { add: ['1', '3', '7'] };
  }
}

async function sessionRead(world: World, id: string) {
  const read = await world.request('alice', 'GET', sessionPath(id));
  http(read, 200, 'Read original own session');
  expect(Object.keys(read.body)).toEqual(['progressSession']);
  privateFree(world, read.body);
  return read.body.progressSession as Session;
}

async function sessionIsolation(world: World, current: Session) {
  for (const persona of ['bob', 'anonymous'] as const) {
    for (const suffix of ['', '/changes', '/completedUnits']) {
      problem(
        world,
        await world.request(persona, 'GET', sessionPath(current.id) + suffix),
        404,
        'not_found',
        'not_applicable',
      );
    }
  }
  problem(
    world,
    await world.request(
      'bob',
      'POST',
      `${sessionPath(current.id)}:complete`,
      { revision: current.revision },
      discoveryKey(),
    ),
    404,
    'not_found',
  );
  expect(await sessions(world, current.subjectId, 'bob')).toEqual([]);
  expect(await sessionRead(world, current.id)).toEqual(current);
}

async function verticalJourney(world: World, release: Release, type: string, title: string, pin: PinRead) {
  const target = await subject(world, type, title);
  const selected = profile(world, release, type);
  const state = activeState(world, selected);
  const modes = selected.progress?.allowed;
  expect(modes?.length, `${world.release.digest} /libraryProfiles/${selected.id}/progress/allowed`).toBeGreaterThan(0);
  await empty(world, target.id);
  const expected: Session[] = [];
  for (const allowed of modes!) {
    expect(['scalar_amount', 'cursor_position', 'completed_units']).toContain(allowed.mode);
    expect(allowed.units.length, `${world.release.digest} ${selected.id} ${allowed.mode}/units`).toBeGreaterThan(0);
    for (const unit of allowed.units) {
      expect(unit.labels.en).toBeString();
      expect(unit.structure).toEqual({ kind: 'none' });
      expect(unit.identity).toEqual({ kind: allowed.mode === 'completed_units' ? 'session_local' : 'none' });
      const input = {
        subjectId: target.id,
        mode: allowed.mode,
        unit: unit.id,
        ...(allowed.mode === 'scalar_amount' && unit.totalPolicy === 'required' ? { total: numericValue(unit) } : {}),
      };
      const key = discoveryKey();
      const started = await world.request('alice', 'POST', '/v1/progressSessions', input, key);
      http(started, 201, `Start ${type} ${allowed.mode}/${unit.id}`);
      const initial = started.body.progressSession as Session;
      expect(started.body).toEqual({
        progressSession: {
          id: expect.any(String),
          subjectId: target.id,
          versionSubjectId: null,
          mode: allowed.mode,
          unit: unit.id,
          total: 'total' in input ? input.total : null,
          amount: null,
          locator: null,
          position: null,
          completedUnitCount: 0,
          state: 'active',
          revision: 1,
          startedAt: expect.any(String),
          completedAt: null,
        },
      });
      privateFree(world, started.body);
      expect(await sessionRead(world, initial.id)).toEqual(initial);
      await pin('progress_session', initial.id, type);
      problem(
        world,
        await world.request('unscoped', 'POST', '/v1/progressSessions', input, discoveryKey()),
        403,
        'forbidden',
      );
      await absentEntry(world, target.id); // a session alone is not an entry
      expect(await copies(world, target.id)).toEqual([]);
      await entitlements(world);
      const intent = recordValue(allowed.mode, unit);
      const recorded = await world.request(
        'alice',
        'POST',
        `${sessionPath(initial.id)}:record`,
        { revision: initial.revision, ...intent },
        discoveryKey(),
      );
      http(recorded, 200, 'Record released progress pair');
      const current = recorded.body.progressSession as Session;
      expect(recorded.body).toEqual({ progressSession: current });
      expect(current).toEqual({
        ...initial,
        revision: initial.revision + 1,
        ...(allowed.mode === 'completed_units' ? { completedUnitCount: 3 } : intent),
      });
      privateFree(world, recorded.body);
      expect(await sessionRead(world, initial.id)).toEqual(current);
      await pin('progress_session', initial.id, type);
      const changes = await world.request('alice', 'GET', `${sessionPath(initial.id)}/changes`);
      http(changes, 200, 'Read recorded original intent');
      expect(changes.body).toEqual({
        changes: [{ id: expect.any(String), revision: current.revision, intent, createdAt: expect.any(String) }],
        next: null,
      });
      privateFree(world, changes.body);
      if (allowed.mode === 'completed_units') {
        const sparse = await world.request('alice', 'GET', `${sessionPath(initial.id)}/completedUnits`);
        http(sparse, 200, 'Read actual sparse completed identities');
        expect(sparse.body).toEqual({ completedUnits: ['1', '3', '7'], next: null });
      }
      const complete = await world.request(
        'alice',
        'POST',
        `${sessionPath(initial.id)}:complete`,
        { revision: current.revision },
        discoveryKey(),
      );
      http(complete, 200, 'Complete released session');
      const completed = complete.body.progressSession as Session;
      expect(complete.body).toEqual({ progressSession: completed });
      expect(completed).toEqual({
        ...current,
        revision: current.revision + 1,
        state: 'completed',
        completedAt: expect.any(String),
      });
      privateFree(world, complete.body);
      expect(await sessionRead(world, initial.id)).toEqual(completed);
      await pin('progress_session', initial.id, type);
      const replay = await world.request('alice', 'POST', '/v1/progressSessions', input, key);
      http(replay, 201, 'Original start receipt retains original status');
      expect(replay.body).toEqual(started.body);
      expect(replay.headers.get('content-type')).toBe(started.headers.get('content-type'));
      await pin('progress_session', initial.id, type);
      expected.push(completed);
      await sessionIsolation(world, completed);
      await absentEntry(world, target.id); // completion/history still creates no entry
    }
  }
  const before = await sessions(world, target.id);
  expect(before.map((item) => item.id).sort()).toEqual(expected.map((item) => item.id).sort());
  const invalidUnit = 'not-declared-in-release';
  expect(modes!.flatMap((mode) => mode.units.map((unit) => unit.id))).not.toContain(invalidUnit);
  problem(
    world,
    await world.request(
      'alice',
      'POST',
      '/v1/progressSessions',
      { subjectId: target.id, mode: modes![0]!.mode, unit: invalidUnit },
      discoveryKey(),
    ),
    422,
    'unsupported_library_profile',
  );
  expect(await sessions(world, target.id)).toEqual(before);
  // Exercise actual released units and fixed algorithms outside this profile's allowed pairs. A closed
  // legacy parser accepting every old mode/unit combination must not satisfy profile-aware admission.
  const declared = modes![0]!;
  const otherMode = (['scalar_amount', 'cursor_position', 'completed_units'] as const).find(
    (mode) =>
      !modes!.some((pair) => pair.mode === mode && pair.units.some((unit) => unit.id === declared.units[0]!.id)),
  );
  expect(otherMode, `${world.release.digest} ${selected.id} requires an unsupported pair control`).toBeDefined();
  const otherUnit = Object.values(release.libraryProfiles!)
    .flatMap((candidate) => candidate.progress?.allowed ?? [])
    .filter((pair) => pair.mode === declared.mode)
    .flatMap((pair) => pair.units)
    .find((unit) => !declared.units.some((own) => own.id === unit.id));
  expect(otherUnit, `${world.release.digest} ${selected.id} requires another actual released unit`).toBeDefined();
  for (const pair of [
    { mode: otherMode!, unit: declared.units[0]!.id },
    { mode: declared.mode, unit: otherUnit!.id },
  ]) {
    problem(
      world,
      await world.request('alice', 'POST', '/v1/progressSessions', { subjectId: target.id, ...pair }, discoveryKey()),
      422,
      'unsupported_library_profile',
    );
    expect(await sessions(world, target.id)).toEqual(before);
  }
  await absentEntry(world, target.id);
  const own = await putEntry(world, target, state, pin, type);
  expect(await sessions(world, target.id)).toEqual(before); // entry write cannot restart or change history
  expect(await copies(world, target.id)).toEqual([]);
  await entitlements(world);
  await entryIsolation(world, target, own);
}

nativeCase(
  'bundled Game player uses released state mode and unit through original start201 record200 and complete200',
  async (world, release, pin) => {
    await verticalJourney(world, release, 'schema:VideoGame', 'Bundled player', pin);
  },
);

nativeCase(
  'bundled Recipe cook uses released state mode and unit through original start201 record200 and complete200',
  async (world, release, pin) => {
    await verticalJourney(world, release, 'schema:Recipe', 'Bundled cook', pin);
  },
);

nativeCase(
  'bundled recording listener uses released state mode and unit through original start201 record200 and complete200',
  async (world, release, pin) => {
    await verticalJourney(world, release, 'schema:MusicAlbum', 'Bundled listener', pin);
  },
);

// The committed account transport forwards arbitrary HTTP methods to Request unchanged, but its public type
// omits PATCH. Widen only that signature for this existing route; do not create another transport or fixture.
function patch(world: World, persona: 'alice' | 'bob', path: string, body: unknown) {
  const request = world.request as (
    persona: DiscoveryPersona,
    method: Parameters<World['request']>[1] | 'PATCH',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<HttpResponse>;
  return request(persona, 'PATCH', path, body, discoveryKey());
}

function copyReceipt(world: World, response: HttpResponse, status: number) {
  http(response, status, 'Native copy receipt');
  expect(Object.keys(response.body)).toEqual(['copy']);
  const copy = response.body.copy as Copy;
  expect(Object.keys(copy).sort()).toEqual(
    ['id', 'subjectId', 'kind', 'status', 'revision', 'location', 'source', 'acquiredOn', 'disposedOn', 'note'].sort(),
  );
  privateFree(world, response.body);
  return copy;
}

nativeCase(
  'two declared copies of one bundled Book edition keep independent IDs and transitions without entry session or entitlement',
  async (world, release, pin) => {
    const work = await subject(world, 'schema:Book', 'Copy work');
    const edition = await subject(world, 'bf:Instance', 'One Book edition');
    await world.adopt(edition, discoveryStatement('schema:exampleOfWork', work.id));
    const selected = profile(world, release, 'bf:Instance');
    const kinds = selected.copies?.kinds;
    expect(kinds?.length, `${world.release.digest} /libraryProfiles/${selected.id}/copies/kinds`).toBeGreaterThan(0);
    const kind = kinds!.find((choice) => choice.statuses.length >= 2);
    expect(
      kind,
      `${world.release.digest} ${selected.id}/copies/kinds requires a declared status transition`,
    ).toBeDefined();
    const [start, next] = kind!.statuses;
    expect(kind!.labels.en).toBeString();
    expect(start!.labels.en).toBeString();
    expect(next!.labels.en).toBeString();
    await empty(world, edition.id);
    await empty(world, work.id);
    const input = { subjectId: edition.id, kind: kind!.id, status: start!.id, note: 'Private first copy' };
    const firstRaw = await world.request('alice', 'POST', '/v1/copies', input, discoveryKey());
    const first = copyReceipt(world, firstRaw, 201);
    await pin('copy', first.id, 'bf:Instance');
    const secondRaw = await world.request(
      'alice',
      'POST',
      '/v1/copies',
      { ...input, note: 'Private second copy' },
      discoveryKey(),
    );
    const second = copyReceipt(world, secondRaw, 201);
    await pin('copy', second.id, 'bf:Instance');
    expect(first).toMatchObject({ subjectId: edition.id, kind: kind!.id, status: start!.id, revision: 1 });
    expect(second).toMatchObject({ subjectId: edition.id, kind: kind!.id, status: start!.id, revision: 1 });
    expect(first.id).not.toBe(second.id);
    problem(world, await world.request('unscoped', 'POST', '/v1/copies', input, discoveryKey()), 403, 'forbidden');
    const readCopy = async (id: string) => copyReceipt(world, await world.request('alice', 'GET', copyPath(id)), 200);
    expect(await readCopy(first.id)).toEqual(first);
    expect(await readCopy(second.id)).toEqual(second);
    const changed = copyReceipt(
      world,
      await patch(world, 'alice', copyPath(first.id), { revision: first.revision, status: next!.id }),
      200,
    );
    expect(changed).toEqual({ ...first, status: next!.id, revision: first.revision + 1 });
    await pin('copy', first.id, 'bf:Instance');
    expect(await readCopy(second.id)).toEqual(second);
    const changedSecond = copyReceipt(
      world,
      await patch(world, 'alice', copyPath(second.id), { revision: second.revision, status: next!.id }),
      200,
    );
    expect(changedSecond).toEqual({ ...second, status: next!.id, revision: second.revision + 1 });
    await pin('copy', second.id, 'bf:Instance');
    expect(await readCopy(first.id)).toEqual(changed);
    const before = await copies(world, edition.id);
    expect(before.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    const invalid = 'not-declared-in-release';
    expect(kind!.statuses.map((choice) => choice.id)).not.toContain(invalid);
    for (const body of [
      { ...input, status: invalid },
      { ...input, kind: invalid },
    ]) {
      expect(kinds!.map((choice) => choice.id)).not.toContain(invalid);
      problem(
        world,
        await world.request('alice', 'POST', '/v1/copies', body, discoveryKey()),
        422,
        'unsupported_library_profile',
      );
      expect(await copies(world, edition.id)).toEqual(before);
    }
    // Both IDs exist in the actual release, but a status from one kind is not granted to another kind.
    const otherKind = kinds!.find((candidate) => !candidate.statuses.some((status) => status.id === next!.id));
    expect(otherKind, `${world.release.digest} ${selected.id} requires an unsupported kind/status pair`).toBeDefined();
    problem(
      world,
      await world.request(
        'alice',
        'POST',
        '/v1/copies',
        { ...input, kind: otherKind!.id, status: next!.id },
        discoveryKey(),
      ),
      422,
      'unsupported_library_profile',
    );
    expect(await copies(world, edition.id)).toEqual(before);
    problem(
      world,
      await patch(world, 'alice', copyPath(first.id), { revision: changed.revision, status: invalid }),
      422,
      'unsupported_library_profile',
    );
    problem(
      world,
      await patch(world, 'alice', copyPath(first.id), { revision: first.revision, status: start!.id }),
      409,
      'conflict',
    );
    expect(await copies(world, edition.id)).toEqual(before);
    for (const persona of ['bob', 'anonymous'] as const) {
      const denied = await world.request(persona, 'GET', copyPath(first.id));
      problem(world, denied, 404, 'not_found', 'not_applicable');
      for (const secret of ['Private first copy', 'Private second copy'])
        expect(JSON.stringify(denied.body)).not.toContain(secret);
    }
    expect(await copies(world, edition.id, 'bob')).toEqual([]);
    problem(
      world,
      await patch(world, 'bob', copyPath(first.id), { revision: changed.revision, status: start!.id }),
      404,
      'not_found',
    );
    expect(await copies(world, edition.id)).toEqual(before);
    for (const id of [edition.id, work.id]) {
      await absentEntry(world, id);
      expect(await sessions(world, id)).toEqual([]);
    }
    expect(await copies(world, work.id)).toEqual([]);
    await entitlements(world);
  },
);

async function unprofiled(world: World, release: Release, type: string) {
  const target = await subject(world, type, 'Readable unprofiled control');
  expect(release.types[type]!.library).toBeUndefined();
  await empty(world, target.id);
  // Negative probes deliberately include the old fixed vocabulary: absence must not grant legacy defaults.
  const attempts = [
    ['PUT', entryPath(target.id), { state: 'planned' }],
    ['POST', '/v1/progressSessions', { subjectId: target.id, mode: 'scalar_amount', unit: 'page' }],
    ['POST', '/v1/copies', { subjectId: target.id, kind: 'physical', status: 'owned' }],
  ] as const;
  for (const [method, path, body] of attempts) {
    problem(
      world,
      await world.request('alice', method, path, body, discoveryKey()),
      422,
      'unsupported_library_profile',
    );
    await empty(world, target.id);
    const readable = await world.read(target);
    http(readable, 200, 'Unsupported tracking leaves ordinary subject readable');
    expect(readable.body.subject).toMatchObject({ id: target.id, type, release: world.release.digest });
  }
}

nativeCase(
  'unprofiled bundled Person stays readable without fresh state session or holding capability',
  async (world, release) => {
    await unprofiled(world, release, 'schema:Person');
  },
);

nativeCase(
  'unprofiled bundled Concept stays readable without fresh state session or holding capability',
  async (world, release) => {
    await unprofiled(world, release, 'skos:Concept');
  },
);

nativeCase(
  'pre-existing suspended bearer is native invalid_credentials401 with its invalid_token challenge and no private receipt',
  async (world) => {
    const target = await subject(world, 'schema:Book', 'Suspended credential control');
    // No new suspended token or password sign-in is manufactured here. The shared fixture owns real Auth issuance.
    for (const [method, path, body] of [
      ['GET', `/v1/definitions/releases/${world.release.digest}`, undefined],
      ['PUT', entryPath(target.id), { state: 'planned' }],
      ['POST', '/v1/progressSessions', { subjectId: target.id, mode: 'scalar_amount', unit: 'page' }],
      ['POST', '/v1/copies', { subjectId: target.id, kind: 'physical', status: 'owned' }],
    ] as const) {
      const denied = await world.request('suspended', method, path, body, discoveryKey());
      problem(world, denied, 401, 'invalid_credentials', method === 'GET' ? 'not_applicable' : 'not_applied');
      expect(denied.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    }
    await empty(world, target.id);
  },
);

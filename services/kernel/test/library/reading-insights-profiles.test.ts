import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { sessionScopes } from './support/session-profile-fixture.ts';
import {
  createReadingInsightsProfileReads,
  type ReadingInsightsProfiles,
} from '../../src/library/reading-insights-profiles.ts';
import maintenanceSessions from '../../src/library/shelf-maintenance-sessions.sql';
import { newId, routeOf } from '../../src/route/route.ts';

let native: NativeProfileFixture;
let game: string, recipe: string;
const path = '/v1/libraryReadingInsightsProfiles?year=2020';
type Identity = NativeProfileFixture['owner'];
beforeAll(async () => {
  native = await createProfileEntryFixture({ projectLinks: false });
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  game = await native.createSubject('game');
  recipe = await native.createSubject('recipe');
}, 120_000);
afterAll(async () => {
  await native?.close();
});
async function send(owner: Identity, method: string, url: string, body?: unknown, key = entryKey(), status = 200) {
  const response = await native.send(owner.bearer, method, url, body, key);
  const value = await response.json();
  expect({ status: response.status, value }).toEqual({ status, value: expect.any(Object) });
  return value;
}
async function occurrence(owner: Identity, subjectId = game, completed = true) {
  const result = await send(
    owner,
    'POST',
    '/v1/progressSessions',
    { subjectId, mode: 'scalar_amount', unit: 'minute' },
    entryKey(),
    201,
  );
  const id = result.progressSession.id as string;
  await send(owner, 'PATCH', `/v1/progressSessions/${id}/journal`, { revision: 0, finishDate: { year: 2020 } });
  if (completed) await send(owner, 'POST', `/v1/progressSessions/${id}:complete`, { revision: 1 });
  return id;
}
async function read(owner: Identity): Promise<ReadingInsightsProfiles> {
  const response = await native.send(owner.bearer, 'GET', path);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.status).toBe(200);
  return response.json();
}
function available(value: ReadingInsightsProfiles) {
  expect(value.state).toBe('available');
  if (value.state !== 'available') throw new Error('Expected initialized profile distribution');
  return value;
}
async function clone(owner: Identity, id: string, count: number, profileGroups = false) {
  // Seed retained source rows from a natively admitted occurrence. Every inserted
  // row traverses all installed native receivers; no aggregate row is mocked.
  await native.pool.query(
    `INSERT INTO library.progress_session
    SELECT (jsonb_populate_record(NULL::library.progress_session,to_jsonb(s)||jsonb_build_object(
      'session_id',seeded.new_id,'state','completed','completed_at',s.started_at,
      'library_profile_pin',CASE WHEN $4 THEN jsonb_set(s.library_profile_pin,'{profileId}',to_jsonb('historical-'||(n%12)::text))
        ELSE s.library_profile_pin END))).*
    FROM library.progress_session s CROSS JOIN unnest($3::uuid[]) WITH ORDINALITY AS seeded(new_id,n)
    WHERE s.route=$1 AND s.session_id=$2`,
    [
      routeOf(owner.actor.accountId),
      id,
      Array.from({ length: count }, () => newId(routeOf(owner.actor.accountId)!)),
      profileGroups,
    ],
  );
}

test('exact retained profiles, unknown history, journal correction, receipt replay and retirement stay independent', async () => {
  const owner = await native.identity(sessionScopes);
  const first = await occurrence(owner),
    second = await occurrence(owner);
  await occurrence(owner, recipe);
  let value = available(await read(owner));
  expect(
    value.profiles.map((group) => [
      group.profile.profileId,
      group.completedOccurrences,
      group.repeatOccurrencesWithinProfile,
    ]),
  ).toEqual([
    ['fixture.game', '2', '1'],
    ['fixture.recipe', '1', '0'],
  ]);
  const url = `/v1/progressSessions/${second}/journal`,
    key = entryKey();
  const correction = { revision: 1, finishDate: { year: 2021 } };
  await send(owner, 'PATCH', url, correction, key);
  const corrected = available(await read(owner));
  await send(owner, 'PATCH', url, correction, key);
  expect(await read(owner)).toEqual(corrected);
  expect(corrected.totals).toEqual({ completedOccurrences: '2', repeatOccurrencesWithinProfile: '0' });
  const route = routeOf(owner.actor.accountId)!;
  // Historical pre-profile data cannot be interpreted using the current profile.
  await native.pool.query(
    'UPDATE library.progress_session SET library_profile_pin=NULL WHERE route=$1 AND session_id=$2',
    [route, first],
  );
  value = available(await read(owner));
  expect(value.unknown.completedOccurrences).toBe('1');
  expect(value.profiles).toHaveLength(1);
  await native.activate(native.replacementDigest);
  expect(await read(owner)).toEqual(value);
  await native.pool.query(
    "UPDATE library.progress_session SET state='retired',completed_at=NULL WHERE route=$1 AND session_id=$2",
    [route, first],
  );
  expect(available(await read(owner)).unknown.completedOccurrences).toBe('0');
  await native.pool.query(
    "UPDATE library.progress_session SET state='completed',completed_at=started_at WHERE route=$1 AND session_id=$2",
    [route, first],
  );
  expect(available(await read(owner)).unknown.completedOccurrences).toBe('1');
  await native.pool.query('DELETE FROM library.progress_session WHERE route=$1 AND account_id=$2', [
    route,
    owner.actor.accountId,
  ]);
  expect(available(await read(owner)).totals.completedOccurrences).toBe('0');
  for (const table of ['owner', 'year', 'profile', 'subject'])
    expect(
      (
        await native.pool.query(`SELECT 1 FROM library.reading_insights_${table} WHERE route=$1 AND account_id=$2`, [
          route,
          owner.actor.accountId,
        ])
      ).rows,
    ).toEqual([]);
  await native.activate(native.originalDigest);
}, 120_000);

test('the ranked bounded set retains exact remainder and distinguishes empty, partial and missing installation', async () => {
  const owner = await native.identity(sessionScopes),
    route = routeOf(owner.actor.accountId)!;
  const id = await occurrence(owner, game, false);
  await clone(owner, id, 144, true);
  await clone(owner, id, 10);
  let value = available(await read(owner));
  expect(value.profiles).toHaveLength(8);
  expect(value.totals).toEqual({ completedOccurrences: '154', repeatOccurrencesWithinProfile: '141' });
  expect(value.remainder).toEqual({
    completedOccurrences: '58',
    repeatOccurrencesWithinProfile: '53',
    profileGroups: '5',
  });
  const source = (
    await native.pool.query('SELECT * FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, id])
  ).rows[0];
  const connection = await native.pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, id]);
    await connection.query('ALTER TABLE library.progress_session DISABLE TRIGGER reading_insights_receive');
    await connection.query(
      `INSERT INTO library.progress_session SELECT
      (jsonb_populate_record(NULL::library.progress_session,$1::jsonb)).*`,
      [JSON.stringify({ ...source, reading_insights_initialized: false })],
    );
    await connection.query('ALTER TABLE library.progress_session ENABLE TRIGGER reading_insights_receive');
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  expect(await read(owner)).toMatchObject({
    state: 'unavailable',
    reason: 'initializing',
    coverage: { initializedSessions: '154', retainedSessions: '155' },
  });
  // The same installed 100-row backfill phase initializes the addressed old row.
  const rows = await maintenanceSessions.run(native.pool, {
    route,
    account_id: owner.actor.accountId,
    after: '00000000-0000-0000-0000-000000000000',
    run_id: entryKey(),
  });
  expect(rows.length).toBeLessThanOrEqual(100);
  expect(rows.some((row) => row.id === id)).toBe(true);
  value = available(await read(owner));
  expect(value.coverage.initializedSessions).toBe('155');
  const empty = await native.identity(sessionScopes);
  expect(available(await read(empty)).totals.completedOccurrences).toBe('0');
  await native.pool.query('DELETE FROM library.reading_insights_installation WHERE singleton=true');
  try {
    expect(await read(empty)).toMatchObject({ state: 'unavailable', reason: 'not_installed' });
  } finally {
    await native.pool.query('INSERT INTO library.reading_insights_installation VALUES(true,1)');
  }
}, 120_000);

for (const scale of [64, 512, 4096])
  test(`independent ${scale}-session initialized read stays bounded and pure`, async () => {
    const owner = await native.identity(sessionScopes),
      id = await occurrence(owner, game, false);
    await clone(owner, id, scale);
    const reads = createReadingInsightsProfileReads(native);
    const first = available(await reads.profiles(owner.actor, 2020, Date.now() + 30_000));
    expect(first.profiles).toHaveLength(1);
    expect(first.totals).toEqual({
      completedOccurrences: String(scale),
      repeatOccurrencesWithinProfile: String(scale - 1),
    });
    expect(first.coverage).toMatchObject({
      initializedSessions: String(scale + 1),
      retainedSessions: String(scale + 1),
    });
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(16_384);
    expect(await reads.profiles(owner.actor, 2020, Date.now() + 30_000)).toEqual(first);
  }, 120_000);

test('mounted profile read retains owner admission, strict year input and cancellation', async () => {
  const owner = await native.identity(sessionScopes);
  expect((await native.send('anonymous', 'GET', path)).status).toBe(401);
  const unscoped = await native.identity([]);
  expect((await native.send(unscoped.bearer, 'GET', path)).status).toBe(403);
  for (const query of ['', '?year=0', '?year=2020&year=2021', '?year=2020&accountId=x'])
    expect((await native.send(owner.bearer, 'GET', '/v1/libraryReadingInsightsProfiles' + query)).status).toBe(400);
  const controller = new AbortController();
  controller.abort();
  await expect(
    createReadingInsightsProfileReads(native).profiles(owner.actor, 2020, Date.now() + 30_000, controller.signal),
  ).rejects.toMatchObject({ code: 'deadline_exceeded' });
}, 120_000);

test('native session creation retains its accepting unit meaning and session deletion removes it', async () => {
  const owner = await native.identity(sessionScopes);
  const id = await occurrence(owner, game, false);
  const route = routeOf(owner.actor.accountId)!;
  const meaning = await native.pool.query(
    `SELECT m.unit_id,m.meaning_revision,m.mode,m.profile_pin,m.dimension,m.precision,
      m.minimum::text AS minimum,m.maximum::text AS maximum,m.total_policy,m.identity_kind,m.structure_kind,
      s.library_profile_pin AS current_pin
     FROM library.reading_insights_progress_meaning m
     JOIN library.progress_session s USING(route,session_id)
     WHERE m.route=$1 AND m.session_id=$2`,
    [route, id],
  );
  expect(meaning.rows).toHaveLength(1);
  expect(meaning.rows[0]).toMatchObject({ unit_id: 'minute', meaning_revision: 1, mode: 'scalar_amount' });
  expect(meaning.rows[0].profile_pin).toEqual(meaning.rows[0].current_pin);
  expect(meaning.rows[0].structure_kind).toBe('none');
  await native.pool.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, id]);
  expect(
    (await native.pool.query(
      'SELECT 1 FROM library.reading_insights_progress_meaning WHERE route=$1 AND session_id=$2',
      [route, id],
    )).rows,
  ).toEqual([]);
}, 120_000);

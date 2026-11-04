import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { sessionScopes } from './support/session-profile-fixture.ts';
import { routeOf } from '../../src/route/route.ts';

let native: NativeProfileFixture;
let game: string;
type Identity = NativeProfileFixture['owner'];

beforeAll(async () => {
  native = await createProfileEntryFixture({ projectLinks: false });
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  game = await native.createSubject('game');
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

async function session(owner: Identity) {
  const result = await send(
    owner,
    'POST',
    '/v1/progressSessions',
    { subjectId: game, mode: 'scalar_amount', unit: 'minute' },
    entryKey(),
    201,
  );
  return result.progressSession.id as string;
}

async function read(owner: Identity) {
  const response = await native.send(owner.bearer, 'GET', '/v1/libraryReadingInsightsAssessments');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.status).toBe(200);
  return response.json();
}

test('assessment receiving distinguishes absent, explicit null, zero and historical unknown exactly once', async () => {
  const owner = await native.identity(sessionScopes);
  const cleared = await session(owner);
  const zero = await session(owner);

  expect(await read(owner)).toMatchObject({
    state: 'available',
    scope: 'retained_nonretired_sessions',
    coverage: { initializedSessions: '2', retainedSessions: '2', includedSessions: '2' },
    revisions: [{
      meaningRevision: 1,
      counts: { absent: '2', explicitNull: '0', value: '0', historicalUnknown: '0' },
      values: [],
    }],
  });

  const clearRequest = { revision: 0, assessment: null };
  const clearKey = entryKey();
  await send(owner, 'PATCH', `/v1/progressSessions/${cleared}/journal`, clearRequest, clearKey);
  const afterClear = await read(owner);
  await send(owner, 'PATCH', `/v1/progressSessions/${cleared}/journal`, clearRequest, clearKey);
  expect(await read(owner)).toEqual(afterClear);

  await send(owner, 'PATCH', `/v1/progressSessions/${zero}/journal`, {
    revision: 0,
    assessment: { units: 0 },
  });
  expect(await read(owner)).toMatchObject({
    revisions: [{
      meaningRevision: 1,
      counts: { absent: '0', explicitNull: '1', value: '1', historicalUnknown: '0' },
      values: [{ units: 0, occurrences: '1' }],
    }],
  });

  await native.pool.query(
    'UPDATE library.progress_session SET journal_assessment_presence=NULL WHERE route=$1 AND session_id=$2',
    [routeOf(owner.actor.accountId), cleared],
  );
  expect(await read(owner)).toMatchObject({
    revisions: [{
      meaningRevision: 1,
      counts: { absent: '0', explicitNull: '0', value: '1', historicalUnknown: '1' },
      values: [{ units: 0, occurrences: '1' }],
    }],
  });

  await native.pool.query(
    "UPDATE library.progress_session SET state='retired',completed_at=NULL WHERE route=$1 AND session_id=$2",
    [routeOf(owner.actor.accountId), cleared],
  );
  expect(await read(owner)).toMatchObject({
    coverage: { initializedSessions: '2', retainedSessions: '2', includedSessions: '1' },
    revisions: [{ counts: { historicalUnknown: '0' } }],
  });
  await native.pool.query(
    "UPDATE library.progress_session SET state='active' WHERE route=$1 AND session_id=$2",
    [routeOf(owner.actor.accountId), cleared],
  );
  expect(await read(owner)).toMatchObject({
    coverage: { initializedSessions: '2', retainedSessions: '2', includedSessions: '2' },
    revisions: [{ counts: { historicalUnknown: '1' } }],
  });
}, 120_000);

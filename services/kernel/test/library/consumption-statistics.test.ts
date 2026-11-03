import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { compileSessionProfile, sessionScopes } from './support/session-profile-fixture.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createConsumptionStatisticsReads, type ConsumptionSummary } from '../../src/library/consumption-statistics.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import * as store from '../../src/library/progress-store.ts';

let native: NativeProfileFixture;
let owner: NativeProfileFixture['owner'];
const path = '/v1/libraryConsumptionSummary';
beforeAll(async () => {
  native = await createProfileEntryFixture({ projectLinks: false });
  owner = await native.identity([...sessionScopes, 'library_entry:read', 'library_entry:update', 'copy:create']);
  await native.activate(await native.publish(await compileSessionProfile()));
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120_000);
afterAll(async () => { await native?.close(); });

async function send(method: string, url: string, body?: unknown, status = 200, key = entryKey()) {
  const response = await native.send(owner.bearer, method, url, body, key);
  const value = await response.json();
  expect({ status: response.status, value }).toEqual({ status, value: expect.any(Object) });
  return value;
}
async function summary(): Promise<ConsumptionSummary> { return send('GET', path); }
function counts(value: ConsumptionSummary) {
  return [value.completedOccurrences, value.distinctCompletedSubjects, value.repeatOccurrences];
}

test('real owner history counts distinct occurrences independently of shelf, quantities, clear and replay', async () => {
  expect(counts(await summary())).toEqual(['0', '0', '0']);
  const subjectId = await native.createSubject('game');
  const secondSubject = await native.createSubject('recipe');
  await send('PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' }, 201);
  const beforeEntry = await send('GET', `/v1/libraryEntries/${subjectId}`);
  const ids: string[] = [];
  for (const id of [subjectId, subjectId, secondSubject]) {
    const started = await send('POST', '/v1/progressSessions', { subjectId: id, mode: 'scalar_amount', unit: 'minute', total: '10' }, 201);
    ids.push(started.progressSession.id);
    const sessionPath = `/v1/progressSessions/${started.progressSession.id}`;
    await send('POST', `${sessionPath}:record`, { revision: 1, amount: '10' });
    // A total does not complete anything.
    const previous = await summary();
    expect(previous.completedOccurrences).toBe(String(ids.length - 1));
    const key = entryKey();
    const completion = await send('POST', `${sessionPath}:complete`, { revision: 2 }, 200, key);
    expect(await send('POST', `${sessionPath}:complete`, { revision: 2 }, 200, key)).toEqual(completion);
  }
  const complete = await summary();
  expect(counts(complete)).toEqual(['3', '2', '1']);
  expect(complete.coverage).toEqual({ nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' });
  expect(complete.completedOccurrencesWithUnknownProfile).toBe('0');
  await send('POST', `/v1/progressSessions/${ids[0]}:record`, { revision: 3, clear: true });
  const cleared = await summary();
  expect(counts(cleared)).toEqual(['3', '2', '1']);
  expect(cleared.currentness.revision).not.toBe(complete.currentness.revision);
  expect((await send('GET', `/v1/libraryEntries/${subjectId}`)).libraryEntry.state).toBe(beforeEntry.libraryEntry.state);
  const response = await native.send(owner.bearer, 'GET', path);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const other = await native.identity(sessionScopes);
  expect(counts(await (await native.send(other.bearer, 'GET', path)).json())).toEqual(['0', '0', '0']);
  expect((await native.send(owner.bearer, 'GET', `${path}?accountId=${other.actor.accountId}`)).status).toBe(400);
}, 120_000);

test('native corrections, unknown historical profile meaning and retirement update the same snapshot', async () => {
  const route = routeOf(owner.actor.accountId)!;
  const before = await summary();
  const subjectId = await native.createSubject('game');
  const { progressSession: session } = await send('POST', '/v1/progressSessions', { subjectId, mode: 'scalar_amount', unit: 'minute' }, 201);
  const connection = await native.pool.connect();
  try {
    // The installed native store is also the receiving boundary for correction. No
    // analytics writer or provider-completion adapter is involved.
    await store.updateSession(connection, route, session.id, 1, {
      amount: null, locator: null, position: null, completedUnitCount: 0,
      state: 'completed', completedAt: '2026-10-01T12:00:00Z',
    }, { time: '2026-10-01T12:00:00Z', transactionId: randomUUID() });
    expect(BigInt((await summary()).completedOccurrences)).toBe(BigInt(before.completedOccurrences) + 1n);
    await connection.query('UPDATE library.progress_session SET library_profile_pin=NULL WHERE route=$1 AND session_id=$2', [route, session.id]);
    expect((await summary()).completedOccurrencesWithUnknownProfile).toBe('1');
    await store.updateSession(connection, route, session.id, 2, {
      amount: null, locator: null, position: null, completedUnitCount: 0,
      state: 'abandoned', completedAt: null,
    }, { time: '2026-10-02T12:00:00Z', transactionId: randomUUID() });
    expect(counts(await summary())).toEqual(counts(before));
    expect((await summary()).completedOccurrencesWithUnknownProfile).toBe('0');
    await store.updateSession(connection, route, session.id, 3, {
      amount: null, locator: null, position: null, completedUnitCount: 0,
      state: 'completed', completedAt: '2026-10-03T12:00:00Z',
    }, { time: '2026-10-03T12:00:00Z', transactionId: randomUUID() });
    expect(BigInt((await summary()).completedOccurrences)).toBe(BigInt(before.completedOccurrences) + 1n);
    // Removal through the native source table is the same receive used by erasure.
    await connection.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, session.id]);
    expect(counts(await summary())).toEqual(counts(before));
    expect((await connection.query('SELECT 1 FROM library.consumption_statistics_subject WHERE route=$1 AND account_id=$2 AND subject_id=$3', [route, owner.actor.accountId, subjectId])).rowCount).toBe(0);
  } finally { connection.release(); }
}, 120_000);

test('unavailable authority, cancellation, bounded reads and terminal fences never become successful zeros', async () => {
  const reader = createConsumptionStatisticsReads(native);
  const statements: string[] = [];
  // Observe the real production SQL, forwarding every request to the native pool.
  const trackedPool = Object.create(native.pool);
  trackedPool.connect = async () => {
    const client = await native.pool.connect();
    const original = client.query;
    client.query = ((...args: unknown[]) => {
      statements.push(typeof args[0] === 'string' ? args[0] : 'prepared');
      return (original as Function).apply(client, args);
    }) as typeof original;
    const release = client.release;
    client.release = ((...args: unknown[]) => { client.query = original; client.release = release; (release as Function).apply(client, args); }) as typeof release;
    return client;
  };
  const tracked = createConsumptionStatisticsReads({ pool: trackedPool });
  const historyOwner = await native.identity(sessionScopes);
  const route = routeOf(historyOwner.actor.accountId)!;
  const subjectId = await native.createSubject('game');
  let count = 0;
  for (const scale of [0, 8, 32]) {
    for (let i = 0; i < scale; i++) await store.insertSession(native.pool, route, {
      id: newId(route), accountId: historyOwner.actor.accountId, subjectId, versionSubjectId: null,
      mode: 'scalar_amount', unit: 'minute', total: null,
    }, { time: '2026-10-03T12:00:00Z', transactionId: randomUUID() });
    statements.length = 0;
    expect(counts(await tracked.summary(historyOwner.actor, Date.now() + 30_000))).toEqual(['0', '0', '0']);
    if (count) expect(statements).toHaveLength(count);
    count = statements.length;
    expect(statements.filter((sql) => sql.includes('consumption_statistics_installation'))).toHaveLength(1);
    expect(statements.some((sql) => /FROM library\.progress_session/.test(sql))).toBe(false);
  }
  await native.pool.query('DELETE FROM library.progress_session WHERE route=$1 AND account_id=$2', [route, historyOwner.actor.accountId]);
  expect((await native.pool.query('SELECT 1 FROM library.consumption_statistics_owner WHERE route=$1 AND account_id=$2', [route, historyOwner.actor.accountId])).rowCount).toBe(0);
  await expect(reader.summary(owner.actor, Date.now() - 1)).rejects.toMatchObject({ code: 'deadline_exceeded' });
  const cancelled = AbortSignal.abort();
  await expect(reader.summary(owner.actor, Date.now() + 30_000, cancelled)).rejects.toMatchObject({ code: 'deadline_exceeded' });
  await native.pool.query('UPDATE library.consumption_statistics_installation SET complete=false');
  try { expect((await native.send(owner.bearer, 'GET', path)).status).toBe(503); }
  finally { await native.pool.query('UPDATE library.consumption_statistics_installation SET complete=true'); }
  expect((await native.send('anonymous', 'GET', path)).status).toBe(401);
  expect((await native.send('owner', 'GET', path)).status).toBe(403); // no progress scope
  const fenced = await native.identity(sessionScopes);
  await native.revokeIdentity(fenced.actor.accountId);
  await expect(reader.summary(fenced.actor, Date.now() + 30_000)).rejects.toMatchObject({ code: 'forbidden' });
  expect((await native.send(fenced.bearer, 'GET', path)).status).toBe(401);
}, 120_000);

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { sessionScopes } from './support/session-profile-fixture.ts';
import { createReportedYearSummaryReads, type ReportedYearSummary } from '../../src/library/reported-year-summary.ts';
import { routeOf } from '../../src/route/route.ts';
import maintenanceSessions from '../../src/library/shelf-maintenance-sessions.sql';
import eraseSession from '../../src/library/erasure-owned-session-delete.sql';

let native: NativeProfileFixture;
let owner: NativeProfileFixture['owner'];
let subject: string, independent: string;
const path = '/v1/libraryReportedYearSummary';
beforeAll(async () => {
  native = await createProfileEntryFixture({ projectLinks: false });
  owner = await native.identity(sessionScopes);
  await native.activate(await native.publish(bundledRelease));
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  for (const label of ['Repeatable book', 'Independent book']) {
    const response = await native.send('owner', 'POST', '/v1/subjects', { type: 'schema:Book', labels: { en: label } });
    expect(response.status).toBe(201);
    const id = (await response.json()).subject.id;
    if (!subject) subject = id; else independent = id;
  }
}, 120_000);
afterAll(async () => { await native?.close(); });
async function send(method: string, url: string, body?: unknown, key = entryKey(), status = 200) {
  const response = await native.send(owner.bearer, method, url, body, key);
  const value = await response.json();
  expect({ status: response.status, value }).toEqual({ status, value: expect.any(Object) });
  return value;
}
async function summary(year = 2020): Promise<ReportedYearSummary> { return send('GET', `${path}?year=${year}`); }
function counts(value: { completedOccurrences: string; distinctCompletedSubjects: string; repeatOccurrences: string }) {
  return [value.completedOccurrences, value.distinctCompletedSubjects, value.repeatOccurrences];
}
async function occurrence(subjectId: string, finishDate?: object, complete = true) {
  const created = await send('POST', '/v1/progressSessions', { subjectId, mode: 'scalar_amount', unit: 'page' }, entryKey(), 201);
  const id = created.progressSession.id;
  if (finishDate) await send('PATCH', `/v1/progressSessions/${id}/journal`, { revision: 0, finishDate });
  if (complete) await send('POST', `/v1/progressSessions/${id}:complete`, { revision: 1 });
  return id as string;
}

test('released book occurrences retain precision, independent bucket grouping and original journal retries', async () => {
  const first = await occurrence(subject, { year: 2020, month: 2, day: 29 });
  const second = await occurrence(subject, { year: 2020, month: 2 });
  await occurrence(independent, { year: 2020 });
  await occurrence(subject, { year: 2020, month: 3, day: 1 });
  await occurrence(independent); // no reported finish: never a January completion
  await occurrence(independent, { year: 2020, month: 1 }, false);
  const value = await summary();
  expect(counts(value)).toEqual(['4', '2', '2']);
  expect(value.months).toHaveLength(12);
  expect(counts(value.months[0]!)).toEqual(['0', '0', '0']);
  expect(counts(value.months[1]!)).toEqual(['2', '1', '1']);
  expect(value.months[1]!.finishPrecision).toEqual({ year: '0', month: '1', day: '1' });
  expect(counts(value.monthUnallocated)).toEqual(['1', '1', '0']);
  expect(value.coverage.completedOccurrencesWithMissingFinish).toBe('1');
  expect(value.coverage.initializedSessions).toBe(value.coverage.retainedSessions);
  const allTime = await send('GET', '/v1/libraryConsumptionSummary');
  const correction = { revision: 1, finishDate: { year: 1900, month: 12 } };
  const key = entryKey(), url = `/v1/progressSessions/${first}/journal`;
  const acknowledged = await send('PATCH', url, correction, key);
  expect(await send('PATCH', url, correction, key)).toEqual(acknowledged);
  await send('PATCH', `/v1/progressSessions/${second}/journal`, { revision: 1, finishDate: null });
  expect(counts(await summary())).toEqual(['2', '2', '0']);
  expect(counts(await summary(1900))).toEqual(['1', '1', '0']);
  expect((await summary()).coverage.completedOccurrencesWithMissingFinish).toBe('2');
  expect(counts(await send('GET', '/v1/libraryConsumptionSummary'))).toEqual(counts(allTime));
  await send('PATCH', url, { revision: 2, finishDate: { year: 1900, month: 2, day: 29 } }, entryKey(), 400);
  expect(counts(await summary(1900))).toEqual(['1', '1', '0']);
  for (const query of ['', '?year=0', '?year=10000', '?year=2020.5', '?year=2020&year=2021', '?year=2020&accountId=x'])
    expect((await native.send(owner.bearer, 'GET', path + query)).status).toBe(400);
  const other = await native.identity(sessionScopes);
  expect(counts(await (await native.send(other.bearer, 'GET', `${path}?year=2020`)).json())).toEqual(['0', '0', '0']);
  expect((await native.send('anonymous', 'GET', `${path}?year=2020`)).status).toBe(401);
  expect((await native.send('owner', 'GET', `${path}?year=2020`)).status).toBe(403);
  expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(16_384);
}, 120_000);

test('concurrent first and last memberships, native retirement and bounded installed maintenance coverage', async () => {
  const ids = await Promise.all([occurrence(subject, { year: 1700 }), occurrence(subject, { year: 1700 })]);
  expect(counts(await summary(1700))).toEqual(['2', '1', '1']);
  await Promise.all(ids.map((id) => send('PATCH', `/v1/progressSessions/${id}/journal`, { revision: 1, finishDate: null })));
  expect(counts(await summary(1700))).toEqual(['0', '0', '0']);
  const transition = await occurrence(independent, { year: 1800 });
  await send('PATCH', `/v1/progressSessions/${transition}/journal`, { revision: 1, finishDate: { year: 1800, month: 4 } });
  expect((await summary(1800)).monthUnallocated.completedOccurrences).toBe('0');
  expect((await summary(1800)).months[3]!.finishPrecision.month).toBe('1');
  await send('PATCH', `/v1/progressSessions/${transition}/journal`, { revision: 2, finishDate: { year: 1800, month: 4, day: 30 } });
  expect((await summary(1800)).months[3]!.finishPrecision.day).toBe('1');
  expect(counts(await summary(1800))).toEqual(['1', '1', '0']);
  const route = routeOf(owner.actor.accountId)!;
  // Emulate the pre-installation row at the migration boundary in this isolated DB.
  // Retire it through the source trigger, then restore only its uninitialized source.
  const id = await occurrence(independent, { year: 1600, month: 1 });
  const connection = await native.pool.connect();
  try {
    await connection.query('BEGIN');
    const source = (await connection.query('SELECT * FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, id])).rows[0];
    // Source has no progress children: completion itself does not create progress changes.
    await connection.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, id]);
    await connection.query('ALTER TABLE library.progress_session DISABLE TRIGGER reported_year_receive');
    await connection.query(`INSERT INTO library.progress_session SELECT (jsonb_populate_record(NULL::library.progress_session,$1::jsonb)).*`,
      [JSON.stringify({ ...source, reported_year_initialized: false })]);
    await connection.query('ALTER TABLE library.progress_session ENABLE TRIGGER reported_year_receive');
    await connection.query('COMMIT');
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
  expect((await native.send(owner.bearer, 'GET', `${path}?year=1600`)).status).toBe(503);
  // The real installed backfill page is the initializer, not a test-only summary writer.
  const rows = await maintenanceSessions.run(native.pool, { route, account_id: owner.actor.accountId,
    after: '00000000-0000-0000-0000-000000000000', run_id: entryKey() });
  expect(rows.length).toBeLessThanOrEqual(100);
  expect(counts(await summary(1600))).toEqual(['1', '1', '0']);
  expect(await eraseSession.run(native.pool, { route, account_id: owner.actor.accountId, parent_id: id })).toMatchObject({ removed: true });
  expect(counts(await summary(1600))).toEqual(['0', '0', '0']);
  expect((await native.pool.query('SELECT 1 FROM library.reported_year_subject WHERE route=$1 AND account_id=$2 AND year=1600',
    [route, owner.actor.accountId])).rowCount).toBe(0);
}, 120_000);

test('cancellation at delivery and terminal authority cannot deliver a successful private year', async () => {
  const read = createReportedYearSummaryReads(native);
  await expect(read.summary(owner.actor, 2020, Date.now() + 5000, AbortSignal.abort())).rejects.toMatchObject({ code: 'deadline_exceeded' });
  const controller = new AbortController();
  const pool = { connect: async () => {
    const client = await native.pool.connect();
    return { query: async (...args: Parameters<typeof client.query>) => {
      const value = await (client.query as Function)(...args);
      if (args[0] === 'COMMIT') controller.abort();
      return value;
    }, release: () => client.release() };
  } } as unknown as NativeProfileFixture['pool'];
  let delivered = false;
  await expect(createReportedYearSummaryReads({ pool }).summary(owner.actor, 2020, Date.now() + 5000,
    controller.signal, () => { delivered = true; })).rejects.toMatchObject({ code: 'deadline_exceeded' });
  expect(delivered).toBe(false);
  const route = routeOf(owner.actor.accountId)!;
  const retained = await native.pool.query<{session_id:string}>('SELECT session_id FROM library.progress_session WHERE route=$1 AND account_id=$2', [route, owner.actor.accountId]);
  await native.revokeIdentity(owner.actor.accountId);
  await expect(read.summary(owner.actor, 2020, Date.now() + 5000)).rejects.toMatchObject({ code: 'forbidden' });
  for (const row of retained.rows)
    expect(await eraseSession.run(native.pool, { route, account_id: owner.actor.accountId, parent_id: row.session_id })).toMatchObject({ removed: true });
  for (const table of ['reported_year_subject', 'reported_year_bucket', 'reported_year_owner'])
    expect((await native.pool.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND account_id=$2`, [route, owner.actor.accountId])).rowCount).toBe(0);
  const terminal = await native.identity(sessionScopes);
  await native.revokeIdentity(terminal.actor.accountId);
  await expect(read.summary(terminal.actor, 2020, Date.now() + 5000)).rejects.toMatchObject({ code: 'forbidden' });
}, 120_000);

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { sessionScopes } from './support/session-profile-fixture.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';

let native: NativeProfileFixture;
let owner: NativeProfileFixture['owner'];
let subject = '';
let independent = '';
const path = '/v1/libraryYearlyCompletionGoal';
const metric = 'completed_consumption_occurrences';

beforeAll(async () => {
  native = await createProfileEntryFixture({ projectLinks: false });
  owner = await native.identity(sessionScopes);
  await native.activate(await native.publish(bundledRelease));
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  for (const label of ['Occurrence goal work', 'Undated goal work']) {
    const response = await native.send('owner', 'POST', '/v1/subjects', { type: 'schema:Book', labels: { en: label } });
    expect(response.status).toBe(201);
    const id = (await response.json()).subject.id as string;
    if (!subject) subject = id;
    else independent = id;
  }
}, 120_000);

afterAll(async () => {
  await native?.close();
});

async function call(method: string, url: string, body?: unknown, key = entryKey()) {
  const response = await native.send(owner.bearer, method, url, body, key);
  return { response, value: await response.json() };
}

async function read(year: number) {
  const result = await call('GET', `${path}?year=${year}`);
  expect(result.response.status).toBe(200);
  return result.value;
}

async function change(year: number, target: number | null, expectedRevision: string | null, key = entryKey()) {
  return call(
    'PUT',
    path,
    { year, metric, target, expectedRevision },
    key,
  );
}

async function occurrence(subjectId: string, finishDate?: { year: number; month?: number; day?: number }) {
  const started = await call('POST', '/v1/progressSessions', { subjectId, mode: 'scalar_amount', unit: 'page' });
  expect(started.response.status).toBe(201);
  const id = started.value.progressSession.id as string;
  let revision = 0;
  if (finishDate) {
    const journal = await call('PATCH', `/v1/progressSessions/${id}/journal`, { revision, finishDate });
    expect(journal.response.status).toBe(200);
    revision++;
  }
  const completed = await call('POST', `/v1/progressSessions/${id}:complete`, { revision });
  expect(completed.response.status).toBe(200);
  return id;
}

test('target edits keep the revision fence while native repeated and undated occurrences remain explicit', async () => {
  const initial = await read(2026);
  expect(initial.target).toEqual({ state: 'none', revision: null });
  expect(initial.viewer.actions).toMatchObject({
    editTarget: { allowed: true },
    clearTarget: { allowed: false, reason: 'no_target' },
    navigateYear: { allowed: true },
  });
  expect(initial.progress.summary.completedOccurrences).toBe('0');

  const key = entryKey();
  const created = await change(2026, 1, null, key);
  expect(created.response.status).toBe(200);
  expect(created.value).toMatchObject({ year: 2026, metric, target: 1, revision: '1' });
  expect((await change(2026, 1, null, key)).value).toEqual(created.value);

  await occurrence(subject, { year: 2026, month: 2, day: 28 });
  await occurrence(subject, { year: 2026, month: 2 });
  await occurrence(independent);
  const overTarget = await read(2026);
  expect(overTarget.target).toEqual({ state: 'set', target: 1, revision: '1' });
  expect(overTarget.progress.summary.completedOccurrences).toBe('2');
  expect(overTarget.progress.summary.repeatOccurrences).toBe('1');
  expect(overTarget.progress.summary.months[1].finishPrecision).toEqual({ year: '0', month: '1', day: '1' });
  expect(overTarget.progress.summary.coverage).toMatchObject({
    completedOccurrencesWithMissingFinish: '1',
    completedOccurrencesWithUnsupportedFinish: '0',
    otherHistory: 'unavailable',
    unitMeaning: 'not_evaluated',
  });

  const edited = await change(2026, 2, '1');
  expect(edited.response.status).toBe(200);
  expect(edited.value.revision).toBe('2');
  expect(await read(2026)).toMatchObject({
    target: { state: 'set', target: 2, revision: '2' },
    progress: { state: 'available', summary: { completedOccurrences: '2' } },
  });
}, 120_000);

test('year and target operands reject coercion, fractions, and out-of-range values', async () => {
  for (const query of ['', '?year=0', '?year=10000', '?year=2026.5', '?year=2026&year=2027', '?year=2026&owner=x'])
    expect((await native.send(owner.bearer, 'GET', path + query)).status).toBe(400);
  for (const body of [
    { year: 2026, metric, target: 1.5, expectedRevision: null },
    { year: 2026, metric, target: '2', expectedRevision: null },
    { year: 2026, metric, target: 1001, expectedRevision: null },
    { year: 2026.5, metric, target: 2, expectedRevision: null },
    { year: 2026, metric, target: null, expectedRevision: null },
  ])
    expect((await native.send(owner.bearer, 'PUT', path, body, entryKey())).status).toBe(400);
  expect((await native.send('anonymous', 'GET', `${path}?year=2026`)).status).toBe(401);
}, 120_000);

test('correction moves the occurrence between reported years without changing either goal revision', async () => {
  const id = await occurrence(subject, { year: 2024, month: 2, day: 29 });
  const moved = await call('PATCH', `/v1/progressSessions/${id}/journal`, {
    revision: 1,
    finishDate: { year: 2025, month: 1 },
  });
  expect(moved.response.status).toBe(200);
  const [oldYear, newYear] = await Promise.all([read(2024), read(2025)]);
  expect(oldYear.progress.summary.completedOccurrences).toBe('0');
  expect(oldYear.target.revision).toBeNull();
  expect(newYear.progress.summary.completedOccurrences).toBe('1');
  expect(newYear.progress.summary.months[0].finishPrecision).toEqual({ year: '0', month: '1', day: '0' });
  expect(newYear.target.revision).toBeNull();
}, 120_000);

test('clear and recreate advance the same fence, and concurrent first edits cannot overwrite one another', async () => {
  const created = await change(2031, 3, null);
  expect(created.value.revision).toBe('1');
  const cleared = await change(2031, null, '1');
  expect(cleared.value).toMatchObject({ target: null, revision: '2' });
  const recreated = await change(2031, 5, '2');
  expect(recreated.value.revision).toBe('3');
  expect((await change(2031, 99, '1')).response.status).toBe(409);
  expect(await read(2031)).toMatchObject({ target: { state: 'set', target: 5, revision: '3' } });

  const racers = await Promise.all([change(2032, 7, null), change(2032, 8, null)]);
  expect(racers.map(({ response }) => response.status).sort()).toEqual([200, 409]);
  expect(await read(2032)).toMatchObject({ target: { state: 'set', revision: '1' } });
}, 120_000);

test('summary unavailability keeps an installed target readable and editable; target reads stay bounded at scale', async () => {
  const seeded = await change(2030, 4, null);
  const route = await native.pool.query<{ route: number }>(
    'SELECT route FROM access.account WHERE account_id=$1',
    [owner.actor.accountId],
  );
  const ownerRoute = route.rows[0]!.route;
  try {
    await native.pool.query('UPDATE library.consumption_statistics_installation SET complete=false WHERE singleton=true');
    const unavailable = await read(2030);
    expect(unavailable.progress).toEqual({ state: 'unavailable', reason: 'summary_unavailable' });
    expect(unavailable.viewer.actions.editTarget).toEqual({ allowed: true });
    expect((await change(2030, 6, seeded.value.revision)).response.status).toBe(200);
  } finally {
    await native.pool.query('UPDATE library.consumption_statistics_installation SET complete=true WHERE singleton=true');
  }

  for (const size of [64, 512, 4096]) {
    await native.pool.query('DELETE FROM library.yearly_completion_goal WHERE route=$1 AND account_id=$2', [
      ownerRoute,
      owner.actor.accountId,
    ]);
    await native.pool.query(
      `INSERT INTO library.yearly_completion_goal(route,account_id,year,target,revision)
       SELECT $1,$2,year,1,1 FROM generate_series(1,$3::integer) AS years(year)`,
      [ownerRoute, owner.actor.accountId, size],
    );
    expect(await read(size)).toMatchObject({ target: { state: 'set', target: 1, revision: '1' } });
  }
  await native.pool.query('DELETE FROM library.yearly_completion_goal WHERE route=$1 AND account_id=$2', [
    ownerRoute,
    owner.actor.accountId,
  ]);
}, 120_000);

test('foreign owners see only their own goal state and account retirement erases goal rows', async () => {
  await change(2040, 12, null);
  const other = await native.identity(sessionScopes);
  const hidden = await native.send(other.bearer, 'GET', `${path}?year=2040`);
  expect(hidden.status).toBe(200);
  expect((await hidden.json()).target).toEqual({ state: 'none', revision: null });

  const ownerRoute = (await native.pool.query<{ route: number }>(
    'SELECT route FROM access.account WHERE account_id=$1',
    [owner.actor.accountId],
  )).rows[0]!.route;
  await native.revokeIdentity(owner.actor.accountId);
  expect((await native.send(owner.bearer, 'GET', `${path}?year=2040`)).status).toBe(403);
  const erased = await purgeOwnedGraphPage(native.pool, {
    accountId: owner.actor.accountId,
    kind: 'yearly_completion_goals',
    parent: null,
    after: null,
    ordinal: 0,
    segment: 0,
  });
  expect(erased.removed).toBeGreaterThan(0);
  expect(
    (
      await native.pool.query(
        'SELECT 1 FROM library.yearly_completion_goal WHERE route=$1 AND account_id=$2 LIMIT 1',
        [ownerRoute, owner.actor.accountId],
      )
    ).rowCount,
  ).toBe(0);
}, 120_000);

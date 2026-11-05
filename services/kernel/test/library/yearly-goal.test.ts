import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createOwnedErasureFixture } from './support/erasure-worker.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { routeOf } from '../../src/route/route.ts';
import { receiptKeyCandidates } from '../../src/command/receipt-key.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

let native: Awaited<ReturnType<typeof createOwnedErasureFixture>>;
let owner: Awaited<ReturnType<typeof createOwnedErasureFixture>>['people']['bob'];
let subject = '';
let independent = '';
const path = '/v1/libraryYearlyCompletionGoal';
const metric = 'completed_consumption_occurrences';

beforeAll(async () => {
  native = await createOwnedErasureFixture();
  owner = native.people.bob;
  subject = await native.subject();
  independent = await native.subject();
}, 120_000);

afterAll(async () => {
  await native?.close();
});

type Identity = { accountId: string; bearer: string };

async function request(as: Identity | null, method: string, url: string, body?: unknown, key = crypto.randomUUID()) {
  return native.kernel.handle(
    new Request(`http://kernel.test${url}`, {
      method,
      headers: {
        ...(as ? { authorization: `Bearer ${as.bearer}` } : {}),
        'idempotency-key': JSON.stringify(key),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function call(method: string, url: string, body?: unknown, key = crypto.randomUUID(), as: Identity = owner) {
  const response = await request(as, method, url, body, key);
  return { response, value: await response.json() };
}

async function read(year: number) {
  const result = await call('GET', `${path}?year=${year}`);
  expect(result.response.status).toBe(200);
  return result.value;
}

async function change(year: number, target: number | null, expectedRevision: string | null, key = crypto.randomUUID()) {
  return call('PUT', path, { year, metric, target, expectedRevision }, key);
}

async function occurrence(subjectId: string, finishDate?: { year: number; month?: number; day?: number }) {
  const started = await call('POST', '/v1/progressSessions', { subjectId, mode: 'scalar_amount', unit: 'page' });
  expect(started.response.status).toBe(201);
  const id = started.value.progressSession.id as string;
  if (finishDate) {
    const journal = await call('PATCH', `/v1/progressSessions/${id}/journal`, { revision: 0, finishDate });
    expect(journal.response.status).toBe(200);
  }
  const completed = await call('POST', `/v1/progressSessions/${id}:complete`, { revision: 1 });
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

  const key = crypto.randomUUID();
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
    expect((await request(owner, 'GET', path + query)).status).toBe(400);
  for (const body of [
    { year: 2026, metric, target: 1.5, expectedRevision: null },
    { year: 2026, metric, target: '2', expectedRevision: null },
    { year: 2026, metric, target: 1001, expectedRevision: null },
    { year: 2026.5, metric, target: 2, expectedRevision: null },
    { year: 2026, metric, target: null, expectedRevision: null },
  ])
    expect((await request(owner, 'PUT', path, body)).status).toBe(400);
  expect((await request(null, 'GET', `${path}?year=2026`)).status).toBe(401);
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
  const route = await native.db.pool.query<{ route: number }>('SELECT route FROM access.account WHERE account_id=$1', [
    owner.accountId,
  ]);
  const ownerRoute = route.rows[0]!.route;
  try {
    await native.db.pool.query(
      'UPDATE library.consumption_statistics_installation SET complete=false WHERE singleton=true',
    );
    const unavailable = await read(2030);
    expect(unavailable.progress).toEqual({ state: 'unavailable', reason: 'summary_unavailable' });
    expect(unavailable.viewer.actions.editTarget).toEqual({ allowed: true });
    expect((await change(2030, 6, seeded.value.revision)).response.status).toBe(200);
  } finally {
    await native.db.pool.query(
      'UPDATE library.consumption_statistics_installation SET complete=true WHERE singleton=true',
    );
  }

  for (const size of [64, 512, 4096]) {
    await native.db.pool.query('DELETE FROM library.yearly_completion_goal WHERE route=$1 AND account_id=$2', [
      ownerRoute,
      owner.accountId,
    ]);
    await native.db.pool.query(
      `INSERT INTO library.yearly_completion_goal(route,account_id,year,target,revision)
       SELECT $1,$2,year,1,1 FROM generate_series(1,$3::integer) AS years(year)`,
      [ownerRoute, owner.accountId, size],
    );
    expect(await read(size)).toMatchObject({ target: { state: 'set', target: 1, revision: '1' } });
  }
  await native.db.pool.query('DELETE FROM library.yearly_completion_goal WHERE route=$1 AND account_id=$2', [
    ownerRoute,
    owner.accountId,
  ]);
}, 120_000);

test('foreign owners see only their own goal state and account retirement erases goal rows', async () => {
  await change(2041, 12, null);
  const other = native.people.alice;
  const hidden = await request(other, 'GET', `${path}?year=2041`);
  expect(hidden.status).toBe(200);
  expect((await hidden.json()).target).toEqual({ state: 'none', revision: null });

  const key = crypto.randomUUID();
  const commandBody = { year: 2040, metric, target: 12, expectedRevision: null };
  const originalCommand = () =>
    native.kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${owner.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
        },
        body: JSON.stringify(commandBody),
      }),
    );
  const original = await originalCommand();
  expect(original.status).toBe(200);
  expect(await original.json()).toMatchObject({ target: 12, revision: '1' });
  const receipt = () =>
    native.db.pool.query<{ request_digest: Buffer; response: unknown }>(
      `SELECT request_digest,response FROM core.receipt
       WHERE principal_id=$1 AND command_kind='library.yearly_completion_goal.change' AND idempotency_key=ANY($2::text[])`,
      [
        owner.accountId,
        receiptKeyCandidates(
          testReceiptKeys(),
          'library.yearly_completion_goal.change',
          { kind: 'account', id: owner.accountId },
          key,
        ),
      ],
    );
  const receiptBefore = await receipt();
  expect(receiptBefore.rows).toHaveLength(1);
  await deletePersona(native.options, owner);
  expect((await originalCommand()).status).toBe(401);
  const ownerRoute = routeOf(owner.accountId)!;
  const erased = await purgeOwnedGraphPage(native.db.pool, {
    accountId: owner.accountId,
    kind: 'yearly_completion_goals',
    parent: null,
    after: null,
    ordinal: 0,
    segment: 0,
  });
  expect(erased.removed).toBeGreaterThan(0);
  expect(
    (
      await native.db.pool.query(
        'SELECT 1 FROM library.yearly_completion_goal WHERE route=$1 AND account_id=$2 LIMIT 1',
        [ownerRoute, owner.accountId],
      )
    ).rowCount,
  ).toBe(0);
  const receiptAfter = await receipt();
  expect(receiptAfter.rows).toEqual(receiptBefore.rows);
}, 120_000);

test('HTTP boundary requires an owner and rejects noncanonical years and coercive goal commands', async () => {
  const valid = { year: 2060, metric, target: 4, expectedRevision: null };
  expect((await request(null, 'GET', `${path}?year=2060`)).status).toBe(401);
  expect((await request(null, 'PUT', path, valid)).status).toBe(401);

  for (const query of ['year=02060', 'year=0', 'year=2060&year=2061', 'year=2060&extra=1'])
    expect((await request(owner, 'GET', `${path}?${query}`)).status).toBe(400);

  const invalidBodies = [
    { ...valid, year: '2060' },
    { ...valid, target: 4.5 },
    { ...valid, target: 1001 },
    { ...valid, expectedRevision: 0 },
    { ...valid, metric: 'completed_sessions' },
    { ...valid, extra: true },
    { ...valid, target: null, expectedRevision: null },
  ];
  for (const body of invalidBodies) expect((await request(owner, 'PUT', path, body)).status).toBe(400);
});

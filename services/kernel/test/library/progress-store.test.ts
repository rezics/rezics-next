import { afterAll, expect, test } from 'bun:test';
import pg, { type Pool, type PoolClient } from 'pg';
import type { ProgressSessionDraft, ProgressSessionUpdate, ProgressState } from '../../src/library/progress-model.ts';
import * as store from '../../src/library/progress-store.ts';
import {
  assertGrowth,
  measure,
  openGrowthDatabase,
  seed,
  type GrowthSample,
  type Population,
} from '../support/growth.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const route = 0x1234;
const time = '2026-10-26T12:00:00.000Z';
const later = '2026-10-27T12:00:00.000Z';
const newest = '2026-10-28T12:00:00.000Z';
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;

function context(n: number, at = time) {
  return { transactionId: id(n), time: at };
}

function draft(
  sessionId: string,
  accountId: string,
  subjectId: string,
  mode: ProgressSessionDraft['mode'],
  unit: ProgressSessionDraft['unit'],
  total: string | null = null,
  versionSubjectId: string | null = null,
): ProgressSessionDraft {
  return { id: sessionId, accountId, subjectId, versionSubjectId, mode, unit, total };
}

function value(state: ProgressState, fields: Partial<ProgressSessionUpdate> = {}): ProgressSessionUpdate {
  return {
    amount: null,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state,
    completedAt: state === 'completed' ? later : null,
    ...fields,
  };
}

async function inTransaction<T>(database: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    return await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function expectSqlState(client: PoolClient, code: string, body: () => Promise<unknown>): Promise<void> {
  await client.query('SAVEPOINT expect_sqlstate');
  let thrown: unknown;
  try {
    await body();
  } catch (error) {
    thrown = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expect_sqlstate');
  expect(thrown).toMatchObject({ code });
}

const sessionColumns = `route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount,
  locator, position, completed_unit_count, state, revision, started_at, completed_at, transaction_id`;

async function insertRaw(
  client: PoolClient,
  row: {
    sessionId?: string;
    accountId?: string;
    mode?: string;
    unit?: string;
    total?: string | null;
    amount?: string | null;
    locator?: string | null;
    position?: string | null;
    completedUnitCount?: number;
    state?: string;
    completedAt?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO library.progress_session (${sessionColumns})
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $14, $15)`,
    [
      route,
      row.sessionId ?? id(700),
      row.accountId ?? id(701),
      id(702),
      row.mode ?? 'scalar_amount',
      row.unit ?? 'minute',
      row.total ?? null,
      row.amount ?? null,
      row.locator ?? null,
      row.position ?? null,
      row.completedUnitCount ?? 0,
      row.state ?? 'active',
      time,
      row.completedAt ?? null,
      id(703),
    ],
  );
}

test('each mode round-trips only its own columns in the owner partition', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(1);
    const subjectId = id(2);
    const versionSubjectId = id(3);

    const scalar = await store.insertSession(
      client,
      route,
      draft(id(10), accountId, subjectId, 'scalar_amount', 'minute', '120', versionSubjectId),
      context(10),
    );
    expect(scalar).toEqual({
      id: id(10),
      accountId,
      subjectId,
      versionSubjectId,
      mode: 'scalar_amount',
      unit: 'minute',
      total: '120',
      amount: null,
      locator: null,
      position: null,
      completedUnitCount: 0,
      state: 'active',
      revision: 1,
      startedAt: time,
      completedAt: null,
      transactionId: id(10),
    });
    expect(await store.readSession(client, route, scalar.id)).toEqual(scalar);
    expect(await store.readSession(client, route + 1, scalar.id)).toBeNull();
    expect(await store.readSession(client, route, id(99))).toBeNull();

    const recorded = await store.updateSession(
      client,
      route,
      scalar.id,
      1,
      value('active', { amount: '1.50', completedAt: null }),
      context(11, later),
    );
    expect(recorded).toEqual({
      ...scalar,
      amount: '1.50',
      revision: 2,
      transactionId: id(11),
    });
    expect(
      await store.updateSession(
        client,
        route,
        scalar.id,
        1,
        value('active', { amount: '9', completedAt: null }),
        context(12),
      ),
    ).toBeNull();
    expect(await store.readSession(client, route, scalar.id)).toEqual(recorded);

    const cursor = await store.insertSession(
      client,
      route,
      draft(id(20), accountId, subjectId, 'cursor_position', 'page', null, versionSubjectId),
      context(20),
    );
    expect(cursor).toMatchObject({
      id: id(20),
      mode: 'cursor_position',
      unit: 'page',
      total: null,
      amount: null,
      locator: null,
      position: null,
      completedUnitCount: 0,
      state: 'active',
      versionSubjectId,
    });
    const forward = await store.updateSession(
      client,
      route,
      cursor.id,
      1,
      value('active', { locator: 'chapter:three', position: '90.5', completedAt: null }),
      context(21),
    );
    const backward = await store.updateSession(
      client,
      route,
      cursor.id,
      2,
      value('active', { locator: 'chapter:one', position: '12.25', completedAt: null }),
      context(22, later),
    );
    expect(backward).toMatchObject({
      locator: 'chapter:one',
      position: '12.25',
      state: 'active',
      completedAt: null,
      revision: 3,
      transactionId: id(22),
    });
    expect(forward?.locator).toBe('chapter:three');
    expect(await store.readSession(client, route, scalar.id)).toEqual(recorded);

    const units = await store.insertSession(
      client,
      route,
      draft(id(30), accountId, subjectId, 'completed_units', 'chapter'),
      context(30),
    );
    expect(await store.addUnits(client, route, units.id, ['7', '1', '3'], context(31))).toBe(3);
    expect(await store.addUnits(client, route, units.id, ['1', '3'], context(32))).toBe(0);
    const counted = await store.updateSession(
      client,
      route,
      units.id,
      1,
      value('active', { completedUnitCount: 3, completedAt: null }),
      context(33),
    );
    expect(counted).toMatchObject({
      mode: 'completed_units',
      amount: null,
      locator: null,
      position: null,
      completedUnitCount: 3,
      state: 'active',
      revision: 2,
    });
    expect(
      (await store.pageUnits(client, route, units.id, { after: null, limit: 10 })).map((unit) => unit.unitId),
    ).toEqual(['1', '3', '7']);
    expect(await store.pageUnits(client, route, scalar.id, { after: null, limit: 10 })).toEqual([]);

    const percent = await store.insertSession(
      client,
      route,
      draft(id(40), accountId, subjectId, 'scalar_amount', 'percent', '100'),
      context(40),
    );
    const full = await store.updateSession(
      client,
      route,
      percent.id,
      1,
      value('active', { amount: '100', completedAt: null }),
      context(41),
    );
    expect(full).toMatchObject({ unit: 'percent', total: '100', amount: '100', state: 'active' });
    const zero = await store.updateSession(
      client,
      route,
      percent.id,
      2,
      value('active', { amount: '0', completedAt: null }),
      context(42),
    );
    expect(zero).toMatchObject({ amount: '0', total: '100' });
  });
});

test('the mode check rejects columns from another mode and a percent of 101', async () => {
  await inTransaction(pool, async (client) => {
    await expectSqlState(client, '23514', () => insertRaw(client, { locator: 'page' }));
    await expectSqlState(client, '23514', () => insertRaw(client, { position: '1' }));
    await expectSqlState(client, '23514', () => insertRaw(client, { completedUnitCount: 1 }));
    await expectSqlState(client, '23514', () =>
      insertRaw(client, { mode: 'cursor_position', unit: 'page', amount: '1', locator: 'page', position: '1' }),
    );
    await expectSqlState(client, '23514', () =>
      insertRaw(client, { mode: 'cursor_position', unit: 'page', total: '10', locator: 'page', position: '1' }),
    );
    await expectSqlState(client, '23514', () =>
      insertRaw(client, { mode: 'completed_units', unit: 'chapter', amount: '1', completedUnitCount: 1 }),
    );
    await expectSqlState(client, '23514', () =>
      insertRaw(client, {
        mode: 'completed_units',
        unit: 'chapter',
        locator: '1',
        position: '1',
        completedUnitCount: 1,
      }),
    );
    await expectSqlState(client, '23514', () => insertRaw(client, { unit: 'percent', total: '100', amount: '101' }));
    await expectSqlState(client, '23514', () => insertRaw(client, { unit: 'percent', total: '101' }));
    await expectSqlState(client, '23514', () => insertRaw(client, { state: 'completed' }));
    await expectSqlState(client, '23514', () => insertRaw(client, { state: 'active', completedAt: time }));
    await expectSqlState(client, '23514', () =>
      store.insertSession(client, route + 1, draft(id(710), id(711), id(712), 'scalar_amount', 'minute'), context(710)),
    );

    await insertRaw(client, { sessionId: id(720), unit: 'minute', amount: '101' });
    await insertRaw(client, { sessionId: id(721), unit: 'percent', total: '100', amount: '100' });
    await insertRaw(client, { sessionId: id(722), unit: 'percent', total: '0', amount: '0' });
    expect(await store.readSession(client, route, id(720))).toMatchObject({ amount: '101', unit: 'minute' });
    expect(await store.readSession(client, route, id(721))).toMatchObject({ amount: '100', total: '100' });
  });
});

test('a sparse unit set keeps the given ids and an absent removal changes nothing', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(50);
    const subjectId = id(51);
    const session = await store.insertSession(
      client,
      route,
      draft(id(52), accountId, subjectId, 'completed_units', 'episode'),
      context(52),
    );
    const other = await store.insertSession(
      client,
      route,
      draft(id(53), accountId, subjectId, 'completed_units', 'episode'),
      context(53),
    );
    expect(await store.addUnits(client, route, session.id, ['7', '1', '3', '10', '2'], context(54))).toBe(5);
    expect(await store.addUnits(client, route, other.id, ['9'], context(55))).toBe(1);

    const idsOf = async (sessionId: string) =>
      (await store.pageUnits(client, route, sessionId, { after: null, limit: 10 })).map((unit) => unit.unitId);
    expect(await idsOf(session.id)).toEqual(['1', '10', '2', '3', '7']);
    expect(await idsOf(session.id)).not.toEqual(['1', '2', '3', '7', '10']);

    const before = await store.pageUnits(client, route, session.id, { after: null, limit: 10 });
    expect(await store.removeUnits(client, route, session.id, ['absent'])).toBe(0);
    expect(await store.removeUnits(client, route, session.id, ['4', '5', '6'])).toBe(0);
    expect(await store.pageUnits(client, route, session.id, { after: null, limit: 10 })).toEqual(before);
    expect(await store.readSession(client, route, session.id)).toMatchObject({ completedUnitCount: 0, revision: 1 });

    expect(await store.removeUnits(client, route, session.id, ['3', 'absent'])).toBe(1);
    expect(await idsOf(session.id)).toEqual(['1', '10', '2', '7']);
    expect(await idsOf(other.id)).toEqual(['9']);

    const first = await store.pageUnits(client, route, session.id, { after: null, limit: 2 });
    const second = await store.pageUnits(client, route, session.id, {
      after: { unitId: first[1]!.unitId },
      limit: 2,
    });
    const third = await store.pageUnits(client, route, session.id, {
      after: { unitId: second[1]!.unitId },
      limit: 2,
    });
    expect([first, second, third].map((page) => page.map((unit) => unit.unitId))).toEqual([
      ['1', '10'],
      ['2', '7'],
      [],
    ]);
    expect(await store.pageUnits(client, route + 1, session.id, { after: null, limit: 10 })).toEqual([]);
    expect(first.every((unit) => unit.sessionId === session.id && unit.addedAt === time)).toBe(true);
  });
});

test('a reread is a separate session and leaves the earlier completion untouched', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(60);
    const otherAccountId = id(61);
    const subjectId = id(62);
    const otherSubjectId = id(63);
    const first = await store.insertSession(
      client,
      route,
      draft(id(64), accountId, subjectId, 'scalar_amount', 'minute', '40'),
      context(64),
    );
    const completed = await store.updateSession(
      client,
      route,
      first.id,
      1,
      value('completed', { amount: '40' }),
      context(65, later),
    );
    expect(completed).toEqual({
      ...first,
      amount: '40',
      state: 'completed',
      completedAt: later,
      revision: 2,
      transactionId: id(65),
    });

    const reread = await store.insertSession(
      client,
      route,
      draft(id(66), accountId, subjectId, 'scalar_amount', 'minute', '40'),
      context(66, newest),
    );
    expect(reread.id).not.toBe(first.id);
    expect(reread).toMatchObject({
      subjectId,
      state: 'active',
      completedAt: null,
      amount: null,
      startedAt: newest,
      revision: 1,
    });
    expect(await store.readSession(client, route, first.id)).toEqual(completed);

    await store.insertSession(
      client,
      route,
      draft(id(67), otherAccountId, subjectId, 'scalar_amount', 'minute'),
      context(67, newest),
    );
    await store.insertSession(
      client,
      route,
      draft(id(68), accountId, otherSubjectId, 'cursor_position', 'page'),
      context(68, time),
    );

    const owned = await store.pageSessions(client, route, accountId, subjectId, { after: null, limit: 10 });
    expect(owned.map((session) => session.id)).toEqual([reread.id, first.id]);
    expect(owned.find((session) => session.id === first.id)).toEqual(completed);
    expect(owned.every((session) => session.accountId === accountId && session.subjectId === subjectId)).toBe(true);

    const page = await store.pageSessions(client, route, accountId, subjectId, { after: null, limit: 1 });
    const rest = await store.pageSessions(client, route, accountId, subjectId, {
      after: { startedAt: page[0]!.startedAt, sessionId: page[0]!.id },
      limit: 1,
    });
    expect([page[0]!.id, rest[0]!.id]).toEqual([reread.id, first.id]);
    expect(
      await store.pageSessions(client, route, accountId, subjectId, {
        after: { startedAt: rest[0]!.startedAt, sessionId: rest[0]!.id },
        limit: 1,
      }),
    ).toEqual([]);
    expect(
      await store.pageSessions(client, route, otherAccountId, subjectId, { after: null, limit: 10 }),
    ).toMatchObject([{ id: id(67), accountId: otherAccountId }]);
    expect(
      await store.pageSessions(client, route, accountId, otherSubjectId, { after: null, limit: 10 }),
    ).toMatchObject([{ id: id(68), subjectId: otherSubjectId }]);
    expect(await store.pageSessions(client, route + 1, accountId, subjectId, { after: null, limit: 10 })).toEqual([]);

    const sameTime = [
      await store.insertSession(
        client,
        route,
        draft(id(70), accountId, subjectId, 'scalar_amount', 'page'),
        context(70, time),
      ),
      await store.insertSession(
        client,
        route,
        draft(id(69), accountId, subjectId, 'scalar_amount', 'page'),
        context(69, time),
      ),
    ];
    expect(sameTime.map((session) => session.startedAt)).toEqual([time, time]);
    const tied = await store.pageSessions(client, route, accountId, subjectId, {
      after: { startedAt: time, sessionId: first.id },
      limit: 2,
    });
    expect(tied.map((session) => session.id)).toEqual([id(69), id(70)]);
  });
});

test('change history is numbered per session and stores the exact intent', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(80);
    const subjectId = id(81);
    const session = await store.insertSession(
      client,
      route,
      draft(id(82), accountId, subjectId, 'completed_units', 'volume'),
      context(82),
    );
    const other = await store.insertSession(
      client,
      route,
      draft(id(83), accountId, subjectId, 'completed_units', 'volume'),
      context(83),
    );
    const firstIntent = { add: ['7', '1', '3'] };
    const secondIntent = { remove: ['3'] };
    const bothIntent = { add: ['b', 'a'], remove: ['d', 'c'] };
    const first = await store.appendChange(client, route, session.id, 1, firstIntent, context(84));
    const second = await store.appendChange(client, route, session.id, 2, secondIntent, context(85, later));
    const third = await store.appendChange(client, route, session.id, 3, bothIntent, context(86, newest));
    const foreign = await store.appendChange(client, route, other.id, 1, { add: ['only-other'] }, context(87));

    expect(first).toEqual({
      sessionId: session.id,
      changeNo: 1,
      intent: firstIntent,
      recordedAt: time,
      transactionId: id(84),
    });
    expect(second.intent).toEqual(secondIntent);
    expect(third.intent).toEqual(bothIntent);

    const page = async (after: number | null, limit: number) =>
      store.pageChanges(client, route, session.id, { after: after === null ? null : { changeNo: after }, limit });
    expect(await page(null, 10)).toEqual([first, second, third]);
    expect((await page(null, 2)).map((change) => change.changeNo)).toEqual([1, 2]);
    expect((await page(2, 2)).map((change) => change.changeNo)).toEqual([3]);
    expect(await page(3, 2)).toEqual([]);
    expect(await store.pageChanges(client, route, other.id, { after: null, limit: 10 })).toEqual([foreign]);
    expect(await store.pageChanges(client, route + 1, session.id, { after: null, limit: 10 })).toEqual([]);

    await expectSqlState(client, '23505', () =>
      store.appendChange(client, route, session.id, 1, firstIntent, context(88)),
    );
    await expectSqlState(client, '23514', () =>
      store.appendChange(client, route, session.id, 0, firstIntent, context(89)),
    );
    expect(await page(null, 10)).toEqual([first, second, third]);
  });
});

function routed(prefix: string, ownerRoute: number, ordinal: number): string {
  return `${prefix}-0000-7000-8000-${ownerRoute.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

const population: Population = {
  name: 'library-progress',
  hotPartition: route >>> 4,
  hotShare: 0.5,
  rows(place) {
    const accountId = routed('10000000', place.route, place.ordinal);
    const sessionId = routed('20000000', place.route, place.ordinal);
    const subjectId = routed('30000000', place.route, place.ordinal);
    const transactionId = routed('40000000', place.route, place.ordinal);
    return {
      'library.progress_session': [
        {
          route: place.route,
          session_id: sessionId,
          account_id: accountId,
          subject_id: subjectId,
          version_subject_id: null,
          mode: 'scalar_amount',
          unit: 'minute',
          total: null,
          amount: null,
          locator: null,
          position: null,
          completed_unit_count: 0,
          state: 'active',
          revision: 1,
          started_at: time,
          completed_at: null,
          transaction_id: transactionId,
        },
      ],
      'library.progress_unit': [{ route: place.route, session_id: sessionId, unit_id: 'unrelated', added_at: time }],
      'library.progress_change': [
        {
          route: place.route,
          session_id: sessionId,
          change_no: 1,
          intent: { amount: '0' },
          recorded_at: time,
          transaction_id: transactionId,
        },
      ],
    };
  },
};

test('unit add, unit page and change page touch the same rows and statements at three scales', async () => {
  const database = await openGrowthDatabase();
  const owner = id(900_000);
  const subjectId = id(900_001);
  const sessionId = id(900_002);
  const scales = [1_000, 8_000, 64_000] as const;
  try {
    await database.admin.query(
      `INSERT INTO library.progress_session (${sessionColumns})
       VALUES ($1, $2, $3, $4, NULL, 'completed_units', 'chapter', NULL, NULL, NULL, NULL, 2, 'active', 1, $5, NULL, $6)`,
      [route, sessionId, owner, subjectId, time, id(900_010)],
    );
    await database.admin.query(
      `INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)
       VALUES ($1, $2, '1', $3), ($1, $2, '3', $3)`,
      [route, sessionId, time],
    );
    await database.admin.query(
      `INSERT INTO library.progress_change (route, session_id, change_no, intent, recorded_at, transaction_id)
       VALUES ($1, $2, 1, $3::jsonb, $4, $5), ($1, $2, 2, $6::jsonb, $4, $5)`,
      [route, sessionId, JSON.stringify({ add: ['1'] }), time, id(900_011), JSON.stringify({ add: ['3'] })],
    );

    const addSamples: GrowthSample[] = [];
    const unitPageSamples: GrowthSample[] = [];
    const changePageSamples: GrowthSample[] = [];
    let previous = 0;
    for (const scale of scales) {
      await seed(database, population, { from: previous, to: scale });

      const added = await measure(database, () =>
        inTransaction(database.pool, (client) => store.addUnits(client, route, sessionId, ['9'], context(900_100))),
      );
      expect(added.value).toBe(1);
      expect(added.cost.statements).toBe(1);
      expect(added.cost.relations?.['library.progress_unit']?.sequentialScans ?? 0).toBe(0);
      addSamples.push({ scale, cost: added.cost });

      const unitPage = await measure(database, () =>
        inTransaction(database.pool, (client) => store.pageUnits(client, route, sessionId, { after: null, limit: 1 })),
      );
      expect(unitPage.value).toMatchObject([{ sessionId, unitId: '1' }]);
      expect(unitPage.cost.statements).toBe(1);
      expect(unitPage.cost.relations?.['library.progress_unit']?.sequentialScans ?? 0).toBe(0);
      unitPageSamples.push({ scale, cost: unitPage.cost });

      const changePage = await measure(database, () =>
        inTransaction(database.pool, (client) =>
          store.pageChanges(client, route, sessionId, { after: null, limit: 1 }),
        ),
      );
      expect(changePage.value).toMatchObject([{ sessionId, changeNo: 1, intent: { add: ['1'] } }]);
      expect(changePage.cost.statements).toBe(1);
      expect(changePage.cost.relations?.['library.progress_change']?.sequentialScans ?? 0).toBe(0);
      changePageSamples.push({ scale, cost: changePage.cost });
      previous = scale;
    }

    const relationRows = (samples: GrowthSample[], relation: string) =>
      samples.map((sample) => sample.cost.relations?.[relation]?.rows ?? 0);
    const same = (values: number[]) => values.every((value) => value === values[0] && value > 0);
    expect(addSamples.map((sample) => sample.cost.statements)).toEqual([1, 1, 1]);
    expect(unitPageSamples.map((sample) => sample.cost.statements)).toEqual([1, 1, 1]);
    expect(changePageSamples.map((sample) => sample.cost.statements)).toEqual([1, 1, 1]);
    expect(same(relationRows(addSamples, 'library.progress_unit'))).toBe(true);
    expect(same(relationRows(unitPageSamples, 'library.progress_unit'))).toBe(true);
    expect(same(relationRows(changePageSamples, 'library.progress_change'))).toBe(true);
    expect(same(addSamples.map((sample) => sample.cost.rows))).toBe(true);
    expect(same(unitPageSamples.map((sample) => sample.cost.rows))).toBe(true);
    expect(same(changePageSamples.map((sample) => sample.cost.rows))).toBe(true);

    const bounded = (samples: GrowthSample[], relation: string): GrowthSample[] =>
      samples.map((sample) => ({
        scale: sample.scale,
        cost: { ...sample.cost, rows: sample.cost.relations?.[relation]?.rows ?? 0 },
      }));
    assertGrowth(bounded(addSamples, 'library.progress_unit'), {
      rows: 'constant',
      blocks: 'logarithmic',
      statements: 'constant',
    });
    assertGrowth(bounded(unitPageSamples, 'library.progress_unit'), {
      rows: 'constant',
      blocks: 'logarithmic',
      statements: 'constant',
    });
    assertGrowth(bounded(changePageSamples, 'library.progress_change'), {
      rows: 'constant',
      blocks: 'logarithmic',
      statements: 'constant',
    });
  } finally {
    await database.close();
  }
});

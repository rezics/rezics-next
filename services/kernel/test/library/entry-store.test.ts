import { afterAll, expect, test } from 'bun:test';
import pg, { type Pool, type PoolClient } from 'pg';
import type { CopyChanges, CopyDraft, EntryDraft, EntryState } from '../../src/library/entry-model.ts';
import * as store from '../../src/library/entry-store.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const route = 0x1234;
const time = '2026-10-26T12:00:00.000Z';
const later = '2026-10-27T12:00:00.000Z';
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;

function context(n: number, at = time) {
  return { transactionId: id(n), time: at };
}

function entryDraft(
  accountId: string,
  subjectId: string,
  state: EntryState,
  requestedSubjectId: string | null = null,
): EntryDraft {
  return { accountId, subjectId, requestedSubjectId, state };
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

test('an entry round trip changes state only when the revision matches', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(1);
    const subjectId = id(2);
    const inserted = await store.insertEntry(
      client,
      route,
      entryDraft(accountId, subjectId, 'planned', id(3)),
      context(10),
    );
    expect(inserted).toEqual({
      accountId,
      subjectId,
      requestedSubjectId: id(3),
      state: 'planned',
      revision: 1,
      createdAt: time,
      updatedAt: time,
      transactionId: id(10),
    });
    expect(await store.readEntry(client, route, accountId, subjectId)).toEqual(inserted);
    expect(await store.readEntry(client, route + 1, accountId, subjectId)).toBeNull();
    expect(await store.readEntry(client, route, id(9), subjectId)).toBeNull();

    const updated = await store.updateEntryState(
      client,
      route,
      accountId,
      subjectId,
      1,
      'in_progress',
      context(11, later),
    );
    expect(updated).toEqual({
      ...inserted,
      state: 'in_progress',
      revision: 2,
      updatedAt: later,
      transactionId: id(11),
    });
    expect(await store.updateEntryState(client, route, accountId, subjectId, 1, 'completed', context(12))).toBeNull();
    expect(await store.deleteEntry(client, route, accountId, subjectId, 1)).toBeNull();
    expect(await store.readEntry(client, route, accountId, subjectId)).toEqual(updated);

    expect(await store.deleteEntry(client, route, accountId, subjectId, 2)).toEqual(updated);
    expect(await store.readEntry(client, route, accountId, subjectId)).toBeNull();
    expect(await store.deleteEntry(client, route, accountId, subjectId, 2)).toBeNull();
  });
});

test('one library entry exists per account and subject', async () => {
  await inTransaction(pool, async (client) => {
    const subjectId = id(20);
    const first = await store.insertEntry(client, route, entryDraft(id(21), subjectId, 'planned'), context(21));
    const second = await store.insertEntry(client, route, entryDraft(id(22), subjectId, 'completed'), context(22));
    expect(first.subjectId).toBe(second.subjectId);
    expect(first.accountId).not.toBe(second.accountId);

    await expectSqlState(client, '23505', () =>
      store.insertEntry(client, route, entryDraft(id(21), subjectId, 'dropped', id(23)), context(23)),
    );
    expect(await store.readEntry(client, route, id(21), subjectId)).toEqual(first);
    expect(await store.readEntry(client, route, id(22), subjectId)).toEqual(second);
  });
});

test('copies of one edition keep separate ids and ignore a stale revision', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(40);
    const edition = id(41);
    const draft = (copyId: string, note: string): CopyDraft => ({
      id: copyId,
      accountId,
      subjectId: edition,
      status: 'owned',
      location: 'Study',
      source: 'Bookshop',
      acquiredOn: '2030-01-01',
      disposedOn: null,
      note,
    });
    const first = await store.insertCopy(client, route, draft(id(42), 'First copy'), context(42));
    const second = await store.insertCopy(client, route, draft(id(43), 'Second copy'), context(43));
    expect(second.id).not.toBe(first.id);
    expect(first).toEqual({
      id: id(42),
      accountId,
      subjectId: edition,
      status: 'owned',
      location: 'Study',
      source: 'Bookshop',
      acquiredOn: '2030-01-01',
      disposedOn: null,
      note: 'First copy',
      revision: 1,
      createdAt: time,
      updatedAt: time,
      transactionId: id(42),
    });
    expect(await store.readCopy(client, route, first.id)).toEqual(first);
    expect(await store.readCopy(client, route + 1, first.id)).toBeNull();
    expect(second).toMatchObject({ id: id(43), subjectId: edition, note: 'Second copy', revision: 1 });

    const changes: CopyChanges = {
      status: 'lent',
      location: 'Friend',
      source: 'Bookshop',
      acquiredOn: '2030-01-01',
      disposedOn: null,
      note: 'Loan',
    };
    const changed = await store.updateCopy(client, route, first.id, 1, changes, context(44, later));
    expect(changed).toEqual({
      ...first,
      ...changes,
      revision: 2,
      updatedAt: later,
      transactionId: id(44),
    });
    expect(
      await store.updateCopy(client, route, first.id, 1, { ...changes, status: 'disposed' }, context(45)),
    ).toBeNull();
    expect(await store.deleteCopy(client, route, first.id, 1, context(49, later))).toBeNull();
    expect(await store.readCopy(client, route, first.id)).toEqual(changed);
    expect(await store.readCopy(client, route, second.id)).toEqual(second);

    const disposed: CopyChanges = {
      status: 'disposed',
      location: null,
      source: 'Bookshop',
      acquiredOn: '2030-01-01',
      disposedOn: '2030-02-02',
      note: 'n'.repeat(1000),
    };
    const gone = await store.updateCopy(client, route, second.id, 1, disposed, context(46, later));
    expect(gone).toMatchObject({
      status: 'disposed',
      location: null,
      disposedOn: '2030-02-02',
      note: 'n'.repeat(1000),
      revision: 2,
    });
    await expectSqlState(client, '23514', () =>
      store.insertCopy(client, route, { ...draft(id(47), 'too long'), location: 'x'.repeat(201) }, context(47)),
    );
    await expectSqlState(client, '23514', () =>
      store.insertCopy(client, route, { ...draft(id(48), 'y'.repeat(1001)) }, context(48)),
    );
    expect(await store.deleteCopy(client, route, first.id, 2, context(50, later))).toEqual(changed);
    expect(await store.readCopy(client, route, first.id)).toBeNull();
    expect(await store.readCopy(client, route, second.id)).toEqual(gone);
  });
});

test('entry and copy pages walk one owner keyset and hide another account', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(50);
    const otherAccountId = id(80);
    const stamps = [
      '2026-10-24T00:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
      '2026-10-27T00:00:00.000Z',
    ];
    const states: EntryState[] = ['planned', 'in_progress', 'planned', 'completed', 'planned'];
    for (let index = 0; index < 5; index++) {
      await store.insertEntry(
        client,
        route,
        entryDraft(accountId, id(51 + index), states[index]!),
        context(51 + index, stamps[index]),
      );
    }
    await store.insertEntry(
      client,
      route,
      entryDraft(otherAccountId, id(51), 'planned'),
      context(90, '2026-10-28T00:00:00.000Z'),
    );

    const first = await store.pageEntries(client, route, accountId, { after: null, state: null, limit: 2 });
    const second = await store.pageEntries(client, route, accountId, {
      after: { updatedAt: first[1]!.updatedAt, subjectId: first[1]!.subjectId },
      state: null,
      limit: 2,
    });
    const third = await store.pageEntries(client, route, accountId, {
      after: { updatedAt: second[1]!.updatedAt, subjectId: second[1]!.subjectId },
      state: null,
      limit: 2,
    });
    expect([first, second, third].map((page) => page.map((entry) => entry.subjectId))).toEqual([
      [id(55), id(53)],
      [id(54), id(52)],
      [id(51)],
    ]);
    expect([...first, ...second, ...third].every((entry) => entry.accountId === accountId)).toBe(true);

    const planned = [];
    let after: { updatedAt: string; subjectId: string } | null = null;
    for (let page = 0; page < 3; page++) {
      const rows = await store.pageEntries(client, route, accountId, { after, state: 'planned', limit: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('planned');
      planned.push(rows[0]!.subjectId);
      after = { updatedAt: rows[0]!.updatedAt, subjectId: rows[0]!.subjectId };
    }
    expect(planned).toEqual([id(55), id(53), id(51)]);
    expect(await store.pageEntries(client, route, accountId, { after, state: 'planned', limit: 1 })).toEqual([]);
    expect(await store.pageEntries(client, route, accountId, { after: null, state: 'dropped', limit: 10 })).toEqual([]);
    expect(
      await store.pageEntries(client, route, otherAccountId, { after: null, state: null, limit: 10 }),
    ).toMatchObject([{ accountId: otherAccountId, subjectId: id(51) }]);
    expect(await store.pageEntries(client, route + 1, accountId, { after: null, state: null, limit: 10 })).toEqual([]);

    const edition = id(60);
    const created = [
      '2026-10-24T00:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
      '2026-10-27T00:00:00.000Z',
    ];
    for (let index = 0; index < 5; index++) {
      await store.insertCopy(
        client,
        route,
        {
          id: id(61 + index),
          accountId,
          subjectId: edition,
          status: 'ordered',
          location: null,
          source: null,
          acquiredOn: null,
          disposedOn: null,
          note: null,
        },
        context(61 + index, created[index]),
      );
    }
    await store.insertCopy(
      client,
      route,
      {
        id: id(70),
        accountId: otherAccountId,
        subjectId: edition,
        status: 'owned',
        location: null,
        source: null,
        acquiredOn: null,
        disposedOn: null,
        note: null,
      },
      context(70, '2026-10-23T00:00:00.000Z'),
    );

    const copiesFirst = await store.pageCopies(client, route, accountId, { after: null, limit: 2 });
    const copiesSecond = await store.pageCopies(client, route, accountId, {
      after: { createdAt: copiesFirst[1]!.createdAt, copyId: copiesFirst[1]!.id },
      limit: 2,
    });
    const copiesThird = await store.pageCopies(client, route, accountId, {
      after: { createdAt: copiesSecond[1]!.createdAt, copyId: copiesSecond[1]!.id },
      limit: 2,
    });
    expect([copiesFirst, copiesSecond, copiesThird].map((page) => page.map((copy) => copy.id))).toEqual([
      [id(61), id(62)],
      [id(63), id(64)],
      [id(65)],
    ]);
    expect(
      [...copiesFirst, ...copiesSecond, ...copiesThird].every(
        (copy) => copy.accountId === accountId && copy.subjectId === edition,
      ),
    ).toBe(true);
    expect(await store.pageCopies(client, route, otherAccountId, { after: null, limit: 10 })).toMatchObject([
      { id: id(70), accountId: otherAccountId },
    ]);
    expect(await store.pageCopies(client, route + 1, accountId, { after: null, limit: 10 })).toEqual([]);
  });
});

function routed(prefix: string, ownerRoute: number, ordinal: number): string {
  return `${prefix}-0000-7000-8000-${ownerRoute.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

const population: Population = {
  name: 'library-entries',
  hotPartition: route >>> 4,
  hotShare: 0.5,
  rows(place) {
    const accountId = routed('10000000', place.route, place.ordinal);
    const subjectId = routed('20000000', place.route, place.ordinal);
    const transactionId = routed('40000000', place.route, place.ordinal);
    return {
      'library.entry': [
        {
          route: place.route,
          account_id: accountId,
          subject_id: subjectId,
          requested_subject_id: null,
          state: 'planned',
          revision: 1,
          created_at: time,
          updated_at: time,
          transaction_id: transactionId,
        },
      ],
      'library.copy': [
        {
          route: place.route,
          copy_id: routed('30000000', place.route, place.ordinal),
          account_id: accountId,
          subject_id: subjectId,
          status: 'owned',
          location: null,
          source: null,
          acquired_on: null,
          disposed_on: null,
          note: null,
          revision: 1,
          created_at: time,
          updated_at: time,
          transaction_id: transactionId,
        },
      ],
    };
  },
};

function seededRows(): { readonly transactionIds: string[] } {
  return {
    transactionIds: Array.from({ length: 8_000 }, (_, ordinal) => {
      const place = placement(population, ordinal);
      return routed('40000000', place.route, place.ordinal);
    }),
  };
}

async function clearSeededRows(database: GrowthDatabase): Promise<void> {
  const { transactionIds } = seededRows();
  await database.admin.query('DELETE FROM library.entry WHERE transaction_id = ANY($1::uuid[])', [transactionIds]);
  await database.admin.query('DELETE FROM library.copy WHERE transaction_id = ANY($1::uuid[])', [transactionIds]);
}

type GrowthReport = Awaited<ReturnType<typeof checkGrowth>>;

function expectGrowthReport(report: GrowthReport, relation: string): void {
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 4, 16]);
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([1, 1, 1]);
  const relationRows = report.samples.map((sample) => sample.cost.relations?.[relation]?.rows ?? 0);
  expect(relationRows.every((rows) => rows === relationRows[0] && rows > 0)).toBe(true);
  const totalRows = report.samples.map(({ cost }) => cost.rows);
  expect(totalRows.every((rows) => rows === totalRows[0] && rows > 0)).toBe(true);
  expect(
    report.samples.every(({ cost }) =>
      Object.entries(cost.relations ?? {})
        .filter(([name]) => name.startsWith('library.'))
        .every(([, relationCost]) => relationCost.sequentialScans === 0),
    ),
  ).toBe(true);
}

test('entry write, entry page and copy page touch the same rows and statements at three scales', async () => {
  const database = await openGrowthDatabase();
  const owner = id(900_000);
  const subjectId = id(900_001);
  const copyId = id(900_002);
  try {
    await database.admin.query(
      `INSERT INTO library.entry
         (route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at, transaction_id)
       VALUES ($1, $2, $3, NULL, 'planned', 1, $4, $4, $5)`,
      [route, owner, subjectId, time, id(900_010)],
    );
    await database.admin.query(
      `INSERT INTO library.copy
         (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
          created_at, updated_at, transaction_id)
       VALUES ($1, $2, $3, $4, 'owned', NULL, NULL, NULL, NULL, NULL, 1, $5, $5, $6)`,
      [route, copyId, owner, subjectId, time, id(900_011)],
    );

    const write = await checkGrowth(database, {
      name: 'Library entry write',
      scales: [1, 4, 16],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: (growthDatabase, scale, previous) =>
        seed(growthDatabase, population, { from: 500 * previous, to: 500 * scale }),
      operation: (growthDatabase) =>
        inTransaction(growthDatabase.pool, async (client) => {
          const written = await store.updateEntryState(
            client,
            route,
            owner,
            subjectId,
            1,
            'paused',
            context(900_100, later),
          );
          expect(written).toMatchObject({ accountId: owner, subjectId, state: 'paused', revision: 2 });
          return written;
        }),
    });
    expectGrowthReport(write, 'library.entry');

    await clearSeededRows(database);
    const entryPage = await checkGrowth(database, {
      name: 'Library entry page',
      scales: [1, 4, 16],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: (growthDatabase, scale, previous) =>
        seed(growthDatabase, population, { from: 500 * previous, to: 500 * scale }),
      operation: (growthDatabase) =>
        inTransaction(growthDatabase.pool, async (client) => {
          const page = await store.pageEntries(client, route, owner, { after: null, state: null, limit: 1 });
          expect(page).toMatchObject([{ accountId: owner, subjectId }]);
          return page;
        }),
    });
    expectGrowthReport(entryPage, 'library.entry');

    await clearSeededRows(database);
    const copyPage = await checkGrowth(database, {
      name: 'Library copy page',
      scales: [1, 4, 16],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: (growthDatabase, scale, previous) =>
        seed(growthDatabase, population, { from: 500 * previous, to: 500 * scale }),
      operation: (growthDatabase) =>
        inTransaction(growthDatabase.pool, async (client) => {
          const page = await store.pageCopies(client, route, owner, { after: null, limit: 1 });
          expect(page).toMatchObject([{ id: copyId, accountId: owner }]);
          return page;
        }),
    });
    expectGrowthReport(copyPage, 'library.copy');
  } finally {
    await database.close();
  }
});

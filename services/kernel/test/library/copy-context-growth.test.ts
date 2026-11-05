import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { collectionListFactsPopulation } from './support/collection-list-facts-fixture.ts';
import { createCopyListContextFixture } from './copy-list-context-fixture.ts';

test('FULL Copies page growth includes 64/512/4096 unrelated Semantic facts and private copy rows', async () => {
  const db = await openGrowthDatabase();
  const f = await createCopyListContextFixture({ db });
  try {
    const book = await f.create('schema:Book', { 'schema:wordCount': { amount: '+123', unit: '1' } });
    const copy = await f.copy(f.ownerToken, book, 'fixed copy row');
    const repeated = await f.copy(f.ownerToken, book, 'repeated subject copy');
    const sparse = await f.create('schema:Book', {}, { en: 'Sparse copy context' });
    const sparseCopy = await f.copy(f.ownerToken, sparse, 'sparse facts copy');
    const hidden = await f.create('schema:Book', {}, { en: 'Hidden growth context' });
    const hiddenCopy = await f.copy(f.ownerToken, hidden, 'hidden facts copy');
    await f.hide(hidden);
    const mergeTarget = await f.create('schema:Book', {}, { en: 'Current identity target' });
    await f.checked('POST', '/v1/platform/exposure/subject_identity:open', {}, 'operator');
    await f.checked('POST', '/v1/subjects:merge', { subjects: [book, mergeTarget] });
    const semantic = collectionListFactsPopulation(f, book);
    const account = f.accounts.reader;
    const route = routeOf(account)!;
    const loanAccount = f.accounts.editor;
    const loanRoute = routeOf(loanAccount)!;
    const addressedLoan = newId(loanRoute);
    await f.pool.query(
      `INSERT INTO library.copy_loan
        (route,loan_id,account_id,copy_id,direction,counterparty_kind,counterparty_name,counterparty_person_id,
         started_on,due_on,returned_on,revision,created_at,updated_at,transaction_id)
       VALUES ($1,$2,$3,$4,'lent','name','  Native loan counterparty 🐈  ',NULL,
               '2026-10-20','9999-12-31',NULL,1,now(),now(),$5)`,
      [loanRoute, addressedLoan, loanAccount, copy.id, randomUUID()],
    );
    const returnedHistory: Population = {
      name: 'copy-loan-returned-history',
      hotPartition: partitionOf(loanRoute),
      hotShare: 1,
      rows() {
        return {
          'library.copy_loan': [
            {
              route: loanRoute,
              loan_id: newId(loanRoute),
              account_id: loanAccount,
              copy_id: copy.id,
              direction: 'lent',
              counterparty_kind: 'name',
              counterparty_name: 'retained history',
              counterparty_person_id: null,
              started_on: '2018-01-01',
              due_on: '2018-02-01',
              returned_on: '2019-01-01',
              revision: 2,
              created_at: '2018-01-01T00:00:00.000Z',
              updated_at: '2019-01-01T00:00:00.000Z',
              transaction_id: randomUUID(),
            },
          ],
        };
      },
    };
    const copies: Population = {
      name: 'copy-list-context-unrelated-reader-copies',
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows({ ordinal }) {
        const copyId = newId(route);
        return {
          'library.copy': [
            {
              route,
              copy_id: copyId,
              account_id: account,
              subject_id: book,
              status: 'owned',
              location: null,
              source: null,
              acquired_on: null,
              disposed_on: null,
              note: `unrelated ${ordinal}`,
              revision: 1,
              created_at: '2020-01-01T00:00:00.000Z',
              updated_at: '2020-01-01T00:00:00.000Z',
              transaction_id: randomUUID(),
            },
          ],
        };
      },
    };
    const report = await checkGrowth(db, {
      name: 'FULL native Copies list plus one bounded Semantic context batch',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
      async grow(_database, scale, previous) {
        await seed(db, semantic, { from: previous, to: scale });
        await seed(db, copies, { from: previous, to: scale });
        await seed(db, returnedHistory, { from: previous, to: scale });
      },
      async operation() {
        const response = await f.page(f.ownerToken);
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          copies: Array<{ id: string; subjectId: string; context: { state: string } }>;
        };
        expect(result.copies.map(({ id }) => id).sort()).toEqual(
          [copy.id, repeated.id, sparseCopy.id, hiddenCopy.id].sort(),
        );
        expect(result.copies.filter(({ context }) => context.state === 'unsupported')).toHaveLength(3);
        expect(result.copies.find(({ id }) => id === hiddenCopy.id)?.context.state).toBe('withheld');
        expect(result.copies.find(({ id }) => id === copy.id)?.subjectId).toBe(book);
        expect(result.copies.find(({ id }) => id === sparseCopy.id)?.subjectId).toBe(sparse);
        expect(JSON.stringify(result.copies.find(({ id }) => id === hiddenCopy.id)?.context)).not.toContain(hidden);
        const loansResponse = await f.send(f.ownerToken, 'GET', '/v1/copy-loans?filter=open&limit=100');
        expect(loansResponse.status).toBe(200);
        const loans = (await loansResponse.json()) as {
          items: { loan: { id: string; counterparty: { kind: string; name: string } }; copy: { id: string } }[];
        };
        expect(loans.items).toHaveLength(1);
        expect(loans.items[0]).toMatchObject({
          loan: { id: addressedLoan, counterparty: { kind: 'name', name: '  Native loan counterparty 🐈  ' } },
          copy: { id: copy.id },
        });
        expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
        return {};
      },
    });
    const relations = [
      ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations)))),
    ];
    assertGrowthAccessPaths(report.name, report.samples, relations);
    for (const sample of report.samples) {
      expect(sample.cost.plans).toBeGreaterThan(0);
      for (const backends of sample.backendRepetitions) expect(new Set(backends).size).toBeLessThanOrEqual(1);
    }
    console.info(`GROWTH_SAMPLES ${JSON.stringify(report)}`);
  } finally {
    await f.close();
    await db.close();
  }
}, 600_000);

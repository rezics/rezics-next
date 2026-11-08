import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { costTableProblems, readCostTable } from '../support/growth-cost-table.ts';

const missingGrowthChecks = ['Report effect projection'];

const boardOperationChecks = [
  [
    'Board projection source effect (`board-projection.ts:createBoardEffect`)',
    'test/content/board-read-growth.test.ts',
    'Board projection stays within its bound as T grows',
  ],
  [
    'Board projection candidate upsert (`board-projection.ts:applyBoardCandidate`)',
    'test/content/board-projection.test.ts',
    'checkGrowth proves the declared three-scale machine-independent bound',
  ],
  [
    'Board candidate page, descending (`board-projection.ts:readBoardCandidates`)',
    'test/content/board-read-growth.test.ts',
    'Board candidate page stays within its bound as d grows',
  ],
  [
    'Board candidate page, ascending (`board-projection.ts:pageBoardCandidates`)',
    'test/content/board-read-growth.test.ts',
    'Ascending board candidates and the oldest listing stay within their bound as candidates grow',
  ],
  [
    'Board ordered thread pages (`boards.ts:listBoardThreads`)',
    'test/content/growth-board-sorts.test.ts',
    'board pages under newest, oldest, active and hot, with their disclosure passes, stay within the written bound as threads, boards and hidden candidates grow',
  ],
  [
    'Board newest HTTP query and disclosure (`routes.ts:/v1/boards/:id/threads`)',
    'test/content/boards-http.test.ts',
    'checkGrowth proves the declared three-scale machine-independent bound',
  ],
  [
    'Board hot HTTP page (`routes.ts:/v1/boards/:id/threads?sort=hot`)',
    'test/content/board-hot-http.test.ts',
    'the hot page stays within its bound as boards and threads grow',
  ],
  [
    'Board active HTTP page (`routes.ts:/v1/boards/:id/threads?sort=active`)',
    'test/content/board-ranking.test.ts',
    'active board pages keep constant cost as boards and threads grow',
  ],
  [
    'Deep Board pages (empty, withheld, selected)',
    'test/content/board-read-growth.test.ts',
    'Deep Board pages keep empty, withheld, and selected results bounded as unrelated history grows',
  ],
  [
    'Board rank refresh (`board-ranking.ts`)',
    'test/content/board-hot-refresh.test.ts',
    'one refresh batch stays within its bound as candidates and reactions grow',
  ],
  [
    'Public board point read (`reads.ts:readBoard`)',
    'test/content/growth-threads.test.ts',
    'Public board read stays within its bound as T grows',
  ],
  [
    'Realm board listing (`boards.ts:listRealmBoards`)',
    'test/content/realm-boards.test.ts',
    'Realm board keyset listing stays bounded as other Realms add boards',
  ],
  [
    'Protected Realm thread page (`routes.ts:/v1/boards/:id/threads`)',
    'test/content/realm-boards.test.ts',
    'a settled protected Realm member reads its boards, threads and posts',
  ],
  [
    'Global board creation (`board-create.ts:createBoard`, Global branch)',
    'test/content/global-board-create-http.test.ts',
    'a governance account creates published and protected Global boards over HTTP and authors post reviews and discussions on them',
  ],
  [
    'Realm board creation (`board-create.ts:createBoard`, Realm branch)',
    'test/content/board-read-growth.test.ts',
    'Concept board creation stays within its bound as boards grow',
  ],
  [
    'Realm board point read (`boards.ts:readRealmBoard`)',
    'test/content/board-read-growth.test.ts',
    'Realm board read by concept stays within its bound as boards grow',
  ],
  [
    'Sitemap board/thread feeds',
    'test/content/growth-sitemap.test.ts',
    '${feed} sitemap page stays within its bound as listed items grow',
  ],
] as const;

test('the content README Cost table cites an existing growth check for every row', () => {
  const readme = join(import.meta.dir, '../../src/content/README.md');
  const options = {
    testRoot: join(import.meta.dir, '../..'),
    repositoryRoot: join(import.meta.dir, '../../../..'),
  };
  const rows = readCostTable(readme);
  const missing = rows.filter((row) => row.check.startsWith('Missing:'));

  expect(missing.map((row) => row.operation).sort()).toEqual([...missingGrowthChecks].sort());
  expect(costTableProblems(readme, options)).toEqual(
    missing.map(
      (row) =>
        `${readme}: operation "${row.operation}": growth check must be a test citation or "None:" followed by a reason`,
    ),
  );
});

test('every Board Cost row resolves to its producer case and a declared test title', () => {
  const readme = join(import.meta.dir, '../../src/content/README.md');
  const options = {
    testRoot: join(import.meta.dir, '../..'),
    repositoryRoot: join(import.meta.dir, '../../../..'),
  };
  const rows = readCostTable(readme);
  const expectedOperations = boardOperationChecks.map(([operation]) => operation).sort();
  const boardRows = rows.filter((row) =>
    expectedOperations.includes(row.operation as (typeof expectedOperations)[number]),
  );

  expect(boardRows.map((row) => row.operation).sort()).toEqual(expectedOperations);
  for (const [operation, path, title] of boardOperationChecks) {
    const row = boardRows.find((candidate) => candidate.operation === operation);
    expect(row, operation).toBeDefined();
    expect(row!.check, operation).toContain(`\`${path}\`: “${title}”`);
  }

  const boardProblems = costTableProblems(readme, options).filter((problem) =>
    expectedOperations.some((operation) => problem.includes(`operation "${operation}"`)),
  );
  expect(boardProblems).toEqual([]);
});

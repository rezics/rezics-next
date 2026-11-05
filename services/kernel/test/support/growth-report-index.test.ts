import { expect, test } from 'bun:test';
import { formatStatementAttribution, profileStatements } from './growth-report.ts';

type Entry = { statement: string; rows: number; blocks: number; count: number; node?: string };

function tracked(runs: Entry[][]) {
  const reads = runs.map(() => 0);
  return {
    reads,
    runs: runs.map(
      (run, index) =>
        new Proxy(run, {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) reads[index]!++;
            return Reflect.get(target, key, receiver);
          },
        }),
    ),
  };
}

test('indexes each run once and preserves sparse medians, first values, nodes, ties, and intermittent order', () => {
  const small = tracked([
    [
      { statement: 'SELECT A', rows: 4, blocks: 2, count: 5, node: 'A first' },
      { statement: 'SELECT B', rows: 2, blocks: 8, count: 2, node: 'B first' },
      { statement: 'SELECT D', rows: 2, blocks: 1, count: 1, node: 'D node' },
      { statement: 'SELECT A', rows: 100, blocks: 100, count: 100, node: 'A duplicate' },
    ],
    [
      { statement: 'SELECT A', rows: 8, blocks: 6, count: 2, node: 'A middle' },
      { statement: 'SELECT B', rows: 6, blocks: 2, count: 4, node: 'B middle' },
      { statement: 'SELECT E', rows: 2, blocks: 2, count: 1, node: 'E node' },
    ],
    [{ statement: 'SELECT A', rows: 10, blocks: 10, count: 3, node: 'A final' }],
  ]);
  const large = tracked([
    [
      { statement: 'SELECT C', rows: 2, blocks: 3, count: 1, node: 'C first' },
      { statement: 'SELECT A', rows: 20, blocks: 5, count: 2, node: 'A large' },
    ],
    [{ statement: 'SELECT C', rows: 6, blocks: 1, count: 3, node: 'C final' }],
  ]);
  const samples = [
    { scale: 1, statementRepetitions: small.runs },
    { scale: 2, statementRepetitions: large.runs },
  ];

  expect(profileStatements(samples)).toEqual([
    [
      { statement: 'SELECT A', rows: 8, blocks: 6, count: 3 },
      { statement: 'SELECT B', rows: 2, blocks: 2, count: 2 },
      { statement: 'SELECT D', rows: 0, blocks: 0, count: 0 },
      { statement: 'SELECT E', rows: 0, blocks: 0, count: 0 },
    ],
    [
      { statement: 'SELECT A', rows: 10, blocks: 2.5, count: 1 },
      { statement: 'SELECT C', rows: 4, blocks: 2, count: 2 },
    ],
  ]);
  expect([...small.reads, ...large.reads]).toEqual([4, 3, 1, 2, 1]);
  expect(formatStatementAttribution(samples, ['rows', 'blocks'])).toBe(
    '\nStatement attribution:\nStatements growing most for rows:\n' +
      '  SELECT C | 1: 0, 2: 4 | C final\n' +
      '  SELECT A | 1: 8, 2: 10 | A large\n' +
      '  SELECT D | 1: 0, 2: 0 | D node\n' +
      '  SELECT E | 1: 0, 2: 0 | E node\n' +
      '  SELECT B | 1: 2, 2: 0 | B middle\n' +
      'Statements growing most for blocks:\n' +
      '  SELECT C | 1: 0, 2: 2 | C final\n' +
      '  SELECT D | 1: 0, 2: 0 | D node\n' +
      '  SELECT E | 1: 0, 2: 0 | E node\n' +
      '  SELECT B | 1: 2, 2: 0 | B middle\n' +
      '  SELECT A | 1: 6, 2: 2.5 | A large\n' +
      'Intermittent at scale 1: SELECT B ran in repetitions 1, 2\n' +
      'Intermittent at scale 1: SELECT D ran in repetitions 1\n' +
      'Intermittent at scale 1: SELECT E ran in repetitions 2\n' +
      'Intermittent at scale 2: SELECT A ran in repetitions 1',
  );
  expect([...small.reads, ...large.reads]).toEqual([8, 6, 2, 4, 2]);
});

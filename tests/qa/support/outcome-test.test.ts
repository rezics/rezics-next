import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadOutcomes } from '../../../scripts/qa/cases/outcomes.ts';
import { outcomeTest } from './outcome-test.ts';
import { notApplicable, rowOutcomes } from '../../../scripts/qa/cases/outcome-cells.ts';

const root = resolve(import.meta.dir, '../../..');
const declarationsModule = join(root, 'scripts/qa/cases/outcome-cells.ts');
const helperModule = join(import.meta.dir, 'outcome-test.ts');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(state: 'proved' | 'pending', passing: boolean) {
  const directory = mkdtempSync(join(root, '.temp/outcome-test-'));
  directories.push(directory);
  const declaration = join(directory, 'scripts/qa/cases/outcomes/books/read-a-book.ts');
  const file = join(directory, 'tests/qa/integration/outcomes/books/read-a-book.test.ts');
  mkdirSync(dirname(declaration), { recursive: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    declaration,
    `import { rowOutcomes, ${state} } from ${JSON.stringify(declarationsModule)};
export default rowOutcomes('books/read-a-book', { visitor: ${state}('a visitor reads the book') });`,
  );
  writeFileSync(
    file,
    `import { expect } from 'bun:test';
import declaration from ${JSON.stringify(declaration)};
import { outcomeTest } from ${JSON.stringify(helperModule)};
outcomeTest(declaration, 'visitor', async () => { await Promise.resolve(); expect(${passing}).toBe(true); });`,
  );
  return { directory, file };
}

test('outcomeTest throws at load for missing and not-applicable cells', () => {
  const declaration = rowOutcomes('books/read-a-book', {
    operator: notApplicable('No operator action'),
  });
  expect(() => outcomeTest(declaration, 'visitor', () => {})).toThrow(
    'No outcome test for books/read-a-book / visitor',
  );
  expect(() => outcomeTest(declaration, 'operator', () => {})).toThrow(
    'No outcome test for books/read-a-book / operator',
  );
});

test('proved outcomes run normally; pending outcomes go red when they start passing', async () => {
  for (const state of ['proved', 'pending'] as const) {
    for (const passing of [false, true]) {
      const data = fixture(state, passing);
      const loaded = await loadOutcomes({
        root: data.directory,
        registry: [{ kind: 'books', capability: 'Read a book' }],
      });
      expect(loaded.get('books/read-a-book')?.cells.visitor?.state).toBe(state);
      const result = spawnSync(process.execPath, ['test', data.file], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(state === 'proved' ? (passing ? 0 : 1) : passing ? 1 : 0);
    }
  }
}, 30_000);

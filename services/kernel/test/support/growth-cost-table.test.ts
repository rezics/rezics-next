import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { costTableProblems, expectCostTable, readCostTable } from './growth-cost-table';

const actualRepositoryRoot = resolve(import.meta.dir, '../../../../');
const temporaryRoot = join(actualRepositoryRoot, '.temp');

type Fixture = {
  root: string;
  repositoryRoot: string;
  testRoot: string;
  options: { testRoot: string; repositoryRoot: string };
  cleanup: () => void;
};

function fixture(): Fixture {
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(join(temporaryRoot, 'growth-cost-table-'));
  const repositoryRoot = join(root, 'repository');
  const testRoot = join(root, 'tests');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(testRoot, { recursive: true });
  return {
    root,
    repositoryRoot,
    testRoot,
    options: { testRoot, repositoryRoot },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeReadme(f: Fixture, name: string, body: string): string {
  const path = join(f.repositoryRoot, `${name}.md`);
  writeFileSync(path, body, 'utf8');
  return path;
}

function writeTestFile(f: Fixture, root: string, path: string, source: string): string {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
  return absolutePath;
}

function costReadme(
  rows: string[],
  heading = '## Cost',
  header = '| Operation | Touches | Bound | Growth check |',
): string {
  return ['# Module', '', heading, '', header, '| --- | --- | --- | --- |', ...rows, '', '## Next section', ''].join(
    '\n',
  );
}

test('a Cost table whose every row cites an existing check passes', () => {
  const f = fixture();
  try {
    writeTestFile(
      f,
      f.testRoot,
      'first.test.ts',
      'test("first valid growth check", () => {}); test("first additional valid growth check", () => {});',
    );
    writeTestFile(f, f.testRoot, 'second.test.ts', 'test("second valid growth check", () => {});');
    const readmePath = writeReadme(
      f,
      'valid',
      costReadme([
        '| Read records | indexed reads | logarithmic blocks | `first.test.ts`: “first valid growth check”; “first additional valid growth check” commentary before another citation `second.test.ts`: `second valid growth check` |',
        '| Write records | changed rows | constant work | `second.test.ts`: `second valid growth check` |',
      ]),
    );

    expect(costTableProblems(readmePath, f.options)).toEqual([]);
    expectCostTable(readmePath, f.options);
    expect(readCostTable(readmePath)).toEqual([
      {
        operation: 'Read records',
        touches: 'indexed reads',
        bound: 'logarithmic blocks',
        check:
          '`first.test.ts`: “first valid growth check”; “first additional valid growth check” commentary before another citation `second.test.ts`: `second valid growth check`',
      },
      {
        operation: 'Write records',
        touches: 'changed rows',
        bound: 'constant work',
        check: '`second.test.ts`: `second valid growth check`',
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test('a README without one Cost section and the four-column table is refused', () => {
  const f = fixture();
  try {
    const missingSection = writeReadme(f, 'missing-section', '# Module\n\nThere is no cost table.\n');
    const wrongHeader = writeReadme(
      f,
      'wrong-header',
      costReadme([], '## Cost', '| Operation | Touches | Bound | Check |'),
    );
    const duplicateSection = writeReadme(
      f,
      'duplicate-section',
      `${costReadme([], '## Cost')}\n## Cost\n\nNo second table.\n`,
    );

    for (const path of [missingSection, wrongHeader, duplicateSection]) {
      const problems = costTableProblems(path, f.options);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join('\n')).toContain(path);
      expect(problems.join('\n')).toContain('<table>');
    }
    expect(costTableProblems(missingSection, f.options).join('\n')).toContain('exactly one');
    expect(costTableProblems(wrongHeader, f.options).join('\n')).toContain('header');
    expect(costTableProblems(duplicateSection, f.options).join('\n')).toContain('exactly one');
  } finally {
    f.cleanup();
  }
});

test('a citation of a missing file or of a name the file does not contain is refused and named', () => {
  const f = fixture();
  try {
    writeTestFile(f, f.testRoot, 'present.test.ts', 'test("a different title", () => {});');
    const readmePath = writeReadme(
      f,
      'missing-checks',
      costReadme([
        '| Missing file row | one request | linear work | `missing.test.ts`: “missing growth title” |',
        '| Missing title row | one request | linear work | `present.test.ts`: “missing title from file” |',
        '| Malformed list row | one request | linear work | `present.test.ts`: “a different title” “a different title” |',
      ]),
    );

    const problems = costTableProblems(readmePath, f.options).join('\n');
    expect(problems).toContain('Missing file row');
    expect(problems).toContain('missing.test.ts');
    expect(problems).toContain('Missing title row');
    expect(problems).toContain('missing title from file');
    expect(problems).toContain('present.test.ts');
    expect(problems).toContain('Malformed list row');
    expect(problems).toContain('must name one or more checks');
  } finally {
    f.cleanup();
  }
});

test('a generated check title is found from its template', () => {
  const f = fixture();
  try {
    writeTestFile(
      f,
      f.testRoot,
      'generated.test.ts',
      'test(`passkey ${path} remains bounded as unrelated credentials grow`, () => {});',
    );
    const readmePath = writeReadme(
      f,
      'generated',
      costReadme([
        '| Passkey removal | one passkey | constant work | `generated.test.ts`: “passkey removal remains bounded as unrelated credentials grow” |',
      ]),
    );

    expect(costTableProblems(readmePath, f.options)).toEqual([]);

    writeTestFile(f, f.testRoot, 'empty-template.test.ts', 'test(`${a} ${b}`, () => {});');
    const noFixedText = writeReadme(
      f,
      'empty-template',
      costReadme([
        '| Generated title | one request | constant work | `empty-template.test.ts`: “a generated title that is not present” |',
      ]),
    );
    expect(costTableProblems(noFixedText, f.options).join('\n')).toContain('not present');
  } finally {
    f.cleanup();
  }
});

test('a None row needs a reason and no row may have an empty cell', () => {
  const f = fixture();
  try {
    const readmePath = writeReadme(
      f,
      'none-and-empty',
      costReadme([
        '| No-op operation | no I/O | constant work | None: validates a local value without database or engine I/O |',
        '| Short reason | no I/O | constant work | None: too short |',
        '| Empty touches |  | constant work | None: this operation validates local data without database or engine I/O |',
        '| Three cells | touches | constant work |',
        '| Repeated operation | touches | constant work | None: this operation validates local data without database or engine I/O |',
        '| Repeated operation | touches | constant work | None: this operation validates local data without database or engine I/O |',
      ]),
    );

    const problems = costTableProblems(readmePath, f.options).join('\n');
    expect(problems).toContain('Short reason');
    expect(problems).toContain('at least 20 characters');
    expect(problems).toContain('Empty touches');
    expect(problems).toContain('every cell must be non-empty');
    expect(problems).toContain('Three cells');
    expect(problems).toContain('expected four cells, found 3');
    expect(problems).toContain('Repeated operation');
    expect(problems).toContain('operation is duplicated');
    expect(problems).not.toContain('No-op operation');
  } finally {
    f.cleanup();
  }
});

test('a bound must name constant, logarithmic or linear', () => {
  const f = fixture();
  try {
    const readmePath = writeReadme(
      f,
      'bounds',
      costReadme([
        '| Constant bound | one item | CONSTANT rows | None: this operation performs no database or engine I/O |',
        '| Logarithmic bound | one item | logarithmic probes | None: this operation performs no database or engine I/O |',
        '| Linear bound | all items | linear rows | None: this operation performs no database or engine I/O |',
        '| Unknown bound | growing items | quadratic | None: this operation performs no database or engine I/O |',
      ]),
    );

    const problems = costTableProblems(readmePath, f.options).join('\n');
    expect(problems).toContain('Unknown bound');
    expect(problems).toContain('bound must contain "constant", "logarithmic" or "linear"');
    expect(problems).not.toContain('Constant bound');
    expect(problems).not.toContain('Logarithmic bound');
    expect(problems).not.toContain('Linear bound');
  } finally {
    f.cleanup();
  }
});

test('paths under services/ resolve from the repository root and other paths from the test root', () => {
  const f = fixture();
  try {
    writeTestFile(
      f,
      f.repositoryRoot,
      'services/kernel/test/root-growth.test.ts',
      'test("repository root check title", () => {});',
    );
    writeTestFile(f, f.testRoot, 'services/kernel/test/root-growth.test.ts', 'test("wrong root title", () => {});');
    writeTestFile(f, f.testRoot, 'local-growth.test.ts', 'test("test root check title", () => {});');
    writeTestFile(f, f.repositoryRoot, 'local-growth.test.ts', 'test("wrong local title", () => {});');
    const readmePath = writeReadme(
      f,
      'path-roots',
      costReadme([
        '| Repository rooted check | one item | constant work | `services/kernel/test/root-growth.test.ts`: “repository root check title” |',
        '| Test rooted check | one item | constant work | `local-growth.test.ts`: “test root check title” |',
      ]),
    );

    expect(costTableProblems(readmePath, f.options)).toEqual([]);
  } finally {
    f.cleanup();
  }
});

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import ts from 'typescript-6';
import { integrationGateFiles } from './integration-gate-files.ts';
import { outcomeRepositoryViolations, outcomeTestViolations, outcomeSourcePattern, repositoryGuards, selectRepositoryGuards, guardParallelism, parseGuardRunArgs, runRepositoryGuardFiles, type RepositoryGuard } from './repository-guards.ts';
import { parseJUnit } from './acceptance.ts';

const file = 'tests/qa/integration/outcomes/reading.test.ts';

test('guard parallelism fits processors and available memory while retaining the host reserve', () => {
  const gib = 1024 ** 3;
  expect(guardParallelism(38, 64, 32 * gib)).toBe(12);
  expect(guardParallelism(38, 4, 128 * gib)).toBe(4);
  expect(guardParallelism(3, 64, 128 * gib)).toBe(3);
  expect(guardParallelism(38, 64, 7 * gib)).toBe(1);
  expect(guardParallelism(0, 64, 32 * gib)).toBe(0);
});

test('guard arguments keep Bun options and reserve a single aggregate JUnit destination', () => {
  expect(parseGuardRunArgs(['--timeout', '12000', './one.test.ts', '--preload', 'setup.test.ts',
    '--reporter=junit', '--reporter-outfile', '.temp/unit.xml', 'two.test.ts']))
    .toEqual({ files: ['./one.test.ts', 'two.test.ts'], bunArgs: ['--timeout', '12000', '--preload', 'setup.test.ts'],
      report: '.temp/unit.xml' });
  expect(() => parseGuardRunArgs(['--reporter=dot', 'one.test.ts'])).toThrow('junit');
});

test('guard processes overlap, inherit one QA slot, and retain every file in one JUnit report', async () => {
  mkdirSync('.temp', { recursive: true });
  const root = mkdtempSync(resolve('.temp/parallel-guards-'));
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  try {
    const files = ['one', 'two', 'three'].map(name => join(root, `${name}.test.ts`));
    for (const [index, path] of files.entries()) writeFileSync(path, `
      import { expect, test } from 'bun:test';
      import { existsSync, writeFileSync } from 'node:fs';
      test('same title', async () => {
        expect(process.env.GOAL_IN_SLOT).toBe('1');
        expect(process.env.GOAL_QA_SLOT_DIRECTORY).toBe('existing-slot');
        ${index === 2 ? `expect(existsSync(${JSON.stringify(join(root, '0.done'))}) || existsSync(${JSON.stringify(join(root, '1.done'))})).toBe(true);` : ''}
        writeFileSync(${JSON.stringify(join(root, `${index}.ready`))}, '');
        const deadline = Date.now() + 2000;
        while (!existsSync(${JSON.stringify(join(root, `${index === 0 ? 1 : 0}.ready`))}) && Date.now() < deadline) await Bun.sleep(10);
        expect(existsSync(${JSON.stringify(join(root, `${index === 0 ? 1 : 0}.ready`))})).toBe(true);
        writeFileSync(${JSON.stringify(join(root, `${index}.done`))}, '');
      });`);
    const report = join(root, 'unit.xml');
    const result = await runRepositoryGuardFiles(files, { parallelism: 2, report,
      env: { ...process.env, CLAUDECODE: '1', GOAL_IN_SLOT: '1', GOAL_QA_SLOT_DIRECTORY: 'existing-slot' } });
    expect(result.code, result.summary).toBe(0);
    const tests = parseJUnit(readFileSync(report, 'utf8'), 'unit');
    expect(tests.map(test => resolve(test.file)).sort()).toEqual(files.sort());
    expect(tests.every(test => test.name === 'same title' && !test.failed)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test('guard failures and module crashes are attributed to their file without discarding passing siblings', async () => {
  mkdirSync('.temp', { recursive: true });
  const root = mkdtempSync(resolve('.temp/guard-failures-'));
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  try {
    const files = ['pass', 'fail', 'crash', 'no-report'].map(name => join(root, `${name}.test.ts`));
    writeFileSync(files[0]!, "import { test } from 'bun:test'; test('same title', () => {});");
    writeFileSync(files[1]!, "import { expect, test } from 'bun:test'; test('same title', () => { expect(1).toBe(2); });");
    writeFileSync(files[2]!, "throw new Error('module could not load');");
    writeFileSync(files[3]!, 'process.exit(0);');
    const report = join(root, 'unit.xml');
    const result = await runRepositoryGuardFiles(files, { parallelism: 2, report,
      env: { ...process.env, CLAUDECODE: '1' } });
    expect(result.code).toBe(1);
    const tests = parseJUnit(readFileSync(report, 'utf8'), 'unit');
    expect(tests.filter(test => test.failed).map(test => resolve(test.file)).sort()).toEqual(files.slice(1).sort());
    expect(tests.find(test => resolve(test.file) === files[0])?.failed).toBe(false);
    for (const path of files.slice(1)) expect(result.summary).toContain(path);
    expect(result.summary).toContain('module could not load');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test('outcome guard refuses product imports and module mocks in outcome files', () => {
  for (const source of [
    "import { app } from '../../../../services/main/src/app.ts';",
    "import type { User } from '../../../../services/account/src/auth.ts';",
    "export { read } from '../../../../apps/web/src/read.ts';",
    "await import('../../../../services/main/src/app.ts');",
    "const app = require('../../../../services/main/src/app.ts');",
    "import app = require('../../../../services/main/src/app.ts');",
    "import app from 'services/main/src/app.ts';",
    "import app from '/workspace/services/main/src/app.ts';",
    "import app from 'file:///workspace/apps/web/src/app.ts';",
    "mock . module('owner', () => ({}));",
    "mock['module']('owner', () => ({}));",
    "import { type User } from '../../../../services/account/src/auth.ts';",
  ])
    expect(outcomeTestViolations(file, source), source).toHaveLength(1);
});

test('outcome guard accepts public clients, persona fixtures, comments and other integration tests', () => {
  expect(
    outcomeTestViolations(
      file,
      `
    import { expect, test } from 'bun:test';
    import { personaSessions } from '../../support/personas.ts';
    import type { Response } from '../../../../packages/api-client/index.ts';
    // mock.module('owner', () => ({}));
    const example = "services/main/src/app.ts";
  `,
    ),
  ).toEqual([]);
  expect(
    outcomeTestViolations(
      'tests/qa/integration/owner.test.ts',
      "import app from '../../../services/main/src/app.ts'; mock.module('app', () => ({}));",
    ),
  ).toEqual([]);
});

test('outcome inventory reads every nested outcome file', () => {
  mkdirSync('.temp', { recursive: true });
  const root = mkdtempSync(resolve('.temp/outcome-guard-'));
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  try {
    const directory = join(root, 'tests/qa/integration/outcomes/nested');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'refused.test.ts'),
      "import app from '../../../../../services/main/src/app.ts';",
    );
    writeFileSync(
      join(directory, 'accepted.test.ts'),
      "import { personaSessions } from '../../../support/personas.ts';",
    );
    expect(outcomeRepositoryViolations(root)).toEqual([
      'tests/qa/integration/outcomes/nested/refused.test.ts: imports product source: ../../../../../services/main/src/app.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all repository outcome tests stay at the public API boundary', () => {
  expect(outcomeRepositoryViolations()).toEqual([]);
});

const guardFiles = (changed?: string[]) => selectRepositoryGuards(changed).map(guard => guard.file);

test('web changes select web inventories and leave unrelated service guards out', () => {
  const selected = guardFiles(['apps/web/features/realm/browse-page.ts']);
  for (const file of ['web-continuations', 'web-accepted-commands', 'web-acting-identity', 'web-page-filtering'])
    expect(selected).toContain(`scripts/static/${file}.test.ts`);
  expect(selected).not.toContain('services/main/tests/api-contract.test.ts');
  expect(selected).not.toContain('services/main/tests/g-829-public-reads.test.ts');
});

test('service changes select service inventories without generated-contract web scans', () => {
  const selected = guardFiles(['services/main/src/modules/work/read.ts']);
  expect(selected).toContain('services/main/tests/g-829-public-reads.test.ts');
  expect(selected).toContain('services/main/tests/api-contract.test.ts');
  expect(selected).not.toContain('scripts/static/web-continuations.test.ts');
  expect(selected).not.toContain('scripts/static/web-page-filtering.test.ts');
  expect(selected).not.toContain('scripts/static/web-accepted-commands.test.ts');
  // This scan generates its contract from Main instead of opening the generated file.
  expect(selected).toContain('scripts/static/web-acting-identity.test.ts');
});

test('registry and main-wide runs retain all guards, empty changes run none, and each guard selects itself', () => {
  const all = repositoryGuards.map(guard => guard.file);
  expect(guardFiles(['scripts/qa/repository-guards.ts'])).toEqual(all);
  expect(guardFiles(['scripts/lib/repository-files.ts'])).toEqual(all);
  expect(guardFiles()).toEqual(all);
  expect(guardFiles([])).toEqual([]);
  for (const guard of repositoryGuards) expect(guardFiles([guard.file])).toContain(guard.file);
});

test('selection matches deleted and newly added paths without inspecting the filesystem', () => {
  const guards: RepositoryGuard[] = [
    { file: 'web.test.ts', reason: 'web scan', reads: ['apps/web/**/*.{ts,tsx}'] },
    { file: 'always.test.ts', reason: 'whole tree' },
    { file: 'service.test.ts', reason: 'service scan', reads: ['services/main/src/**'] },
  ];
  expect(selectRepositoryGuards(['apps/web/new/nested.tsx'], guards).map(guard => guard.file))
    .toEqual(['web.test.ts', 'always.test.ts']);
  expect(selectRepositoryGuards(['README.md'], guards).map(guard => guard.file)).toEqual(['always.test.ts']);
  expect(selectRepositoryGuards([], guards)).toEqual([]);
});

test('raw SPARQL inventory retains every registered integration root outside its default tree', () => {
  for (const file of integrationGateFiles) {
    expect(guardFiles([file]), file).toContain('scripts/qa/raw-sparql-integration-files.test.ts');
  }
});

test('every declared inventory matches a tracked file and is nonempty', () => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8' });
  expect(tracked.status).toBe(0);
  const files = tracked.stdout.split('\0').filter(Boolean);
  for (const guard of repositoryGuards as readonly RepositoryGuard[]) {
    if (!guard.reads) continue;
    expect(guard.reads.length, guard.file).toBeGreaterThan(0);
    // Generated contracts are untracked; their consumers still declare supporting source.
    expect(files.some(file => guard.reads!.some(pattern => new Bun.Glob(pattern).match(file))), guard.file).toBe(true);
  }
});

/** Parse executable scan declarations; fixture strings containing globs are not scans. */
function literalScanPatterns(file: string): string[] {
  const ast = ts.createSourceFile(file, readFileSync(resolve(import.meta.dir, '../..', file), 'utf8'), ts.ScriptTarget.Latest, true);
  const patterns: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Bun.Glob'
      || ts.isCallExpression(node) && node.expression.getText(ast) === 'repositoryGlob') {
      const pattern = node.arguments?.[ts.isCallExpression(node) ? 1 : 0];
      if (pattern && ts.isStringLiteral(pattern)) patterns.push(pattern.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...new Set(patterns)];
}

test('declared inventories retain the scan patterns from executable guard source', () => {
  const scans = [
    ['scripts/api/answer-records.guard.test.ts', 'scripts/api/answer-record.ts', ['']],
    ['scripts/static/web-continuations.test.ts', 'scripts/static/web-continuations.ts', ['']],
    ['scripts/static/web-page-filtering.test.ts', 'scripts/static/web-continuations.ts', ['']],
    ['scripts/static/web-accepted-commands.test.ts', 'scripts/static/web-accepted-commands.ts', ['apps/web/']],
    ['scripts/static/web-acting-identity.test.ts', 'scripts/static/web-acting-identity.test.ts', ['']],
    ['tests/qa/unit/g-1046-sql-relations.test.ts', 'scripts/qa/sql-relations.ts', ['services/', 'scripts/', 'tests/']],
    ['tests/qa/unit/serialization-points.test.ts', 'scripts/qa/serialization-points.ts', ['']],
    ['tests/qa/unit/outbox-event-handlers.test.ts', 'tests/qa/unit/outbox-event-handlers.test.ts', ['']],
    ['services/main/tests/g-543-rate-limit.test.ts', 'services/main/tests/g-543-rate-limit.test.ts', ['services/main/migrations/access/']],
    ['services/main/tests/g-896-content-sequence.test.ts', 'services/main/tests/g-896-content-sequence.test.ts', ['']],
    ['scripts/static/mechanism-writers.test.ts', 'scripts/static/mechanism-writers.test.ts', ['']],
  ] as const;
  for (const [file, source, prefixes] of scans) {
    const guard = (repositoryGuards as readonly RepositoryGuard[]).find(guard => guard.file === file)!;
    const patterns = literalScanPatterns(source);
    expect(patterns.length, source).toBeGreaterThan(0);
    for (const pattern of patterns) for (const prefix of prefixes) {
      // Brace expansion is intentional in the SQL inventory declaration.
      const declared = guard.reads!.flatMap(read => read.startsWith('{services,scripts,tests}/')
        ? ['services', 'scripts', 'tests'].map(root => read.replace('{services,scripts,tests}', root)) : [read]);
      expect(declared, `${file}: ${prefix}${pattern}`).toContain(`${prefix}${pattern}`);
    }
  }
  const outcome = (repositoryGuards as readonly RepositoryGuard[]).find(guard => guard.file === 'scripts/qa/repository-guards.test.ts')!;
  expect(outcome.reads).toContain(outcomeSourcePattern);
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runUnitSide, runOwnerShard, rememberSlowTests, writeUnitEvidence, timeoutOnlyTestFiles, UNIT_JUNIT_MARKER, preMergeSurfaceGate, completedUnitShard,
  type SlowTestRecord, type UnitRunEvidence } from './unit-gate.ts';
import { parseBrief } from './briefs.ts';
import { mergeUnitFiles, unitFilesFromPlan } from './unit-gate.ts';
import { repositoryGuards, selectRepositoryGuards } from '../qa/repository-guards.ts';
import type { AffectedPlan } from '../qa/affected.ts';

const scratch = join(import.meta.dir, '../../.temp/timeout-retry-tests');
const directories: string[] = [];
let restoreOutput = () => {};
beforeEach(() => {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  // Nested gates are fixture diagnostics, not output of the outer test runner.
  const captured: unknown[][] = [];
  console.log = console.error = console.warn = (...args: unknown[]) => { captured.push(args); };
  restoreOutput = () => { Object.assign(console, saved); };
});
function fixture(source: string) {
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(join(scratch, 'case-'));
  directories.push(cwd);
  writeFileSync(join(cwd, 'Taskfile.yml'), 'version: "3"\ntasks:\n  goal:unit-files:\n    cmds:\n      - bun run.ts {{.CLI_ARGS}}\n  test:\n    cmds:\n      - bun run.ts --owner-fixture {{.CLI_ARGS}}\n');
  writeFileSync(join(cwd, 'run.ts'), `import { appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const owner = args[0] === '--owner-fixture';
if (owner) args.shift();
const artifacts = owner ? process.env.REZICS_QA_ARTIFACT_ROOT : undefined;
if (artifacts) {
  mkdirSync(artifacts, { recursive: true });
  args.push('--reporter=junit', '--reporter-outfile=' + artifacts + '/owner.xml');
}
appendFileSync('invocations', args.join(' ') + '\\n');
const result = spawnSync(process.execPath, ['test', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);\n`);
  const file = 'slow.test.ts';
  writeFileSync(join(cwd, file), `import { test, expect } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
test('busy host guard', async () => {
  appendFileSync('attempts', process.argv.join(' ') + '\\n');
  ${source}
});\n`);
  return { cwd, file, historyDirectory: join(cwd, '.temp/history'), durations: new Map<string, number>() };
}
afterEach(() => {
  restoreOutput();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('typed and transcript unit gates select inventories, including guards widened into the affected plan', () => {
  const f = fixture('expect(true).toBe(true);');
  for (const guard of repositoryGuards) {
    mkdirSync(join(f.cwd, guard.file, '..'), { recursive: true });
    writeFileSync(join(f.cwd, guard.file), 'export {};');
  }
  const all = repositoryGuards.map(guard => guard.file);
  const transcript = `Affected since main\n${all.map(file => `  unit: ${file}`).join('\n')}\n  unit: ${f.file}\n`;
  const typed = { tests: { unit: [...all, f.file] }, widened: [] } as unknown as AffectedPlan;
  for (const changed of [[], ['apps/web/app/page.tsx'], ['services/main/src/modules/work/read.ts'], ['scripts/qa/repository-guards.ts']]) {
    const expected = [...selectRepositoryGuards(changed).map(guard => guard.file), f.file].sort();
    expect(mergeUnitFiles(f.cwd, transcript, changed)).toEqual(expected);
    expect(unitFilesFromPlan(f.cwd, typed, changed)).toEqual(expected);
  }
  // Omitted changes preserve the existing main-wide/regression contract.
  expect(mergeUnitFiles(f.cwd, transcript)).toEqual([...all, f.file].sort());
  expect(unitFilesFromPlan(f.cwd, typed)).toEqual([...all, f.file].sort());
});

test('surface landing refuses incomplete selection before generating or executing a gate', async () => {
  const f = fixture('expect(true).toBe(true);');
  const plan = join(f.cwd, 'plan'); writeFileSync(plan, '');
  const saved = process.env.GOAL_TEST_PLAN; process.env.GOAL_TEST_PLAN = plan;
  let generated = false;
  try {
    const refusal = await preMergeSurfaceGate(f.cwd, 'main', parseBrief('---\nkind: surface\nrows: []\ntests: []\n---\n'), [], new Set(), {
      generate: async () => { generated = true; return undefined; },
      runner: async () => { throw new Error('selection must refuse before execution'); },
    });
    expect(refusal).toContain('surface requires rows:');
    expect(refusal).toContain('at least one web *.stories.tsx');
    expect(generated).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.GOAL_TEST_PLAN; else process.env.GOAL_TEST_PLAN = saved;
  }
});

test('a passing file’s printed timeout cannot become a failure beside a real assertion failure', async () => {
  const previousShards = process.env.GOAL_UNIT_GATE_SHARDS;
  process.env.GOAL_UNIT_GATE_SHARDS = '1';
  try {
    for (const owner of [false, true]) {
      const f = fixture(`console.log('slow.test.ts:\\n(fail) nested guard\\nthis test timed out after 5000ms\\n 1 fail');`);
      const broken = 'broken.test.ts';
      writeFileSync(join(f.cwd, broken), "import { test, expect } from 'bun:test'; test('real assertion', () => expect(1).toBe(2));\n");
      const evidence: UnitRunEvidence[] = [];
      const run = owner ? (cwd: string, files: readonly string[], deadline: number) => runOwnerShard(cwd, files, deadline) : undefined;
      const side = await runUnitSide(f.cwd, [f.file, broken], 'affected', evidence, run, f);
      expect(side.failing).toEqual([broken]);
      expect(side.inconclusive).toEqual([]);
      expect(evidence.some(item => item.kind === 'isolated-retry')).toBe(false);
    }
  } finally {
    if (previousShards === undefined) delete process.env.GOAL_UNIT_GATE_SHARDS; else process.env.GOAL_UNIT_GATE_SHARDS = previousShards;
  }
});

test('a test beyond the unit budget passes alone with six times the budget and keeps its timing evidence', async () => {
  const f = fixture('await Bun.sleep(5_100); expect(true).toBe(true);');
  const evidence: UnitRunEvidence[] = [];
  const lines: string[] = [];
  const previous = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const previousLog = process.env.GOAL_MERGE_LOG;
  process.env.GOAL_MERGE_LOG = join(f.cwd, 'merge.log');
  try {
    const side = await runUnitSide(f.cwd, [f.file], 'affected', evidence, undefined, f);
    expect(side.inconclusive).toEqual([]);
    expect(side.failing).toEqual([]);
    const attempts = readFileSync(join(f.cwd, 'attempts'), 'utf8').trim().split('\n');
    expect(attempts).toHaveLength(2);
    const invocations = readFileSync(join(f.cwd, 'invocations'), 'utf8').trim().split('\n');
    expect(invocations[0]).toContain('--timeout=5000');
    expect(invocations[1]).toContain('--timeout=30000');
    const records = JSON.parse(readFileSync(join(f.historyDirectory, 'timeout-retry-history.json'), 'utf8')) as SlowTestRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ file: f.file, test: 'busy host guard' });
    expect(records[0]!.seconds).toBeGreaterThan(5);
    expect(records[0]!.loadAverage).toHaveLength(3);
    expect(lines.filter(line => line.startsWith('Timeout retry passed:'))).toHaveLength(1);
    expect(lines.join('\n')).toContain(`${f.file} > busy host guard (`);
    const path = writeUnitEvidence(evidence)!;
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { invocations: { runs: UnitRunEvidence[] }[] };
    expect(stored.invocations[0]!.runs.flatMap(run => run.slowTests ?? [])).toEqual(records);
  } finally {
    console.log = previous;
    if (previousLog === undefined) delete process.env.GOAL_MERGE_LOG; else process.env.GOAL_MERGE_LOG = previousLog;
  }
}, 60_000);

test('an assertion keeps the existing confirmation and gets no longer timeout retry', async () => {
  const f = fixture('expect(1).toBe(2);');
  const side = await runUnitSide(f.cwd, [f.file], 'affected', [], undefined, f);
  expect(side.failing).toEqual([f.file]);
  const attempts = readFileSync(join(f.cwd, 'attempts'), 'utf8').trim().split('\n');
  expect(attempts).toHaveLength(2);
  expect(readFileSync(join(f.cwd, 'invocations'), 'utf8').trim().split('\n').every(line => line.includes('--timeout=5000'))).toBe(true);
  expect(existsSync(f.historyDirectory)).toBe(false);
});

test('a second timeout stays inconclusive and there is no third attempt', async () => {
  const f = fixture('await Bun.sleep(31_000);');
  const side = await runUnitSide(f.cwd, [f.file], 'affected', [], undefined, f);
  expect(side.inconclusive).toEqual([f.file]);
  expect(readFileSync(join(f.cwd, 'attempts'), 'utf8').trim().split('\n')).toHaveLength(2);
  expect(existsSync(f.historyDirectory)).toBe(false);
}, 65_000);

test('an assertion on the longer retry becomes the deciding failure', async () => {
  const f = fixture('if (readFileSync("attempts", "utf8").trim().split("\\n").length > 1) expect(1).toBe(2); await Bun.sleep(5_100);');
  const side = await runUnitSide(f.cwd, [f.file], 'affected', [], undefined, f);
  expect(side.inconclusive).toEqual([]);
  expect(side.failing).toEqual([f.file]);
  expect(side.failures[0]?.test).toBe('busy host guard');
  expect(readFileSync(join(f.cwd, 'attempts'), 'utf8').trim().split('\n')).toHaveLength(2);
  expect(existsSync(f.historyDirectory)).toBe(false);
}, 30_000);

test('history retains only the last two hundred tests across appends', async () => {
  const f = fixture('');
  const record = (index: number): SlowTestRecord => ({ file: 'guard.test.ts', test: String(index), seconds: 7, loadAverage: [1, 2, 3] });
  await rememberSlowTests(Array.from({ length: 205 }, (_, index) => record(index)), f.historyDirectory);
  await rememberSlowTests([record(205)], f.historyDirectory);
  const stored = JSON.parse(readFileSync(join(f.historyDirectory, 'timeout-retry-history.json'), 'utf8')) as SlowTestRecord[];
  expect(stored).toHaveLength(200);
  expect(stored[0]!.test).toBe('6');
  expect(stored.at(-1)!.test).toBe('205');
});

test('a file with both a timeout and an assertion never qualifies for a timeout retry', () => {
  const xml = `${UNIT_JUNIT_MARKER}\n<testsuites><testsuite>
<testcase file="mixed.test.ts" name="slow"><failure type="TimeoutError" message="test timed out"/></testcase>
<testcase file="mixed.test.ts" name="broken"><failure type="AssertionError" message="expected 2"/></testcase>
</testsuite></testsuites>`;
  expect(timeoutOnlyTestFiles(xml, ['mixed.test.ts'])).toEqual([]);
});

test('completed shard attribution keeps the unit gate’s exit status and failure identities', () => {
  const file = 'guard.test.ts';
  const output = `${UNIT_JUNIT_MARKER}\n<testsuites><testsuite>
<testcase file="${file}" name="slow" time="5"><failure type="TimeoutError" message="test timed out"/></testcase>
<testcase file="${file}" name="broken"><failure type="AssertionError" message="expected 2"/></testcase>
</testsuite></testsuites>`;
  expect(completedUnitShard('.', [file], 0, output, 10)).toMatchObject({ failing: [], timedOut: [], failures: [], runnerErrors: [], exitCode: 0 });
  expect(completedUnitShard('.', [file], 1, output, 10)).toMatchObject({ failing: [file], timedOut: [file],
    failures: [{ file, test: 'slow' }, { file, test: 'broken' }], runnerErrors: [], exitCode: 1 });
  expect(completedUnitShard('.', [file], 1, 'error: runner crashed', 10)).toMatchObject({ failing: [],
    runnerErrors: [{ files: ['runner'], diagnostic: 'error: runner crashed' }] });
});

test('a passing file printing another run’s timeout, failure and report passes without any retry', async () => {
  for (const owner of [false, true]) {
    const f = fixture(`
      const transcript = 'slow.test.ts:\\n(fail) busy nested guard\\nthis test timed out after 5000ms\\n 1 fail\\n'
        + '${UNIT_JUNIT_MARKER}\\n<testsuites><testcase file="slow.test.ts" name="nested"><failure type="TimeoutError" message="test timed out"/></testcase></testsuites>';
      console.log(transcript);
      console.error(transcript);
    `);
    let calls = 0;
    // The owner's Task command exercises the same stdout path as a hosted owner report.
    const run = owner ? async (cwd: string, files: readonly string[], deadline: number) => {
      calls++;
      return runOwnerShard(cwd, files, deadline);
    } : undefined;
    const side = await runUnitSide(f.cwd, [f.file], 'affected', [], run, f);
    expect(side.failing).toEqual([]);
    expect(side.inconclusive).toEqual([]);
    expect(side.orderDependent).toEqual([]);
    expect(readFileSync(join(f.cwd, 'invocations'), 'utf8').trim().split('\n')).toHaveLength(1);
    if (owner) expect(calls).toBe(1);
  }
});

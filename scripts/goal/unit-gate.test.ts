import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runUnitSide, rememberSlowTests, writeUnitEvidence, timeoutOnlyTestFiles, UNIT_JUNIT_MARKER,
  type SlowTestRecord, type UnitRunEvidence } from './unit-gate.ts';

const scratch = join(import.meta.dir, '../../.temp/timeout-retry-tests');
const directories: string[] = [];
function fixture(source: string) {
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(join(scratch, 'case-'));
  directories.push(cwd);
  writeFileSync(join(cwd, 'Taskfile.yml'), 'version: "3"\ntasks:\n  goal:unit-files:\n    cmds:\n      - bun run.ts {{.CLI_ARGS}}\n');
  writeFileSync(join(cwd, 'run.ts'), `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
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
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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

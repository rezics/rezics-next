import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFullLock, acquireQaSlots, estimatedDurations, expandTestPaths, expectedFusekiModuleVersion,
  junitSuites, matchedNoTests, maximumShards, mergeJUnit, parseArgs, planShards, recordedFileDurations,
  shardCount, splitTestArgs, testLogEnvironment, writeSummary, implementedTiers, tierArtifactName,
  xmlForCommand, type Tier } from '../../../scripts/qa/core.ts';
import { parseJUnit } from '../../../scripts/qa/acceptance.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';

const scratch = join(import.meta.dir, '../../../.temp');
mkdirSync(scratch, { recursive: true });

test('QA01: overlapping full runs are rejected and lock releases', () => {
  const root = mkdtempSync(join(scratch, 'rezics-qa-lock-'));
  try {
    const release = acquireFullLock(root, 'first');
    expect(() => acquireFullLock(root, 'second')).toThrow('Another full QA run');
    release();
    acquireFullLock(root, 'third')();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('QA02: selected tier and uncovered tiers cannot certify full', () => {
  expect(parseArgs(['--tier', 'integration'])).toEqual({ tier: 'integration', onlyFailed: undefined, keep: false, record: false });
  expect(() => parseArgs(['--record', '--tier', 'unit'])).toThrow();
  const dir = mkdtempSync(join(scratch, 'rezics-qa-summary-'));
  const source = { head: 'abc', fingerprint: 'fingerprint', clean: true };
  try {
    writeSummary(dir, { runId: 'test', sourceBefore: source, sourceAfter: source,
      partial: true, errors: [], cases: [{ id: 'OPS01', page: 'docs/testing/operations.md' }], tests: [], tiers: [
        { name: 'integration', status: 'passed' }, { name: 'model', status: 'uncovered' },
      ] });
    const acceptance = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(acceptance.certifiesFull).toBe(false);
    expect(acceptance.partial).toBe(true);
    expect(acceptance.tiers[1].status).toBe('uncovered');
    expect(acceptance.ids.OPS01.status).toBe('uncovered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA02: backend mode selects non-browser tiers and records its exact scope', () => {
  expect(parseArgs(['--backend', '--record']).backend).toBe(true);
  expect(() => parseArgs(['--backend', '--tier', 'e2e'])).toThrow('no e2e');
  expect(() => parseArgs(['--backend', '--only-failed', 'run-one'])).toThrow('unsupported');
  const dir = mkdtempSync(join(scratch, 'rezics-qa-backend-'));
  const source = { head: 'abc', fingerprint: 'fingerprint', clean: true };
  const testResult = { tier: 'integration' as const, file: 'tests/qa/integration/case.test.ts',
    name: 'OPS01: exact backend case', failed: false, skipped: false };
  const tiers = ['static', 'unit', 'integration', 'model', 'fault/recovery', 'load']
    .map(name => ({ name: name as Tier, status: 'passed' as const }));
  try {
    const report = { runId: 'backend', sourceBefore: source, sourceAfter: source,
      partial: false, errors: [], cases: [{ id: 'OPS01', page: 'docs/testing/operations.md' }],
      tests: [testResult], tiers, caseCoverage: new Map([['OPS01',
        ['integration:tests/qa/integration/case.test.ts:OPS01: exact backend case']]]),
      excludedCases: [{ id: 'VIEW04', page: 'docs/testing/presentation-and-addressing.md',
        reason: 'rendering only' }], inventoryFingerprint: 'frozen' };
    writeSummary(dir, { ...report, scope: 'backend' });
    const backend = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(backend.certifiesFull).toBe(true);
    expect(backend.scope).toBe('backend');
    expect(backend.excludedCases[0].id).toBe('VIEW04');
    expect(backend.inventoryFingerprint).toBe('frozen');
    const dirtySource = { ...source, clean: false };
    writeSummary(dir, { ...report, sourceBefore: dirtySource, sourceAfter: dirtySource, scope: 'backend' });
    expect(JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8')).certifiesFull).toBe(false);
    writeSummary(dir, { ...report, scope: 'all' });
    expect(JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8')).certifiesFull).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA03: command failures produce escaped JUnit output', () => {
  expect(xmlForCommand('static', false, 1000, '<bad>')).toContain('&lt;bad&gt;');
  expect(xmlForCommand('static', false, 1000, 'bad')).toContain('failures="1"');
});

test('QA12: QA bootstrap rejects a Fuseki module that differs from the Compose pin', () => {
  expect(expectedFusekiModuleVersion('services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-cmd0.5.12\n'))
    .toBe('0.5.12');
  expect(() => expectedFusekiModuleVersion('services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-base1\n'))
    .toThrow('must pin one command-module');
  expect(expectedFusekiModuleVersion(
    `services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-cmd${COMMAND_MODULE_VERSION}-4dc9015683cb\n`))
    .toBe(COMMAND_MODULE_VERSION);
});

test('QA tier Bun runs drop agent output variables so logs list every test', () => {
  expect(testLogEnvironment({ PATH: '/bin', AGENT: '1', CLAUDECODE: '1', REPL_ID: 'x', FUSEKI_URL: 'u' }))
    .toEqual({ PATH: '/bin', FUSEKI_URL: 'u' });
});

test('QA02: fault/recovery is a selectable implemented tier with one artifact basename', () => {
  expect(implementedTiers).toContain('fault/recovery');
  expect(parseArgs(['--tier', 'fault/recovery', '--id', 'SYS02']).tier).toBe('fault/recovery');
  expect(tierArtifactName('fault/recovery')).toBe('fault-recovery');
});

test('QA02: load is an implemented isolated tier', () => {
  expect(implementedTiers).toContain('load');
  expect(parseArgs(['--tier', 'load', '--id', 'OPS05']).tier).toBe('load');
  expect(tierArtifactName('load')).toBe('load');
});

test('QA02: e2e is an implemented tier without declaring acceptance coverage', () => {
  expect(implementedTiers).toContain('e2e');
  expect(parseArgs(['--tier', 'e2e'])).toEqual({ tier: 'e2e', onlyFailed: undefined,
    keep: false, record: false });
  expect(parseArgs(['--tier', 'e2e', '--file', 'apps/web/tests/public-search.e2e.ts']).files)
    .toEqual(['apps/web/tests/public-search.e2e.ts']);
});

const suite = (file: string, cases: string) =>
  `<testsuite name="${file}" file="${file}" tests="1">${cases}</testsuite>`;
const junit = (...suites: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n${suites.join('\n')}\n</testsuites>\n`;

test('QA shards: registered directories expand to test files and flags stay with every shard', () => {
  const root = mkdtempSync(join(scratch, 'rezics-qa-expand-'));
  try {
    mkdirSync(join(root, 'tests/qa/integration/nested'), { recursive: true });
    for (const file of ['a.test.ts', 'helper.ts', 'nested/b.test.ts']) writeFileSync(join(root, 'tests/qa/integration', file), '');
    mkdirSync(join(root, 'services/main/tests'), { recursive: true });
    writeFileSync(join(root, 'services/main/tests/gate.integration.test.ts'), '');
    expect(expandTestPaths(root, ['tests/qa/integration', 'services/main/tests/gate.integration.test.ts',
      'tests/qa/integration/a.test.ts'])).toEqual(['services/main/tests/gate.integration.test.ts',
      'tests/qa/integration/a.test.ts', 'tests/qa/integration/nested/b.test.ts']);
    expect(() => expandTestPaths(root, ['tests/qa/missing.test.ts'])).toThrow('missing');
  } finally { rmSync(root, { recursive: true, force: true }); }
  expect(splitTestArgs(['a.test.ts', 'b.test.ts', '-t', '^x$'])).toEqual({ paths: ['a.test.ts', 'b.test.ts'],
    flags: ['-t', '^x$'] });
  expect(splitTestArgs(['a.test.ts'])).toEqual({ paths: ['a.test.ts'], flags: [] });
});

test('QA shards: recorded durations use the latest merged JUnit, killed-run logs and the slowest of three', () => {
  const dir = mkdtempSync(join(scratch, 'rezics-qa-durations-'));
  try {
    const run = (id: string, files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, id, name.includes('/') ? 'logs' : ''), { recursive: true });
        writeFileSync(join(dir, id, name), text);
      }
    };
    run('20260901t000000-aaaaaa', { 'integration.xml': junit(suite('a.test.ts', '<testcase name="one" time="9" file="a.test.ts" />')) });
    run('20260902t000000-bbbbbb', { 'integration.xml': junit(suite('a.test.ts',
      '<testcase name="one" time="1" file="a.test.ts" /><testcase name="two" time="2" file="a.test.ts" />')) });
    run('20260903t000000-cccccc', { 'integration.xml': junit(suite('a.test.ts', '<testcase name="one" time="4" file="a.test.ts" />')) });
    run('20260904t000000-dddddd', { 'integration.xml': junit(suite('a.test.ts', '<testcase name="one" time="0.5" file="a.test.ts" />'),
      suite('b.test.ts', '<testcase name="b" time="0.25" file="b.test.ts" />')) });
    // A killed shard leaves no JUnit; its log still lists finished files.
    run('20260905t000000-eeeeee', { 'logs/integration-2.log': 'bun test\n\nc.test.ts:\n(pass) C01: c [1500.50ms]\n'
      + '(fail) C02: d [2.5s]\n\nd.test.ts:\nspawnSync bun ETIMEDOUT\n',
    'logs/integration-2-stack.log': 'c.test.ts:\n(pass) x [99999ms]\n', 'logs/fault-recovery-f1.log': 'c.test.ts:\n(pass) x [99999ms]\n' });
    const durations = recordedFileDurations([dir, join(dir, 'absent')], 'integration');
    // a.test.ts: newest three observations are 500, 4000 and 3000 ms; the oldest 9000 ms is ignored.
    expect(Object.fromEntries(durations)).toEqual({ 'a.test.ts': 4000, 'b.test.ts': 250, 'c.test.ts': 4001 });
    expect(Object.fromEntries(recordedFileDurations([dir], 'fault/recovery'))).toEqual({ 'c.test.ts': 99999 });
    expect(Object.fromEntries(estimatedDurations(['a.test.ts', 'new.test.ts', 'b.test.ts'], durations)))
      .toEqual({ 'a.test.ts': 4000, 'new.test.ts': 4000, 'b.test.ts': 250 });
    expect(Object.fromEntries(estimatedDurations(['new.test.ts'], new Map()))).toEqual({ 'new.test.ts': 30_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA shards: shard count keeps each project near half its budget and planning is balanced and deterministic', () => {
  const estimates = new Map([['a', 200_000], ['b', 150_000], ['c', 120_000], ['d', 100_000], ['e', 90_000],
    ['f', 60_000], ['g', 30_000]]);
  expect(shardCount(estimates, 480_000, 8)).toBe(4);
  expect(shardCount(estimates, 480_000, 2)).toBe(2);
  expect(shardCount(new Map([['a', 1_000]]), 480_000, 4)).toBe(1);
  expect(shardCount(new Map([['a', 900_000], ['b', 900_000]]), 360_000, 8)).toBe(2);
  const plan = planShards(estimates, 4);
  expect(plan).toEqual([['a'], ['b', 'g'], ['c', 'f'], ['d', 'e']]);
  expect(plan.flat().sort()).toEqual([...estimates.keys()].sort());
  expect(planShards(new Map([...estimates].reverse()), 4)).toEqual(plan);
  expect(planShards(new Map([['a', 1]]), 4)).toEqual([['a']]);
  expect(maximumShards({})).toBe(4);
  expect(maximumShards({ REZICS_QA_SHARDS: '6' })).toBe(6);
  expect(() => maximumShards({ REZICS_QA_SHARDS: '0' })).toThrow('1 to 8');
  expect(() => maximumShards({ REZICS_QA_SHARDS: '9' })).toThrow('1 to 8');
});

test('QA shards: shard JUnit merges per file, keeps nested suites and replaces isolated files', () => {
  const nested = '<testsuite name="n.test.ts" file="n.test.ts"><testsuite name="describe" file="n.test.ts" line="3">'
    + '<testcase name="X01: in describe" time="1" file="n.test.ts" /></testsuite></testsuite>';
  const first = junit(suite('a.test.ts', '<testcase name="A01: a" time="1" file="a.test.ts"><failure message="x" /></testcase>'), nested);
  const second = junit(suite('b.test.ts', '<testcase name="B01: b" time="2" file="b.test.ts"><skipped /></testcase>'),
    '<testsuite name="empty.test.ts" file="empty.test.ts" tests="0" />');
  const suites = [...junitSuites(first), ...junitSuites(second)];
  expect(suites.map(item => item.file)).toEqual(['a.test.ts', 'n.test.ts', 'b.test.ts', 'empty.test.ts']);
  expect(suites[1]!.xml).toBe(nested);
  const alone = junitSuites(junit(suite('a.test.ts', '<testcase name="A01: a" time="3" file="a.test.ts" />')));
  const merged = mergeJUnit([...suites.filter(item => item.file !== 'a.test.ts'), ...alone].map(item => item.xml), 12_500);
  expect(merged).toContain('tests="3" failures="0" skipped="1" time="12.5"');
  const results = parseJUnit(merged, 'integration');
  expect(results.map(item => [item.file, item.name, item.failed, item.skipped])).toEqual([
    ['n.test.ts', 'X01: in describe', false, false], ['b.test.ts', 'B01: b', false, true],
    ['a.test.ts', 'A01: a', false, false]]);
  // Command failures without a file stay visible but map to no test.
  expect(junitSuites(xmlForCommand('integration', false, 1, 'stack down'))[0]!.file).toBeUndefined();
  expect(matchedNoTests('bun test v1.4.2\n\nerror: regex "^X01" matched 0 tests. Searched 2 files')).toBe(true);
  expect(matchedNoTests('error: something else')).toBe(false);
});

test('QA shards: Goal QA slots bound extra projects, keep the caller slot and release only their own', () => {
  const dir = mkdtempSync(join(scratch, 'rezics-qa-slots-'));
  try {
    expect(acquireQaSlots(undefined, 3).count).toBe(3);
    // Slot 0 belongs to this process (as goalctl holds it for the harness); slot 1 to a live stranger.
    for (const [slot, pid] of [['0', process.pid], ['1', process.ppid]] as const) {
      mkdirSync(join(dir, slot));
      writeFileSync(join(dir, slot, 'pid'), String(pid));
    }
    // Slot 2 is stale: a dead owner and older than ten seconds.
    mkdirSync(join(dir, '2'));
    writeFileSync(join(dir, '2', 'pid'), '999999999');
    utimesSync(join(dir, '2'), new Date(0), new Date(0));
    const env = { GOAL_QA_SLOTS: '4' };
    const slots = acquireQaSlots(dir, 4, env);
    expect(slots.count).toBe(3);
    expect(readFileSync(join(dir, '2', 'pid'), 'utf8')).toBe(String(process.pid));
    expect(existsSync(join(dir, '3'))).toBe(true);
    expect(acquireQaSlots(dir, 2, env).count).toBe(1);
    slots.release();
    expect([0, 1, 2, 3].map(k => existsSync(join(dir, String(k))))).toEqual([true, true, false, false]);
    const one = acquireQaSlots(dir, 1, env);
    expect(one.count).toBe(1);
    expect(existsSync(join(dir, '2'))).toBe(false);
    // A run outside any slot takes one for itself.
    rmSync(join(dir, '0'), { recursive: true });
    const outside = acquireQaSlots(dir, 2, env, 999_999_998);
    expect(outside.count).toBe(2);
    outside.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA shards: summary records every project and per-file order dependence', () => {
  const dir = mkdtempSync(join(scratch, 'rezics-qa-shard-summary-'));
  const source = { head: 'abc', fingerprint: 'fingerprint', clean: true };
  try {
    writeSummary(dir, { runId: 'run', sourceBefore: source, sourceAfter: source, partial: true, errors: [],
      cases: [{ id: 'OPS01', page: 'docs/testing/operations.md' }], tests: [], tiers: [{ name: 'integration' as Tier,
        status: 'passed', elapsedMs: 200_000, shards: [
          { project: 'run-1', files: ['a.test.ts', 'b.test.ts'], status: 'failed', stage: 'test', elapsedMs: 190_000 },
          { project: 'run-2', files: ['c.test.ts'], status: 'failed', stage: 'stack' },
          { project: 'run-r1', files: ['b.test.ts'], status: 'passed', stage: 'test', elapsedMs: 10_000, isolation: true }] }],
      isolation: [{ tier: 'integration', file: 'b.test.ts', afterProject: 'run-1', afterFiles: 1, project: 'run-r1',
        shardFailures: ['B01: b'], status: 'order-dependent' }] });
    const acceptance = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(acceptance.isolation[0].status).toBe('order-dependent');
    expect(acceptance.tiers[0].shards).toHaveLength(3);
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    expect(summary).toContain('- integration projects: run-1 2 files 190.0 s failed; run-2 1 files — failed at stack; '
      + 'run-r1 (isolated) 1 files 10.0 s passed');
    expect(summary).toContain('- Isolation integration: b.test.ts failed after 1 other files in run-1; passed alone in run-r1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

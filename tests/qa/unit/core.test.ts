import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireFullLock, acquireQaSlots, commandAsync, concurrencyGate, estimatedDurations, expandTestPaths, expectedFusekiModuleVersion,
  isolatedFaultFiles, isolatedIntegrationFiles, isolationCandidates, junitSuites, matchedNoTests, maximumShards,
  mergeJUnit, parseArgs, planShards, planStackProjects,
  recordedFileDurations, selfManagedFaultFiles, shardCount, stackPlanBudgetWarning, shardResolved, splitTestArgs,
  testLogEnvironment, writeSummary, withQaMemory,
  implementedTiers, tierArtifactName,
  xmlForCommand, sourceIdentity, type Tier } from '../../../scripts/qa/core.ts';
import { parseJUnit } from '../../../scripts/qa/acceptance.ts';
import { qaStartupServices } from '../../../scripts/qa/stack-ownership.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';

const scratch = join(import.meta.dir, '../../../.temp');
mkdirSync(scratch, { recursive: true });

test('QA work starts only after memory admission and stays unstarted at the deadline', async () => {
  const need = { vm: 10, host: 2, hostReserve: 8, vmReserve: 1 };
  let now = 0, started = false;
  const options = { deadline: 20, now: () => now, sleep: async (ms: number) => { now += ms; }, pollMs: 10,
    announce: () => {}, read: async () => ({ vmTotal: 24, vmUsed: 14, hostAvailable: 10 }) };
  await expect(withQaMemory(need, options, async () => { started = true; })).rejects.toThrow('deadline');
  expect(started).toBe(false);
  now = 0;
  const result = await withQaMemory(need, { ...options, read: async () => {
    expect(started).toBe(false);
    return { vmTotal: 24, vmUsed: now === 0 ? 14 : 13, hostAvailable: 10 };
  } }, async () => { started = true; return 'started'; });
  expect(now).toBe(10);
  expect(result).toBe('started');
});

test('storybook selection remains e2e-only alongside the owner tier', () => {
  expect(parseArgs(['--tier', 'e2e', '--storybook']).storybook).toBe(true);
  expect(parseArgs(['--tier', 'owner', '--file', 'services/main/tests/preferences-settings.test.ts']))
    .toMatchObject({ tier: 'owner', files: ['services/main/tests/preferences-settings.test.ts'] });
  expect(() => parseArgs(['--tier', 'owner', '--storybook'])).toThrow('--storybook requires the e2e tier');
  expect(() => parseArgs(['--tier', 'unit', '--storybook'])).toThrow('--storybook requires the e2e tier');
});

test('a handled SIGTERM cannot extend the Bun tier wall deadline', async () => {
  const directory = mkdtempSync(join(scratch, 'qa-deadline-'));
  const pidFile = join(directory, 'pid');
  try {
    const result = await commandAsync(directory, 'bun', ['-e', `
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `], 300);
    expect(existsSync(pidFile)).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeLessThan(3000);
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('QA source identity hashes a generated-contract diff larger than the default subprocess buffer',()=>{
  const root=mkdtempSync(join(scratch,'qa-large-source-'));
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
  try {
    git(['init','--quiet']);
    writeFileSync(join(root,'contract.json'),'initial\n');
    git(['add','contract.json']);
    git(['-c','user.name=QA fixture','-c','user.email=qa@example.test','commit','--quiet','-m','initial']);
    const clean=sourceIdentity(root);expect(clean.clean).toBe(true);
    const large='generated schema row\n'.repeat(60_000);
    expect(Buffer.byteLength(large)).toBeGreaterThan(1_048_576);
    writeFileSync(join(root,'contract.json'),large);
    const changed=sourceIdentity(root);expect(changed.clean).toBe(false);
    expect(changed.fingerprint).not.toBe(clean.fingerprint);
    writeFileSync(join(root,'contract.json'),`${large}last field changed\n`);
    expect(sourceIdentity(root).fingerprint).not.toBe(changed.fingerprint);
    writeFileSync(join(root,'contract.json'),'initial\n');
    expect(sourceIdentity(root)).toEqual(clean);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('QA setup: only integration omits the unused fault proxy', () => {
  expect(qaStartupServices({ profile: 'qa' }, 'integration'))
    .toEqual(['postgres', 'fuseki', 'rustfs', 'mailpit']);
  expect(qaStartupServices({ profile: 'dev' }, 'integration')).toEqual([]);
  expect(qaStartupServices({ profile: 'qa' }, 'fault/recovery')).toEqual([]);
  expect(qaStartupServices({ profile: 'qa' }, undefined)).toEqual([]);
});

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
  const tiers = ['static', 'unit', 'owner', 'integration', 'model', 'fault/recovery', 'load']
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
      suite('b.test.ts', '<testcase name="b" time="0.25" file="b.test.ts" />')),
    'logs/integration-1.log': 'a.test.ts:\n(pass) A01: slower log [7000ms]\n' });
    // A killed shard leaves no JUnit; its log still lists finished files.
    run('20260905t000000-eeeeee', { 'logs/integration-2.log': 'bun test\n\nc.test.ts:\n(pass) C01: c [1500.50ms]\n'
      + '(fail) C02: d [2.5s]\n\nd.test.ts:\nspawnSync bun ETIMEDOUT\n',
    'logs/integration-2-stack.log': 'c.test.ts:\n(pass) x [99999ms]\n', 'logs/fault-recovery-f1.log': 'c.test.ts:\n(pass) x [99999ms]\n',
    'logs/fault-recovery-f2.log': 'failed-fault.test.ts:\n(fail) F01: failure [800ms]\n' });
    run('20260906t000000-abcdef', { 'integration.xml': junit(suite('stack-only.test.ts',
      '<testcase name="STACK01: started" time="500" file="stack-only.test.ts" />')),
    'acceptance.json': JSON.stringify({ tiers: [{ name: 'integration', status: 'failed', shards: [
      { project: 'integration-2', status: 'failed', stage: 'stack' },
    ] }] }) });
    run('20260906t000000-ffffff', { 'unit.xml': junit(suite('unrelated.test.ts',
      '<testcase name="unit" time="1" file="unrelated.test.ts" />'),
      suite('failed-unit.test.ts', '<testcase name="failed" time="50" file="failed-unit.test.ts"><failure /></testcase>')),
    'logs/unit.log': 'failed-unit.test.ts:\n(fail) U01: failure [50000ms]\n' });
    run('20260906t000000-fedcba', { 'model.xml': junit(suite('stack-model.test.ts',
      '<testcase name="STACK02: started" time="120" file="stack-model.test.ts" />')),
    'logs/model-stack.log': 'Docker unavailable before model tests started\n' });
    const durations = recordedFileDurations([dir, join(dir, 'absent')], 'integration');
    // Failed files, unavailable-stack runs and unstarted files never enter history.
    // a.test.ts: newest three usable observations are 7000, 4000 and 3000 ms.
    expect(Object.fromEntries(durations)).toEqual({ 'a.test.ts': 7000, 'b.test.ts': 250 });
    expect(Object.fromEntries(recordedFileDurations([dir], 'fault/recovery'))).toEqual({ 'c.test.ts': 99999 });
    expect(Object.fromEntries(recordedFileDurations([dir], 'integration', 1))).toEqual({});
    expect(Object.fromEntries(recordedFileDurations([dir], 'unit'))).toEqual({ 'unrelated.test.ts': 1000 });
    expect(Object.fromEntries(recordedFileDurations([dir], 'model'))).toEqual({});
    expect(recordedFileDurations([dir], 'integration').has('d.test.ts')).toBe(false);
    expect(Object.fromEntries(estimatedDurations(['a.test.ts', 'new.test.ts', 'b.test.ts'], durations)))
      .toEqual({ 'a.test.ts': 7000, 'new.test.ts': 7000, 'b.test.ts': 250 });
    expect(Object.fromEntries(estimatedDurations(['new.test.ts'], new Map()))).toEqual({ 'new.test.ts': 30_000 });
    run('20260907t000000-abcdef', { 'integration.xml': junit(suite('a.test.ts',
      '<testcase name="one" time="1" file="a.test.ts" />')) });
    expect(recordedFileDurations([dir], 'integration', 60, 1).get('a.test.ts')).toBe(1000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA shards: shard count keeps each project near half its budget and planning is balanced and deterministic', () => {
  const estimates = new Map([['a', 200_000], ['b', 150_000], ['c', 120_000], ['d', 100_000], ['e', 90_000],
    ['f', 60_000], ['g', 30_000]]);
  expect(shardCount(estimates, 480_000, 8)).toBe(4);
  expect(shardCount(estimates, 480_000, 2)).toBe(2);
  expect(shardCount(new Map([['a', 1_000]]), 480_000, 4)).toBe(1);
  expect(shardCount(new Map(Array.from({ length: 8 }, (_, index) => [`f${index}`, 1_000])),
    480_000, 4)).toBe(2);
  expect(shardCount(new Map([['a', 900_000], ['b', 900_000]]), 360_000, 8)).toBe(2);
  const plan = planShards(estimates, 4);
  expect(plan).toEqual([['a'], ['b', 'g'], ['c', 'f'], ['d', 'e']]);
  expect(plan.flat().sort()).toEqual([...estimates.keys()].sort());
  expect(planShards(new Map([...estimates].reverse()), 4)).toEqual(plan);
  expect(planShards(new Map([['a', 1]]), 4)).toEqual([['a']]);
  expect(maximumShards({}, 'integration')).toBe(6);
  expect(maximumShards({}, 'fault/recovery')).toBe(8);
  expect(maximumShards({ REZICS_QA_SHARDS: '6' }, 'fault/recovery')).toBe(6);
  expect(() => maximumShards({ REZICS_QA_SHARDS: '0' }, 'integration')).toThrow('1 to 8');
  expect(() => maximumShards({ REZICS_QA_SHARDS: '9' }, 'fault/recovery')).toThrow('1 to 8');
});

test('QA shards: bounded stack plans warn with their estimate and the fitting shard count', () => {
  const estimates = new Map<string, number>([
    ['tests/qa/integration/validation-command.test.ts', 20_000],
    ['tests/qa/integration/shared-a.test.ts', 200_000],
    ['tests/qa/integration/shared-b.test.ts', 200_000],
    ['tests/qa/integration/shared-c.test.ts', 200_000],
  ]);
  expect(stackPlanBudgetWarning(estimates, 480_000, 2, 2, 'integration'))
    .toBe('Warning: integration is estimated at 600.0s with 2 available shard(s), over its 480.0s budget; '
      + '3 shards are estimated to fit. REZICS_QA_SHARDS cap: 2.');
  expect(stackPlanBudgetWarning(estimates, 480_000, 3, 3, 'integration')).toBeUndefined();
  expect(stackPlanBudgetWarning(new Map(), 480_000, 1, 1, 'integration')).toBeUndefined();
});

test('QA shards: graph reset, outbox gap and fresh-graph files get singleton integration projects', () => {
  for (const file of ['validation-cross-profile', 'semantic-generation',
    'search-statement-query', 'event-time', 'access-org-realm-move-api',
    'theme-activation-api']) {
    expect(isolatedIntegrationFiles.has(`tests/qa/integration/${file}.test.ts`)).toBe(true);
  }
  for (const file of ['export-api', 'context-rule-cases', 'search-grouped-native']) {
    expect(isolatedIntegrationFiles.has(`tests/qa/integration/${file}.test.ts`)).toBe(false);
  }
  const files = new Map<string, number>([
    ['tests/qa/integration/claim-template.test.ts', 100],
    ['tests/qa/integration/governance-report.test.ts', 80],
    ...[...isolatedIntegrationFiles].map(file => [file, 10] as const),
  ]);
  const plan = planStackProjects(files, 3, 'integration');
  expect(plan.flat().sort()).toEqual([...files.keys()].sort());
  expect(plan.filter(project => project.some(file => isolatedIntegrationFiles.has(file))))
    .toEqual([...isolatedIntegrationFiles].sort().map(file => [file]));
  expect(planStackProjects(new Map([...files].reverse()), 3, 'integration')).toEqual(plan);
  expect(planStackProjects(files, 3, 'fault/recovery')).toEqual(planShards(files, 3));
  const faultFiles = new Map<string, number>([
    ['tests/qa/fault-recovery/content-rebuild.test.ts', 100],
    ...[...isolatedFaultFiles].map(file => [file, 10] as const),
  ]);
  const faultPlan = planStackProjects(faultFiles, 3, 'fault/recovery');
  expect(faultPlan.flat().sort()).toEqual([...faultFiles.keys()].sort());
  expect(faultPlan.filter(project => project.some(file => isolatedFaultFiles.has(file))))
    .toEqual([...isolatedFaultFiles].sort().map(file => [file]));
  const recoveryFiles = new Map<string, number>([
    ['tests/qa/fault-recovery/content-rebuild.test.ts', 100],
    ['tests/qa/fault-recovery/search-ops-lock.test.ts', 80],
    ['tests/qa/fault-recovery/zone-wiki.test.ts', 30],
    ['tests/qa/fault-recovery/partition-relocation.test.ts', 20],
  ]);
  const recoveryPlan = planStackProjects(recoveryFiles, 2, 'fault/recovery');
  expect(recoveryPlan.flat().sort()).toEqual([...recoveryFiles.keys()].sort());
  expect(recoveryPlan.filter(project => project.some(file => selfManagedFaultFiles.has(file))))
    .toEqual([['tests/qa/fault-recovery/content-rebuild.test.ts'],
      ['tests/qa/fault-recovery/search-ops-lock.test.ts']]);
  expect(recoveryPlan[0]).toEqual(['tests/qa/fault-recovery/zone-wiki.test.ts']);
  expect(planStackProjects(new Map([...recoveryFiles].reverse()), 2, 'fault/recovery')).toEqual(recoveryPlan);
  expect(recoveryPlan).toContainEqual(['tests/qa/fault-recovery/zone-wiki.test.ts']);
  expect(recoveryPlan).toContainEqual(['tests/qa/fault-recovery/partition-relocation.test.ts']);
  const one = new Map([['tests/qa/integration/validation-command.test.ts', 1]]);
  expect(planStackProjects(one, 1, 'integration'))
    .toEqual([['tests/qa/integration/validation-command.test.ts']]);
});

test('QA shards: long isolated integration files start before the short tail', () => {
  const short = 'tests/qa/integration/also-enjoyed.test.ts';
  const long = 'tests/qa/integration/public-search-scale.test.ts';
  const estimates = new Map([[short, 1_000], [long, 90_000], ['shared.test.ts', 100_000]]);
  const plan = planStackProjects(estimates, 2, 'integration');
  expect(plan).toEqual([['shared.test.ts'], [long], [short]]);
  expect(planStackProjects(new Map([...estimates].reverse()), 2, 'integration')).toEqual(plan);
});

test('QA shards: fresh integration projects share the initial worker slots', () => {
  const isolated = [...isolatedIntegrationFiles].slice(0, 6);
  const files = new Map([
    ...Array.from({ length: 9 }, (_, index) => [`shared-${index}.test.ts`, 30_000] as const),
    ...isolated.map(file => [file, 10_000] as const),
  ]);
  const plan = planStackProjects(files, 6, 'integration');
  expect(plan.slice(0, 6).filter(project => project.some(file => isolatedIntegrationFiles.has(file))))
    .toHaveLength(3);
  expect(plan.flat().sort()).toEqual([...files.keys()].sort());
});

test('QA shards: stack startup gate releases a permit before the next setup', async () => {
  expect(() => concurrencyGate(0)).toThrow('concurrency limit');
  const start = concurrencyGate(2);
  const release: (() => void)[] = [];
  let running = 0;
  let peak = 0;
  const job = (value: number) => start(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>(resolve => release.push(resolve));
    running--;
    return value;
  });
  const first = job(1), second = job(2), third = job(3);
  await Bun.sleep(0);
  expect(running).toBe(2);
  release.shift()!();
  expect(await first).toBe(1);
  await Bun.sleep(0);
  expect(running).toBe(2);
  expect(peak).toBe(2);
  release.shift()!();
  release.shift()!();
  expect(await Promise.all([second, third])).toEqual([2, 3]);
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

test('QA shards: only a small file failure set is eligible for fresh-project isolation', () => {
  const xml = junit(
    suite('first.test.ts', '<testcase name="A01: pass" file="first.test.ts" />'),
    suite('second.test.ts', '<testcase name="A02: fail" file="second.test.ts"><failure /></testcase>'),
    suite('third.test.ts', '<testcase name="A03: fail" file="third.test.ts">'
      + '<failure>all predefined address pools have been fully subnetted</failure></testcase>'));
  expect(isolationCandidates(xml, 'integration')).toEqual([
    { file: 'second.test.ts', names: ['A02: fail'], afterFiles: 1, infrastructure: false },
    { file: 'third.test.ts', names: ['A03: fail'], afterFiles: 2, infrastructure: true }]);
  expect(isolationCandidates(xml, 'integration', 1)).toEqual([]);
  expect(shardResolved(false, 'test', false, new Set(), new Set())).toBe(false);
  expect(shardResolved(false, 'test', false, new Set(['second.test.ts']),
    new Set(['second.test.ts']))).toBe(true);
  expect(shardResolved(false, 'test', true, new Set(['second.test.ts']),
    new Set(['second.test.ts']))).toBe(false);
});

test('QA shards: Goal QA slots bound extra projects, keep the caller slot and release only their own', async () => {
  const dir = mkdtempSync(join(scratch, 'rezics-qa-slots-'));
  try {
    expect((await acquireQaSlots(undefined, 3)).count).toBe(3);
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
    const slots = await acquireQaSlots(dir, 4, env);
    expect(slots.count).toBe(3);
    expect(readFileSync(join(dir, '2', 'pid'), 'utf8')).toBe(String(process.pid));
    expect(existsSync(join(dir, '3'))).toBe(true);
    const borrowed = await acquireQaSlots(dir, 2, env);
    expect(borrowed.count).toBe(1);
    borrowed.release();
    slots.release();
    expect([0, 1, 2, 3].map(k => existsSync(join(dir, String(k))))).toEqual([true, true, false, false]);
    const one = await acquireQaSlots(dir, 1, env);
    expect(one.count).toBe(1);
    expect(existsSync(join(dir, '2'))).toBe(false);
    // A run outside any slot takes one for itself.
    rmSync(join(dir, '0'), { recursive: true });
    one.release();
    const outside = await acquireQaSlots(dir, 2, env, 999_999_998);
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
        shardFailures: ['B01: b'], status: 'order-dependent' },
      { tier: 'integration', file: 'c.test.ts', afterProject: 'run-2', afterFiles: 0, project: 'run-r2',
        shardFailures: ['C01: c'], status: 'infrastructure-dependent' }] });
    const acceptance = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(acceptance.isolation[0].status).toBe('order-dependent');
    expect(acceptance.tiers[0].shards).toHaveLength(3);
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    expect(summary).toContain('- integration projects: run-1 2 files 190.0 s failed; run-2 1 files — failed at stack; '
      + 'run-r1 (isolated) 1 files 10.0 s passed');
    expect(summary).toContain('- Isolation integration: b.test.ts failed after 1 other files in run-1; passed alone in run-r1');
    expect(summary).toContain('- Isolation integration: c.test.ts failed after 0 other files in run-2; '
      + 'passed alone in run-r2 after Docker network exhaustion');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('QA slots: zero leases wait until the deadline without starting a stack', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-slot-wait-'));
  let now = 0;
  const messages: string[] = [];
  let started = false;
  try {
    mkdirSync(join(dir, '0'));
    writeFileSync(join(dir, '0', 'pid'), String(process.pid));
    await expect((async () => {
      const slots = await acquireQaSlots(dir, 1, { GOAL_QA_SLOTS: '1' }, 999_999_998, {
        deadline: 25, now: () => now, sleep: async ms => { now += ms; },
        pollMs: 10, announce: message => messages.push(message),
      });
      started = true;
      slots.release();
    })()).rejects.toThrow('No QA slot became free before the deadline');
    expect(started).toBe(false);
    expect(messages).toEqual(['Waiting for a QA slot; all 1 slots are held']);
    expect(now).toBe(25);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA slots: a waiter takes a newly released lease before it starts a stack', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-slot-turnover-'));
  let now = 0;
  try {
    mkdirSync(join(dir, '0'));
    writeFileSync(join(dir, '0', 'pid'), String(process.pid));
    const slots = await acquireQaSlots(dir, 1, { GOAL_QA_SLOTS: '1' }, 999_999_998, {
      deadline: 20, now: () => now, announce: () => {},
      sleep: async ms => { now += ms; rmSync(join(dir, '0'), { recursive: true }); }, pollMs: 10,
    });
    expect(now).toBe(10);
    expect(slots.count).toBe(1);
    expect(readFileSync(join(dir, '0', 'pid'), 'utf8')).toBe('999999998');
    slots.release();
    expect(existsSync(join(dir, '0'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('QA slots: SIGTERM, SIGINT, process exit, errors and the run deadline release leases', async () => {
  for (const mode of ['SIGTERM', 'SIGINT', 'exit', 'error', 'deadline'] as const) {
    const dir = mkdtempSync(join(scratch, 'qa-slot-exit-'));
    const script = join(dir, 'holder.ts');
    const ready = join(dir, 'ready');
    writeFileSync(script, `
      import { acquireQaSlots, commandAsync } from ${JSON.stringify(join(import.meta.dir, '../../../scripts/qa/core.ts'))};
      import { writeFileSync } from 'node:fs';
      await acquireQaSlots(${JSON.stringify(dir)}, 1, { GOAL_QA_SLOTS: '1' }, process.pid,
        ${mode === 'deadline' ? '{ runDeadline: Date.now() + 100 }' : '{}'});
      ${mode === 'SIGTERM' || mode === 'SIGINT'
        ? `await commandAsync(${JSON.stringify(dir)}, 'bun', ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1_000);`)}], 5_000);`
        : `writeFileSync(${JSON.stringify(ready)}, 'ready');`}
      ${mode === 'exit' ? 'process.exit(0);' : mode === 'error' ? "throw new Error('injected holder failure');" : 'await new Promise(() => { setInterval(() => {}, 1_000); });'}
    `);
    const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const deadline = Date.now() + 2_000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
      expect(existsSync(ready)).toBe(true);
      if (mode === 'SIGTERM' || mode === 'SIGINT') {
        expect(existsSync(join(dir, '0'))).toBe(true);
        child.kill(mode);
      }
      expect(await child.exited).toBe(mode === 'SIGTERM' ? 143 : mode === 'SIGINT' ? 130 : mode === 'error' ? 1 : mode === 'deadline' ? 124 : 0);
      expect(existsSync(join(dir, '0'))).toBe(false);
      if (mode === 'SIGTERM' || mode === 'SIGINT') {
        const subprocess = Number(readFileSync(ready, 'utf8'));
        const alive = () => {
          try { return !readFileSync(`/proc/${subprocess}/stat`, 'utf8').includes(') Z '); }
          catch { return false; }
        };
        const stoppedBy = Date.now() + 1_000;
        while (alive() && Date.now() < stoppedBy) await Bun.sleep(5);
        expect(alive()).toBe(false);
      }
      if (mode === 'deadline') expect(await new Response(child.stderr).text()).toContain('reached its deadline');
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

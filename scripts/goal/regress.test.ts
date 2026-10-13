import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import * as filesystem from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { selectTestCommand } from '../qa/test.ts';
import { artifactRoots, parseArgs } from '../qa/core.ts';
import { inputSelectedNativeTests, parseJUnit, UNEXECUTED_FILE_TEST } from '../qa/acceptance.ts';
import { e2eBrowserPlan, storybookCommands } from '../qa/browser-budget.ts';
import { isHeavyTest } from './goalctl.ts';
import { verticalJourneys, verticalJourneyFilter, type VerticalJourney } from '../qa/cases/vertical-journeys.ts';
import * as goalctl from './goalctl.ts';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';
import { reapScopeLabel } from '../qa/container-reaper.ts';
import { appendInbox, checkoutNameLength, classify, regressionFailureCause, executionOutcomes, inboxEntries, isRamBackedFileSystem, parseRegressArgs, provideGoalctl, regressionLaneLimit,
  pruneRegressionCheckouts, regressionBatchArtifactPaths, regressionBatchCommand, regressionCheckoutRoot, regressionDiagnosisBudgetMs,
  regressionRegistry, runBatch,
  regressionBatchEnvironment, runRegression, waitForRegressionTurn, type Batch, type Execution, type ExpectedFile, type Manifest, type MergeEvent, type RegressionOptions } from './regress.ts';

let repoSequence = 0;

function repo(extraIntegration = 0) {
  const fixtureRoot = regressionCheckoutRoot(import.meta.dir, join(import.meta.dir, '../../.temp/r'));
  const dir = mkdtempSync(join(fixtureRoot, 'repo-'));
  const checkoutRoot = join(fixtureRoot, `c${(repoSequence++).toString(36)}`);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Regression test'); git('config', 'user.email', 'test@example.invalid');
  const files: ExpectedFile[] = [
    ['unit', 'tests/qa/unit/example.test.ts'], ['model', 'model/tests/example.test.ts'],
    ['integration', 'tests/qa/integration/example.test.ts'], ['fault/recovery', 'tests/qa/fault-recovery/example.test.ts'],
    ['e2e', 'apps/web/tests/example.e2e.ts'], ['e2e', 'apps/web/features/example.stories.tsx'],
    ['accounts:storybook', 'apps/accounts/features/example.stories.tsx'],
    ['owner', 'scripts/ops/tests/example.test.ts'],
    ['jena:check', 'scripts/qa/jena-cli.ts'],
    ...Array.from({ length: extraIntegration }, (_, index) => ['integration', `tests/qa/integration/subdir/extra-${index}.test.ts`]),
  ].map(([tier, file]) => ({ tier, file, outcome: 'pending' })) as ExpectedFile[];
  const write = (file: string, text: string) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
  write('.gitignore', '.temp/\n.artifacts/\n');
  for (const file of files) write(file.file, 'pass\n');
  const commit = (changes: Record<string, string | null> = {}) => {
    for (const [path, text] of Object.entries(changes)) { if (text === null) rmSync(join(dir, path)); else write(path, text); }
    git('add', '.'); git('commit', '--allow-empty', '-qm', 'fixture'); return git('rev-parse', 'HEAD');
  };
  const base = commit();
  const stateDir = join(dir, '.temp/goal-orchestration');
  const calls: { commit: string; checkout: string; batch: Batch; directory: string }[] = [];
  const runner: NonNullable<RegressionOptions['runner']> = async (checkout, batch, directory) => {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
    calls.push({ commit: sha, checkout, batch, directory });
    const outcomes = Object.fromEntries(batch.files.map(file => [file, !existsSync(join(checkout, file)) ? 'missing'
      : readFileSync(join(checkout, file), 'utf8').startsWith('fail') ? 'failed' : 'passed'])) as Execution['outcomes'];
    return { code: Object.values(outcomes).every(result => result === 'passed') ? 0 : 1, outcomes,
      queueMs: 2, testMs: 3, totalMs: 5, artifactPaths: [directory] };
  };
  const options: RegressionOptions = { repo: dir, stateDir, checkoutRoot, legacyRoot: join(checkoutRoot, 'l'),
    registry: async () => files.map(file => ({ ...file })),
    prepare: async () => ({ ok: true, artifactPaths: [] }), runner, slots: 1, waitForTurn: async () => {} };
  const event = (before: string, after: string, goal = 'owner') => {
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, 'merges.jsonl');
    const events = existsSync(path) ? readFileSync(path, 'utf8') : '';
    writeFileSync(path, events + JSON.stringify({ before, after, goal, taskIds: ['G-001', 'G-002'], at: new Date().toISOString() } satisfies MergeEvent) + '\n');
  };
  const run = (overrides: Partial<RegressionOptions> = {}) => runRegression({ ...options, ...overrides });
  const manifest = (id: string) => JSON.parse(readFileSync(join(stateDir, 'regress', id, 'manifest.json'), 'utf8')) as Manifest;
  return { dir, git, base, files, options, calls, runner, write, commit, event, run, manifest,
    unit: files[0]!.file, cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    } };
}

describe('pinned main-wide regression', () => {
  // The merge gate runs this file with its own owner deadline in the environment; the regression's
  // default must not come from whoever started the test.
  let inheritedOwnerBudget: string | undefined;
  beforeEach(() => {
    inheritedOwnerBudget = process.env.REZICS_QA_OWNER_BUDGET_MS;
    delete process.env.REZICS_QA_OWNER_BUDGET_MS;
  });
  afterEach(() => {
    if (inheritedOwnerBudget === undefined) delete process.env.REZICS_QA_OWNER_BUDGET_MS;
    else process.env.REZICS_QA_OWNER_BUDGET_MS = inheritedOwnerBudget;
  });
  test('each routine regression schedules the pinned Jena check as its own entry', async () => {
    const r = repo();
    try {
      for (const runId of ['jena-first', 'jena-next', 'jena-restricted']) {
        r.calls.length = 0;
        const result = await r.run({ runId, ...(runId === 'jena-restricted' ? { only: ['unit'] as RegressionOptions['only'] } : {}) });
        expect(result.status).toBe(runId === 'jena-restricted' ? 'incomplete' : 'passed');
        expect(result.batches.filter(batch => batch.tier === 'jena:check')).toEqual([
          expect.objectContaining({ id: 'jena-check-1', files: ['scripts/qa/jena-cli.ts'], state: 'done' }),
        ]);
        expect(r.calls.filter(call => call.batch.tier === 'jena:check')).toHaveLength(1);
        expect(result.files).toContainEqual({ file: 'scripts/qa/jena-cli.ts', tier: 'jena:check', outcome: 'passed' });
      }
    } finally { r.cleanup(); }
  });

  test('native Jena proofs run in singleton image batches with each file deadline', async () => {
    const r = repo();
    const nativeFiles = new Set<string>(inputSelectedNativeTests);
    const longProof = inputSelectedNativeTests[0];
    try {
      for (const file of inputSelectedNativeTests) {
        r.files.push({ file, tier: 'jena:check', outcome: 'pending' });
        r.write(file, file === longProof ? "test('native proof', () => {}, 900_000);\n" : 'pass\n');
      }
      expect(regressionBatchCommand({ id: 'native-proof', tier: 'jena:check', files: [longProof], state: 'pending', attempts: [] },
        '/disk/report.json', '/disk/native.xml')).toEqual([
        'bun', join(import.meta.dir, 'goalctl.ts'), 'slot', '--',
        'bun', join(import.meta.dir, '../qa/host-admission.ts'), '--gib', '4', '--',
        'bun', 'test', `--preload=${join(import.meta.dir, '../qa/container-reaper.ts')}`,
        '--reporter=junit', '--reporter-outfile=/disk/native.xml', longProof,
      ]);
      r.commit();
      const result = await r.run({ runId: 'native-jena-deadlines' });
      const batches = result.batches.filter(batch => batch.tier === 'jena:check'
        && inputSelectedNativeTests.some(file => batch.files.includes(file)));
      expect(batches.map(batch => batch.files)).toEqual(inputSelectedNativeTests.map(file => [file]));
      expect(batches.every(batch => batch.budgetMs !== undefined)).toBe(true);
      expect(batches.find(batch => batch.files[0] === longProof)?.budgetMs).toBe(960_000);
      expect(result.files.filter(file => nativeFiles.has(file.file))
        .every(file => file.tier === 'jena:check' && file.outcome === 'passed')).toBe(true);
    } finally { r.cleanup(); }
  });

  test('a large unit tier splits into serial fifteen-file batches within the harness deadline', async () => {
    const r = repo();
    try {
      for (let index = 1; index < 380; index++) {
        const file = `tests/qa/unit/example-${index}.test.ts`;
        r.files.push({ file, tier: 'unit', outcome: 'pending' }); r.write(file, 'pass\n');
      }
      r.commit();
      let active = 0;
      const result = await r.run({ runId: 'unit-batches', only: ['unit'], runner: async (...args) => {
        if (args[1].tier !== 'unit') return r.runner(...args);
        expect(++active).toBe(1);
        expect(args[1].files.length).toBeLessThanOrEqual(15);
        const result = await r.runner(...args); active--;
        return { ...result, testMs: args[1].files.length * 10_000 };
      } });
      const batches = result.batches.filter(batch => batch.tier === 'unit');
      expect(batches).toHaveLength(26);
      expect(batches.flatMap(batch => batch.files).sort()).toEqual(r.files.filter(file => file.tier === 'unit').map(file => file.file).sort());
      expect(batches.every(batch => batch.attempts[0]!.testMs < 180_000)).toBe(true);
      expect(result.files.filter(file => file.tier === 'unit').every(file => file.outcome === 'passed')).toBe(true);
      r.calls.length = 0;
      await r.run({ resume: 'unit-batches' });
      expect(r.calls).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('a declared 900-second owner proof runs alone with the gate margin in the actual child deadline', async () => {
    const r = repo();
    const file = r.files.find(item => item.tier === 'owner')!.file;
    try {
      r.write(file, "test('native proof', () => {}, 900_000);\n");
      for (let index = 0; index < 14; index++) {
        const ordinary = `scripts/ops/tests/ordinary-${index}.test.ts`;
        r.files.push({ file: ordinary, tier: 'owner', outcome: 'pending' }); r.write(ordinary, 'pass\n');
      }
      r.commit({ 'scripts/qa/test.ts': `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = join(process.env.REZICS_QA_ARTIFACT_ROOT!, 'owner-proof');
mkdirSync(directory, { recursive: true });
const args = process.argv.slice(2);
const files = args.filter((_, index) => args[index - 1] === '--file');
writeFileSync(join(directory, 'owner.xml'), files.map(file => '<testcase file="' + file + '" name="proof"></testcase>').join(''));
console.log('Owner deadline: ' + process.env.REZICS_QA_OWNER_BUDGET_MS);
` });
      for (const legacy of [false, true]) {
        const result = await r.run({ runId: legacy ? 'legacy-owner-deadline' : 'owner-deadline', only: ['owner'],
          runner: async (checkout, batch, directory, shards, slotLimit, artifactRoot) => {
            if (batch.tier !== 'owner') return r.runner(checkout, batch, directory, shards, slotLimit, artifactRoot);
            const produced = await runBatch(checkout, legacy ? { ...batch, budgetMs: undefined } : batch, directory, shards, slotLimit, artifactRoot);
            expect(readFileSync(join(directory, 'runner.log'), 'utf8')).toContain(`Owner deadline: ${batch.budgetMs}`);
            return produced;
          } });
        expect(result.batches.filter(batch => batch.tier === 'owner')).toEqual([
          expect.objectContaining({ files: [file], budgetMs: 960_000 }),
          expect.objectContaining({ files: r.files.filter(item => item.tier === 'owner' && item.file !== file).map(item => item.file), budgetMs: 600_000 }),
        ]);
        expect(result.files.filter(item => item.tier === 'owner').every(item => item.outcome === 'passed')).toBe(true);
      }
    } finally { r.cleanup(); }
  }, 60_000);

  test('owner files without timeout declarations keep fifteen-file batches and the ordinary deadline', async () => {
    const r = repo();
    try {
      for (let index = 0; index < 30; index++) {
        const file = `scripts/ops/tests/ordinary-${index}.test.ts`;
        r.files.push({ file, tier: 'owner', outcome: 'pending' }); r.write(file, 'pass\n');
      }
      r.commit();
      const result = await r.run({ runId: 'ordinary-owner-deadline', only: ['owner'] });
      const batches = result.batches.filter(batch => batch.tier === 'owner');
      expect(batches.map(batch => batch.files.length)).toEqual([15, 15, 1]);
      expect(batches.flatMap(batch => batch.files)).toEqual(r.files.filter(file => file.tier === 'owner').map(file => file.file));
      expect(batches.map(batch => batch.budgetMs)).toEqual([600_000, 600_000, 600_000]);
    } finally { r.cleanup(); }
  });

  test('the lane count file widens the batches in flight and its absence keeps two', async () => {
    const r = repo();
    let active = 0;
    let maximum = 0;
    try {
      for (let index = 0; index < 60; index++) {
        const file = `scripts/ops/tests/wide-${index}.test.ts`;
        r.files.push({ file, tier: 'owner', outcome: 'pending' }); r.write(file, 'pass\n');
      }
      r.commit();
      expect(regressionLaneLimit(r.options.stateDir, 2)).toBe(2);
      mkdirSync(r.options.stateDir, { recursive: true });
      writeFileSync(join(r.options.stateDir, 'regress-lane-count'), 'many\n');
      expect(regressionLaneLimit(r.options.stateDir, 2)).toBe(2);
      writeFileSync(join(r.options.stateDir, 'regress-lane-count'), '4\n');
      expect(regressionLaneLimit(r.options.stateDir, 2)).toBe(4);
      const result = await r.run({ runId: 'wide-lanes', slots: 3, only: ['owner'], runner: async (...args) => {
        // Each batch is given as many host slots as there are lanes, or the lanes queue for two slots.
        expect(args[4]).toBe(4);
        active++; maximum = Math.max(maximum, active);
        try { await Bun.sleep(5); return await r.runner(...args); } finally { active--; }
      } });
      expect(maximum).toBe(4);
      expect(result.batches.filter(batch => batch.tier === 'owner').every(batch => batch.state === 'done')).toBe(true);
    } finally { r.cleanup(); }
  });

  test('the owner deadline planner comes from the entry module when it hands itself over', async () => {
    const r = repo();
    const planned: string[] = [];
    try {
      r.commit();
      provideGoalctl({ declaredTestTimeout: goalctl.declaredTestTimeout, heavyQaStatus: goalctl.heavyQaStatus,
        planUnitGateShards: (entries, shards, budget) => {
          planned.push(...entries.map(entry => entry.file));
          return goalctl.planUnitGateShards(entries, shards, budget);
        } });
      const result = await r.run({ runId: 'entry-planner', only: ['owner'] });
      const owner = r.files.filter(file => file.tier === 'owner').map(file => file.file);
      expect(planned.sort()).toEqual([...owner].sort());
      expect(result.batches.filter(batch => batch.tier === 'owner').every(batch => batch.budgetMs !== undefined)).toBe(true);
    } finally { provideGoalctl(undefined); r.cleanup(); }
  });

  test('the command entry hands itself to the regression and the regression never imports it unprovided', () => {
    // goalctl awaits the regression at its top level; an import of goalctl from the regression while it runs never settles.
    const entry = readFileSync(join(import.meta.dir, 'goalctl.ts'), 'utf8');
    const start = entry.indexOf("case 'regress': {");
    expect(start).toBeGreaterThan(-1);
    const body = entry.slice(start, entry.indexOf('runRegression(', start));
    expect(body).toContain('provideGoalctl({ declaredTestTimeout, planUnitGateShards, heavyQaStatus })');
    const regression = readFileSync(join(import.meta.dir, 'regress.ts'), 'utf8');
    expect(regression.match(/import\('\.\/goalctl\.ts'\)/g)).toHaveLength(2);
    expect(regression).toContain("providedGoalctl ?? await import('./goalctl.ts')");
  });

  test('an unparseable owner timeout is reported and falls back to the ordinary batch deadline', async () => {
    const r = repo();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const file = r.files.find(item => item.tier === 'owner')!.file;
    const ordinary = 'scripts/ops/tests/ordinary.test.ts';
    try {
      r.write(file, "test('proof', () => {}, 900_000);\ntest('dynamic proof', () => {}, proofTimeout);\n");
      r.files.push({ file: ordinary, tier: 'owner', outcome: 'pending' }); r.write(ordinary, 'pass\n');
      r.commit();
      const result = await r.run({ runId: 'unparseable-owner-deadline', only: ['owner'] });
      expect(result.batches.filter(batch => batch.tier === 'owner')).toEqual([
        expect.objectContaining({ files: [file, ordinary], budgetMs: 600_000 }),
      ]);
      expect(log).toHaveBeenCalledWith(`Regression: ${file} declared a timeout that could not be parsed; using the default per-file deadline`);
    } finally { log.mockRestore(); r.cleanup(); }
  });

  test('owner isolation uses the gate margin and honors the configured ordinary deadline', async () => {
    const r = repo();
    const previous = process.env.REZICS_QA_OWNER_BUDGET_MS;
    const ordinary = r.files.find(item => item.tier === 'owner')!.file;
    const long = 'scripts/ops/tests/native-proof.test.ts';
    try {
      process.env.REZICS_QA_OWNER_BUDGET_MS = '700000';
      r.write(ordinary, "test('proof', () => {}, 640_000);\n");
      r.files.push({ file: long, tier: 'owner', outcome: 'pending' });
      r.write(long, "setDefaultTimeout(640_001);\ntest('proof', () => {});\n");
      r.commit();
      const result = await r.run({ runId: 'owner-margin-boundary', only: ['owner'] });
      expect(result.batches.filter(batch => batch.tier === 'owner')).toEqual([
        expect.objectContaining({ files: [long], budgetMs: 700_001 }),
        expect.objectContaining({ files: [ordinary], budgetMs: 700_000 }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.REZICS_QA_OWNER_BUDGET_MS;
      else process.env.REZICS_QA_OWNER_BUDGET_MS = previous;
      r.cleanup();
    }
  });

  test('a whole-tier deadline routes one batch event without confirming or probing its files', async () => {
    const r = repo();
    try {
      for (let index = 1; index < 12; index++) {
        const file = `tests/qa/unit/example-${index}.test.ts`;
        r.files.push({ file, tier: 'unit', outcome: 'pending' }); r.write(file, 'pass\n');
      }
      r.commit();
      const result = await r.run({ runId: 'tier-deadline', only: ['unit'], runner: async (...args) => {
        const result = await r.runner(...args);
        return args[1].tier === 'unit' ? { ...result, code: 1, classification: 'deadline', outcomes: {},
          evidence: 'bun timed out after 180000 ms of active work',
          failingTests: args[1].files.map(file => `${file}: QA file did not complete`) } : result;
      } });
      expect(result.status).toBe('incomplete');
      expect(r.calls.filter(call => call.batch.tier === 'unit')).toHaveLength(1);
      expect(result.diagnoses).toEqual([expect.objectContaining({ file: 'batch:unit-1', classification: 'deadline', status: 'unavailable' })]);
      expect(inboxEntries(r.options.stateDir, 'program')).toEqual([expect.objectContaining({
        failingTests: ['batch:unit-1'], runEvent: { batchId: 'unit-1', tier: 'unit', fileCount: 12,
          cause: 'bun timed out after 180000 ms of active work' },
      })]);
      expect(result.batches[0]!.attempts[0]!.cause).toContain('180000');
      r.calls.length = 0;
      await r.run({ resume: 'tier-deadline' });
      expect(r.calls).toHaveLength(0);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test('a timed-out native proof batch reaps its labelled Docker container', async () => {
    const r = repo();
    const file = 'infra/jena/tests/erasure-campaign-native.test.ts';
    const directory = join(r.dir, '.temp/native-timeout');
    const bin = join(r.dir, '.temp/native-timeout-bin');
    const state = join(r.dir, '.temp/native-timeout-state');
    const dockerLog = join(r.dir, '.temp/native-docker.jsonl');
    mkdirSync(bin, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') console.log('native-container');
`);
    chmodSync(join(bin, 'docker'), 0o755);
    r.write(file, `import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';
test('native container work hangs until its batch deadline', async () => {
  if (!process.env.REZICS_REAP_SCOPE || process.env.REZICS_REAP_PRELOAD !== '1') {
    throw new Error('native proof batch did not receive the QA reaper environment');
  }
  const result = spawnSync('docker', ['run', '--rm', 'jena:test', 'sleep', '600']);
  if (result.status !== 0) throw new Error('docker run failed');
  await new Promise<void>(() => {});
}, 60_000);
`);
    r.commit();
    const envKeys = ['PATH', 'REZICS_REAP_OWNER', 'REZICS_REAP_STATE', 'REZICS_REAP_SCOPE', 'REZICS_REAP_SCOPES'] as const;
    const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.REZICS_REAP_OWNER = '987654321:1';
    process.env.REZICS_REAP_STATE = state;
    delete process.env.REZICS_REAP_SCOPE;
    delete process.env.REZICS_REAP_SCOPES;
    try {
      const result = await runBatch(r.dir, {
        id: 'native-timeout', tier: 'jena:check', files: [file], state: 'pending', attempts: [],
      }, directory, 1, 1, undefined, { deadlineCapMs: 5_000 });
      expect(result.code).toBe(124);
      expect(result.classification).toBe('deadline');
      expect(result.outcomes[file]).toBe('failed');
      const calls = readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      const run = calls.find(args => args[0] === 'run');
      expect(run).toBeDefined();
      const scopeLabel = run!.find(arg => arg.startsWith(`${reapScopeLabel}.`))!;
      expect(scopeLabel).toMatch(/^rezics\.reap-scope\.[A-Za-z0-9_.-]+=1$/);
      const cleanupFilter = `label=${scopeLabel!.slice(0, -2)}`;
      expect(calls).toContainEqual(['ps', '-aq', '--filter', cleanupFilter]);
      expect(calls).toContainEqual(['rm', '-f', 'native-container']);
    } finally {
      for (const key of envKeys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      r.cleanup();
    }
  });

  test('a native proof queued longer than its proof budget is still recorded passed', async () => {
    const r = repo();
    const file = inputSelectedNativeTests[0];
    const directory = join(r.dir, '.temp/native-queued');
    const slotDirectory = join(r.options.stateDir!, 'qa-slots');
    mkdirSync(slotDirectory, { recursive: true });
    const lease = tryAcquireDirectoryLease(join(slotDirectory, '0'));
    if (!lease || lease === 'held') throw new Error('fixture slot was not free');
    r.files.push({ file, tier: 'jena:check', outcome: 'pending' });
    r.write(file, "import { test } from 'bun:test';\ntest('admitted proof passes', () => {});\n");
    r.commit();
    const savedProfile = process.env.REZICS_STACK_PROFILE;
    process.env.REZICS_STACK_PROFILE = 'dev';
    let pending: Promise<Execution> | undefined;
    try {
      // Run in the fixture root so its actual slot wrapper sees the held fixture lease.
      pending = runBatch(r.dir, { id: 'native-queued', tier: 'jena:check', files: [file],
        state: 'pending', attempts: [] }, directory, 1, 1, undefined, { deadlineCapMs: 1_000 });
      const waitDeadline = Date.now() + 15_000;
      while (!existsSync(join(directory, 'runner.log'))
        || !readFileSync(join(directory, 'runner.log'), 'utf8').includes('waiting for QA slot')) {
        if (Date.now() >= waitDeadline) throw new Error('native proof never queued for its slot');
        await Bun.sleep(25);
      }
      await Bun.sleep(1_100);
      lease.release();
      const execution = await pending;
      expect(execution.code).toBe(0);
      expect(execution.classification).toBeUndefined();
      expect(execution.outcomes[file]).toBe('passed');
      const result = await r.run({ runId: 'native-queued-pass', runner: async (...args) =>
        args[1].files.includes(file) ? execution : r.runner(...args) });
      expect(result.files).toContainEqual({ file, tier: 'jena:check', outcome: 'passed' });
      expect(r.manifest('native-queued-pass').files).toContainEqual({ file, tier: 'jena:check', outcome: 'passed' });
    } finally {
      lease.release();
      await pending;
      if (savedProfile === undefined) delete process.env.REZICS_STACK_PROFILE;
      else process.env.REZICS_STACK_PROFILE = savedProfile;
      r.cleanup();
    }
  }, 30_000);

  test('a batch timeout names the hanging file and reruns only the files that never started', async () => {
    const recorded = join(import.meta.dir, '../../tests/qa/fixtures/regression-hang');
    const logs = {
      model: {
        log: 'model-1.txt',
        hang: 'services/main/tests/read-snapshot-native.test.ts',
        after: [] as string[],
        files: [
          'infra/jena/tests/command.integration.test.ts',
          'model/compiler/generate.test.ts',
          'model/tests/daily-rating.test.ts',
          'model/tests/event-time.test.ts',
          'model/tests/experience-rating.test.ts',
          'model/tests/native-equivalence.test.ts',
          'model/tests/reasoning-profile.test.ts',
          'model/tests/source-reification.test.ts',
          'model/tests/validation-shape-terms.test.ts',
          'packages/model/tests/generated.test.ts',
          'services/main/tests/read-snapshot-native.test.ts',
        ],
      },
      unit: {
        log: 'unit-17.txt',
        hang: 'infra/jena/tests/semantic-source-readiness-union.test.ts',
        after: [
          'infra/jena/tests/tdb2-integrity.test.ts',
          'infra/jena/tests/work-name-scope-basis.test.ts',
        ],
        files: [
          'infra/jena/tests/erasure-campaign-shell.test.ts',
          'infra/jena/tests/fuseki-owner.test.ts',
          'infra/jena/tests/native-external-fixture.test.ts',
          'infra/jena/tests/native-integer-preservation.test.ts',
          'infra/jena/tests/semantic-source-readiness-union.test.ts',
          'infra/jena/tests/tdb2-integrity.test.ts',
          'infra/jena/tests/work-name-scope-basis.test.ts',
          'model/compiler/shacl.test.ts',
          'model/tests/agent-realm-turtle.test.ts',
          'model/tests/claim-analysis.test.ts',
          'model/tests/comment-source-erasure.test.ts',
          'model/tests/context-classification-turtle.test.ts',
          'model/tests/contribution-selection-turtle.test.ts',
          'model/tests/facet-definitions.test.ts',
          'model/tests/g-512-language-profiles.test.ts',
        ],
      },
    } as const;
    for (const tier of ['model', 'unit'] as const) {
      const spec = logs[tier];
      const r = repo();
      try {
        const previous = r.files.filter(file => file.tier === tier).map(file => file.file);
        r.files.splice(0, r.files.length, ...r.files.filter(file => file.tier !== tier),
          ...spec.files.map(file => ({ file, tier, outcome: 'pending' as const })));
        for (const file of spec.files) r.write(file, file === 'infra/jena/tests/command.integration.test.ts' ? 'fail\n' : 'pass\n');
        r.commit(Object.fromEntries(previous.map(file => [file, null])));
        const result = await r.run({ runId: `${tier}-hang`, only: [tier], runner: async (...args) => {
          const produced = await r.runner(...args);
          if (args[1].id !== `${tier}-1` || !args[2].endsWith('/attempt-1')) return produced;
          const path = join(args[2], 'logs', `${tier}.log`);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, readFileSync(join(recorded, spec.log), 'utf8'));
          return { ...produced, code: 1, classification: 'deadline',
            outcomes: Object.fromEntries(args[1].files.map(file => [file, 'missing' as const])),
            evidence: 'bun timed out after 180000 ms of active work', artifactPaths: [args[2]] };
        } });
        const rest = r.calls.filter(call => call.batch.tier === tier && call.batch.id.endsWith('-rest'));
        expect(rest.map(call => call.batch.files)).toEqual(spec.after.length ? [[...spec.after]] : []);
        expect(rest.every(call => !call.batch.files.includes(spec.hang))).toBe(true);
        const log = join(r.calls.find(call => call.batch.tier === tier && call.directory.endsWith('/attempt-1'))!.directory, 'logs', `${tier}.log`);
        const hung = result.files.find(file => file.file === spec.hang)!;
        expect(hung.outcome).toBe('failed');
        expect(hung.reason).toBe(`Hung until the tier deadline; ${log}`);
        expect(result.files.find(file => file.file === (tier === 'unit' ? 'model/compiler/shacl.test.ts' : 'model/compiler/generate.test.ts'))!.outcome).toBe('passed');
        const summary = readFileSync(join(r.options.stateDir, 'regress', `${tier}-hang`, 'summary.md'), 'utf8');
        expect(summary).toContain(spec.hang);
        expect(summary).toContain(log);
        const diagnosis = result.diagnoses.find(item => item.file === spec.hang);
        expect(diagnosis).toMatchObject({ classification: 'deadline', reason: `Hung until the tier deadline; ${log}` });
        expect(diagnosis!.artifactPaths).toContain(log);
        expect(result.diagnoses.some(item => item.file === `batch:${tier}-1`)).toBe(false);
        for (const file of spec.after) expect(result.files.find(item => item.file === file)!.outcome).toBe('passed');
      } finally { r.cleanup(); }
    }
  });

  test('a batch that times out before any file header stays a deadline for the batch', async () => {
    const r = repo();
    try {
      const later = 'tests/qa/unit/later.test.ts';
      r.files.push({ file: later, tier: 'unit', outcome: 'pending' });
      r.write(later, 'pass\n');
      r.commit();
      const result = await r.run({ runId: 'admission-deadline', only: ['unit'], runner: async (...args) => {
        const produced = await r.runner(...args);
        if (args[1].tier !== 'unit') return produced;
        const path = join(args[2], 'logs', 'unit.log');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'Memory admission deadline reached; no work started\n');
        return { ...produced, code: 1, classification: 'deadline', outcomes: {},
          evidence: 'Memory admission deadline reached; no work started', artifactPaths: [args[2]] };
      } });
      expect(r.calls.filter(call => call.batch.tier === 'unit')).toHaveLength(1);
      expect(result.diagnoses).toEqual([expect.objectContaining({ file: 'batch:unit-1', classification: 'deadline', status: 'unavailable' })]);
      expect(result.files.filter(file => file.tier === 'unit').every(file => file.outcome === 'missing')).toBe(true);
      expect(result.files.some(file => file.reason?.includes('Hung until the tier deadline'))).toBe(false);
    } finally { r.cleanup(); }
  });

  test('a deadline with partial evidence retains per-file assertion failures alongside one run event', async () => {
    const r = repo();
    try {
      const missing = 'tests/qa/unit/unexecuted.test.ts';
      r.files.push({ file: missing, tier: 'unit', outcome: 'pending' }); r.write(missing, 'pass\n');
      r.commit({ [r.unit]: 'fail\n' });
      const result = await r.run({ runId: 'partial-deadline', only: ['unit'], runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[1].tier !== 'unit') return result;
        return { ...result, failingTests: [`${r.unit}: expected assertion`],
          ...(args[2].endsWith('/attempt-1') ? { classification: 'deadline', outcomes: { [r.unit]: 'failed', [missing]: 'missing' } } : {}) };
      } });
      const entries = inboxEntries(r.options.stateDir, 'program');
      expect(entries).toHaveLength(2);
      expect(entries[0]!.runEvent).toMatchObject({ batchId: 'unit-1', fileCount: 2 });
      expect(entries[1]!.failingTests).toEqual([`${r.unit}: expected assertion`]);
      expect(entries[1]!.runEvent).toBeUndefined();
      expect(result.diagnoses.some(diagnosis => diagnosis.file === missing)).toBe(false);
      expect(r.calls.some(call => call.directory.includes('/alone-') && call.batch.files.includes(missing))).toBe(false);
    } finally { r.cleanup(); }
  });

  test('an infrastructure retry that recovers produces no run event', async () => {
    const r = repo();
    try {
      let down = true;
      const result = await r.run({ runId: 'infra-recovered', runner: async (...args) => {
        const result = await r.runner(...args);
        if (down && args[1].tier === 'unit') { down = false; return { ...result, code: 1, classification: 'infrastructure' }; }
        return result;
      } });
      expect(result.status).toBe('passed');
      expect(result.batches[0]!.attempts).toHaveLength(2);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('a confirmation deadline produces one run event without probing unavailable files', async () => {
    const r = repo();
    try {
      const missing = 'tests/qa/unit/unexecuted.test.ts';
      r.files.push({ file: missing, tier: 'unit', outcome: 'pending' }); r.write(missing, 'pass\n');
      r.commit({ [r.unit]: 'fail\n' });
      const result = await r.run({ runId: 'confirm-deadline', only: ['unit'], runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[1].tier !== 'unit') return result;
        return { ...result, outcomes: {}, code: 1, classification: args[2].endsWith('/confirm') ? 'deadline' : 'deterministic' };
      } });
      expect(result.diagnoses).toEqual([expect.objectContaining({ file: 'batch:unit-1', classification: 'deadline' })]);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(1);
      expect(r.calls.filter(call => call.batch.tier === 'unit')).toHaveLength(2);
      expect(r.calls.some(call => call.directory.includes('/alone-'))).toBe(false);
      r.calls.length = 0;
      await r.run({ resume: 'confirm-deadline' });
      expect(r.calls).toHaveLength(0);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test('a confirmation deadline retains initial assertions without assigning regression blame', async () => {
    const r = repo();
    try {
      r.commit({ [r.unit]: 'fail\n' });
      const result = await r.run({ runId: 'confirm-assertion', only: ['unit'], runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[1].tier !== 'unit') return result;
        return { ...result, failingTests: [`${r.unit}: expected assertion`],
          ...(args[2].endsWith('/confirm') ? { classification: 'deadline', outcomes: {} } : {}) };
      } });
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(2);
      expect(result.diagnoses.find(diagnosis => diagnosis.file === r.unit)).toMatchObject({
        status: 'unavailable', classification: 'deterministic', reason: 'Batch confirmation unavailable',
      });
      expect(r.calls.some(call => call.directory.includes('/alone-') || call.directory.includes('/probes/'))).toBe(false);
    } finally { r.cleanup(); }
  });

  test('an assertion completed before its own file deadline survives missing file evidence', async () => {
    const r = repo();
    try {
      r.commit({ [r.unit]: 'fail\n' });
      const result = await r.run({ runId: 'incomplete-assertion', only: ['unit'], runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[1].tier !== 'unit') return result;
        const tests = ['completed assertion', UNEXECUTED_FILE_TEST].map(name => ({
          file: r.unit, name, tier: 'unit' as const, failed: true, skipped: false,
        }));
        return { ...result, classification: 'deadline', outcomes: executionOutcomes(args[0], args[1], tests),
          failingTests: tests.map(test => `${test.file}: ${test.name}`) };
      } });
      expect(result.files.find(file => file.file === r.unit)!.outcome).toBe('missing');
      expect(inboxEntries(r.options.stateDir, 'program')).toEqual([
        expect.objectContaining({ runEvent: expect.objectContaining({ batchId: 'unit-1' }) }),
        expect.objectContaining({ failingTests: [`${r.unit}: completed assertion`], status: 'unavailable' }),
      ]);
      expect(r.calls.filter(call => call.batch.tier === 'unit')).toHaveLength(2);
      expect(r.calls.some(call => call.directory.includes('/alone-') || call.directory.includes('/probes/'))).toBe(false);
      r.calls.length = 0;
      await r.run({ resume: 'incomplete-assertion' });
      expect(r.calls).toHaveLength(0);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(2);
    } finally { r.cleanup(); }
  });

  test('infrastructure during confirmation, isolation or bisection retains every initial assertion', async () => {
    for (const phase of ['confirm', 'alone', 'probe'] as const) {
      const r = repo();
      const second = 'tests/qa/unit/second.test.ts';
      try {
        r.files.push({ file: second, tier: 'unit', outcome: 'pending' }); r.write(second, 'pass\n');
        const base = r.commit();
        await r.run({ runId: 'assertion-base', only: ['unit'] });
        const bad = r.commit({ [r.unit]: 'fail\n', [second]: 'fail\n' }); r.event(base, bad);
        const result = await r.run({ runId: `assertion-${phase}`, only: ['unit'], runner: async (...args) => {
          const result = await r.runner(...args);
          if (args[1].tier !== 'unit') return result;
          const unavailable = phase === 'confirm' ? args[2].endsWith('/confirm')
            : phase === 'alone' ? args[2].includes('/alone-') : args[2].includes('/probes/');
          return { ...result, failingTests: args[1].files.filter(file => result.outcomes[file] === 'failed').map(file => `${file}: completed assertion`),
            ...(unavailable ? { code: 1, classification: 'infrastructure', outcomes: {}, evidence: 'Cannot connect to the Docker daemon' } : {}) };
        } });
        expect(result.batches.find(batch => batch.tier === 'unit')!.state).toBe('pending');
        expect(result.files.filter(file => file.tier === 'unit').every(file => file.outcome === 'void')).toBe(true);
        const entries = inboxEntries(r.options.stateDir, 'program');
        expect(entries).toHaveLength(3);
        expect(entries.filter(entry => entry.runEvent)).toEqual([expect.objectContaining({ classification: 'infrastructure',
          runEvent: expect.objectContaining({ batchId: 'unit-1', fileCount: 2 }) })]);
        expect(entries.filter(entry => !entry.runEvent)).toEqual([r.unit, second].map(file => expect.objectContaining({
          failingTests: [`${file}: completed assertion`], status: 'unavailable', classification: 'deterministic', goal: 'program', taskIds: [],
        })));
        expect(result.diagnoses.filter(diagnosis => !diagnosis.file.startsWith('batch:')).every(diagnosis => !diagnosis.before)).toBe(true);
        expect(r.calls.filter(call => call.directory.includes('/alone-') && call.batch.files.includes(second))).toHaveLength(0);
        r.calls.length = 0;
        const recovered = await r.run({ resume: `assertion-${phase}`, runner: async (...args) => {
          const result = await r.runner(...args);
          return { ...result, failingTests: args[1].files.filter(file => result.outcomes[file] === 'failed').map(file => `${file}: completed assertion`) };
        } });
        expect(recovered.batches.find(batch => batch.tier === 'unit')!.state).toBe('done');
        expect(recovered.diagnoses.filter(diagnosis => !diagnosis.file.startsWith('batch:'))).toEqual([r.unit, second].map(file =>
          expect.objectContaining({ file, status: 'attributed', goal: 'owner', before: base, after: bad })));
        expect(r.calls.some(call => call.directory.endsWith('/confirm'))).toBe(true);
        expect(inboxEntries(r.options.stateDir, 'owner')).toHaveLength(2);
        expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(3);
      } finally { r.cleanup(); }
    }
  });

  test('pending infrastructure retains assertion evidence from earlier attempts without duplicate inbox entries', async () => {
    const r = repo();
    try {
      r.commit({ [r.unit]: 'fail\n' });
      const runner: RegressionOptions['runner'] = async (...args) => {
        const result = await r.runner(...args);
        return args[1].tier === 'unit' ? { ...result, code: 1, classification: 'infrastructure', outcomes: {},
          failingTests: args[2].endsWith('/attempt-1') ? [`${r.unit}: completed assertion`] : [],
          evidence: 'Cannot connect to the Docker daemon' } : result;
      };
      const result = await r.run({ runId: 'pending-assertion', only: ['unit'], runner });
      expect(result.batches[0]!.state).toBe('pending');
      expect(result.batches[0]!.attempts).toHaveLength(2);
      expect(inboxEntries(r.options.stateDir, 'program')).toEqual([
        expect.objectContaining({ runEvent: expect.objectContaining({ batchId: 'unit-1' }) }),
        expect.objectContaining({ failingTests: [`${r.unit}: completed assertion`], status: 'unavailable', classification: 'deterministic' }),
      ]);
      expect(result.diagnoses.find(diagnosis => diagnosis.file === r.unit)!.artifactPaths)
        .toContain(r.calls.find(call => call.directory.endsWith('/attempt-1') && call.batch.tier === 'unit')!.directory);
      await r.run({ resume: 'pending-assertion', runner });
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(2);
    } finally { r.cleanup(); }
  });

  test('a Storybook assertion followed by a deadline keeps both the file failure and run event', async () => {
    const r = repo();
    const story = 'apps/web/features/example.stories.tsx';
    const journey = 'apps/web/tests/example.e2e.ts';
    try {
      r.commit({ [story]: 'fail\n' });
      const result = await r.run({ runId: 'story-deadline', only: ['e2e'], runner: async (...args) => {
        const result = await r.runner(...args);
        return args[1].tier === 'e2e' && args[2].endsWith('/attempt-1')
          ? { ...result, classification: 'deadline', outcomes: executionOutcomes(args[0], args[1], [],
            '<testsuite name="features/example.stories.tsx" tests="2" failures="1"></testsuite>') } : result;
      } });
      expect(inboxEntries(r.options.stateDir, 'program')).toEqual([
        expect.objectContaining({ runEvent: expect.objectContaining({ batchId: 'e2e-1', fileCount: 2 }) }),
        expect.objectContaining({ failingTests: [story] }),
      ]);
      expect(result.diagnoses.some(diagnosis => diagnosis.file === journey)).toBe(false);
    } finally { r.cleanup(); }
  });

  test('browser execution joins the fair heavy queue directly by default', async () => {
    const r = repo();
    const status = spyOn(goalctl, 'heavyQaStatus').mockImplementation(() => { throw new Error('Unexpected heavy queue drain'); });
    try {
      const result = await r.run({ runId: 'fair-browser', only: ['e2e'], waitForTurn: undefined });
      expect(status).not.toHaveBeenCalled();
      expect(r.calls.filter(call => call.batch.tier === 'e2e')).toHaveLength(1);
      expect(result.batches.filter(batch => batch.tier === 'e2e').every(batch => batch.state === 'done')).toBe(true);
    } finally { status.mockRestore(); r.cleanup(); }
  });

  test('browser batches reuse the integration width and keep mixed, journey-only and standalone Storybook commands', async () => {
    const r = repo();
    try {
      const extra = [
        ...Array.from({ length: 8 }, (_, index) => `apps/web/tests/extra-${index}.e2e.ts`),
        'apps/web/features/extra.stories.tsx', 'packages/ui/src/extra.stories.tsx',
      ];
      for (const file of extra) { r.files.push({ file, tier: 'e2e', outcome: 'pending' }); r.write(file, 'pass\n'); }
      r.commit();
      const result = await r.run({ runId: 'browser-batches', only: ['e2e'], integrationBatches: 0 });
      const batches = result.batches.filter(batch => batch.tier === 'e2e');
      expect(batches.map(batch => batch.files.length)).toEqual([5, 5, 2]);
      expect(batches.flatMap(batch => batch.files)).toEqual(r.files.filter(file => file.tier === 'e2e').map(file => file.file));
      expect(result.files.filter(file => file.tier === 'e2e').every(file => file.outcome === 'passed')).toBe(true);
      const commands = batches.map(batch => regressionBatchCommand(batch, '/disk/report.json', '/disk/stories.xml'));
      expect(commands[0]).toContain('--storybook');
      expect(commands[0]).not.toContain('apps/web/features/example.stories.tsx');
      expect(commands[1]).not.toContain('--storybook');
      expect(commands[2]).toContain('--reporter=junit');
      expect(commands[2]).not.toContain('--tier');
      for (const file of batches[2]!.files) expect(commands[2]).toContain(file);
      r.calls.length = 0;
      await r.run({ resume: 'browser-batches' });
      expect(r.calls).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  for (const classification of ['deadline', 'infrastructure'] as const) {
    test(`a browser startup ${classification} affects only its batch and later files still run`, async () => {
      const r = repo();
      try {
        for (let index = 0; index < 10; index++) {
          const file = `apps/web/tests/extra-${index}.e2e.ts`;
          r.files.push({ file, tier: 'e2e', outcome: 'pending' }); r.write(file, 'pass\n');
        }
        r.commit();
        const cause = classification === 'deadline' ? 'Browser startup timed out before any file ran'
          : 'Cannot connect to the Docker daemon';
        const result = await r.run({ runId: `browser-startup-${classification}`, only: ['e2e'], runner: async (...args) => {
          const produced = await r.runner(...args);
          return args[1].id === 'e2e-1' ? { ...produced, code: 1, outcomes: {}, classification, evidence: cause } : produced;
        } });
        const batches = result.batches.filter(batch => batch.tier === 'e2e');
        expect(batches.map(batch => batch.files.length)).toEqual([5, 5, 2]);
        expect(batches[0]!.attempts).toHaveLength(classification === 'infrastructure' ? 2 : 1);
        for (const file of batches[0]!.files) {
          expect(result.files.find(entry => entry.file === file)!.outcome).toBe(classification === 'infrastructure' ? 'void' : 'missing');
        }
        for (const batch of batches.slice(1)) {
          expect(batch.state).toBe('done');
          expect(batch.attempts).toHaveLength(1);
          for (const file of batch.files) expect(result.files.find(entry => entry.file === file)!.outcome).toBe('passed');
        }
        expect(result.status).toBe('incomplete');
        expect(inboxEntries(r.options.stateDir, 'program')).toEqual([expect.objectContaining({
          classification, runEvent: { batchId: 'e2e-1', tier: 'e2e', fileCount: 5, cause },
        })]);
      } finally { r.cleanup(); }
    });
  }

  test('routine selection excludes browser tiers with a resumable reason; explicit full selection runs them', async () => {
    const r = repo();
    try {
      const routine = await r.run({ runId: 'routine' });
      expect(routine.status).toBe('passed');
      expect(routine.partial).toBe(false);
      expect(routine.files.filter(file => file.tier === 'e2e' || file.tier === 'accounts:storybook'))
        .toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'excluded', reason: expect.stringContaining('nightly') })]));
      expect(r.calls.some(call => call.batch.tier === 'e2e' || call.batch.tier === 'accounts:storybook')).toBe(false);
      expect((await r.run({ resume: 'routine' })).status).toBe('passed');
      r.calls.length = 0;
      const full = await r.run({ runId: 'nightly', only: ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'e2e', 'accounts:storybook', 'jena:check'] });
      expect(full.status).toBe('passed');
      expect(full.partial).toBe(false);
      expect(full.files.every(file => file.outcome === 'passed')).toBe(true);
    } finally { r.cleanup(); }
  });

  test('routine resume preserves registry-owned browser exclusions', async () => {
    const r = repo();
    try {
      r.files.find(file => file.file === 'apps/web/tests/example.e2e.ts')!.outcome = 'excluded';
      r.files.find(file => file.file === 'apps/web/tests/example.e2e.ts')!.reason = 'Provider evidence requires separate credentials';
      const result = await r.run({ runId: 'browser-exclusion' });
      expect(result.files.find(file => file.file === 'apps/web/tests/example.e2e.ts')!.reason)
        .toBe('Provider evidence requires separate credentials');
      expect((await r.run({ resume: 'browser-exclusion' })).status).toBe('passed');
    } finally { r.cleanup(); }
  });

  test('nightly runs all non-browser tiers and only one exact journey per vertical, preserving resume', async () => {
    const r = repo();
    // Prove a complete plan even while the shipped registry explicitly records a recipe gap.
    const journeys = verticalJourneys.map(journey => 'missing' in journey
      ? { kind: journey.kind, file: `apps/web/tests/${journey.kind}.e2e.ts`, test: `${journey.kind} signed-in journey` } : journey);
    try {
      for (const journey of journeys) if (!r.files.some(file => file.file === journey.file)) {
        r.files.push({ file: journey.file, tier: 'e2e', outcome: 'pending' }); r.write(journey.file, 'pass\n');
      }
      r.commit();
      const options = { nightly: true, journeyRegistry: async () => journeys };
      const result = await r.run({ runId: 'vertical-nightly', ...options });
      expect(result.selection).toBe('nightly');
      expect(result.status).toBe('passed');
      expect(result.partial).toBe(false);
      expect(result.verticalJourneys).toEqual(journeys);
      expect(new Set(r.calls.map(call => call.batch.tier))).toEqual(new Set(['unit', 'owner', 'model', 'integration', 'fault/recovery', 'e2e', 'jena:check']));
      const browser = r.calls.filter(call => call.batch.tier === 'e2e');
      expect(browser).toHaveLength(6);
      expect(browser.flatMap(call => call.batch.tests ?? []).sort())
        .toEqual(journeys.map(journey => journey.test).sort());
      for (const { batch } of browser) {
        expect(batch.files).toHaveLength(1);
        const command = regressionBatchCommand(batch, '/disk/report.json', '/disk/tests.xml');
        expect(command).toContain('--heavy');
        expect(command).not.toContain('--storybook');
        const [, args] = selectTestCommand(command.slice(command.indexOf('--tier')));
        const parsed = parseArgs(args.slice(1));
        expect(storybookCommands(e2eBrowserPlan(parsed.files ?? [], parsed.storybook))).toEqual([]);
        const filter = new RegExp(verticalJourneyFilter(batch.tests!));
        const env = regressionBatchEnvironment({ REZICS_E2E_GREP: '.*', REZICS_E2E_PROJECTS: 'all' }, 1, 1, undefined, undefined, batch.tests);
        expect(env.REZICS_E2E_GREP).toBe(filter.source);
        expect(env.REZICS_E2E_PROJECTS).toBe('desktop-chrome');
        expect(env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS).toBe(String(batch.tests!.length * 300_000));
        expect(batch.tests!.every(title => filter.test(`desktop-chrome file ${title}`))).toBe(true);
        expect(filter.test('an unselected journey')).toBe(false);
      }
      const resumed = await r.run({ resume: 'vertical-nightly', journeyRegistry: options.journeyRegistry });
      expect(resumed.status).toBe('passed');
      const corrupt = r.manifest('vertical-nightly');
      corrupt.batches.find(batch => batch.tier === 'e2e')!.tests = ['another test'];
      writeFileSync(join(r.options.stateDir, 'regress/vertical-nightly/manifest.json'), JSON.stringify(corrupt));
      await expect(r.run({ resume: 'vertical-nightly', journeyRegistry: options.journeyRegistry })).rejects.toThrow('nightly journey selection');
    } finally { r.cleanup(); }
  });

  test('nightly uses the pinned registry and reports a missing vertical instead of silently completing coverage', async () => {
    const r = repo();
    const journeys: VerticalJourney[] = [{ kind: 'books', file: 'apps/web/tests/example.e2e.ts', test: 'reader saves' },
      { kind: 'games', missing: 'No passing signed-in journey on the clean QA profile' }];
    try {
      const module = 'scripts/qa/cases/vertical-journeys.ts';
      r.write(module, `export const verticalJourneys = ${JSON.stringify(journeys)};\n`);
      r.commit();
      r.write(module, 'export const verticalJourneys = [];\n');
      const result = await r.run({ runId: 'missing-vertical', nightly: true });
      expect(result.status).toBe('incomplete');
      expect(result.verticalJourneys).toEqual(journeys);
      expect(readFileSync(join(r.options.stateDir, 'regress/missing-vertical/summary.md'), 'utf8'))
        .toContain('games: missing; No passing signed-in journey');
    } finally { r.cleanup(); }
  });

  test('owner and stack batches fit bounded groups and use at most two ordinary slots', async () => {
    const r = repo(60);
    for (const tier of ['owner', 'fault/recovery'] as const) for (let index = 0; index < 32; index++) {
      const file = `tests/${tier.replace('/', '-')}/extra-${index}.test.ts`;
      r.files.push({ file, tier, outcome: 'pending' }); r.write(file, 'pass\n');
    }
    r.commit();
    let active = 0;
    let maximum = 0;
    const activeTrees = new Set<string>();
    try {
      const result = await r.run({ runId: 'parallel', slots: 3, runner: async (...args) => {
        expect(activeTrees.has(args[0])).toBe(false);
        activeTrees.add(args[0]); active++; maximum = Math.max(maximum, active);
        try {
          await Bun.sleep(1);
          return await r.runner(...args);
        } finally { active--; activeTrees.delete(args[0]); }
      }, waitForTurn: async () => { throw new Error('Light batches must not wait for heavy QA'); } });
      expect(maximum).toBe(2);
      expect(result.status).toBe('passed');
      for (const tier of ['owner', 'integration', 'fault/recovery'] as const) {
        const batches = result.batches.filter(batch => batch.tier === tier);
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.every(batch => batch.files.length <= (tier === 'integration' ? 5 : 15))).toBe(true);
        expect(batches.flatMap(batch => batch.files).sort()).toEqual(r.files.filter(file => file.tier === tier).map(file => file.file).sort());
      }
      const pooled = r.calls.filter(call => ['owner', 'integration', 'fault/recovery'].includes(call.batch.tier));
      expect(new Set(pooled.map(call => call.checkout)).size).toBe(2);
      expect(pooled.every(call => call.checkout !== result.checkout)).toBe(true);
    } finally { r.cleanup(); }
  });

  test('regression shard leases share the two-slot limit with their parent QA runs', async () => {
    const r = repo(60);
    const slotDirectory = join(r.dir, '.temp', 'qa-slots');
    const probes = join(r.dir, '.temp', 'slot-probes');
    const script = join(r.dir, '.temp', 'slot-probe.ts');
    mkdirSync(slotDirectory, { recursive: true });
    mkdirSync(probes, { recursive: true });
    writeFileSync(script, `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { acquireQaSlots } from ${JSON.stringify(join(import.meta.dir, '../qa/core.ts'))};
      const [directory, probes, id, limit, shards] = process.argv.slice(2);
      const env = { GOAL_QA_SLOTS: limit };
      const parent = await acquireQaSlots(directory, 1, env, process.pid);
      const projects = await acquireQaSlots(directory, Number(shards), env, process.pid);
      writeFileSync(join(probes, id + '.held'), String(projects.count));
      while (!existsSync(join(probes, id + '.release'))) await Bun.sleep(2);
      projects.release();
      parent.release();
    `);
    const children: ReturnType<typeof Bun.spawn>[] = [];
    let serial = 0;
    let complete = false;
    let failure: unknown;
    let result: Manifest | undefined;
    let maximumLeases = 0;
    const released = new Set<string>();
    try {
      const run = r.run({ runId: 'slot-leases', slots: 3, shards: 2, runner: async (...args) => {
        const [checkout, batch, directory, shards, slotLimit] = args;
        if (batch.tier === 'unit' || batch.tier === 'model') return r.runner(...args);
        const id = String(serial++);
        const env = regressionBatchEnvironment({ GOAL_QA_SLOTS: '3' }, shards, slotLimit);
        expect(env.GOAL_QA_SLOTS).toBe('2');
        const child = Bun.spawn(['bun', script, slotDirectory, probes, id, env.GOAL_QA_SLOTS!, String(shards)], {
          cwd: r.dir, stdout: 'ignore', stderr: 'ignore',
        });
        children.push(child);
        const code = await child.exited;
        if (code !== 0) throw new Error(`slot probe ${id} exited with ${code}`);
        return r.runner(checkout, batch, directory, shards, slotLimit);
      } }).then(value => { result = value; complete = true; }, error => { failure = error; complete = true; });
      const deadline = Date.now() + 30_000;
      while (!complete || readdirSync(probes).some(name => name.endsWith('.held') && !released.has(name))) {
        for (const name of readdirSync(probes).filter(name => name.endsWith('.held') && !released.has(name))) {
          const held = [0, 1, 2].filter(index => existsSync(join(slotDirectory, String(index)))).length;
          maximumLeases = Math.max(maximumLeases, held);
          if (held > 2) failure ??= new Error(`regression held ${held} ordinary slot leases`);
          writeFileSync(join(probes, name.replace(/\.held$/, '.release')), 'release');
          released.add(name);
        }
        if (Date.now() >= deadline) { failure ??= new Error('regression shard slot probes timed out'); break; }
        await Bun.sleep(2);
      }
      await run;
      if (failure) throw failure;
      expect(result?.status).toBe('passed');
      expect(maximumLeases).toBe(2);
      expect(released.size).toBeGreaterThan(2);
    } finally {
      for (const name of readdirSync(probes).filter(name => name.endsWith('.held'))) {
        writeFileSync(join(probes, name.replace(/\.held$/, '.release')), 'release');
      }
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      r.cleanup();
    }
  }, 35_000);

  test('integration batch selection bounds costly fixture groups to five files without changing owner or fault widths', async () => {
    const r = repo(19);
    try {
      const result = await r.run({ runId: 'integration-width', only: ['unit', 'owner'], integrationBatches: 3 });
      const integration = result.batches.filter(batch => batch.tier === 'integration');
      expect(integration.map(batch => batch.files.length)).toEqual([5, 5, 5]);
      expect(result.files.filter(file => file.tier === 'integration' && file.outcome === 'passed')).toHaveLength(15);
      expect(result.files.filter(file => file.tier === 'integration' && file.outcome === 'deferred')).toHaveLength(5);
      expect(result.partial).toBe(true);
      expect((await r.run({ resume: 'integration-width' })).batches.filter(batch => batch.tier === 'integration')
        .map(batch => batch.files.length)).toEqual([5, 5, 5]);
    } finally { r.cleanup(); }
  });

  test('concurrent lanes read only their own QA artifacts', async () => {
    const r = repo(5);
    let arrived = 0;
    let release: (() => void) | undefined;
    const both = new Promise<void>(done => { release = done; });
    const evidence = new Map<string, string>();
    try {
      const result = await r.run({ runId: 'lane-artifacts', slots: 2, only: ['integration'], runner: async (checkout, batch, directory, shards, slotLimit, artifactRoot) => {
        if (batch.tier !== 'integration' || !directory.endsWith('/attempt-1')) return r.runner(checkout, batch, directory, shards, slotLimit);
        const root = artifactRoot!;
        const own = join(root, 'run');
        mkdirSync(join(own, 'logs'), { recursive: true });
        const file = batch.files[0]!;
        writeFileSync(join(own, 'integration.xml'), `<testcase file="${file}" name="fail-${batch.id}"><failure>no</failure></testcase>`);
        writeFileSync(join(own, 'logs', 'integration.log'), `evidence-${batch.id}`);
        const poison = join(r.options.stateDir, 'regress/lane-artifacts/qa/other-lane');
        mkdirSync(join(poison, 'logs'), { recursive: true });
        writeFileSync(join(poison, 'integration.xml'), `<testcase file="${file}" name="foreign-failure"><failure>no</failure></testcase>`);
        writeFileSync(join(poison, 'logs', 'integration.log'), 'foreign-evidence');
        writeFileSync(join(poison, 'acceptance.json'), JSON.stringify({ isolation: [{ file, status: 'order-dependent' }] }));
        if (++arrived === 2) release!(); else await both;
        expect(regressionBatchArtifactPaths([], root)).toEqual([]);
        const paths = regressionBatchArtifactPaths([own], root);
        expect(regressionBatchArtifactPaths([own, poison], root)).toEqual([own]);
        const tests = paths.flatMap(path => existsSync(join(path, 'integration.xml'))
          ? parseJUnit(readFileSync(join(path, 'integration.xml'), 'utf8'), 'integration') : []);
        const logs = paths.flatMap(path => {
          const logDir = join(path, 'logs');
          return existsSync(logDir) ? readdirSync(logDir).map(name => readFileSync(join(logDir, name), 'utf8')) : [];
        });
        const found = logs.join('\n');
        evidence.set(batch.id, found);
        return { code: 1, outcomes: Object.fromEntries(batch.files.map(item => [item, item === file ? 'failed' as const : 'passed' as const])),
          artifactPaths: [directory, ...paths], queueMs: 1, testMs: 1, totalMs: 2, evidence: found,
          failingTests: tests.filter(test => test.failed).map(test => `${test.file}: ${test.name}`) };
      }});
      const lanes = result.batches.filter(batch => batch.tier === 'integration');
      expect(lanes).toHaveLength(2);
      expect(arrived).toBe(2);
      expect(result.diagnoses.length).toBeGreaterThan(0);
      for (const batch of lanes) {
        const attempt = batch.attempts[0]!;
        expect(attempt.failingTests).toEqual([`${batch.files[0]}: fail-${batch.id}`]);
        expect(evidence.get(batch.id)).toBe(`evidence-${batch.id}`);
        expect(attempt.artifactPaths?.some(path => path.includes('other-lane'))).toBe(false);
        expect(attempt.artifactPaths).toContain(join(r.options.stateDir, 'regress/lane-artifacts/qa', batch.id, 'attempt-1', 'run'));
      }
      for (const diagnosis of result.diagnoses) {
        expect(diagnosis.artifactPaths.some(path => path.includes('other-lane'))).toBe(false);
        const lane = lanes.find(batch => diagnosis.artifactPaths.some(path => path.includes(`/${batch.id}/`)));
        expect(lane).toBeDefined();
        expect(diagnosis.artifactPaths.every(path => !lanes.some(batch => batch !== lane && path.includes(`/${batch.id}/`)))).toBe(true);
      }
    } finally { release?.(); r.cleanup(); }
  });

  test('withSlot lists the override root and runBatch reads its junit', async () => {
    const r = repo();
    const file = r.files.find(item => item.tier === 'integration')!.file;
    const resolver = join(import.meta.dir, '../qa/core.ts');
    r.commit({ 'scripts/qa/test.ts': `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newRunId, qaArtifactDirectory } from ${JSON.stringify(resolver)};
const directory = join(qaArtifactDirectory(process.cwd()), newRunId());
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'integration.xml'), '<testcase file="${file}" name="listed"></testcase>');
process.exit(0);
` });
    try {
      const result = await r.run({ runId: 'slot-listing', only: ['integration'], runner: async (checkout, batch, directory, shards, slotLimit, artifactRoot) => {
        if (batch.tier !== 'integration') return r.runner(checkout, batch, directory, shards, slotLimit, artifactRoot);
        return runBatch(checkout, batch, directory, shards, slotLimit, artifactRoot);
      } });
      const attempt = result.batches.find(batch => batch.id === 'integration-1')!.attempts[0]!;
      const slot = JSON.parse(readFileSync(join(r.options.stateDir, 'regress/slot-listing/integration-1/attempt-1/slot.json'), 'utf8')) as { artifactPaths: string[] };
      const batchRoot = join(r.options.stateDir, 'regress/slot-listing/qa/integration-1/attempt-1');
      expect(slot.artifactPaths).toHaveLength(1);
      expect(slot.artifactPaths[0]!.startsWith(`${batchRoot}/`)).toBe(true);
      expect(attempt.artifactPaths).toContain(slot.artifactPaths[0]);
      expect(readFileSync(join(slot.artifactPaths[0]!, 'integration.xml'), 'utf8')).toContain('name="listed"');
      expect(result.files.find(item => item.file === file)!.outcome).toBe('passed');
    } finally { r.cleanup(); }
  }, 60_000);

  test('a stale run directory in the label root is ignored', () => {
    const root = mkdtempSync(join(regressionCheckoutRoot(import.meta.dir, join(import.meta.dir, '../../.temp/r')), 'label-'));
    try {
      const stale = join(root, '20261010t000000-stale');
      mkdirSync(join(stale, 'logs'), { recursive: true });
      writeFileSync(join(stale, 'integration.xml'), '<testcase file="tests/qa/integration/example.test.ts" name="stale-failure"><failure>no</failure></testcase>');
      writeFileSync(join(stale, 'logs', 'integration.log'), 'stale-evidence');
      expect(regressionBatchArtifactPaths([], root)).toEqual([]);
      expect(readFileSync(join(stale, 'logs/integration.log'), 'utf8')).toBe('stale-evidence');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an old checkout’s QA artifacts move into the run directory before the checkout is removed', async () => {
    const r = repo();
    let source = '';
    const artifactId = '20261010t000000-abcdef';
    try {
      const result = await r.run({ runId: 'old-artifacts', only: ['integration'], runner: async (checkout, batch, directory, shards, slotLimit, artifactRoot) => {
        if (batch.tier !== 'integration' || !directory.endsWith('/attempt-1')) return r.runner(checkout, batch, directory, shards, slotLimit);
        source = checkout;
        const written = join(checkout, '.artifacts/qa', artifactId);
        mkdirSync(join(written, 'logs'), { recursive: true });
        const file = batch.files[0]!;
        writeFileSync(join(written, 'integration.xml'), `<testcase file="${file}" name="old-failure"><failure>no</failure></testcase>`);
        writeFileSync(join(written, 'logs', 'integration.log'), 'old-evidence');
        const paths = regressionBatchArtifactPaths([written], artifactRoot);
        const kept = join(artifactRoot!, artifactId);
        expect(paths).toEqual([kept]);
        expect(existsSync(written)).toBe(false);
        const tests = parseJUnit(readFileSync(join(kept, 'integration.xml'), 'utf8'), 'integration');
        return { code: 1, outcomes: Object.fromEntries(batch.files.map(item => [item, item === file ? 'failed' as const : 'passed' as const])),
          artifactPaths: [directory, ...paths], queueMs: 1, testMs: 1, totalMs: 2,
          evidence: readFileSync(join(kept, 'logs', 'integration.log'), 'utf8'),
          failingTests: tests.filter(test => test.failed).map(test => `${test.file}: ${test.name}`) };
      }});
      const attempt = result.batches.find(batch => batch.id === 'integration-1')!.attempts[0]!;
      expect(attempt.failingTests).toEqual([`${result.batches.find(batch => batch.id === 'integration-1')!.files[0]}: old-failure`]);
      const kept = join(r.options.stateDir, 'regress/old-artifacts/qa/integration-1/attempt-1', artifactId);
      expect(attempt.artifactPaths).toContain(kept);
      expect(result.diagnoses.some(diagnosis => diagnosis.artifactPaths.includes(kept))).toBe(true);
      expect(existsSync(join(kept, 'logs/integration.log'))).toBe(true);
      expect(readFileSync(join(kept, 'logs/integration.log'), 'utf8')).toBe('old-evidence');
      expect(existsSync(source)).toBe(false);
    } finally { r.cleanup(); }
  });

  test('a failed lane waits for concurrent children to settle and resume retains their passes', async () => {
    const r = repo(60);
    let started = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>(done => { release = done; });
    let heldBatch = '';
    try {
      const run = r.run({ runId: 'lane-stop', slots: 2, runner: async (...args) => {
        if (args[1].tier === 'unit' || args[1].tier === 'model' || args[1].tier === 'jena:check') return r.runner(...args);
        started++;
        if (started === 1) { await Bun.sleep(1); throw new Error('lane interrupted'); }
        heldBatch = args[1].id; await held;
        return r.runner(...args);
      } });
      await Bun.sleep(20);
      expect(started).toBe(2);
      expect(existsSync(join(r.options.stateDir, 'regress/lane-stop/lock'))).toBe(true);
      release!();
      await expect(run).rejects.toThrow('lane interrupted');
      expect(r.manifest('lane-stop').batches.find(batch => batch.id === heldBatch)!.state).toBe('done');
      r.calls.length = 0;
      const resumed = await r.run({ resume: 'lane-stop', slots: 2 });
      expect(resumed.status).toBe('passed');
      expect(r.calls.some(call => call.batch.id === heldBatch)).toBe(false);
    } finally { release!(); r.cleanup(); }
  });

  test('only browser batches yield until a queued heavy run finishes without changing the pinned commit', async () => {
    const r = repo();
    const lock = join(r.options.stateDir, 'qa-slots', 'heavy');
    const queue = join(r.options.stateDir, 'qa-slots', 'heavy-queue');
    let turns = 0;
    let polls = 0;
    const messages: string[] = [];
    try {
      const result = await r.run({ runId: 'yield', only: ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'e2e', 'accounts:storybook'], waitForTurn: async (lockDir, interrupted) => {
        expect(lockDir).toBeUndefined();
        turns++;
        await waitForRegressionTurn(lock, interrupted, { announce: message => messages.push(message), sleep: async () => {
          polls++;
          expect(r.calls.filter(call => call.batch.tier === 'e2e')).toHaveLength(1);
          if (polls === 1) {
            rmSync(join(queue, 'gate.json'));
            mkdirSync(lock);
            writeFileSync(join(lock, 'identity.json'), JSON.stringify({ pid: process.pid, token: 'heavy-token',
              goal: 'owner', command: 'merge gate', startedAt: new Date().toISOString() }));
            writeFileSync(join(lock, 'pid'), String(process.pid));
            r.commit({ [r.unit]: 'fail\n' });
          } else rmSync(lock, { recursive: true });
        } });
      }, runner: async (...args) => {
        if (args[1].tier === 'e2e' || args[1].tier === 'accounts:storybook') {
          expect(turns).toBe(r.calls.filter(call => call.batch.tier === 'e2e' || call.batch.tier === 'accounts:storybook').length + 1);
        } else expect(turns).toBe(0);
        const result = await r.runner(...args);
        if (args[1].tier === 'e2e') {
          mkdirSync(queue, { recursive: true });
          writeFileSync(join(queue, 'gate.json'), JSON.stringify({ pid: process.pid, command: 'merge gate', arrivedAt: 1 }));
        }
        return result;
      } });
      expect(polls).toBe(2);
      expect(turns).toBe(2);
      expect(messages).toEqual(['Regression yielding to heavy QA: free; 1 waiting']);
      expect(result.atCommit).toBe(r.base);
      expect(r.git('rev-parse', 'main')).not.toBe(r.base);
      expect(new Set(r.calls.map(call => call.commit))).toEqual(new Set([r.base]));
      expect(result.status).toBe('passed');
    } finally { r.cleanup(); }
  });

  test('interrupting a yield resumes unfinished batches at the original pinned commit', async () => {
    const r = repo();
    try {
      await expect(r.run({ runId: 'yield-resume', only: ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'e2e', 'accounts:storybook'], waitForTurn: async (_lockDir, interrupted) => {
        if (r.calls.some(call => call.batch.tier === 'e2e')) {
          await waitForRegressionTurn('', interrupted, { status: () => 'free; 1 waiting', announce: () => {},
            sleep: async () => { throw new Error('interrupted while yielding'); } });
        }
      } })).rejects.toThrow('interrupted while yielding');
      expect(r.manifest('yield-resume').batches[0]!.state).toBe('done');
      expect(r.manifest('yield-resume').batches.find(batch => batch.tier === 'accounts:storybook')!.attempts).toHaveLength(0);
      r.commit({ [r.unit]: 'fail\n' });
      r.calls.length = 0;
      let turns = 0;
      const resumed = await r.run({ resume: 'yield-resume', waitForTurn: async () => { turns++; } });
      expect(resumed.status).toBe('passed');
      expect(resumed.atCommit).toBe(r.base);
      expect(turns).toBe(1);
      expect(r.calls.some(call => call.batch.tier === 'unit')).toBe(false);
      expect(r.calls.some(call => call.batch.tier === 'e2e')).toBe(false);
      expect(new Set(r.calls.map(call => call.commit))).toEqual(new Set([r.base]));
    } finally { r.cleanup(); }
  });

  test('diagnostic probes and infrastructure retries also yield before taking a heavy turn', async () => {
    const r = repo();
    try {
      const browser = 'apps/web/tests/example.e2e.ts';
      r.commit({ [browser]: 'fail\n' });
      let turns = 0;
      let unavailable = true;
      const result = await r.run({ runId: 'yield-probes', only: ['e2e'], waitForTurn: async () => { turns++; }, runner: async (...args) => {
        if (args[1].tier === 'jena:check') return r.runner(...args);
        expect(turns).toBe(r.calls.filter(call => call.batch.tier === 'e2e').length + 1);
        const result = await r.runner(...args);
        if (unavailable) { unavailable = false; return { ...result, code: 1, classification: 'infrastructure' }; }
        return result;
      } });
      expect(result.batches[0]!.attempts).toHaveLength(2);
      expect(r.calls.some(call => call.directory.includes('/probes/'))).toBe(true);
      expect(r.calls.some(call => call.directory.endsWith('/confirm'))).toBe(true);
      expect(turns).toBe(r.calls.filter(call => call.batch.tier === 'e2e').length);
    } finally { r.cleanup(); }
  });

  test('merges landing mid-run do not change the pinned SHA', async () => {
    const r = repo();
    try {
      let landed = false;
      const result = await r.run({ runId: 'pin', runner: async (...args) => {
        if (!landed) { landed = true; r.commit({ [r.unit]: 'fail\n' }); }
        return r.runner(...args);
      } });
      expect(result.atCommit).toBe(r.base);
      expect(r.git('rev-parse', 'main')).not.toBe(r.base);
      expect(new Set(r.calls.map(call => call.commit))).toEqual(new Set([r.base]));
      expect(result.status).toBe('passed');
    } finally { r.cleanup(); }
  });

  test('preflight never falls back to an ancestor Taskfile and executes only the committed Taskfile', async () => {
    const r = repo();
    const marker = join(r.options.stateDir, 'task-marker.log');
    const taskfile = (label: string) => `version: '3'\ntasks:\n  install:\n    cmds: ['echo ${label}', 'echo ${label} >> ${marker}']\n  gen:check:\n    cmds: ['echo ${label}', 'echo ${label} >> ${marker}']\n`;
    try {
      r.write('Taskfile.yml', taskfile('ancestor-task-used'));
      const unsupported = await r.run({ runId: 'no-taskfile', prepare: undefined });
      expect(unsupported.preflight.ok).toBe(false);
      expect(unsupported.preflight.artifactPaths).toHaveLength(0);
      expect(unsupported.status).toBe('failed');
      r.write('Taskfile.yml', taskfile('pinned-task-used')); r.commit();
      r.write('Taskfile.yml', taskfile('ancestor-task-used'));
      const supported = await r.run({ runId: 'pinned-taskfile', prepare: undefined });
      expect(supported.status).toBe('passed');
      expect(supported.preflight.artifactPaths).toHaveLength(2);
      const recorded = readFileSync(marker, 'utf8');
      expect(recorded).toContain('pinned-task-used');
      expect(recorded).not.toContain('ancestor-task-used');
    } finally { r.cleanup(); }
  });

  test('the harness manifest includes gate and subdirectory files, browser stories and explicit exclusions', async () => {
    const r = repo(1);
    try {
      r.write('scripts/qa/acceptance.ts', `export const unitHarnessFiles = ['tests/qa/harness.test.ts'];
export const legacyHostJenaGateFiles = ['services/main/tests/legacy.integration.test.ts'];
export const testExclusions = [
 { file: 'apps/about/tests/example.test.ts', reason: 'About owns its check' },
 { file: 'apps/web/tests/shared-browser.test.ts', reason: 'Live shared stack fixture' }
];
export function testArgs(tier) { return tier === 'owner' ? ['scripts/ops/tests/example.test.ts'] : tier === 'model' ? ['model/tests'] : tier === 'integration'
? ['tests/qa/integration', 'services/main/tests/gate.integration.test.ts'] : [tier === 'fault/recovery' ? 'tests/qa/fault-recovery' : 'tests/qa/' + tier]; }
`);
      r.write('scripts/qa/core.ts', `export { expandTestPaths, splitTestArgs } from ${JSON.stringify(join(import.meta.dir, '../qa/core.ts'))};\n`);
      r.write('scripts/ops/tests/example.test.ts', '');
      r.write('services/main/tests/gate.integration.test.ts', ''); r.write('tests/qa/harness.test.ts', '');
      r.write('tests/qa/load/example.test.ts', ''); r.write('tests/live/example.test.ts', '');
      r.write('packages/ui/src/example.stories.tsx', '');
      r.write('apps/web/.storybook/main.ts', "const config = { stories: ['../features/**/*.stories.@(ts|tsx)', '../../../packages/ui/src/**/*.stories.@(ts|tsx)'] };\n");
      r.write('apps/accounts/.storybook/main.ts', "const config = { stories: ['../features/**/*.stories.@(ts|tsx)'] };\n");
      const files = await regressionRegistry(r.dir);
      expect(files).toContainEqual({ file: 'scripts/qa/jena-cli.ts', tier: 'jena:check', outcome: 'pending' });
      expect(files).toContainEqual({ file: 'scripts/ops/tests/example.test.ts', tier: 'owner', outcome: 'pending' });
      expect(files).toContainEqual({ file: 'services/main/tests/gate.integration.test.ts', tier: 'integration', outcome: 'pending' });
      expect(files).toContainEqual({ file: 'tests/qa/integration/subdir/extra-0.test.ts', tier: 'integration', outcome: 'pending' });
      expect(files).toContainEqual({ file: 'packages/ui/src/example.stories.tsx', tier: 'e2e', outcome: 'pending' });
      expect(files.filter(file => file.outcome === 'excluded').map(file => file.tier).sort()).toEqual(['external', 'legacy', 'live', 'live', 'load']);
    } finally { r.cleanup(); }
  });

  test('a fast-forward merge event is found and attributed with both boundaries verified', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      const after = r.commit({ [r.unit]: 'fail\n' }); r.event(r.base, after);
      expect(r.git('log', '--merges', '--format=%H')).toBe('');
      const result = await r.run({ runId: 'regression' });
      expect(result.diagnoses).toHaveLength(1);
      expect(result.diagnoses[0]).toMatchObject({ status: 'attributed', before: r.base, after, goal: 'owner', taskIds: ['G-001', 'G-002'] });
      expect(result.diagnoses[0]!.probes.slice(-2)).toEqual([{ commit: r.base, outcome: 'passed' }, { commit: after, outcome: 'failed' }]);
      const probes = r.calls.filter(call => call.directory.includes('/probes/'));
      expect(probes.every(call => call.checkout !== result.checkout)).toBe(true);
      expect(new Set(probes.map(call => call.checkout)).size).toBe(probes.length);
      expect(inboxEntries(r.options.stateDir, 'owner')).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test('unrecorded manager edits remain in the suspect range and never go to the nearest task', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      const task = r.commit(); r.event(r.base, task);
      const edit = r.commit({ [r.unit]: 'fail\n' });
      const result = await r.run({ runId: 'gap' });
      expect(result.diagnoses[0]).toMatchObject({ status: 'inconclusive', before: task, after: edit });
      expect(result.diagnoses[0]!.goal).toBeUndefined();
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(1);
      expect(inboxEntries(r.options.stateDir, 'owner')).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('distinct paths cannot collide in probe worktrees or overwrite each other’s artifacts', async () => {
    const r = repo();
    try {
      const files = ['tests/qa/unit/sub/entry.test.ts', 'tests/qa/unit/sub-entry.test.ts'];
      for (const file of files) { r.write(file, 'pass\n'); r.files.push({ file, tier: 'unit', outcome: 'pending' }); }
      const base = r.commit();
      await r.run({ runId: 'base' });
      const after = r.commit(Object.fromEntries(files.map(file => [file, 'fail\n']))); r.event(base, after);
      const result = await r.run({ runId: 'paths' });
      expect(result.diagnoses.every(diagnosis => diagnosis.status === 'attributed')).toBe(true);
      const probes = r.calls.filter(call => call.directory.includes('/probes/'));
      expect(new Set(probes.map(call => call.checkout)).size).toBe(probes.length);
    } finally { r.cleanup(); }
  });

  test('a failure present at the base is inherited', async () => {
    const r = repo();
    try {
      r.git('checkout', '--orphan', 'replacement');
      r.commit({ [r.unit]: 'fail\n' }); r.git('branch', '-M', 'main');
      const result = await r.run({ runId: 'inherited' });
      expect(result.diagnoses[0]).toMatchObject({ status: 'inherited', classification: 'deterministic' });
    } finally { r.cleanup(); }
  });

  test('a missing file or unavailable build at a probe is unavailable', async () => {
    for (const missing of [true, false]) {
      const r = repo();
      try {
        if (missing) { r.git('checkout', '--orphan', 'replacement'); r.commit({ [r.unit]: null }); r.git('branch', '-M', 'main'); }
        const base = r.git('rev-parse', 'HEAD');
        const after = r.commit({ [r.unit]: 'fail\n' }); r.event(base, after);
        const result = await r.run({ runId: 'unavailable', prepare: async checkout => ({
          ok: missing || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim() !== base,
          artifactPaths: [], reason: 'build unavailable' }) });
        expect(result.diagnoses[0]!.status).toBe('unavailable');
        expect(result.status).not.toBe('passed');
      } finally { r.cleanup(); }
    }
  });

  test('a flip-flopping probe is inconclusive and never exceeds eight probes', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      const after = r.commit({ [r.unit]: 'fail\n' }); r.event(r.base, after);
      let probes = 0;
      const result = await r.run({ runId: 'flip', runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[2].includes('/probes/') && r.calls.at(-1)!.commit === r.base && ++probes > 1) {
          result.outcomes[r.unit] = 'failed'; result.code = 1;
        }
        return result;
      } });
      expect(result.diagnoses[0]!.status).toBe('inconclusive');
      expect(result.diagnoses[0]!.probes.length).toBeLessThanOrEqual(8);
      expect(result.diagnoses[0]!.reason).toContain('Conflicting');
    } finally { r.cleanup(); }
  });

  test('the probe budget reports a suspect range rather than guessing a culprit', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      let previous = r.base;
      for (let index = 0; index < 130; index++) {
        const next = r.commit({ [r.unit]: index >= 70 ? 'fail\n' : 'pass\n' }); r.event(previous, next); previous = next;
      }
      await expect(r.run({ runId: 'budget', runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[2].includes('/probes/') && args[2].endsWith('-8')) throw new Error('Interrupted final probe');
        return result;
      } })).rejects.toThrow('Interrupted final probe');
      const result = await r.run({ resume: 'budget' });
      expect(result.diagnoses[0]!.status).toBe('inconclusive');
      expect(result.probeCounts![r.unit]).toBe(8);
      expect(r.calls.filter(call => call.directory.includes('/probes/'))).toHaveLength(8);
      expect(result.diagnoses[0]!.reason).toContain('budget');
      expect(result.diagnoses[0]!.goal).toBeUndefined();
    } finally { r.cleanup(); }
  }, 30_000);

  test('infrastructure failures are void and re-queued; resume runs only unfinished batches', async () => {
    const r = repo(30);
    try {
      let engineDown = true;
      const runner: RegressionOptions['runner'] = async (...args) => {
        const result = await r.runner(...args);
        if (engineDown && args[1].id === 'integration-2') return { ...result, code: 1, classification: 'infrastructure', evidence: 'Cannot connect to the Docker daemon' };
        return result;
      };
      const first = await r.run({ runId: 'infra', runner });
      expect(first.status).toBe('incomplete');
      expect(first.batches.find(batch => batch.id === 'integration-2')!.attempts).toHaveLength(2);
      expect(first.files.some(file => file.outcome === 'void')).toBe(true);
      expect(inboxEntries(r.options.stateDir, 'program')).toEqual([expect.objectContaining({ classification: 'infrastructure',
        runEvent: { batchId: 'integration-2', tier: 'integration', fileCount: 5, cause: 'Cannot connect to the Docker daemon' } })]);
      await r.run({ resume: 'infra', runner });
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(1);
      const completed = first.batches.filter(batch => batch.state === 'done').map(batch => batch.id);
      r.calls.length = 0; engineDown = false;
      const resumed = await r.run({ resume: 'infra', runner });
      expect(resumed.status).toBe('passed');
      expect(r.calls.every(call => !completed.includes(call.batch.id))).toBe(true);
      expect(r.calls).toHaveLength(1);
      expect(resumed.batches.filter(batch => batch.tier === 'integration').every(batch => batch.files.length <= 5)).toBe(true);
    } finally { r.cleanup(); }
  });

  test('an interrupted run resumes without repeating finished batches', async () => {
    const r = repo();
    try {
      await expect(r.run({ runId: 'interrupted', runner: async (...args) => {
        if (args[1].tier === 'model') throw new Error('interrupted');
        return r.runner(...args);
      } })).rejects.toThrow('interrupted');
      expect(r.manifest('interrupted').batches[0]!.state).toBe('done');
      r.calls.length = 0;
      expect((await r.run({ resume: 'interrupted' })).status).toBe('passed');
      expect(r.calls.some(call => call.batch.tier === 'unit')).toBe(false);
    } finally { r.cleanup(); }
  });

  test('resume voids PostgreSQL failures from an old long checkout path and retains verified passes', async () => {
    const r = repo();
    try {
      await expect(r.run({ runId: 'old-layout', runner: async (...args) => {
        if (args[1].tier === 'fault/recovery') throw new Error('interrupted');
        const result = await r.runner(...args);
        if (args[1].tier === 'integration') return { ...result, code: 1, evidence: 'pg_ctl -k checkout/.temp/pg-sock failed',
          outcomes: Object.fromEntries(args[1].files.map(file => [file, 'failed'])) as Execution['outcomes'] };
        return result;
      } })).rejects.toThrow('interrupted');
      const old = r.manifest('old-layout'); old.checkout = `/tmp/${'long'.repeat(40)}`;
      old.batches.find(batch => batch.tier === 'integration')!.attempts[0]!.evidence = 'pg_ctl -k checkout/.temp/pg-sock failed';
      writeFileSync(join(r.options.stateDir, 'regress/old-layout/manifest.json'), JSON.stringify(old));
      r.calls.length = 0;
      const result = await r.run({ resume: 'old-layout', runner: async (...args) => {
        expect(r.manifest('old-layout').batches.filter(batch => batch.state === 'running')).toHaveLength(1);
        return r.runner(...args);
      } });
      expect(result.status).toBe('passed');
      expect(result.batches.find(batch => batch.tier === 'integration')!.attempts[0]!.classification).toBe('infrastructure');
      expect(r.calls.some(call => call.batch.tier === 'unit' || call.batch.tier === 'model')).toBe(false);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('a stop during installation resumes the original SHA even after main advances', async () => {
    const r = repo();
    try {
      await expect(r.run({ runId: 'startup', prepare: async () => { throw new Error('installation interrupted'); } })).rejects.toThrow('interrupted');
      expect(r.manifest('startup').atCommit).toBe(r.base);
      r.commit({ [r.unit]: 'fail\n' });
      const resumed = await r.run({ resume: 'startup' });
      expect(resumed.atCommit).toBe(r.base);
      expect(resumed.status).toBe('passed');
    } finally { r.cleanup(); }
  });

  test('incomplete, zero-match, missing-data and restricted manifests are never green', async () => {
    const r = repo();
    try {
      const result = await r.run({ runId: 'missing', runner: async (...args) => ({ ...await r.runner(...args), outcomes: {} }) });
      expect(result.status).toBe('incomplete');
      const manifest = r.manifest('missing'); manifest.files.pop();
      writeFileSync(join(r.options.stateDir, 'regress/missing/manifest.json'), JSON.stringify(manifest));
      await expect(r.run({ resume: 'missing' })).rejects.toThrow('Incomplete');
      await expect(r.run({ runId: 'zero', registry: async () => [] })).rejects.toThrow('Zero-match');
      const restricted = await r.run({ runId: 'restricted', only: ['unit', 'model'], integrationBatches: 0 });
      expect(restricted.status).toBe('incomplete');
      expect(restricted.files.some(file => file.outcome === 'deferred')).toBe(true);
      const plan = r.manifest('restricted'); plan.batches.pop();
      writeFileSync(join(r.options.stateDir, 'regress/restricted/manifest.json'), JSON.stringify(plan));
      await expect(r.run({ resume: 'restricted' })).rejects.toThrow('batch plan');
    } finally { r.cleanup(); }
  });

  test('resume accepts registry exclusions but cannot hide a removed batch or lose an exclusion reason', async () => {
    const r = repo();
    try {
      r.files.push({ tier: 'live', file: 'tests/qa/live/engine.test.ts', outcome: 'excluded', reason: 'Opt-in live engine gate' });
      expect((await r.run({ runId: 'exclusions' })).status).toBe('passed');
      r.calls.length = 0;
      expect((await r.run({ resume: 'exclusions' })).status).toBe('passed');
      const path = join(r.options.stateDir, 'regress/exclusions/manifest.json');
      const recorded = readFileSync(path, 'utf8');
      const hidden = JSON.parse(recorded) as Manifest;
      hidden.files.find(file => file.file === r.unit)!.outcome = 'excluded';
      hidden.batches = hidden.batches.filter(batch => batch.tier !== 'unit');
      writeFileSync(path, JSON.stringify(hidden));
      await expect(r.run({ resume: 'exclusions' })).rejects.toThrow('exclusions');
      const missingReason = JSON.parse(recorded) as Manifest;
      missingReason.files.find(file => file.tier === 'live')!.reason = undefined;
      writeFileSync(path, JSON.stringify(missingReason));
      await expect(r.run({ resume: 'exclusions' })).rejects.toThrow('exclusions');
      expect(r.calls).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('flaky, order-dependent, deadline and resource outcomes stay distinct', async () => {
    for (const classification of ['flaky', 'order-dependent', 'deadline', 'resource'] as const) {
      const r = repo();
      try {
        r.commit({ [r.unit]: 'fail\n' });
        const result = await r.run({ runId: classification, runner: async (...args) => {
          const result = await r.runner(...args);
          if (args[1].files.includes(r.unit) && ((classification === 'flaky' && args[2].endsWith('/confirm'))
            || (classification === 'order-dependent' && args[2].includes('/alone-')))) {
            result.outcomes[r.unit] = 'passed'; result.code = 0;
          }
          if (classification === 'resource' || classification === 'deadline') {
            result.classification = classification; result.failingTests = [`${r.unit}: failed assertion`];
          }
          return result;
        } });
        expect(result.diagnoses[0]!.classification).toBe(classification);
        expect(result.diagnoses[0]!.status).toBe('inconclusive');
      } finally { r.cleanup(); }
    }
  });

  test('a runner failure with passing files is unavailable rather than assigned to an arbitrary file', async () => {
    const r = repo();
    try {
      const result = await r.run({ runId: 'runner', runner: async (...args) => ({ ...await r.runner(...args),
        code: args[1].tier === 'unit' ? 1 : 0 }) });
      expect(result.status).not.toBe('passed');
      expect(result.diagnoses[0]).toMatchObject({ file: 'batch:unit-1', status: 'unavailable' });
      expect(result.diagnoses[0]!.classification).not.toBe('flaky');
    } finally { r.cleanup(); }
  });

  test('a failure that still fails in the closest earlier run is inherited without probes', async () => {
    const r = repo();
    const failing = 'tests/qa/unit/still-failing.test.ts';
    try {
      r.files.push({ file: failing, tier: 'unit', outcome: 'pending' });
      r.write(failing, 'pass\n');
      const passedAt = r.commit();
      await r.run({ runId: 'older-pass', at: passedAt, only: ['unit'] });
      r.write(failing, 'fail\n');
      const closerCommit = r.commit();
      r.event(passedAt, closerCommit);
      await r.run({ runId: 'closer', only: ['unit'] });
      const prior = r.manifest('closer').diagnoses.find(item => item.file === failing);
      expect(prior).toMatchObject({ status: 'attributed', goal: 'owner', taskIds: ['G-001', 'G-002'] });
      // A later execution of the older passing commit must not replace the nearer failure.
      await r.run({ runId: 'rewind', at: passedAt, only: ['unit'] });
      r.commit();
      r.calls.length = 0;
      const routed = inboxEntries(r.options.stateDir, 'owner').length;
      expect(routed).toBeGreaterThan(0);
      const result = await r.run({ runId: 'current', only: ['unit'] });
      expect(result.diagnoses.find(item => item.file === failing)).toMatchObject({
        status: 'inherited', probes: [], earlierRunId: 'closer', goal: 'owner', taskIds: ['G-001', 'G-002'],
        earlierDiagnosis: { status: 'attributed', classification: prior!.classification, after: prior!.after, goal: 'owner' },
      });
      // The owner has the failure from the run that first saw it.
      expect(inboxEntries(r.options.stateDir, 'owner')).toHaveLength(routed);
      expect(r.calls.some(call => /\/probes\/|\/alone-|\/confirm/.test(call.directory))).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.finishedAt).toBeDefined();
    } finally { r.cleanup(); }
  }, 60_000);

  test('a new failure is bisected only inside the earlier run and the current commit', async () => {
    const r = repo();
    try {
      const root = r.base;
      const earlierCommit = r.commit();
      await r.run({ runId: 'earlier', at: earlierCommit, only: ['unit'] });
      const broke = r.commit({ [r.unit]: 'fail\n' });
      const head = r.commit();
      r.event(earlierCommit, broke);
      const result = await r.run({ runId: 'current', only: ['unit'] });
      const diagnosis = result.diagnoses.find(item => item.file === r.unit)!;
      const range = new Set([earlierCommit, ...r.git('rev-list', '--first-parent', `${earlierCommit}..${head}`).split('\n').filter(Boolean)]);
      expect(result.atCommit).toBe(head);
      expect(range.has(root)).toBe(false);
      expect(diagnosis.probes.length).toBeGreaterThan(0);
      expect(diagnosis.probes[0]!.commit).toBe(earlierCommit);
      expect(diagnosis.probes.every(probe => range.has(probe.commit))).toBe(true);
      expect(r.calls.filter(call => call.directory.includes('/probes/')).every(call => range.has(call.commit))).toBe(true);
      expect(diagnosis.status).toBe('attributed');
      expect(diagnosis.before).toBe(earlierCommit);
    } finally { r.cleanup(); }
  }, 60_000);

  test('a failure that passed in an earlier run of the same commit is not bisected through older history', async () => {
    const r = repo();
    try {
      const root = r.base;
      const pinned = r.commit();
      let fail = false;
      const runner: RegressionOptions['runner'] = async (...args) => {
        const result = await r.runner(...args);
        if (fail && args[1].tier === 'unit' && args[1].files.includes(r.unit)) {
          result.outcomes[r.unit] = 'failed'; result.code = 1;
        }
        return result;
      };
      await r.run({ runId: 'older', at: root, only: ['unit'], runner });
      await r.run({ runId: 'earlier', at: pinned, only: ['unit'], runner });
      fail = true;
      r.calls.length = 0;
      const result = await r.run({ runId: 'current', at: pinned, only: ['unit'], runner });
      const diagnosis = result.diagnoses.find(item => item.file === r.unit)!;
      expect(result.atCommit).toBe(pinned);
      expect(diagnosis).toMatchObject({ status: 'inconclusive', earlierRunId: 'earlier', probes: [] });
      expect(diagnosis.reason).toContain('earlier');
      expect(r.calls.filter(call => call.directory.includes('/probes/'))).toHaveLength(0);
      expect(r.calls.some(call => call.commit === root && /\/confirm|\/alone-|\/probes\//.test(call.directory))).toBe(false);
      expect(result.finishedAt).toBeDefined();
    } finally { r.cleanup(); }
  }, 60_000);

  test('the diagnosis budget leaves the remaining failures undiagnosed and still finishes the run', async () => {
    const r = repo();
    const still = 'tests/qa/unit/still-failing.test.ts';
    const leftover = 'tests/qa/unit/leftover.test.ts';
    try {
      for (const file of [still, leftover]) r.files.push({ file, tier: 'unit', outcome: 'pending' });
      r.write(still, 'fail\n');
      r.write(leftover, 'pass\n');
      const earlierCommit = r.commit();
      await r.run({ runId: 'earlier', at: earlierCommit, only: ['unit'] });
      r.commit({ [r.unit]: 'fail\n', [still]: 'fail\n', [leftover]: 'fail\n' });
      r.calls.length = 0;
      let clock = 0;
      const result = await r.run({
        runId: 'current', only: ['unit'], diagnosisBudgetMs: 1000, now: () => clock,
        runner: async (...args) => {
          const produced = await r.runner(...args);
          if (args[2].includes('/confirm')) clock = 1000;
          return produced;
        },
      });
      const diagnosis = (file: string) => result.diagnoses.find(item => item.file === file);
      expect(diagnosis(r.unit)!.probes.length).toBeGreaterThan(0);
      expect(diagnosis(still)).toMatchObject({ status: 'inherited', earlierRunId: 'earlier', probes: [] });
      expect(diagnosis(leftover)).toMatchObject({ status: 'undiagnosed', reason: 'budget', probes: [] });
      expect(r.calls.some(call => call.directory.includes('/alone-1') || call.directory.includes('/alone-2'))).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.finishedAt).toBeDefined();
      const summary = readFileSync(join(r.options.stateDir, 'regress', 'current', 'summary.md'), 'utf8');
      expect(summary).toContain('undiagnosed: budget');
      expect(summary).toContain(`Since earlier: ${result.comparison!.new.length} new, ${result.comparison!.inherited.length} inherited, ${result.comparison!.fixed.length} fixed`);
      expect(result.comparison).toEqual({
        earlierRunId: 'earlier', new: [r.unit, leftover].sort((left, right) => left.localeCompare(right)), inherited: [still], fixed: [],
      });
    } finally { r.cleanup(); }
  }, 60_000);

  test('the manifest and the run summary count new, inherited and fixed failures since the earlier run', async () => {
    const r = repo();
    const model = r.files.find(file => file.tier === 'model')!.file;
    const owner = r.files.find(file => file.tier === 'owner')!.file;
    try {
      r.write(r.unit, 'fail\n');
      r.write(model, 'fail\n');
      r.commit();
      await r.run({ runId: 'earlier', only: ['unit', 'model', 'owner'] });
      r.write(model, 'pass\n');
      r.write(owner, 'fail\n');
      r.commit();
      const result = await r.run({ runId: 'current', only: ['unit', 'model', 'owner'] });
      expect(result.comparison).toEqual({ earlierRunId: 'earlier', new: [owner], inherited: [r.unit], fixed: [model] });
      const summary = readFileSync(join(r.options.stateDir, 'regress', 'current', 'summary.md'), 'utf8');
      expect(summary).toContain('Since earlier: 1 new, 1 inherited, 1 fixed');
      expect(summary).toContain(`new: ${owner}`);
      expect(summary).toContain(`inherited: ${r.unit}`);
      expect(summary).toContain(`fixed: ${model}`);
      expect(result.diagnoses.find(item => item.file === r.unit)).toMatchObject({ status: 'inherited', earlierRunId: 'earlier', probes: [] });
      expect(result.status).toBe('failed');
      expect(result.finishedAt).toBeDefined();
    } finally { r.cleanup(); }
  }, 60_000);

  test('stale generated artifacts fail preflight and are reported without regenerating', async () => {
    const r = repo();
    try {
      const result = await r.run({ runId: 'stale', prepare: async () => ({ ok: false,
        artifactPaths: ['generated.log'], reason: 'Generated artifacts are stale' }) });
      expect(result.status).toBe('failed');
      expect(result.diagnoses).toContainEqual(expect.objectContaining({ file: 'preflight', status: 'unavailable' }));
      expect(inboxEntries(r.options.stateDir, 'program')[0]!.artifactPaths).toEqual(['generated.log']);
    } finally { r.cleanup(); }
  });
});

test('diagnosis budget defaults to two hours and rejects a non-integer', () => {
  const previous = process.env.GOAL_REGRESS_DIAGNOSIS_BUDGET_MS;
  try {
    delete process.env.GOAL_REGRESS_DIAGNOSIS_BUDGET_MS;
    expect(regressionDiagnosisBudgetMs()).toBe(2 * 3_600_000);
    expect(regressionDiagnosisBudgetMs('')).toBe(2 * 3_600_000);
    expect(regressionDiagnosisBudgetMs('0')).toBe(0);
    expect(regressionDiagnosisBudgetMs('1500')).toBe(1500);
    expect(() => regressionDiagnosisBudgetMs('nope')).toThrow('GOAL_REGRESS_DIAGNOSIS_BUDGET_MS');
    expect(() => regressionDiagnosisBudgetMs('-1')).toThrow('GOAL_REGRESS_DIAGNOSIS_BUDGET_MS');
  } finally {
    if (previous === undefined) delete process.env.GOAL_REGRESS_DIAGNOSIS_BUDGET_MS;
    else process.env.GOAL_REGRESS_DIAGNOSIS_BUDGET_MS = previous;
  }
});

test('regression yielding stops at its deadline or an interruption', async () => {
  const messages: string[] = [];
  const sleeps: number[] = [];
  let time = 0;
  await expect(waitForRegressionTurn('', () => false, { status: () => 'free; 2 waiting', now: () => time,
    deadline: 1, announce: message => messages.push(message), sleep: async ms => { sleeps.push(ms); time += ms; } }))
    .rejects.toThrow('Regression timed out yielding to heavy QA: free; 2 waiting');
  expect(messages).toEqual(['Regression yielding to heavy QA: free; 2 waiting']);
  expect(sleeps).toEqual([1]);
  let stopped = false;
  await expect(waitForRegressionTurn('', () => stopped, { status: () => 'free; 1 waiting', announce: () => {},
    sleep: async () => { stopped = true; } })).rejects.toThrow('interrupted');
});

test('classification uses engine evidence without treating application ECONNREFUSED as Docker failure', () => {
  expect(classify('connect ECONNREFUSED 127.0.0.1:3001')).toBe('deterministic');
  // A test title is not evidence, this test's own included.
  expect(classify('(pass) classification uses engine evidence without treating application ECONNREFUSED as Docker failure [0.12ms]\n(fail) land > stops [1.00ms]\n 1 fail')).toBe('deterministic');
  for (const log of ['docker engine ECONNREFUSED', 'dial unix /var/run/docker.sock: connect: no such file or directory',
    'failed to connect to the Docker API', 'Error response from daemon: mounts denied',
    'The path /tmp/qa/init.sh is not shared from the host and is not known to Docker.',
    'network pool exhausted', 'Out of memory: Killed process 123 (qemu)']) expect(classify(log)).toBe('infrastructure');
  expect(classify('spawnSync bun ETIMEDOUT')).toBe('deadline');
  expect(classify('No QA slot became free within one hour')).toBe('deadline');
  expect(classify('Memory admission deadline reached; no work started')).toBe('deadline');
  expect(classify('bun reached its run deadline')).toBe('deadline');
  expect(classify('The heavy QA lock stayed held for six hours')).toBe('deadline');
  expect(classify('model failed or exceeded 180s')).toBe('deterministic');
  expect(classify('', 137)).toBe('resource');
});

// Cut from attempt-1 runner.log and logs/unit.log, owner.log or integration.log
// in the pinned regression 20261013t043515-585e9a (d2a2e3166).
for (const [batch, error, expected] of [
  ['unit-8', "SyntaxError: Export named 'readReviewer' not found in module '/home/edge/.cache/rezics-r/686ad1445ceb/3cc9affe6b51db38/apps/web/features/work-page/read.ts'.", 'deterministic'],
  ['unit-8-rest', 'error: The real browse route did not render its browse view', 'deterministic'],
  ['unit-11', 'error: expect(received).toBe(expected)', 'deterministic'],
  ['owner-37', 'bun timed out after 600000 ms of active work', 'deadline'],
  ['integration-6', '  ^ this test timed out after 120000ms.', 'deadline'],
] as const) {
  test(`recorded ${batch} failure uses its own evidence`, () => {
    const evidence = `- Error: unit failed or exceeded 180s (see logs/unit.log)\n${error}\n10月 13 12:07:18 ah-ipv6 kernel: clocksource: Watchdog remote CPU 2 read timed out`;
    expect(classify(evidence)).toBe(expected);
    expect(regressionFailureCause(evidence)).toBe(error.trim());
  });
}

test('the first runtime error determines a non-timeout failure', () => {
  expect(classify('error: Invalid application input\nerror: Cannot connect to the Docker daemon')).toBe('deterministic');
  expect(regressionFailureCause('error: Invalid application input\nerror: Cannot connect to the Docker daemon')).toBe('error: Invalid application input');
  expect(classify('error: Invalid application input\nCommand deadline exceeded')).toBe('deadline');
});

test('classification ignores unexecuted branches in numbered Bun source excerpts', () => {
  const nix = " 99 | if (timedOut) throw new Error('Nix oracle operation timed out');\nerror: Nix oracle pin is unavailable";
  expect(classify(nix)).toBe('deterministic');
  for (const literal of ['cannot connect to the docker daemon', 'heap out of memory', 'deadline exceeded']) {
    expect(classify(` 100 | throw new Error('${literal}');\nerror: Invalid application input`)).toBe('deterministic');
  }
  expect(classify(`${nix}\nerror: Nix oracle operation timed out`)).toBe('deadline');
  expect(classify(nix, 137)).toBe('resource');
});

test('file evidence parses Vitest stories and rejects zero tests and absent data', () => {
  const batch: Batch = { id: 'browser', tier: 'e2e', state: 'pending', attempts: [], files: ['apps/web/features/a.stories.tsx', 'packages/ui/src/a.stories.tsx', 'apps/web/tests/a.e2e.ts'] };
  expect(executionOutcomes('/repo', batch, [], '', ' ✓ |storybook (chromium)| features/a.stories.tsx (2 tests) 10ms\n ❯ |storybook (chromium)| ../../packages/ui/src/a.stories.tsx (2 tests | 1 failed)\n'))
    .toEqual({ 'apps/web/features/a.stories.tsx': 'passed', 'packages/ui/src/a.stories.tsx': 'failed', 'apps/web/tests/a.e2e.ts': 'missing' });
  expect(executionOutcomes('/repo', batch, [], '<testsuite name="features/a.stories.tsx" tests="0" failures="0"></testsuite>')['apps/web/features/a.stories.tsx']).toBe('missing');
});

test('inbox delivery is idempotent, acknowledgements are per line and infrastructure needs a run event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regression-inbox-'));
  try {
    const entry = { runId: 'run', atCommit: 'sha', failingTests: ['a'], after: 'sha', goal: 'program', taskIds: [],
      status: 'inconclusive' as const, classification: 'deterministic' as const, artifactPaths: [] };
    appendInbox(dir, entry); appendInbox(dir, entry); appendInbox(dir, { ...entry, failingTests: ['b'] });
    appendInbox(dir, { ...entry, failingTests: ['infra'], classification: 'infrastructure' });
    expect(inboxEntries(dir, 'program')).toHaveLength(2);
    expect(inboxEntries(dir, 'program', 2).map(entry => entry.acknowledged)).toEqual([false, true]);
    expect(() => inboxEntries(dir, 'program', 3)).toThrow('existing');
    const runEvent = { batchId: 'unit-1', tier: 'unit' as const, fileCount: 15, cause: 'Docker engine unavailable' };
    appendInbox(dir, { ...entry, failingTests: ['batch:unit-1'], classification: 'infrastructure', runEvent });
    appendInbox(dir, { ...entry, failingTests: ['different summary'], classification: 'infrastructure', runEvent: { ...runEvent, cause: 'Still unavailable' } });
    expect(inboxEntries(dir, 'program')).toHaveLength(3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bounded CLI selections preserve the resume configuration', () => {
  expect(parseRegressArgs(['--nightly', '--at', 'main'])).toEqual({ nightly: true, at: 'main' });
  expect(() => parseRegressArgs(['--nightly', '--only', 'e2e'])).toThrow('cannot restrict');
  expect(() => parseRegressArgs(['--nightly', '--integration-batches', '1'])).toThrow('cannot restrict');
  expect(() => parseRegressArgs(['--resume', 'run', '--nightly'])).toThrow('original selection');
  expect(parseRegressArgs(['--at', 'main', '--only', 'unit,model', '--integration-batches', '2']))
    .toEqual({ at: 'main', only: ['unit', 'model'], integrationBatches: 2 });
  expect(() => parseRegressArgs(['--resume', 'run', '--only', 'unit'])).toThrow('original selection');
  expect(() => parseRegressArgs(['--integration-batches', '-1'])).toThrow('Invalid');
  const previous = process.env.REZICS_QA_ARTIFACT_ROOT;
  process.env.REZICS_QA_ARTIFACT_ROOT = '/run/qa';
  try {
    expect(artifactRoots('/checkout')).toContain('/run/qa');
    expect(regressionBatchEnvironment({}, 1, 1, '/run/qa').REZICS_QA_ARTIFACT_ROOT).toBe('/run/qa');
  } finally {
    if (previous === undefined) delete process.env.REZICS_QA_ARTIFACT_ROOT;
    else process.env.REZICS_QA_ARTIFACT_ROOT = previous;
  }
});

test('nightly file evidence requires every selected title exactly once', () => {
  const batch: Batch = { id: 'vertical', tier: 'e2e', files: ['apps/web/tests/media.e2e.ts'], tests: ['anime', 'manga'], state: 'pending', attempts: [] };
  const evidence = (name: string, extra = {}) => ({ file: batch.files[0]!, name, tier: 'e2e' as const, failed: false, skipped: false, ...extra });
  expect(executionOutcomes('/repo', batch, [evidence('anime'), evidence('manga')])[batch.files[0]!]).toBe('passed');
  expect(executionOutcomes('/repo', batch, [evidence('anime')])[batch.files[0]!]).toBe('missing');
  expect(executionOutcomes('/repo', batch, [evidence('anime'), evidence('manga', { skipped: true })])[batch.files[0]!]).toBe('missing');
  expect(executionOutcomes('/repo', batch, [evidence('anime'), evidence('manga', { failed: true })])[batch.files[0]!]).toBe('failed');
  expect(executionOutcomes('/repo', batch, [evidence('anime'), evidence('anime'), evidence('manga')])[batch.files[0]!]).toBe('missing');
  expect(executionOutcomes('/repo', batch, [evidence('anime'), evidence('manga'), evidence('other')])[batch.files[0]!]).toBe('missing');
});

test('only browser and Storybook commands acquire the heavy lock', () => {
  for (const tier of ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'e2e', 'accounts:storybook'] as const) {
    const batch: Batch = { id: tier, tier, files: [tier === 'accounts:storybook' ? 'apps/accounts/example.stories.tsx' : 'tests/example.test.ts'], state: 'pending', attempts: [] };
    const command = regressionBatchCommand(batch, '/tmp/report.json', '/tmp/story.xml');
    expect(command.includes('--heavy')).toBe(tier === 'e2e' || tier === 'accounts:storybook');
    expect(isHeavyTest(command.slice(3))).toBe(tier === 'e2e' || tier === 'accounts:storybook');
    expect(command).toContain('--result-file');
    if (tier === 'accounts:storybook') expect(command).toContain('--reporter=junit');
    else expect(command).toContain('--tier');
  }
});

test('Jena CLI uses exit status while native proofs require executed JUnit cases', () => {
  const batch: Batch = { id: 'jena-check-1', tier: 'jena:check', files: ['scripts/qa/jena-cli.ts'], state: 'pending', attempts: [] };
  expect(regressionBatchCommand(batch, '/disk/report.json', '/disk/stories.xml')).toEqual(['task', 'jena:check']);
  expect(executionOutcomes('/repo', batch, [], '', '', 0)).toEqual({ 'scripts/qa/jena-cli.ts': 'passed' });
  expect(executionOutcomes('/repo', batch, [], '', '', 1)).toEqual({ 'scripts/qa/jena-cli.ts': 'failed' });
  expect(executionOutcomes('/repo', batch, [], '', '', 124)).toEqual({ 'scripts/qa/jena-cli.ts': 'failed' });
  expect(executionOutcomes('/repo', batch, [])).toEqual({ 'scripts/qa/jena-cli.ts': 'missing' });

  const nativeFile = inputSelectedNativeTests[0]!;
  const nativeBatch: Batch = { id: 'native-proof', tier: 'jena:check', files: [nativeFile], state: 'pending', attempts: [] };
  const skipped = parseJUnit(`<testsuite><testcase file="${nativeFile}" name="skipped proof"><skipped/></testcase></testsuite>`, 'owner');
  const zeroTests = parseJUnit(`<testsuite name="${nativeFile}" tests="0" failures="0" skipped="0"></testsuite>`, 'owner');
  const executed = parseJUnit(`<testsuite><testcase file="${nativeFile}" name="proof"/></testsuite>`, 'owner');
  expect(executionOutcomes('/repo', nativeBatch, skipped, '', '', 0)[nativeFile]).toBe('missing');
  expect(executionOutcomes('/repo', nativeBatch, zeroTests, '', '', 0)[nativeFile]).toBe('missing');
  expect(executionOutcomes('/repo', nativeBatch, executed, '', '', 0)[nativeFile]).toBe('passed');
});

test('mixed nightly browser batches request stories through the actual QA parser and retain complete evidence', () => {
  const batch: Batch = { id: 'nightly-browser', tier: 'e2e', state: 'pending', attempts: [], files: [
    'apps/web/tests/journey.e2e.ts', 'apps/web/features/card.stories.tsx', 'packages/ui/src/button.stories.tsx',
  ] };
  const command = regressionBatchCommand(batch, '/disk/report.json', '/disk/stories.xml');
  const args = command.slice(command.indexOf('--tier'));
  const [program, runnerArgs] = selectTestCommand(args);
  expect(program).toBe('bun');
  expect(runnerArgs[0]).toBe('scripts/qa/cli.ts');
  const options = parseArgs(runnerArgs.slice(1));
  expect(options.files).toEqual(['apps/web/tests/journey.e2e.ts']);
  expect(options.storybook).toBe(true);
  const plan = e2eBrowserPlan(options.files ?? [], options.storybook);
  expect(plan).toMatchObject({ selectedFiles: ['apps/web/tests/journey.e2e.ts'], stories: true });
  expect(storybookCommands(plan)).toEqual([
    { name: 'storybook', root: 'apps/web' }, { name: 'accounts-storybook', root: 'apps/accounts' },
  ]);
  expect(executionOutcomes('/repo', batch, [{ file: batch.files[0]!, name: 'journey', tier: 'e2e', failed: false, skipped: false }], '',
    ' ✓ |storybook (chromium)| features/card.stories.tsx (2 tests) 10ms\n ✓ |storybook (chromium)| ../../packages/ui/src/button.stories.tsx (1 test) 10ms\n'))
    .toEqual(Object.fromEntries(batch.files.map(file => [file, 'passed'])));
});

test('journey-only browser subsets keep Storybook skipped', () => {
  const batch: Batch = { id: 'journey-subset', tier: 'e2e', state: 'pending', attempts: [], files: ['apps/web/tests/journey.e2e.ts'] };
  const command = regressionBatchCommand(batch, '/disk/report.json', '/disk/stories.xml');
  expect(command).not.toContain('--storybook');
  const [, runnerArgs] = selectTestCommand(command.slice(command.indexOf('--tier')));
  const options = parseArgs(runnerArgs.slice(1));
  const plan = e2eBrowserPlan(options.files ?? [], options.storybook);
  expect(plan.stories).toBe(false);
  expect(storybookCommands(plan)).toEqual([]);
});

test('detached worktree names leave room for owner PostgreSQL Unix sockets', () => {
  const root = '/home/edge/.cache/rezics-r/example';
  const length = checkoutNameLength(root);
  expect(Buffer.byteLength(join(root, 'a'.repeat(length), '.temp/pg-sock/.s.PGSQL.65535'))).toBeLessThanOrEqual(107);
  expect(() => checkoutNameLength(`/disk/${'a'.repeat(100)}`)).toThrow('GOAL_REGRESS_CHECKOUT_ROOT');
});

test('default checkout cache is independent of a source filesystem and refuses RAM before allocation', () => {
  const r = repo();
  const previous = process.env.GOAL_REGRESS_CHECKOUT_ROOT;
  delete process.env.GOAL_REGRESS_CHECKOUT_ROOT;
  const expected = join(homedir(), '.cache/rezics-r', createHash('sha256').update(realpathSync(r.dir)).digest('hex').slice(0, 12));
  try {
    const probes: string[] = [];
    const probe = (path: string) => {
      probes.push(path);
      return 0x01021994;
    };
    expect(() => regressionCheckoutRoot(r.dir, undefined, probe)).toThrow(expected);
    expect(expected.startsWith(r.dir)).toBe(false);
    expect(probes.some(path => path.startsWith(r.dir))).toBe(false);
    const alias = join(r.dir, '.temp/repo-alias');
    mkdirSync(join(r.dir, '.temp'), { recursive: true }); symlinkSync(r.dir, alias);
    expect(() => regressionCheckoutRoot(alias, undefined, probe)).toThrow(expected);
  } finally {
    if (previous === undefined) delete process.env.GOAL_REGRESS_CHECKOUT_ROOT;
    else process.env.GOAL_REGRESS_CHECKOUT_ROOT = previous;
    r.cleanup();
  }
});

  test('explicit disk cache configuration is canonicalized and still refuses RAM', () => {
    const r = repo();
    const previous = process.env.GOAL_REGRESS_CHECKOUT_ROOT;
    try {
      const target = join(r.options.checkoutRoot!, 'x');
    process.env.GOAL_REGRESS_CHECKOUT_ROOT = target;
    expect(regressionCheckoutRoot(r.dir)).toBe(realpathSync(target));
    expect(() => regressionCheckoutRoot(r.dir, undefined, () => 0x01021994)).toThrow('RAM-backed');
  } finally {
    if (previous === undefined) delete process.env.GOAL_REGRESS_CHECKOUT_ROOT;
    else process.env.GOAL_REGRESS_CHECKOUT_ROOT = previous;
    r.cleanup();
  }
});

test('RAM-backed checkout roots are refused before allocation, including signed magic values and symlinks', () => {
  const r = repo();
  try {
    for (const magic of [0x01021994, 0x858458f6, 0x958458f6, BigInt(0x858458f6), 0x858458f6 | 0]) {
      const target = join(r.dir, '.temp/rejected');
      expect(() => regressionCheckoutRoot(r.dir, target, () => magic)).toThrow('RAM-backed');
      expect(existsSync(target)).toBe(false);
    }
    const target = join(r.dir, '.temp/physical');
    mkdirSync(target, { recursive: true });
    const alias = join(r.dir, '.temp/alias'); symlinkSync(target, alias);
    expect(() => regressionCheckoutRoot(r.dir, alias, path => path === realpathSync(target) ? 0x01021994 : 0xef53))
      .toThrow('RAM-backed');
  } finally { r.cleanup(); }
});

test('socket length counts the physical checkout root behind a short symlink', () => {
  const r = repo();
  try {
    const target = join(r.dir, '.temp', 'deep'.repeat(30));
    mkdirSync(target, { recursive: true });
    const alias = join(r.dir, '.temp/short'); symlinkSync(target, alias);
    expect(() => checkoutNameLength(alias)).toThrow('shorter disk path');
  } finally { r.cleanup(); }
});

test('safe legacy disk checkouts resume without repeating passes or changing their paths', async () => {
  const r = repo();
  try {
    const legacy = r.options.legacyRoot!;
    const first = await r.run({ runId: 'legacy-disk', checkoutRoot: legacy });
    r.calls.length = 0;
    const resumed = await r.run({ resume: 'legacy-disk' });
    expect(resumed.checkout).toBe(first.checkout);
    expect(resumed.status).toBe('passed');
    expect(r.calls).toHaveLength(0);
  } finally { r.cleanup(); }
});

test('RAM-backed legacy checkouts relocate to disk without deleting old trees or repeating passes', async () => {
  const r = repo();
  let probe: ReturnType<typeof spyOn> | undefined;
  try {
    const legacy = r.options.legacyRoot!;
    const first = await r.run({ runId: 'legacy-ram', checkoutRoot: legacy });
    // A finished run has already removed this checkout. Put the tree back so relocation still has one to leave in place.
    expect(existsSync(first.checkout)).toBe(false);
    r.git('worktree', 'add', '--detach', first.checkout, r.base);
    const original = filesystem.statfsSync;
    probe = spyOn(filesystem, 'statfsSync').mockImplementation(((path: Parameters<typeof original>[0], options?: Parameters<typeof original>[1]) => {
      const stat = original(path, options);
      if (String(path).startsWith(legacy)) stat.type = typeof stat.type === 'bigint' ? BigInt(0x01021994) : 0x01021994;
      return stat;
    }) as typeof original);
    r.calls.length = 0;
    const resumed = await r.run({ resume: 'legacy-ram' });
    expect(resumed.checkout.startsWith(realpathSync(r.options.checkoutRoot!) + '/')).toBe(true);
    expect(resumed.checkout).not.toBe(first.checkout);
    expect(existsSync(first.checkout)).toBe(true);
    expect(resumed.status).toBe('passed');
    expect(r.calls).toHaveLength(0);
  } finally { probe?.mockRestore(); r.cleanup(); }
});

test('deep legacy checkout maps relocate to a short cache while preserving prior passes', async () => {
  const r = repo();
  try {
    await r.run({ runId: 'legacy-deep' });
    const legacy = join(r.options.legacyRoot!, 'old'.repeat(35));
    r.git('worktree', 'add', '--detach', legacy, r.base);
    const directory = join(r.options.stateDir, 'regress/legacy-deep');
    const mapPath = join(directory, 'checkouts.json');
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>;
    map[`${r.base}:pinned`] = legacy; writeFileSync(mapPath, JSON.stringify(map));
    const recorded = r.manifest('legacy-deep'); recorded.checkout = legacy;
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(recorded));
    r.calls.length = 0;
    const resumed = await r.run({ resume: 'legacy-deep' });
    expect(resumed.checkout).not.toBe(legacy);
    expect(existsSync(legacy)).toBe(true);
    expect(resumed.status).toBe('passed');
    expect(r.calls).toHaveLength(0);
  } finally { r.cleanup(); }
});

test('RAM-backed report directories fail before checkout allocation or runner admission', async () => {
  const r = repo();
  const original = filesystem.statfsSync;
  const probe = spyOn(filesystem, 'statfsSync').mockImplementation(((path: Parameters<typeof original>[0], options?: Parameters<typeof original>[1]) => {
    const stat = original(path, options); stat.type = typeof stat.type === 'bigint' ? BigInt(0x01021994) : 0x01021994; return stat;
  }) as typeof original);
  try {
    await expect(r.run({ runId: 'ram-reports' })).rejects.toThrow('report directory is on a RAM-backed');
    expect(r.calls).toHaveLength(0);
    expect(existsSync(r.options.checkoutRoot!)).toBe(false);
    expect(existsSync(join(r.options.stateDir, 'regress/ram-reports'))).toBe(false);
  } finally { probe.mockRestore(); r.cleanup(); }
});

test('missing registered disk worktrees recover without pruning unrelated Git registry entries', async () => {
  const r = repo();
  try {
    const first = await r.run({ runId: 'removed-tree' });
    rmSync(first.checkout, { recursive: true, force: true });
    r.calls.length = 0;
    const resumed = await r.run({ resume: 'removed-tree' });
    expect(resumed.checkout).toBe(first.checkout);
    expect(resumed.status).toBe('passed');
    expect(r.calls).toHaveLength(0);
  } finally { r.cleanup(); }
});

test('resume rejects a checkout map whose child symlink escapes the verified cache', async () => {
  const r = repo();
  const external = repo();
  try {
    await r.run({ runId: 'map-escape' });
    const mapPath = join(r.options.stateDir, 'regress/map-escape/checkouts.json');
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>;
    const escaped = join(r.options.checkoutRoot!, 'escape'); symlinkSync(external.dir, escaped);
    map[`${r.base}:pinned`] = escaped; writeFileSync(mapPath, JSON.stringify(map));
    await expect(r.run({ resume: 'map-escape' })).rejects.toThrow('outside its cache');
  } finally { r.cleanup(); external.cleanup(); }
});

test('resume rejects a legacy root symlink into another repository before preparing it', async () => {
  const r = repo();
  const external = repo();
  try {
    await r.run({ runId: 'legacy-root-escape' });
    const legacy = join(r.dir, '.temp/regress'); symlinkSync(external.dir, legacy);
    const mapPath = join(r.options.stateDir, 'regress/legacy-root-escape/checkouts.json');
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>;
    map[`${r.base}:pinned`] = legacy; writeFileSync(mapPath, JSON.stringify(map));
    let prepared = false;
    await expect(r.run({ resume: 'legacy-root-escape', prepare: async () => {
      prepared = true; return { ok: true, artifactPaths: [] };
    } })).rejects.toThrow('outside its cache');
    expect(prepared).toBe(false);
  } finally { r.cleanup(); external.cleanup(); }
});

test('pinned Task preparation uses a verified private disk TMPDIR', async () => {
  const r = repo();
  try {
    const marker = join(r.options.stateDir, 'tmpdir.log');
    r.write('Taskfile.yml', `version: '3'\ntasks:\n  install:\n    cmds: ['echo "$TMPDIR" | tee -a ${marker}']\n  gen:check:\n    cmds: ['echo "$TMPDIR" | tee -a ${marker}']\n`);
    r.commit();
    const result = await r.run({ runId: 'disk-tmp', prepare: undefined });
    expect(result.status).toBe('passed');
    const temporary = join(result.checkout, '.temp/tmp');
    expect(readFileSync(marker, 'utf8')).toContain(temporary);
    expect(existsSync(result.checkout)).toBe(false);
    expect(isRamBackedFileSystem(statfsSync(dirname(result.checkout)).type)).toBe(false);
  } finally { r.cleanup(); }
});

function mappedCheckouts(stateDir: string, id: string): string[] {
  const map = JSON.parse(readFileSync(join(stateDir, 'regress', id, 'checkouts.json'), 'utf8')) as Record<string, string>;
  return [...new Set(Object.values(map))];
}

test('a finished run removes exactly its mapped checkouts', async () => {
  const r = repo();
  const taskfile = (ok: boolean) => `version: '3'\ntasks:\n  install:\n    cmds: ['${ok ? 'true' : 'false'}']\n  gen:check:\n    cmds: ['true']\n`;
  try {
    const spare = join(r.options.checkoutRoot!, 'keep-extra');
    mkdirSync(r.options.checkoutRoot!, { recursive: true });
    r.git('worktree', 'add', '--detach', spare, r.base);
    r.write('Taskfile.yml', taskfile(true)); r.commit();
    const passed = await r.run({ runId: 'finished-pass', prepare: undefined });
    expect(passed.status).toBe('passed');
    const mapped = mappedCheckouts(r.options.stateDir, 'finished-pass');
    expect(mapped).toContain(passed.checkout);
    for (const path of mapped) expect(existsSync(path)).toBe(false);
    const evidence = join(r.options.stateDir, 'regress/finished-pass/preflight');
    expect(passed.preflight.artifactPaths.length).toBeGreaterThan(0);
    for (const path of passed.preflight.artifactPaths) {
      expect(path.startsWith(evidence)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(spare)).toBe(true);
    const listed = r.git('worktree', 'list', '--porcelain');
    for (const path of mapped) expect(listed.split('\n')).not.toContain(`worktree ${path}`);
    expect(listed).toContain(`worktree ${spare}`);
    r.write('Taskfile.yml', taskfile(false)); r.commit();
    const failed = await r.run({ runId: 'finished-fail', prepare: undefined });
    expect(failed.status).toBe('failed');
    for (const path of mappedCheckouts(r.options.stateDir, 'finished-fail')) expect(existsSync(path)).toBe(false);
    const failedEvidence = join(r.options.stateDir, 'regress/finished-fail/preflight');
    expect(failed.preflight.artifactPaths.every(path => path.startsWith(failedEvidence) && existsSync(path))).toBe(true);
    expect(inboxEntries(r.options.stateDir, 'program')[0]!.artifactPaths).toEqual(failed.preflight.artifactPaths);
    expect(existsSync(spare)).toBe(true);
  } finally { r.cleanup(); }
});

test('a finished run removes a checkout that holds read-only release staging', async () => {
  const r = repo();
  try {
    r.write('Taskfile.yml', "version: '3'\ntasks:\n  install:\n    cmds: ['mkdir -p .temp/releases/stage/infra && chmod -R a-w .temp/releases']\n  gen:check:\n    cmds: ['true']\n");
    r.commit();
    const finished = await r.run({ runId: 'read-only-stage', prepare: undefined });
    expect(finished.status).toBe('passed');
    for (const path of mappedCheckouts(r.options.stateDir, 'read-only-stage')) expect(existsSync(path)).toBe(false);
  } finally { r.cleanup(); }
});

test('a non-live run loses its checkouts and resume recreates them', async () => {
  const r = repo();
  try {
    await expect(r.run({ runId: 'resume-drop', runner: async (...args) => {
      if (args[1].tier === 'owner') throw new Error('stopped');
      return r.runner(...args);
    } })).rejects.toThrow('stopped');
    const mapped = mappedCheckouts(r.options.stateDir, 'resume-drop');
    expect(mapped.length).toBeGreaterThan(0);
    for (const path of mapped) expect(existsSync(path)).toBe(false);
    let recreated = '';
    const resumed = await r.run({ resume: 'resume-drop', runner: async (...args) => {
      recreated = args[0];
      expect(existsSync(args[0])).toBe(true);
      return r.runner(...args);
    }});
    expect(resumed.status).toBe('passed');
    expect(mapped).toContain(recreated);
    expect(existsSync(recreated)).toBe(false);
  } finally { r.cleanup(); }
});

test('prune keeps a live run and an unmapped worktree, and ignores paths outside the cache and non-worktrees', async () => {
  const r = repo();
  let release: (() => void) | undefined;
  try {
    const cache = r.options.checkoutRoot!;
    mkdirSync(cache, { recursive: true });
    const add = (name: string) => {
      const path = join(cache, name);
      r.git('worktree', 'add', '--detach', path, r.base);
      return path;
    };
    const live = add('live');
    const stale = add('stale');
    const orphan = add('orphan');
    const outside = join(r.dir, 'outside-tree');
    r.git('worktree', 'add', '--detach', outside, r.base);
    const plain = join(cache, 'plain-dir');
    mkdirSync(plain);
    const escape = join(cache, 'escape');
    symlinkSync(outside, escape);
    mkdirSync(join(stale, '.artifacts/qa'), { recursive: true });
    const writeRun = (id: string, checkout: string) => {
      const directory = join(r.options.stateDir, 'regress', id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ status: 'running' }));
      writeFileSync(join(directory, 'checkouts.json'), JSON.stringify({ [`${r.base}:pinned`]: checkout }));
      return directory;
    };
    const liveDir = writeRun('live-run', live);
    const acquired = tryAcquireDirectoryLease(join(liveDir, 'lock'));
    if (acquired === 'held') throw new Error('live lock was already held');
    release = acquired.release;
    writeRun('stale-run', stale);
    writeRun('outside-run', outside);
    const dry = pruneRegressionCheckouts({ repo: r.dir, stateDir: r.options.stateDir, checkoutRoot: cache, measureBytes: false });
    const runsDirectory = pruneRegressionCheckouts({ repo: r.dir, stateDir: join(r.options.stateDir, 'regress'), checkoutRoot: cache, measureBytes: false });
    expect(dry.apply).toBe(false);
    expect(runsDirectory.kept.map(entry => entry.path)).toEqual(dry.kept.map(entry => entry.path));
    expect(runsDirectory.removed.map(entry => entry.path)).toEqual(dry.removed.map(entry => entry.path));
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(orphan)).toBe(true);
    const applied = pruneRegressionCheckouts({ repo: r.dir, stateDir: r.options.stateDir, checkoutRoot: cache, apply: true, measureBytes: false });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(escape)).toBe(true);
    expect(applied.kept.map(entry => [entry.path, entry.reason])).toEqual([
      [live, 'live run live-run'],
      [orphan, 'unmapped while run live-run is live'],
    ]);
    expect(applied.removed.map(entry => [entry.path, entry.reason])).toEqual([
      [stale, 'non-live run stale-run; holds old evidence'],
    ]);
    expect(applied.untouched).toEqual(expect.arrayContaining([
      { path: plain, reason: 'not a registered worktree' },
      { path: escape, reason: 'escapes the cache root' },
      { path: outside, reason: 'outside the cache root' },
    ]));
    release(); release = undefined;
    const freed = pruneRegressionCheckouts({ repo: r.dir, stateDir: r.options.stateDir, checkoutRoot: cache, apply: true, measureBytes: false });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(false);
    expect(freed.removed.map(entry => entry.path).sort()).toEqual([live, orphan].sort());
  } finally { release?.(); r.cleanup(); }
});

test('shared UI stories can be selected alone through the web Storybook command', () => {
  const root = join(import.meta.dir, '../..');
  const file = [...new Bun.Glob('packages/ui/src/**/*.stories.tsx').scanSync({ cwd: root })][0]!;
  const [program, args] = selectTestCommand([file]);
  expect(program).toBe('task');
  expect(args).toEqual(['storybook:test', '--', `../../${file}`]);
});
